/**
 * Audio feature bus (spec section 7).
 *
 * The worklet detects; this bus presents. It normalizes raw measures into [0, 1], holds detected
 * events until they are actually audible, converts audio-thread timestamps into playback time, and
 * applies the clock's freeze and invalidation effects.
 *
 * Pure: `advanceFeatureBus` is a reducer, so latency handling and freeze behavior are testable
 * without an `AudioContext`.
 */

import {
    createExcitationFollower,
    createPeakFollower,
    followExcitation,
    followPeak,
    type BandName,
    type ExcitationFollower,
    type PeakFollower,
    PINK_BAND_WEIGHTS,
    SPECTRAL_BANDS,
} from './analysis';
import { clamp01 } from './bindings';
import { type ClockEffect, type PlaybackClock } from './clock';

export interface TimedFeatureEvent {
    feature: string;
    playbackTime: number;
    audioTime: number;
    strength: number;
    metadata?: Record<string, number>;
}

/**
 * Level and excitation are two different questions and plugins want different ones.
 *
 * Level is where a measure sits against the loudest thing heard lately. It carries the balance
 * between bands, and on mastered music it is close to constant: the dominant band sits near the top
 * of its range and a quiet band sits near the bottom of its own, whatever the music is doing.
 *
 * Excitation is how far a measure sits above its own recent behaviour. It is near zero at rest
 * however loud the track is, and rises on the events a listener would call musical. A parameter that
 * should respond to *what is happening* wants excitation; one that should respond to *what is there*
 * wants level.
 */
export interface ContinuousFeatures {
    rms: number;
    peak: number;

    subBass: number;
    bass: number;
    lowMid: number;
    mid: number;
    highMid: number;
    treble: number;

    rmsExcite: number;
    subBassExcite: number;
    bassExcite: number;
    lowMidExcite: number;
    midExcite: number;
    highMidExcite: number;
    trebleExcite: number;

    spectralCentroid: number;
    spectralFlux: number;

    /**
     * How recently something struck: one envelope over detected onsets, fast to rise and quick to
     * fall.
     *
     * Beat phase is a position between beats, not an event — it runs whether or not anything is
     * happening, so driving motion from it gives a metronome rather than a response. This is the
     * signal for "something just happened", and it is what the composite breathes on.
     */
    transient: number;

    beatConfidence: number;
    beatPhase: number;

    leftLevel: number;
    rightLevel: number;
    stereoBalance: number;
}

export interface AudioFeatureBus {
    continuous: ContinuousFeatures;
    events: {
        onset: TimedFeatureEvent[];
        beat: TimedFeatureEvent[];
        sectionChange: TimedFeatureEvent[];
    };
    waveform: Float32Array;
    spectrum: Float32Array;
}

/** One detection posted by the worklet, timestamped on the audio render thread. */
export interface RawOnset {
    audioTime: number;
    strength: number;
}

/** What the worklet posts each analysis frame. Raw, unnormalized, audio-thread timestamps. */
export interface FeatureSnapshot {
    audioTime: number;

    rms: number;
    peak: number;
    bands: Record<BandName, number>;
    spectralCentroidHz: number;
    spectralFlux: number;

    leftLevel: number;
    rightLevel: number;

    beatPeriodSeconds: number;
    beatConfidence: number;
    beatAnchorAudioTime: number;

    onsets: RawOnset[];

    waveform: Float32Array;
    spectrum: Float32Array;
}

export interface FeatureBusInput {
    /** Absent on frames where no new analysis arrived; continuous values then hold. */
    snapshot?: FeatureSnapshot;
    clock: PlaybackClock;
    effects: readonly ClockEffect[];
    /** `AudioContext.currentTime` for this frame. */
    currentAudioTime: number;
    /** `outputLatency + baseLatency`, or the fallback estimate. */
    latencySeconds: number;
    /** Frozen-aware: 0 while the clock is frozen. */
    deltaSeconds: number;
}

/**
 * Followers for the measures that self-normalize.
 *
 * `bands` is deliberately one shared ceiling for all six bands rather than one each. Per-band
 * ceilings would make every band read full scale on sustained content, erasing the relative balance
 * that section 20 depends on to give bass, midrange, and treble different jobs.
 *
 * A shared ceiling only works over quantities that are comparable to begin with, which raw band means
 * are not — see PINK_BAND_WEIGHTS, which is applied before the ceiling is taken. Without it the
 * ceiling was always set by the low bands and the high ones sat in the bottom one percent of their
 * range for the length of a track.
 */
export type FollowerName = 'rms' | 'peak' | 'flux' | 'bands';

/** Measures carrying an excitation channel beside their level: every band, plus overall level. */
export type ExcitationName = BandName | 'rms';

export const EXCITED_MEASURES: readonly ExcitationName[] = [
    'rms',
    'subBass',
    'bass',
    'lowMid',
    'mid',
    'highMid',
    'treble',
];

/** `bass` becomes `bassExcite`, matching how bindings name the feature. */
export function excitationFeatureName(measure: ExcitationName): string {
    return `${measure}Excite`;
}

export interface FeatureBusState {
    bus: AudioFeatureBus;
    followers: Record<FollowerName, PeakFollower>;
    /**
     * Per-measure running statistics. Kept separate from the peak followers because they answer a
     * different question and must not share a ceiling — coupling them is what flattened the bands.
     */
    excitation: Record<ExcitationName, ExcitationFollower>;
    pendingOnsets: readonly RawOnset[];
    /** Events detected before this audio time are discarded rather than presented. */
    transientGateUntilAudioTime: number;
    beat: { periodSeconds: number; confidence: number; anchorAudioTime: number };
    /** audioTime + offset = playbackTime. Re-observed while playing. */
    audioToPlaybackOffset: number;
    /**
     * Audio time of the last beat whose event was emitted, so each beat fires once.
     *
     * A time rather than an index because the grid anchor moves, which renumbers every index.
     */
    lastEmittedBeatAudioTime: number;
}

/**
 * How long after resuming to keep discarding detections. Long enough to cover a queued transient
 * from before the freeze, short enough that the first real hit after resume still lands.
 */
export const TRANSIENT_GATE_SECONDS = 0.12;

/** Highest centroid used for normalization. Above this, brightness is already saturated. */
const CENTROID_CEILING_HZ = 8000;

/**
 * How long a transient takes to fall away.
 *
 * Short enough that consecutive hits read as separate, long enough that one hit is visible for more
 * than a frame at any plausible frame rate.
 */
const TRANSIENT_RELEASE_SECONDS = 0.22;

const EMPTY_SPECTRUM = new Float32Array(0);

export function createFeatureBusState(): FeatureBusState {
    const followers: Record<FollowerName, PeakFollower> = {
        rms: createPeakFollower(),
        peak: createPeakFollower(),
        flux: createPeakFollower(),
        bands: createPeakFollower(),
    };

    return {
        bus: {
            continuous: zeroContinuous(),
            events: { onset: [], beat: [], sectionChange: [] },
            waveform: EMPTY_SPECTRUM,
            spectrum: EMPTY_SPECTRUM,
        },
        followers,
        excitation: Object.fromEntries(
            EXCITED_MEASURES.map((measure) => [measure, createExcitationFollower()]),
        ) as Record<ExcitationName, ExcitationFollower>,
        pendingOnsets: [],
        transientGateUntilAudioTime: 0,
        beat: { periodSeconds: 0, confidence: 0, anchorAudioTime: 0 },
        audioToPlaybackOffset: 0,
        lastEmittedBeatAudioTime: Number.NEGATIVE_INFINITY,
    };
}

export function advanceFeatureBus(state: FeatureBusState, input: FeatureBusInput): FeatureBusState {
    const afterEffects = applyEffects(state, input);
    const withSnapshot = input.snapshot
        ? absorbSnapshot(afterEffects, input, input.snapshot)
        : afterEffects;

    return presentEvents(withSnapshot, input);
}

function applyEffects(state: FeatureBusState, input: FeatureBusInput): FeatureBusState {
    if (input.effects.length === 0) {
        return state;
    }

    let next = state;

    if (input.effects.includes('clear-pending-events')) {
        next = {
            ...next,
            pendingOnsets: [],
            bus: { ...next.bus, events: { onset: [], beat: [], sectionChange: [] } },
        };
    }

    if (input.effects.includes('invalidate-tempo')) {
        next = {
            ...next,
            beat: { periodSeconds: 0, confidence: 0, anchorAudioTime: 0 },
            lastEmittedBeatAudioTime: Number.NEGATIVE_INFINITY,
            bus: {
                ...next.bus,
                continuous: { ...next.bus.continuous, beatConfidence: 0, beatPhase: 0 },
            },
        };
    }

    if (input.effects.includes('clear-analysis-history')) {
        // Excitation is short-term history by definition. Carrying a mean across a seek would report
        // the new position as a large event purely because it differs from the old one.
        next = {
            ...next,
            audioToPlaybackOffset: 0,
            excitation: Object.fromEntries(
                EXCITED_MEASURES.map((measure) => [measure, createExcitationFollower()]),
            ) as Record<ExcitationName, ExcitationFollower>,
        };
    }

    if (input.effects.includes('suppress-transients')) {
        next = {
            ...next,
            transientGateUntilAudioTime: input.currentAudioTime + TRANSIENT_GATE_SECONDS,
        };
    }

    return next;
}

function absorbSnapshot(
    state: FeatureBusState,
    input: FeatureBusInput,
    snapshot: FeatureSnapshot,
): FeatureBusState {
    const followers = { ...state.followers };
    const delta = input.deltaSeconds;

    const normalizeWith = (key: FollowerName, value: number): number => {
        const result = followPeak(followers[key], value, delta);
        followers[key] = result.follower;
        return result.normalized;
    };

    // One shared ceiling, driven by the loudest band, then every band divided by it. Dynamics still
    // come from the ceiling's decay; relative balance between bands survives.
    //
    // Weighted to the pink reference first. Raw band means are not comparable to one another — a wide
    // high band averages many small bins where a narrow low band averages a few large ones — so a
    // shared ceiling over raw values is set by the low bands and leaves the high ones at a few
    // thousandths of full scale forever. See PINK_BAND_WEIGHTS.
    const weighted = {} as Record<BandName, number>;
    let loudestBand = 0;
    for (const band of SPECTRAL_BANDS) {
        const energy = snapshot.bands[band.name] * PINK_BAND_WEIGHTS[band.name];
        weighted[band.name] = energy;
        if (energy > loudestBand) {
            loudestBand = energy;
        }
    }
    normalizeWith('bands', loudestBand);
    const bandCeiling = followers.bands.peak;
    const scaleBand = (band: BandName): number =>
        clamp01(bandCeiling > 0 ? weighted[band] / bandCeiling : 0);

    // Measured from raw energy, never from the scaled level. Running it on scaled values would put
    // every band back under one ceiling and reintroduce exactly the coupling excitation exists to
    // avoid: a quiet band's own dynamics would be divided away by a loud band's peak.
    const excitation = { ...state.excitation };
    const excite = (measure: ExcitationName, raw: number): number => {
        const result = followExcitation(excitation[measure], raw, delta);
        excitation[measure] = result.follower;
        return result.excitation;
    };

    const continuous: ContinuousFeatures = {
        ...state.bus.continuous,
        rms: normalizeWith('rms', snapshot.rms),
        peak: normalizeWith('peak', snapshot.peak),
        subBass: scaleBand('subBass'),
        bass: scaleBand('bass'),
        lowMid: scaleBand('lowMid'),
        mid: scaleBand('mid'),
        highMid: scaleBand('highMid'),
        treble: scaleBand('treble'),
        rmsExcite: excite('rms', snapshot.rms),
        subBassExcite: excite('subBass', snapshot.bands.subBass),
        bassExcite: excite('bass', snapshot.bands.bass),
        lowMidExcite: excite('lowMid', snapshot.bands.lowMid),
        midExcite: excite('mid', snapshot.bands.mid),
        highMidExcite: excite('highMid', snapshot.bands.highMid),
        trebleExcite: excite('treble', snapshot.bands.treble),
        spectralFlux: normalizeWith('flux', snapshot.spectralFlux),
        spectralCentroid: clamp01(snapshot.spectralCentroidHz / CENTROID_CEILING_HZ),
        leftLevel: clamp01(snapshot.leftLevel),
        rightLevel: clamp01(snapshot.rightLevel),
        stereoBalance: stereoBalance(snapshot.leftLevel, snapshot.rightLevel),
        beatConfidence: clamp01(snapshot.beatConfidence),
    };

    // While playing, the gap between audio-thread time and playback time is stable; record it so
    // detected events can be reported in playback time. A frozen clock keeps the last offset.
    const audioToPlaybackOffset = input.clock.state === 'playing'
        ? input.clock.playbackTime - input.currentAudioTime
        : state.audioToPlaybackOffset;

    return {
        ...state,
        followers,
        excitation,
        audioToPlaybackOffset,
        beat: {
            periodSeconds: snapshot.beatPeriodSeconds,
            confidence: snapshot.beatConfidence,
            anchorAudioTime: snapshot.beatAnchorAudioTime,
        },
        pendingOnsets: [...state.pendingOnsets, ...snapshot.onsets],
        bus: {
            ...state.bus,
            continuous,
            waveform: snapshot.waveform,
            spectrum: snapshot.spectrum,
        },
    };
}

/**
 * Releases detections once they are audible, and advances beat phase.
 *
 * An event detected at audio time T is heard at T plus output latency, so it is held until then.
 * That is what keeps a visual reaction within roughly one frame of the sound rather than ahead of it.
 */
function presentEvents(state: FeatureBusState, input: FeatureBusInput): FeatureBusState {
    const audible = input.currentAudioTime - input.latencySeconds;

    const due: RawOnset[] = [];
    const held: RawOnset[] = [];
    for (const onset of state.pendingOnsets) {
        if (onset.audioTime > audible) {
            held.push(onset);
        } else if (onset.audioTime >= state.transientGateUntilAudioTime) {
            due.push(onset);
        }
        // Detections older than the gate are dropped, not presented.
    }

    const onsetEvents = due.map((onset): TimedFeatureEvent => ({
        feature: 'onset',
        audioTime: onset.audioTime,
        playbackTime: onset.audioTime + state.audioToPlaybackOffset,
        strength: onset.strength,
    }));

    const { beatEvents, lastEmittedBeatAudioTime, beatPhase } = advanceBeat(state, input, audible);

    // One envelope over everything that just struck. Rises to the strongest onset released this
    // frame and falls over a fixed time, so it reads as a hit rather than as a level.
    const strongest = onsetEvents.reduce((highest, event) => Math.max(highest, event.strength), 0);
    const decayed = input.deltaSeconds > 0
        ? state.bus.continuous.transient * Math.exp(-input.deltaSeconds / TRANSIENT_RELEASE_SECONDS)
        : state.bus.continuous.transient;
    const transient = clamp01(Math.max(strongest, decayed));

    return {
        ...state,
        pendingOnsets: held,
        lastEmittedBeatAudioTime,
        bus: {
            ...state.bus,
            continuous: { ...state.bus.continuous, beatPhase, transient },
            events: {
                onset: onsetEvents,
                beat: beatEvents,
                // Section detection is not implemented; the channel exists for consumers.
                sectionChange: [],
            },
        },
    };
}

function advanceBeat(
    state: FeatureBusState,
    input: FeatureBusInput,
    audible: number,
): { beatEvents: TimedFeatureEvent[]; lastEmittedBeatAudioTime: number; beatPhase: number } {
    const { periodSeconds, confidence, anchorAudioTime } = state.beat;

    // No confident tempo, or a frozen clock, holds phase still rather than free-running.
    if (periodSeconds <= 0 || confidence <= 0 || input.deltaSeconds <= 0) {
        return {
            beatEvents: [],
            lastEmittedBeatAudioTime: state.lastEmittedBeatAudioTime,
            beatPhase: periodSeconds > 0 && confidence > 0 ? state.bus.continuous.beatPhase : 0,
        };
    }

    const elapsedBeats = (audible - anchorAudioTime) / periodSeconds;
    const beatIndex = Math.floor(elapsedBeats);
    const phase = elapsedBeats - beatIndex;
    const beatAudioTime = anchorAudioTime + beatIndex * periodSeconds;

    // Deduplicated by the beat's own position in time, not by its index.
    //
    // An index is only meaningful relative to an anchor, and the anchor moves — see `anchorFor`. A
    // monotone high-water mark over a renumbered index is unrecoverable in one direction: once the
    // mark was set high, every later re-anchor restarted the count below it and no beat ever fired
    // again. Half a period of separation is enough to reject the same grid position seen on
    // consecutive frames while accepting the next one.
    const alreadyEmitted = beatAudioTime <= state.lastEmittedBeatAudioTime + periodSeconds * 0.5;

    if (alreadyEmitted || audible < state.transientGateUntilAudioTime) {
        return {
            beatEvents: [],
            lastEmittedBeatAudioTime: state.lastEmittedBeatAudioTime,
            beatPhase: phase,
        };
    }

    return {
        beatEvents: [{
            feature: 'beat',
            audioTime: beatAudioTime,
            playbackTime: beatAudioTime + state.audioToPlaybackOffset,
            strength: confidence,
        }],
        lastEmittedBeatAudioTime: beatAudioTime,
        beatPhase: phase,
    };
}

export function stereoBalance(leftLevel: number, rightLevel: number): number {
    const total = leftLevel + rightLevel;
    if (total <= 0) {
        return 0;
    }

    const balance = (rightLevel - leftLevel) / total;
    return balance < -1 ? -1 : balance > 1 ? 1 : balance;
}

/**
 * A bus carrying silence.
 *
 * The starting state of a real bus, and the base every caller that needs a bus with two or three
 * features set should build on. Exported so adding a feature does not mean editing every place one
 * was hand-built.
 */
export function silentFeatureBus(
    overrides: Partial<ContinuousFeatures> = {},
): AudioFeatureBus {
    return {
        continuous: { ...zeroContinuous(), ...overrides },
        events: { onset: [], beat: [], sectionChange: [] },
        waveform: EMPTY_SPECTRUM,
        spectrum: EMPTY_SPECTRUM,
    };
}

function zeroContinuous(): ContinuousFeatures {
    return {
        rms: 0,
        peak: 0,
        subBass: 0,
        bass: 0,
        lowMid: 0,
        mid: 0,
        highMid: 0,
        treble: 0,
        rmsExcite: 0,
        subBassExcite: 0,
        bassExcite: 0,
        lowMidExcite: 0,
        midExcite: 0,
        highMidExcite: 0,
        trebleExcite: 0,
        spectralCentroid: 0,
        spectralFlux: 0,
        transient: 0,
        beatConfidence: 0,
        beatPhase: 0,
        leftLevel: 0,
        rightLevel: 0,
        stereoBalance: 0,
    };
}
