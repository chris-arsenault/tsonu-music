/**
 * Concurrent parameter motion.
 *
 * Audio bindings provide the immediate musical response. This adds a slower, independent motion to
 * every bound parameter so several layers keep breathing, folding, and drifting at once between
 * transients. Playback time is the only clock, therefore pause and seek semantics remain intact.
 */

import type { ParameterBinding } from './bindings';

const TAU = Math.PI * 2;

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
        const depth = span * (0.045 + identity * 0.055);

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
