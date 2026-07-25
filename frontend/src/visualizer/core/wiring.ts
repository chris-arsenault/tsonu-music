/**
 * Automatic graph wiring.
 *
 * The scheduler decides which plugins are active; this decides how they connect. Each required input
 * takes the most recently produced compatible output, so a scene reads as a chain rather than a set of
 * disconnected nodes.
 *
 * A feedback-capable transformer is wired to read its own previous frame, which is what makes trails
 * and tunnels emerge from assembly rather than needing a hand-authored scene.
 */

import { portsCompatible, type GraphNode, type RenderGraphEdge } from './graph';
import type { PluginCategory, PluginPort, VisualPluginDefinition } from './plugin';

/** Order plugins are chained in. Matches the scheduler's fill order. */
const CHAIN_ORDER: readonly PluginCategory[] = [
    'source',
    'field',
    'simulator',
    'transformer',
    'compositor',
    'postprocess',
];

export interface WiredScene {
    nodes: GraphNode[];
    edges: RenderGraphEdge[];
    present?: { instanceId: string; port: string };
    /** Required inputs nothing could satisfy. A scene with any of these will not compile. */
    unsatisfied: { instanceId: string; port: string; type: string }[];
}

export function instanceIdFor(definition: VisualPluginDefinition, index: number): string {
    return `${definition.id}#${index}`;
}

/**
 * Wires an assembled plugin set into a graph.
 *
 * Producers are tracked as a stack per port type, so a transformer takes the freshest colour output
 * rather than the original source — which is what chains transformers instead of running them in
 * parallel off the same input.
 */
export function wireScene(plugins: readonly VisualPluginDefinition[]): WiredScene {
    const ordered = [...plugins].sort(
        (left, right) => CHAIN_ORDER.indexOf(left.category) - CHAIN_ORDER.indexOf(right.category),
    );

    const nodes: GraphNode[] = ordered.map((definition, index) => ({
        instanceId: instanceIdFor(definition, index),
        definition,
    }));

    const edges: RenderGraphEdge[] = [];
    const unsatisfied: WiredScene['unsatisfied'] = [];
    /** Most recent producer per port type, freshest last. */
    const producers = new Map<string, { instanceId: string; port: string }[]>();

    for (const node of nodes) {
        for (const port of node.definition.inputs) {
            const source = findProducer(producers, port);

            if (source) {
                edges.push({ from: source, to: { instanceId: node.instanceId, port: port.name } });
                continue;
            }

            // A feedback port with nothing upstream reads this plugin's own previous frame.
            const own = ownOutputFor(node.definition, port);
            if (own && isFeedbackPort(port)) {
                edges.push({
                    from: { instanceId: node.instanceId, port: own.name },
                    to: { instanceId: node.instanceId, port: port.name },
                    feedback: true,
                });
                continue;
            }

            if (port.required) {
                unsatisfied.push({ instanceId: node.instanceId, port: port.name, type: port.type });
            }
        }

        // Registered after its inputs, so a plugin never consumes its own forward output.
        for (const port of node.definition.outputs) {
            const existing = producers.get(port.type) ?? [];
            existing.push({ instanceId: node.instanceId, port: port.name });
            producers.set(port.type, existing);
        }

        // A feedback-capable transformer reads its own output even when an upstream source existed.
        if (declaresFeedback(node.definition)) {
            const historyPort = node.definition.inputs.find(isFeedbackPort);
            const own = historyPort && ownOutputFor(node.definition, historyPort);
            const alreadyWired = edges.some((edge) =>
                edge.feedback && edge.to.instanceId === node.instanceId);

            if (historyPort && own && !alreadyWired) {
                // Replace any forward edge into the history port; it is meant to read the past.
                const forward = edges.findIndex((edge) =>
                    edge.to.instanceId === node.instanceId && edge.to.port === historyPort.name);
                if (forward >= 0) {
                    edges.splice(forward, 1);
                }

                edges.push({
                    from: { instanceId: node.instanceId, port: own.name },
                    to: { instanceId: node.instanceId, port: historyPort.name },
                    feedback: true,
                });
            }
        }
    }

    return { nodes, edges, present: resolvePresent(nodes), unsatisfied };
}

function findProducer(
    producers: Map<string, { instanceId: string; port: string }[]>,
    port: PluginPort,
): { instanceId: string; port: string } | undefined {
    const exact = producers.get(port.type);
    if (exact && exact.length > 0) {
        return exact[exact.length - 1];
    }

    // Fall back to any type the port accepts, such as a distance field feeding a mask input.
    for (const [type, candidates] of producers) {
        if (candidates.length > 0 && portsCompatible(type as PluginPort['type'], port.type)) {
            return candidates[candidates.length - 1];
        }
    }

    return undefined;
}

function ownOutputFor(
    definition: VisualPluginDefinition,
    port: PluginPort,
): PluginPort | undefined {
    return definition.outputs.find((candidate) => portsCompatible(candidate.type, port.type));
}

/** A port named for history, which by convention is the one a feedback edge closes onto. */
function isFeedbackPort(port: PluginPort): boolean {
    return port.name === 'history' || port.name === 'feedback' || port.name === 'previous';
}

function declaresFeedback(definition: VisualPluginDefinition): boolean {
    return definition.capabilities.includes('feedback');
}

/** The last colour output in the chain, which for a well-formed scene is the final stage. */
function resolvePresent(nodes: readonly GraphNode[]): { instanceId: string; port: string } | undefined {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const colour = nodes[index].definition.outputs.find((port) => port.type === 'color-texture');
        if (colour) {
            return { instanceId: nodes[index].instanceId, port: colour.name };
        }
    }

    return undefined;
}
