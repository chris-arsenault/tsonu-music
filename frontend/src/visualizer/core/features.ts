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
    createPeakFollower,
    followPeak,
    type BandName,
    type PeakFollower,
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

export interface ContinuousFeatures {
    rms: number;
    peak: number;

    subBass: number;
    bass: number;
    lowMid: number;
    mid: number;
    highMid: number;
    treble: number;

    spectralCentroid: number;
    spectralFlux: number;

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
 */
export type FollowerName = 'rms' | 'peak' | 'flux' | 'bands';

export interface FeatureBusState {
    bus: AudioFeatureBus;
    followers: Record<FollowerName, PeakFollower>;
    pendingOnsets: readonly RawOnset[];
    /** Events detected before this audio time are discarded rather than presented. */
    transientGateUntilAudioTime: number;
    beat: { periodSeconds: number; confidence: number; anchorAudioTime: number };
    /** audioTime + offset = playbackTime. Re-observed while playing. */
    audioToPlaybackOffset: number;
    /** Index of the last beat whose event was emitted, so each beat fires once. */
    lastEmittedBeatIndex: number;
}

/**
 * How long after resuming to keep discarding detections. Long enough to cover a queued transient
 * from before the freeze, short enough that the first real hit after resume still lands.
 */
export const TRANSIENT_GATE_SECONDS = 0.12;

/** Highest centroid used for normalization. Above this, brightness is already saturated. */
const CENTROID_CEILING_HZ = 8000;

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
        pendingOnsets: [],
        transientGateUntilAudioTime: 0,
        beat: { periodSeconds: 0, confidence: 0, anchorAudioTime: 0 },
        audioToPlaybackOffset: 0,
        lastEmittedBeatIndex: -1,
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
            lastEmittedBeatIndex: -1,
            bus: {
                ...next.bus,
                continuous: { ...next.bus.continuous, beatConfidence: 0, beatPhase: 0 },
            },
        };
    }

    if (input.effects.includes('clear-analysis-history')) {
        next = { ...next, audioToPlaybackOffset: 0 };
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
    let loudestBand = 0;
    for (const band of SPECTRAL_BANDS) {
        const energy = snapshot.bands[band.name];
        if (energy > loudestBand) {
            loudestBand = energy;
        }
    }
    normalizeWith('bands', loudestBand);
    const bandCeiling = followers.bands.peak;
    const scaleBand = (value: number): number => clamp01(bandCeiling > 0 ? value / bandCeiling : 0);

    const continuous: ContinuousFeatures = {
        ...state.bus.continuous,
        rms: normalizeWith('rms', snapshot.rms),
        peak: normalizeWith('peak', snapshot.peak),
        subBass: scaleBand(snapshot.bands.subBass),
        bass: scaleBand(snapshot.bands.bass),
        lowMid: scaleBand(snapshot.bands.lowMid),
        mid: scaleBand(snapshot.bands.mid),
        highMid: scaleBand(snapshot.bands.highMid),
        treble: scaleBand(snapshot.bands.treble),
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

    const { beatEvents, lastEmittedBeatIndex, beatPhase } = advanceBeat(state, input, audible);

    return {
        ...state,
        pendingOnsets: held,
        lastEmittedBeatIndex,
        bus: {
            ...state.bus,
            continuous: { ...state.bus.continuous, beatPhase },
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
): { beatEvents: TimedFeatureEvent[]; lastEmittedBeatIndex: number; beatPhase: number } {
    const { periodSeconds, confidence, anchorAudioTime } = state.beat;

    // No confident tempo, or a frozen clock, holds phase still rather than free-running.
    if (periodSeconds <= 0 || confidence <= 0 || input.deltaSeconds <= 0) {
        return {
            beatEvents: [],
            lastEmittedBeatIndex: state.lastEmittedBeatIndex,
            beatPhase: periodSeconds > 0 && confidence > 0 ? state.bus.continuous.beatPhase : 0,
        };
    }

    const elapsedBeats = (audible - anchorAudioTime) / periodSeconds;
    const beatIndex = Math.floor(elapsedBeats);
    const phase = elapsedBeats - beatIndex;

    if (beatIndex <= state.lastEmittedBeatIndex || audible < state.transientGateUntilAudioTime) {
        return { beatEvents: [], lastEmittedBeatIndex: Math.max(state.lastEmittedBeatIndex, beatIndex), beatPhase: phase };
    }

    const beatAudioTime = anchorAudioTime + beatIndex * periodSeconds;

    return {
        beatEvents: [{
            feature: 'beat',
            audioTime: beatAudioTime,
            playbackTime: beatAudioTime + state.audioToPlaybackOffset,
            strength: confidence,
        }],
        lastEmittedBeatIndex: beatIndex,
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
        spectralCentroid: 0,
        spectralFlux: 0,
        beatConfidence: 0,
        beatPhase: 0,
        leftLevel: 0,
        rightLevel: 0,
        stereoBalance: 0,
    };
}
