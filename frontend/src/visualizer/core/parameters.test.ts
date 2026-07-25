import { describe, expect, test } from 'vitest';
import {
    mergeUniforms,
    parameterUniformName,
    parameterUniforms,
    readFeature,
    resolveParameters,
} from './parameters';
import type { AudioFeatureBus } from './features';
import type { ParameterBinding } from './bindings';
import { allDefinitions } from '../plugins/registry';

function features(overrides: Partial<AudioFeatureBus['continuous']> = {}): AudioFeatureBus {
    return {
        continuous: {
            rms: 0, peak: 0, subBass: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
            spectralCentroid: 0, spectralFlux: 0, beatConfidence: 0, beatPhase: 0,
            leftLevel: 0, rightLevel: 0, stereoBalance: 0,
            ...overrides,
        },
        events: { onset: [], beat: [], sectionChange: [] },
        waveform: new Float32Array(0),
        spectrum: new Float32Array(0),
    };
}

const binding = (overrides: Partial<ParameterBinding> = {}): ParameterBinding => ({
    feature: 'bass',
    parameter: 'strength',
    outputRange: [0, 1],
    attack: 0,
    release: 0,
    curve: 'linear',
    ...overrides,
});

describe('parameter to uniform naming', () => {
    test('prefixes and capitalizes', () => {
        expect(parameterUniformName('strength')).toBe('uStrength');
        expect(parameterUniformName('blackLevel')).toBe('uBlackLevel');
        expect(parameterUniformName('a')).toBe('uA');
    });

    test('leaves an already-prefixed name alone', () => {
        expect(parameterUniformName('uStrength')).toBe('uStrength');
    });

    test('an empty name is returned unchanged rather than becoming "u"', () => {
        expect(parameterUniformName('')).toBe('');
    });

    test('maps a whole parameter set', () => {
        expect(parameterUniforms({ strength: 0.5, decay: 0.9 }))
            .toEqual({ uStrength: 0.5, uDecay: 0.9 });
    });

    test('drops non-finite values rather than sending them to GL', () => {
        expect(parameterUniforms({ good: 1, bad: Number.NaN, worse: Number.POSITIVE_INFINITY }))
            .toEqual({ uGood: 1 });
    });
});

describe('uniform merging', () => {
    test('a live parameter overrides the pass default', () => {
        // The defect this exists to prevent: static defaults winning, so nothing reacts.
        expect(mergeUniforms({ uStrength: 0.02 }, { strength: 0.9 })).toEqual({ uStrength: 0.9 });
    });

    test('static uniforms with no matching parameter survive', () => {
        expect(mergeUniforms({ uMode: 3 }, { strength: 0.5 }))
            .toEqual({ uMode: 3, uStrength: 0.5 });
    });

    test('no parameters leaves the pass uniforms untouched', () => {
        expect(mergeUniforms({ uMode: 3 }, {})).toEqual({ uMode: 3 });
    });

    test('no pass uniforms yields the parameters alone', () => {
        expect(mergeUniforms(undefined, { strength: 0.5 })).toEqual({ uStrength: 0.5 });
    });
});

describe('feature reading', () => {
    test('reads a named continuous feature', () => {
        expect(readFeature(features({ bass: 0.75 }), 'bass')).toBe(0.75);
    });

    test('an unknown feature name reads as undefined rather than zero', () => {
        // Distinguishing "not carried" from "carried and zero" is what lets a binding be skipped
        // instead of silently driving the parameter to its floor.
        expect(readFeature(features(), 'nonexistent')).toBeUndefined();
        expect(readFeature(features({ bass: 0 }), 'bass')).toBe(0);
    });
});

describe('resolving parameters from features', () => {
    test('a bound parameter follows its feature', () => {
        const quiet = resolveParameters({ strength: 0 }, [binding()], features({ bass: 0 }), 1 / 60);
        const loud = resolveParameters({ strength: 0 }, [binding()], features({ bass: 1 }), 1 / 60);

        expect(quiet.strength).toBe(0);
        expect(loud.strength).toBe(1);
    });

    test('the output range is honoured', () => {
        const ranged = binding({ outputRange: [0.2, 0.8] });

        expect(resolveParameters({ strength: 0 }, [ranged], features({ bass: 1 }), 1 / 60).strength)
            .toBeCloseTo(0.8, 6);
    });

    test('an unbound parameter is passed through untouched', () => {
        const resolved = resolveParameters(
            { strength: 0, mode: 3 },
            [binding()],
            features({ bass: 1 }),
            1 / 60,
        );

        expect(resolved.mode).toBe(3);
    });

    test('a binding naming an unknown feature leaves its parameter alone', () => {
        const resolved = resolveParameters(
            { strength: 0.42 },
            [binding({ feature: 'nonexistent' })],
            features({ bass: 1 }),
            1 / 60,
        );

        expect(resolved.strength).toBe(0.42);
    });

    test('a frozen frame holds every bound value', () => {
        const resolved = resolveParameters({ strength: 0.3 }, [binding({ attack: 0.5 })], features({ bass: 1 }), 0);

        expect(resolved.strength).toBe(0.3);
    });

    test('smoothing converges over successive frames', () => {
        const smoothed = binding({ attack: 0.1, release: 0.1 });
        let parameters: Record<string, number> = { strength: 0 };

        for (let frame = 0; frame < 120; frame += 1) {
            parameters = resolveParameters(parameters, smoothed ? [smoothed] : [], features({ bass: 1 }), 1 / 60);
        }

        expect(parameters.strength).toBeCloseTo(1, 3);
    });

    test('several bindings on one plugin resolve independently', () => {
        const resolved = resolveParameters(
            { strength: 0, brightness: 0 },
            [binding(), binding({ feature: 'treble', parameter: 'brightness', outputRange: [1, 2] })],
            features({ bass: 1, treble: 1 }),
            1 / 60,
        );

        expect(resolved.strength).toBe(1);
        expect(resolved.brightness).toBe(2);
    });

    test('an empty binding list changes nothing', () => {
        expect(resolveParameters({ strength: 0.5 }, [], features({ bass: 1 }), 1 / 60))
            .toEqual({ strength: 0.5 });
    });
});

/**
 * The chain that was broken: a feature moves, the parameter follows, and the resulting uniform differs.
 * Asserted per plugin across the whole catalog, because the defect was catalog-wide and invisible to
 * every test that only checked one end of the chain.
 */
describe('every bound plugin reacts to its feature', () => {
    const bound = allDefinitions().filter((definition) => (definition.defaultBindings ?? []).length > 0);

    test('the catalog has bound plugins to check', () => {
        expect(bound.length).toBeGreaterThan(20);
    });

    test('a silent and a loud frame produce different uniforms', () => {
        const silent = features();
        const loud = features({
            rms: 1, peak: 1, subBass: 1, bass: 1, lowMid: 1, mid: 1, highMid: 1, treble: 1,
            spectralCentroid: 1, spectralFlux: 1, beatConfidence: 1, beatPhase: 1,
            leftLevel: 1, rightLevel: 1, stereoBalance: 1,
        });

        for (const definition of bound) {
            const defaults = definition.parameters ?? {};
            const bindings = definition.defaultBindings ?? [];

            const quiet = mergeUniforms(
                {},
                resolveParameters(defaults, bindings, silent, 1 / 60),
            );
            const noisy = mergeUniforms(
                {},
                resolveParameters(defaults, bindings, loud, 1 / 60),
            );

            expect(quiet, `${definition.id} responds to audio`).not.toEqual(noisy);
        }
    });

    test('every bound parameter is declared, so nothing binds into nothing', () => {
        for (const definition of bound) {
            for (const binding of definition.defaultBindings ?? []) {
                expect(definition.parameters?.[binding.parameter], `${definition.id}.${binding.parameter}`)
                    .toBeDefined();
            }
        }
    });

    test('every bound parameter names a feature the bus actually carries', () => {
        const carried = new Set(Object.keys(features().continuous));

        for (const definition of allDefinitions()) {
            for (const binding of definition.defaultBindings ?? []) {
                expect(carried, `${definition.id} binds ${binding.feature}`).toContain(binding.feature);
            }
        }
    });
});
