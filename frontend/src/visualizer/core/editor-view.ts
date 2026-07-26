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
import type { CompiledGraph } from './graph';
import { layersForGraph } from './layers';
import { isMotionSource } from './persistence';
import type { PluginCategory, PluginRegistry, PortType } from './plugin';
import type { ResourceId } from './passes';

/** The kernel's own stages, in the order they run. Ids match the runtime's target keys. */
export const COMPOSITE_NODE = 'kernel:composite';
export const MOTION_NODE = 'kernel:motion';
export const ACCUMULATE_NODE = 'kernel:accumulate';
export const GRADE_NODE = 'kernel:grade';
export const CANVAS_NODE = 'kernel:canvas';

export type EditorNodeKind = 'plugin' | 'asset' | 'kernel';

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
    | 'kernel';

export interface EditorPort {
    name: string;
    /** The kernel's own ports carry no graph type. */
    type?: PortType;
    required: boolean;
    multiple?: boolean;
    connected: boolean;
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
    outputs: EditorPort[];
    parameters: EditorParameterRow[];
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
    /** The compiled graph, when the document resolved. Without it the tail cannot be derived. */
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

        nodes.push({
            id: node.id,
            kind: 'plugin',
            title: definition.id,
            subtitle: definition.category,
            category: definition.category,
            position: node.position,
            inputs: definition.inputs.map((port) => ({
                name: port.name,
                type: port.type,
                required: port.required,
                multiple: port.multiple,
                connected: connectedInputs.has(`${node.id}.${port.name}`),
            })),
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
            parameters: Object.keys(values).sort().map((name) => ({
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

    edges.push(...assetNodesAndEdges(document, nodes));

    if (graph) {
        appendKernelTail(nodes, edges, graph, document);
    }

    return { nodes, edges };
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
    graph: CompiledGraph,
    document: AuthoredScene,
): void {
    const rightmost = nodes.reduce((widest, node) => Math.max(widest, node.position.x), 0);
    const column = (index: number) => rightmost + KERNEL_COLUMN_GAP * (index + 1);

    const layers = layersForGraph(graph);
    const motion = graph.resources.filter((resource) => isMotionSource(resource.type));
    const kernel = document.kernel;

    nodes.push({
        id: COMPOSITE_NODE,
        kind: 'kernel',
        title: 'Composite',
        subtitle: `${layers.length} layer${layers.length === 1 ? '' : 's'}`,
        position: { x: column(0), y: 0 },
        inputs: layers.map((layer) => ({
            name: layer.id,
            required: false,
            connected: true,
        })),
        outputs: [{ name: 'composite', required: false, connected: true }],
        // Blend mode and opacity are per layer rather than per stage, so they are shown on the edges
        // rather than here; what this node states is the stack's size and order.
        parameters: [],
        inspect: COMPOSITE_NODE,
        problems: [],
    });

    nodes.push({
        id: MOTION_NODE,
        kind: 'kernel',
        title: 'Motion sum',
        subtitle: motion.length === 0
            ? 'no field — the image is not dragged'
            : `${motion.length} field${motion.length === 1 ? '' : 's'}`,
        position: { x: column(0), y: KERNEL_ROW_GAP },
        inputs: motion.map((resource) => ({
            name: resource.id,
            type: resource.type,
            required: false,
            connected: true,
        })),
        outputs: [{ name: 'motion', required: false, connected: motion.length > 0 }],
        parameters: [],
        inspect: MOTION_NODE,
        problems: [],
    });

    nodes.push({
        id: ACCUMULATE_NODE,
        kind: 'kernel',
        title: 'Accumulate',
        subtitle: 'survival, drag, punch',
        position: { x: column(1), y: 0 },
        inputs: [
            { name: 'composite', required: true, connected: true },
            { name: 'motion', required: false, connected: motion.length > 0 },
        ],
        outputs: [{ name: 'accumulation', required: false, connected: true }],
        parameters: [
            pinnedRow('survivalPerSecond', kernel?.persistence?.survivalPerSecond),
            pinnedRow('motionScale', kernel?.persistence?.motionScale),
            pinnedRow('transientPunch', kernel?.persistence?.transientPunch),
        ],
        inspect: ACCUMULATE_NODE,
        problems: [],
    });

    const gradeValues = kernel?.grade?.parameters ?? {};
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
            ...(kernel?.grade?.bindings?.find((binding) => binding.parameter === name)
                ? { binding: kernel.grade.bindings.find((binding) => binding.parameter === name) }
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

    for (const layer of layers) {
        edges.push({
            id: `layer:${layer.id}`,
            kind: 'layer',
            from: { node: producerOf(layer.color, graph) ?? layer.id, port: portOf(layer.color, graph) ?? 'color' },
            to: { node: COMPOSITE_NODE, port: layer.id },
            type: 'color-texture',
        });
    }

    for (const resource of motion) {
        edges.push({
            id: `motion:${resource.id}`,
            kind: 'motion',
            from: { node: resource.producedBy, port: resource.port },
            to: { node: MOTION_NODE, port: resource.id },
            type: resource.type,
        });
    }

    edges.push(
        {
            id: 'kernel:composite-accumulate',
            kind: 'kernel',
            from: { node: COMPOSITE_NODE, port: 'composite' },
            to: { node: ACCUMULATE_NODE, port: 'composite' },
        },
        {
            id: 'kernel:motion-accumulate',
            kind: 'kernel',
            from: { node: MOTION_NODE, port: 'motion' },
            to: { node: ACCUMULATE_NODE, port: 'motion' },
        },
        {
            id: 'kernel:accumulate-grade',
            kind: 'kernel',
            from: { node: ACCUMULATE_NODE, port: 'accumulation' },
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
