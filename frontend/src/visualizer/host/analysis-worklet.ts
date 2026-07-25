/**
 * Analysis processor, running on the audio render thread.
 *
 * Detection happens here rather than by polling an `AnalyserNode` on the main thread so onset
 * timestamps do not inherit render-loop jank. That matters most exactly when the visualizer is
 * heaviest, which is when a main-thread detector would drift worst.
 *
 * This file is loaded through `addModule`, so it must stay self-contained apart from the pure core
 * modules Vite bundles into it. It must not allocate per render quantum.
 */

import {
    createBeatTracker,
    createOnsetDetector,
    detectOnset,
    observeOnset,
    peak,
    rms,
    resetOnsetDetector,
    SPECTRAL_BANDS,
    bandEnergy,
    spectralCentroid,
    spectralFlux,
    type BandName,
    type BeatTrackerState,
    type OnsetDetectorState,
} from '../core/analysis';
import { computeMagnitudeSpectrum, createSpectrumScratch, type SpectrumScratch } from '../core/fft';
import type { FeatureSnapshot, RawOnset } from '../core/features';

const FFT_SIZE = 1024;
/** Samples between analysis frames. 512 at 48kHz is roughly 93 frames per second. */
const HOP_SIZE = 512;
/** Analysis frames per posted snapshot. Decimated because per-quantum messaging is not viable. */
const FRAMES_PER_POST = 2;
/** Bins and samples included in a posted snapshot. Small enough to keep message churn low. */
const POSTED_SPECTRUM_BINS = 64;
const POSTED_WAVEFORM_SAMPLES = 128;

/** Messages the main thread may send. */
export type AnalysisCommand = { kind: 'reset' };

class AnalysisProcessor extends AudioWorkletProcessor {
    private readonly scratch: SpectrumScratch = createSpectrumScratch(FFT_SIZE);
    private readonly ring = new Float32Array(FFT_SIZE);
    private readonly frame = new Float32Array(FFT_SIZE);
    private readonly previousMagnitude = new Float32Array(FFT_SIZE / 2);
    private readonly bands = createBandRecord();

    private writeIndex = 0;
    private samplesSinceFrame = 0;
    private framesSincePost = 0;
    private hasPreviousMagnitude = false;

    private onsetDetector: OnsetDetectorState = createOnsetDetector();
    private beatTracker: BeatTrackerState = createBeatTracker();
    private pendingOnsets: RawOnset[] = [];

    private leftLevel = 0;
    private rightLevel = 0;

    constructor() {
        super();
        this.port.onmessage = (event: MessageEvent<AnalysisCommand>) => {
            if (event.data?.kind === 'reset') {
                this.reset();
            }
        };
    }

    process(inputs: Float32Array[][]): boolean {
        const input = inputs[0];
        if (!input || input.length === 0) {
            return true;
        }

        const left = input[0];
        const right = input.length > 1 ? input[1] : input[0];
        const quantum = left.length;

        // Per-channel level for stereo balance, measured on the raw quantum.
        this.leftLevel = rms(left);
        this.rightLevel = rms(right);

        for (let i = 0; i < quantum; i += 1) {
            this.ring[this.writeIndex] = (left[i] + right[i]) * 0.5;
            this.writeIndex = (this.writeIndex + 1) % FFT_SIZE;
        }

        this.samplesSinceFrame += quantum;
        if (this.samplesSinceFrame >= HOP_SIZE) {
            this.samplesSinceFrame = 0;
            this.analyseFrame();
        }

        return true;
    }

    private analyseFrame(): void {
        // Unwrap the ring into a contiguous frame, oldest sample first.
        for (let i = 0; i < FFT_SIZE; i += 1) {
            this.frame[i] = this.ring[(this.writeIndex + i) % FFT_SIZE];
        }

        computeMagnitudeSpectrum(this.scratch, this.frame);
        const magnitude = this.scratch.magnitude;

        const flux = this.hasPreviousMagnitude ? spectralFlux(magnitude, this.previousMagnitude) : 0;
        this.previousMagnitude.set(magnitude);
        this.hasPreviousMagnitude = true;

        const detected = detectOnset(this.onsetDetector, flux, currentTime);
        this.onsetDetector = detected.state;

        if (detected.onset) {
            this.pendingOnsets.push({ audioTime: currentTime, strength: detected.strength });
            this.beatTracker = observeOnset(this.beatTracker, currentTime);
        }

        for (const band of SPECTRAL_BANDS) {
            this.bands[band.name] = bandEnergy(magnitude, FFT_SIZE, sampleRate, band.lowHz, band.highHz);
        }

        this.framesSincePost += 1;
        if (this.framesSincePost >= FRAMES_PER_POST) {
            this.framesSincePost = 0;
            this.post(flux);
        }
    }

    private post(flux: number): void {
        const snapshot: FeatureSnapshot = {
            audioTime: currentTime,
            rms: rms(this.frame),
            peak: peak(this.frame),
            bands: { ...this.bands },
            spectralCentroidHz: spectralCentroid(this.scratch.magnitude, FFT_SIZE, sampleRate),
            spectralFlux: flux,
            leftLevel: this.leftLevel,
            rightLevel: this.rightLevel,
            beatPeriodSeconds: this.beatTracker.periodSeconds,
            beatConfidence: this.beatTracker.confidence,
            beatAnchorAudioTime: this.beatTracker.anchorTime,
            onsets: this.pendingOnsets,
            spectrum: decimate(this.scratch.magnitude, POSTED_SPECTRUM_BINS),
            waveform: decimate(this.frame, POSTED_WAVEFORM_SAMPLES),
        };

        this.pendingOnsets = [];
        this.port.postMessage(snapshot);
    }

    /** Drops short-term history. Applied on seek and track change. */
    private reset(): void {
        this.onsetDetector = resetOnsetDetector(this.onsetDetector);
        this.beatTracker = createBeatTracker();
        this.pendingOnsets = [];
        this.previousMagnitude.fill(0);
        this.hasPreviousMagnitude = false;
        this.ring.fill(0);
        this.writeIndex = 0;
        this.samplesSinceFrame = 0;
    }
}

/** Averages `source` down to `length` buckets. */
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

function createBandRecord(): Record<BandName, number> {
    const record = {} as Record<BandName, number>;
    for (const band of SPECTRAL_BANDS) {
        record[band.name] = 0;
    }
    return record;
}

registerProcessor('tsonu-analysis', AnalysisProcessor);
