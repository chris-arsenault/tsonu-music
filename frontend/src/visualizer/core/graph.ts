/**
 * The typed render graph (spec section 10).
 *
 * Compiles an active plugin set plus edges into an execution order with resource assignments. Invalid
 * connections are rejected here rather than surfacing as a blank screen or a GL error.
 *
 * Feedback is legal but must be declared. An undeclared cycle is a bug; a declared one reads the
 * previous frame's content, which is what makes recursive pipelines terminate.
 */

import type { PluginPort, PortType, VisualPluginDefinition } from './plugin';
import type { ResourceId } from './passes';

export interface GraphNode {
    instanceId: string;
    definition: VisualPluginDefinition;
}

export interface RenderGraphEdge {
    from: { instanceId: string; port: string };
    to: { instanceId: string; port: string };
    /** A feedback edge reads the source's previous frame, so it may close a cycle. */
    feedback?: boolean;
}

export interface CompiledNode {
    instanceId: string;
    definition: VisualPluginDefinition;
    /** Input port name to the resource feeding it. */
    inputs: Record<string, ResourceId>;
    /** Output port name to the resource it writes. */
    outputs: Record<string, ResourceId>;
    /** Input port name to the previous-frame resource, for declared feedback reads. */
    previous: Record<string, ResourceId>;
}

export interface CompiledGraph {
    /** Execution order. Feedback edges are excluded from ordering. */
    order: CompiledNode[];
    /** Every resource the graph allocates. */
    resources: ResourceDescriptor[];
    /** Resources needing a second buffer because something reads their previous frame. */
    pingPong: ResourceId[];
    /** The resource presented to the canvas. */
    present: ResourceId | undefined;
}

export interface ResourceDescriptor {
    id: ResourceId;
    type: PortType;
    producedBy: string;
    port: string;
}

export type CompileResult =
    | { ok: true; graph: CompiledGraph }
    | { ok: false; errors: string[] };

/**
 * Types that may be substituted for one another. A distance field is a single-channel texture, so a
 * consumer wanting a mask can read one; the reverse is not true, because a mask carries no distance.
 */
const COMPATIBLE_INPUTS: Partial<Record<PortType, readonly PortType[]>> = {
    'mask-texture': ['distance-field'],
    // A collision field carries a vector in rg plus boundary proximity in b. Consumers that only need
    // a vector can use it, while collision-aware consumers can require the richer type explicitly.
    'vector-field': ['collision-field'],
    'color-texture': [],
};

export function portsCompatible(output: PortType, input: PortType): boolean {
    if (output === input) {
        return true;
    }

    return (COMPATIBLE_INPUTS[input] ?? []).includes(output);
}

export function resourceIdFor(instanceId: string, port: string): ResourceId {
    return `${instanceId}.${port}`;
}

export function compileGraph(
    nodes: readonly GraphNode[],
    edges: readonly RenderGraphEdge[],
    presentFrom?: { instanceId: string; port: string },
    /**
     * Inputs fed by host-supplied asset textures. Passed separately from edges because an asset is not
     * a node, so it takes no place in execution order — but it does satisfy a required input.
     */
    assetBindings: readonly { instanceId: string; port: string; resource: ResourceId }[] = [],
): CompileResult {
    const errors: string[] = [];
    const byInstance = new Map<string, GraphNode>();

    for (const node of nodes) {
        if (byInstance.has(node.instanceId)) {
            errors.push(`duplicate instance ${node.instanceId}`);
        }
        byInstance.set(node.instanceId, node);
    }

    const resources: ResourceDescriptor[] = [];
    for (const node of nodes) {
        for (const port of node.definition.outputs) {
            resources.push({
                id: resourceIdFor(node.instanceId, port.name),
                type: port.type,
                producedBy: node.instanceId,
                port: port.name,
            });
        }
    }

    errors.push(...validateEdges(byInstance, edges));
    if (errors.length > 0) {
        return { ok: false, errors };
    }

    errors.push(...validateRequiredInputs(nodes, edges, assetBindings));

    const forward = edges.filter((edge) => !edge.feedback);
    const ordered = topologicalOrder(nodes, forward);
    if (!ordered) {
        errors.push('graph contains an undeclared cycle; mark the closing edge as feedback');
    }

    if (errors.length > 0 || !ordered) {
        return { ok: false, errors };
    }

    const pingPong = [
        ...new Set(
            edges
                .filter((edge) => edge.feedback)
                .map((edge) => resourceIdFor(edge.from.instanceId, edge.from.port)),
        ),
    ];

    const compiled = ordered.map((node): CompiledNode => {
        const inputs: Record<string, ResourceId> = {};
        const previous: Record<string, ResourceId> = {};

        for (const binding of assetBindings) {
            if (binding.instanceId === node.instanceId) {
                inputs[binding.port] = binding.resource;
            }
        }

        for (const edge of edges) {
            if (edge.to.instanceId !== node.instanceId) {
                continue;
            }

            const resource = resourceIdFor(edge.from.instanceId, edge.from.port);
            if (edge.feedback) {
                previous[edge.to.port] = resource;
            } else {
                inputs[edge.to.port] = resource;
            }
        }

        const outputs: Record<string, ResourceId> = {};
        for (const port of node.definition.outputs) {
            outputs[port.name] = resourceIdFor(node.instanceId, port.name);
        }

        return { instanceId: node.instanceId, definition: node.definition, inputs, outputs, previous };
    });

    const present = resolvePresent(compiled, presentFrom);
    if (presentFrom && !present) {
        return { ok: false, errors: [`present target ${presentFrom.instanceId}.${presentFrom.port} does not exist`] };
    }

    return { ok: true, graph: { order: compiled, resources, pingPong, present } };
}

function validateEdges(
    byInstance: Map<string, GraphNode>,
    edges: readonly RenderGraphEdge[],
): string[] {
    const errors: string[] = [];
    const occupied = new Map<string, number>();

    for (const edge of edges) {
        const source = byInstance.get(edge.from.instanceId);
        const target = byInstance.get(edge.to.instanceId);

        if (!source) {
            errors.push(`edge from unknown instance ${edge.from.instanceId}`);
            continue;
        }
        if (!target) {
            errors.push(`edge to unknown instance ${edge.to.instanceId}`);
            continue;
        }

        const outputPort = findPort(source.definition.outputs, edge.from.port);
        const inputPort = findPort(target.definition.inputs, edge.to.port);

        if (!outputPort) {
            errors.push(`${edge.from.instanceId} has no output port ${edge.from.port}`);
            continue;
        }
        if (!inputPort) {
            errors.push(`${edge.to.instanceId} has no input port ${edge.to.port}`);
            continue;
        }

        if (!portsCompatible(outputPort.type, inputPort.type)) {
            errors.push(
                `cannot connect ${edge.from.instanceId}.${edge.from.port} (${outputPort.type}) ` +
                `to ${edge.to.instanceId}.${edge.to.port} (${inputPort.type})`,
            );
            continue;
        }

        const key = `${edge.to.instanceId}.${edge.to.port}`;
        const count = (occupied.get(key) ?? 0) + 1;
        occupied.set(key, count);

        if (count > 1 && !inputPort.multiple) {
            errors.push(`${key} accepts one connection but received ${count}`);
        }
    }

    return errors;
}

function validateRequiredInputs(
    nodes: readonly GraphNode[],
    edges: readonly RenderGraphEdge[],
    assetBindings: readonly { instanceId: string; port: string }[],
): string[] {
    const errors: string[] = [];
    const connected = new Set([
        ...edges.map((edge) => `${edge.to.instanceId}.${edge.to.port}`),
        ...assetBindings.map((binding) => `${binding.instanceId}.${binding.port}`),
    ]);

    for (const node of nodes) {
        for (const port of node.definition.inputs) {
            if (port.required && !connected.has(`${node.instanceId}.${port.name}`)) {
                errors.push(`${node.instanceId}.${port.name} is required but unconnected`);
            }
        }
    }

    return errors;
}

/** Kahn's algorithm. Returns undefined when a cycle remains among forward edges. */
function topologicalOrder(
    nodes: readonly GraphNode[],
    forward: readonly RenderGraphEdge[],
): GraphNode[] | undefined {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const node of nodes) {
        indegree.set(node.instanceId, 0);
        dependents.set(node.instanceId, []);
    }

    for (const edge of forward) {
        indegree.set(edge.to.instanceId, (indegree.get(edge.to.instanceId) ?? 0) + 1);
        dependents.get(edge.from.instanceId)?.push(edge.to.instanceId);
    }

    // Starts in declaration order so the active graph keeps a stable execution order.
    const ready = nodes.filter((node) => indegree.get(node.instanceId) === 0).map((node) => node.instanceId);
    const order: GraphNode[] = [];
    const byInstance = new Map(nodes.map((node) => [node.instanceId, node]));

    while (ready.length > 0) {
        const instanceId = ready.shift()!;
        const node = byInstance.get(instanceId);
        if (node) {
            order.push(node);
        }

        for (const dependent of dependents.get(instanceId) ?? []) {
            const remaining = (indegree.get(dependent) ?? 0) - 1;
            indegree.set(dependent, remaining);
            if (remaining === 0) {
                ready.push(dependent);
            }
        }
    }

    return order.length === nodes.length ? order : undefined;
}

function resolvePresent(
    compiled: readonly CompiledNode[],
    presentFrom?: { instanceId: string; port: string },
): ResourceId | undefined {
    if (presentFrom) {
        const node = compiled.find((candidate) => candidate.instanceId === presentFrom.instanceId);
        return node?.outputs[presentFrom.port];
    }

    // Default: the last node's first colour output, which for a well-formed scene is the final stage.
    for (let index = compiled.length - 1; index >= 0; index -= 1) {
        const node = compiled[index];
        const colour = node.definition.outputs.find((port) => port.type === 'color-texture');
        if (colour) {
            return node.outputs[colour.name];
        }
    }

    return undefined;
}

function findPort(ports: readonly PluginPort[], name: string): PluginPort | undefined {
    return ports.find((port) => port.name === name);
}
