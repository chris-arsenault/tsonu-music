/**
 * Reactivity distribution (spec section 20).
 *
 * Plugins should not all react to the same audio event. Left to their defaults every plugin binds to
 * whatever suits it in isolation, and the whole scene pulses together on every beat — the specific
 * failure the mapping table exists to prevent.
 *
 * This assigns each plugin a distinct feature focus, so bass drives large-scale motion while treble
 * drives detail and onsets drive bursts.
 */

import type { ParameterBinding } from './bindings';
import type { PluginCategory, VisualPluginDefinition } from './plugin';
import type { Rng } from './random';

/** Features the scheduler distributes, with what each is appropriate for. */
export type FeatureRole =
    | 'rms'
    | 'bass'
    | 'subBass'
    | 'mid'
    | 'lowMid'
    | 'highMid'
    | 'treble'
    | 'spectralCentroid'
    | 'spectralFlux'
    | 'beatPhase'
    | 'stereoBalance';

/**
 * Which features suit which category, from the section 20 table. A field wants large-scale force, a
 * postprocess stage wants brightness and palette movement, and so on.
 */
export const CATEGORY_AFFINITY: Record<PluginCategory, readonly FeatureRole[]> = {
    source: ['rms', 'mid', 'treble', 'beatPhase', 'spectralCentroid'],
    field: ['bass', 'subBass', 'stereoBalance', 'spectralFlux'],
    simulator: ['bass', 'treble', 'spectralFlux', 'rms'],
    transformer: ['bass', 'beatPhase', 'mid', 'lowMid'],
    compositor: ['rms', 'highMid', 'spectralCentroid'],
    postprocess: ['rms', 'spectralCentroid', 'highMid'],
};

export interface DistributedBinding {
    pluginId: string;
    bindings: ParameterBinding[];
}

/**
 * Rewrites every binding onto a feature chosen for it.
 *
 * Assignment is per binding, not per plugin: a plugin that binds amplitude to level and brightness to
 * treble means those to be different signals, and collapsing them onto one feature would undo exactly
 * the separation this function exists to create.
 *
 * Features already claimed are avoided until the pool runs dry, at which point reuse is allowed — a
 * scene with more bindings than features cannot give each an exclusive signal, but it can still avoid
 * every binding sharing one.
 */
export function distributeReactivity(
    plugins: readonly VisualPluginDefinition[],
    rng: Rng,
): DistributedBinding[] {
    const claimed = new Set<FeatureRole>();

    const claim = (affinity: readonly FeatureRole[]): FeatureRole => {
        const unclaimed = affinity.filter((role) => !claimed.has(role));
        const pool = unclaimed.length > 0 ? unclaimed : affinity;
        const role = rng.pick(pool) ?? affinity[0];

        claimed.add(role);
        return role;
    };

    return plugins.map((definition) => {
        const affinity = CATEGORY_AFFINITY[definition.category];

        return {
            pluginId: definition.id,
            bindings: (definition.defaultBindings ?? []).map((binding) => ({
                ...binding,
                feature: claim(affinity),
            })),
        };
    });
}

/**
 * How many plugins share each feature. Used to check that a scene's reactivity is spread rather than
 * concentrated.
 */
export function reactivitySpread(distributed: readonly DistributedBinding[]): Map<string, number> {
    const spread = new Map<string, number>();

    for (const entry of distributed) {
        for (const binding of entry.bindings) {
            spread.set(binding.feature, (spread.get(binding.feature) ?? 0) + 1);
        }
    }

    return spread;
}

/**
 * The largest number of plugins bound to any one feature. A scene where this equals the plugin count
 * is one where everything pulses together.
 */
export function peakConcentration(distributed: readonly DistributedBinding[]): number {
    let peak = 0;

    for (const count of reactivitySpread(distributed).values()) {
        peak = Math.max(peak, count);
    }

    return peak;
}
