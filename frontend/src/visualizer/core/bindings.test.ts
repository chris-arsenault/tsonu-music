import { describe, expect, test } from 'vitest';
import {
    advanceBinding,
    advanceImpulse,
    applyCurve,
    bindingMode,
    bindingTarget,
    clamp01,
    integrateBinding,
    normalize,
    type BindingCurve,
    type ParameterBinding,
} from './bindings';

const ALL_CURVES: BindingCurve[] = ['linear', 'smooth', 'square', 'sqrt', 'exponential'];

function binding(overrides: Partial<ParameterBinding> = {}): ParameterBinding {
    return {
        feature: 'bass',
        parameter: 'zoom',
        outputRange: [0, 1],
        attack: 0,
        release: 0,
        curve: 'linear',
        ...overrides,
    };
}

describe('parameter bindings', () => {
    test('normalize maps into unit range and clamps outside it', () => {
        expect(normalize(5, 0, 10)).toBe(0.5);
        expect(normalize(-1, 0, 10)).toBe(0);
        expect(normalize(11, 0, 10)).toBe(1);
        expect(normalize(5, 10, 10)).toBe(0);
        expect(normalize(Number.NaN, 0, 1)).toBe(0);
    });

    test('clamp01 rejects non-finite input', () => {
        expect(clamp01(Number.NaN)).toBe(0);
        expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
        expect(clamp01(-3)).toBe(0);
        expect(clamp01(3)).toBe(1);
    });

    test('every curve is anchored at both ends and monotonic between', () => {
        for (const curve of ALL_CURVES) {
            expect(applyCurve(curve, 0)).toBeCloseTo(0, 10);
            expect(applyCurve(curve, 1)).toBeCloseTo(1, 10);

            let previous = -1;
            for (let step = 0; step <= 20; step += 1) {
                const value = applyCurve(curve, step / 20);
                expect(value).toBeGreaterThanOrEqual(previous);
                previous = value;
            }
        }
    });

    test('curves bend in the expected direction at mid-input', () => {
        expect(applyCurve('linear', 0.5)).toBeCloseTo(0.5, 10);
        expect(applyCurve('smooth', 0.5)).toBeCloseTo(0.5, 10);
        expect(applyCurve('square', 0.5)).toBeLessThan(0.5);
        expect(applyCurve('exponential', 0.5)).toBeLessThan(0.5);
        expect(applyCurve('sqrt', 0.5)).toBeGreaterThan(0.5);
    });

    test('output range is applied after the curve', () => {
        const scaled = binding({ outputRange: [10, 20] });
        expect(bindingTarget(scaled, 0)).toBe(10);
        expect(bindingTarget(scaled, 1)).toBe(20);
        expect(bindingTarget(scaled, 0.5)).toBe(15);
    });

    test('an inverted output range moves the parameter downward', () => {
        const inverted = binding({ outputRange: [1, 0] });
        expect(bindingTarget(inverted, 0)).toBe(1);
        expect(bindingTarget(inverted, 1)).toBe(0);
    });

    test('input range rescales before the curve', () => {
        const ranged = binding({ inputRange: [0.2, 0.8] });
        expect(bindingTarget(ranged, 0.2)).toBe(0);
        expect(bindingTarget(ranged, 0.8)).toBe(1);
        expect(bindingTarget(ranged, 0.5)).toBeCloseTo(0.5, 10);
        expect(bindingTarget(ranged, 0.1)).toBe(0);
    });

    test('negative polarity inverts the response', () => {
        const inverse = binding({ polarity: -1 });
        expect(bindingTarget(inverse, 0)).toBe(1);
        expect(bindingTarget(inverse, 1)).toBe(0);
    });

    test('zero time constants follow the target immediately', () => {
        expect(advanceBinding(binding(), 0, 1, 1 / 60)).toBe(1);
    });

    test('attack governs rising and release governs falling', () => {
        const smoothed = binding({ attack: 0.5, release: 0.05 });

        const rising = advanceBinding(smoothed, 0, 1, 1 / 60);
        const falling = advanceBinding(smoothed, 1, 0, 1 / 60);

        // Slow attack moves a little; fast release moves a lot.
        expect(rising).toBeGreaterThan(0);
        expect(rising).toBeLessThan(0.1);
        expect(falling).toBeLessThan(0.75);
    });

    test('smoothing converges on the target over time', () => {
        const smoothed = binding({ attack: 0.1, release: 0.1 });

        let value = 0;
        for (let frame = 0; frame < 120; frame += 1) {
            value = advanceBinding(smoothed, value, 1, 1 / 60);
        }

        expect(value).toBeCloseTo(1, 3);
    });

    test('a frozen frame holds the previous value', () => {
        const smoothed = binding({ attack: 0.1, release: 0.1 });
        expect(advanceBinding(smoothed, 0.42, 1, 0)).toBe(0.42);
        expect(advanceBinding(smoothed, 0.42, 1, -1)).toBe(0.42);
    });

    test('approach is framerate independent', () => {
        const smoothed = binding({ attack: 0.2, release: 0.2 });

        let atSixty = 0;
        for (let frame = 0; frame < 60; frame += 1) {
            atSixty = advanceBinding(smoothed, atSixty, 1, 1 / 60);
        }

        let atThirty = 0;
        for (let frame = 0; frame < 30; frame += 1) {
            atThirty = advanceBinding(smoothed, atThirty, 1, 1 / 30);
        }

        expect(atSixty).toBeCloseTo(atThirty, 2);
    });

    test('an uninitialized parameter snaps to its target', () => {
        const smoothed = binding({ attack: 10, release: 10 });
        expect(advanceBinding(smoothed, Number.NaN, 0.5, 1 / 60)).toBe(0.5);
    });
});

/**
 * Rate and impulse exist because a value binding can only scale a displacement.
 *
 * Nothing in the original contract let audio change how fast something moves or fire a shaped
 * envelope from a detected event, which is why the catalog could look busy and still read as still.
 */
describe('binding modes', () => {
    const rate = (overrides: Partial<ParameterBinding> = {}): ParameterBinding => ({
        feature: 'mid',
        parameter: 'spin',
        mode: 'rate',
        outputRange: [0, 2],
        attack: 0,
        release: 0,
        curve: 'linear',
        ...overrides,
    });

    const impulse = (overrides: Partial<ParameterBinding> = {}): ParameterBinding => ({
        feature: 'onset',
        parameter: 'amount',
        mode: 'impulse',
        outputRange: [0.2, 1],
        attack: 0,
        release: 0.25,
        curve: 'linear',
        ...overrides,
    });

    test('value is the default, so bindings written before modes existed are unchanged', () => {
        expect(bindingMode({ ...rate(), mode: undefined })).toBe('value');
    });

    test('a rate binding accumulates rather than tracking', () => {
        let value = 0;
        for (let frame = 0; frame < 60; frame += 1) {
            value = integrateBinding(rate(), value, 0.5, 1 / 60);
        }

        // Half scale of a 0..2 range is 1 unit per second, held for one second.
        expect(value).toBeCloseTo(1, 3);
    });

    test('a louder feature integrates faster, which a value binding cannot express', () => {
        let slow = 0;
        let fast = 0;
        for (let frame = 0; frame < 60; frame += 1) {
            slow = integrateBinding(rate(), slow, 0.25, 1 / 60);
            fast = integrateBinding(rate(), fast, 1, 1 / 60);
        }

        expect(fast).toBeGreaterThan(slow * 3);
    });

    test('a frozen clock holds an integrated value exactly', () => {
        const held = integrateBinding(rate(), 1.234, 1, 0);
        expect(held).toBe(1.234);
    });

    test('wrapping keeps an angle bounded without losing continuity', () => {
        const wrapped = integrateBinding(rate({ wrap: Math.PI * 2 }), Math.PI * 2 - 0.01, 1, 0.5);

        expect(wrapped).toBeGreaterThanOrEqual(0);
        expect(wrapped).toBeLessThan(Math.PI * 2);
        expect(wrapped).toBeCloseTo(0.99, 6);
    });

    test('an unwrapped rate is left to accumulate', () => {
        expect(integrateBinding(rate(), 1000, 1, 1)).toBeCloseTo(1002, 6);
    });

    test('an impulse jumps to the event strength and decays back to the floor', () => {
        const fired = advanceImpulse(impulse(), 0.2, 0.75, 1 / 60);
        expect(fired).toBeCloseTo(0.8, 6);

        let value = fired;
        for (let frame = 0; frame < 120; frame += 1) {
            value = advanceImpulse(impulse(), value, undefined, 1 / 60);
        }

        expect(value).toBeCloseTo(0.2, 2);
    });

    test('a weaker event does not cut a louder one short', () => {
        const loud = advanceImpulse(impulse(), 0.2, 0.9, 1 / 60);
        const quieter = advanceImpulse(impulse(), loud, 0.1, 1 / 60);

        expect(quieter).toBe(loud);
    });

    test('an impulse with attack swells rather than snapping', () => {
        const swelling = advanceImpulse(impulse({ attack: 0.2 }), 0.2, 1, 1 / 60);

        expect(swelling).toBeGreaterThan(0.2);
        expect(swelling).toBeLessThan(0.5);
    });

    test('a frozen clock holds an impulse mid-decay', () => {
        expect(advanceImpulse(impulse(), 0.7, undefined, 0)).toBe(0.7);
    });

    test('an impulse starts from its floor rather than from nothing', () => {
        expect(advanceImpulse(impulse(), Number.NaN, undefined, 1 / 60)).toBeCloseTo(0.2, 6);
    });
});
