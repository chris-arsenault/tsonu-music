/**
 * Hand-authored scenes (spec section 23.1).
 *
 * A second producer of a compiled graph, beside the scheduler. Where `scene-builder.ts` assembles a
 * scene from entropy under the grammar, this one takes a document that says exactly which plugins are
 * present and exactly how they are joined, and puts it through the render graph compiler.
 *
 * The grammar does not apply here. Category ranges, minimum scene size, minimum material branches and
 * contribution pruning all exist to make *random* assembly coherent, and a graph somebody drew is not
 * random — being able to build a scene the grammar would reject is the point. Everything
 * `compileGraph` enforces still applies, because port typing, required inputs and cycle declaration
 * decide whether a graph can render at all. See ADR-0010.
 *
 * Pure: a document resolves to a graph with no device, no registry lookups beyond the one passed in,
 * and no host state, so the whole path from a saved document to an executable graph is testable in
 * the Node environment.
 */

import type { ParameterBinding } from './bindings';
import { COMPOSITE_BINDINGS, COMPOSITE_PARAMETERS } from './composite-grade';
import {
    compileGraph,
    type CompileProblem,
    type CompiledGraph,
    type GraphNode,
    type RenderGraphEdge,
} from './graph';
import type { DistributedBinding } from './audio-mapping';
import type { LayerOverride } from './layers';
import type { PersistenceOverrides } from './persistence';
import type { PluginRegistry, VisualPluginDefinition } from './plugin';
import { instanceSeed } from './random';
import type { WiredScene } from './wiring';

/**
 * The document format's version.
 *
 * A document is committable and outlives the code that wrote it, so it carries the version it was
 * written against and resolution refuses one it does not understand rather than misreading it.
 */
export const AUTHORED_SCENE_VERSION = 1;

export interface AuthoredNodePosition {
    x: number;
    y: number;
}

export interface AuthoredNode {
    /**
     * Stable identity, owned by the document.
     *
     * Also the instance id the graph compiles with, so a captured scene keeps the ids it was running
     * under and re-applying it reuses the instances rather than recreating them.
     */
    id: string;
    pluginId: string;
    position: AuthoredNodePosition;
    /** Pinned instance identity. Derived from the document's entropy when absent. */
    seed?: number;
    /** Starting values, applied over the plugin's own defaults. */
    parameters?: Record<string, number>;
    /**
     * What drives those parameters. Absent means the plugin's own bindings; an empty array means the
     * document has deliberately removed them, which is not the same thing.
     */
    bindings?: ParameterBinding[];
    /** Excluded from rendering without being removed from the graph. */
    muted?: boolean;
    /**
     * Parameters shown as sockets rather than as rows on the node.
     *
     * ComfyUI's convert-widget-to-input, and here for the same reason: a scene carries twenty-odd
     * bindings and drawing every one as its own node makes the graph unreadable, while drawing none
     * of them hides the thing most worth seeing — which parameters answer to which part of the
     * music. Promotion is per parameter, so the one under investigation becomes visible wiring and
     * the rest stay as rows.
     *
     * Presentation, like `position`, and in the document for the same reason: reopening a capture
     * should give back the picture that was being looked at.
     */
    promoted?: string[];
}

export interface AuthoredEdge {
    id: string;
    from: { node: string; port: string };
    to: { node: string; port: string };
    /** Reads the source's previous frame, so it may close a cycle. */
    feedback?: boolean;
}

export interface AuthoredAssetBinding {
    node: string;
    port: string;
    /** A host asset resource id, as `assetResourceId` produces. */
    resource: string;
}

/**
 * The stages between the graph and the canvas, which belong to no plugin.
 *
 * Composite, motion sum, accumulation, meter and grade run outside the render graph entirely, and
 * they decide as much about the finished frame as anything in it — the accumulation alone is where
 * most of what reads as motion happens. A document that could address the graph and not the tail
 * could not be used to answer the commonest question there is, which is why the frame looks the way
 * it does rather than why one node does.
 *
 * Every member is optional. Absent means the kernel decides, as it does with no document at all.
 */
export interface AuthoredKernel {
    /**
     * Explicit layer membership for Composite. Undefined keeps automatic membership; an empty array
     * deliberately gives the stage no inputs.
     */
    compositeInputs?: string[];
    /** The grade's own parameters and what drives them, resolved exactly as a plugin's are. */
    grade?: {
        parameters?: Record<string, number>;
        bindings?: ParameterBinding[];
    };
    /**
     * The scheme used to colour otherwise-neutral material at Composite.
     *
     * Undefined members retain the theme/entropy-derived choice. An explicit id and strength make the
     * colour transformation reproducible and editable instead of leaving it as hidden kernel state.
     */
    palette?: {
        id?: string;
        strength?: number;
    };
    /** Pinned accumulation values. Absent members keep following the theme and the audio. */
    persistence?: PersistenceOverrides;
    /** Presentation overrides per layer, keyed by the instance that produced it. */
    layers?: Record<string, LayerOverride>;
}

export interface AuthoredScene {
    version: number;
    /**
     * Reproduces everything the scene derives rather than states: instance seeds, and the colour
     * scheme the palette is drawn from. Without it a reopened document renders in a different scheme
     * than the one it was saved in, which makes it useless for studying a colour fault.
     */
    entropy: string;
    /** The family this scene was captured from, when it came from one. */
    themeId?: string;
    nodes: AuthoredNode[];
    edges: AuthoredEdge[];
    assetBindings: AuthoredAssetBinding[];
    /** The resource presented to the canvas. Absent leaves the compiler's default in place. */
    present?: { node: string; port: string };
    /** The stages after the graph. Absent leaves every one of them to the kernel. */
    kernel?: AuthoredKernel;
}

/**
 * One reason a document did not resolve, attributed to whatever caused it.
 *
 * Anchored rather than flat, because the editor's job is to put the message on the node or edge at
 * fault. A list of sentences is something to log, not something to show.
 */
export interface AuthoredProblem {
    kind: 'version' | 'unknown-plugin' | 'duplicate-node' | 'dangling-edge' | 'compile' | 'binding';
    detail: string;
    nodeId?: string;
    edgeId?: string;
}

/** Everything a host needs to run an authored document, in the shapes it already consumes. */
export interface ResolvedAuthoredScene {
    entropy: string;
    themeId?: string;
    nodes: GraphNode[];
    /**
     * The document's structure in the shape the host already reads for a generated scene, so the two
     * paths converge before the host has to tell them apart.
     */
    wired: WiredScene;
    graph: CompiledGraph;
    /** Per-instance, as `distributeReactivity` produces for a generated scene. */
    bindings: DistributedBinding[];
    /** Per-instance starting parameters, already merged over each plugin's defaults. */
    parameters: Record<string, Record<string, number>>;
    /** Per-instance identity, pinned by the document or derived from its entropy. */
    seeds: Record<string, number>;
    /** Nodes the document has muted. A runtime exclusion, not a change to the graph. */
    muted: string[];
    /** The tail's settings, already resolved over the kernel's own defaults. */
    kernel: ResolvedKernel;
}

export interface ResolvedKernel {
    compositeInputs?: readonly string[];
    gradeParameters: Record<string, number>;
    gradeBindings: readonly ParameterBinding[];
    palette?: {
        id?: string;
        strength?: number;
    };
    persistence?: PersistenceOverrides;
    layers?: Record<string, LayerOverride>;
}

export type AuthoredResolution =
    | { ok: true; scene: ResolvedAuthoredScene; warnings: AuthoredProblem[] }
    | { ok: false; problems: AuthoredProblem[] };

/** An empty document, which is a legal thing to start editing from. */
export function emptyAuthoredScene(entropy: string): AuthoredScene {
    return {
        version: AUTHORED_SCENE_VERSION,
        entropy,
        nodes: [],
        edges: [],
        assetBindings: [],
    };
}

export function edgeIdFor(
    from: { node: string; port: string },
    to: { node: string; port: string },
    feedback = false,
): string {
    return `${from.node}.${from.port}->${to.node}.${to.port}${feedback ? ':feedback' : ''}`;
}

/**
 * Turns a document into an executable graph, or into the reasons it is not one.
 *
 * Structural faults the compiler cannot see — a plugin id no longer in the catalog, two nodes sharing
 * an id, an edge naming a node that is not there — are found first and reported against the node or
 * edge that holds them. Everything else comes from `compileGraph`, whose problems already carry their
 * own anchors.
 */
export function resolveAuthoredScene(
    document: AuthoredScene,
    registry: PluginRegistry,
): AuthoredResolution {
    if (document.version !== AUTHORED_SCENE_VERSION) {
        return {
            ok: false,
            problems: [{
                kind: 'version',
                detail: `document version ${document.version} is not ${AUTHORED_SCENE_VERSION}`,
            }],
        };
    }

    const problems: AuthoredProblem[] = [];
    const definitions = new Map<string, VisualPluginDefinition>();
    const seen = new Set<string>();

    for (const node of document.nodes) {
        if (seen.has(node.id)) {
            problems.push({
                kind: 'duplicate-node',
                detail: `two nodes share the id ${node.id}`,
                nodeId: node.id,
            });
            continue;
        }
        seen.add(node.id);

        const definition = registry.get(node.pluginId);
        if (!definition) {
            // Reported against the node rather than failing the document, so a stale document opens
            // with a gap in it and everything else still resolves.
            problems.push({
                kind: 'unknown-plugin',
                detail: `no plugin named ${node.pluginId} is registered`,
                nodeId: node.id,
            });
            continue;
        }

        definitions.set(node.id, definition);
    }

    for (const edge of document.edges) {
        for (const end of [edge.from, edge.to]) {
            if (!definitions.has(end.node)) {
                problems.push({
                    kind: 'dangling-edge',
                    detail: `edge ${edge.id} names ${end.node}, which is not in the document`,
                    edgeId: edge.id,
                });
            }
        }
    }

    for (const binding of document.assetBindings) {
        if (!definitions.has(binding.node)) {
            problems.push({
                kind: 'dangling-edge',
                detail: `asset binding names ${binding.node}, which is not in the document`,
                nodeId: binding.node,
            });
        }
    }

    if (problems.length > 0) {
        return { ok: false, problems };
    }

    const nodes: GraphNode[] = document.nodes.map((node) => ({
        instanceId: node.id,
        definition: definitions.get(node.id)!,
    }));

    const edges: RenderGraphEdge[] = document.edges.map((edge) => ({
        from: { instanceId: edge.from.node, port: edge.from.port },
        to: { instanceId: edge.to.node, port: edge.to.port },
        ...(edge.feedback ? { feedback: true } : {}),
    }));

    const wired: WiredScene = {
        nodes,
        edges,
        assetBindings: document.assetBindings.map((binding) => ({
            instanceId: binding.node,
            port: binding.port,
            resource: binding.resource,
        })),
        ...(document.present
            ? { present: { instanceId: document.present.node, port: document.present.port } }
            : {}),
        // A document that leaves a required input open does not resolve at all, so by the time
        // anything reads this there is nothing unsatisfied left to report.
        unsatisfied: [],
    };

    const compiled = compileGraph(nodes, edges, wired.present, wired.assetBindings);

    if (!compiled.ok) {
        return {
            ok: false,
            problems: compiled.problems.map((problem) => asAuthoredProblem(problem, document)),
        };
    }

    const bindings: DistributedBinding[] = [];
    const parameters: Record<string, Record<string, number>> = {};
    const seeds: Record<string, number> = {};
    const muted: string[] = [];
    const warnings: AuthoredProblem[] = [];

    for (const node of document.nodes) {
        const definition = definitions.get(node.id)!;

        bindings.push({
            instanceId: node.id,
            pluginId: node.pluginId,
            bindings: [...(node.bindings ?? definition.defaultBindings ?? [])],
        });

        parameters[node.id] = { ...(definition.parameters ?? {}), ...(node.parameters ?? {}) };
        seeds[node.id] = node.seed ?? instanceSeed(document.entropy, node.id);

        if (node.muted) {
            muted.push(node.id);
        }

        for (const binding of node.bindings ?? []) {
            if (definition.parameters?.[binding.parameter] === undefined) {
                // Harmless — it becomes a uniform nothing reads — but it is almost always a typo or a
                // parameter the plugin has since dropped, and silence there is how a control that
                // looks connected turns out not to be.
                warnings.push({
                    kind: 'binding',
                    detail: `${node.pluginId} declares no parameter ${binding.parameter}`,
                    nodeId: node.id,
                });
            }
        }
    }

    return {
        ok: true,
        warnings,
        scene: {
            entropy: document.entropy,
            themeId: document.themeId,
            nodes,
            wired,
            graph: compiled.graph,
            bindings,
            parameters,
            seeds,
            muted,
            kernel: resolveKernel(document.kernel),
        },
    };
}

/** The tail's settings over the kernel's own, so an absent section behaves as no document at all. */
export function resolveKernel(kernel: AuthoredKernel | undefined): ResolvedKernel {
    return {
        ...(kernel?.compositeInputs !== undefined
            ? { compositeInputs: [...kernel.compositeInputs] }
            : {}),
        gradeParameters: { ...COMPOSITE_PARAMETERS, ...(kernel?.grade?.parameters ?? {}) },
        gradeBindings: kernel?.grade?.bindings ?? COMPOSITE_BINDINGS,
        ...(kernel?.palette ? { palette: { ...kernel.palette } } : {}),
        ...(kernel?.persistence ? { persistence: { ...kernel.persistence } } : {}),
        ...(kernel?.layers ? { layers: { ...kernel.layers } } : {}),
    };
}

/** Re-anchors a compiler problem onto the document's own node and edge ids. */
function asAuthoredProblem(problem: CompileProblem, document: AuthoredScene): AuthoredProblem {
    const edge = problem.edge && document.edges.find((candidate) =>
        candidate.from.node === problem.edge!.from.instanceId
        && candidate.from.port === problem.edge!.from.port
        && candidate.to.node === problem.edge!.to.instanceId
        && candidate.to.port === problem.edge!.to.port);

    return {
        kind: 'compile',
        detail: problem.detail,
        ...(problem.instanceId ? { nodeId: problem.instanceId } : {}),
        ...(edge ? { edgeId: edge.id } : {}),
    };
}
