import { describe, expect, test } from 'vitest';
import {
    applyConnect,
    applyDisconnect,
    bindingOf,
    compatibleTargets,
    connectionAllowed,
} from './editor-actions';
import { buildEditorView, driverNodeId, parameterPortFor } from './editor-view';
import {
    addNode,
    setBinding,
    setPromoted,
    type PluginLookup,
} from './authored-scene-edit';
import { emptyAuthoredScene, resolveAuthoredScene, type AuthoredScene } from './authored-scene';
import { createPluginRegistry } from './plugin';
import type { PluginCategory, PluginPort, VisualPluginDefinition } from './plugin';
import type { ParameterBinding } from './bindings';

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

const binding: ParameterBinding = {
    feature: 'bass',
    parameter: 'amount',
    role: 'large-scale-force',
    outputRange: [0, 1],
    attack: 0.1,
    release: 0.2,
    curve: 'smooth',
};

const source = plugin('src', 'source', [], undefined, {
    parameters: { amount: 0.5, other: 1 },
    defaultBindings: [binding],
});
const transform = plugin('trn', 'transformer', [
    { name: 'source', type: 'color-texture', required: true },
], undefined, { parameters: { gain: 1 } });
const field = plugin('fld', 'field', [], [
    { name: 'flow', type: 'vector-field', required: false },
]);
const needsField = plugin('needy', 'simulator', [
    { name: 'flow', type: 'vector-field', required: true },
]);

const CATALOG = [source, transform, field, needsField];
const REGISTRY = createPluginRegistry(CATALOG);
const lookup: PluginLookup = (id) => CATALOG.find((entry) => entry.id === id);

const at = { x: 0, y: 0 };

function withNodes(...pluginIds: string[]): AuthoredScene {
    return pluginIds.reduce(
        (scene, pluginId) => addNode(scene, pluginId, at),
        emptyAuthoredScene('actions'),
    );
}

function viewOf(scene: AuthoredScene) {
    const resolved = resolveAuthoredScene(scene, REGISTRY);

    return buildEditorView({
        document: scene,
        registry: REGISTRY,
        graph: resolved.ok ? resolved.scene.graph : undefined,
    });
}

describe('what may be connected', () => {
    const scene = withNodes('src', 'trn');
    const view = viewOf(scene);

    test('a compatible pair is allowed', () => {
        expect(connectionAllowed(
            view,
            { node: 'src#0', port: 'color' },
            { node: 'trn#0', port: 'source' },
        )).toEqual({ ok: true, kind: 'data' });
    });

    test('an incompatible pair is refused by the compiler rule, not a second one', () => {
        const wider = viewOf(withNodes('src', 'needy'));
        const verdict = connectionAllowed(
            wider,
            { node: 'src#0', port: 'color' },
            { node: 'needy#0', port: 'flow' },
        );

        expect(verdict.ok).toBe(false);
        if (verdict.ok) return;
        expect(verdict.reason).toContain('does not satisfy');
    });

    test('a substitutable type is allowed, as the compiler allows it', () => {
        const wider = viewOf(withNodes('fld', 'needy'));

        expect(connectionAllowed(
            wider,
            { node: 'fld#0', port: 'flow' },
            { node: 'needy#0', port: 'flow' },
        ).ok).toBe(true);
    });

    test('a node may not feed itself, because a loop is declared rather than drawn', () => {
        const verdict = connectionAllowed(
            view,
            { node: 'trn#0', port: 'color' },
            { node: 'trn#0', port: 'source' },
        );

        expect(verdict.ok).toBe(false);
        if (verdict.ok) return;
        expect(verdict.reason).toContain('feedback');
    });

    test('the kernel stages take no new wiring', () => {
        expect(connectionAllowed(
            view,
            { node: 'src#0', port: 'color' },
            { node: 'kernel:accumulate', port: 'composite' },
        ).ok).toBe(false);
    });

    test('an end that is not on the canvas is refused', () => {
        expect(connectionAllowed(
            view,
            { node: 'ghost', port: 'color' },
            { node: 'trn#0', port: 'source' },
        ).ok).toBe(false);
    });
});

describe('promoted parameters', () => {
    const scene = setPromoted(withNodes('src', 'trn'), 'src#0', 'amount', true);
    const view = viewOf(scene);

    test('a promoted parameter becomes a socket and leaves the rows', () => {
        const node = view.nodes.find((candidate) => candidate.id === 'src#0');

        expect(node?.inputs.map((port) => port.name)).toContain(parameterPortFor('amount'));
        expect(node?.parameters.map((row) => row.name)).not.toContain('amount');
        expect(node?.parameters.map((row) => row.name)).toContain('other');
    });

    test('its driver is drawn from the binding rather than stored beside it', () => {
        const driver = view.nodes.find((node) => node.id === driverNodeId('src#0', 'amount'));

        expect(driver?.kind).toBe('feature');
        expect(driver?.title).toBe('bass');
        expect(driver?.details?.find((row) => row.label === 'drives')?.value)
            .toBe('src#0.amount');
    });

    test('an unbound promoted parameter shows as a constant', () => {
        const pinned = setPromoted(withNodes('trn'), 'trn#0', 'gain', true);
        const driver = viewOf(pinned).nodes.find((node) => node.id === driverNodeId('trn#0', 'gain'));

        expect(driver?.kind).toBe('constant');
        expect(driver?.parameters[0]).toEqual({ name: 'gain', value: 1 });
    });

    test('a parameter socket takes a driver and refuses a resource', () => {
        expect(connectionAllowed(
            view,
            { node: driverNodeId('src#0', 'amount'), port: 'value' },
            { node: 'src#0', port: parameterPortFor('amount') },
        )).toEqual({ ok: true, kind: 'parameter' });

        expect(connectionAllowed(
            view,
            { node: 'src#0', port: 'color' },
            { node: 'src#0', port: parameterPortFor('amount') },
        ).ok).toBe(false);
    });

    test('a driver refuses an ordinary input', () => {
        const verdict = connectionAllowed(
            view,
            { node: driverNodeId('src#0', 'amount'), port: 'value' },
            { node: 'trn#0', port: 'source' },
        );

        expect(verdict.ok).toBe(false);
        if (verdict.ok) return;
        expect(verdict.reason).toContain('drives a parameter');
    });

    test('promoting a parameter the plugin does not have shows nothing', () => {
        const odd = setPromoted(withNodes('trn'), 'trn#0', 'nonexistent', true);
        const node = viewOf(odd).nodes.find((candidate) => candidate.id === 'trn#0');

        expect(node?.inputs.map((port) => port.name))
            .not.toContain(parameterPortFor('nonexistent'));
    });
});

describe('applying a connection', () => {
    test('a data link becomes an edge', () => {
        const scene = withNodes('src', 'trn');
        const next = applyConnect(
            scene,
            viewOf(scene),
            { node: 'src#0', port: 'color' },
            { node: 'trn#0', port: 'source' },
            lookup,
        );

        expect(next.edges).toHaveLength(1);
        expect(resolveAuthoredScene(next, REGISTRY).ok).toBe(true);
    });

    test('a refused link changes nothing', () => {
        const scene = withNodes('src', 'needy');
        const next = applyConnect(
            scene,
            viewOf(scene),
            { node: 'src#0', port: 'color' },
            { node: 'needy#0', port: 'flow' },
            lookup,
        );

        expect(next).toBe(scene);
    });

    test('dragging a feature onto another parameter copies the binding, keeping the original', () => {
        // The feature node is a picture of a binding, so connecting it elsewhere means "drive that
        // too" rather than "move it".
        let scene = setPromoted(withNodes('src'), 'src#0', 'amount', true);
        scene = setPromoted(scene, 'src#0', 'other', true);

        const next = applyConnect(
            scene,
            viewOf(scene),
            { node: driverNodeId('src#0', 'amount'), port: 'value' },
            { node: 'src#0', port: parameterPortFor('other') },
            lookup,
        );

        expect(bindingOf(next, 'src#0', 'other', lookup)?.feature).toBe('bass');
        expect(bindingOf(next, 'src#0', 'amount', lookup)?.feature).toBe('bass');
    });

    test('dragging a constant onto a bound parameter pins it', () => {
        let scene = setPromoted(withNodes('src', 'trn'), 'trn#0', 'gain', true);
        scene = setPromoted(scene, 'src#0', 'amount', true);

        const next = applyConnect(
            scene,
            viewOf(scene),
            { node: driverNodeId('trn#0', 'gain'), port: 'value' },
            { node: 'src#0', port: parameterPortFor('amount') },
            lookup,
        );

        expect(bindingOf(next, 'src#0', 'amount', lookup)).toBeUndefined();
    });
});

describe('applying a disconnection', () => {
    test('a data edge is removed', () => {
        let scene = withNodes('src', 'trn');
        scene = applyConnect(
            scene,
            viewOf(scene),
            { node: 'src#0', port: 'color' },
            { node: 'trn#0', port: 'source' },
            lookup,
        );

        const result = applyDisconnect(scene, viewOf(scene), scene.edges[0].id, lookup);

        expect(result.scene.edges).toEqual([]);
        expect(result.refused).toBeUndefined();
    });

    test('cutting a driver returns the parameter to the rows, unbound', () => {
        const scene = setPromoted(withNodes('src'), 'src#0', 'amount', true);
        const view = viewOf(scene);
        const edge = view.edges.find((candidate) => candidate.kind === 'parameter')!;

        const result = applyDisconnect(scene, view, edge.id, lookup);

        expect(result.scene.nodes[0].promoted).toBeUndefined();
        expect(bindingOf(result.scene, 'src#0', 'amount', lookup)).toBeUndefined();
    });

    test('a derived edge cannot be cut, and says why rather than appearing to work', () => {
        const scene = withNodes('src');
        const view = viewOf(scene);
        const layer = view.edges.find((candidate) => candidate.kind === 'layer')!;

        const result = applyDisconnect(scene, view, layer.id, lookup);

        expect(result.scene).toBe(scene);
        expect(result.refused).toContain('derived');
    });

    test('an edge that is not there changes nothing', () => {
        const scene = withNodes('src');

        expect(applyDisconnect(scene, viewOf(scene), 'nope', lookup).scene).toBe(scene);
    });
});

describe('an edit keeps the instances it did not touch', () => {
    // `instantiate` reuses an instance when its id and its definition both match, so this is the
    // whole of what makes editing usable: a change to one node must not reset the particle state and
    // feedback buffers of every other node in the scene.
    const identities = (scene: AuthoredScene) => {
        const resolved = resolveAuthoredScene(scene, REGISTRY);
        if (!resolved.ok) throw new Error(resolved.problems[0].detail);

        return new Map(resolved.scene.nodes.map((node) => [node.instanceId, node.definition]));
    };

    test('adding a node renumbers nothing', () => {
        let scene = withNodes('src', 'trn');
        scene = applyConnect(
            scene,
            viewOf(scene),
            { node: 'src#0', port: 'color' },
            { node: 'trn#0', port: 'source' },
            lookup,
        );

        const before = identities(scene);
        const after = identities(addNode(scene, 'fld', at));

        for (const [instanceId, definition] of before) {
            expect(after.get(instanceId), instanceId).toBe(definition);
        }
    });

    test('rewiring an edge leaves every identity alone', () => {
        let scene = withNodes('src', 'src', 'trn');
        scene = applyConnect(
            scene,
            viewOf(scene),
            { node: 'src#0', port: 'color' },
            { node: 'trn#0', port: 'source' },
            lookup,
        );

        const before = identities(scene);
        const rewired = applyConnect(
            scene,
            viewOf(scene),
            { node: 'src#1', port: 'color' },
            { node: 'trn#0', port: 'source' },
            lookup,
        );

        expect(identities(rewired)).toEqual(before);
    });

    test('changing a parameter changes no identity at all', () => {
        const scene = withNodes('src');
        const before = identities(scene);

        expect(identities(setPromoted(scene, 'src#0', 'amount', true))).toEqual(before);
    });
});

describe('where a link may land', () => {
    test('the compatible sockets are offered and the rest are not', () => {
        const scene = withNodes('src', 'trn', 'needy');
        const targets = compatibleTargets(viewOf(scene), { node: 'src#0', port: 'color' });

        expect(targets.map((entry) => `${entry.node.id}.${entry.port}`)).toEqual(['trn#0.source']);
    });

    test('a feature may land on any promoted parameter and nothing else', () => {
        let scene = setPromoted(withNodes('src', 'trn'), 'src#0', 'amount', true);
        scene = setPromoted(scene, 'trn#0', 'gain', true);
        scene = setBinding(scene, 'trn#0', { ...binding, parameter: 'gain' }, lookup);

        const targets = compatibleTargets(
            viewOf(scene),
            { node: driverNodeId('src#0', 'amount'), port: 'value' },
        );

        expect(targets.map((entry) => `${entry.node.id}.${entry.port}`).sort()).toEqual([
            `src#0.${parameterPortFor('amount')}`,
            `trn#0.${parameterPortFor('gain')}`,
        ]);
    });
});
