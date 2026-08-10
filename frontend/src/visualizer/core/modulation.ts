/**
 * Concurrent parameter motion.
 *
 * Audio bindings provide the immediate musical response. This adds a slower, independent wander to
 * every bound parameter so several layers keep breathing, folding, and drifting at once between
 * transients. The wander is value noise over an unrepeating lattice, not an oscillator: it visits
 * new positions for as long as the track runs. Playback time is the only clock, therefore pause
 * and seek semantics remain intact.
 */

import { bindingMode, clamp01, type ParameterBinding } from './bindings';

const TAU = Math.PI * 2;

/**
 * How far and how fast a parameter's slow motion travels, derived from its own envelope.
 *
 * This was a table keyed by the binding's role: structural roles drifted far and slowly, detail
 * roles a little and often. The role is gone, and the property the table was reaching for is
 * already written into every binding — its response speed. A binding that follows the music over
 * seconds is a structural parameter whatever it is called, and one that snaps in tens of
 * milliseconds is detail. Deriving the dynamics from attack + release keeps the old contrast (a
 * slow arc visibly larger than the ripple riding on it) and lets the per-scene expression draw
 * carry through: the same parameter drawn as `glide` drifts in wide arcs, drawn as `punch` it
 * twitches.
 *
 * Anchors match the retired table's extremes: a ~2.6s envelope gets the old large-scale dynamics
 * (depth [0.18, 0.34], rate [0.012, 0.045] Hz), a ~0.15s envelope the old detail dynamics
 * (depth [0.05, 0.12], rate [0.18, 0.5] Hz), log-interpolated between and clamped outside. The
 * fast anchor sits at 0.15s rather than at the fastest catalog envelope so that a typical
 * half-second follower lands on the old unroled default (depth ~[0.1, 0.22]) — the drift the
 * whole catalog was tuned against. `depth` is a fraction of the headroom left between the
 * audio-resolved value and the limit the drift travels toward; `rate` is in hertz. The drift
 * remains a garnish on a parameter the music is already driving, not a second driver.
 */
const SLOW_ENVELOPE_SECONDS = 2.6;
const FAST_ENVELOPE_SECONDS = 0.15;
const SLOW_DYNAMICS = { depth: [0.18, 0.34] as [number, number], rate: [0.012, 0.045] as [number, number] };
const FAST_DYNAMICS = { depth: [0.05, 0.12] as [number, number], rate: [0.18, 0.5] as [number, number] };

function dynamicsFor(binding: ParameterBinding): { depth: [number, number]; rate: [number, number] } {
    const envelope = Math.max(1e-3, binding.attack + binding.release);
    const position = clamp01(
        (Math.log(envelope) - Math.log(FAST_ENVELOPE_SECONDS))
        / (Math.log(SLOW_ENVELOPE_SECONDS) - Math.log(FAST_ENVELOPE_SECONDS)),
    );

    const blend = (fast: [number, number], slow: [number, number]): [number, number] => [
        fast[0] + (slow[0] - fast[0]) * position,
        fast[1] + (slow[1] - fast[1]) * position,
    ];

    return {
        depth: blend(FAST_DYNAMICS.depth, SLOW_DYNAMICS.depth),
        // Rates span an order of magnitude; interpolate them in log space so the middle of the
        // envelope range lands in the middle of the audible tempo range, not near the slow end.
        rate: [
            Math.exp(Math.log(FAST_DYNAMICS.rate[0]) + (Math.log(SLOW_DYNAMICS.rate[0]) - Math.log(FAST_DYNAMICS.rate[0])) * position),
            Math.exp(Math.log(FAST_DYNAMICS.rate[1]) + (Math.log(SLOW_DYNAMICS.rate[1]) - Math.log(FAST_DYNAMICS.rate[1])) * position),
        ],
    };
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
        const dynamics = dynamicsFor(binding);
        const rate = lerp(dynamics.rate, identity);
        const phase = playbackTime * rate + identity * 127.31;

        // Nudged by transients rather than by beat phase. Beat phase is a position between beats —
        // it advances whether or not anything is playing, so warping on it produced a metronome
        // riding under every parameter regardless of what the music did. The warp is scaled by the
        // role's own depth so a detail parameter twitches on a hit and a structural one leans.
        const warp = clamp01(transient) * lerp(dynamics.depth, identity) * 0.6;

        // A phase-warped oscillator rather than plain sines. Two sines of fixed ratio are periodic
        // in playback time: the parameter retraces the same figure every cycle, which is the
        // reported "motion with periodicity instead of additive chaos" — for an unchanged graph,
        // seconds one and five looked alike because they *were* alike, one lap apart. Here lattice
        // noise wanders the sine's phase by up to ±2.5 radians per cycle and a second noise rides
        // on top, so the excursion each period is still guaranteed — which is what keeps a slow
        // structural role sweeping further than a fast detail role — but no two cycles trace the
        // same path, for as long as the track runs. Still a pure function of playback time, so
        // pause and seek semantics are untouched.
        const wander = valueNoise(phase * 0.37 + 11.3, identity) * 2.5;
        const ripple = valueNoise(phase * 2.317 + 71.7, identity);
        const motion = Math.sin(TAU * (phase + warp) + wander) * 0.62 + ripple * 0.38;

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

/**
 * Smooth 1D value noise in [-1, 1]: hashed lattice values, smoothstep-interpolated.
 *
 * The lattice hash never repeats over any practical playback length, which is the property the
 * oscillator it replaced lacked. `seed` separates parameters so two of them at the same rate do
 * not trace the same wander.
 */
function valueNoise(position: number, seed: number): number {
    const cell = Math.floor(position);
    const t = position - cell;
    const eased = t * t * (3 - 2 * t);
    const a = latticeValue(cell, seed);
    const b = latticeValue(cell + 1, seed);
    return a + (b - a) * eased;
}

function latticeValue(cell: number, seed: number): number {
    let hash = Math.imul(cell | 0, 374761393) ^ Math.imul(Math.floor(seed * 65521), 668265263);
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    hash ^= hash >>> 16;
    return ((hash >>> 0) / 4294967295) * 2 - 1;
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
