/**
 * Concurrent parameter motion.
 *
 * Audio bindings provide the immediate musical response. This adds a slower, independent motion to
 * every bound parameter so several layers keep breathing, folding, and drifting at once between
 * transients. Playback time is the only clock, therefore pause and seek semantics remain intact.
 */

import { bindingMode, type BindingRole, type ParameterBinding } from './bindings';

const TAU = Math.PI * 2;

/**
 * How far and how fast each role's slow motion travels.
 *
 * Every parameter drifted by the same fraction of its range at the same rate, whatever it did. A
 * scene therefore had one tempo and one amplitude of change everywhere, which reads as uniformly
 * small no matter how the individual ranges are tuned — there was no sense of a large slow shift
 * carrying faster small detail on top of it.
 *
 * Large-scale roles move far and slowly, because that is what large-scale means. Detail moves a
 * little and often. `depth` is a fraction of the binding's own range; `rate` is in hertz.
 */
const ROLE_DYNAMICS: Record<BindingRole, { depth: [number, number]; rate: [number, number] }> = {
    // Structure: wide, unhurried arcs that reshape the frame over many seconds.
    'large-scale-force': { depth: [0.45, 0.8], rate: [0.012, 0.045] },
    deformation: { depth: [0.4, 0.7], rate: [0.018, 0.06] },
    // Presence: the middle ground, and the closest to the old uniform behaviour.
    intensity: { depth: [0.25, 0.45], rate: [0.05, 0.12] },
    complexity: { depth: [0.3, 0.55], rate: [0.03, 0.09] },
    'lateral-force': { depth: [0.3, 0.6], rate: [0.04, 0.1] },
    // Detail: small and quick, riding on top of whatever the structure is doing.
    detail: { depth: [0.08, 0.2], rate: [0.18, 0.5] },
    burst: { depth: [0.06, 0.16], rate: [0.25, 0.7] },
    'repeating-motion': { depth: [0.15, 0.35], rate: [0.1, 0.3] },
};

/** What an unroled binding gets: the middle of the range, as before. */
const DEFAULT_DYNAMICS = { depth: [0.2, 0.45] as [number, number], rate: [0.035, 0.14] as [number, number] };

function dynamicsFor(role: BindingRole | undefined) {
    return role ? ROLE_DYNAMICS[role] : DEFAULT_DYNAMICS;
}

function lerp(range: readonly [number, number], t: number): number {
    return range[0] + (range[1] - range[0]) * t;
}

/**
 * Adds bounded, per-parameter motion around the values resolved from live audio.
 *
 * The instance entropy is fresh for each scene. It only separates oscillator phases within the
 * current composition; it is not a track identity or a user-visible reproduction key.
 */
export function modulateParameters(
    resolved: Readonly<Record<string, number>>,
    bindings: readonly ParameterBinding[],
    playbackTime: number,
    beatPhase: number,
    beatConfidence: number,
    instanceEntropy: number,
): Record<string, number> {
    const modulated: Record<string, number> = { ...resolved };
    const visited = new Set<string>();

    for (const binding of bindings) {
        if (visited.has(binding.parameter)) {
            continue;
        }
        visited.add(binding.parameter);

        // A rate binding is already in continuous motion and its parameter accumulates outside the
        // output range, which is a velocity rather than a position — clamping it there would stop
        // the integration dead. An impulse is a shaped envelope whose whole value is its shape.
        // Both are left alone; this exists for parameters that would otherwise sit still.
        if (bindingMode(binding) !== 'value') {
            continue;
        }

        const current = resolved[binding.parameter];
        if (!Number.isFinite(current)) {
            continue;
        }

        const low = Math.min(...binding.outputRange);
        const high = Math.max(...binding.outputRange);
        const span = high - low;
        if (span <= 0) {
            continue;
        }

        const identity = fractional(
            instanceEntropy * 997.3 + stringPhase(binding.parameter) * 431.9,
        );
        const dynamics = dynamicsFor(binding.role);
        const rate = lerp(dynamics.rate, identity);
        const phase = playbackTime * rate * TAU + identity * TAU;
        const beatWarp = beatPhase * TAU * (0.18 + identity * 0.34) * beatConfidence;
        const motion = Math.sin(phase + beatWarp) * 0.68
            + Math.sin(phase * 1.731 + identity * 11.0) * 0.32;
        const depth = span * lerp(dynamics.depth, identity);

        modulated[binding.parameter] = clamp(current + motion * depth, low, high);
    }

    return modulated;
}

function fractional(value: number): number {
    return value - Math.floor(value);
}

function stringPhase(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967295;
}

function clamp(value: number, low: number, high: number): number {
    return value < low ? low : value > high ? high : value;
}
