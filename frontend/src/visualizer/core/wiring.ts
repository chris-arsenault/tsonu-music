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
import type { Rng } from './random';

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
    /**
     * Inputs fed by a host-supplied asset texture rather than another plugin. Kept separate from edges
     * because an asset is not a graph node, so it has no execution order to participate in.
     */
    assetBindings: { instanceId: string; port: string; resource: string }[];
    /** Required inputs nothing could satisfy. A scene with any of these will not compile. */
    unsatisfied: { instanceId: string; port: string; type: string }[];
}

/**
 * Identity for one instance of a definition within a scene.
 *
 * `occurrence` counts how many instances of *this same definition* precede it, not how many nodes
 * do. A global position made every id downstream of a change a different id: adding one plugin, or
 * removing one, renumbered the rest of the scene, and `instantiate` reuses an instance only when its
 * id and definition both match — so an incremental rebuild that was supposed to preserve the
 * simulations it did not touch recreated all of them instead. Occurrence is stable against anything
 * happening elsewhere in the graph.
 */
export function instanceIdFor(definition: VisualPluginDefinition, occurrence: number): string {
    return `${definition.id}#${occurrence}`;
}

/** Nodes for an ordered definition list, each with its occurrence-stable id. */
export function assignInstanceIds(
    definitions: readonly VisualPluginDefinition[],
): GraphNode[] {
    const occurrences = new Map<string, number>();

    return definitions.map((definition) => {
        const occurrence = occurrences.get(definition.id) ?? 0;
        occurrences.set(definition.id, occurrence + 1);

        return { instanceId: instanceIdFor(definition, occurrence), definition };
    });
}

/**
 * Wires an assembled plugin set into a graph.
 *
 * Producers are tracked as a stack per port type, so a transformer takes the freshest colour output
 * rather than the original source — which is what chains transformers instead of running them in
 * parallel off the same input.
 */
/**
 * A texture the host supplies rather than a plugin producing: loaded album art, a mask image.
 *
 * Assets have to be graph resources, because the plugins that consume them declare ordinary typed
 * inputs. Without this, an album-art source could never be satisfied by anything.
 */
export interface AssetResource {
    resource: string;
    type: PluginPort['type'];
}

/** Resource id for a bound asset, distinguishable from a plugin output. */
export function assetResourceId(assetId: string): string {
    return `asset:${assetId}`;
}

/**
 * Re-points each loop at a producer drawn from the whole scene (ADR-0012).
 *
 * Every closing edge was pointed at the plugin's own output, so a loop could only ever be a branch
 * trailing itself. The compiler, the render plan, and the pass executor all accept a loop closed to
 * any resource; only this file insisted otherwise.
 *
 * Two configurations are favoured because they read as something. A plugin reading its own output is
 * a branch leaving a trail, which is what these plugins were written for. A plugin reading the
 * scene's terminal colour is the whole composed image folding back into itself, which is where a
 * tunnel comes from — and it is the configuration that makes a warp's small per-frame displacement
 * compound over hundreds of frames instead of being rebuilt. The rest are the variety.
 */
function redirectLoops(
    edges: RenderGraphEdge[],
    nodes: readonly GraphNode[],
    rng: Rng,
): void {
    const terminal = resolvePresent(nodes);

    for (const edge of edges) {
        if (!edge.feedback) {
            continue;
        }

        const sink = nodes.find((node) => node.instanceId === edge.to.instanceId);
        const port = sink?.definition.inputs.find((input) => input.name === edge.to.port);
        if (!sink || !port) {
            continue;
        }

        const candidates = nodes.flatMap((node) => node.definition.outputs
            .filter((output) => !output.internal && portsCompatible(output.type, port.type))
            .map((output) => ({ instanceId: node.instanceId, port: output.name })));

        // Grouped before it is drawn, because the three kinds are not equally numerous and drawing
        // over the flat list lets the largest group decide the proportions. A scene has one of
        // itself and one terminal against however many other colour producers it happens to hold,
        // so weighting candidates individually made "somewhere else" the usual answer at a rate
        // nobody chose — measured, 174 of 300 against 56 self-closing.
        const own = candidates.filter((candidate) => candidate.instanceId === sink.instanceId);
        const last = candidates.filter((candidate) =>
            terminal !== undefined
            && candidate.instanceId === terminal.instanceId
            && candidate.instanceId !== sink.instanceId);
        const rest = candidates.filter((candidate) =>
            !own.includes(candidate) && !last.includes(candidate));

        const groups: { members: typeof candidates; weight: number }[] = [
            // A branch leaving a trail: what these plugins were written for.
            { members: own, weight: 3 },
            // The whole composed image folding back into itself: where a tunnel comes from.
            { members: last, weight: 3 },
            // Everything else, which is the variety rather than the default.
            { members: rest, weight: 2 },
        ];

        const group = rng.weighted(
            groups.filter((entry) => entry.members.length > 0),
            (entry) => entry.weight,
        );
        const picked = group && rng.pick(group.members);

        if (picked) {
            edge.from = picked;
        }
    }
}

export function wireScene(
    plugins: readonly VisualPluginDefinition[],
    assets: readonly AssetResource[] = [],
    /**
     * Draws where each loop closes. Absent, every loop closes on its own plugin, which is what an
     * authored graph and every wiring test expect: they state their edges rather than drawing them.
     */
    rng?: Rng,
): WiredScene {
    const ordered = orderByDependency(
        [...plugins].sort(
            (left, right) => CHAIN_ORDER.indexOf(left.category) - CHAIN_ORDER.indexOf(right.category),
        ),
        assets,
    );

    const nodes: GraphNode[] = assignInstanceIds(ordered);

    const edges: RenderGraphEdge[] = [];
    const assetBindings: WiredScene['assetBindings'] = [];
    const unsatisfied: WiredScene['unsatisfied'] = [];
    /** Most recent producer per port type, freshest last. */
    const producers = new Map<string, { instanceId: string; port: string }[]>();
    /** Outputs registered but not yet read by anything, so later inputs can fold them into the chain. */
    const unconsumed = new Set<string>();

    for (const node of nodes) {
        // A two-input compositor needs two branches. Without reserving the first producer, both
        // `source` and `overlay` resolve to the same newest texture and the mixer becomes a no-op.
        const usedProducerResources = new Map<PluginPort['type'], Set<string>>();
        let inputsWired = 0;

        for (const port of node.definition.inputs) {
            const excluded = usedProducerResources.get(port.type) ?? new Set<string>();
            // The first input continues whatever chain this node is part of; the rest reach for a
            // branch nothing has read, which is what folds separate generators into one image instead
            // of leaving each to be summed in at the end.
            const source = findProducer(producers, port, excluded, inputsWired > 0 ? unconsumed : undefined);

            if (source) {
                edges.push({ from: source, to: { instanceId: node.instanceId, port: port.name } });
                excluded.add(`${source.instanceId}.${source.port}`);
                usedProducerResources.set(port.type, excluded);
                unconsumed.delete(`${source.instanceId}.${source.port}`);
                inputsWired += 1;
                continue;
            }

            // No plugin produces this, so fall back to a host asset of a compatible type. Checked after
            // plugin outputs, so a derived texture always wins over the raw asset it came from.
            const asset = findAsset(assets, port);
            if (asset) {
                assetBindings.push({
                    instanceId: node.instanceId,
                    port: port.name,
                    resource: asset.resource,
                });
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

        // Registered after its inputs, so a plugin never consumes its own forward output. An internal
        // output is never registered at all: it is this plugin's own working state, and offering it
        // to the rest of the graph gets it consumed in place of the thing the plugin actually makes.
        for (const port of node.definition.outputs) {
            if (port.internal) {
                continue;
            }

            const existing = producers.get(port.type) ?? [];
            existing.push({ instanceId: node.instanceId, port: port.name });
            producers.set(port.type, existing);
            unconsumed.add(`${node.instanceId}.${port.name}`);
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

    if (rng) {
        redirectLoops(edges, nodes, rng);
    }

    return { nodes, edges, assetBindings, present: resolvePresent(nodes), unsatisfied };
}

function findAsset(
    assets: readonly AssetResource[],
    port: PluginPort,
): AssetResource | undefined {
    return assets.find((asset) => portsCompatible(asset.type, port.type));
}

/**
 * Reorders so a plugin's producers come before it, preserving the category sort otherwise.
 *
 * Category order alone is not enough: two plugins in the same category can depend on one another, as a
 * mask containment field depends on the distance field beside it. Without this, wiring would look for a
 * producer that has not been registered yet and report the input as unsatisfiable.
 */
function orderByDependency(
    plugins: readonly VisualPluginDefinition[],
    assets: readonly AssetResource[] = [],
): VisualPluginDefinition[] {
    const remaining = [...plugins];
    const ordered: VisualPluginDefinition[] = [];
    // Assets are available from the start, so a plugin reading one is ready immediately.
    const produced = new Set<PluginPort['type']>(assets.map((asset) => asset.type));

    while (remaining.length > 0) {
        const readyIndex = remaining.findIndex((definition) =>
            definition.inputs
                .filter((port) => port.required)
                .every((port) => satisfiedBy(produced, definition, port)));

        // Nothing is ready, so the rest depend on something absent. Emit in place and let wiring
        // report the unsatisfied inputs rather than looping forever.
        const index = readyIndex >= 0 ? readyIndex : 0;
        const next = remaining.splice(index, 1)[0];

        ordered.push(next);
        for (const port of next.outputs) {
            produced.add(port.type);
        }
    }

    return ordered;
}

function satisfiedBy(
    produced: ReadonlySet<PluginPort['type']>,
    definition: VisualPluginDefinition,
    port: PluginPort,
): boolean {
    if (isFeedbackPort(port) && declaresFeedback(definition)) {
        return true;
    }

    for (const type of produced) {
        if (portsCompatible(type, port.type)) {
            return true;
        }
    }

    return false;
}

function findProducer(
    producers: Map<string, { instanceId: string; port: string }[]>,
    port: PluginPort,
    excluded: ReadonlySet<string> = new Set(),
    /**
     * Outputs nothing has read yet, preferred over the newest when set.
     *
     * This is what turns a scene into a chain instead of a pile. Taking the newest producer for every
     * input means the first transform consumes the last source and each later transform consumes the
     * previous transform — a chain, but one that only ever contains a single generator. Every other
     * generator is left unread, becomes a terminal layer of its own, and is summed into the frame at
     * the end. Three generators then meant three images made separately, each modified on its own,
     * added together: no generator ever passing through anything another one made.
     *
     * A node's first input still takes the newest, which is what continues the chain it is part of.
     * Its later inputs reach for something unconsumed, so a compositor folds a waiting generator into
     * the chain rather than mixing two stages of the same one.
     */
    unconsumed?: ReadonlySet<string>,
): { instanceId: string; port: string } | undefined {
    if (unconsumed) {
        const preferred = findProducerIn(producers, port, excluded, unconsumed);
        if (preferred) {
            return preferred;
        }
    }

    const exact = producers.get(port.type);
    if (exact && exact.length > 0) {
        for (let index = exact.length - 1; index >= 0; index -= 1) {
            const candidate = exact[index];
            if (!excluded.has(`${candidate.instanceId}.${candidate.port}`)) {
                return candidate;
            }
        }
    }

    // Fall back to any type the port accepts, such as a distance field feeding a mask input.
    for (const [type, candidates] of producers) {
        if (!portsCompatible(type as PluginPort['type'], port.type)) {
            continue;
        }

        for (let index = candidates.length - 1; index >= 0; index -= 1) {
            const candidate = candidates[index];
            if (!excluded.has(`${candidate.instanceId}.${candidate.port}`)) {
                return candidate;
            }
        }
    }

    return undefined;
}

/** The same search as `findProducer`, restricted to a set of candidate outputs. */
function findProducerIn(
    producers: Map<string, { instanceId: string; port: string }[]>,
    port: PluginPort,
    excluded: ReadonlySet<string>,
    allowed: ReadonlySet<string>,
): { instanceId: string; port: string } | undefined {
    const search = (candidates: readonly { instanceId: string; port: string }[]) => {
        for (let index = candidates.length - 1; index >= 0; index -= 1) {
            const candidate = candidates[index];
            const key = `${candidate.instanceId}.${candidate.port}`;
            if (allowed.has(key) && !excluded.has(key)) {
                return candidate;
            }
        }

        return undefined;
    };

    const exact = producers.get(port.type);
    if (exact) {
        const match = search(exact);
        if (match) {
            return match;
        }
    }

    for (const [type, candidates] of producers) {
        if (portsCompatible(type as PluginPort['type'], port.type)) {
            const match = search(candidates);
            if (match) {
                return match;
            }
        }
    }

    return undefined;
}

function ownOutputFor(
    definition: VisualPluginDefinition,
    port: PluginPort,
): PluginPort | undefined {
    // A named pairing wins over a type match, so a plugin with two outputs of one type can close two
    // distinct loops. Falling back to type keeps every port written before `feedbackFrom` existed
    // working unchanged.
    if (port.feedbackFrom) {
        return definition.outputs.find((candidate) => candidate.name === port.feedbackFrom);
    }

    return definition.outputs.find((candidate) => portsCompatible(candidate.type, port.type));
}

/**
 * A port a plugin nominates as its historical read.
 *
 * The nomination is a hint about where a previous frame is most useful to this plugin, not a
 * statement that history may only occur there — see ADR-0012. What it still decides is which port a
 * self-closing loop lands on when the plugin has several.
 */
export function isFeedbackPort(port: PluginPort): boolean {
    return port.feedbackFrom !== undefined
        || port.name === 'history' || port.name === 'feedback' || port.name === 'previous';
}

/**
 * A loop carrying an image, which is the kind that can run away visually.
 *
 * The distinction the attenuation contract turns on, and it is already in the port types. A
 * simulator closing a loop on `reaction-diffusion-state` or `wave-field-state` is advancing its own
 * state, bounded by its own dynamics — Gray-Scott stays inside nought to one because the reaction
 * does, not because anything decays it — and no other plugin produces those types, so such a loop
 * cannot be cross-wired anywhere else. A loop carrying a colour or mask texture is a picture being
 * fed back into a picture, and that is what diverges.
 */
export function isImagePortType(type: PluginPort['type']): boolean {
    return type === 'color-texture' || type === 'mask-texture';
}

/**
 * Whether a plugin may sit at the closing end of an image loop.
 *
 * The attenuation contract (ADR-0012). The kernel owns the combine for its own accumulation and can
 * promise that a static image converges to itself; it does not own a loop closed through the graph
 * and cannot. What it can require is that whatever closes one is lossy, which is not a restriction
 * so much as physics — a feedback path over an image that does not attenuate diverges whatever is
 * in it.
 *
 * This is a precondition on wiring, checkable and checked, rather than a hope about which plugins
 * selection happens to draw. ADR-0007 rejected the latter shape for persistence itself, and
 * persistence is still guaranteed by the kernel regardless of what the graph does.
 */
export function attenuatesHistory(definition: VisualPluginDefinition): boolean {
    return definition.capabilities.includes('feedback');
}

function declaresFeedback(definition: VisualPluginDefinition): boolean {
    return attenuatesHistory(definition);
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
