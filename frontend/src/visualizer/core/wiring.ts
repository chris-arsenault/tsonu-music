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
import { isDerivedJoin, SPATIAL_FEEDBACK } from './grammar';
import { divergentCycles } from './loop-gain';
import { isImagePortType, type PluginCategory, type PluginPort, type VisualPluginDefinition } from './plugin';
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
 * Turns one forward image edge into a historical one, chosen so the cycle it makes converges.
 *
 * This was `redirectLoops`, which re-pointed loops that a plugin had already declared by naming a
 * port `history`, `feedback`, or `previous`. Under ADR-0013 no plugin declares a loop: every node
 * output persists, any edge may read the previous frame, and where a scene remembers is a wiring
 * decision like every other. What decides whether the decision is legal is the cycle's gain, so that
 * is what is checked here rather than a capability string.
 *
 * The sink is an image input somewhere in the chain and the source is a producer from anywhere in the
 * scene, with two configurations favoured because they read as something. A node reading its own
 * output is a branch leaving a trail. A node reading the scene's terminal colour is the whole
 * composed image folding back into itself, which is where a tunnel comes from — the configuration
 * that makes a warp's small per-frame displacement compound over hundreds of frames instead of being
 * rebuilt from nothing. The rest are the variety.
 *
 * Grouped before it is drawn, because the three kinds are not equally numerous and drawing over the
 * flat list lets the largest group decide the proportions: a scene has one of itself and one terminal
 * against however many other colour producers it happens to hold, which made "somewhere else" the
 * usual answer at a rate nobody chose — measured, 174 of 300 against 56 self-closing.
 */
/**
 * Image inputs a loop could close at, the ones that displace what they read first.
 *
 * Shuffled within each group rather than across both, because `requireSpatialLoop` asks for a loop
 * that moves the image and not merely one that remembers it — a loop through a colour operation
 * gives a scene a memory and no motion. Drawn flat, the displacing sinks are a minority of the image
 * inputs in a scene and most candidates settled on one that only recolours, which the grammar then
 * rejected after the whole scene had been assembled.
 */
function orderLoopSinks(
    nodes: readonly GraphNode[],
    rng: Rng,
): { node: GraphNode; input: PluginPort }[] {
    const sinks = nodes.flatMap((node) => node.definition.inputs
        .filter((input) => isImagePortType(input.type))
        .map((input) => ({ node, input })));

    const displaces = (entry: { node: GraphNode }) =>
        entry.node.definition.capabilities.includes(SPATIAL_FEEDBACK);

    return [
        ...rng.shuffle(sinks.filter(displaces)),
        ...rng.shuffle(sinks.filter((entry) => !displaces(entry))),
    ];
}

function closeLoop(
    edges: RenderGraphEdge[],
    nodes: readonly GraphNode[],
    rng: Rng,
): void {
    const terminal = resolvePresent(nodes);

    // Image loops a nominated port already closed are candidates to relocate, not fixtures. The
    // nomination says where a previous frame is most useful *to that plugin*; where the scene
    // remembers is a different question, and answering it with whichever loop-capable plugin
    // selection happened to draw is what ADR-0013 removed. Exactly one survives either way, because
    // the grammar budgets for one.
    const isImageLoop = (edge: RenderGraphEdge): boolean => {
        if (!edge.feedback) {
            return false;
        }

        const sink = nodes.find((node) => node.instanceId === edge.to.instanceId);
        const port = sink?.definition.inputs.find((input) => input.name === edge.to.port);

        return port !== undefined && isImagePortType(port.type) && !port.required;
    };

    const kept = edges.filter((edge) => !isImageLoop(edge));

    for (const { node: sink, input } of orderLoopSinks(nodes, rng)) {
        const candidates = nodes.flatMap((node) => node.definition.outputs
            .filter((output) => !output.internal && portsCompatible(output.type, input.type))
            .map((output) => ({ instanceId: node.instanceId, port: output.name })));

        const own = candidates.filter((candidate) => candidate.instanceId === sink.instanceId);
        const last = candidates.filter((candidate) =>
            terminal !== undefined
            && candidate.instanceId === terminal.instanceId
            && candidate.instanceId !== sink.instanceId);
        const rest = candidates.filter((candidate) =>
            !own.includes(candidate) && !last.includes(candidate));

        const groups: { members: typeof candidates; weight: number }[] = [
            { members: own, weight: 3 },
            { members: last, weight: 3 },
            { members: rest, weight: 2 },
        ];

        const group = rng.weighted(
            groups.filter((entry) => entry.members.length > 0),
            (entry) => entry.weight,
        );
        const picked = group && rng.pick(group.members);
        if (!picked) {
            continue;
        }

        const to = { instanceId: sink.instanceId, port: input.name };
        const proposed: RenderGraphEdge[] = [
            ...kept.filter((edge) =>
                !(edge.to.instanceId === to.instanceId && edge.to.port === to.port)),
            { from: picked, to, feedback: true },
        ];

        // A cycle at unity gain grows without bound. The grade compresses, so it shows as a bright
        // frame rather than as `NaN`, which is a worse thing to ship than a scene that composes
        // differently — and the alternative candidates are right here.
        if (divergentCycles(nodes, proposed).length > 0) {
            continue;
        }

        edges.length = 0;
        edges.push(...proposed);
        return;
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
    // Derived joins sort after every category, not with the compositors they otherwise resemble.
    // Placed by category they ran before the post-processing stages, and each of those takes one
    // branch and emits one — so three of them consuming three different producers split the image
    // back into three terminals immediately after it had been joined into one. A join has to be able
    // to reach whatever the scene finished with.
    const chainIndex = (definition: VisualPluginDefinition) =>
        (isDerivedJoin(definition) ? CHAIN_ORDER.length : CHAIN_ORDER.indexOf(definition.category));

    const ordered = orderByDependency(
        [...plugins].sort((left, right) => chainIndex(left) - chainIndex(right)),
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

        // A join exists to absorb branches, so every one of its inputs reaches for something unread —
        // including the first, which for every other node takes the newest producer to continue the
        // chain it is part of. Without this a derived mixer could take two outputs that were already
        // consumed, produce a third terminal, and leave the count exactly where it was: the joins were
        // added and the scene still arrived at the composite in pieces.
        const joining = isDerivedJoin(node.definition);

        for (const port of node.definition.inputs) {
            // A port nominating a historical read gets one, ahead of any upstream producer. ADR-0013
            // keeps `feedbackFrom` and the conventional names as a hint about where a previous frame
            // is most useful to this plugin — not as permission for history to occur, which is now
            // everywhere, but as the answer to which port a self-closing loop lands on.
            //
            // Images only. The particle emitters, forces and colliders each declare a `previous` port
            // so they can chain, and every one after the first reads the list the one before it
            // built. Preferring history there would break the chain into a row of nodes each reading
            // its own last frame.
            const nominated = isFeedbackPort(port)
                && isImagePortType(port.type)
                && ownOutputFor(node.definition, port);

            if (nominated) {
                edges.push({
                    from: { instanceId: node.instanceId, port: nominated.name },
                    to: { instanceId: node.instanceId, port: port.name },
                    feedback: true,
                });
                continue;
            }

            const excluded = usedProducerResources.get(port.type) ?? new Set<string>();
            // The first input continues whatever chain this node is part of; the rest reach for a
            // branch nothing has read, which is what folds separate generators into one image instead
            // of leaving each to be summed in at the end.
            const source = findProducer(
                producers,
                port,
                excluded,
                joining || inputsWired > 0 ? unconsumed : undefined,
            );

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

        // A block stood here forcing every plugin carrying the `feedback` capability to read its own
        // output, whether or not an upstream source existed. That was the mechanism that decided a
        // scene's memory, and it decided it by capability string: which plugin was selected settled
        // where the loop went and how it combined. Under ADR-0013 memory is a property of every
        // output, so where a scene remembers is drawn below like any other wiring choice.
    }

    if (rng) {
        closeLoop(edges, nodes, rng);
    }

    return { nodes, edges, assetBindings, present: resolvePresent(nodes), unsatisfied };
}

/**
 * Colour outputs nothing in the graph reads.
 *
 * Each of these becomes its own layer, and the kernel composite sums the layers onto one another. A
 * producer that ends up here has reached the canvas without passing through a single transform in the
 * scene — measured, only 38 of 400 scenes converged to one terminal, and the waveform sources were
 * unabsorbed roughly three hundred times across that sample. That is a spectrum drawn flat over the
 * picture, unwarped and unaffected by any loop, which is exactly what it looked like.
 *
 * The layer stack is section 11's and is not the problem; what it receives is. A scene that means to
 * compose should arrive at the composite as one image.
 */
export function unabsorbedOutputs(scene: WiredScene): { instanceId: string; port: string }[] {
    const consumed = new Set(
        scene.edges
            .filter((edge) => !edge.feedback)
            .map((edge) => `${edge.from.instanceId}.${edge.from.port}`),
    );

    return scene.nodes.flatMap((node) => node.definition.outputs
        .filter((port) =>
            port.type === 'color-texture'
            && !port.internal
            && !consumed.has(`${node.instanceId}.${port.name}`))
        .map((port) => ({ instanceId: node.instanceId, port: port.name })));
}

/**
 * A compositor able to join two colour branches into one.
 *
 * Found by shape rather than by id, so a mixer added later is eligible without this knowing its name.
 */
export function isBranchJoiner(definition: VisualPluginDefinition): boolean {
    const colourInputs = definition.inputs.filter((port) => port.type === 'color-texture');

    return definition.category === 'compositor'
        && colourInputs.length >= 2
        && colourInputs.every((port) => port.required)
        && definition.outputs.some((port) => port.type === 'color-texture');
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
    // A port nominating a historical read can always close on the output it names, so it never makes
    // a plugin wait for a producer that may not exist.
    if (isFeedbackPort(port) && ownOutputFor(definition, port) !== undefined) {
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

// `isImagePortType` moved to `core/plugin.ts`, beside `isValuePortType`, when the loop-gain check
// came to need it: it is a fact about a port type and both callers are outside this file.
export { isImagePortType } from './plugin';

// `attenuatesHistory` stood here, asking whether a definition carried the `feedback` capability. It
// was the attenuation contract of ADR-0012, and a capability string cannot express it: what keeps a
// loop from diverging is the product of the gains around it, which is a number, belongs to the cycle
// rather than to any one plugin, and can be checked. `divergentCycles` in `core/loop-gain.ts` is
// what replaced it, and `closeLoop` above is the precondition on wiring it was asking for.

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
