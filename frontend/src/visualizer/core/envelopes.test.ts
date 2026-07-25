import { describe, expect, test } from 'vitest';
import { envelope, wrapPhase, type EnvelopeShape } from './envelopes';

const ALL_SHAPES: EnvelopeShape[] = [
    'linear',
    'triangle',
    'sine',
    'sawtooth',
    'square',
    'exponential-decay',
];

describe('beat envelopes', () => {
    test('every shape stays within unit range across a full cycle', () => {
        for (const shape of ALL_SHAPES) {
            for (let step = 0; step <= 100; step += 1) {
                const value = envelope(shape, step / 100);
                expect(value).toBeGreaterThanOrEqual(0);
                expect(value).toBeLessThanOrEqual(1);
            }
        }
    });

    test('phase wraps so a tempo estimate drifting past one beat keeps working', () => {
        expect(wrapPhase(0)).toBe(0);
        expect(wrapPhase(0.25)).toBe(0.25);
        expect(wrapPhase(1)).toBe(0);
        expect(wrapPhase(1.25)).toBeCloseTo(0.25, 10);
        expect(wrapPhase(-0.25)).toBeCloseTo(0.75, 10);
        expect(wrapPhase(Number.NaN)).toBe(0);
    });

    test('every shape treats phase 1 as phase 0', () => {
        for (const shape of ALL_SHAPES) {
            expect(envelope(shape, 1)).toBeCloseTo(envelope(shape, 0), 10);
        }
    });

    test('linear ramps from zero to one', () => {
        expect(envelope('linear', 0)).toBe(0);
        expect(envelope('linear', 0.5)).toBe(0.5);
        expect(envelope('linear', 0.999)).toBeCloseTo(1, 2);
    });

    test('triangle peaks at mid-phase', () => {
        expect(envelope('triangle', 0)).toBe(0);
        expect(envelope('triangle', 0.5)).toBe(1);
        expect(envelope('triangle', 0.25)).toBeCloseTo(0.5, 10);
        expect(envelope('triangle', 0.75)).toBeCloseTo(0.5, 10);
    });

    test('sine peaks at mid-phase and is smooth at the beat', () => {
        expect(envelope('sine', 0)).toBeCloseTo(0, 10);
        expect(envelope('sine', 0.5)).toBeCloseTo(1, 10);
        expect(envelope('sine', 0.25)).toBeCloseTo(0.5, 10);
    });

    test('sawtooth snaps on the beat and falls away', () => {
        expect(envelope('sawtooth', 0)).toBe(1);
        expect(envelope('sawtooth', 0.5)).toBe(0.5);
    });

    test('square holds the first half of the beat', () => {
        expect(envelope('square', 0)).toBe(1);
        expect(envelope('square', 0.49)).toBe(1);
        expect(envelope('square', 0.5)).toBe(0);
    });

    test('exponential decay falls monotonically from one', () => {
        expect(envelope('exponential-decay', 0)).toBe(1);

        // Stops short of phase 1, which wraps back onto the next beat's attack.
        let previous = 1;
        for (let step = 1; step < 20; step += 1) {
            const value = envelope('exponential-decay', step / 20);
            expect(value).toBeLessThan(previous);
            previous = value;
        }
    });
});
