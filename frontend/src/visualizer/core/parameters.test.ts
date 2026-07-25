import { describe, expect, test } from 'vitest';
import {
    mergeUniforms,
    parameterUniformName,
    parameterUniforms,
    readFeature,
    resolveParameters,
} from './parameters';
import { silentFeatureBus, type AudioFeatureBus } from './features';
import { bindingMode, type ParameterBinding } from './bindings';
import { allDefinitions } from '../plugins/registry';

function features(overrides: Partial<AudioFeatureBus['continuous']> = {}): AudioFeatureBus {
    return silentFeatureBus(overrides);
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
        // Every continuous channel at full scale, derived rather than listed so a newly added feature
        // is covered without this test needing to know about it.
        const loud: AudioFeatureBus = {
            ...features(
                Object.fromEntries(
                    Object.keys(silent.continuous).map((name) => [name, 1]),
                ) as Partial<AudioFeatureBus['continuous']>,
            ),
            // Impulse bindings read the event channels, so a purely continuous frame could never
            // exercise them and a plugin bound only to onsets would pass by standing still.
            events: {
                onset: [{ feature: 'onset', playbackTime: 1, audioTime: 1, strength: 0.9 }],
                beat: [{ feature: 'beat', playbackTime: 1, audioTime: 1, strength: 0.9 }],
                sectionChange: [],
            },
        };

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
        const continuous = new Set(Object.keys(features().continuous));
        const events = new Set(Object.keys(features().events));

        for (const definition of allDefinitions()) {
            for (const binding of definition.defaultBindings ?? []) {
                // An impulse fires from an event channel; every other mode reads the continuous bus.
                // Checking the wrong one is how a binding ends up reading a name nothing ever sets.
                const carried = bindingMode(binding) === 'impulse' ? events : continuous;

                expect(carried, `${definition.id} binds ${binding.feature}`).toContain(binding.feature);
            }
        }
    });
});

describe('binding modes reach parameters', () => {
    const rateBinding = binding({
        feature: 'mid',
        parameter: 'spin',
        mode: 'rate',
        outputRange: [0, 2],
    });

    const impulseBinding = binding({
        feature: 'onset',
        parameter: 'burst',
        mode: 'impulse',
        outputRange: [0, 1],
        release: 0.2,
    });

    const withOnset = (strength: number): AudioFeatureBus => ({
        ...features(),
        events: {
            onset: [{ feature: 'onset', playbackTime: 1, audioTime: 1, strength }],
            beat: [],
            sectionChange: [],
        },
    });

    test('a rate binding integrates across frames', () => {
        let values: Record<string, number> = { spin: 0 };
        for (let frame = 0; frame < 60; frame += 1) {
            values = resolveParameters(values, [rateBinding], features({ mid: 1 }), 1 / 60);
        }

        expect(values.spin).toBeCloseTo(2, 2);
    });

    test('an impulse binding reads the event channel rather than the continuous bus', () => {
        // `onset` is not a continuous feature. Dispatching on mode is what keeps it from being
        // skipped as an unknown name and leaving the parameter at its default forever.
        const fired = resolveParameters({ burst: 0 }, [impulseBinding], withOnset(0.8), 1 / 60);

        expect(fired.burst).toBeCloseTo(0.8, 6);
    });

    test('an impulse decays once the event has passed', () => {
        let values = resolveParameters({ burst: 0 }, [impulseBinding], withOnset(1), 1 / 60);
        for (let frame = 0; frame < 60; frame += 1) {
            values = resolveParameters(values, [impulseBinding], features(), 1 / 60);
        }

        expect(values.burst).toBeLessThan(0.05);
    });

    test('both modes hold under a frozen clock', () => {
        const held = { spin: 1.5, burst: 0.6 };
        const frozen = resolveParameters(held, [rateBinding, impulseBinding], withOnset(1), 0);

        expect(frozen).toEqual(held);
    });

    test('a rate parameter reaches the shader under its own uniform name', () => {
        const resolved = resolveParameters({ spin: 0 }, [rateBinding], features({ mid: 1 }), 1);

        expect(mergeUniforms({}, resolved).uSpin).toBeCloseTo(2, 6);
    });
});
