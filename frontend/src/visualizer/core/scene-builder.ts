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
import { wireScene, type WiredScene } from './wiring';

export interface BuiltScene {
    seed: string;
    theme: VisualTheme;
    plugins: VisualPluginDefinition[];
    wired: WiredScene;
    graph: CompiledGraph;
    bindings: DistributedBinding[];
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
export function buildScene(
    seed: string,
    theme: VisualTheme,
    context: Omit<SchedulerContext, 'theme' | 'allowHighCost' | 'allowDominant'>,
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

    const wired = wireScene(assembled.plugins);
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

    const compiled = compileGraph(wired.nodes, wired.edges, wired.present);
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
    context: Omit<SchedulerContext, 'theme' | 'allowHighCost' | 'allowDominant'>,
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
