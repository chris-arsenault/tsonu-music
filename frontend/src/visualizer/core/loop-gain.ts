/**
 * Whether a cycle in the graph converges (ADR-0013).
 *
 * ADR-0007 kept the accumulation bounded by owning the combine and making survival and injection
 * complements. That guarantees a fixed point and, in the same stroke, guarantees the image can never
 * hold more than one copy of its source — the weights of a convex blend sum to one however many
 * frames it runs for, so a warped loop produces a motion blur and never a tunnel.
 *
 * The condition that actually governs divergence is weaker. A cycle converges when the product of
 * the gains it passes through is below one, and at a gain of 0.95 the steady state holds twenty
 * copies of the source laid along the flow path. That is the accumulation the convex rule forbade,
 * and it is bounded by a geometric series rather than by each stage refusing to amplify.
 *
 * Checked against the largest value each gain parameter can reach, not its default: a parameter the
 * music drives to 1.05 on a peak is an unstable loop that happens to be stable at rest, which is the
 * worst version — it looks correct until the track does something.
 */

import type { GraphNode, RenderGraphEdge } from './graph';
import type { PluginPort, VisualPluginDefinition } from './plugin';

/** A cycle in the graph, with the gain a signal accumulates going once around it. */
export interface GraphCycle {
    /** Instance ids in traversal order, starting and ending at the same node. */
    path: string[];
    /** Product of the per-port gains around the cycle. Below one converges. */
    gain: number;
}

/**
 * The largest value a parameter can take once its bindings are applied.
 *
 * A binding replaces the default outright rather than modulating it, so the ceiling is the binding's
 * output range rather than anything involving the declared value. An unbound parameter can only ever
 * be its default — the scheduler may override it per instance, which `parameterOverrides` supplies
 * and this function accepts.
 */
export function parameterCeiling(
    definition: VisualPluginDefinition,
    parameter: string,
    overrides: Readonly<Record<string, number>> = {},
): number {
    const bindings = (definition.defaultBindings ?? []).filter(
        (binding) => binding.parameter === parameter,
    );

    if (bindings.length > 0) {
        return Math.max(...bindings.map((binding) => Math.max(...binding.outputRange)));
    }

    const override = overrides[parameter];
    if (override !== undefined && Number.isFinite(override)) {
        return override;
    }

    return definition.parameters?.[parameter] ?? 1;
}

/**
 * How much of an input reaches the output, at the parameter's ceiling.
 *
 * One when the port declares no gain parameter, which is the honest answer for a warp: resampling
 * moves material without diminishing it, so a loop made only of warps has unity gain and never
 * settles. Something on the cycle has to be lossy, and this is where a plugin says it is.
 */
export function portGain(
    definition: VisualPluginDefinition,
    port: PluginPort,
    overrides: Readonly<Record<string, number>> = {},
): number {
    if (!port.gainParameter) {
        return 1;
    }

    return Math.max(0, parameterCeiling(definition, port.gainParameter, overrides));
}

/**
 * Every simple cycle in the graph, with its gain.
 *
 * Feedback edges are included — they are what closes a cycle, and excluding them is how the compiler
 * gets a topological order, not a statement that the loop is absent. Johnson's algorithm would be the
 * general answer; a scene holds a dozen nodes and one or two loops, so a bounded depth-first walk from
 * each node is simpler and fast enough.
 */
export function graphCycles(
    nodes: readonly GraphNode[],
    edges: readonly RenderGraphEdge[],
    overrides: Readonly<Record<string, Record<string, number>>> = {},
): GraphCycle[] {
    const byInstance = new Map(nodes.map((node) => [node.instanceId, node]));
    const outgoing = new Map<string, RenderGraphEdge[]>();

    for (const edge of edges) {
        const list = outgoing.get(edge.from.instanceId) ?? [];
        list.push(edge);
        outgoing.set(edge.from.instanceId, list);
    }

    const cycles: GraphCycle[] = [];
    const seen = new Set<string>();

    const gainOf = (edge: RenderGraphEdge): number => {
        const sink = byInstance.get(edge.to.instanceId);
        const port = sink?.definition.inputs.find((input) => input.name === edge.to.port);

        return sink && port ? portGain(sink.definition, port, overrides[sink.instanceId] ?? {}) : 1;
    };

    // Each cycle is found once from its lowest-ordered member, so the same loop is not reported
    // three times under three rotations.
    for (const start of nodes) {
        const walk = (current: string, path: string[], gain: number): void => {
            for (const edge of outgoing.get(current) ?? []) {
                const next = edge.to.instanceId;

                if (next === start.instanceId) {
                    const members = [...path].sort();
                    const key = members.join('>');
                    if (!seen.has(key)) {
                        seen.add(key);
                        cycles.push({ path: [...path, next], gain: gain * gainOf(edge) });
                    }
                    continue;
                }

                // Only walk forward through nodes not already on this path, and never back to a node
                // ordered before the start — that cycle belongs to the earlier start.
                if (path.includes(next) || !byInstance.has(next)) {
                    continue;
                }
                if (nodes.findIndex((node) => node.instanceId === next)
                    < nodes.findIndex((node) => node.instanceId === start.instanceId)) {
                    continue;
                }

                walk(next, [...path, next], gain * gainOf(edge));
            }
        };

        walk(start.instanceId, [start.instanceId], 1);
    }

    return cycles;
}

/**
 * Cycles whose gain reaches one or more, which will grow without bound.
 *
 * The grade's roll-off means a divergent loop shows as a bright frame rather than as `NaN`, so this
 * is a correctness check rather than a crash guard. It is also the reason the four local bounds could
 * be removed: one structural condition, checked where scenes are assembled, replaces a rule that every
 * stage individually refuse to amplify.
 */
export function divergentCycles(
    nodes: readonly GraphNode[],
    edges: readonly RenderGraphEdge[],
    overrides: Readonly<Record<string, Record<string, number>>> = {},
): GraphCycle[] {
    return graphCycles(nodes, edges, overrides).filter((cycle) => cycle.gain >= 1);
}
