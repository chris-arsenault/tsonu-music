/**
 * Reactivity distribution (spec section 20).
 *
 * Plugins should not all react to the same audio event. Left to their defaults every plugin binds to
 * whatever suits it in isolation, and the whole scene pulses together on every beat — the specific
 * failure the mapping table exists to prevent.
 *
 * Distribution happens *within* what a binding means, never across it. Section 20 is a table of
 * appropriate targets: bass belongs to large-scale force, treble to edge detail, onsets to bursts.
 * An earlier version picked a feature at random from a pool defined by the plugin's category, which
 * moved feedback expansion onto stereo balance and palette movement onto beat phase — reactivity was
 * spread, and the meaning of every parameter was destroyed to do it. A binding now declares its role
 * and the scheduler chooses only among the features that role admits.
 */

import { bindingMode, type BindingRole, type ParameterBinding } from './bindings';
import type { VisualPluginDefinition } from './plugin';
import type { Rng } from './random';

/**
 * Features each role admits, from the section 20 table. Ordered by how well each expresses the role,
 * since selection prefers whatever is still unclaimed and falls back along this order.
 *
 * Excitation features appear where a role is about *events* — detail and burst want the transient,
 * not the standing level. Level features appear where a role is about *presence* — a large-scale
 * force should hold while the bass holds.
 */
export const ROLE_FEATURES: Record<BindingRole, readonly string[]> = {
    intensity: ['rms', 'peak', 'rmsExcite'],
    'large-scale-force': ['bass', 'subBass', 'bassExcite', 'subBassExcite'],
    deformation: ['mid', 'lowMid', 'midExcite', 'lowMidExcite'],
    detail: ['trebleExcite', 'highMidExcite', 'treble', 'highMid'],
    burst: ['spectralFlux', 'trebleExcite', 'bassExcite', 'rmsExcite'],
    'repeating-motion': ['beatPhase'],
    complexity: ['spectralCentroid'],
    'lateral-force': ['stereoBalance'],
};

/** Event channels an impulse binding fires from. Distribution never moves one onto a level. */
const IMPULSE_FEATURES: readonly string[] = ['onset', 'beat'];

/**
 * Whether a feature reads as a standing level or as a departure from one.
 *
 * Level channels are peak-normalized: they ride continuously, spending most of their time somewhere
 * in the middle of their range. Excitation channels report how far a measure sits above its own
 * recent mean in units of its own recent deviation, so on percussive material they clear the
 * headroom constant entirely and read as a gate. Measured: `bass` has a median of 0.204 and a 95th
 * percentile of 0.402, while `bassExcite` has a median of 0.000 and a 95th percentile of 1.000.
 *
 * Derived from the name rather than tabulated, so a new excitation channel cannot be added without
 * being classified.
 */
export type FeatureKind = 'level' | 'excitation';

export function featureKind(feature: string): FeatureKind {
    return feature.endsWith('Excite') ? 'excitation' : 'level';
}

/**
 * The role a feature belongs to, so a binding written before roles existed keeps its meaning.
 *
 * This is what lets role-based distribution take effect across the whole catalog without editing
 * every plugin definition: an author who wrote `feature: 'bass'` meant large-scale force, and that
 * is exactly what the table says.
 */
export function roleForFeature(feature: string): BindingRole | undefined {
    for (const [role, features] of Object.entries(ROLE_FEATURES) as [BindingRole, readonly string[]][]) {
        if (features.includes(feature)) {
            return role;
        }
    }

    return undefined;
}

/** A binding's declared role, or the one implied by the feature it was authored against. */
export function bindingRole(binding: ParameterBinding): BindingRole | undefined {
    return binding.role ?? roleForFeature(binding.feature);
}

export interface DistributedBinding {
    pluginId: string;
    bindings: ParameterBinding[];
}

/**
 * Spreads bindings across the features their roles admit.
 *
 * Assignment is per binding, not per plugin: a plugin that binds amplitude to level and brightness to
 * treble means those to be different signals, and collapsing them onto one feature would undo exactly
 * the separation this function exists to create.
 *
 * Features already claimed are avoided until a role's pool runs dry, at which point reuse is allowed
 * — a scene with more bindings in one role than that role has features cannot give each an exclusive
 * signal, but it can still avoid every binding sharing one.
 */
export function distributeReactivity(
    plugins: readonly VisualPluginDefinition[],
    rng: Rng,
): DistributedBinding[] {
    const claimed = new Set<string>();

    const claim = (pool: readonly string[], fallback: string): string => {
        if (pool.length === 0) {
            return fallback;
        }

        const unclaimed = pool.filter((feature) => !claimed.has(feature));
        const feature = rng.pick(unclaimed.length > 0 ? unclaimed : pool) ?? pool[0];

        claimed.add(feature);
        return feature;
    };

    return plugins.map((definition) => ({
        pluginId: definition.id,
        bindings: (definition.defaultBindings ?? []).map((binding) => {
            // An impulse names an event channel. Rewriting it onto a continuous feature would leave
            // the binding reading a channel that never fires.
            if (bindingMode(binding) === 'impulse') {
                return { ...binding, feature: claim(IMPULSE_FEATURES, binding.feature) };
            }

            const role = bindingRole(binding);
            if (!role) {
                // A feature outside the table is deliberate and specific. Leave it alone rather than
                // guessing at a replacement.
                return { ...binding };
            }

            // Within the role, only among features of the binding's own kind. `inputRange`,
            // `outputRange`, and `curve` are authored against a distribution, and the two kinds do
            // not share one: substituting `bassExcite` for `bass` turns a parameter written to ride
            // smoothly at a fifth of its range into a binary toggle between its extremes, decided by
            // a per-scene die roll. This is the same guard the impulse branch above applies to
            // events, for the same reason — distribution spreads reactivity, it does not reinterpret
            // what a binding meant.
            const kind = featureKind(binding.feature);
            const pool = ROLE_FEATURES[role].filter((feature) => featureKind(feature) === kind);

            return { ...binding, role, feature: claim(pool, binding.feature) };
        }),
    }));
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
