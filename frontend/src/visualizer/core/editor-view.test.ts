import { describe, expect, test } from 'vitest';
import {
    ACCUMULATE_NODE,
    buildEditorView,
    CANVAS_NODE,
    COMPOSITE_NODE,
    GRADE_NODE,
    isPinned,
    MOTION_NODE,
    PALETTE_NODE,
} from './editor-view';
import { emptyAuthoredScene, resolveAuthoredScene, type AuthoredScene } from './authored-scene';
import { createPluginRegistry } from './plugin';
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

const source = plugin('src', 'source', [], undefined, { parameters: { amount: 0.5 } });
const field = plugin('fld', 'field', [], [
    { name: 'flow', type: 'vector-field', required: false },
]);
const mixer = plugin('mix', 'compositor', [
    { name: 'a', type: 'color-texture', required: true },
    { name: 'b', type: 'color-texture', required: true },
]);
const masked = plugin('msk', 'transformer', [
    { name: 'mask', type: 'mask-texture', required: true },
]);
const twoOut = plugin('two', 'simulator', [], [
    { name: 'state', type: 'particle-buffer', required: false },
    { name: 'bins', type: 'particle-buffer', required: false, internal: true },
]);

const REGISTRY = createPluginRegistry([source, field, mixer, masked, twoOut]);

function view(document: AuthoredScene) {
    const resolved = resolveAuthoredScene(document, REGISTRY);

    return buildEditorView({
        document,
        registry: REGISTRY,
        graph: resolved.ok ? resolved.scene.graph : undefined,
        problems: resolved.ok ? resolved.warnings : resolved.problems,
    });
}

function scene(overrides: Partial<AuthoredScene> = {}): AuthoredScene {
    return {
        ...emptyAuthoredScene('view'),
        nodes: [{ id: 'src#0', pluginId: 'src', position: { x: 0, y: 0 } }],
        ...overrides,
    };
}

describe('plugin nodes', () => {
    test('a node carries its ports and parameters', () => {
        const node = view(scene()).nodes.find((candidate) => candidate.id === 'src#0');

        expect(node?.kind).toBe('plugin');
        expect(node?.category).toBe('source');
        expect(node?.outputs.map((port) => port.name)).toEqual(['color']);
        expect(node?.parameters).toEqual([{ name: 'amount', value: 0.5 }]);
    });

    test('an internal output is not drawn as a socket', () => {
        // It exists only to close a loop inside its own plugin and is offered to nobody, so a socket
        // would invite a connection that cannot be made.
        const node = view(scene({
            nodes: [{ id: 'two#0', pluginId: 'two', position: { x: 0, y: 0 } }],
        })).nodes.find((candidate) => candidate.id === 'two#0');

        expect(node?.outputs.map((port) => port.name)).toEqual(['state']);
    });

    test('a required input with nothing on it reads as unconnected', () => {
        const node = view(scene({
            nodes: [{ id: 'mix#0', pluginId: 'mix', position: { x: 0, y: 0 } }],
        })).nodes.find((candidate) => candidate.id === 'mix#0');

        expect(node?.inputs.every((port) => !port.connected)).toBe(true);
        expect(node?.inputs.every((port) => port.required)).toBe(true);
    });

    test('a parameter with a binding is not presented as a constant', () => {
        const binding = {
            feature: 'rms',
            parameter: 'amount',
            outputRange: [0, 1] as [number, number],
            attack: 0.1,
            release: 0.2,
            curve: 'linear' as const,
        };
        const node = view(scene({
            nodes: [{
                id: 'src#0',
                pluginId: 'src',
                position: { x: 0, y: 0 },
                bindings: [binding],
            }],
        })).nodes.find((candidate) => candidate.id === 'src#0');

        expect(node?.parameters[0].binding).toEqual(binding);
    });

    test('live values ride alongside the stated ones', () => {
        const built = buildEditorView({
            document: scene(),
            registry: REGISTRY,
            live: { 'src#0': { amount: 0.82 } },
        });
        const node = built.nodes.find((candidate) => candidate.id === 'src#0');

        expect(node?.parameters[0]).toEqual({ name: 'amount', value: 0.5, live: 0.82 });
    });

    test('a plugin that is no longer registered leaves a hole rather than vanishing', () => {
        const node = view(scene({
            nodes: [{ id: 'gone#0', pluginId: 'gone', position: { x: 0, y: 0 } }],
        })).nodes.find((candidate) => candidate.id === 'gone#0');

        expect(node).toBeDefined();
        expect(node?.subtitle).toBe('not registered');
        expect(node?.problems[0]).toContain('no plugin named gone');
    });
});

describe('assets', () => {
    const withAsset = scene({
        nodes: [{ id: 'msk#0', pluginId: 'msk', position: { x: 400, y: 0 } }],
        assetBindings: [{ node: 'msk#0', port: 'mask', resource: 'asset:ring' }],
    });

    test('a bound asset becomes a producer node left of its consumer', () => {
        const built = view(withAsset);
        const asset = built.nodes.find((node) => node.id === 'asset:ring');

        expect(asset?.kind).toBe('asset');
        expect(asset?.title).toBe('ring');
        expect(asset!.position.x).toBeLessThan(400);
    });

    test('one node per asset however many inputs it feeds', () => {
        const built = view({
            ...withAsset,
            nodes: [
                ...withAsset.nodes,
                { id: 'msk#1', pluginId: 'msk', position: { x: 400, y: 200 } },
            ],
            assetBindings: [
                ...withAsset.assetBindings,
                { node: 'msk#1', port: 'mask', resource: 'asset:ring' },
            ],
        });

        expect(built.nodes.filter((node) => node.id === 'asset:ring')).toHaveLength(1);
        expect(built.edges.filter((edge) => edge.kind === 'asset')).toHaveLength(2);
    });
});

describe('the implicit buses', () => {
    const twoBranches = scene({
        nodes: [
            { id: 'src#0', pluginId: 'src', position: { x: 0, y: 0 } },
            { id: 'src#1', pluginId: 'src', position: { x: 0, y: 200 } },
        ],
    });

    test('every unconsumed colour output reaches the compositor', () => {
        // The layer stack appears in no edge list, and it — not `present` — is what reaches the
        // screen. Two parallel sources are two layers.
        const built = view(twoBranches);
        const layerEdges = built.edges.filter((edge) => edge.kind === 'layer');

        expect(layerEdges.map((edge) => edge.from.node).sort()).toEqual(['src#0', 'src#1']);
        expect(layerEdges.every((edge) => edge.to.node === COMPOSITE_NODE)).toBe(true);
    });

    test('explicit composite membership can exclude a layer without hiding it as a choice', () => {
        const built = view({
            ...twoBranches,
            kernel: { compositeInputs: ['src#1'] },
        });
        const composite = built.nodes.find((node) => node.id === COMPOSITE_NODE);

        expect(built.edges.filter((edge) => edge.kind === 'layer').map((edge) => edge.from.node))
            .toEqual(['src#1']);
        expect(composite?.inputs.map((port) => port.name)).toEqual(['palette', 'src#1']);
        expect(composite?.availableInputs?.map((port) => port.name)).toEqual(['src#0', 'src#1']);
    });

    test('a consumed output is an intermediate, not a layer', () => {
        const built = view(scene({
            nodes: [
                { id: 'src#0', pluginId: 'src', position: { x: 0, y: 0 } },
                { id: 'src#1', pluginId: 'src', position: { x: 0, y: 200 } },
                { id: 'mix#0', pluginId: 'mix', position: { x: 320, y: 0 } },
            ],
            edges: [
                {
                    id: 'a',
                    from: { node: 'src#0', port: 'color' },
                    to: { node: 'mix#0', port: 'a' },
                },
                {
                    id: 'b',
                    from: { node: 'src#1', port: 'color' },
                    to: { node: 'mix#0', port: 'b' },
                },
            ],
        }));

        expect(built.edges.filter((edge) => edge.kind === 'layer').map((edge) => edge.from.node))
            .toEqual(['mix#0']);
    });

    test('a field reaches the motion sum whether or not anything reads it', () => {
        // This is the whole point of the motion bus, and it is invisible in the graph.
        const built = view(scene({
            nodes: [
                { id: 'src#0', pluginId: 'src', position: { x: 0, y: 0 } },
                { id: 'fld#0', pluginId: 'fld', position: { x: 0, y: 200 } },
            ],
        }));
        const motion = built.edges.filter((edge) => edge.kind === 'motion');

        expect(motion).toHaveLength(1);
        expect(motion[0].from.node).toBe('fld#0');
        expect(motion[0].to.node).toBe(MOTION_NODE);
    });

    test('explicit motion membership can select none while retaining available fields', () => {
        const built = view(scene({
            nodes: [
                { id: 'fld#0', pluginId: 'fld', position: { x: 0, y: 0 } },
                { id: 'fld#1', pluginId: 'fld', position: { x: 0, y: 200 } },
            ],
            kernel: { motionInputs: [] },
        }));
        const motion = built.nodes.find((node) => node.id === MOTION_NODE);

        expect(built.edges.filter((edge) => edge.kind === 'motion')).toEqual([]);
        expect(motion?.inputs).toEqual([]);
        expect(motion?.availableInputs?.map((port) => port.name))
            .toEqual(['fld#0.flow', 'fld#1.flow']);
    });

    test('a scene with no field says so rather than showing an empty stage', () => {
        const motionNode = view(twoBranches).nodes.find((node) => node.id === MOTION_NODE);

        expect(motionNode?.subtitle).toContain('not dragged');
        expect(motionNode?.outputs[0].connected).toBe(false);
    });
});

describe('the kernel tail', () => {
    test('the six stages are present and chained in the order they run', () => {
        const built = view(scene());
        const ids = built.nodes.filter((node) => node.kind === 'kernel').map((node) => node.id);

        expect(ids).toEqual([
            PALETTE_NODE, COMPOSITE_NODE, MOTION_NODE, ACCUMULATE_NODE, GRADE_NODE, CANVAS_NODE,
        ]);

        const chain = built.edges.filter((edge) => edge.kind === 'kernel');
        expect(chain.map((edge) => `${edge.from.node}->${edge.to.node}`)).toEqual([
            `${PALETTE_NODE}->${COMPOSITE_NODE}`,
            `${COMPOSITE_NODE}->${ACCUMULATE_NODE}`,
            `${MOTION_NODE}->${ACCUMULATE_NODE}`,
            `${ACCUMULATE_NODE}->${GRADE_NODE}`,
            `${GRADE_NODE}->${CANVAS_NODE}`,
        ]);
    });

    test('the tail sits right of everything in the document', () => {
        const built = view(scene({
            nodes: [{ id: 'src#0', pluginId: 'src', position: { x: 1200, y: 0 } }],
        }));
        const composite = built.nodes.find((node) => node.id === COMPOSITE_NODE);

        expect(composite!.position.x).toBeGreaterThan(1200);
    });

    test('an unpinned accumulation value has no constant to show', () => {
        const rows = view(scene()).nodes
            .find((node) => node.id === ACCUMULATE_NODE)!.parameters;

        expect(rows.map((row) => row.name))
            .toEqual(['survivalPerSecond', 'motionScale', 'transientPunch']);
        // Decided per frame from the theme, the layer stack and three audio channels. Showing zero
        // would be a worse lie than showing nothing.
        expect(rows.every((row) => !isPinned(row))).toBe(true);
    });

    test('a pinned accumulation value reads as pinned', () => {
        const rows = view(scene({
            kernel: { persistence: { survivalPerSecond: 0.8 } },
        })).nodes.find((node) => node.id === ACCUMULATE_NODE)!.parameters;

        expect(isPinned(rows[0])).toBe(true);
        expect(rows[0].value).toBe(0.8);
        expect(isPinned(rows[1])).toBe(false);
    });

    test('the grade shows all effective values and bindings, including kernel defaults', () => {
        const grade = view(scene({
            kernel: { grade: { parameters: { exposure: 1.5 } } },
        })).nodes.find((node) => node.id === GRADE_NODE);

        expect(grade?.parameters.map((row) => row.name)).toEqual([
            'contrast', 'exposure', 'hueDrift', 'saturation', 'tint',
        ]);
        expect(grade?.parameters.find((row) => row.name === 'exposure')?.value).toBe(1.5);
        expect(grade?.parameters.every((row) => row.binding)).toBe(true);
    });

    test('the palette is visible and can state an explicit scheme and strength', () => {
        const palette = view(scene({
            kernel: { palette: { id: 'monochrome-noir', strength: 0 } },
        })).nodes.find((node) => node.id === PALETTE_NODE);

        expect(palette?.subtitle).toBe('monochrome-noir');
        expect(palette?.parameters).toEqual([{ name: 'strength', value: 0 }]);
    });

    test('the composite counts its stack, and the canvas ends the chain', () => {
        const built = view(scene());

        expect(built.nodes.find((node) => node.id === COMPOSITE_NODE)?.subtitle).toBe('1 layer');
        expect(built.nodes.find((node) => node.id === CANVAS_NODE)?.outputs).toEqual([]);
    });

    test('a document that does not compile keeps the fixed kernel tail visible', () => {
        // There is no graph, so the layer stack and motion bus cannot be derived. The fixed stages
        // still exist, though: making them disappear makes a one-node removal look like it deleted
        // Composite, Accumulate, Grade and Canvas as collateral.
        const built = view(scene({
            nodes: [{ id: 'mix#0', pluginId: 'mix', position: { x: 0, y: 0 } }],
        }));

        expect(built.nodes.filter((node) => node.kind === 'kernel').map((node) => node.id)).toEqual([
            PALETTE_NODE,
            COMPOSITE_NODE,
            MOTION_NODE,
            ACCUMULATE_NODE,
            GRADE_NODE,
            CANVAS_NODE,
        ]);
        expect(built.nodes.find((node) => node.id === COMPOSITE_NODE)?.subtitle)
            .toBe('layers unresolved');
        expect(built.nodes.find((node) => node.id === 'mix#0')?.problems.length).toBeGreaterThan(0);
    });
});

describe('inspection targets', () => {
    test('a colour-producing node offers its own output', () => {
        expect(view(scene()).nodes.find((node) => node.id === 'src#0')?.inspect)
            .toBe('src#0.color');
    });

    test('a node producing no colour offers nothing to show alone', () => {
        expect(view(scene({
            nodes: [{ id: 'fld#0', pluginId: 'fld', position: { x: 0, y: 0 } }],
        })).nodes.find((node) => node.id === 'fld#0')?.inspect).toBeUndefined();
    });

    test('the inspectable kernel stages name the runtime targets', () => {
        const built = view(scene());
        const inspect = (id: string) => built.nodes.find((node) => node.id === id)?.inspect;

        expect(inspect(COMPOSITE_NODE)).toBe(COMPOSITE_NODE);
        expect(inspect(MOTION_NODE)).toBe(MOTION_NODE);
        expect(inspect(ACCUMULATE_NODE)).toBe(ACCUMULATE_NODE);
        // The graded image is the canvas, so there is nothing separate to show.
        expect(inspect(GRADE_NODE)).toBeUndefined();
    });
});
