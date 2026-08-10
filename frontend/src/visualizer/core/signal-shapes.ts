/**
 * Signal shapes: how each bus channel behaves, which is the property a substituted feature has to
 * preserve.
 *
 * The role table this replaces constrained substitution by what a feature *meant* — bass belongs
 * to large-scale force, treble to detail. Meaning was the wrong invariant: the feature bus
 * quantile-normalizes every level channel into uniform [0, 1] occupancy (`features.ts`,
 * `distribution.ts`), so any level channel drives any [0, 1]-shaped binding correctly by
 * construction, and the table's semantic buckets narrowed substitution to near-duplicates — a
 * `bass` binding could move to `subBass` and nowhere else. What actually breaks a binding written
 * for a rider is being fed a gate: the excitation channels spend most of their time at zero and
 * clear their headroom on hits (measured median 0.000, p95 1.000), `beatPhase` is a sawtooth,
 * `spectralFlux` is event-shaped. Shape is the invariant; within a shape, substitution is free.
 */

export type SignalShape = 'level' | 'pulse' | 'phase' | 'event';

export const SIGNAL_SHAPES: Record<SignalShape, readonly string[]> = {
    /** Distribution-normalized riders: occupy [0, 1] uniformly over a rolling window. */
    level: [
        'rms', 'peak',
        'subBass', 'bass', 'lowMid', 'mid', 'highMid', 'treble',
        'spectralCentroid',
        // Carried as a position (0.5 centred), and distribution-normalized like the rest.
        'stereoBalance',
    ],
    /** Gates and event envelopes: near zero at rest, clearing their headroom on hits. */
    pulse: [
        'rmsExcite', 'subBassExcite', 'bassExcite', 'lowMidExcite',
        'midExcite', 'highMidExcite', 'trebleExcite',
        'spectralFlux', 'transient',
    ],
    /** A position between beats, uniform by construction, advancing whether or not anything plays. */
    phase: ['beatPhase'],
    /** Detected events, readable only by impulse bindings. */
    event: ['onset', 'beat'],
};

/**
 * Channels no substitution may land on. Binding one deliberately is reasonable — an editor offers
 * them — but `beatConfidence` is a confidence in a measurement and the raw channel levels are
 * unnormalized, so a drawn binding would read something its response curve was never written for.
 */
export const DELIBERATE_ONLY_FEATURES: readonly string[] = [
    'beatConfidence', 'leftLevel', 'rightLevel',
];

export function shapeOf(feature: string): SignalShape | undefined {
    for (const [shape, features] of Object.entries(SIGNAL_SHAPES) as [SignalShape, readonly string[]][]) {
        if (features.includes(feature)) {
            return shape;
        }
    }

    return undefined;
}
