import { describe, expect, test } from 'vitest';
import {
    compileGraph,
    portsCompatible,
    resourceIdFor,
    type GraphNode,
    type RenderGraphEdge,
} from './graph';
import { createPluginRegistry, validateDefinition, type PluginPort, type VisualPluginDefinition } from './plugin';

function definition(overrides: Partial<VisualPluginDefinition> = {}): VisualPluginDefinition {
    return {
        id: 'test-plugin',
        version: 1,
        category: 'source',
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

const colorIn = (required = true, multiple = false): PluginPort => ({
    name: 'source',
    type: 'color-texture',
    required,
    multiple,
});

const source = definition({ id: 'source', outputs: [{ name: 'color', type: 'color-texture', required: false }] });
const transform = definition({
    id: 'transform',
    category: 'transformer',
    inputs: [colorIn()],
    outputs: [{ name: 'color', type: 'color-texture', required: false }],
});
const output = definition({
    id: 'output',
    category: 'postprocess',
    inputs: [colorIn()],
    outputs: [{ name: 'color', type: 'color-texture', required: false }],
});

function node(instanceId: string, def: VisualPluginDefinition): GraphNode {
    return { instanceId, definition: def };
}

const chain: GraphNode[] = [node('a', source), node('b', transform), node('c', output)];
const chainEdges: RenderGraphEdge[] = [
    { from: { instanceId: 'a', port: 'color' }, to: { instanceId: 'b', port: 'source' } },
    { from: { instanceId: 'b', port: 'color' }, to: { instanceId: 'c', port: 'source' } },
];

describe('port compatibility', () => {
    test('identical types connect', () => {
        expect(portsCompatible('color-texture', 'color-texture')).toBe(true);
        expect(portsCompatible('vector-field', 'vector-field')).toBe(true);
    });

    test('unrelated types do not connect', () => {
        expect(portsCompatible('color-texture', 'vector-field')).toBe(false);
        expect(portsCompatible('palette', 'depth-texture')).toBe(false);
        expect(portsCompatible('particle-buffer', 'color-texture')).toBe(false);
    });

    test('a distance field satisfies a mask input but not the reverse', () => {
        expect(portsCompatible('distance-field', 'mask-texture')).toBe(true);
        expect(portsCompatible('mask-texture', 'distance-field')).toBe(false);
    });
});

describe('graph compilation', () => {
    test('orders a linear chain by dependency', () => {
        const result = compileGraph(chain, chainEdges);

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.graph.order.map((entry) => entry.instanceId)).toEqual(['a', 'b', 'c']);
    });

    test('order follows edges rather than declaration order', () => {
        const reversed = [node('c', output), node('b', transform), node('a', source)];
        const result = compileGraph(reversed, chainEdges);

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.graph.order.map((entry) => entry.instanceId)).toEqual(['a', 'b', 'c']);
    });

    test('assigns a resource per output port and wires inputs to them', () => {
        const result = compileGraph(chain, chainEdges);
        if (!result.ok) throw new Error('expected compilation to succeed');

        expect(result.graph.resources.map((resource) => resource.id)).toEqual([
            'a.color',
            'b.color',
            'c.color',
        ]);
        expect(result.graph.order[1].inputs).toEqual({ source: resourceIdFor('a', 'color') });
        expect(result.graph.order[1].outputs).toEqual({ color: 'b.color' });
    });

    test('presents the last colour output by default', () => {
        const result = compileGraph(chain, chainEdges);
        if (!result.ok) throw new Error('expected compilation to succeed');

        expect(result.graph.present).toBe('c.color');
    });

    test('presents an explicitly named output', () => {
        const result = compileGraph(chain, chainEdges, { instanceId: 'b', port: 'color' });
        if (!result.ok) throw new Error('expected compilation to succeed');

        expect(result.graph.present).toBe('b.color');
    });

    test('rejects an unknown present target', () => {
        const result = compileGraph(chain, chainEdges, { instanceId: 'b', port: 'missing' });

        expect(result.ok).toBe(false);
    });

    test('compiles a graph with no edges', () => {
        const result = compileGraph([node('a', source)], []);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.graph.order).toHaveLength(1);
        expect(result.graph.pingPong).toEqual([]);
    });

    test('compilation keeps a stable execution order for the active graph', () => {
        const first = compileGraph(chain, chainEdges);
        const second = compileGraph(chain, chainEdges);
        if (!first.ok || !second.ok) throw new Error('expected compilation to succeed');

        expect(first.graph.order.map((entry) => entry.instanceId))
            .toEqual(second.graph.order.map((entry) => entry.instanceId));
    });
});

describe('graph validation', () => {
    test('rejects a type mismatch', () => {
        const field = definition({ id: 'field', outputs: [{ name: 'flow', type: 'vector-field', required: false }] });
        const result = compileGraph(
            [node('f', field), node('b', transform)],
            [{ from: { instanceId: 'f', port: 'flow' }, to: { instanceId: 'b', port: 'source' } }],
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors[0]).toMatch(/cannot connect/);
    });

    test('rejects an unknown port on either end', () => {
        const missingOutput = compileGraph(chain, [
            { from: { instanceId: 'a', port: 'nope' }, to: { instanceId: 'b', port: 'source' } },
        ]);
        expect(missingOutput.ok).toBe(false);

        const missingInput = compileGraph(chain, [
            { from: { instanceId: 'a', port: 'color' }, to: { instanceId: 'b', port: 'nope' } },
        ]);
        expect(missingInput.ok).toBe(false);
    });

    test('rejects an edge referencing an unknown instance', () => {
        const result = compileGraph(chain, [
            { from: { instanceId: 'ghost', port: 'color' }, to: { instanceId: 'b', port: 'source' } },
        ]);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors[0]).toMatch(/unknown instance/);
    });

    test('rejects an unconnected required input', () => {
        const result = compileGraph([node('a', source), node('b', transform)], []);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.some((error) => /required but unconnected/.test(error))).toBe(true);
    });

    test('accepts an unconnected optional input', () => {
        const optional = definition({
            id: 'optional',
            category: 'transformer',
            inputs: [colorIn(false)],
        });
        const result = compileGraph([node('o', optional)], []);

        expect(result.ok).toBe(true);
    });

    test('rejects two connections into a single-connection port', () => {
        const result = compileGraph(
            [node('a', source), node('a2', source), node('b', transform)],
            [
                { from: { instanceId: 'a', port: 'color' }, to: { instanceId: 'b', port: 'source' } },
                { from: { instanceId: 'a2', port: 'color' }, to: { instanceId: 'b', port: 'source' } },
            ],
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.some((error) => /accepts one connection/.test(error))).toBe(true);
    });

    test('accepts many connections into a multiple port', () => {
        const mixer = definition({
            id: 'mixer',
            category: 'compositor',
            inputs: [colorIn(true, true)],
            outputs: [{ name: 'color', type: 'color-texture', required: false }],
        });
        const result = compileGraph(
            [node('a', source), node('a2', source), node('m', mixer)],
            [
                { from: { instanceId: 'a', port: 'color' }, to: { instanceId: 'm', port: 'source' } },
                { from: { instanceId: 'a2', port: 'color' }, to: { instanceId: 'm', port: 'source' } },
            ],
        );

        expect(result.ok).toBe(true);
    });

    test('rejects duplicate instance ids', () => {
        const result = compileGraph([node('a', source), node('a', source)], []);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors[0]).toMatch(/duplicate instance/);
    });
});

describe('retained outputs', () => {
    // ADR-0014. A producer's memory can be aged without being sampled, but not moved without one, so
    // an output whose producer displaces it asks for the second slot directly rather than through an
    // edge nobody would draw.
    const drifting = definition({
        id: 'drifting-source',
        category: 'source',
        inputs: [{ name: 'field', type: 'vector-field', required: false }],
        outputs: [{ name: 'color', type: 'color-texture', required: false, retained: true }],
    });

    const fieldSource = definition({
        id: 'field-source',
        outputs: [{ name: 'field', type: 'vector-field', required: false }],
    });

    function compiled(edges: RenderGraphEdge[] = []) {
        const result = compileGraph([node('f', fieldSource), node('p', drifting)], edges);
        if (!result.ok) throw new Error(result.errors.join(', '));
        return result.graph;
    }

    const wired: RenderGraphEdge[] = [
        { from: { instanceId: 'f', port: 'field' }, to: { instanceId: 'p', port: 'field' } },
    ];

    test('a wired producer gets a second slot for its own colour', () => {
        expect(compiled(wired).pingPong).toContain(resourceIdFor('p', 'color'));
    });

    test('the producer is handed its previous frame under the output port name', () => {
        const node = compiled(wired).order.find((entry) => entry.instanceId === 'p')!;

        expect(node.previous.color).toBe(resourceIdFor('p', 'color'));
    });

    test('a producer with nothing wired into it gets no slot', () => {
        // Displacement by a field nothing produced is the identity, so the buffer would be bought to
        // copy a texture to itself.
        expect(compiled().pingPong).toEqual([]);
        expect(compiled().order.find((entry) => entry.instanceId === 'p')!.previous).toEqual({});
    });

    test('an unretained output never gets one', () => {
        const plain = definition({ id: 'plain', inputs: [{ name: 'field', type: 'vector-field', required: false }] });
        const result = compileGraph([node('f', fieldSource), node('p', plain)], wired);

        expect(result.ok && result.graph.pingPong).toEqual([]);
    });

    test('a retained output may not share a name with an input', () => {
        const colliding = definition({
            inputs: [{ name: 'color', type: 'color-texture', required: false }],
            outputs: [{ name: 'color', type: 'color-texture', required: false, retained: true }],
        });

        expect(validateDefinition(colliding))
            .toContain('retained output color collides with an input of the same name');
    });
});

describe('feedback', () => {
    const feedbackConsumer = definition({
        id: 'feedback-consumer',
        category: 'transformer',
        inputs: [colorIn(), { name: 'history', type: 'color-texture', required: false }],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
    });

    test('rejects an undeclared two-node cycle', () => {
        // Each port takes exactly one connection, so nothing but the cycle itself is wrong here.
        const result = compileGraph(
            [node('p', transform), node('q', transform)],
            [
                { from: { instanceId: 'p', port: 'color' }, to: { instanceId: 'q', port: 'source' } },
                { from: { instanceId: 'q', port: 'color' }, to: { instanceId: 'p', port: 'source' } },
            ],
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.some((error) => /undeclared cycle/.test(error))).toBe(true);
    });

    test('rejects an undeclared self-cycle', () => {
        const result = compileGraph(
            [node('p', transform)],
            [{ from: { instanceId: 'p', port: 'color' }, to: { instanceId: 'p', port: 'source' } }],
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.some((error) => /undeclared cycle/.test(error))).toBe(true);
    });

    test('rejects a longer undeclared cycle', () => {
        const result = compileGraph(
            [node('p', transform), node('q', transform), node('r', transform)],
            [
                { from: { instanceId: 'p', port: 'color' }, to: { instanceId: 'q', port: 'source' } },
                { from: { instanceId: 'q', port: 'color' }, to: { instanceId: 'r', port: 'source' } },
                { from: { instanceId: 'r', port: 'color' }, to: { instanceId: 'p', port: 'source' } },
            ],
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.some((error) => /undeclared cycle/.test(error))).toBe(true);
    });

    test('declaring the closing edge as feedback makes the same cycle legal', () => {
        const result = compileGraph(
            [node('p', transform), node('q', transform)],
            [
                { from: { instanceId: 'p', port: 'color' }, to: { instanceId: 'q', port: 'source' } },
                {
                    from: { instanceId: 'q', port: 'color' },
                    to: { instanceId: 'p', port: 'source' },
                    feedback: true,
                },
            ],
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.graph.order.map((entry) => entry.instanceId)).toEqual(['p', 'q']);
        expect(result.graph.pingPong).toEqual(['q.color']);
    });

    test('accepts a declared feedback cycle and marks it for ping-pong', () => {
        const result = compileGraph(
            [node('a', source), node('b', feedbackConsumer)],
            [
                { from: { instanceId: 'a', port: 'color' }, to: { instanceId: 'b', port: 'source' } },
                {
                    from: { instanceId: 'b', port: 'color' },
                    to: { instanceId: 'b', port: 'history' },
                    feedback: true,
                },
            ],
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.graph.pingPong).toEqual(['b.color']);
        // The feedback read is separated from forward inputs, so it resolves to the prior frame.
        expect(result.graph.order[1].previous).toEqual({ history: 'b.color' });
        expect(result.graph.order[1].inputs).toEqual({ source: 'a.color' });
    });

    test('a feedback edge does not affect execution order', () => {
        const result = compileGraph(
            [node('a', source), node('b', feedbackConsumer)],
            [
                { from: { instanceId: 'a', port: 'color' }, to: { instanceId: 'b', port: 'source' } },
                {
                    from: { instanceId: 'b', port: 'color' },
                    to: { instanceId: 'b', port: 'history' },
                    feedback: true,
                },
            ],
        );
        if (!result.ok) throw new Error('expected compilation to succeed');

        expect(result.graph.order.map((entry) => entry.instanceId)).toEqual(['a', 'b']);
    });

    test('a feedback edge satisfies a required input', () => {
        const requiresHistory = definition({
            id: 'requires-history',
            category: 'transformer',
            inputs: [{ name: 'history', type: 'color-texture', required: true }],
        });
        const result = compileGraph(
            [node('h', requiresHistory)],
            [{
                from: { instanceId: 'h', port: 'color' },
                to: { instanceId: 'h', port: 'history' },
                feedback: true,
            }],
        );

        expect(result.ok).toBe(true);
    });

    test('deduplicates ping-pong resources read by several consumers', () => {
        const result = compileGraph(
            [node('a', source), node('b', feedbackConsumer), node('c', feedbackConsumer)],
            [
                { from: { instanceId: 'a', port: 'color' }, to: { instanceId: 'b', port: 'source' } },
                { from: { instanceId: 'a', port: 'color' }, to: { instanceId: 'c', port: 'source' } },
                { from: { instanceId: 'a', port: 'color' }, to: { instanceId: 'b', port: 'history' }, feedback: true },
                { from: { instanceId: 'a', port: 'color' }, to: { instanceId: 'c', port: 'history' }, feedback: true },
            ],
        );
        if (!result.ok) throw new Error('expected compilation to succeed');

        expect(result.graph.pingPong).toEqual(['a.color']);
    });
});

describe('plugin registry', () => {
    test('registers and retrieves by id and category', () => {
        const registry = createPluginRegistry([source, transform]);

        expect(registry.get('source')).toBe(source);
        expect(registry.all()).toHaveLength(2);
        expect(registry.byCategory('transformer')).toEqual([transform]);
        expect(registry.byCategory('simulator')).toEqual([]);
    });

    test('registering a new plugin needs no kernel change beyond the call', () => {
        const registry = createPluginRegistry();
        registry.register(definition({ id: 'late-arrival' }));

        expect(registry.get('late-arrival')?.id).toBe('late-arrival');
    });

    test('a higher version supersedes and a lower one is rejected', () => {
        const registry = createPluginRegistry([definition({ id: 'versioned', version: 1 })]);

        registry.register(definition({ id: 'versioned', version: 2 }));
        expect(registry.get('versioned')?.version).toBe(2);

        expect(() => registry.register(definition({ id: 'versioned', version: 2 }))).toThrow(/supersede/);
        expect(() => registry.register(definition({ id: 'versioned', version: 1 }))).toThrow(/supersede/);
    });

    test('rejects a structurally invalid definition', () => {
        const registry = createPluginRegistry();

        expect(() => registry.register(definition({ id: '' }))).toThrow(/invalid/);
        expect(() => registry.register(definition({ version: 0 }))).toThrow(/invalid/);
        expect(() => registry.register(definition({ outputs: [] }))).toThrow(/no outputs/);
    });

    test('a compositor may declare no outputs', () => {
        expect(validateDefinition(definition({ category: 'compositor', outputs: [] }))).toEqual([]);
    });

    test('rejects duplicate port names', () => {
        const problems = validateDefinition(definition({
            inputs: [colorIn(), colorIn()],
        }));

        expect(problems.some((problem) => /duplicate input port/.test(problem))).toBe(true);
    });

    test('rejects a binding that targets an undeclared parameter', () => {
        const problems = validateDefinition(definition({
            parameters: { zoom: 1 },
            defaultBindings: [{
                feature: 'bass',
                parameter: 'nonexistent',
                outputRange: [0, 1],
                attack: 0,
                release: 0,
                curve: 'linear',
            }],
        }));

        expect(problems.some((problem) => /undeclared parameter/.test(problem))).toBe(true);
    });

    test('accepts a binding that targets a declared parameter', () => {
        expect(validateDefinition(definition({
            parameters: { zoom: 1 },
            defaultBindings: [{
                feature: 'bass',
                parameter: 'zoom',
                outputRange: [0, 1],
                attack: 0,
                release: 0,
                curve: 'linear',
            }],
        }))).toEqual([]);
    });
});
