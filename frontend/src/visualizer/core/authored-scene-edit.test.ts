import { describe, expect, test } from 'vitest';
import {
    addNode,
    canRedo,
    canUndo,
    cloneNode,
    coalesce,
    commit,
    connect,
    createHistory,
    disconnect,
    freeNodeId,
    isPromoted,
    MAX_HISTORY,
    redo,
    removeBinding,
    removeGradeBinding,
    removeNode,
    setBinding,
    setAssetBinding,
    setFeedback,
    setGradeBinding,
    setGradeParameter,
    setKernelInputs,
    setLayerOverride,
    setMuted,
    setPaletteId,
    setPaletteStrength,
    setParameter,
    setPersistencePin,
    setPosition,
    setPresent,
    setPromoted,
    setSeed,
    undo,
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
    feature: 'rms',
    parameter: 'amount',
    outputRange: [0, 1],
    attack: 0.1,
    release: 0.2,
    curve: 'linear',
};

const source = plugin('src', 'source', [], undefined, {
    parameters: { amount: 0.5 },
    defaultBindings: [binding],
});
const single = plugin('one', 'transformer', [
    { name: 'source', type: 'color-texture', required: true },
]);
const many = plugin('mix', 'compositor', [
    { name: 'layers', type: 'color-texture', required: true, multiple: true },
]);

const CATALOG = [source, single, many];
const REGISTRY = createPluginRegistry(CATALOG);
const lookup: PluginLookup = (id) => CATALOG.find((entry) => entry.id === id);

const at = { x: 0, y: 0 };

function twoNodes(): AuthoredScene {
    return addNode(addNode(emptyAuthoredScene('edit'), 'src', at), 'one', at);
}

describe('node operations', () => {
    test('an added node takes the next free id for its plugin', () => {
        const scene = addNode(addNode(emptyAuthoredScene('e'), 'src', at), 'src', at);

        expect(scene.nodes.map((node) => node.id)).toEqual(['src#0', 'src#1']);
    });

    test('a freed id skips the ones in use rather than colliding', () => {
        const scene = addNode(emptyAuthoredScene('e'), 'src', at);

        expect(freeNodeId(scene, 'src')).toBe('src#1');
        expect(freeNodeId(removeNode(scene, 'src#0'), 'src')).toBe('src#0');
    });

    test('removing a node takes its edges, asset bindings and present target with it', () => {
        let scene = connect(
            twoNodes(),
            { node: 'src#0', port: 'color' },
            { node: 'one#0', port: 'source' },
            lookup,
        );
        scene = setPresent(scene, { node: 'src#0', port: 'color' });
        scene = {
            ...scene,
            assetBindings: [{ node: 'src#0', port: 'mask', resource: 'asset:ring' }],
        };

        const after = removeNode(scene, 'src#0');

        expect(after.nodes.map((node) => node.id)).toEqual(['one#0']);
        expect(after.edges).toEqual([]);
        expect(after.assetBindings).toEqual([]);
        expect(after.present).toBeUndefined();
    });

    test('a clone copies the settings and not the wiring', () => {
        let scene = connect(
            twoNodes(),
            { node: 'src#0', port: 'color' },
            { node: 'one#0', port: 'source' },
            lookup,
        );
        scene = setParameter(scene, 'src#0', 'amount', 0.9);

        const cloned = cloneNode(scene, 'src#0');
        const clone = cloned.nodes.find((node) => node.id === 'src#1');

        expect(clone?.parameters).toEqual({ amount: 0.9 });
        // Inheriting the edges would double every downstream input, which an input taking one
        // connection then refuses to compile.
        expect(cloned.edges.filter((edge) => edge.from.node === 'src#1')).toEqual([]);
    });

    test('a clone is offset so it does not land underneath its source', () => {
        const cloned = cloneNode(addNode(emptyAuthoredScene('e'), 'src', { x: 10, y: 20 }), 'src#0');

        expect(cloned.nodes[1].position).toEqual({ x: 58, y: 68 });
    });

    test('cloning a node that is not there changes nothing', () => {
        const scene = twoNodes();

        expect(cloneNode(scene, 'ghost')).toBe(scene);
    });
});

describe('connections', () => {
    const from = { node: 'src#0', port: 'color' };
    const to = { node: 'one#0', port: 'source' };

    test('connecting produces an edge the resolver accepts', () => {
        const scene = connect(twoNodes(), from, to, lookup);
        const resolved = resolveAuthoredScene(scene, REGISTRY);

        expect(resolved.ok, resolved.ok ? '' : resolved.problems[0].detail).toBe(true);
        expect(scene.edges).toHaveLength(1);
    });

    test('a second connection into a single input displaces the first', () => {
        let scene = addNode(twoNodes(), 'src', at);
        scene = connect(scene, from, to, lookup);
        scene = connect(scene, { node: 'src#1', port: 'color' }, to, lookup);

        expect(scene.edges).toHaveLength(1);
        expect(scene.edges[0].from.node).toBe('src#1');
    });

    test('an input declaring multiple keeps both', () => {
        let scene = addNode(addNode(addNode(emptyAuthoredScene('m'), 'src', at), 'src', at), 'mix', at);
        const into = { node: 'mix#0', port: 'layers' };
        scene = connect(scene, { node: 'src#0', port: 'color' }, into, lookup);
        scene = connect(scene, { node: 'src#1', port: 'color' }, into, lookup);

        expect(scene.edges).toHaveLength(2);
    });

    test('the same connection drawn twice is not duplicated', () => {
        let scene = addNode(addNode(addNode(emptyAuthoredScene('m'), 'src', at), 'src', at), 'mix', at);
        const into = { node: 'mix#0', port: 'layers' };
        scene = connect(scene, { node: 'src#0', port: 'color' }, into, lookup);
        scene = connect(scene, { node: 'src#0', port: 'color' }, into, lookup);

        expect(scene.edges).toHaveLength(1);
    });

    test('an asset binding displaces an edge on a single input', () => {
        const connected = connect(twoNodes(), from, to, lookup);
        const scene = setAssetBinding(connected, to, 'asset:mask:ring', lookup);

        expect(scene.edges).toEqual([]);
        expect(scene.assetBindings).toEqual([
            { node: 'one#0', port: 'source', resource: 'asset:mask:ring' },
        ]);
    });

    test('a graph edge displaces an asset on a single input', () => {
        const bound = setAssetBinding(twoNodes(), to, 'asset:mask:ring', lookup);
        const scene = connect(bound, from, to, lookup);

        expect(scene.assetBindings).toEqual([]);
        expect(scene.edges).toHaveLength(1);
    });

    test('binding the same asset twice does not duplicate it', () => {
        let scene = setAssetBinding(twoNodes(), to, 'asset:mask:ring', lookup);
        scene = setAssetBinding(scene, to, 'asset:mask:ring', lookup);

        expect(scene.assetBindings).toHaveLength(1);
    });

    test('disconnecting removes exactly the edge named', () => {
        const scene = connect(twoNodes(), from, to, lookup);

        expect(disconnect(scene, scene.edges[0].id).edges).toEqual([]);
        expect(disconnect(scene, 'other').edges).toHaveLength(1);
    });

    test('declaring an edge as feedback renames it so its id still describes it', () => {
        const scene = setFeedback(
            connect(twoNodes(), from, to, lookup),
            connect(twoNodes(), from, to, lookup).edges[0].id,
            true,
        );

        expect(scene.edges[0].feedback).toBe(true);
        expect(scene.edges[0].id).toContain(':feedback');
    });
});

describe('parameters and bindings', () => {
    test('setting a constant leaves the other parameters alone', () => {
        const scene = setParameter(setParameter(twoNodes(), 'src#0', 'amount', 0.2), 'src#0', 'other', 3);

        expect(scene.nodes[0].parameters).toEqual({ amount: 0.2, other: 3 });
    });

    test('binding a parameter starts from the plugin defaults when the node has none', () => {
        const scene = setBinding(twoNodes(), 'src#0', { ...binding, feature: 'bass' }, lookup);

        expect(scene.nodes[0].bindings).toEqual([{ ...binding, feature: 'bass' }]);
    });

    test('one parameter takes one driver', () => {
        // Two bindings on one parameter means the second overwrites the first every frame, which
        // reads as the first silently not working.
        let scene = setBinding(twoNodes(), 'src#0', { ...binding, feature: 'bass' }, lookup);
        scene = setBinding(scene, 'src#0', { ...binding, feature: 'treble' }, lookup);

        expect(scene.nodes[0].bindings).toHaveLength(1);
        expect(scene.nodes[0].bindings?.[0].feature).toBe('treble');
    });

    test('removing a binding leaves the parameter at its constant', () => {
        const scene = removeBinding(
            addNode(emptyAuthoredScene('unbind'), 'src', at),
            'src#0',
            'amount',
            lookup,
        );

        expect(scene.nodes[0].bindings).toEqual([]);

        // Cleared at the document level, so resolution must not put the plugin's own binding back.
        const resolved = resolveAuthoredScene(scene, REGISTRY);
        expect(resolved.ok, resolved.ok ? '' : resolved.problems[0].detail).toBe(true);
        expect(resolved.ok && resolved.scene.bindings[0].bindings).toEqual([]);
    });

    test('muting and unmuting round-trips to no flag at all', () => {
        const muted = setMuted(twoNodes(), 'src#0', true);

        expect(muted.nodes[0].muted).toBe(true);
        expect(setMuted(muted, 'src#0', false).nodes[0].muted).toBeUndefined();
    });

    test('a seed can be pinned and released', () => {
        const pinned = setSeed(twoNodes(), 'src#0', 0.5);

        expect(pinned.nodes[0].seed).toBe(0.5);
        expect(setSeed(pinned, 'src#0', undefined).nodes[0].seed).toBeUndefined();
    });

    test('moving a node changes nothing but its position', () => {
        const moved = setPosition(twoNodes(), 'src#0', { x: 5, y: 7 });

        expect(moved.nodes[0].position).toEqual({ x: 5, y: 7 });
        expect(moved.edges).toEqual([]);
    });
});

describe('promotion', () => {
    test('promoting and demoting round-trips to no list at all', () => {
        const promoted = setPromoted(twoNodes(), 'src#0', 'amount', true);

        expect(promoted.nodes[0].promoted).toEqual(['amount']);
        expect(setPromoted(promoted, 'src#0', 'amount', false).nodes[0].promoted).toBeUndefined();
    });

    test('promoting twice does not list it twice', () => {
        const once = setPromoted(twoNodes(), 'src#0', 'amount', true);

        expect(setPromoted(once, 'src#0', 'amount', true).nodes[0].promoted).toEqual(['amount']);
    });

    test('isPromoted answers for a node that has never been promoted', () => {
        expect(isPromoted(twoNodes().nodes[0], 'amount')).toBe(false);
    });
});

describe('the kernel tail', () => {
    const base = emptyAuthoredScene('kernel');

    test('a grade parameter is set over whatever was there', () => {
        const scene = setGradeParameter(setGradeParameter(base, 'exposure', 1.2), 'contrast', 2);

        expect(scene.kernel?.grade?.parameters).toEqual({ exposure: 1.2, contrast: 2 });
    });

    test('a grade binding replaces the one on its parameter, keeping the others', () => {
        const scene = setGradeBinding(base, { ...binding, parameter: 'exposure', feature: 'peak' });
        const bindings = scene.kernel?.grade?.bindings ?? [];

        expect(bindings.filter((entry) => entry.parameter === 'exposure')).toHaveLength(1);
        expect(bindings.find((entry) => entry.parameter === 'exposure')?.feature).toBe('peak');
        // The kernel's own bindings for the other parameters are still there.
        expect(bindings.length).toBeGreaterThan(1);
    });

    test('palette selection and strength can be pinned and released independently', () => {
        let scene = setPaletteId(base, 'monochrome-noir');
        scene = setPaletteStrength(scene, 0);

        expect(scene.kernel?.palette).toEqual({ id: 'monochrome-noir', strength: 0 });

        scene = setPaletteId(scene, undefined);
        expect(scene.kernel?.palette).toEqual({ strength: 0 });
        scene = setPaletteStrength(scene, undefined);
        expect(scene.kernel?.palette).toBeUndefined();
    });

    test('removing a grade binding leaves the rest of the kernel default set', () => {
        const scene = removeGradeBinding(base, 'exposure');

        expect(scene.kernel?.grade?.bindings?.some((entry) => entry.parameter === 'exposure'))
            .toBe(false);
        expect(scene.kernel?.grade?.bindings?.length).toBeGreaterThan(0);
    });

    test('a persistence value can be pinned and released independently', () => {
        let scene = setPersistencePin(base, 'survivalPerSecond', 0.9);
        scene = setPersistencePin(scene, 'motionScale', 0.1);

        expect(scene.kernel?.persistence).toEqual({ survivalPerSecond: 0.9, motionScale: 0.1 });

        scene = setPersistencePin(scene, 'survivalPerSecond', undefined);
        expect(scene.kernel?.persistence).toEqual({ motionScale: 0.1 });
    });

    test('releasing the last pin removes the section rather than leaving an empty one', () => {
        // An absence is a question left to the kernel; an empty object is a claim to have answered it.
        const pinned = setPersistencePin(base, 'survivalPerSecond', 0.9);

        expect(setPersistencePin(pinned, 'survivalPerSecond', undefined).kernel?.persistence)
            .toBeUndefined();
    });

    test('a zero pin is a pin', () => {
        expect(setPersistencePin(base, 'motionScale', 0).kernel?.persistence)
            .toEqual({ motionScale: 0 });
    });

    test('kernel input membership distinguishes explicit empty from automatic', () => {
        let scene = setKernelInputs(base, 'composite', ['src#1', 'src#1', 'src#0']);
        scene = setKernelInputs(scene, 'motion', []);

        expect(scene.kernel?.compositeInputs).toEqual(['src#1', 'src#0']);
        expect(scene.kernel?.motionInputs).toEqual([]);

        scene = setKernelInputs(scene, 'composite', undefined);
        expect(scene.kernel?.compositeInputs).toBeUndefined();
        expect(scene.kernel?.motionInputs).toEqual([]);
    });

    test('a layer override is set and cleared by the layer it names', () => {
        const scene = setLayerOverride(base, 'src#0', { opacity: 0, blendMode: 'add' });

        expect(scene.kernel?.layers).toEqual({ 'src#0': { opacity: 0, blendMode: 'add' } });
        expect(setLayerOverride(scene, 'src#0', undefined).kernel?.layers).toBeUndefined();
        expect(setLayerOverride(scene, 'src#0', {}).kernel?.layers).toBeUndefined();
    });
});

describe('history', () => {
    const base = emptyAuthoredScene('h');

    test('nothing to undo at the start', () => {
        expect(canUndo(createHistory(base))).toBe(false);
        expect(canRedo(createHistory(base))).toBe(false);
    });

    test('undo returns the previous document and redo puts it back', () => {
        const first = addNode(base, 'src', at);
        const second = addNode(first, 'one', at);

        let history = commit(commit(createHistory(base), first), second);
        expect(history.present).toBe(second);

        history = undo(history);
        expect(history.present).toBe(first);
        expect(canRedo(history)).toBe(true);

        history = redo(history);
        expect(history.present).toBe(second);
    });

    test('an edit after an undo discards what was ahead', () => {
        const first = addNode(base, 'src', at);
        const second = addNode(first, 'one', at);
        const other = addNode(first, 'mix', at);

        const history = commit(undo(commit(commit(createHistory(base), first), second)), other);

        expect(history.present).toBe(other);
        expect(canRedo(history)).toBe(false);
    });

    test('an edit producing the same document is not recorded', () => {
        const history = createHistory(base);

        expect(commit(history, base)).toBe(history);
    });

    test('a coalesced edit replaces the last rather than stacking on it', () => {
        // A continuous slider emits a document per frame. Recorded separately, undo walks back
        // through the gesture one frame at a time instead of undoing the gesture.
        const dragged = setPosition(addNode(base, 'src', at), 'src#0', { x: 10, y: 0 });
        const further = setPosition(dragged, 'src#0', { x: 20, y: 0 });

        let history = commit(createHistory(base), addNode(base, 'src', at));
        const depth = history.past.length;
        history = coalesce(coalesce(history, dragged), further);

        expect(history.past.length).toBe(depth);
        expect(history.present).toBe(further);
        expect(undo(history).present).toBe(base);
    });

    test('a settled node move is one undoable document change', () => {
        const placed = addNode(base, 'src', at);
        const moved = setPosition(placed, 'src#0', { x: 20, y: 30 });
        const history = commit(createHistory(placed), moved);

        expect(history.past).toEqual([placed]);
        expect(history.present.nodes[0].position).toEqual({ x: 20, y: 30 });
        expect(undo(history).present.nodes[0].position).toEqual(at);
    });

    test('history is bounded', () => {
        let history = createHistory(base);
        for (let index = 0; index < MAX_HISTORY + 40; index += 1) {
            history = commit(history, addNode(history.present, 'src', at));
        }

        expect(history.past.length).toBe(MAX_HISTORY);
    });

    test('undo and redo at the ends are no-ops', () => {
        const history = createHistory(base);

        expect(undo(history)).toBe(history);
        expect(redo(history)).toBe(history);
    });
});
