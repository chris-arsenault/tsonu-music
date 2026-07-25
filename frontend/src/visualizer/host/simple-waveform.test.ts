import { describe, expect, test } from 'vitest';
import { hasSignal } from './simple-waveform';

describe('waveform signal detection', () => {
    test('silence is detected as absent', () => {
        expect(hasSignal(new Float32Array(256))).toBe(false);
        expect(hasSignal(new Float32Array(0))).toBe(false);
    });

    test('a real signal is detected', () => {
        expect(hasSignal(Float32Array.from({ length: 64 }, (_, i) => Math.sin(i / 4)))).toBe(true);
    });

    test('detection is sign-independent', () => {
        expect(hasSignal(Float32Array.from([0, 0, -0.5, 0]))).toBe(true);
    });

    test('numerically negligible values count as silence', () => {
        // Otherwise floating-point dust would keep the tier drawing a flat line forever.
        expect(hasSignal(Float32Array.from([1e-9, -1e-9]))).toBe(false);
    });
});
