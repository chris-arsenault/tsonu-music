import { describe, expect, test } from 'vitest';
import {
    AUTHORED_SCENE_VERSION,
    edgeIdFor,
    emptyAuthoredScene,
    resolveAuthoredScene,
    type AuthoredScene,
} from './authored-scene';
import { COMPOSITE_BINDINGS, COMPOSITE_PARAMETERS } from './composite-grade';
import { createPluginRegistry } from './plugin';
import type { PluginCategory, PluginPort, VisualPluginDefinition } from './plugin';
import { instanceSeed } from './random';

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

const source = plugin('src', 'source', [], undefined, {
    parameters: { amount: 0.5, unused: 2 },
});
const transform = plugin('trn', 'transformer', [
    { name: 'source', type: 'color-texture', required: true },
]);
const needsField = plugin('needy', 'simulator', [
    { name: 'flow', type: 'vector-field', required: true },
]);
const masked = plugin('masked', 'transformer', [
    { name: 'mask', type: 'mask-texture', required: true },
]);

const REGISTRY = createPluginRegistry([source, transform, needsField, masked]);

function document(overrides: Partial<AuthoredScene> = {}): AuthoredScene {
    return {
        ...emptyAuthoredScene('doc'),
        nodes: [
            { id: 'src#0', pluginId: 'src', position: { x: 0, y: 0 } },
            { id: 'trn#0', pluginId: 'trn', position: { x: 320, y: 0 } },
        ],
        edges: [{
            id: edgeIdFor({ node: 'src#0', port: 'color' }, { node: 'trn#0', port: 'source' }),
            from: { node: 'src#0', port: 'color' },
            to: { node: 'trn#0', port: 'source' },
        }],
        ...overrides,
    };
}

describe('authored scene resolution', () => {
    test('compiles a document into an executable graph', () => {
        const result = resolveAuthoredScene(document(), REGISTRY);

        expect(result.ok, result.ok ? '' : result.problems.map((p) => p.detail).join('; ')).toBe(true);
        if (!result.ok) return;

        expect(result.scene.graph.order.map((node) => node.instanceId)).toEqual(['src#0', 'trn#0']);
        expect(result.scene.graph.order[1].inputs.source).toBe('src#0.color');
    });

    test('an empty document is legal', () => {
        const result = resolveAuthoredScene(emptyAuthoredScene('nothing'), REGISTRY);

        expect(result.ok).toBe(true);
    });

    test('refuses a version it does not understand rather than misreading it', () => {
        const result = resolveAuthoredScene({ ...document(), version: 99 }, REGISTRY);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems[0].kind).toBe('version');
    });

    test('a plugin no longer in the catalog is reported against its node', () => {
        const result = resolveAuthoredScene(document({
            nodes: [{ id: 'gone#0', pluginId: 'gone', position: { x: 0, y: 0 } }],
            edges: [],
        }), REGISTRY);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems).toContainEqual(expect.objectContaining({
            kind: 'unknown-plugin',
            nodeId: 'gone#0',
        }));
    });

    test('two nodes sharing an id are reported rather than silently merged', () => {
        const result = resolveAuthoredScene(document({
            nodes: [
                { id: 'src#0', pluginId: 'src', position: { x: 0, y: 0 } },
                { id: 'src#0', pluginId: 'src', position: { x: 10, y: 0 } },
            ],
            edges: [],
        }), REGISTRY);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems[0].kind).toBe('duplicate-node');
    });

    test('an edge naming a node that is not there is anchored to the edge', () => {
        const result = resolveAuthoredScene(document({
            edges: [{
                id: 'dangling',
                from: { node: 'ghost', port: 'color' },
                to: { node: 'trn#0', port: 'source' },
            }],
        }), REGISTRY);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems[0].edgeId).toBe('dangling');
    });

    test('a type mismatch is anchored to the edge that made it', () => {
        const result = resolveAuthoredScene(document({
            nodes: [
                { id: 'src#0', pluginId: 'src', position: { x: 0, y: 0 } },
                { id: 'needy#0', pluginId: 'needy', position: { x: 320, y: 0 } },
            ],
            edges: [{
                id: 'wrong-type',
                from: { node: 'src#0', port: 'color' },
                to: { node: 'needy#0', port: 'flow' },
            }],
        }), REGISTRY);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems[0].edgeId).toBe('wrong-type');
        expect(result.problems[0].detail).toContain('cannot connect');
    });

    test('an unconnected required input is anchored to the node that declares it', () => {
        const result = resolveAuthoredScene(document({
            nodes: [{ id: 'trn#0', pluginId: 'trn', position: { x: 0, y: 0 } }],
            edges: [],
        }), REGISTRY);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problems[0].nodeId).toBe('trn#0');
        expect(result.problems[0].detail).toContain('required but unconnected');
    });

    test('an undeclared cycle is refused, and a declared one is not', () => {
        const cyclic = document({
            nodes: [
                { id: 'a#0', pluginId: 'trn', position: { x: 0, y: 0 } },
                { id: 'b#0', pluginId: 'trn', position: { x: 320, y: 0 } },
            ],
            edges: [
                {
                    id: 'a-to-b',
                    from: { node: 'a#0', port: 'color' },
                    to: { node: 'b#0', port: 'source' },
                },
                {
                    id: 'b-to-a',
                    from: { node: 'b#0', port: 'color' },
                    to: { node: 'a#0', port: 'source' },
                },
            ],
        });

        expect(resolveAuthoredScene(cyclic, REGISTRY).ok).toBe(false);

        const declared = {
            ...cyclic,
            edges: cyclic.edges.map((edge) =>
                (edge.id === 'b-to-a' ? { ...edge, feedback: true } : edge)),
        };

        expect(resolveAuthoredScene(declared, REGISTRY).ok).toBe(true);
    });

    test('a scene the grammar would reject still compiles', () => {
        // One source, nothing else: below every category floor, below the minimum scene size, and one
        // material branch where the grammar wants two. Being able to build this is the point.
        const result = resolveAuthoredScene(document({
            nodes: [{ id: 'src#0', pluginId: 'src', position: { x: 0, y: 0 } }],
            edges: [],
        }), REGISTRY);

        expect(result.ok).toBe(true);
    });

    test('an asset satisfies a required input that no node produces', () => {
        const result = resolveAuthoredScene(document({
            nodes: [{ id: 'masked#0', pluginId: 'masked', position: { x: 0, y: 0 } }],
            edges: [],
            assetBindings: [{ node: 'masked#0', port: 'mask', resource: 'asset:ring' }],
        }), REGISTRY);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.scene.graph.order[0].inputs.mask).toBe('asset:ring');
    });

    test('parameters resolve over the plugin defaults rather than replacing them', () => {
        const result = resolveAuthoredScene(document({
            nodes: [{
                id: 'src#0',
                pluginId: 'src',
                position: { x: 0, y: 0 },
                parameters: { amount: 0.9 },
            }],
            edges: [],
        }), REGISTRY);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.scene.parameters['src#0']).toEqual({ amount: 0.9, unused: 2 });
    });

    test('an absent seed derives from the document entropy, and a pinned one wins', () => {
        const result = resolveAuthoredScene(document({
            nodes: [
                { id: 'src#0', pluginId: 'src', position: { x: 0, y: 0 } },
                { id: 'trn#0', pluginId: 'trn', position: { x: 0, y: 0 }, seed: 0.25 },
            ],
        }), REGISTRY);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.scene.seeds['src#0']).toBe(instanceSeed('doc', 'src#0'));
        expect(result.scene.seeds['trn#0']).toBe(0.25);
    });

    test('absent bindings fall back to the plugin, and an empty array does not', () => {
        const bound = plugin('bound', 'source', [], undefined, {
            parameters: { amount: 0 },
            defaultBindings: [{
                feature: 'rms',
                parameter: 'amount',
                outputRange: [0, 1],
                attack: 0.1,
                release: 0.2,
                curve: 'linear',
            }],
        });
        const registry = createPluginRegistry([bound]);

        const inherited = resolveAuthoredScene({
            ...emptyAuthoredScene('b'),
            nodes: [{ id: 'bound#0', pluginId: 'bound', position: { x: 0, y: 0 } }],
        }, registry);
        const cleared = resolveAuthoredScene({
            ...emptyAuthoredScene('b'),
            nodes: [{ id: 'bound#0', pluginId: 'bound', position: { x: 0, y: 0 }, bindings: [] }],
        }, registry);

        expect(inherited.ok && inherited.scene.bindings[0].bindings).toHaveLength(1);
        expect(cleared.ok && cleared.scene.bindings[0].bindings).toHaveLength(0);
    });

    test('a binding on a parameter the plugin does not declare warns without failing', () => {
        const result = resolveAuthoredScene(document({
            nodes: [{
                id: 'src#0',
                pluginId: 'src',
                position: { x: 0, y: 0 },
                bindings: [{
                    feature: 'rms',
                    parameter: 'typo',
                    outputRange: [0, 1],
                    attack: 0.1,
                    release: 0.2,
                    curve: 'linear',
                }],
            }],
            edges: [],
        }), REGISTRY);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.warnings).toContainEqual(expect.objectContaining({
            kind: 'binding',
            nodeId: 'src#0',
        }));
    });

    test('a muted node stays in the graph and is reported as excluded', () => {
        const muted = document({
            nodes: document().nodes.map((node) =>
                (node.id === 'src#0' ? { ...node, muted: true } : node)),
        });
        const result = resolveAuthoredScene(muted, REGISTRY);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Muting is a runtime exclusion. Removing it from the graph would change what compiles.
        expect(result.scene.graph.order.map((node) => node.instanceId)).toEqual(['src#0', 'trn#0']);
        expect(result.scene.muted).toEqual(['src#0']);
    });

    test('a present target that does not exist is refused', () => {
        const result = resolveAuthoredScene(document({
            present: { node: 'trn#0', port: 'nope' },
        }), REGISTRY);

        expect(result.ok).toBe(false);
    });

    test('the version constant is what an empty document carries', () => {
        expect(emptyAuthoredScene('x').version).toBe(AUTHORED_SCENE_VERSION);
    });

    test('the wired structure comes back in the shape the host already reads', () => {
        const result = resolveAuthoredScene(document({
            assetBindings: [{ node: 'src#0', port: 'mask', resource: 'asset:ring' }],
            present: { node: 'trn#0', port: 'color' },
        }), REGISTRY);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.scene.wired.edges).toEqual([{
            from: { instanceId: 'src#0', port: 'color' },
            to: { instanceId: 'trn#0', port: 'source' },
        }]);
        expect(result.scene.wired.present).toEqual({ instanceId: 'trn#0', port: 'color' });
        expect(result.scene.wired.unsatisfied).toEqual([]);
    });
});

describe('the kernel tail', () => {
    test('an absent section resolves to what the kernel does with no document at all', () => {
        const result = resolveAuthoredScene(document(), REGISTRY);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.scene.kernel.gradeParameters).toEqual(COMPOSITE_PARAMETERS);
        expect(result.scene.kernel.gradeBindings).toBe(COMPOSITE_BINDINGS);
        expect(result.scene.kernel.persistence).toBeUndefined();
        expect(result.scene.kernel.layers).toBeUndefined();
    });

    test('grade parameters resolve over the kernel defaults rather than replacing them', () => {
        const result = resolveAuthoredScene(document({
            kernel: { grade: { parameters: { exposure: 2 } } },
        }), REGISTRY);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.scene.kernel.gradeParameters.exposure).toBe(2);
        expect(result.scene.kernel.gradeParameters.contrast).toBe(COMPOSITE_PARAMETERS.contrast);
    });

    test('a document may replace what drives the grade', () => {
        const bindings = [{
            feature: 'bass',
            parameter: 'exposure',
            outputRange: [1, 2] as [number, number],
            attack: 0.1,
            release: 0.2,
            curve: 'linear' as const,
        }];
        const result = resolveAuthoredScene(document({ kernel: { grade: { bindings } } }), REGISTRY);

        expect(result.ok && result.scene.kernel.gradeBindings).toEqual(bindings);
    });

    test('persistence pins and layer overrides come through', () => {
        const result = resolveAuthoredScene(document({
            kernel: {
                persistence: { survivalPerSecond: 0.9 },
                layers: { 'src#0': { opacity: 0 } },
            },
        }), REGISTRY);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.scene.kernel.persistence).toEqual({ survivalPerSecond: 0.9 });
        expect(result.scene.kernel.layers).toEqual({ 'src#0': { opacity: 0 } });
    });

    test('resolving twice does not share the mutable sections between the results', () => {
        const kernel = { persistence: { survivalPerSecond: 0.5 } };
        const first = resolveAuthoredScene(document({ kernel }), REGISTRY);

        kernel.persistence.survivalPerSecond = 0.1;

        expect(first.ok && first.scene.kernel.persistence?.survivalPerSecond).toBe(0.5);
    });
});
