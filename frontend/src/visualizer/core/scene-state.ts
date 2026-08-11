/** Pure validation for the one graph-owned recursive image state. */

import type { CompileProblem, GraphNode, RenderGraphEdge } from './graph';
import { DERIVED_STATE } from './grammar';
import { isImagePortType } from './plugin';

export interface CompiledSceneState {
    combineInstanceId: string;
    warpInstanceId: string;
    stateResource: string;
    materialRoots: string[];
}

export interface SceneStateAnalysis {
    problems: CompileProblem[];
    state?: CompiledSceneState;
}

function edgeCarriesImage(nodes: readonly GraphNode[], edge: RenderGraphEdge): boolean {
    const sink = nodes.find((node) => node.instanceId === edge.to.instanceId);
    const port = sink?.definition.inputs.find((input) => input.name === edge.to.port);
    return port !== undefined && isImagePortType(port.type);
}

function reachable(
    start: string,
    target: string,
    edges: readonly RenderGraphEdge[],
): boolean {
    const outgoing = new Map<string, string[]>();
    for (const edge of edges.filter((candidate) => !candidate.feedback)) {
        const entries = outgoing.get(edge.from.instanceId) ?? [];
        entries.push(edge.to.instanceId);
        outgoing.set(edge.from.instanceId, entries);
    }

    const queue = [start];
    const seen = new Set(queue);
    while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === target) {
            return true;
        }
        for (const next of outgoing.get(current) ?? []) {
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }

    return false;
}

function ancestorsOf(
    target: string,
    edges: readonly RenderGraphEdge[],
): Set<string> {
    const incoming = new Map<string, string[]>();
    for (const edge of edges.filter((candidate) => !candidate.feedback)) {
        const entries = incoming.get(edge.to.instanceId) ?? [];
        entries.push(edge.from.instanceId);
        incoming.set(edge.to.instanceId, entries);
    }

    const ancestors = new Set<string>([target]);
    const queue = [target];
    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const previous of incoming.get(current) ?? []) {
            if (!ancestors.has(previous)) {
                ancestors.add(previous);
                queue.push(previous);
            }
        }
    }

    return ancestors;
}

/**
 * Validates the canonical form rather than accepting any graph containing a historical label.
 *
 * Exactly one combine owns the displayed state. Its output is read on the previous frame by a
 * spatial warp, that warp reaches the combine's history input, and all fresh material reaches the
 * combine's source input. This is the property the former edge-count checks approximated.
 */
export function analyzeSceneState(
    nodes: readonly GraphNode[],
    edges: readonly RenderGraphEdge[],
    present?: { instanceId: string; port: string },
): SceneStateAnalysis {
    if (nodes.length === 0) {
        return { problems: [] };
    }

    const problems: CompileProblem[] = [];
    const combines = nodes.filter((node) => node.definition.temporalCombine !== undefined);
    if (combines.length !== 1) {
        problems.push({ detail: `scene requires exactly one temporal combine; found ${combines.length}` });
        return { problems };
    }

    const combine = combines[0];
    const contract = combine.definition.temporalCombine!;
    const stateResource = `${combine.instanceId}.${contract.output}`;
    // Presentation and memory may be different outputs of the combine: the state stays the
    // previous-frame read, the display carries fresh material at full weight (ADR-0017).
    const presentPort = contract.displayOutput ?? contract.output;

    if (!present || present.instanceId !== combine.instanceId || present.port !== presentPort) {
        problems.push({
            detail: `scene must present ${combine.instanceId}.${presentPort}`,
            instanceId: combine.instanceId,
            port: presentPort,
        });
    }

    const sourceEdge = edges.find((edge) =>
        !edge.feedback
        && edge.to.instanceId === combine.instanceId
        && edge.to.port === contract.sourceInput);
    const historyEdge = edges.find((edge) =>
        !edge.feedback
        && edge.to.instanceId === combine.instanceId
        && edge.to.port === contract.historyInput);

    if (!sourceEdge) {
        problems.push({
            detail: 'temporal combine has no fresh-material input',
            instanceId: combine.instanceId,
            port: contract.sourceInput,
        });
    }
    if (!historyEdge) {
        problems.push({
            detail: 'temporal combine has no transformed-history input',
            instanceId: combine.instanceId,
            port: contract.historyInput,
        });
    }

    // Exactly one loop reads the *state* — the combine's previous output entering the warp. Other
    // previous-frame image edges are material memory: a stage trailing itself, the composed image
    // folding back through a lossy port (ADR-0016). Requiring the state edge to be the only one
    // is what made every scene's upstream a fresh redraw; the canonical form constrains the
    // state, not the material. What bounds the material loops is arithmetic: `compileSceneGraph`
    // rejects any image cycle whose gain reaches one.
    const previousImages = edges.filter((edge) => edge.feedback && edgeCarriesImage(nodes, edge));
    const canonical = previousImages.filter((edge) =>
        edge.from.instanceId === combine.instanceId && edge.from.port === contract.output);
    if (canonical.length !== 1) {
        problems.push({ detail: `scene requires exactly one previous-frame read of the combine output; found ${canonical.length}` });
        return { problems };
    }

    const previous = canonical[0];

    const warp = nodes.find((node) => node.instanceId === previous.to.instanceId);
    if (!warp?.definition.capabilities.includes('scene-history-warp')) {
        problems.push({
            detail: 'previous-frame image must enter the scene history warp',
            edge: { from: previous.from, to: previous.to },
        });
    }

    if (historyEdge && !reachable(previous.to.instanceId, historyEdge.from.instanceId, edges)) {
        problems.push({
            detail: 'previous-frame image does not return through the history input',
            edge: { from: previous.from, to: previous.to },
        });
    }

    const freshAncestors = sourceEdge ? ancestorsOf(sourceEdge.from.instanceId, edges) : new Set<string>();
    const forwardImageSources = new Set(
        edges
            .filter((edge) => {
                const sink = nodes.find((node) => node.instanceId === edge.to.instanceId);
                return !edge.feedback
                    && edgeCarriesImage(nodes, edge)
                    && !sink?.definition.capabilities.includes(DERIVED_STATE);
            })
            .map((edge) => edge.from.instanceId),
    );
    const materialRoots = nodes
        .filter((node) =>
            !node.definition.capabilities.includes(DERIVED_STATE)
            && node.definition.outputs.some((output) => output.type === 'color-texture')
            && !forwardImageSources.has(node.instanceId))
        .map((node) => node.instanceId);

    for (const root of materialRoots) {
        if (!freshAncestors.has(root)) {
            problems.push({
                detail: `visible material root ${root} bypasses the scene state`,
                instanceId: root,
            });
        }
    }

    if (problems.length > 0 || !warp) {
        return { problems };
    }

    return {
        problems,
        state: {
            combineInstanceId: combine.instanceId,
            warpInstanceId: warp.instanceId,
            stateResource,
            materialRoots,
        },
    };
}
