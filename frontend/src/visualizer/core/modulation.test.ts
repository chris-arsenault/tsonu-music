import { describe, expect, test } from 'vitest';
import type { ParameterBinding } from './bindings';
import { modulateParameters } from './modulation';

const BINDINGS: ParameterBinding[] = [
    {
        feature: 'bass',
        parameter: 'amount',
        outputRange: [0.2, 2],
        attack: 0.1,
        release: 0.4,
        curve: 'smooth',
    },
    {
        feature: 'treble',
        parameter: 'hue',
        outputRange: [0, 1],
        attack: 0.1,
        release: 0.4,
        curve: 'linear',
    },
];

describe('concurrent modulation', () => {
    test('several bound parameters move concurrently', () => {
        const resolved = { amount: 1, hue: 0.5 };
        const first = modulateParameters(resolved, BINDINGS, 10, 0.2, 0.8, 0.314);
        const later = modulateParameters(resolved, BINDINGS, 12.5, 0.7, 0.8, 0.314);

        expect(later.amount).not.toBeCloseTo(first.amount, 6);
        expect(later.hue).not.toBeCloseTo(first.hue, 6);
    });

    test('the same playback instant holds every modulation during pause', () => {
        const resolved = { amount: 1, hue: 0.5 };
        const first = modulateParameters(resolved, BINDINGS, 42, 0.3, 0.9, 0.712);
        const frozen = modulateParameters(resolved, BINDINGS, 42, 0.3, 0.9, 0.712);

        expect(frozen).toEqual(first);
    });

    test('motion remains inside each binding range', () => {
        const resolved = { amount: 0.2, hue: 1 };

        for (let time = 0; time < 60; time += 0.25) {
            const values = modulateParameters(resolved, BINDINGS, time, 0.8, 1, 0.913);
            expect(values.amount).toBeGreaterThanOrEqual(0.2);
            expect(values.amount).toBeLessThanOrEqual(2);
            expect(values.hue).toBeGreaterThanOrEqual(0);
            expect(values.hue).toBeLessThanOrEqual(1);
        }
    });
});
