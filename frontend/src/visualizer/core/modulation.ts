/**
 * Concurrent parameter motion.
 *
 * Audio bindings provide the immediate musical response. This adds a slower, independent motion to
 * every bound parameter so several layers keep breathing, folding, and drifting at once between
 * transients. Playback time is the only clock, therefore pause and seek semantics remain intact.
 */

import { bindingMode, type ParameterBinding } from './bindings';

const TAU = Math.PI * 2;

/**
 * Fraction of a binding's range the slow motion sweeps.
 *
 * This was 4.5% to 10%, which on a typical range is below the threshold of visibility — the scene
 * was described as breathing while measurably holding still. Motion is still clamped to the
 * binding's authored range, so widening it cannot push a parameter anywhere its author did not
 * already permit.
 */
const DEPTH_FLOOR = 0.2;
const DEPTH_SPAN = 0.25;

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
        const rate = 0.035 + identity * 0.105;
        const phase = playbackTime * rate * TAU + identity * TAU;
        const beatWarp = beatPhase * TAU * (0.18 + identity * 0.34) * beatConfidence;
        const motion = Math.sin(phase + beatWarp) * 0.68
            + Math.sin(phase * 1.731 + identity * 11.0) * 0.32;
        const depth = span * (DEPTH_FLOOR + identity * DEPTH_SPAN);

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
