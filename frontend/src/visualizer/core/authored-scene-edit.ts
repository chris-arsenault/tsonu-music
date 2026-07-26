/**
 * Every edit the graph editor can make, as a function from one document to the next.
 *
 * The editor's gestures live here rather than in the React surface, so what an edit *means* is
 * testable without a DOM — which in this repository is the only way it can be tested at all, since
 * the test environment has no jsdom. See ADR-0003.
 *
 * Every operation returns a new document and mutates nothing, which is also what makes undo a matter
 * of keeping the previous one rather than of inverting anything.
 */

import type { ParameterBinding } from './bindings';
import {
    edgeIdFor,
    type AuthoredEdge,
    type AuthoredKernel,
    type AuthoredNode,
    type AuthoredNodePosition,
    type AuthoredScene,
} from './authored-scene';
import { COMPOSITE_BINDINGS } from './composite-grade';
import type { LayerOverride } from './layers';
import type { PersistenceOverrides } from './persistence';
import type { VisualPluginDefinition } from './plugin';

/** Resolves a plugin id to its definition. Operations need port shapes, not the whole registry. */
export type PluginLookup = (pluginId: string) => VisualPluginDefinition | undefined;
export type KernelInputStage = 'composite' | 'motion';

/**
 * A free id for another instance of this definition.
 *
 * Matches the generated path's `instanceIdFor`, so a node added by hand is indistinguishable from one
 * the scheduler placed and a captured document stays internally consistent after editing.
 */
export function freeNodeId(scene: AuthoredScene, pluginId: string): string {
    const taken = new Set(scene.nodes.map((node) => node.id));

    for (let occurrence = 0; ; occurrence += 1) {
        const candidate = `${pluginId}#${occurrence}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
}

export function addNode(
    scene: AuthoredScene,
    pluginId: string,
    position: AuthoredNodePosition,
    id = freeNodeId(scene, pluginId),
): AuthoredScene {
    const node: AuthoredNode = { id, pluginId, position };

    return { ...scene, nodes: [...scene.nodes, node] };
}

/** Removes a node and everything attached to it, so no edge is left pointing at nothing. */
export function removeNode(scene: AuthoredScene, nodeId: string): AuthoredScene {
    const present = scene.present?.node === nodeId ? undefined : scene.present;

    return {
        ...scene,
        nodes: scene.nodes.filter((node) => node.id !== nodeId),
        edges: scene.edges.filter((edge) => edge.from.node !== nodeId && edge.to.node !== nodeId),
        assetBindings: scene.assetBindings.filter((binding) => binding.node !== nodeId),
        ...(present ? { present } : { present: undefined }),
    };
}

/**
 * Copies a node's plugin, parameters and bindings, but not its connections.
 *
 * A clone that inherited its source's edges would silently double every downstream input, and an
 * input that takes one connection would then refuse to compile. Copying the settings and leaving the
 * wiring to be drawn is what makes a clone useful for comparing two tunings side by side.
 */
export function cloneNode(
    scene: AuthoredScene,
    nodeId: string,
    offset: AuthoredNodePosition = { x: 48, y: 48 },
): AuthoredScene {
    const source = scene.nodes.find((node) => node.id === nodeId);
    if (!source) {
        return scene;
    }

    const clone: AuthoredNode = {
        ...source,
        id: freeNodeId(scene, source.pluginId),
        position: { x: source.position.x + offset.x, y: source.position.y + offset.y },
        ...(source.parameters ? { parameters: { ...source.parameters } } : {}),
        ...(source.bindings ? { bindings: source.bindings.map((binding) => ({ ...binding })) } : {}),
    };

    return { ...scene, nodes: [...scene.nodes, clone] };
}

/**
 * Draws an edge, displacing whatever already occupied the target input.
 *
 * An input that does not declare `multiple` takes one connection, and the compiler rejects a second.
 * Dropping a link on an occupied input therefore replaces rather than adds, which is both what the
 * compiler will accept and what the gesture means.
 */
export function connect(
    scene: AuthoredScene,
    from: { node: string; port: string },
    to: { node: string; port: string },
    lookup: PluginLookup,
    feedback = false,
): AuthoredScene {
    const target = scene.nodes.find((node) => node.id === to.node);
    const port = target && lookup(target.pluginId)?.inputs.find((entry) => entry.name === to.port);
    const displaces = !port?.multiple;

    const kept = scene.edges.filter((edge) => {
        if (edge.to.node !== to.node || edge.to.port !== to.port) {
            return true;
        }

        // An identical edge is replaced rather than duplicated whatever the port's arity.
        const identical = edge.from.node === from.node && edge.from.port === from.port;
        return !displaces && !identical;
    });

    const edge: AuthoredEdge = {
        id: edgeIdFor(from, to, feedback),
        from,
        to,
        ...(feedback ? { feedback: true } : {}),
    };

    return {
        ...scene,
        edges: [...kept, edge],
        // A single input cannot simultaneously read a graph edge and a host asset.
        assetBindings: displaces
            ? scene.assetBindings.filter((binding) =>
                binding.node !== to.node || binding.port !== to.port)
            : scene.assetBindings,
    };
}

/** Binds a host asset to an input, displacing another producer on a single-valued port. */
export function setAssetBinding(
    scene: AuthoredScene,
    to: { node: string; port: string },
    resource: string,
    lookup: PluginLookup,
): AuthoredScene {
    const target = scene.nodes.find((node) => node.id === to.node);
    const port = target && lookup(target.pluginId)?.inputs.find((entry) => entry.name === to.port);
    const displaces = !port?.multiple;
    const assetBindings = scene.assetBindings.filter((binding) => {
        if (binding.node !== to.node || binding.port !== to.port) {
            return true;
        }

        return !displaces && binding.resource !== resource;
    });

    return {
        ...scene,
        edges: displaces
            ? scene.edges.filter((edge) => edge.to.node !== to.node || edge.to.port !== to.port)
            : scene.edges,
        assetBindings: [...assetBindings, { node: to.node, port: to.port, resource }],
    };
}

export function disconnect(scene: AuthoredScene, edgeId: string): AuthoredScene {
    return { ...scene, edges: scene.edges.filter((edge) => edge.id !== edgeId) };
}

/** Marks an existing edge as reading the previous frame, or stops it doing so. */
export function setFeedback(
    scene: AuthoredScene,
    edgeId: string,
    feedback: boolean,
): AuthoredScene {
    return {
        ...scene,
        edges: scene.edges.map((edge) => (
            edge.id === edgeId
                ? {
                    ...edge,
                    id: edgeIdFor(edge.from, edge.to, feedback),
                    ...(feedback ? { feedback: true } : { feedback: undefined }),
                }
                : edge
        )),
    };
}

function updateNode(
    scene: AuthoredScene,
    nodeId: string,
    change: (node: AuthoredNode) => AuthoredNode,
): AuthoredScene {
    return {
        ...scene,
        nodes: scene.nodes.map((node) => (node.id === nodeId ? change(node) : node)),
    };
}

export function setPosition(
    scene: AuthoredScene,
    nodeId: string,
    position: AuthoredNodePosition,
): AuthoredScene {
    return updateNode(scene, nodeId, (node) => ({ ...node, position }));
}

export function setParameter(
    scene: AuthoredScene,
    nodeId: string,
    parameter: string,
    value: number,
): AuthoredScene {
    return updateNode(scene, nodeId, (node) => ({
        ...node,
        parameters: { ...(node.parameters ?? {}), [parameter]: value },
    }));
}

/**
 * Attaches a feature to a parameter, replacing any binding already on it.
 *
 * One parameter, one driver: two bindings on the same parameter mean the second overwrites the first
 * every frame, which reads as the first one silently not working.
 */
export function setBinding(
    scene: AuthoredScene,
    nodeId: string,
    binding: ParameterBinding,
    lookup: PluginLookup,
): AuthoredScene {
    return updateNode(scene, nodeId, (node) => {
        const current = node.bindings ?? lookup(node.pluginId)?.defaultBindings ?? [];

        return {
            ...node,
            bindings: [
                ...current.filter((entry) => entry.parameter !== binding.parameter),
                binding,
            ],
        };
    });
}

/** Detaches whatever drives a parameter, leaving it at its constant. */
export function removeBinding(
    scene: AuthoredScene,
    nodeId: string,
    parameter: string,
    lookup: PluginLookup,
): AuthoredScene {
    return updateNode(scene, nodeId, (node) => {
        const current = node.bindings ?? lookup(node.pluginId)?.defaultBindings ?? [];

        return { ...node, bindings: current.filter((entry) => entry.parameter !== parameter) };
    });
}

export function setMuted(scene: AuthoredScene, nodeId: string, muted: boolean): AuthoredScene {
    return updateNode(scene, nodeId, (node) => ({ ...node, muted: muted || undefined }));
}

/** Pins a node's identity, or returns it to one derived from the document's entropy. */
export function setSeed(
    scene: AuthoredScene,
    nodeId: string,
    seed: number | undefined,
): AuthoredScene {
    return updateNode(scene, nodeId, (node) => ({ ...node, seed }));
}

export function setPresent(
    scene: AuthoredScene,
    present: { node: string; port: string } | undefined,
): AuthoredScene {
    return { ...scene, present };
}

/** Shows a parameter as a socket rather than as a row, or puts it back. */
export function setPromoted(
    scene: AuthoredScene,
    nodeId: string,
    parameter: string,
    promoted: boolean,
): AuthoredScene {
    return updateNode(scene, nodeId, (node) => {
        const current = node.promoted ?? [];
        const next = promoted
            ? (current.includes(parameter) ? current : [...current, parameter])
            : current.filter((name) => name !== parameter);

        return { ...node, promoted: next.length > 0 ? next : undefined };
    });
}

export function isPromoted(node: AuthoredNode, parameter: string): boolean {
    return (node.promoted ?? []).includes(parameter);
}

/* -------------------------------------------------------------------------- */
/* The kernel tail                                                            */
/* -------------------------------------------------------------------------- */

function updateKernel(
    scene: AuthoredScene,
    change: (kernel: AuthoredKernel) => AuthoredKernel,
): AuthoredScene {
    return { ...scene, kernel: change(scene.kernel ?? {}) };
}

/**
 * Pins one kernel stage to explicit inputs, or returns it to all compatible graph outputs.
 *
 * An empty list is intentionally different from undefined: it disconnects the stage.
 */
export function setKernelInputs(
    scene: AuthoredScene,
    stage: KernelInputStage,
    inputs: readonly string[] | undefined,
): AuthoredScene {
    return updateKernel(scene, (kernel) => {
        const unique = inputs === undefined ? undefined : [...new Set(inputs)];
        const next = { ...kernel };

        if (stage === 'composite') {
            if (unique === undefined) {
                delete next.compositeInputs;
            } else {
                next.compositeInputs = unique;
            }
        } else if (unique === undefined) {
            delete next.motionInputs;
        } else {
            next.motionInputs = unique;
        }

        return next;
    });
}

/** Sets one of the grade's own parameters, which resolve exactly as a plugin's do. */
export function setGradeParameter(
    scene: AuthoredScene,
    parameter: string,
    value: number,
): AuthoredScene {
    return updateKernel(scene, (kernel) => ({
        ...kernel,
        grade: {
            ...kernel.grade,
            parameters: { ...(kernel.grade?.parameters ?? {}), [parameter]: value },
        },
    }));
}

export function setGradeBinding(
    scene: AuthoredScene,
    binding: ParameterBinding,
): AuthoredScene {
    return updateKernel(scene, (kernel) => ({
        ...kernel,
        grade: {
            ...kernel.grade,
            bindings: [
                ...(kernel.grade?.bindings ?? COMPOSITE_BINDINGS)
                    .filter((entry) => entry.parameter !== binding.parameter),
                binding,
            ],
        },
    }));
}

export function removeGradeBinding(scene: AuthoredScene, parameter: string): AuthoredScene {
    return updateKernel(scene, (kernel) => ({
        ...kernel,
        grade: {
            ...kernel.grade,
            bindings: (kernel.grade?.bindings ?? COMPOSITE_BINDINGS)
                .filter((entry) => entry.parameter !== parameter),
        },
    }));
}

/** Selects the scene palette explicitly, or releases it back to the theme and entropy. */
export function setPaletteId(scene: AuthoredScene, id: string | undefined): AuthoredScene {
    return updateKernel(scene, (kernel) => {
        const palette = { ...(kernel.palette ?? {}) };

        if (id === undefined) {
            delete palette.id;
        } else {
            palette.id = id;
        }

        return {
            ...kernel,
            palette: Object.keys(palette).length > 0 ? palette : undefined,
        };
    });
}

/** Pins how strongly Composite applies the selected scheme, or returns it to the theme. */
export function setPaletteStrength(scene: AuthoredScene, strength: number | undefined): AuthoredScene {
    return updateKernel(scene, (kernel) => {
        const palette = { ...(kernel.palette ?? {}) };

        if (strength === undefined) {
            delete palette.strength;
        } else {
            palette.strength = strength;
        }

        return {
            ...kernel,
            palette: Object.keys(palette).length > 0 ? palette : undefined,
        };
    });
}

/**
 * Pins one accumulation value, or releases it back to the theme and the audio.
 *
 * Released rather than set to zero: the three are decided per frame from the theme, the layer stack
 * and three audio channels, and a zero is a value while an absence is a question left to the kernel.
 */
export function setPersistencePin(
    scene: AuthoredScene,
    name: keyof PersistenceOverrides,
    value: number | undefined,
): AuthoredScene {
    return updateKernel(scene, (kernel) => {
        const persistence = { ...(kernel.persistence ?? {}) };

        if (value === undefined) {
            delete persistence[name];
        } else {
            persistence[name] = value;
        }

        return {
            ...kernel,
            persistence: Object.keys(persistence).length > 0 ? persistence : undefined,
        };
    });
}

/** Overrides how one layer is presented, or clears the override. */
export function setLayerOverride(
    scene: AuthoredScene,
    layerId: string,
    override: LayerOverride | undefined,
): AuthoredScene {
    return updateKernel(scene, (kernel) => {
        const layers = { ...(kernel.layers ?? {}) };

        if (override && Object.keys(override).length > 0) {
            layers[layerId] = override;
        } else {
            delete layers[layerId];
        }

        return { ...kernel, layers: Object.keys(layers).length > 0 ? layers : undefined };
    });
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

export interface DocumentHistory {
    past: AuthoredScene[];
    present: AuthoredScene;
    future: AuthoredScene[];
}

/**
 * How many documents back undo reaches.
 *
 * A document is small, but dragging a node emits one per frame, so an unbounded stack grows without
 * limit during ordinary use.
 */
export const MAX_HISTORY = 100;

export function createHistory(scene: AuthoredScene): DocumentHistory {
    return { past: [], present: scene, future: [] };
}

/**
 * Records an edit.
 *
 * An edit producing the document already in hand is not recorded, so a no-op — reconnecting an edge
 * where it already was, setting a parameter to the value it already holds — does not cost an undo
 * step that appears to do nothing when taken.
 */
export function commit(history: DocumentHistory, next: AuthoredScene): DocumentHistory {
    if (next === history.present) {
        return history;
    }

    return {
        past: [...history.past, history.present].slice(-MAX_HISTORY),
        present: next,
        future: [],
    };
}

/**
 * Records a continuous edit onto the previous one rather than beside it.
 *
 * Dragging a slider produces a document per frame. Each recorded separately, undo walks back through
 * the gesture one frame at a time instead of undoing the gesture.
 */
export function coalesce(history: DocumentHistory, next: AuthoredScene): DocumentHistory {
    if (next === history.present) {
        return history;
    }

    return { ...history, present: next, future: [] };
}

export function canUndo(history: DocumentHistory): boolean {
    return history.past.length > 0;
}

export function canRedo(history: DocumentHistory): boolean {
    return history.future.length > 0;
}

export function undo(history: DocumentHistory): DocumentHistory {
    const previous = history.past[history.past.length - 1];
    if (!previous) {
        return history;
    }

    return {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future].slice(0, MAX_HISTORY),
    };
}

export function redo(history: DocumentHistory): DocumentHistory {
    const [next, ...rest] = history.future;
    if (!next) {
        return history;
    }

    return {
        past: [...history.past, history.present].slice(-MAX_HISTORY),
        present: next,
        future: rest,
    };
}
