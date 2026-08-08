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
    displacesHistory,
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
import { isImagePortType, wireScene, type AssetResource, type WiredScene } from './wiring';

export interface BuiltScene {
    entropy: string;
    theme: VisualTheme;
    plugins: VisualPluginDefinition[];
    wired: WiredScene;
    graph: CompiledGraph;
    bindings: DistributedBinding[];
    /**
     * Per-instance starting parameters the theme dictates, applied over each plugin's own defaults.
     *
     * Keyed by instance id rather than definition id, so two instances of one plugin can start from
     * different values. Keyed by definition they could not, on this path or any other.
     */
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

/**
 * Lands the theme's colour policy on the instances that are actually in the scene.
 *
 * `colourOverrides` above answers "which plugins does this policy address", which is a question about
 * the catalog. This answers "which nodes does it reach", which is a question about one scene — so a
 * definition present twice gets two entries that can subsequently diverge, and a definition the
 * scheduler did not select gets none rather than an override addressed to nothing.
 */
export function instanceOverrides(
    scene: WiredScene,
    policy: VisualTheme['colorPolicy'],
): Record<string, Record<string, number>> {
    const byDefinition = colourOverrides(policy);
    const overrides: Record<string, Record<string, number>> = {};

    for (const node of scene.nodes) {
        const values = byDefinition[node.definition.id];
        if (values) {
            overrides[node.instanceId] = { ...values };
        }
    }

    return overrides;
}

/**
 * Scales the colour-mapping bindings by the theme's declared colour strength.
 *
 * `colourOverrides` above writes the same strength into those parameters' starting values, but both
 * parameters are *bound* — `PaletteMapper.strength` to overall level, `ColorTransform.amount` to a
 * band — so the resolver treats the override as nothing more than an initial condition and smooths it
 * away over the binding's own attack and release, a matter of a second at most. The theme's colour
 * policy had no steady-state effect on anything.
 *
 * Scaling the output range is what makes it durable: at zero the parameter cannot leave zero however
 * loud the track, at one the binding keeps the range its author wrote, and in between the music still
 * drives the parameter across a proportionally smaller span. The starting values remain useful, since
 * they are where the parameter begins before the first frame of audio arrives.
 */
export function applyColourPolicy(
    bindings: DistributedBinding[],
    policy: VisualTheme['colorPolicy'],
): DistributedBinding[] {
    if (!policy) {
        return bindings;
    }

    const strength = policy.strength <= 0 ? 0 : policy.strength > 1 ? 1 : policy.strength;
    if (strength === 1) {
        return bindings;
    }

    const scaled = (id: string, parameter: string): boolean =>
        (id === 'PaletteMapper' && parameter === 'strength')
        || (id.startsWith('ColorTransform:') && parameter === 'amount');

    return bindings.map((entry) => ({
        ...entry,
        bindings: entry.bindings.map((binding) => (
            scaled(entry.pluginId, binding.parameter)
                ? {
                    ...binding,
                    outputRange: [
                        binding.outputRange[0] * strength,
                        binding.outputRange[1] * strength,
                    ] as [number, number],
                }
                : binding
        )),
    }));
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
    let wired = wireScene(plugins, context.assetResources ?? [], createRng(`${entropy}:loops`));
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
    // Compared against the number of distinct definitions in the scene, not the number of nodes.
    // `contributingPluginIds` returns definition ids, so two instances of one definition made the set
    // smaller than the node count on their own and triggered a prune pass that had nothing to prune.
    const contributing = contributingPluginIds(wired);
    const distinctDefinitions = new Set(wired.nodes.map((node) => node.definition.id)).size;
    if (contributing.size < distinctDefinitions) {
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

        // The same draw, so a prune does not silently move every loop in the scene.
        wired = wireScene(plugins, context.assetResources ?? [], createRng(`${entropy}:loops`));
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
            bindings: applyColourPolicy(
                distributeReactivity(wired.nodes, createRng(`${entropy}:bindings`)),
                effectiveTheme.colorPolicy,
            ),
            // The theme's colour policy reaches the plugins that map colour, so a theme asking for the
            // album palette at full strength actually gets it.
            parameterOverrides: instanceOverrides(wired, effectiveTheme.colorPolicy),
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
    const violations: GrammarViolation[] = [];

    const branches = materialBranchCount(scene);
    if (branches < grammar.minimumMaterialBranches) {
        violations.push({
            kind: 'too-few-branches',
            detail: `${branches} material branches below ${grammar.minimumMaterialBranches}`,
        });
    }

    // Counted as edges rather than as plugins carrying a capability. The two agree while each
    // loop-closing plugin nominates one port, and the edge is what a plugin with two of them, or an
    // authored graph, would disagree with the count on. See ADR-0012.
    //
    // Image loops only. `ParticleEmitter`, `ParticleForceField`, and `ParticleCollider` each declare
    // a `previous` port so they can chain — each reads the list built so far — and the first in a
    // chain has no upstream producer, so wiring closes it on itself. That is a harmless empty read
    // of a value port, not a picture fed back into a picture, and counting it put four loops in a
    // family whose ceiling is one.
    const loops = scene.edges.filter((edge) => {
        if (!edge.feedback) {
            return false;
        }

        const sink = scene.nodes.find((node) => node.instanceId === edge.to.instanceId);
        const port = sink?.definition.inputs.find((input) => input.name === edge.to.port);

        return port !== undefined && isImagePortType(port.type);
    });
    if (loops.length < grammar.minimumFeedbackLoops) {
        violations.push({
            kind: 'too-few-feedback',
            detail: `${loops.length} loops below ${grammar.minimumFeedbackLoops}`,
        });
    }
    if (loops.length > grammar.maximumFeedbackLoops) {
        violations.push({
            kind: 'too-many-feedback',
            detail: `${loops.length} loops exceed ${grammar.maximumFeedbackLoops}`,
        });
    }

    // A field has to reach something that reads it.
    //
    // This asked whether the scene *contained* a spatial field, which was the right question while a
    // kernel pass summed every one of them whether or not anything was wired to it. ADR-0008 adopted
    // that partly to stop assembly producing orphans and recorded that closing it properly belonged
    // to a predicate about consumption. With the bus retired, a field nothing reads is a pass drawn
    // into a texture that is sampled by nothing.
    if (grammar.requireMotionSource && !consumesMotion(scene)) {
        violations.push({
            kind: 'no-motion-source',
            detail: 'no spatial field reaches a consumer',
        });
    }

    // A loop that only mixes colour gives the scene a memory and no motion. Once the kernel stops
    // dragging the accumulation itself, this is the difference between a picture that flows and one
    // that fades.
    if (grammar.requireSpatialLoop && !loops.some((edge) => {
        const sink = scene.nodes.find((node) => node.instanceId === edge.to.instanceId);
        return sink !== undefined && displacesHistory(sink.definition);
    })) {
        violations.push({
            kind: 'no-spatial-loop',
            detail: 'no loop displaces the image it reads',
        });
    }

    return violations;
}

/** Whether any edge in the scene carries a spatial field from its producer to something that reads it. */
export function consumesMotion(scene: WiredScene): boolean {
    return scene.edges.some((edge) => {
        const producer = scene.nodes.find((node) => node.instanceId === edge.from.instanceId);
        const port = producer?.definition.outputs.find((output) => output.name === edge.from.port);

        return port !== undefined && isMotionSource(port.type);
    });
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
        // A spatial field used to seed this set unconditionally, because the compositor summed every
        // one of them into the motion bus whether or not the graph read it — so judging contribution
        // by paths through the graph would have pruned exactly the plugins that moved the picture.
        // With the bus retired (ADR-0012) that is no longer true in either direction: a field
        // reaches the picture through an edge like everything else, and one nothing reads is a pass
        // drawn into a texture that is sampled by nothing.
        const hasTerminalColour = node.definition.outputs.some((port) =>
            port.type === 'color-texture'
            && !forwardConsumed.has(`${node.instanceId}.${port.name}`));

        if (hasTerminalColour) {
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
