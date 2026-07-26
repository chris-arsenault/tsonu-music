/**
 * Audio analysis primitives (spec section 7).
 *
 * All of it is pure so the worklet can import it and Node can test it. Stateful parts are reducers:
 * they take their own state plus an observation and return new state, never touching a host global.
 *
 * Extraction, normalization, and beat detection live here and are never duplicated inside plugins.
 */

import { binFrequency } from './fft';
import { clamp01 } from './bindings';

export interface BandRange {
    name: BandName;
    lowHz: number;
    highHz: number;
}

export type BandName =
    | 'subBass'
    | 'bass'
    | 'lowMid'
    | 'mid'
    | 'highMid'
    | 'treble';

export const SPECTRAL_BANDS: readonly BandRange[] = [
    { name: 'subBass', lowHz: 20, highHz: 60 },
    { name: 'bass', lowHz: 60, highHz: 250 },
    { name: 'lowMid', lowHz: 250, highHz: 500 },
    { name: 'mid', lowHz: 500, highHz: 2000 },
    { name: 'highMid', lowHz: 2000, highHz: 4000 },
    { name: 'treble', lowHz: 4000, highHz: 16000 },
];

export function rms(samples: Float32Array): number {
    if (samples.length === 0) {
        return 0;
    }

    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
        sum += samples[i] * samples[i];
    }

    return Math.sqrt(sum / samples.length);
}

export function peak(samples: Float32Array): number {
    let highest = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const magnitude = Math.abs(samples[i]);
        if (magnitude > highest) {
            highest = magnitude;
        }
    }

    return highest;
}

/**
 * Mean magnitude across the bins whose centre frequency falls in [lowHz, highHz).
 *
 * Half-open, and rounded outward at neither end. Widening with `floor` below and `ceil` above put
 * every band's edge bins in its neighbour as well: at 48 kHz with a 1024-point FFT that gave subBass
 * bins {0,1,2} and bass bins {1..6}, so two of subBass's three bins were also bass bins and the two
 * were near-duplicates — while being offered as distinct alternatives within the same binding role
 * pool. Bin 0 is DC, so including it also let any signal offset read as sub-bass energy.
 *
 * A band narrower than one bin collapses to the single bin nearest its centre rather than reporting
 * nothing, which is what the low band does at small FFT sizes.
 */
export function bandEnergy(
    magnitude: Float32Array,
    fftSize: number,
    sampleRate: number,
    lowHz: number,
    highHz: number,
): number {
    const limit = magnitude.length - 1;
    if (limit < 1 || highHz <= lowHz) {
        return 0;
    }

    const lowBin = Math.min(limit, Math.max(1, Math.ceil((lowHz * fftSize) / sampleRate)));
    const highBin = Math.min(limit, Math.ceil((highHz * fftSize) / sampleRate) - 1);

    if (highBin < lowBin) {
        const centre = Math.round(((lowHz + highHz) * 0.5 * fftSize) / sampleRate);
        return magnitude[Math.min(limit, Math.max(1, centre))];
    }

    let sum = 0;
    for (let bin = lowBin; bin <= highBin; bin += 1) {
        sum += magnitude[bin];
    }

    return sum / (highBin - lowBin + 1);
}

/**
 * Per-band gain that makes the six bands read alike on a neutral spectrum.
 *
 * `bandEnergy` reports a mean per bin, and the bands span from tens of hertz to twelve kilohertz.
 * Music rolls off with frequency, so a wide high band averages a great many small bins while a narrow
 * low band averages a few large ones. Feeding those raw into one shared ceiling meant the loudest
 * band set the ceiling and the rest were divided by a number they could not approach: measured over
 * real material, treble sat at a median of 0.0002 and highMid at 0.0016, against subBass at 0.355.
 * Four of six channels never left the bottom one percent of their range, so every parameter bound to
 * one was pinned at its output floor for the length of a track.
 *
 * Pink noise — equal energy per octave, magnitude falling as 1/f — is the reference. Its mean over a
 * band works out to `ln(high/low) / (high - low)`, so dividing each band by its own pink reference
 * makes all six read equal on pink and lets genuine spectral balance show as departure from it. The
 * weights are derived from the band table rather than tuned, so changing a band edge cannot leave a
 * stale constant behind.
 */
export const PINK_BAND_WEIGHTS: Readonly<Record<BandName, number>> = (() => {
    const reference = (band: BandRange): number =>
        Math.log(band.highHz / band.lowHz) / (band.highHz - band.lowHz);

    // Normalized so bass reads 1. The absolute scale cancels in the shared ceiling; only the ratios
    // between bands carry meaning.
    const anchor = reference(SPECTRAL_BANDS.find((band) => band.name === 'bass') ?? SPECTRAL_BANDS[0]);

    const weights = {} as Record<BandName, number>;
    for (const band of SPECTRAL_BANDS) {
        weights[band.name] = anchor / reference(band);
    }

    return weights;
})();

/**
 * Spectral centroid in Hz — the magnitude-weighted mean frequency. Rises with brightness and
 * sharpness, which is why it drives complexity and palette movement rather than level.
 */
export function spectralCentroid(
    magnitude: Float32Array,
    fftSize: number,
    sampleRate: number,
): number {
    let weighted = 0;
    let total = 0;

    for (let bin = 0; bin < magnitude.length; bin += 1) {
        weighted += magnitude[bin] * binFrequency(bin, fftSize, sampleRate);
        total += magnitude[bin];
    }

    return total > 0 ? weighted / total : 0;
}

/** Positive-rectified spectral flux: how much energy appeared since the previous frame. */
export function spectralFlux(magnitude: Float32Array, previous: Float32Array): number {
    const bins = Math.min(magnitude.length, previous.length);
    if (bins === 0) {
        return 0;
    }

    let sum = 0;
    for (let bin = 0; bin < bins; bin += 1) {
        const rise = magnitude[bin] - previous[bin];
        if (rise > 0) {
            sum += rise;
        }
    }

    return sum / bins;
}

/**
 * Decaying peak follower, used to normalize an unbounded measure into [0, 1] without a fixed gain
 * assumption. The peak rises instantly and falls slowly, so quiet passages stay expressive.
 */
export interface PeakFollower {
    peak: number;
}

export function createPeakFollower(): PeakFollower {
    return { peak: 0 };
}

const PEAK_DECAY_PER_SECOND = 0.4;
const PEAK_FLOOR = 1e-4;

export function followPeak(
    follower: PeakFollower,
    value: number,
    deltaSeconds: number,
): { follower: PeakFollower; normalized: number } {
    const decayed = Math.max(PEAK_FLOOR, follower.peak * Math.exp(-PEAK_DECAY_PER_SECOND * deltaSeconds));
    const nextPeak = Math.max(decayed, value);

    return {
        follower: { peak: nextPeak },
        normalized: clamp01(value / nextPeak),
    };
}

/* -------------------------------------------------------------------------- */
/* Excitation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Running mean and mean absolute deviation for one measure.
 *
 * A peak follower answers "how loud is this against the loudest thing lately", which on mastered
 * music is close to constant. This answers "how far is this above its own recent behaviour", which
 * is what actually tracks musical events. The two are complementary: level carries the balance
 * between bands, excitation carries the dynamics that level cannot express.
 */
export interface ExcitationFollower {
    mean: number;
    deviation: number;
}

export function createExcitationFollower(): ExcitationFollower {
    return { mean: 0, deviation: 0 };
}

/** Seconds for the running statistics to forget. Long enough to span a bar at most tempos. */
const EXCITATION_WINDOW_SECONDS = 1.6;

/** Deviations above the mean that read as fully excited. */
const EXCITATION_HEADROOM = 2;

/**
 * Smallest deviation, as a fraction of the measure's own mean, that the denominator may fall to.
 *
 * Without it a steady measure stays slightly excited forever: the excess above the mean and the
 * deviation both decay at the same exponential rate, so their ratio falls only as one over the frame
 * count. A measure varying by less than this fraction of itself is steady, and dividing by its
 * vanishing deviation would amplify noise into full-scale response. Relative rather than absolute, so
 * a quiet band is held to the same standard as a loud one.
 */
const MINIMUM_RELATIVE_DEVIATION = 0.08;

/** Below this the measure is silence rather than a quiet passage, and excitation reads zero. */
const EXCITATION_FLOOR = 1e-6;

/**
 * Advances the statistics and reports how far the observation sits above its own recent mean,
 * normalized by its own recent deviation.
 *
 * Deliberately one-sided: falling below the mean is not negative excitation, it is rest. A measure
 * with no variation reports zero however loud it is, which is what stops a sustained bass note from
 * pinning a parameter at full scale for the length of a track.
 */
export function followExcitation(
    follower: ExcitationFollower,
    value: number,
    deltaSeconds: number,
): { follower: ExcitationFollower; excitation: number } {
    // Framerate-independent exponential approach, matching how bindings smooth.
    const factor = deltaSeconds > 0
        ? 1 - Math.exp(-deltaSeconds / EXCITATION_WINDOW_SECONDS)
        : 0;

    const excess = value - follower.mean;
    const scale = Math.max(
        follower.deviation * EXCITATION_HEADROOM,
        follower.mean * MINIMUM_RELATIVE_DEVIATION,
    );
    const excitation = scale > EXCITATION_FLOOR ? clamp01(excess / scale) : 0;

    return {
        follower: {
            mean: follower.mean + excess * factor,
            deviation: follower.deviation + (Math.abs(excess) - follower.deviation) * factor,
        },
        excitation,
    };
}

/* -------------------------------------------------------------------------- */
/* Onset detection                                                            */
/* -------------------------------------------------------------------------- */

const FLUX_HISTORY_SIZE = 43;
const ONSET_THRESHOLD_MULTIPLIER = 1.5;
const ONSET_THRESHOLD_FLOOR = 1e-5;
const ONSET_MINIMUM_GAP_SECONDS = 0.05;

export interface OnsetDetectorState {
    /** Ring buffer of recent flux values. */
    readonly history: Float32Array;
    readonly writeIndex: number;
    readonly filled: number;
    readonly lastOnsetTime: number;
}

export function createOnsetDetector(): OnsetDetectorState {
    return {
        history: new Float32Array(FLUX_HISTORY_SIZE),
        writeIndex: 0,
        filled: 0,
        lastOnsetTime: Number.NEGATIVE_INFINITY,
    };
}

export interface OnsetResult {
    state: OnsetDetectorState;
    onset: boolean;
    /** Normalized 0..1 excess over the adaptive threshold. */
    strength: number;
}

/**
 * Adaptive-threshold onset detection. A flux value is an onset when it exceeds a multiple of the
 * recent local mean, subject to a minimum gap so one transient does not fire repeatedly.
 */
export function detectOnset(
    state: OnsetDetectorState,
    flux: number,
    time: number,
): OnsetResult {
    const history = Float32Array.from(state.history);
    history[state.writeIndex] = flux;

    const nextState: OnsetDetectorState = {
        history,
        writeIndex: (state.writeIndex + 1) % FLUX_HISTORY_SIZE,
        filled: Math.min(state.filled + 1, FLUX_HISTORY_SIZE),
        lastOnsetTime: state.lastOnsetTime,
    };

    // Until the window fills, there is no reliable local mean to compare against.
    if (nextState.filled < FLUX_HISTORY_SIZE) {
        return { state: nextState, onset: false, strength: 0 };
    }

    let sum = 0;
    for (let i = 0; i < FLUX_HISTORY_SIZE; i += 1) {
        sum += history[i];
    }
    const mean = sum / FLUX_HISTORY_SIZE;
    const threshold = Math.max(ONSET_THRESHOLD_FLOOR, mean * ONSET_THRESHOLD_MULTIPLIER);

    const gapElapsed = time - state.lastOnsetTime >= ONSET_MINIMUM_GAP_SECONDS;
    if (flux <= threshold || !gapElapsed) {
        return { state: nextState, onset: false, strength: 0 };
    }

    return {
        state: { ...nextState, lastOnsetTime: time },
        onset: true,
        // Compressed ratio rather than a clamped linear excess. A linear measure saturates at 1
        // almost immediately against a quiet background, which would flatten every onset to full
        // strength and leave nothing for burst magnitude to respond to.
        strength: clamp01(1 - threshold / flux),
    };
}

/** Discards flux history and the onset gate. Applied on seek and track change. */
export function resetOnsetDetector(state: OnsetDetectorState): OnsetDetectorState {
    return {
        history: new Float32Array(state.history.length),
        writeIndex: 0,
        filled: 0,
        lastOnsetTime: Number.NEGATIVE_INFINITY,
    };
}

/* -------------------------------------------------------------------------- */
/* Beat tracking                                                              */
/* -------------------------------------------------------------------------- */

const ONSET_MEMORY = 24;
const MINIMUM_BEAT_PERIOD = 0.3;
const MAXIMUM_BEAT_PERIOD = 1.0;
const GRID_TOLERANCE = 0.09;
const MINIMUM_ONSETS_FOR_TEMPO = 5;

export interface BeatTrackerState {
    /** Recent onset times, oldest first, bounded to `ONSET_MEMORY`. */
    readonly onsetTimes: readonly number[];
    readonly periodSeconds: number;
    readonly confidence: number;
    readonly anchorTime: number;
    /** Consecutive onsets that missed the current grid. See `anchorFor`. */
    readonly offGridRun: number;
}

export function createBeatTracker(): BeatTrackerState {
    return {
        onsetTimes: [],
        periodSeconds: 0,
        confidence: 0,
        anchorTime: 0,
        offGridRun: 0,
    };
}

/**
 * Re-estimates tempo from the remembered onset times. Every inter-onset interval inside the plausible
 * range is treated as a candidate period and scored by how many onsets fall on its grid; the best
 * score wins. Confidence is the share of onsets explained, so a track with no steady pulse reports
 * low confidence rather than an arbitrary tempo.
 */
export function observeOnset(state: BeatTrackerState, time: number): BeatTrackerState {
    const onsetTimes = [...state.onsetTimes, time].slice(-ONSET_MEMORY);

    if (onsetTimes.length < MINIMUM_ONSETS_FOR_TEMPO) {
        return { ...state, onsetTimes, anchorTime: time };
    }

    let bestPeriod = 0;
    let bestScore = 0;

    for (let i = 0; i < onsetTimes.length; i += 1) {
        for (let j = i + 1; j < onsetTimes.length; j += 1) {
            const candidate = onsetTimes[j] - onsetTimes[i];
            if (candidate < MINIMUM_BEAT_PERIOD || candidate > MAXIMUM_BEAT_PERIOD) {
                continue;
            }

            const score = scoreGrid(onsetTimes, candidate, time);
            if (score > bestScore) {
                bestScore = score;
                bestPeriod = candidate;
            }
        }
    }

    if (bestPeriod === 0) {
        return { ...state, onsetTimes, confidence: 0, anchorTime: time };
    }

    return {
        onsetTimes,
        periodSeconds: bestPeriod,
        confidence: clamp01(bestScore / onsetTimes.length),
        ...anchorFor(state, bestPeriod, time),
    };
}

/**
 * How many consecutive onsets must miss the grid before it is moved.
 *
 * Not one, because most music puts something between the beats — an off-beat hat alternates on-grid
 * and off-grid onsets forever, and re-anchoring on each miss flips the grid by half a beat every
 * other onset. A genuine tempo or phase change produces a run of misses instead, which this clears.
 */
const OFF_GRID_RUN_TO_REANCHOR = 3;

/**
 * Where the beat grid starts.
 *
 * This used to be the most recent onset, unconditionally. That moves the anchor several times a
 * second, and everything downstream reads phase and beat number against it: elapsed beats since the
 * anchor was therefore almost always less than one, so phase never swept past roughly a half and the
 * beat index sat at zero. Measured over twenty seconds of 120 bpm material with onsets every quarter
 * second, one beat event was emitted where forty were due.
 *
 * The anchor is a phase reference, not a record of the last thing that happened. It is kept while
 * onsets keep landing on the grid it defines, and moved only once several in a row do not — which
 * also absorbs drift from a slightly-off period estimate, since drift eventually pushes a run of
 * onsets off the grid.
 */
function anchorFor(
    state: BeatTrackerState,
    period: number,
    time: number,
): { anchorTime: number; offGridRun: number } {
    if (state.periodSeconds <= 0 || state.confidence <= 0) {
        return { anchorTime: time, offGridRun: 0 };
    }

    const beats = (time - state.anchorTime) / period;
    const offGrid = Math.abs(beats - Math.round(beats)) * period;

    if (offGrid <= GRID_TOLERANCE) {
        return { anchorTime: state.anchorTime, offGridRun: 0 };
    }

    const run = state.offGridRun + 1;

    return run >= OFF_GRID_RUN_TO_REANCHOR
        ? { anchorTime: time, offGridRun: 0 }
        : { anchorTime: state.anchorTime, offGridRun: run };
}

function scoreGrid(onsetTimes: readonly number[], period: number, anchor: number): number {
    let aligned = 0;

    for (const onsetTime of onsetTimes) {
        const beats = (anchor - onsetTime) / period;
        const distance = Math.abs(beats - Math.round(beats));
        if (distance * period <= GRID_TOLERANCE) {
            aligned += 1;
        }
    }

    return aligned;
}

/**
 * Beat phase at `time`: 0 on a beat, approaching 1 just before the next. Returns 0 when no tempo is
 * held, so a caller with no confident tempo gets a still value rather than a free-running metronome.
 */
export function beatPhaseAt(state: BeatTrackerState, time: number): number {
    if (state.periodSeconds <= 0 || state.confidence <= 0) {
        return 0;
    }

    const elapsed = (time - state.anchorTime) / state.periodSeconds;
    const phase = elapsed % 1;

    return phase < 0 ? phase + 1 : phase;
}

/** Drops tempo confidence while keeping nothing from the previous position. */
export function invalidateTempo(): BeatTrackerState {
    return createBeatTracker();
}
