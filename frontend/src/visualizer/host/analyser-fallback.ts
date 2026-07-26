/**
 * Main-thread analysis, for when the audio render thread is unavailable.
 *
 * `AudioWorklet` is a secure-context API. Over plain HTTP on anything but localhost it is simply not
 * there, so `addModule` throws and analysis stops before it starts — the visualizer then renders
 * perfectly while every feature reads zero, which looks like the music doing nothing rather than like
 * a failure. That is the worst possible way for this to break.
 *
 * An `AnalyserNode` carries no such restriction. It is measurably worse — the detector inherits
 * render-loop jank, which is exactly what ADR-0001 chose the worklet to avoid — but a scene that
 * responds with imprecise timing is far better than one that does not respond at all.
 *
 * The framing mirrors the worklet's and calls the same pure functions from `core/analysis`, so the
 * two paths produce the same shape of snapshot from the same arithmetic.
 */

import {
    bandEnergy,
    createBeatTracker,
    createOnsetDetector,
    detectOnset,
    observeOnset,
    peak,
    resetOnsetDetector,
    rms,
    spectralCentroid,
    spectralFlux,
    SPECTRAL_BANDS,
    type BandName,
    type BeatTrackerState,
    type OnsetDetectorState,
} from '../core/analysis';
import { computeMagnitudeSpectrum, createSpectrumScratch } from '../core/fft';
import type { FeatureSnapshot, RawOnset } from '../core/features';

const FFT_SIZE = 1024;
const POSTED_SPECTRUM_BINS = 64;
const POSTED_WAVEFORM_SAMPLES = 128;

export interface AnalyserAnalysis {
    /** Computes a snapshot from the current analyser contents. Called once per frame by the loop. */
    pull(): FeatureSnapshot;
    reset(): void;
    connect(): void;
    disconnect(): void;
    dispose(): void;
}

export function createAnalyserAnalysis(
    context: AudioContext,
    source: AudioNode,
): AnalyserAnalysis {
    const mixed = context.createAnalyser();
    mixed.fftSize = FFT_SIZE;
    // The pure analysis does its own windowing and smoothing; the node should hand over raw frames.
    mixed.smoothingTimeConstant = 0;

    // Stereo balance needs the channels apart, which the mixed analyser cannot give.
    const splitter = context.createChannelSplitter(2);
    const left = context.createAnalyser();
    const right = context.createAnalyser();
    for (const analyser of [left, right]) {
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0;
    }

    const scratch = createSpectrumScratch(FFT_SIZE);
    const frame = new Float32Array(FFT_SIZE);
    const channel = new Float32Array(FFT_SIZE);
    const previousMagnitude = new Float32Array(FFT_SIZE / 2);
    const bands = {} as Record<BandName, number>;
    for (const band of SPECTRAL_BANDS) {
        bands[band.name] = 0;
    }

    let hasPreviousMagnitude = false;
    let onsetDetector: OnsetDetectorState = createOnsetDetector();
    let beatTracker: BeatTrackerState = createBeatTracker();
    let pendingOnsets: RawOnset[] = [];
    let connected = false;

    const channelLevel = (analyser: AnalyserNode): number => {
        analyser.getFloatTimeDomainData(channel);
        return rms(channel);
    };

    const connect = (): void => {
        if (connected) {
            return;
        }

        // A parallel branch that terminates here, exactly as the worklet's did: none of these nodes
        // is connected onward, so nothing on the analysis side can reach the output.
        source.connect(mixed);
        source.connect(splitter);
        splitter.connect(left, 0);
        splitter.connect(right, 1);
        connected = true;
    };

    connect();

    return {
        pull(): FeatureSnapshot {
            mixed.getFloatTimeDomainData(frame);
            computeMagnitudeSpectrum(scratch, frame);
            const magnitude = scratch.magnitude;

            const flux = hasPreviousMagnitude ? spectralFlux(magnitude, previousMagnitude) : 0;
            previousMagnitude.set(magnitude);
            hasPreviousMagnitude = true;

            const detected = detectOnset(onsetDetector, flux, context.currentTime);
            onsetDetector = detected.state;
            if (detected.onset) {
                pendingOnsets.push({ audioTime: context.currentTime, strength: detected.strength });
                beatTracker = observeOnset(beatTracker, context.currentTime);
            }

            for (const band of SPECTRAL_BANDS) {
                bands[band.name] = bandEnergy(
                    magnitude,
                    FFT_SIZE,
                    context.sampleRate,
                    band.lowHz,
                    band.highHz,
                );
            }

            const onsets = pendingOnsets;
            pendingOnsets = [];

            return {
                audioTime: context.currentTime,
                rms: rms(frame),
                peak: peak(frame),
                bands: { ...bands },
                spectralCentroidHz: spectralCentroid(magnitude, FFT_SIZE, context.sampleRate),
                spectralFlux: flux,
                leftLevel: channelLevel(left),
                rightLevel: channelLevel(right),
                beatPeriodSeconds: beatTracker.periodSeconds,
                beatConfidence: beatTracker.confidence,
                beatAnchorAudioTime: beatTracker.anchorTime,
                onsets,
                spectrum: decimate(magnitude, POSTED_SPECTRUM_BINS),
                waveform: decimate(frame, POSTED_WAVEFORM_SAMPLES),
            };
        },

        reset(): void {
            onsetDetector = resetOnsetDetector(onsetDetector);
            beatTracker = createBeatTracker();
            pendingOnsets = [];
            previousMagnitude.fill(0);
            hasPreviousMagnitude = false;
        },

        connect,

        disconnect(): void {
            if (!connected) {
                return;
            }

            source.disconnect(mixed);
            source.disconnect(splitter);
            connected = false;
        },

        dispose(): void {
            this.disconnect();
            splitter.disconnect();
        },
    };
}

/** Averages `source` down to `length` buckets. Mirrors the worklet's decimation. */
function decimate(source: Float32Array, length: number): Float32Array {
    const output = new Float32Array(length);
    const stride = source.length / length;

    for (let i = 0; i < length; i += 1) {
        const start = Math.floor(i * stride);
        const end = Math.min(source.length, Math.floor((i + 1) * stride));

        let sum = 0;
        for (let j = start; j < end; j += 1) {
            sum += source[j];
        }
        output[i] = end > start ? sum / (end - start) : 0;
    }

    return output;
}
