import { describe, expect, test } from 'vitest';
import { instanceIdFor, wireScene } from './wiring';
import { compileGraph } from './graph';
import { distributeReactivity, peakConcentration, reactivitySpread } from './audio-mapping';
import { createRng } from './random';
import type { PluginCategory, PluginPort, VisualPluginDefinition } from './plugin';

function plugin(
    id: string,
    category: PluginCategory,
    inputs: PluginPort[] = [],
    outputs: PluginPort[] = [{ name: 'color', type: 'color-texture', required: false }],
    overrides: Partial<VisualPluginDefinition> = {},
): VisualPluginDefinition {
    return {
        id,
        version: 1,
        category,
        inputs,
        outputs,
        capabilities: [],
        cost: { gpu: 1, cpu: 1, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.5, motionEnergy: 0.5, geometricOrder: 0.5,
            recognizability: 0.5, persistence: 0.5, brightness: 0.5, dominance: 'either',
        },
        activationRules: { activationWeight: 1 },
        create: () => ({
            initialize: () => undefined,
            activate: () => undefined,
            update: () => undefined,
            render: () => [],
            deactivate: () => undefined,
            destroy: () => undefined,
        }),
        ...overrides,
    };
}

const colorIn: PluginPort = { name: 'source', type: 'color-texture', required: true };
const historyIn: PluginPort = { name: 'history', type: 'color-texture', required: false };

const source = plugin('src', 'source');
const transform = plugin('trn', 'transformer', [colorIn]);
const feedback = plugin('fbk', 'transformer', [colorIn, historyIn], undefined, {
    capabilities: ['feedback'],
});
const post = plugin('post', 'postprocess', [colorIn]);

describe('scene wiring', () => {
    test('chains source into transformer into postprocess', () => {
        const wired = wireScene([post, transform, source]);

        expect(wired.nodes.map((node) => node.definition.id)).toEqual(['src', 'trn', 'post']);
        expect(wired.unsatisfied).toEqual([]);
        expect(wired.edges).toHaveLength(2);
    });

    test('the wired scene compiles', () => {
        const wired = wireScene([source, transform, post]);
        const result = compileGraph(wired.nodes, wired.edges, wired.present);

        expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    });

    test('chains transformers rather than running them in parallel', () => {
        const second = plugin('trn2', 'transformer', [colorIn]);
        const wired = wireScene([source, transform, second]);

        const intoSecond = wired.edges.find((edge) => edge.to.instanceId.startsWith('trn2'));
        // Takes the freshest colour output, which is the first transformer, not the source.
        expect(intoSecond?.from.instanceId).toBe(instanceIdFor(transform, 1));
    });

    test('presents the last colour output in the chain', () => {
        const wired = wireScene([source, transform, post]);

        expect(wired.present?.instanceId).toBe(instanceIdFor(post, 2));
    });

    test('a plugin never consumes its own forward output', () => {
        const wired = wireScene([transform]);

        // Nothing upstream, so its required input is unsatisfied rather than self-connected.
        expect(wired.edges.filter((edge) => !edge.feedback)).toEqual([]);
        expect(wired.unsatisfied).toHaveLength(1);
    });

    test('reports unsatisfied required inputs instead of producing a broken graph', () => {
        const needsField = plugin('needy', 'simulator', [
            { name: 'flow', type: 'vector-field', required: true },
        ]);
        const wired = wireScene([source, needsField]);

        expect(wired.unsatisfied).toEqual([
            { instanceId: instanceIdFor(needsField, 1), port: 'flow', type: 'vector-field' },
        ]);
    });

    test('an optional unconnected input is not reported', () => {
        const optional = plugin('opt', 'transformer', [
            { name: 'mask', type: 'mask-texture', required: false },
        ]);
        const wired = wireScene([source, optional]);

        expect(wired.unsatisfied).toEqual([]);
    });

    test('a distance field satisfies a mask input', () => {
        const field = plugin('sdf', 'field', [], [{ name: 'sdf', type: 'distance-field', required: false }]);
        const masked = plugin('mask-user', 'transformer', [
            { name: 'mask', type: 'mask-texture', required: true },
        ]);
        const wired = wireScene([field, masked]);

        expect(wired.unsatisfied).toEqual([]);
        expect(wired.edges).toHaveLength(1);
    });

    test('an empty scene wires to nothing rather than failing', () => {
        const wired = wireScene([]);

        expect(wired.nodes).toEqual([]);
        expect(wired.edges).toEqual([]);
        expect(wired.present).toBeUndefined();
    });

    test('instance ids are unique even for repeated plugin ids', () => {
        const wired = wireScene([source, plugin('src', 'source')]);
        const ids = wired.nodes.map((node) => node.instanceId);

        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('feedback wiring', () => {
    test('a feedback transformer reads its own previous frame', () => {
        const wired = wireScene([source, feedback, post]);
        const loops = wired.edges.filter((edge) => edge.feedback);

        expect(loops).toHaveLength(1);
        expect(loops[0].from.instanceId).toBe(loops[0].to.instanceId);
        expect(loops[0].to.port).toBe('history');
    });

    test('the feedback scene compiles as a declared cycle', () => {
        const wired = wireScene([source, feedback, post]);
        const result = compileGraph(wired.nodes, wired.edges, wired.present);

        expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
        if (!result.ok) return;
        expect(result.graph.pingPong).toHaveLength(1);
    });

    test('its forward input still comes from upstream', () => {
        const wired = wireScene([source, feedback]);
        const forward = wired.edges.filter((edge) => !edge.feedback);

        expect(forward).toHaveLength(1);
        expect(forward[0].from.instanceId).toBe(instanceIdFor(source, 0));
        expect(forward[0].to.port).toBe('source');
    });

    test('the history port is not wired forward from an upstream producer', () => {
        const wired = wireScene([source, plugin('other', 'source'), feedback]);
        const intoHistory = wired.edges.filter((edge) => edge.to.port === 'history');

        expect(intoHistory).toHaveLength(1);
        expect(intoHistory[0].feedback).toBe(true);
    });

    test('a transformer without the feedback capability gets no loop', () => {
        const wired = wireScene([source, transform, post]);

        expect(wired.edges.filter((edge) => edge.feedback)).toEqual([]);
    });
});

describe('reactivity distribution', () => {
    const binding = {
        feature: 'rms',
        parameter: 'amount',
        outputRange: [0, 1] as [number, number],
        attack: 0.1,
        release: 0.2,
        curve: 'linear' as const,
    };

    const withBindings = (id: string, category: PluginCategory) =>
        plugin(id, category, [], undefined, {
            parameters: { amount: 0 },
            defaultBindings: [binding],
        });

    test('spreads reactivity instead of binding everything to one feature', () => {
        const plugins = [
            withBindings('a', 'source'),
            withBindings('b', 'field'),
            withBindings('c', 'transformer'),
            withBindings('d', 'postprocess'),
        ];

        const distributed = distributeReactivity(plugins, createRng('spread'));

        // Four plugins that all defaulted to rms must not all still be on rms.
        expect(peakConcentration(distributed)).toBeLessThan(plugins.length);
        expect(reactivitySpread(distributed).size).toBeGreaterThan(1);
    });

    test('assignments come from the category affinity table', () => {
        const distributed = distributeReactivity([withBindings('f', 'field')], createRng('affinity'));

        expect(['bass', 'subBass', 'stereoBalance', 'spectralFlux'])
            .toContain(distributed[0].bindings[0].feature);
    });

    test('is deterministic for a seed', () => {
        const plugins = [withBindings('a', 'source'), withBindings('b', 'field')];

        expect(distributeReactivity(plugins, createRng('same')))
            .toEqual(distributeReactivity(plugins, createRng('same')));
    });

    test('preserves everything about a binding except its feature', () => {
        const distributed = distributeReactivity([withBindings('a', 'source')], createRng('preserve'));
        const rewritten = distributed[0].bindings[0];

        expect(rewritten.parameter).toBe('amount');
        expect(rewritten.attack).toBe(0.1);
        expect(rewritten.release).toBe(0.2);
        expect(rewritten.curve).toBe('linear');
        expect(rewritten.outputRange).toEqual([0, 1]);
    });

    test('a plugin with no bindings gets none', () => {
        const distributed = distributeReactivity([plugin('bare', 'source')], createRng('bare'));

        expect(distributed[0].bindings).toEqual([]);
    });

    test('more plugins than features still avoids total concentration', () => {
        const many = Array.from({ length: 12 }, (_, index) => withBindings(`p${index}`, 'transformer'));
        const distributed = distributeReactivity(many, createRng('crowded'));

        expect(peakConcentration(distributed)).toBeLessThan(many.length);
    });

    test('an empty scene distributes nothing', () => {
        expect(distributeReactivity([], createRng('empty'))).toEqual([]);
        expect(peakConcentration([])).toBe(0);
    });
});
