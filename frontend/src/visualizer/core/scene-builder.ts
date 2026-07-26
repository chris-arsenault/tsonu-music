/**
 * Scene construction: assemble, distribute reactivity, wire, compile.
 *
 * One place that turns per-scene entropy plus a theme into something the runtime can execute, so the
 * host does not have to know the order these steps go in. Pure, so the whole pipeline is testable end
 * to end without a GL context.
 */

import { distributeReactivity, type DistributedBinding } from './audio-mapping';
import { compileGraph, type CompiledGraph } from './graph';
import {
    grammarViolations,
    REDUCED_GRAMMAR,
    type GrammarViolation,
    type SceneGrammar,
} from './grammar';
import { isMotionSource } from './persistence';
import type { QualityProfile } from './performance';
import type { VisualPluginDefinition } from './plugin';
import { createRng } from './random';
import { assembleScene, type SchedulerContext, type VisualTheme } from './scheduler';
import { wireScene, type AssetResource, type WiredScene } from './wiring';

export interface BuiltScene {
    entropy: string;
    theme: VisualTheme;
    plugins: VisualPluginDefinition[];
    wired: WiredScene;
    graph: CompiledGraph;
    bindings: DistributedBinding[];
    /** Per-plugin starting parameters the theme dictates, applied over each plugin's own defaults. */
    parameterOverrides: Record<string, Record<string, number>>;
}

/**
 * Turns a theme's colour policy into starting parameters.
 *
 * The policy says how strongly the scene's colour should come from its palette source; the plugins that
 * map colour are the ones that can act on it, so the policy lands on their strength parameters rather
 * than being stored and forgotten.
 */
export function colourOverrides(
    policy: VisualTheme['colorPolicy'],
): Record<string, Record<string, number>> {
    if (!policy) {
        return {};
    }

    const strength = policy.strength <= 0 ? 0 : policy.strength > 1 ? 1 : policy.strength;

    return {
        PaletteMapper: { strength },
        // A curated policy leaves the source material's own colour largely intact, so the transform
        // works less hard; a palette-derived policy pushes harder toward the palette.
        ...Object.fromEntries(
            ['hue-rotate', 'saturation', 'contrast', 'solarize', 'invert', 'permute', 'duotone', 'quantize', 'luminance']
                .map((mode) => [`ColorTransform:${mode}`, { amount: strength * 0.6 }]),
        ),
    };
}

export type SceneBuildFailure =
    | { reason: 'grammar'; detail: string }
    | { reason: 'unsatisfied-inputs'; detail: string }
    | { reason: 'compile'; detail: string };

export type SceneBuildResult =
    | { ok: true; scene: BuiltScene }
    | { ok: false; failure: SceneBuildFailure };

/**
 * Builds a scene from one host-supplied entropy token.
 *
 * The quality profile is applied as scheduler constraints rather than after the fact: at a reduced
 * level the grammar itself gets cheaper and expensive plugins become ineligible, so a struggling device
 * assembles a scene it can render instead of one it must then dismantle.
 */
export interface SceneBuildContext
    extends Omit<SchedulerContext, 'theme' | 'allowHighCost' | 'allowDominant'> {
    /** Host-supplied asset textures the graph may bind to plugin inputs. */
    assetResources?: readonly AssetResource[];
}

const MAX_BUILD_ATTEMPTS = 32;

export function buildScene(
    entropy: string,
    theme: VisualTheme,
    context: SceneBuildContext,
    profile: QualityProfile,
): SceneBuildResult {
    let lastFailure: SceneBuildFailure = { reason: 'grammar', detail: 'no viable composition' };

    // Category selection is intentionally exploratory. Some selections are individually legal but
    // cannot form a connected multi-branch graph (for example, a field with no consumer or a mixer
    // with only one colour producer). Try further candidates instead of accepting an orphan or
    // flattening the scene to repair it.
    for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt += 1) {
        const candidateEntropy = `${entropy}:candidate:${attempt}`;
        const result = buildSceneAttempt(candidateEntropy, theme, context, profile);
        if (result.ok) {
            return result;
        }
        lastFailure = result.failure;
    }

    return { ok: false, failure: lastFailure };
}

function buildSceneAttempt(
    entropy: string,
    theme: VisualTheme,
    context: SceneBuildContext,
    profile: QualityProfile,
): SceneBuildResult {
    const effectiveTheme: VisualTheme = profile.reducedGrammar
        ? { ...theme, grammar: REDUCED_GRAMMAR }
        : theme;

    const schedulerContext: SchedulerContext = {
        ...context,
        theme: effectiveTheme,
        allowHighCost: profile.expensivePrimary,
        allowDominant: profile.expensivePrimary,
    };

    const assembled = assembleScene(entropy, schedulerContext);
    if (assembled.violations.length > 0) {
        return {
            ok: false,
            failure: {
                reason: 'grammar',
                detail: assembled.violations.map((violation) => violation.detail).join('; '),
            },
        };
    }

    let plugins = assembled.plugins;
    let wired = wireScene(plugins, context.assetResources ?? []);
    if (wired.unsatisfied.length > 0) {
        return {
            ok: false,
            failure: {
                reason: 'unsatisfied-inputs',
                detail: wired.unsatisfied
                    .map((entry) => `${entry.instanceId}.${entry.port} (${entry.type})`)
                    .join('; '),
            },
        };
    }

    // Category counts alone are not enough: an optional field can be selected without anything ever
    // reading it. Keep only plugins that contribute to a terminal colour layer, then re-check the
    // grammar so an allegedly full scene cannot spend passes on disconnected decoration.
    const contributing = contributingPluginIds(wired);
    if (contributing.size < wired.nodes.length) {
        plugins = plugins.filter((definition) => contributing.has(definition.id));
        const violations = grammarViolations(plugins, effectiveTheme.grammar);
        if (violations.length > 0) {
            return {
                ok: false,
                failure: {
                    reason: 'grammar',
                    detail: `connected graph: ${violations.map((violation) => violation.detail).join('; ')}`,
                },
            };
        }

        wired = wireScene(plugins, context.assetResources ?? []);
    }

    // How the scene is joined, which counts alone cannot express. Checked after the prune above, so a
    // scene that only reaches two branches by keeping a disconnected one is rejected rather than
    // counted.
    const structural = structuralViolations(wired, effectiveTheme.grammar);
    if (structural.length > 0) {
        return {
            ok: false,
            failure: {
                reason: 'grammar',
                detail: structural.map((violation) => violation.detail).join('; '),
            },
        };
    }

    const compiled = compileGraph(wired.nodes, wired.edges, wired.present, wired.assetBindings);
    if (!compiled.ok) {
        return { ok: false, failure: { reason: 'compile', detail: compiled.errors.join('; ') } };
    }

    return {
        ok: true,
        scene: {
            entropy,
            theme: effectiveTheme,
            plugins,
            wired,
            graph: compiled.graph,
            bindings: distributeReactivity(plugins, createRng(`${entropy}:bindings`)),
            // The theme's colour policy reaches the plugins that map colour, so a theme asking for the
            // album palette at full strength actually gets it.
            parameterOverrides: colourOverrides(effectiveTheme.colorPolicy),
        },
    };
}

/**
 * Structural checks the grammar can only make once the scene is wired.
 *
 * Category counts describe what a scene contains; these describe how it is joined. A compositor
 * reading one branch twice satisfies every count and composes nothing, which is the difference
 * between a scene that reads as one composition and a scene that merely has the right parts.
 */
export function structuralViolations(
    scene: WiredScene,
    grammar: SceneGrammar,
): GrammarViolation[] {
    const branches = materialBranchCount(scene);
    if (branches < grammar.minimumMaterialBranches) {
        return [{
            kind: 'too-few-branches',
            detail: `${branches} material branches below ${grammar.minimumMaterialBranches}`,
        }];
    }

    return [];
}

/**
 * Distinct colour producers that reach the screen, either terminally or through a compositor.
 *
 * Counted by producing instance rather than by edge, so a mixer wired to the same texture on both
 * inputs counts once — which is exactly the case this exists to catch.
 */
export function materialBranchCount(scene: WiredScene): number {
    const producers = new Set<string>();

    for (const node of scene.nodes) {
        const producesColour = node.definition.outputs.some((port) => port.type === 'color-texture');
        // A post-processing stage transforms one branch rather than being one, and a compositor joins
        // branches rather than being one. Every compositor outputs a colour texture and none is
        // categorised as postprocess, so each was counting itself: a scene of one source and one
        // compositor reported two material branches and satisfied a minimum of two while composing a
        // single branch. That is one of the two things behind a frame that is almost entirely black
        // with a thin line in it.
        const joinsBranches = node.definition.category === 'compositor'
            || node.definition.category === 'postprocess';

        if (producesColour && !joinsBranches) {
            producers.add(node.instanceId);
        }
    }

    return producers.size;
}

/**
 * Plugin ids that reach the screen, either through a terminal colour output or through the motion bus.
 *
 * Feedback edges are dependencies but do not make an output intermediate: a feedback texture may be
 * both read next frame and presented now. Forward consumers do make an output intermediate.
 *
 * A spatial field is a contributor whether or not anything in the graph reads it, because the
 * compositor sums every one of them into the motion field that drags the accumulation. Judging
 * contribution by colour paths alone would prune exactly the fields that move the picture.
 */
export function contributingPluginIds(scene: WiredScene): Set<string> {
    const forwardConsumed = new Set(
        scene.edges
            .filter((edge) => !edge.feedback)
            .map((edge) => `${edge.from.instanceId}.${edge.from.port}`),
    );
    const contributingInstances = new Set<string>();

    for (const node of scene.nodes) {
        const hasTerminalColour = node.definition.outputs.some((port) =>
            port.type === 'color-texture'
            && !forwardConsumed.has(`${node.instanceId}.${port.name}`));
        const feedsMotion = node.definition.outputs.some((port) => isMotionSource(port.type));

        if (hasTerminalColour || feedsMotion) {
            contributingInstances.add(node.instanceId);
        }
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const edge of scene.edges) {
            if (
                contributingInstances.has(edge.to.instanceId)
                && !contributingInstances.has(edge.from.instanceId)
            ) {
                contributingInstances.add(edge.from.instanceId);
                changed = true;
            }
        }
    }

    return new Set(
        scene.nodes
            .filter((node) => contributingInstances.has(node.instanceId))
            .map((node) => node.definition.id),
    );
}

/**
 * Tries each theme in turn and returns the first that builds.
 *
 * A theme whose grammar the current catalog cannot satisfy fails rather than producing a broken scene,
 * so falling through to the next one is how the visualizer stays usable while the catalog is still
 * being filled in.
 */
export function buildFirstViableScene(
    entropy: string,
    themes: readonly VisualTheme[],
    context: SceneBuildContext,
    profile: QualityProfile,
): SceneBuildResult {
    let lastFailure: SceneBuildFailure = { reason: 'grammar', detail: 'no themes supplied' };

    for (const theme of themes) {
        const result = buildScene(entropy, theme, context, profile);
        if (result.ok) {
            return result;
        }

        lastFailure = result.failure;
    }

    return { ok: false, failure: lastFailure };
}

/**
 * Varies family priority for each freshly generated scene.
 *
 * Fallback still needs an order, but a static one made the first viable family monopolize every track.
 * The entropy originates from a new browser UUID, so this is not a track-to-theme mapping.
 */
export function variedThemeOrder(
    entropy: string,
    themes: readonly VisualTheme[],
): VisualTheme[] {
    return createRng(`${entropy}:themes`).shuffle(themes);
}
