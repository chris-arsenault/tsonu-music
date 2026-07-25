import { describe, expect, test } from 'vitest';
import {
    binFrequency,
    computeMagnitudeSpectrum,
    createSpectrumScratch,
    hannWindow,
    isPowerOfTwo,
} from './fft';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 1024;

function sineWave(frequencyHz: number, length: number, amplitude = 1): Float32Array {
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
        samples[i] = amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE);
    }
    return samples;
}

function peakBin(magnitude: Float32Array): number {
    let best = 0;
    for (let bin = 1; bin < magnitude.length; bin += 1) {
        if (magnitude[bin] > magnitude[best]) {
            best = bin;
        }
    }
    return best;
}

describe('fft', () => {
    test('recognizes power-of-two sizes', () => {
        expect(isPowerOfTwo(1024)).toBe(true);
        expect(isPowerOfTwo(1)).toBe(true);
        expect(isPowerOfTwo(1000)).toBe(false);
        expect(isPowerOfTwo(0)).toBe(false);
        expect(isPowerOfTwo(-8)).toBe(false);
    });

    test('rejects a non-power-of-two scratch size', () => {
        expect(() => createSpectrumScratch(1000)).toThrow(/power of two/);
    });

    test('hann window is zero at the edges and one at the centre', () => {
        const window = hannWindow(64);
        expect(window[0]).toBeCloseTo(0, 6);
        expect(window[63]).toBeCloseTo(0, 6);
        expect(window[32]).toBeCloseTo(1, 2);
    });

    test('locates a pure tone in the expected bin', () => {
        const scratch = createSpectrumScratch(FFT_SIZE);
        const toneHz = 1000;
        computeMagnitudeSpectrum(scratch, sineWave(toneHz, FFT_SIZE));

        const expectedBin = Math.round((toneHz * FFT_SIZE) / SAMPLE_RATE);
        expect(peakBin(scratch.magnitude)).toBeCloseTo(expectedBin, 0);
    });

    test('a higher tone lands in a higher bin', () => {
        const scratch = createSpectrumScratch(FFT_SIZE);

        computeMagnitudeSpectrum(scratch, sineWave(500, FFT_SIZE));
        const lowBin = peakBin(scratch.magnitude);

        computeMagnitudeSpectrum(scratch, sineWave(4000, FFT_SIZE));
        const highBin = peakBin(scratch.magnitude);

        expect(highBin).toBeGreaterThan(lowBin);
    });

    test('a louder tone produces a larger magnitude', () => {
        const scratch = createSpectrumScratch(FFT_SIZE);

        computeMagnitudeSpectrum(scratch, sineWave(1000, FFT_SIZE, 0.25));
        const quiet = Math.max(...scratch.magnitude);

        computeMagnitudeSpectrum(scratch, sineWave(1000, FFT_SIZE, 1));
        const loud = Math.max(...scratch.magnitude);

        expect(loud).toBeGreaterThan(quiet * 3);
    });

    test('silence produces an empty spectrum', () => {
        const scratch = createSpectrumScratch(256);
        computeMagnitudeSpectrum(scratch, new Float32Array(256));

        expect(Math.max(...scratch.magnitude)).toBe(0);
    });

    test('short input is zero-padded rather than reading past its end', () => {
        const scratch = createSpectrumScratch(256);
        computeMagnitudeSpectrum(scratch, sineWave(1000, 64));

        expect(Number.isFinite(Math.max(...scratch.magnitude))).toBe(true);
    });

    test('reusing scratch does not carry the previous frame', () => {
        const scratch = createSpectrumScratch(256);
        computeMagnitudeSpectrum(scratch, sineWave(1000, 256));
        expect(Math.max(...scratch.magnitude)).toBeGreaterThan(0);

        computeMagnitudeSpectrum(scratch, new Float32Array(256));
        expect(Math.max(...scratch.magnitude)).toBe(0);
    });

    test('bin frequency maps bin zero to DC and scales linearly', () => {
        expect(binFrequency(0, FFT_SIZE, SAMPLE_RATE)).toBe(0);
        expect(binFrequency(FFT_SIZE / 2, FFT_SIZE, SAMPLE_RATE)).toBe(SAMPLE_RATE / 2);
    });
});
