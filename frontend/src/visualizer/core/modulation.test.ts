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

describe('modulation depth and exemptions', () => {
    const swept = (parameter: string, bindings: ParameterBinding[], value: number) => {
        let low = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;

        for (let time = 0; time < 120; time += 0.1) {
            const modulated = modulateParameters({ [parameter]: value }, bindings, time, 0.4, 0.9, 0.371);
            low = Math.min(low, modulated[parameter]);
            high = Math.max(high, modulated[parameter]);
        }

        return high - low;
    };

    test('motion sweeps a visible fraction of the range', () => {
        // At the original depth this swept under a tenth of the range, which on a typical binding was
        // below the threshold of visibility: the scene was described as breathing while holding still.
        const span = swept('amount', BINDINGS, 1.1);

        expect(span / (2 - 0.2)).toBeGreaterThan(0.15);
    });

    test('a rate parameter is left to integrate', () => {
        // Its value is an accumulating angle, not a position inside the output range. Clamping it
        // there would stop the integration dead.
        const rate: ParameterBinding[] = [{
            feature: 'mid',
            parameter: 'spin',
            mode: 'rate',
            outputRange: [0, 2],
            attack: 0,
            release: 0,
            curve: 'linear',
        }];

        expect(swept('spin', rate, 400)).toBe(0);
        expect(modulateParameters({ spin: 400 }, rate, 12, 0.4, 0.9, 0.371).spin).toBe(400);
    });

    test('an impulse envelope is left unsmeared', () => {
        const impulse: ParameterBinding[] = [{
            feature: 'onset',
            parameter: 'burst',
            mode: 'impulse',
            outputRange: [0, 1],
            attack: 0,
            release: 0.2,
            curve: 'linear',
        }];

        expect(swept('burst', impulse, 0.5)).toBe(0);
    });
});

describe('role shapes how far and how fast a parameter drifts', () => {
    const roled = (role: ParameterBinding['role']): ParameterBinding[] => ([{
        feature: 'bass',
        role,
        parameter: 'value',
        outputRange: [0, 1],
        attack: 0.1,
        release: 0.4,
        curve: 'linear',
    }]);

    /** Total sweep and how often the value crosses its midpoint, over two minutes of playback. */
    const profile = (role: ParameterBinding['role']) => {
        const bindings = roled(role);
        let low = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;
        let crossings = 0;
        let previous = 0.5;

        for (let time = 0; time < 120; time += 0.05) {
            const value = modulateParameters({ value: 0.5 }, bindings, time, 0, 0, 0.42).value;
            low = Math.min(low, value);
            high = Math.max(high, value);
            if ((value - 0.5) * (previous - 0.5) < 0) {
                crossings += 1;
            }
            previous = value;
        }

        return { sweep: high - low, crossings };
    };

    test('a large-scale role travels further than a detail role', () => {
        // One depth and one rate for everything meant a scene had a single amplitude and a single
        // tempo of change, which reads as uniformly small however the individual ranges are tuned.
        expect(profile('large-scale-force').sweep).toBeGreaterThan(profile('detail').sweep * 2);
    });

    test('a detail role moves more often than a large-scale role', () => {
        expect(profile('detail').crossings)
            .toBeGreaterThan(profile('large-scale-force').crossings * 3);
    });

    test('every role stays inside the binding range', () => {
        for (const role of ['large-scale-force', 'deformation', 'intensity', 'detail', 'burst'] as const) {
            const { sweep } = profile(role);

            expect(sweep, role).toBeGreaterThan(0);
            expect(sweep, role).toBeLessThanOrEqual(1);
        }
    });
});
