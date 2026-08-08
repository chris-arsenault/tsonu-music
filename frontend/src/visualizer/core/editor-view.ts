/**
 * What the graph editor draws, derived from what actually runs.
 *
 * The reason this exists as a derivation rather than as a rendering of the document: three of the
 * structures deciding what reaches the screen are not in the document, not in the edge list, and not
 * anywhere a reader can see them.
 *
 * The **layer stack** is every colour output nothing else consumes, blended in graph order with a
 * mode chosen from the plugin's character. The **motion bus** is every motion-typed resource in the
 * graph, summed whether or not anything reads it. The **kernel tail** — composite, motion sum,
 * accumulation, meter, grade — runs outside the render graph entirely and decides as much about the
 * finished frame as the graph does.
 *
 * A view that showed only the document's own edges would be a picture of a third of the system, and
 * would be most misleading exactly where the frame is hardest to explain.
 *
 * Pure, so what the editor claims about the running scene is testable without a browser.
 */

import type { AuthoredProblem, AuthoredScene } from './authored-scene';
import type { ParameterBinding } from './bindings';
import { COMPOSITE_BINDINGS, COMPOSITE_PARAMETERS } from './composite-grade';
import type { CompiledGraph } from './graph';
import { layersForGraph } from './layers';
import { selectKernelInputs } from './kernel-inputs';
import type { PluginCategory, PluginRegistry, PortType } from './plugin';
import type { ResourceId } from './passes';

/** The kernel's own stages, in the order they run. Ids match the runtime's target keys. */
export const PALETTE_NODE = 'kernel:palette';
export const COMPOSITE_NODE = 'kernel:composite';
// An `ACCUMULATE_NODE` stood between the composite and the grade, carrying the survival and punch
// pins. The stage it drew is gone (ADR-0013), and drawing a node for a pass that does not run is the
// kind of diagram that gets trusted and then contradicts the code.
export const GRADE_NODE = 'kernel:grade';
export const CANVAS_NODE = 'kernel:canvas';

export type EditorNodeKind = 'plugin' | 'asset' | 'kernel' | 'feature' | 'constant';

/** Prefix for the socket a promoted parameter is reached through. */
export const PARAMETER_PORT = 'param:';

export function parameterPortFor(parameter: string): string {
    return `${PARAMETER_PORT}${parameter}`;
}

export function parameterFromPort(port: string): string | undefined {
    return port.startsWith(PARAMETER_PORT) ? port.slice(PARAMETER_PORT.length) : undefined;
}

/** The node that drives a promoted parameter. Derived from the binding, not stored beside it. */
export function driverNodeId(nodeId: string, parameter: string): string {
    return `driver:${nodeId}:${parameter}`;
}

export function driverTarget(id: string): { node: string; parameter: string } | undefined {
    if (!id.startsWith('driver:')) {
        return undefined;
    }

    // A node id may itself contain colons — plugin ids do, as `Family:mode#0` — so the parameter is
    // taken from the end and the node id is whatever remains.
    const rest = id.slice('driver:'.length);
    const split = rest.lastIndexOf(':');

    return split < 0
        ? undefined
        : { node: rest.slice(0, split), parameter: rest.slice(split + 1) };
}

export type EditorEdgeKind =
    /** A declared edge between two plugin ports. */
    | 'data'
    /** A declared edge reading the source's previous frame. */
    | 'feedback'
    /** A host texture bound to a plugin input. */
    | 'asset'
    /** An unconsumed colour output reaching the compositor. Implicit: in no edge list. */
    | 'layer'
    /** A motion-typed resource reaching the motion sum. Implicit: read whether or not consumed. */
    | 'motion'
    /** Between two kernel stages. Fixed, and the same for every scene. */
    | 'kernel'
    /** A feature or a constant driving a promoted parameter. */
    | 'parameter';

export interface EditorPort {
    name: string;
    /** The kernel's own ports carry no graph type. */
    type?: PortType;
    required: boolean;
    multiple?: boolean;
    connected: boolean;
    /** A promoted parameter's socket, which takes a value rather than a resource. */
    parameter?: string;
}

export interface EditorParameterRow {
    name: string;
    /** The value the document states, or the plugin's default. */
    value: number;
    /** The value the running instance holds this moment, when the kernel has reported one. */
    live?: number;
    /** What drives it. A parameter with a binding is not a constant, and the editor must not pretend. */
    binding?: ParameterBinding;
}

export interface EditorNode {
    id: string;
    kind: EditorNodeKind;
    title: string;
    subtitle: string;
    category?: PluginCategory;
    position: { x: number; y: number };
    inputs: EditorPort[];
    /** Every compatible kernel-stage input, including ones excluded by explicit membership. */
    availableInputs?: EditorPort[];
    outputs: EditorPort[];
    parameters: EditorParameterRow[];
    /** Non-numeric facts about the node, shown as rows beneath its parameters. */
    details?: { label: string; value: string }[];
    /** The resource to show when this node is inspected. Absent means it cannot be shown alone. */
    inspect?: ResourceId;
    muted?: boolean;
    problems: string[];
}

export interface EditorEdge {
    id: string;
    kind: EditorEdgeKind;
    from: { node: string; port: string };
    to: { node: string; port: string };
    type?: PortType;
}

export interface EditorView {
    nodes: EditorNode[];
    edges: EditorEdge[];
}

export interface EditorViewInput {
    document: AuthoredScene;
    registry: PluginRegistry;
    /** The compiled graph, when the document resolved. Its layer and motion inputs are then derived. */
    graph?: CompiledGraph;
    /** Live resolved parameter values by node id, as the kernel last reported them. */
    live?: Readonly<Record<string, Readonly<Record<string, number>>>>;
    problems?: readonly AuthoredProblem[];
}

const KERNEL_COLUMN_GAP = 320;
const KERNEL_ROW_GAP = 190;
const ASSET_OFFSET = 320;

/** Everything the canvas draws, in one pass over the document and its compiled graph. */
export function buildEditorView(input: EditorViewInput): EditorView {
    const { document, registry, graph, live, problems = [] } = input;

    const nodes: EditorNode[] = [];
    const edges: EditorEdge[] = [];

    const problemsFor = (nodeId: string): string[] => problems
        .filter((problem) => problem.nodeId === nodeId)
        .map((problem) => problem.detail);

    const connectedInputs = new Set([
        ...document.edges.map((edge) => `${edge.to.node}.${edge.to.port}`),
        ...document.assetBindings.map((binding) => `${binding.node}.${binding.port}`),
    ]);
    const connectedOutputs = new Set(
        document.edges.map((edge) => `${edge.from.node}.${edge.from.port}`),
    );

    for (const node of document.nodes) {
        const definition = registry.get(node.pluginId);

        if (!definition) {
            // Kept on the canvas rather than dropped. A document naming a plugin that is gone should
            // show a hole where it was, not quietly close over it.
            nodes.push({
                id: node.id,
                kind: 'plugin',
                title: node.pluginId,
                subtitle: 'not registered',
                position: node.position,
                inputs: [],
                outputs: [],
                parameters: [],
                muted: node.muted,
                problems: [`no plugin named ${node.pluginId} is registered`, ...problemsFor(node.id)],
            });
            continue;
        }

        const bindings = node.bindings ?? definition.defaultBindings ?? [];
        const values = { ...(definition.parameters ?? {}), ...(node.parameters ?? {}) };
        const promoted = (node.promoted ?? []).filter((name) => values[name] !== undefined);

        nodes.push({
            id: node.id,
            kind: 'plugin',
            title: definition.id,
            subtitle: definition.category,
            category: definition.category,
            position: node.position,
            inputs: [
                ...definition.inputs.map((port) => ({
                    name: port.name,
                    type: port.type,
                    required: port.required,
                    multiple: port.multiple,
                    connected: connectedInputs.has(`${node.id}.${port.name}`),
                })),
                // A promoted parameter is a socket at the end of the column, exactly where a widget
                // converted to an input lands in ComfyUI.
                ...promoted.map((name) => ({
                    name: parameterPortFor(name),
                    required: false,
                    connected: true,
                    parameter: name,
                })),
            ],
            outputs: definition.outputs
                // An internal output exists only to close a loop inside its own plugin and is offered
                // to nobody, so drawing it as a socket would invite a connection that cannot be made.
                .filter((port) => !port.internal)
                .map((port) => ({
                    name: port.name,
                    type: port.type,
                    required: false,
                    connected: connectedOutputs.has(`${node.id}.${port.name}`),
                })),
            // A promoted parameter has left the rows for the sockets; showing it in both places
            // would be two controls for one value.
            parameters: Object.keys(values).sort()
                .filter((name) => !promoted.includes(name))
                .map((name) => ({
                    name,
                    value: values[name],
                    ...(live?.[node.id]?.[name] !== undefined ? { live: live[node.id][name] } : {}),
                    ...(bindings.find((binding) => binding.parameter === name)
                        ? { binding: bindings.find((binding) => binding.parameter === name) }
                        : {}),
                })),
            inspect: firstColourOutput(definition.outputs)
                ? `${node.id}.${firstColourOutput(definition.outputs)}`
                : undefined,
            muted: node.muted,
            problems: problemsFor(node.id),
        });
    }

    for (const edge of document.edges) {
        edges.push({
            id: edge.id,
            kind: edge.feedback ? 'feedback' : 'data',
            from: { node: edge.from.node, port: edge.from.port },
            to: { node: edge.to.node, port: edge.to.port },
            type: portTypeOf(document, registry, edge.from.node, edge.from.port),
        });
    }

    edges.push(...driverNodesAndEdges(document, registry, nodes, live));

    edges.push(...assetNodesAndEdges(document, nodes));

    // These stages exist independently of whether the plugin graph currently compiles. Keeping the
    // fixed tail visible is especially important while editing: removing one required input should
    // expose the broken connection, not make Composite through Canvas look deleted as collateral.
    appendKernelTail(nodes, edges, graph, document);

    return { nodes, edges };
}

const DRIVER_OFFSET_X = 300;
const DRIVER_ROW_HEIGHT = 96;

/**
 * A node per promoted parameter: the feature driving it, or the constant it sits at.
 *
 * The binding is not stored beside the parameter — it is the parameter's driver — so these are
 * derived rather than declared, and moving one means rebinding rather than moving a node. Placed left
 * of the node they feed, stacked so several promotions on one node do not overlap.
 */
function driverNodesAndEdges(
    document: AuthoredScene,
    registry: PluginRegistry,
    nodes: EditorNode[],
    live: EditorViewInput['live'],
): EditorEdge[] {
    const edges: EditorEdge[] = [];

    for (const node of document.nodes) {
        const definition = registry.get(node.pluginId);
        const promoted = node.promoted ?? [];
        if (!definition || promoted.length === 0) {
            continue;
        }

        const bindings = node.bindings ?? definition.defaultBindings ?? [];
        const values = { ...(definition.parameters ?? {}), ...(node.parameters ?? {}) };

        promoted.forEach((parameter, index) => {
            if (values[parameter] === undefined) {
                return;
            }

            const binding = bindings.find((entry) => entry.parameter === parameter);
            const id = driverNodeId(node.id, parameter);
            const position = {
                x: node.position.x - DRIVER_OFFSET_X,
                y: node.position.y + index * DRIVER_ROW_HEIGHT,
            };

            nodes.push(binding
                ? {
                    id,
                    kind: 'feature',
                    title: binding.feature,
                    subtitle: binding.mode ?? 'value',
                    position,
                    inputs: [],
                    outputs: [{ name: 'value', required: false, connected: true }],
                    parameters: [
                        { name: 'attack', value: binding.attack },
                        { name: 'release', value: binding.release },
                    ],
                    details: [
                        { label: 'range', value: `${binding.outputRange[0]} … ${binding.outputRange[1]}` },
                        { label: 'curve', value: binding.curve },
                        ...(binding.role ? [{ label: 'role', value: binding.role }] : []),
                        ...(binding.polarity === -1 ? [{ label: 'polarity', value: 'inverted' }] : []),
                        { label: 'drives', value: `${node.id}.${parameter}` },
                    ],
                    problems: [],
                }
                : {
                    id,
                    kind: 'constant',
                    title: parameter,
                    subtitle: 'constant',
                    position,
                    inputs: [],
                    outputs: [{ name: 'value', required: false, connected: true }],
                    parameters: [{
                        name: parameter,
                        value: values[parameter],
                        ...(live?.[node.id]?.[parameter] !== undefined
                            ? { live: live[node.id][parameter] }
                            : {}),
                    }],
                    details: [{ label: 'drives', value: `${node.id}.${parameter}` }],
                    problems: [],
                });

            edges.push({
                id: `parameter:${node.id}:${parameter}`,
                kind: 'parameter',
                from: { node: id, port: 'value' },
                to: { node: node.id, port: parameterPortFor(parameter) },
            });
        });
    }

    return edges;
}

/** One node per distinct host texture, placed left of whatever first consumes it. */
function assetNodesAndEdges(document: AuthoredScene, nodes: EditorNode[]): EditorEdge[] {
    const edges: EditorEdge[] = [];
    const placed = new Set<string>();

    for (const binding of document.assetBindings) {
        const consumer = nodes.find((node) => node.id === binding.node);

        if (!placed.has(binding.resource)) {
            placed.add(binding.resource);
            nodes.push({
                id: binding.resource,
                kind: 'asset',
                title: binding.resource.replace(/^asset:/, ''),
                subtitle: 'asset',
                position: {
                    x: (consumer?.position.x ?? ASSET_OFFSET) - ASSET_OFFSET,
                    y: consumer?.position.y ?? 0,
                },
                inputs: [],
                outputs: [{ name: 'texture', required: false, connected: true }],
                parameters: [],
                inspect: binding.resource,
                problems: [],
            });
        }

        edges.push({
            id: `${binding.resource}->${binding.node}.${binding.port}`,
            kind: 'asset',
            from: { node: binding.resource, port: 'texture' },
            to: { node: binding.node, port: binding.port },
        });
    }

    return edges;
}

/**
 * The stages between the graph and the canvas, and the two implicit buses feeding them.
 *
 * Placed to the right of everything in the document, in the order they run.
 */
function appendKernelTail(
    nodes: EditorNode[],
    edges: EditorEdge[],
    graph: CompiledGraph | undefined,
    document: AuthoredScene,
): void {
    const rightmost = nodes.reduce((widest, node) => Math.max(widest, node.position.x), 0);
    const column = (index: number) => rightmost + KERNEL_COLUMN_GAP * (index + 1);

    const availableLayers = graph ? layersForGraph(graph) : [];
    const layers = selectKernelInputs(availableLayers, document.kernel?.compositeInputs);
    const kernel = document.kernel;

    nodes.push({
        id: PALETTE_NODE,
        kind: 'kernel',
        title: 'Palette',
        subtitle: kernel?.palette?.id ?? 'theme / entropy',
        position: { x: column(0), y: -KERNEL_ROW_GAP },
        inputs: [],
        outputs: [{ name: 'palette', type: 'palette', required: false, connected: true }],
        parameters: [pinnedRow('strength', kernel?.palette?.strength)],
        details: [{
            label: 'selection',
            value: kernel?.palette?.id ?? 'automatic',
        }],
        problems: [],
    });

    nodes.push({
        id: COMPOSITE_NODE,
        kind: 'kernel',
        title: 'Composite',
        subtitle: graph
            ? `${layers.length} layer${layers.length === 1 ? '' : 's'}`
            : 'layers unresolved',
        position: { x: column(0), y: 0 },
        inputs: [
            { name: 'palette', type: 'palette', required: true, connected: true },
            ...layers.map((layer) => ({
                name: layer.id,
                required: false,
                connected: true,
            })),
        ],
        availableInputs: availableLayers.map((layer) => ({
            name: layer.id,
            required: false,
            connected: layers.some((selected) => selected.id === layer.id),
        })),
        outputs: [{ name: 'composite', required: false, connected: true }],
        // Blend mode and opacity are per layer rather than per stage, so they are shown on the edges
        // rather than here; what this node states is the stack's size and order.
        parameters: [],
        inspect: COMPOSITE_NODE,
        problems: [],
    });

    // A `Motion sum` kernel node stood here, listing every motion-typed resource the graph produced.
    // The kernel neither sums a motion field nor drags anything through one (ADR-0012), so drawing a
    // stage for it would be drawing something that does not run. Where a field reaches the picture is
    // now an ordinary edge to an ordinary node, which the canvas already shows.

    const gradeValues = { ...COMPOSITE_PARAMETERS, ...(kernel?.grade?.parameters ?? {}) };
    const gradeBindings = kernel?.grade?.bindings ?? COMPOSITE_BINDINGS;
    nodes.push({
        id: GRADE_NODE,
        kind: 'kernel',
        title: 'Grade',
        subtitle: 'exposure, contrast, saturation',
        position: { x: column(2), y: 0 },
        inputs: [{ name: 'accumulation', required: true, connected: true }],
        outputs: [{ name: 'canvas', required: false, connected: true }],
        parameters: Object.keys(gradeValues).sort().map((name) => ({
            name,
            value: gradeValues[name],
            ...(gradeBindings.find((binding) => binding.parameter === name)
                ? { binding: gradeBindings.find((binding) => binding.parameter === name) }
                : {}),
        })),
        // The graded image is the canvas, so there is nothing separate to inspect: clearing the
        // inspection shows exactly this.
        problems: [],
    });

    nodes.push({
        id: CANVAS_NODE,
        kind: 'kernel',
        title: 'Canvas',
        subtitle: 'what you see',
        position: { x: column(3), y: 0 },
        inputs: [{ name: 'image', required: true, connected: true }],
        outputs: [],
        parameters: [],
        problems: [],
    });

    if (graph) {
        for (const layer of layers) {
            edges.push({
                id: `layer:${layer.id}`,
                kind: 'layer',
                from: {
                    node: producerOf(layer.color, graph) ?? layer.id,
                    port: portOf(layer.color, graph) ?? 'color',
                },
                to: { node: COMPOSITE_NODE, port: layer.id },
                type: 'color-texture',
            });
        }

    }

    edges.push(
        {
            id: 'kernel:palette-composite',
            kind: 'kernel',
            from: { node: PALETTE_NODE, port: 'palette' },
            to: { node: COMPOSITE_NODE, port: 'palette' },
            type: 'palette',
        },
        {
            id: 'kernel:composite-grade',
            kind: 'kernel',
            from: { node: COMPOSITE_NODE, port: 'composite' },
            to: { node: GRADE_NODE, port: 'accumulation' },
        },
        {
            id: 'kernel:grade-canvas',
            kind: 'kernel',
            from: { node: GRADE_NODE, port: 'canvas' },
            to: { node: CANVAS_NODE, port: 'image' },
        },
    );
}

/**
 * A tail parameter's row.
 *
 * A value the document has not pinned is decided per frame from the theme, the layer stack and three
 * audio channels, so it has no constant to show — `NaN` would be a lie and zero would be a worse one.
 * The row exists either way, because a control that only appears once it is used is a control nobody
 * finds.
 */
function pinnedRow(name: string, pinned: number | undefined): EditorParameterRow {
    return { name, value: pinned ?? Number.NaN };
}

export function isPinned(row: EditorParameterRow): boolean {
    return Number.isFinite(row.value);
}

function firstColourOutput(outputs: readonly { name: string; type: PortType; internal?: boolean }[]) {
    return outputs.find((port) => port.type === 'color-texture' && !port.internal)?.name;
}

function producerOf(resource: ResourceId | undefined, graph: CompiledGraph): string | undefined {
    return graph.resources.find((candidate) => candidate.id === resource)?.producedBy;
}

function portOf(resource: ResourceId | undefined, graph: CompiledGraph): string | undefined {
    return graph.resources.find((candidate) => candidate.id === resource)?.port;
}

function portTypeOf(
    document: AuthoredScene,
    registry: PluginRegistry,
    nodeId: string,
    port: string,
): PortType | undefined {
    const node = document.nodes.find((candidate) => candidate.id === nodeId);
    const definition = node && registry.get(node.pluginId);

    return definition?.outputs.find((candidate) => candidate.name === port)?.type;
}
