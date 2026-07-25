import { describe, expect, test } from 'vitest';
import {
    bandEnergy,
    beatPhaseAt,
    createBeatTracker,
    createOnsetDetector,
    createPeakFollower,
    detectOnset,
    followPeak,
    invalidateTempo,
    observeOnset,
    peak,
    resetOnsetDetector,
    rms,
    SPECTRAL_BANDS,
    spectralCentroid,
    spectralFlux,
} from './analysis';
import { computeMagnitudeSpectrum, createSpectrumScratch } from './fft';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 1024;

function tone(frequencyHz: number, amplitude = 1): Float32Array {
    const samples = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
        samples[i] = amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE);
    }
    return samples;
}

function spectrumOf(samples: Float32Array): Float32Array {
    const scratch = createSpectrumScratch(FFT_SIZE);
    computeMagnitudeSpectrum(scratch, samples);
    return Float32Array.from(scratch.magnitude);
}

/** Feeds flat filler flux until the detector's window is primed. */
function primeDetector(background: number, time = 0) {
    let state = createOnsetDetector();
    let at = time;
    for (let i = 0; i < 60; i += 1) {
        state = detectOnset(state, background, at).state;
        at += 0.01;
    }
    return { state, time: at };
}

describe('level measures', () => {
    test('rms of silence is zero and of full-scale DC is one', () => {
        expect(rms(new Float32Array(128))).toBe(0);
        expect(rms(new Float32Array(128).fill(1))).toBeCloseTo(1, 10);
    });

    test('rms of a full-scale sine is about 0.707', () => {
        expect(rms(tone(1000))).toBeCloseTo(Math.SQRT1_2, 2);
    });

    test('peak reports the largest excursion regardless of sign', () => {
        expect(peak(new Float32Array([0.1, -0.9, 0.3]))).toBeCloseTo(0.9, 6);
        expect(peak(new Float32Array(0))).toBe(0);
    });

    test('rms of an empty buffer is zero rather than NaN', () => {
        expect(rms(new Float32Array(0))).toBe(0);
    });
});

describe('spectral measures', () => {
    test('a bass tone lands in the bass band, not the treble band', () => {
        const spectrum = spectrumOf(tone(100));

        const bass = bandEnergy(spectrum, FFT_SIZE, SAMPLE_RATE, 60, 250);
        const treble = bandEnergy(spectrum, FFT_SIZE, SAMPLE_RATE, 4000, 16000);

        expect(bass).toBeGreaterThan(treble * 10);
    });

    test('a treble tone lands in the treble band', () => {
        const spectrum = spectrumOf(tone(8000));

        const bass = bandEnergy(spectrum, FFT_SIZE, SAMPLE_RATE, 60, 250);
        const treble = bandEnergy(spectrum, FFT_SIZE, SAMPLE_RATE, 4000, 16000);

        expect(treble).toBeGreaterThan(bass * 10);
    });

    test('band ranges are contiguous and ascending', () => {
        for (let i = 1; i < SPECTRAL_BANDS.length; i += 1) {
            expect(SPECTRAL_BANDS[i].lowHz).toBe(SPECTRAL_BANDS[i - 1].highHz);
            expect(SPECTRAL_BANDS[i].highHz).toBeGreaterThan(SPECTRAL_BANDS[i].lowHz);
        }
    });

    test('an inverted or out-of-range band yields zero rather than reading past the spectrum', () => {
        const spectrum = spectrumOf(tone(1000));
        expect(bandEnergy(spectrum, FFT_SIZE, SAMPLE_RATE, 500, 100)).toBe(0);
        expect(bandEnergy(spectrum, FFT_SIZE, SAMPLE_RATE, 100000, 200000)).toBeGreaterThanOrEqual(0);
    });

    test('centroid rises with brightness', () => {
        const low = spectralCentroid(spectrumOf(tone(200)), FFT_SIZE, SAMPLE_RATE);
        const high = spectralCentroid(spectrumOf(tone(6000)), FFT_SIZE, SAMPLE_RATE);

        expect(low).toBeGreaterThan(0);
        expect(high).toBeGreaterThan(low * 5);
    });

    test('centroid of silence is zero rather than NaN', () => {
        expect(spectralCentroid(new Float32Array(512), FFT_SIZE, SAMPLE_RATE)).toBe(0);
    });

    test('flux is zero for an unchanging spectrum', () => {
        const spectrum = spectrumOf(tone(1000));
        expect(spectralFlux(spectrum, spectrum)).toBe(0);
    });

    test('flux is positive when energy appears and zero when it only decays', () => {
        const quiet = spectrumOf(tone(1000, 0.1));
        const loud = spectrumOf(tone(1000, 1));

        expect(spectralFlux(loud, quiet)).toBeGreaterThan(0);
        // Positive rectification: a fall in energy is not an onset.
        expect(spectralFlux(quiet, loud)).toBe(0);
    });
});

describe('peak follower', () => {
    test('rises instantly so the loudest moment reads as full scale', () => {
        const { normalized } = followPeak(createPeakFollower(), 0.5, 1 / 60);
        expect(normalized).toBeCloseTo(1, 6);
    });

    test('a quieter value after a loud one reads proportionally lower', () => {
        const loud = followPeak(createPeakFollower(), 1, 1 / 60);
        const quiet = followPeak(loud.follower, 0.25, 1 / 60);

        expect(quiet.normalized).toBeGreaterThan(0.2);
        expect(quiet.normalized).toBeLessThan(0.4);
    });

    test('the ceiling decays so a quiet passage regains contrast', () => {
        let follower = followPeak(createPeakFollower(), 1, 1 / 60).follower;

        let normalized = 0;
        for (let second = 0; second < 20; second += 1) {
            const result = followPeak(follower, 0.1, 1);
            follower = result.follower;
            normalized = result.normalized;
        }

        expect(normalized).toBeCloseTo(1, 1);
    });

    test('silence normalizes to zero without dividing by zero', () => {
        const { normalized } = followPeak(createPeakFollower(), 0, 1 / 60);
        expect(normalized).toBe(0);
    });
});

describe('onset detection', () => {
    test('reports nothing until its window has filled', () => {
        let state = createOnsetDetector();
        let detected = false;

        for (let i = 0; i < 20; i += 1) {
            const result = detectOnset(state, 10, i * 0.01);
            state = result.state;
            detected = detected || result.onset;
        }

        expect(detected).toBe(false);
    });

    test('fires on a spike above the local mean', () => {
        const primed = primeDetector(0.01);
        const result = detectOnset(primed.state, 1, primed.time);

        expect(result.onset).toBe(true);
        expect(result.strength).toBeGreaterThan(0);
    });

    test('does not fire on steady flux', () => {
        const primed = primeDetector(0.01);
        const result = detectOnset(primed.state, 0.01, primed.time);

        expect(result.onset).toBe(false);
    });

    test('one transient does not fire twice inside the minimum gap', () => {
        const primed = primeDetector(0.01);
        const first = detectOnset(primed.state, 1, primed.time);
        expect(first.onset).toBe(true);

        const immediate = detectOnset(first.state, 1, primed.time + 0.01);
        expect(immediate.onset).toBe(false);

        const later = detectOnset(immediate.state, 1, primed.time + 0.2);
        expect(later.onset).toBe(true);
    });

    test('a louder spike reports greater strength, without saturating', () => {
        const primed = primeDetector(0.01);

        const soft = detectOnset(primed.state, 0.05, primed.time);
        const hard = detectOnset(primed.state, 1, primed.time);
        const hardest = detectOnset(primed.state, 20, primed.time);

        expect(soft.strength).toBeGreaterThan(0);
        expect(hard.strength).toBeGreaterThan(soft.strength);
        expect(hardest.strength).toBeGreaterThan(hard.strength);
        expect(hardest.strength).toBeLessThanOrEqual(1);
    });

    test('reset discards history and the gate', () => {
        const primed = primeDetector(0.01);
        const fired = detectOnset(primed.state, 1, primed.time);
        const reset = resetOnsetDetector(fired.state);

        expect(reset.filled).toBe(0);
        expect(reset.lastOnsetTime).toBe(Number.NEGATIVE_INFINITY);
        // A fresh detector cannot fire until it has re-primed from newly heard audio.
        expect(detectOnset(reset, 1, primed.time + 0.001).onset).toBe(false);
    });
});

describe('beat tracking', () => {
    /** Onsets on a steady grid, as a metronome at the given period would produce. */
    function steadyOnsets(periodSeconds: number, count: number, start = 10) {
        let state = createBeatTracker();
        for (let beat = 0; beat < count; beat += 1) {
            state = observeOnset(state, start + beat * periodSeconds);
        }
        return state;
    }

    test('holds no tempo before enough onsets are heard', () => {
        const state = observeOnset(observeOnset(createBeatTracker(), 1), 1.5);

        expect(state.confidence).toBe(0);
        expect(beatPhaseAt(state, 2)).toBe(0);
    });

    test('recovers a steady period at 120 BPM', () => {
        const state = steadyOnsets(0.5, 12);

        expect(state.periodSeconds).toBeCloseTo(0.5, 2);
        expect(state.confidence).toBeGreaterThan(0.8);
    });

    test('recovers a different steady period', () => {
        const state = steadyOnsets(0.75, 12);
        expect(state.periodSeconds).toBeCloseTo(0.75, 2);
        expect(state.confidence).toBeGreaterThan(0.8);
    });

    test('reports low confidence for irregular onsets', () => {
        let state = createBeatTracker();
        const irregular = [10, 10.31, 10.94, 11.12, 11.83, 12.02, 12.77];
        for (const time of irregular) {
            state = observeOnset(state, time);
        }

        expect(state.confidence).toBeLessThan(0.8);
    });

    test('phase is zero on the beat and mid-way between beats', () => {
        const state = steadyOnsets(0.5, 12);
        const lastOnset = state.anchorTime;

        expect(beatPhaseAt(state, lastOnset)).toBeCloseTo(0, 6);
        expect(beatPhaseAt(state, lastOnset + 0.25)).toBeCloseTo(0.5, 6);
        expect(beatPhaseAt(state, lastOnset + 0.5)).toBeCloseTo(0, 6);
    });

    test('phase advances monotonically within a beat and wraps at the next', () => {
        const state = steadyOnsets(0.5, 12);
        const anchor = state.anchorTime;

        let previous = -1;
        for (let step = 0; step < 10; step += 1) {
            const phase = beatPhaseAt(state, anchor + step * 0.049);
            expect(phase).toBeGreaterThan(previous);
            previous = phase;
        }

        expect(beatPhaseAt(state, anchor + 0.51)).toBeLessThan(previous);
    });

    test('phase stays still when no tempo is held, rather than free-running', () => {
        const empty = createBeatTracker();
        expect(beatPhaseAt(empty, 5)).toBe(0);
        expect(beatPhaseAt(empty, 500)).toBe(0);
    });

    test('phase works for times before the anchor', () => {
        const state = steadyOnsets(0.5, 12);
        const phase = beatPhaseAt(state, state.anchorTime - 0.25);

        expect(phase).toBeGreaterThanOrEqual(0);
        expect(phase).toBeLessThan(1);
        expect(phase).toBeCloseTo(0.5, 6);
    });

    test('invalidating tempo returns to holding nothing', () => {
        const state = steadyOnsets(0.5, 12);
        expect(state.confidence).toBeGreaterThan(0);

        const cleared = invalidateTempo();
        expect(cleared.confidence).toBe(0);
        expect(cleared.periodSeconds).toBe(0);
        expect(cleared.onsetTimes).toEqual([]);
        expect(beatPhaseAt(cleared, 100)).toBe(0);
    });

    test('onset memory stays bounded', () => {
        const state = steadyOnsets(0.5, 500);
        expect(state.onsetTimes.length).toBeLessThanOrEqual(24);
    });

    test('re-locks onto a new tempo after the old one is invalidated', () => {
        const slow = steadyOnsets(0.8, 12);
        expect(slow.periodSeconds).toBeCloseTo(0.8, 2);

        let relocked = invalidateTempo();
        for (let beat = 0; beat < 12; beat += 1) {
            relocked = observeOnset(relocked, 400 + beat * 0.4);
        }

        expect(relocked.periodSeconds).toBeCloseTo(0.4, 2);
        expect(relocked.confidence).toBeGreaterThan(0.8);
    });
});
