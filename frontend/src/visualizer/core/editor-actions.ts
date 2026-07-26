/**
 * What a gesture on the canvas means to the document.
 *
 * The canvas draws more than the document holds: the layer stack and the motion bus are derived,
 * the kernel stages are fixed, and a promoted parameter's driver is a picture of its binding rather
 * than a node anybody stored. So dragging between two sockets is not always "add an edge" — between a
 * feature and a parameter it is "rebind", and onto a derived edge it is nothing at all.
 *
 * Translating here rather than in the canvas keeps every one of those rules testable in the Node
 * environment, and keeps the surface that handles pointer events free of decisions. See ADR-0003.
 */

import {
    driverTarget,
    parameterFromPort,
    type EditorNode,
    type EditorView,
} from './editor-view';
import {
    connect,
    disconnect,
    removeBinding,
    setBinding,
    setPromoted,
    type PluginLookup,
} from './authored-scene-edit';
import type { AuthoredScene } from './authored-scene';
import { portsCompatible } from './graph';

export interface CanvasEndpoint {
    node: string;
    port: string;
}

export type ConnectionVerdict =
    | { ok: true; kind: 'data' | 'parameter' }
    | { ok: false; reason: string };

/**
 * Whether a link may be drawn, by the same rule the compiler will apply.
 *
 * Type compatibility comes from `portsCompatible`, so a link the canvas allows is a link that
 * compiles and a link it refuses is one that would have been rejected. Everything else here is about
 * what the two ends *are*: a derived node has no editable wiring, and a value and a resource are not
 * interchangeable however their types read.
 */
export function connectionAllowed(
    view: EditorView,
    from: CanvasEndpoint,
    to: CanvasEndpoint,
): ConnectionVerdict {
    const source = view.nodes.find((node) => node.id === from.node);
    const target = view.nodes.find((node) => node.id === to.node);

    if (!source || !target) {
        return { ok: false, reason: 'one end is not on the canvas' };
    }

    if (source.id === target.id && !parameterFromPort(to.port)) {
        // A plugin reading its own output is a feedback loop, and one is declared by marking the
        // edge rather than by drawing it — otherwise the compiler sees an undeclared cycle.
        return { ok: false, reason: 'a node cannot feed itself; declare feedback on the edge instead' };
    }

    const parameter = parameterFromPort(to.port);
    const drives = source.kind === 'feature' || source.kind === 'constant';

    if (parameter) {
        return drives
            ? { ok: true, kind: 'parameter' }
            : { ok: false, reason: 'a parameter takes a feature or a constant, not a resource' };
    }

    if (drives) {
        return { ok: false, reason: 'a feature drives a parameter, not an input' };
    }

    if (target.kind === 'kernel' || source.kind === 'kernel') {
        return { ok: false, reason: 'the kernel stages are fixed' };
    }

    const outputType = source.outputs.find((port) => port.name === from.port)?.type;
    const inputType = target.inputs.find((port) => port.name === to.port)?.type;

    if (!outputType || !inputType) {
        return { ok: false, reason: 'that socket carries no graph type' };
    }

    if (!portsCompatible(outputType, inputType)) {
        return { ok: false, reason: `${outputType} does not satisfy ${inputType}` };
    }

    return { ok: true, kind: 'data' };
}

/**
 * Applies a link the canvas drew.
 *
 * A link into a parameter socket moves that parameter's driver, which is a rebinding rather than an
 * edge: the feature node being dragged from is a picture of a binding, so connecting it elsewhere
 * copies the binding onto the new parameter and leaves the original where it was. Dragging a
 * *constant* onto a parameter clears whatever bound it, which is how a parameter is pinned.
 */
export function applyConnect(
    scene: AuthoredScene,
    view: EditorView,
    from: CanvasEndpoint,
    to: CanvasEndpoint,
    lookup: PluginLookup,
): AuthoredScene {
    const verdict = connectionAllowed(view, from, to);
    if (!verdict.ok) {
        return scene;
    }

    const parameter = parameterFromPort(to.port);
    if (!parameter) {
        return connect(scene, from, to, lookup);
    }

    const origin = driverTarget(from.node);
    const source = view.nodes.find((node) => node.id === from.node);

    if (!origin || !source) {
        return scene;
    }

    if (source.kind === 'constant') {
        return removeBinding(scene, to.node, parameter, lookup);
    }

    const binding = bindingOf(scene, origin.node, origin.parameter, lookup);

    return binding
        ? setBinding(scene, to.node, { ...binding, parameter }, lookup)
        : scene;
}

/**
 * Applies a link the canvas deleted.
 *
 * Only two kinds of edge are the document's to remove. A layer or motion edge is derived from what
 * the graph produces, and deleting the picture of a fact does not change the fact — the node has to
 * go, or stop producing. Saying so is better than appearing to work.
 */
export function applyDisconnect(
    scene: AuthoredScene,
    view: EditorView,
    edgeId: string,
    lookup: PluginLookup,
): { scene: AuthoredScene; refused?: string } {
    const edge = view.edges.find((candidate) => candidate.id === edgeId);

    if (!edge) {
        return { scene };
    }

    if (edge.kind === 'data' || edge.kind === 'feedback') {
        return { scene: disconnect(scene, edgeId) };
    }

    if (edge.kind === 'parameter') {
        const parameter = parameterFromPort(edge.to.port);

        // Cutting a driver puts the parameter back among the rows at whatever value it holds, which
        // is what "no longer driven by this" means for a value that must always have one.
        return parameter
            ? { scene: setPromoted(removeBinding(scene, edge.to.node, parameter, lookup), edge.to.node, parameter, false) }
            : { scene };
    }

    return {
        scene,
        refused: edge.kind === 'asset'
            ? 'an asset binding is removed from the node that reads it'
            : 'that connection is derived from what the scene produces, not drawn',
    };
}

/** The binding on one parameter, whether the document states it or the plugin ships it. */
export function bindingOf(
    scene: AuthoredScene,
    nodeId: string,
    parameter: string,
    lookup: PluginLookup,
) {
    const node = scene.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
        return undefined;
    }

    const bindings = node.bindings ?? lookup(node.pluginId)?.defaultBindings ?? [];

    return bindings.find((binding) => binding.parameter === parameter);
}

/**
 * Sockets a link may be dropped on, given where it started.
 *
 * Drives the search box that opens when a link is dropped on empty canvas, and the dimming of
 * everything a link cannot reach while it is being dragged.
 */
export function compatibleTargets(
    view: EditorView,
    from: CanvasEndpoint,
): { node: EditorNode; port: string }[] {
    const targets: { node: EditorNode; port: string }[] = [];

    for (const node of view.nodes) {
        for (const port of node.inputs) {
            if (connectionAllowed(view, from, { node: node.id, port: port.name }).ok) {
                targets.push({ node, port: port.name });
            }
        }
    }

    return targets;
}
