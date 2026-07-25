/**
 * Scene construction: assemble, distribute reactivity, wire, compile.
 *
 * One place that turns a seed plus a theme into something the runtime can execute, so the host does not
 * have to know the order these steps go in. Pure, so the whole pipeline is testable end to end without
 * a GL context.
 */

import { distributeReactivity, type DistributedBinding } from './audio-mapping';
import { compileGraph, type CompiledGraph } from './graph';
import { REDUCED_GRAMMAR } from './grammar';
import type { QualityProfile } from './performance';
import type { VisualPluginDefinition } from './plugin';
import { createRng } from './random';
import { assembleScene, type SchedulerContext, type VisualTheme } from './scheduler';
import { wireScene, type AssetResource, type WiredScene } from './wiring';

export interface BuiltScene {
    seed: string;
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
 * Builds a scene for a seed.
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

export function buildScene(
    seed: string,
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

    const assembled = assembleScene(seed, schedulerContext);
    if (assembled.violations.length > 0) {
        return {
            ok: false,
            failure: {
                reason: 'grammar',
                detail: assembled.violations.map((violation) => violation.detail).join('; '),
            },
        };
    }

    const wired = wireScene(assembled.plugins, context.assetResources ?? []);
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

    const compiled = compileGraph(wired.nodes, wired.edges, wired.present, wired.assetBindings);
    if (!compiled.ok) {
        return { ok: false, failure: { reason: 'compile', detail: compiled.errors.join('; ') } };
    }

    return {
        ok: true,
        scene: {
            seed,
            theme: effectiveTheme,
            plugins: assembled.plugins,
            wired,
            graph: compiled.graph,
            bindings: distributeReactivity(assembled.plugins, createRng(`${seed}:bindings`)),
            // The theme's colour policy reaches the plugins that map colour, so a theme asking for the
            // album palette at full strength actually gets it.
            parameterOverrides: colourOverrides(effectiveTheme.colorPolicy),
        },
    };
}

/**
 * Tries each theme in turn and returns the first that builds.
 *
 * A theme whose grammar the current catalog cannot satisfy fails rather than producing a broken scene,
 * so falling through to the next one is how the visualizer stays usable while the catalog is still
 * being filled in.
 */
export function buildFirstViableScene(
    seed: string,
    themes: readonly VisualTheme[],
    context: SceneBuildContext,
    profile: QualityProfile,
): SceneBuildResult {
    let lastFailure: SceneBuildFailure = { reason: 'grammar', detail: 'no themes supplied' };

    for (const theme of themes) {
        const result = buildScene(seed, theme, context, profile);
        if (result.ok) {
            return result;
        }

        lastFailure = result.failure;
    }

    return { ok: false, failure: lastFailure };
}
