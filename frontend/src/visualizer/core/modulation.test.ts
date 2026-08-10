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
        const first = modulateParameters(resolved, BINDINGS, 10, 0.2, 0.314);
        const later = modulateParameters(resolved, BINDINGS, 12.5, 0.7, 0.314);

        expect(later.amount).not.toBeCloseTo(first.amount, 6);
        expect(later.hue).not.toBeCloseTo(first.hue, 6);
    });

    test('the wander never repeats itself at any lag', () => {
        // The motion used to be two sines of fixed ratio, so the parameter retraced the same figure
        // once per cycle — for an unchanged graph, seconds one and five looked alike because they
        // were alike, one lap apart. Whatever the lag, the trajectory must differ somewhere: an
        // oscillator fails this at its own period, a wandering one does not.
        const trajectory = (offset: number): number[] => {
            const samples: number[] = [];
            for (let time = 0; time < 30; time += 0.25) {
                samples.push(modulateParameters({ hue: 0.5 }, BINDINGS, offset + time, 0, 0.371).hue);
            }
            return samples;
        };

        const base = trajectory(0);
        for (let lag = 5; lag <= 120; lag += 5) {
            const shifted = trajectory(lag);
            const divergence = Math.max(...base.map((value, index) => Math.abs(value - shifted[index])));
            expect(divergence, `lag ${lag}s`).toBeGreaterThan(0.02);
        }
    });

    test('the same playback instant holds every modulation during pause', () => {
        const resolved = { amount: 1, hue: 0.5 };
        const first = modulateParameters(resolved, BINDINGS, 42, 0.3, 0.712);
        const frozen = modulateParameters(resolved, BINDINGS, 42, 0.3, 0.712);

        expect(frozen).toEqual(first);
    });

    test('motion remains inside each binding range', () => {
        const resolved = { amount: 0.2, hue: 1 };

        for (let time = 0; time < 60; time += 0.25) {
            const values = modulateParameters(resolved, BINDINGS, time, 0.8, 0.913);
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
            const modulated = modulateParameters({ [parameter]: value }, bindings, time, 0.4, 0.371);
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

    test('the audio-resolved value keeps its authority over the parameter', () => {
        // The drift used to take its depth from the whole output range, add that to the resolved
        // value, and clamp. The oscillator alone therefore covered the range end to end, and audio
        // was reduced to a small offset on top of it — a parameter that looked alive while being
        // driven by a clock. Measured then: moving the resolved value by 0.6 of the range moved the
        // mean output by 0.464, with the rest eaten by the clamp.
        const sample = (value: number) => {
            let total = 0;
            let count = 0;

            for (let time = 0; time < 240; time += 0.1) {
                total += modulateParameters({ hue: value }, BINDINGS, time, 0.4, 0.371).hue;
                count += 1;
            }

            return total / count;
        };

        expect(sample(0.8) - sample(0.2)).toBeGreaterThan(0.55);
    });

    test('drift alone never reaches a limit the audio did not', () => {
        // Sitting on a rail is the parameter's response to the music saturating, and it should mean
        // that. Previously the drift railed on its own for eighteen percent of every cycle.
        for (let time = 0; time < 240; time += 0.05) {
            const { hue } = modulateParameters({ hue: 0.5 }, BINDINGS, time, 0.4, 0.371);

            expect(hue).toBeGreaterThan(0);
            expect(hue).toBeLessThan(1);
        }
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
        expect(modulateParameters({ spin: 400 }, rate, 12, 0.4, 0.371).spin).toBe(400);
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

describe('the envelope shapes how far and how fast a parameter drifts', () => {
    // A slow follower is a structural parameter whatever it is called; a fast one is detail. The
    // drift dynamics derive from attack + release, so the per-scene expression draw carries
    // through: the same parameter drawn as glide arcs widely, drawn as punch it ripples.
    const enveloped = (attack: number, release: number): ParameterBinding[] => ([{
        feature: 'bass',
        parameter: 'value',
        outputRange: [0, 1],
        attack,
        release,
        curve: 'linear',
    }]);
    const slow = () => enveloped(0.6, 2);
    const fast = () => enveloped(0.01, 0.14);

    /** Total sweep and how often the value crosses its midpoint, over two minutes of playback. */
    const profile = (bindings: ParameterBinding[]) => {
        let low = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;
        let crossings = 0;
        let previous = 0.5;

        for (let time = 0; time < 120; time += 0.05) {
            const value = modulateParameters({ value: 0.5 }, bindings, time, 0, 0.42).value;
            low = Math.min(low, value);
            high = Math.max(high, value);
            if ((value - 0.5) * (previous - 0.5) < 0) {
                crossings += 1;
            }
            previous = value;
        }

        return { sweep: high - low, crossings };
    };

    test('a slow follower travels further than a fast one', () => {
        // One depth and one rate for everything meant a scene had a single amplitude and a single
        // tempo of change, which reads as uniformly small however the individual ranges are tuned.
        expect(profile(slow()).sweep).toBeGreaterThan(profile(fast()).sweep * 2);
    });

    test('a fast follower moves more often than a slow one', () => {
        expect(profile(fast()).crossings)
            .toBeGreaterThan(profile(slow()).crossings * 3);
    });

    test('every envelope stays inside the binding range', () => {
        for (const bindings of [slow(), fast(), enveloped(0.1, 0.4), enveloped(4, 8), enveloped(0, 0.05)]) {
            const { sweep } = profile(bindings);

            expect(sweep).toBeGreaterThan(0);
            expect(sweep).toBeLessThanOrEqual(1);
        }
    });
});
