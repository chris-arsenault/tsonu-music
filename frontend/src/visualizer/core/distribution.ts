/**
 * Channel occupancy normalisation.
 *
 * A binding maps `[0, 1]` onto the range its author wrote, so a channel that never leaves the bottom
 * fifth of `[0, 1]` gives every parameter bound to it a fifth of its intended travel. Measured across
 * the catalog, the median binding traversed nineteen percent of its output range and a hundred and
 * sixty-three of three hundred and thirteen traversed under a quarter. The producer was not wrong —
 * a peak follower answers "how loud is this against the loudest thing lately", and on mastered music
 * that answer is close to constant, which is exactly what keeps the balance between bands meaningful.
 * It is simply not the question a consumer's `[0, 1]` is asking.
 *
 * This answers the consumer's question: where does the current value sit within this channel's own
 * recent behaviour? A decaying histogram gives the empirical distribution, and reporting the value's
 * own quantile within it produces an output that is uniform over `[0, 1]` by construction, whatever
 * scale, spread, or offset the input has.
 *
 * The alternative was to declare `inputRange` on each of the three hundred bindings from measured
 * percentiles. That works on the material it was measured against and goes stale on everything else:
 * a sparse acoustic track and a loud mastered one do not share a distribution, and neither shares one
 * with whatever bed the constants were taken from. A channel that carries its own distribution needs
 * no such constant and cannot be over-fitted to a sample.
 *
 * Pure, so the recurrence deciding how far every parameter in the scene can travel is testable in the
 * Node environment.
 */

import { clamp01 } from './bindings';

/**
 * Histogram resolution.
 *
 * The output cannot resolve two values inside one bin except by the linear interpolation across it,
 * so this sets the finest distinction the mapping can draw. A hundred and twenty-eight puts the
 * narrowest measured channel — `mid`, spanning 0.150 to 0.254 between its fifth and ninety-fifth
 * percentiles — across thirteen bins.
 */
const BIN_COUNT = 128;

/**
 * How long the distribution remembers.
 *
 * The length of this window is the whole design. Short, and every passage reads full scale because it
 * is only ever ranked against itself — which is the failure the shared band ceiling in `features.ts`
 * was written to avoid, arriving by a different route. Long, and a track change takes a minute to
 * take effect.
 *
 * Forty seconds spans about two sections of most music, so a verse and the chorus after it are in the
 * window together and map to different parts of the range. Dynamics within that span survive; only
 * the systematic compression across it is removed.
 */
const WINDOW_SECONDS = 40;

/**
 * Playing time before the mapping is trusted completely.
 *
 * Weight accumulates in seconds rather than in observations, so this is independent of how often the
 * worklet posts and of the frame rate. Below it the output blends back toward the raw value, because
 * a quantile against four seconds of history is a quantile against noise.
 */
const WARMUP_SECONDS = 6;

/**
 * Spread, as inter-decile range, below which a channel is treated as not varying.
 *
 * Without this a genuinely steady measure is catastrophic: its own measurement noise fills the
 * histogram and the mapping spreads that noise across the whole output range, turning a silent band
 * into a full-scale control signal. A band that is absent should read absent.
 *
 * Ramped rather than switched, so a channel that is merely quiet degrades toward its raw value
 * instead of crossing a threshold mid-track.
 */
const MINIMUM_SPREAD = 0.01;
const CONFIDENT_SPREAD = 0.04;

export interface DistributionFollower {
    /** Decaying weight per bin, in seconds of observation. */
    readonly bins: Float32Array;
    /** Sum of `bins`, carried separately so the common path does not re-add it. */
    readonly weight: number;
}

export function createDistributionFollower(): DistributionFollower {
    return { bins: new Float32Array(BIN_COUNT), weight: 0 };
}

/**
 * Advances the distribution and reports where `value` sits inside it.
 *
 * The quantile is taken against the history *before* this observation joins it, so the answer is
 * "where does this sit against what came before" rather than a value being partly ranked against
 * itself.
 *
 * A frozen clock passes zero delta: nothing decays, nothing accumulates, and the reported value comes
 * from the distribution as it stands. That is the same freeze contract every other advance honours.
 */
export function followDistribution(
    follower: DistributionFollower,
    value: number,
    deltaSeconds: number,
): { follower: DistributionFollower; normalized: number } {
    const observed = clamp01(value);

    if (!(deltaSeconds > 0)) {
        return { follower, normalized: mapThrough(follower, observed) };
    }

    const decay = Math.exp(-deltaSeconds / WINDOW_SECONDS);
    const bins = new Float32Array(BIN_COUNT);
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
        bins[bin] = follower.bins[bin] * decay;
    }

    const decayed: DistributionFollower = { bins, weight: follower.weight * decay };
    const normalized = mapThrough(decayed, observed);

    // Weighted by time rather than by count, so the steady-state total is `WINDOW_SECONDS` whatever
    // rate the observations arrive at, and a dropped analysis frame costs its own duration rather
    // than one whole sample.
    bins[binFor(observed)] += deltaSeconds;

    return { follower: { bins, weight: decayed.weight + deltaSeconds }, normalized };
}

/** The value's quantile, blended back toward the value itself where the history cannot support it. */
function mapThrough(follower: DistributionFollower, observed: number): number {
    if (follower.weight <= 0) {
        return observed;
    }

    const confidence = clamp01(follower.weight / WARMUP_SECONDS) * spreadConfidence(follower);
    if (confidence <= 0) {
        return observed;
    }

    return observed + (cumulativeAt(follower, observed) - observed) * confidence;
}

function binFor(value: number): number {
    return Math.min(BIN_COUNT - 1, Math.floor(value * BIN_COUNT));
}

/**
 * Empirical cumulative distribution at `value`, interpolated across the bin holding it.
 *
 * Interpolation is what keeps the output continuous. Taking whole bins gives a staircase with a
 * hundred and twenty-eight steps, and a parameter driven by a staircase reads as stepping rather
 * than as moving.
 */
export function cumulativeAt(follower: DistributionFollower, value: number): number {
    if (follower.weight <= 0) {
        return clamp01(value);
    }

    const scaled = clamp01(value) * BIN_COUNT;
    const index = binFor(clamp01(value));
    const withinBin = clamp01(scaled - index);

    let below = 0;
    for (let bin = 0; bin < index; bin += 1) {
        below += follower.bins[bin];
    }

    return clamp01((below + follower.bins[index] * withinBin) / follower.weight);
}

/** The value at which `fraction` of the observed weight lies below, in input units. */
export function quantile(follower: DistributionFollower, fraction: number): number {
    if (follower.weight <= 0) {
        return 0;
    }

    const target = follower.weight * clamp01(fraction);
    let cumulative = 0;

    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
        const next = cumulative + follower.bins[bin];
        if (next >= target) {
            const withinBin = follower.bins[bin] > 0 ? (target - cumulative) / follower.bins[bin] : 0;
            return (bin + clamp01(withinBin)) / BIN_COUNT;
        }
        cumulative = next;
    }

    return 1;
}

/** How far the mapping is applied, from how much the channel actually varies. */
function spreadConfidence(follower: DistributionFollower): number {
    const spread = quantile(follower, 0.9) - quantile(follower, 0.1);
    if (spread <= MINIMUM_SPREAD) {
        return 0;
    }
    if (spread >= CONFIDENT_SPREAD) {
        return 1;
    }

    const t = (spread - MINIMUM_SPREAD) / (CONFIDENT_SPREAD - MINIMUM_SPREAD);
    return t * t * (3 - 2 * t);
}
