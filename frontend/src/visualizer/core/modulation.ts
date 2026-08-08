/**
 * Concurrent parameter motion.
 *
 * Audio bindings provide the immediate musical response. This adds a slower, independent motion to
 * every bound parameter so several layers keep breathing, folding, and drifting at once between
 * transients. Playback time is the only clock, therefore pause and seek semantics remain intact.
 */

import { bindingMode, clamp01, type BindingRole, type ParameterBinding } from './bindings';

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
 * little and often. `depth` is a fraction of the headroom left between the audio-resolved value and
 * the limit the drift is travelling toward; `rate` is in hertz.
 *
 * The depths are roughly half what they were, and the rates are unchanged. Both figures were set
 * while the audio-resolved value moved about a fifth of its range, because every channel occupied a
 * fifth of `[0, 1]` — so a drift of half the remaining headroom was a modest addition to a parameter
 * that was barely moving. With the channels normalized against their own distributions the audio
 * moves nine tenths of the range, and the same fractions made the oscillator a co-driver: measured
 * over a hundred and fifty-four bound parameters, twenty-one moved further from the drift than from
 * the music, and the median parameter took only seventy-two percent of its motion from the audio.
 *
 * What the drift is for has not changed, which is why the rates have not: several layers should keep
 * breathing and folding between transients, on separate clocks, so the frame is never still. It is a
 * garnish on a parameter the music is already driving, not a second driver.
 */
const ROLE_DYNAMICS: Record<BindingRole, { depth: [number, number]; rate: [number, number] }> = {
    // Structure: wide, unhurried arcs that reshape the frame over many seconds.
    'large-scale-force': { depth: [0.18, 0.34], rate: [0.012, 0.045] },
    deformation: { depth: [0.16, 0.3], rate: [0.018, 0.06] },
    // Presence: the middle ground, and the closest to the old uniform behaviour.
    intensity: { depth: [0.12, 0.22], rate: [0.05, 0.12] },
    complexity: { depth: [0.14, 0.26], rate: [0.03, 0.09] },
    'lateral-force': { depth: [0.14, 0.28], rate: [0.04, 0.1] },
    // Detail: small and quick, riding on top of whatever the structure is doing. Scaled with the
    // structural roles rather than left alone, because the gap between them is the point — a
    // structural arc has to be visibly larger than the detail riding on it, and halving one end of
    // that comparison without the other would have flattened the two toward each other.
    detail: { depth: [0.05, 0.12], rate: [0.18, 0.5] },
    burst: { depth: [0.04, 0.1], rate: [0.25, 0.7] },
    'repeating-motion': { depth: [0.1, 0.2], rate: [0.1, 0.3] },
};

/** What an unroled binding gets: the middle of the range, as before. */
const DEFAULT_DYNAMICS = { depth: [0.1, 0.22] as [number, number], rate: [0.035, 0.14] as [number, number] };

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
    /** The transient envelope: an event, so the warp lands on hits instead of running as a clock. */
    transient: number,
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

        // Nudged by transients rather than by beat phase. Beat phase is a position between beats —
        // it advances whether or not anything is playing, so warping on it produced a metronome
        // riding under every parameter regardless of what the music did. The warp is scaled by the
        // role's own depth so a detail parameter twitches on a hit and a structural one leans.
        const warp = clamp01(transient) * TAU * lerp(dynamics.depth, identity) * 0.6;
        const motion = Math.sin(phase + warp) * 0.68
            + Math.sin(phase * 1.731 + identity * 11.0) * 0.32;

        // Depth is a share of the room left in the direction of travel, not of the whole range.
        //
        // It used to be a share of the span, added to the audio-resolved value and then clamped —
        // which meant the oscillator alone covered the entire range. Measured with the audio value
        // held at the middle of a zero-to-one binding, the output swept 0.000 to 1.000 and sat
        // pinned at a rail eighteen percent of the time, on a cycle of twenty-two to eighty-three
        // seconds. Moving the audio value by 0.6 shifted the output by 0.464, because the clamp ate
        // the rest. Audio was contributing a small offset to an oscillator that was already doing
        // everything, which is precisely the disconnection this drift was added to relieve.
        //
        // Taking it from the remaining headroom instead means the resolved value always sets the
        // centre and the result can never rail on its own.
        //
        // Symmetric — the smaller of the two gaps — rather than whichever gap the drift happens to
        // be heading into. Using the near gap going down and the far gap going up sounds like it
        // wastes less room, but it biases every parameter toward the middle of its range in
        // proportion to how far from the middle the music put it, which costs about a fifth of the
        // audio's authority. A parameter the music has driven near a limit drifts little, which is
        // the honest reading of a saturated control.
        const room = Math.min(current - low, high - current);
        const depth = room * lerp(dynamics.depth, identity);

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
