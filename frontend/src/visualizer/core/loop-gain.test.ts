import { describe, expect, test } from 'vitest';
import { divergentCycles, graphCycles, parameterCeiling, portGain } from './loop-gain';
import type { GraphNode, RenderGraphEdge } from './graph';
import type { PluginPort, VisualPluginDefinition } from './plugin';
import { allDefinitions } from '../plugins/registry';

function definition(overrides: Partial<VisualPluginDefinition> = {}): VisualPluginDefinition {
    return {
        id: 'test-plugin',
        version: 1,
        category: 'transformer',
        inputs: [],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
        capabilities: [],
        cost: { gpu: 1, cpu: 1, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.5,
            motionEnergy: 0.5,
            geometricOrder: 0.5,
            recognizability: 0.5,
            persistence: 0.5,
            brightness: 0.5,
            dominance: 'either',
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

const port = (overrides: Partial<PluginPort> = {}): PluginPort => ({
    name: 'source',
    type: 'color-texture',
    required: true,
    ...overrides,
});

/** A blend with a declared, bound gain on its base operand. */
const blend = definition({
    id: 'blend',
    category: 'compositor',
    inputs: [port({ gainParameter: 'sourceWeight' }), port({ name: 'overlay' })],
    parameters: { sourceWeight: 0.9 },
    defaultBindings: [{
        feature: 'lowMid',
        parameter: 'sourceWeight',
        outputRange: [0.5, 0.9],
        attack: 0.1,
        release: 0.5,
        curve: 'smooth',
    }],
});

/** A resampling warp: it moves material without diminishing it, so it declares no gain. */
const warp = definition({ id: 'warp', inputs: [port()] });

function nodes(...definitions: VisualPluginDefinition[]): GraphNode[] {
    return definitions.map((entry) => ({ instanceId: `${entry.id}#0`, definition: entry }));
}

describe('a parameter ceiling is what its bindings can reach', () => {
    test('a bound parameter reports the top of its output range, not its default', () => {
        expect(parameterCeiling(blend, 'sourceWeight')).toBe(0.9);
    });

    test('an unbound parameter reports its default', () => {
        const fixed = definition({ id: 'fixed', parameters: { sourceWeight: 0.4 } });
        expect(parameterCeiling(fixed, 'sourceWeight')).toBe(0.4);
    });

    test('a per-instance override is used when nothing binds the parameter', () => {
        const fixed = definition({ id: 'fixed', parameters: { sourceWeight: 0.4 } });
        expect(parameterCeiling(fixed, 'sourceWeight', { sourceWeight: 0.8 })).toBe(0.8);
    });

    test('an override does not lower a bound parameter, because the binding still drives it', () => {
        expect(parameterCeiling(blend, 'sourceWeight', { sourceWeight: 0.1 })).toBe(0.9);
    });
});

describe('a port with no declared gain passes its input through', () => {
    test('a warp reports unity, which is why a loop of warps alone never settles', () => {
        expect(portGain(warp, warp.inputs[0])).toBe(1);

        const cycles = graphCycles(nodes(warp), [{
            from: { instanceId: 'warp#0', port: 'color' },
            to: { instanceId: 'warp#0', port: 'source' },
            feedback: true,
        }]);

        expect(cycles).toHaveLength(1);
        expect(cycles[0].gain).toBe(1);
        expect(divergentCycles(nodes(warp), [{
            from: { instanceId: 'warp#0', port: 'color' },
            to: { instanceId: 'warp#0', port: 'source' },
            feedback: true,
        }])).toHaveLength(1);
    });
});

describe('cycle gain is the product around the loop', () => {
    const graph = nodes(warp, blend);
    const edges: RenderGraphEdge[] = [
        { from: { instanceId: 'warp#0', port: 'color' }, to: { instanceId: 'blend#0', port: 'source' } },
        {
            from: { instanceId: 'blend#0', port: 'color' },
            to: { instanceId: 'warp#0', port: 'source' },
            feedback: true,
        },
    ];

    test('a warp into a lossy blend converges at the blend\'s ceiling', () => {
        const cycles = graphCycles(graph, edges);

        expect(cycles).toHaveLength(1);
        expect(cycles[0].gain).toBeCloseTo(0.9, 10);
        expect(divergentCycles(graph, edges)).toHaveLength(0);
    });

    test('two lossy stages multiply', () => {
        const second = { ...blend, id: 'blend2' };
        const chain = nodes(warp, blend, second);
        const chained: RenderGraphEdge[] = [
            { from: { instanceId: 'warp#0', port: 'color' }, to: { instanceId: 'blend#0', port: 'source' } },
            { from: { instanceId: 'blend#0', port: 'color' }, to: { instanceId: 'blend2#0', port: 'source' } },
            {
                from: { instanceId: 'blend2#0', port: 'color' },
                to: { instanceId: 'warp#0', port: 'source' },
                feedback: true,
            },
        ];

        expect(graphCycles(chain, chained)[0].gain).toBeCloseTo(0.81, 10);
    });

    test('the ceiling is checked, not the resting value', () => {
        // Resting at 0.6, driven to 1.04 on a peak. Stable at rest and divergent on the music, which
        // is the failure mode a default-value check would pass.
        const peaky = definition({
            id: 'peaky',
            category: 'compositor',
            inputs: [port({ gainParameter: 'sourceWeight' })],
            parameters: { sourceWeight: 0.6 },
            defaultBindings: [{
                feature: 'bass',
                parameter: 'sourceWeight',
                outputRange: [0.6, 1.04],
                attack: 0.1,
                release: 0.5,
                curve: 'smooth',
            }],
        });

        const loop: RenderGraphEdge[] = [{
            from: { instanceId: 'peaky#0', port: 'color' },
            to: { instanceId: 'peaky#0', port: 'source' },
            feedback: true,
        }];

        expect(divergentCycles(nodes(peaky), loop)).toHaveLength(1);
    });

    test('a cycle is reported once rather than once per rotation', () => {
        const a = definition({ id: 'a', inputs: [port({ gainParameter: 'w' })], parameters: { w: 0.5 } });
        const b = definition({ id: 'b', inputs: [port({ gainParameter: 'w' })], parameters: { w: 0.5 } });
        const ring: RenderGraphEdge[] = [
            { from: { instanceId: 'a#0', port: 'color' }, to: { instanceId: 'b#0', port: 'source' } },
            {
                from: { instanceId: 'b#0', port: 'color' },
                to: { instanceId: 'a#0', port: 'source' },
                feedback: true,
            },
        ];

        expect(graphCycles(nodes(a, b), ring)).toHaveLength(1);
    });

    test('an acyclic graph has no cycles', () => {
        expect(graphCycles(nodes(warp, blend), [
            { from: { instanceId: 'warp#0', port: 'color' }, to: { instanceId: 'blend#0', port: 'source' } },
        ])).toHaveLength(0);
    });
});

describe('the catalog can close a converging loop', () => {
    // The contract ADR-0013 puts in place of `attenuatesHistory`. Something in the catalog has to be
    // able to be the lossy element, or every loop a scene draws is divergent and the check rejects
    // every scene rather than the wrong ones.
    test('at least one plugin declares a gain parameter below one', () => {
        const lossy = allDefinitions().filter((entry) =>
            entry.inputs.some((input) =>
                input.gainParameter !== undefined
                && portGain(entry, input) < 1));

        expect(lossy.length).toBeGreaterThan(0);
    });

    test('no plugin declares a gain parameter it does not have', () => {
        for (const entry of allDefinitions()) {
            for (const input of entry.inputs) {
                if (input.gainParameter === undefined) {
                    continue;
                }

                expect(
                    entry.parameters?.[input.gainParameter],
                    `${entry.id}.${input.name} names ${input.gainParameter}`,
                ).toBeDefined();
            }
        }
    });
});
