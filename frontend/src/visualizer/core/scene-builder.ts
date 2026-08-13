/**
 * Scene construction: assemble, distribute reactivity, wire, compile.
 *
 * One place that turns per-scene entropy plus a theme into something the runtime can execute, so the
 * host does not have to know the order these steps go in. Pure, so the whole pipeline is testable end
 * to end without a GL context.
 */

import { distributeReactivity, type DistributedBinding } from './audio-mapping';
import { compileSceneGraph, portsCompatible, type CompiledGraph, type GraphNode, type RenderGraphEdge } from './graph';
import {
    DERIVED_JOIN,
    DERIVED_STATE,
    displacesHistory,
    grammarViolations,
    isDerivedJoin,
    REDUCED_GRAMMAR,
    SPATIAL_FEEDBACK,
    type GrammarViolation,
    type SceneGrammar,
} from './grammar';
import { isMotionSource } from './fields';
import type { QualityProfile } from './performance';
import type { VisualPluginDefinition } from './plugin';
import { createRng } from './random';
import { assembleScene, type SchedulerContext, type VisualTheme } from './scheduler';
import {
    closeSceneLoop,
    isBranchJoiner,
    isImagePortType,
    unabsorbedOutputs,
    instanceIdFor,
    wireScene,
    type AssetResource,
    type WiredScene,
} from './wiring';

export interface BuiltScene {
    entropy: string;
    theme: VisualTheme;
    plugins: VisualPluginDefinition[];
    wired: WiredScene;
    graph: CompiledGraph;
    bindings: DistributedBinding[];
    /**
     * Per-instance starting parameters the theme dictates, applied over each plugin's own defaults.
     *
     * Keyed by instance id rather than definition id, so two instances of one plugin can start from
     * different values. Keyed by definition they could not, on this path or any other.
     */
    parameterOverrides: Record<string, Record<string, number>>;
}

/**
 * Turns a theme's colour policy into starting parameters.
 *
 * The policy says how strongly the scene's colour should come from its palette source; the plugins that
 * map colour are the ones that can act on it, so the policy lands on their strength parameters rather
 * than being stored and forgotten.
 */
export function colourOverrides(
    policy: VisualTheme['colorPolicy'],
): Record<string, Record<string, number>> {
    if (!policy) {
        return {};
    }

    const strength = policy.strength <= 0 ? 0 : policy.strength > 1 ? 1 : policy.strength;

    return {
        PaletteMapper: { strength },
        // A curated policy leaves the source material's own colour largely intact, so the transform
        // works less hard; a palette-derived policy pushes harder toward the palette.
        ...Object.fromEntries(
            ['hue-rotate', 'saturation', 'contrast', 'solarize', 'invert', 'permute', 'duotone', 'quantize', 'luminance']
                .map((mode) => [`ColorTransform:${mode}`, { amount: strength * 0.6 }]),
        ),
    };
}

/**
 * Lands the theme's colour policy on the instances that are actually in the scene.
 *
 * `colourOverrides` above answers "which plugins does this policy address", which is a question about
 * the catalog. This answers "which nodes does it reach", which is a question about one scene — so a
 * definition present twice gets two entries that can subsequently diverge, and a definition the
 * scheduler did not select gets none rather than an override addressed to nothing.
 */
export function instanceOverrides(
    scene: WiredScene,
    policy: VisualTheme['colorPolicy'],
): Record<string, Record<string, number>> {
    const byDefinition = colourOverrides(policy);
    const overrides: Record<string, Record<string, number>> = {};

    for (const node of scene.nodes) {
        const values = byDefinition[node.definition.id];
        if (values) {
            overrides[node.instanceId] = { ...values };
        }
    }

    return overrides;
}

/**
 * Scales the colour-mapping bindings by the theme's declared colour strength.
 *
 * `colourOverrides` above writes the same strength into those parameters' starting values, but both
 * parameters are *bound* — `PaletteMapper.strength` to overall level, `ColorTransform.amount` to a
 * band — so the resolver treats the override as nothing more than an initial condition and smooths it
 * away over the binding's own attack and release, a matter of a second at most. The theme's colour
 * policy had no steady-state effect on anything.
 *
 * Scaling the output range is what makes it durable: at zero the parameter cannot leave zero however
 * loud the track, at one the binding keeps the range its author wrote, and in between the music still
 * drives the parameter across a proportionally smaller span. The starting values remain useful, since
 * they are where the parameter begins before the first frame of audio arrives.
 */
export function applyColourPolicy(
    bindings: DistributedBinding[],
    policy: VisualTheme['colorPolicy'],
): DistributedBinding[] {
    if (!policy) {
        return bindings;
    }

    const strength = policy.strength <= 0 ? 0 : policy.strength > 1 ? 1 : policy.strength;
    if (strength === 1) {
        return bindings;
    }

    const scaled = (id: string, parameter: string): boolean =>
        (id === 'PaletteMapper' && parameter === 'strength')
        || (id.startsWith('ColorTransform:') && parameter === 'amount');

    return bindings.map((entry) => ({
        ...entry,
        bindings: entry.bindings.map((binding) => (
            scaled(entry.pluginId, binding.parameter)
                ? {
                    ...binding,
                    outputRange: [
                        binding.outputRange[0] * strength,
                        binding.outputRange[1] * strength,
                    ] as [number, number],
                }
                : binding
        )),
    }));
}

export type SceneBuildFailure =
    | { reason: 'grammar'; detail: string }
    | { reason: 'unsatisfied-inputs'; detail: string }
    | { reason: 'compile'; detail: string };

export type SceneBuildResult =
    | { ok: true; scene: BuiltScene }
    | { ok: false; failure: SceneBuildFailure };

/**
 * Builds a scene from one host-supplied entropy token.
 *
 * The quality profile is applied as scheduler constraints rather than after the fact: at a reduced
 * level the grammar itself gets cheaper and expensive plugins become ineligible, so a struggling device
 * assembles a scene it can render instead of one it must then dismantle.
 */
export interface SceneBuildContext
    extends Omit<SchedulerContext, 'theme' | 'allowHighCost' | 'allowDominant'> {
    /** Host-supplied asset textures the graph may bind to plugin inputs. */
    assetResources?: readonly AssetResource[];
}

const MAX_BUILD_ATTEMPTS = 32;

export function buildScene(
    entropy: string,
    theme: VisualTheme,
    context: SceneBuildContext,
    profile: QualityProfile,
): SceneBuildResult {
    let lastFailure: SceneBuildFailure = { reason: 'grammar', detail: 'no viable composition' };

    // Category selection is intentionally exploratory. Some selections are individually legal but
    // cannot form a connected multi-branch graph (for example, a field with no consumer or a mixer
    // with only one colour producer). Try further candidates instead of accepting an orphan or
    // flattening the scene to repair it.
    for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt += 1) {
        const candidateEntropy = `${entropy}:candidate:${attempt}`;
        const result = buildSceneAttempt(candidateEntropy, theme, context, profile);
        if (result.ok) {
            return result;
        }
        lastFailure = result.failure;
    }

    return { ok: false, failure: lastFailure };
}

export interface SettledScene {
    ok: true;
    plugins: VisualPluginDefinition[];
    wired: WiredScene;
    graph: CompiledGraph;
}

/**
 * Wires a plugin list into a scene that satisfies its own grammar, or says why it cannot.
 *
 * Everything between "here is a set of plugins" and "here is a graph worth rendering" lives here:
 * the loop draw, the derived joins, the connectivity prune, the structural check, the compile. It is
 * exported because it had exactly one caller and needed two.
 *
 * The second caller is the live mutation in `host/renderer.ts`, which was calling `wireScene`
 * directly and passing no rng. `wireScene` closes the scene's loop and draws its assets only when it
 * is given one, so every structural mutation — 81% of them, on a five-second timer — silently
 * removed the composed-image loop, reset every asset to the first entry of its manifest, and skipped
 * the join and the structural check entirely. Measured across three independent samples: the
 * cross-node fold-back loop went from ~45% of scenes to 0% after a single mutation, and mask
 * selection collapsed to the manifest's first entry in 100% of cases. Every figure this file's
 * comments quote was true of the first frame after a build and false a few seconds later.
 */
export function settleScene(
    initial: readonly VisualPluginDefinition[],
    entropy: string,
    theme: VisualTheme,
    context: SceneBuildContext,
    schedulerContext: SchedulerContext,
): SettledScene | { ok: false; failure: SceneBuildFailure } {
    let plugins = [...initial];
    // Material wiring nominates trails; the fold-back loop is drawn once, below, after the plugin
    // set stops changing. These are the scene's material memory — a stage echoing itself, the
    // composed image folding back through a lossy port — distinct from the canonical image state
    // `withCanonicalState` adds afterwards. Without them every stage upstream of the combine is a
    // fresh redraw resampled through per-frame absolute warps, which is invertible: the picture
    // returns exactly when the parameter does.
    const rewire = () => wireScene(
        plugins,
        context.assetResources ?? [],
        {
            rng: createRng(`${entropy}:loops`),
            maximumImageLoops: theme.grammar.maximumFeedbackLoops,
            drawLoop: false,
        },
    );

    let wired = rewire();
    if (wired.unsatisfied.length > 0) {
        return {
            ok: false,
            failure: {
                reason: 'unsatisfied-inputs',
                detail: wired.unsatisfied
                    .map((entry) => `${entry.instanceId}.${entry.port} (${entry.type})`)
                    .join('; '),
            },
        };
    }

    // Assembly is now one pass over the graph, repeated only when the prune removes a plugin.
    //
    // Placement and joining are functions of the wired graph: they add edges and nodes to what
    // wiring produced instead of adding definitions to the plugin list for wiring to re-derive. That
    // is what makes the round monotone. The old shape ran wiring, joining, wiring, pruning, wiring —
    // each stage re-deriving what the last had decided, from a plugin list the next stage changed
    // again. Nothing here can add a plugin, so the loop terminates on the prune alone.
    //
    // The prune still runs after joining, because contribution is defined by what reaches the
    // presented image: an unjoined branch is a terminal of its own, so every plugin feeding it reads
    // as contributing whether or not anything will ever look at it.
    for (let round = 0; round < ASSEMBLY_ROUNDS; round += 1) {
        // Leftover branches become arguments to stages already in the picture where an input is
        // open, and mixers where none is.
        let composed = placeBranches(wired, entropy);
        composed = spliceJoins(composed, entropy, schedulerContext);

        // Category counts alone are not enough: an optional field can be selected without anything
        // ever reading it. Keep only plugins that contribute to the presented image, then re-check
        // the grammar so an allegedly full scene cannot spend passes on disconnected decoration.
        if (unabsorbedOutputs(composed).length !== 1) {
            // Nothing left to try: joining ran out of eligible mixers or splice points, so the scene
            // would arrive at the composite in pieces. Another candidate is the answer.
            break;
        }

        const stateful = withCanonicalState(composed, entropy, schedulerContext.available);
        if (!stateful) {
            return {
                ok: false,
                failure: { reason: 'compile', detail: 'the catalog has no scene-state operators' },
            };
        }

        const contributing = contributingInstanceIds(stateful);
        const disconnected = composed.nodes.filter((node) => !contributing.has(node.instanceId));
        if (disconnected.length === 0) {
            wired = composed;
            break;
        }

        // Instances, counted back to definitions. Two instances of one definition where only one
        // contributes leaves one copy in the list, and wiring decides afresh which of them survives.
        // Derived nodes are not counted: they are spliced onto the graph rather than drawn from the
        // plugin list, so a contributing mixer of the builder's own making would otherwise vouch for
        // a disconnected one the scheduler chose.
        const keep = new Map<string, number>();
        for (const node of composed.nodes) {
            if (contributing.has(node.instanceId)
                && !isDerivedJoin(node.definition)
                && !node.definition.capabilities.includes(DERIVED_STATE)) {
                keep.set(node.definition.id, (keep.get(node.definition.id) ?? 0) + 1);
            }
        }
        plugins = plugins.filter((definition) => {
            const remaining = keep.get(definition.id) ?? 0;
            if (remaining <= 0) {
                return false;
            }
            keep.set(definition.id, remaining - 1);
            return true;
        });

        const violations = grammarViolations(plugins, theme.grammar);
        if (violations.length > 0) {
            return {
                ok: false,
                failure: {
                    reason: 'grammar',
                    detail: `connected graph: ${violations.map((violation) => violation.detail).join('; ')}`,
                },
            };
        }

        wired = rewire();
        if (round === ASSEMBLY_ROUNDS - 1) {
            // Out of rounds with the scene still shedding plugins. Compose what is left so the
            // structural check below judges a finished graph rather than a bare chain.
            wired = spliceJoins(placeBranches(wired, entropy), entropy, schedulerContext);
        }
    }

    // The fold-back loop, drawn once on the settled graph.
    //
    // The draw reads the whole node list, so it answers differently for every plugin set it sees.
    // Run inside the rounds above it re-drew the loop each time the joins or the prune changed the
    // set, and the rounds were chasing a fixpoint that moved underneath them — which is why a fix
    // to any one round could not converge, and why 155 of 200 builds had to discard their first
    // candidate. Drawn here it sees the graph the scene actually ships, joins included, so a branch
    // it displaces is one the joins have already placed.
    wired = closeSceneLoop(
        wired,
        createRng(`${entropy}:loops`),
        theme.grammar.maximumFeedbackLoops,
        true,
    );
    // A draw that displaced a forward edge left its producer loose; the same splice places it again.
    wired = spliceJoins(wired, `${entropy}:after-loop`, schedulerContext);

    // Said here, where it is true. A scene that never converged reached the state wrapper with two
    // terminals, the wrapper declined for that reason, and the failure came back as "canonical
    // scene-state nodes are unavailable" — a complaint about the catalog, which sends anyone reading
    // it to look for a missing plugin. Placement and joining ran out of room; that is the fact.
    const loose = unabsorbedOutputs(wired);
    if (loose.length !== 1) {
        return {
            ok: false,
            failure: {
                reason: 'grammar',
                detail: `${loose.length} colour outputs reach the canvas unjoined`,
            },
        };
    }

    // Every material previous-frame read drifts (ADR-0016): spliced after the graph settles so
    // the join and prune rounds reason about the material alone, and before the canonical state
    // so its occurrence counting sees the trail warps.
    wired = withTrailWarps(wired, entropy, schedulerContext.available);

    const stateful = withCanonicalState(wired, entropy, schedulerContext.available);
    if (!stateful) {
        return {
            ok: false,
            failure: { reason: 'compile', detail: 'the catalog has no scene-state operators' },
        };
    }
    wired = stateful;

    // How the scene is joined, which counts alone cannot express. Checked after the prune above, so a
    // scene that only reaches two branches by keeping a disconnected one is rejected rather than
    // counted.
    const structural = structuralViolations(wired, theme.grammar);
    if (structural.length > 0) {
        return {
            ok: false,
            failure: {
                reason: 'grammar',
                detail: structural.map((violation) => violation.detail).join('; '),
            },
        };
    }

    const compiled = compileSceneGraph(wired.nodes, wired.edges, wired.present, wired.assetBindings, entropy);
    if (!compiled.ok) {
        return { ok: false, failure: { reason: 'compile', detail: compiled.errors.join('; ') } };
    }

    return { ok: true, plugins, wired, graph: compiled.graph };
}

/**
 * Feeds each leftover branch into an input something already reads, before any mixer is considered.
 *
 * A branch nothing consumes has two possible fates. It can become an argument to a stage that is
 * already in the picture — a spectrum becoming a polygon's edge, a curve becoming a texture's
 * domain, a trace becoming a stencil — or it can be pasted onto the finished image by a mixer the
 * builder adds for the purpose. Only the first composes: `f(g())` puts one branch inside the other's
 * geometry, where a mixer can only put `f() + g()` side by side and hope the eye reads a relation.
 *
 * The builder had only the second, so every leftover branch cost a mixer and every mixer added a
 * layer of pixel arithmetic on top of the picture. Placement runs first and the joins take what is
 * left, which is how the same scenes arrive with fewer mixers and more interaction.
 *
 * A generator's input is preferred over a later stage's, since that is where an argument changes
 * what gets *made* rather than what has already been made; earlier targets are weighted above later
 * ones for the same reason, so a placed branch passes through as much of the chain as possible. A
 * target the branch can already reach is refused: that edge would be a cycle, and where a scene
 * remembers is the loop draw's decision, not a side effect of tidying up branches.
 */
function placeBranches(
    scene: WiredScene,
    entropy: string,
): WiredScene {
    const terminals = unabsorbedOutputs(scene);
    if (terminals.length <= 1) {
        return scene;
    }

    const nodeIndex = new Map(scene.nodes.map((node, index) => [node.instanceId, index]));

    // The composite is whichever terminal sits latest in the chain; the rest are the branches to
    // place. Keeping the latest means placement never reroutes the presentation tail into a
    // generator halfway up the scene.
    const ordered = [...terminals].sort((left, right) =>
        (nodeIndex.get(left.instanceId) ?? 0) - (nodeIndex.get(right.instanceId) ?? 0));
    const branches = ordered.slice(0, -1);

    const edges = [...scene.edges];
    // A port reading its own previous frame is occupied, feedback or not: the trail transport spliced
    // in later turns that read into a forward edge of its own, and a placement sharing the port
    // arrives at the compiler as two connections to an input that accepts one.
    const fed = new Set([
        ...edges.map((edge) => `${edge.to.instanceId}.${edge.to.port}`),
        ...scene.assetBindings.map((binding) => `${binding.instanceId}.${binding.port}`),
    ]);

    /** Instances reachable from a node by forward edges, so a placement cannot close a cycle. */
    const reaches = (instanceId: string): Set<string> => {
        const seen = new Set<string>();
        const stack = [instanceId];
        while (stack.length > 0) {
            const current = stack.pop()!;
            for (const edge of edges) {
                if (edge.feedback || edge.from.instanceId !== current || seen.has(edge.to.instanceId)) {
                    continue;
                }
                seen.add(edge.to.instanceId);
                stack.push(edge.to.instanceId);
            }
        }
        return seen;
    };

    const rng = createRng(`${entropy}:branch-placement`);
    const placed: { instanceId: string; port: string }[] = [];

    for (const branch of branches) {
        const downstream = reaches(branch.instanceId);
        const openings = scene.nodes.flatMap((node) => node.definition.inputs
            .filter((input) =>
                input.type === 'color-texture'
                && !input.required
                && !input.fromAsset
                && !fed.has(`${node.instanceId}.${input.name}`)
                && node.instanceId !== branch.instanceId
                && !downstream.has(node.instanceId))
            .map((input) => ({ node, input })));
        if (openings.length === 0) {
            continue;
        }

        const generators = openings.filter((opening) => opening.node.definition.category === 'source');
        const tier = generators.length > 0 ? generators : openings;
        const depth = scene.nodes.length;
        const opening = rng.weighted(tier, (candidate) =>
            depth - (nodeIndex.get(candidate.node.instanceId) ?? 0)) ?? tier[0];

        edges.push({
            from: branch,
            to: { instanceId: opening.node.instanceId, port: opening.input.name },
        });
        fed.add(`${opening.node.instanceId}.${opening.input.name}`);
        placed.push(branch);
    }

    if (placed.length === 0) {
        return scene;
    }

    // The node list keeps the order wiring gave it. A placement can point an edge backwards through
    // it — a generator taking an argument from a stage declared after it — and execution order is
    // derived from the edges rather than from the list, so the compiler sorts it out. What reads the
    // list is "later in the chain" for the loop draw and the presented output, and there the wiring
    // order is the answer that was wanted: the composite is still the tail of the chain.
    return { ...scene, edges };
}

/**
 * Interposes a drift transport on every material previous-frame image read (ADR-0016).
 *
 * A feedback edge alone gives a plugin memory and no motion: a temporal echo resamples its past at
 * fixed offsets, and a mixer fold-back blends its past with zero displacement — ghosts that pulse
 * in place. The canonical state is the proof of the correct shape: it reads its past *through a
 * transport that displaces by a per-frame step*, so the displacement compounds and the picture
 * travels. This applies that shape to every material loop: `producer -(previous)-> transport ->
 * port`.
 *
 * The transport is drawn from every `SPATIAL_FEEDBACK` plugin whose required inputs the scene can
 * satisfy — the capability's own definition is "a loop through this displaces the image it reads".
 * That is the scene-history warp's four intrinsic modes, `FeedbackFlowTransform`'s nine, and
 * `FieldFeedback` wherever a field exists to steer it, rather than one plugin family standing in
 * for all motion. Field-consuming transports take the freshest field, preferring a dedicated
 * field or simulator output over a side-motion, the same policy the canonical state uses. Each
 * transport is an ordinary instance: distribution draws its features and expressions, its seed
 * sets its drift course. Cycle gains are unchanged — a transport only resamples — so the lossy
 * port that made a loop legal still governs it.
 */
function withTrailWarps(
    material: WiredScene,
    entropy: string,
    catalog: readonly VisualPluginDefinition[],
): WiredScene {
    const fieldOutputs = material.nodes.flatMap((node) => node.definition.outputs
        .filter((output) => isMotionSource(output.type))
        .map((output) => ({
            instanceId: node.instanceId,
            port: output.name,
            type: output.type,
            category: node.definition.category,
        })));
    /** What each node can reach by forward edges, so a transport cannot be steered from below it. */
    const downstreamOf = (instanceId: string): Set<string> => {
        const seen = new Set<string>();
        const stack = [instanceId];
        while (stack.length > 0) {
            const current = stack.pop()!;
            for (const edge of material.edges) {
                if (edge.feedback || edge.from.instanceId !== current || seen.has(edge.to.instanceId)) {
                    continue;
                }
                seen.add(edge.to.instanceId);
                stack.push(edge.to.instanceId);
            }
        }
        return seen;
    };

    /**
     * The freshest field the transport may read, preferring a dedicated field or simulator output
     * over a stage's side-motion — the same policy the canonical state uses.
     *
     * A field produced below the transport's own sink is refused. The transport feeds that sink, so
     * taking its steering from anything the sink reaches closes a forward cycle, and the candidate
     * died in the compiler one stage after the decision that caused it.
     */
    const fieldFor = (
        type: VisualPluginDefinition['inputs'][number]['type'],
        sinkInstanceId?: string,
    ) => {
        const below = sinkInstanceId ? downstreamOf(sinkInstanceId) : new Set<string>();
        const compatible = fieldOutputs.filter((output) =>
            portsCompatible(output.type, type)
            && output.instanceId !== sinkInstanceId
            && !below.has(output.instanceId));
        const dedicated = compatible.filter((output) => ['field', 'simulator'].includes(output.category));
        return [...(dedicated.length > 0 ? dedicated : compatible)].reverse()[0];
    };

    const candidates = catalog.filter((definition) =>
        definition.capabilities.includes(SPATIAL_FEEDBACK)
        && definition.inputs.some((input) => input.required && input.type === 'color-texture')
        && definition.inputs.every((input) =>
            !input.required
            || input.type === 'color-texture'
            || fieldFor(input.type) !== undefined));
    if (candidates.length === 0) {
        return material;
    }

    const occurrences = new Map<string, number>();
    for (const node of material.nodes) {
        occurrences.set(node.definition.id, (occurrences.get(node.definition.id) ?? 0) + 1);
    }

    const rng = createRng(`${entropy}:trail-warps`);
    const nodes = [...material.nodes];
    const edges: RenderGraphEdge[] = [];

    for (const edge of material.edges) {
        const sink = material.nodes.find((node) => node.instanceId === edge.to.instanceId);
        const port = sink?.definition.inputs.find((input) => input.name === edge.to.port);
        // Colour, not every image type. A transport reads and writes a picture, so splicing one onto
        // a loop that closes on a mask input would connect a colour output to a mask port and the
        // candidate would die in the compiler rather than at the decision that caused it.
        const carriesImage = port?.type === 'color-texture';
        if (!edge.feedback || !carriesImage) {
            edges.push(edge);
            continue;
        }

        // Only transports this loop can actually steer: a field-driven one needs a field produced
        // above the sink it feeds, and which fields qualify depends on where in the graph the loop
        // is. Drawn from what is left, so a scene with no field above the sink still gets one of the
        // intrinsic modes rather than an unsatisfiable edge.
        const usable = candidates.filter((definition) => definition.inputs.every((input) =>
            !input.required
            || input.type === 'color-texture'
            || fieldFor(input.type, edge.to.instanceId) !== undefined));
        if (usable.length === 0) {
            edges.push(edge);
            continue;
        }

        const drawn = rng.pick(usable) ?? usable[0];
        // Derived infrastructure, like a joining compositor's DERIVED_JOIN: the transport is here
        // because the builder put it here, and the branch counts must not read it as material.
        const definition: VisualPluginDefinition = drawn.capabilities.includes(DERIVED_STATE)
            ? drawn
            : { ...drawn, capabilities: [...drawn.capabilities, DERIVED_STATE] };
        const occurrence = occurrences.get(definition.id) ?? 0;
        occurrences.set(definition.id, occurrence + 1);
        const transport: GraphNode = {
            instanceId: instanceIdFor(definition, occurrence),
            definition,
        };

        const sourcePort = definition.inputs.find((input) =>
            input.required && input.type === 'color-texture')!;
        nodes.push(transport);
        edges.push(
            { from: edge.from, to: { instanceId: transport.instanceId, port: sourcePort.name }, feedback: true },
            { from: { instanceId: transport.instanceId, port: 'color' }, to: edge.to },
        );

        for (const input of definition.inputs) {
            if (!input.required || input.type === 'color-texture') {
                continue;
            }
            const field = fieldFor(input.type, edge.to.instanceId)!;
            edges.push({
                from: { instanceId: field.instanceId, port: field.port },
                to: { instanceId: transport.instanceId, port: input.name },
            });
        }
    }

    return { ...material, nodes, edges };
}

/**
 * Wraps the fully joined fresh scene in the one graph-owned recursive image state.
 *
 * The state nodes are derived rather than selected. This keeps the invariant independent of which
 * plugin families the scheduler happened to draw and prevents a local plugin self-loop from standing
 * in for scene memory.
 */
function withCanonicalState(
    material: WiredScene,
    entropy: string,
    catalog: readonly VisualPluginDefinition[],
): WiredScene | undefined {
    const terminals = unabsorbedOutputs(material);
    if (terminals.length !== 1) {
        return undefined;
    }

    const fieldOutputs = material.nodes.flatMap((node) => node.definition.outputs
        .filter((output) => isMotionSource(output.type))
        .map((output) => ({ instanceId: node.instanceId, port: output.name, type: output.type })));

    const warpCandidates = catalog.filter((definition) =>
        definition.capabilities.includes(DERIVED_STATE)
        && definition.capabilities.includes('scene-history-warp')
        && definition.inputs.every((input) =>
            !input.required
            || input.type === 'color-texture'
            || fieldOutputs.some((output) => portsCompatible(output.type, input.type))));
    const combineCandidates = catalog.filter((definition) =>
        definition.capabilities.includes(DERIVED_STATE)
        && definition.temporalCombine !== undefined);
    if (warpCandidates.length === 0 || combineCandidates.length === 0) {
        return undefined;
    }

    const rng = createRng(`${entropy}:scene-state`);
    // Two distinct modes in series, when the catalog offers them. A single pure mode has an
    // invariant set — rotation's is circles, drift's is parallel lines, zoom's is rays — and
    // persistent material collapses onto it: the reported "turns into a circle pretty fast,
    // there's no conflicting motion". Composed transports with per-instance pivots have no simple
    // closed orbits, which is where MilkDrop-class wander comes from.
    const firstWarp = rng.pick(warpCandidates) ?? warpCandidates[0];
    const secondCandidates = warpCandidates.filter((candidate) => candidate.id !== firstWarp.id);
    const secondWarp = secondCandidates.length > 0 ? rng.pick(secondCandidates) : undefined;
    const warpDefinitions = secondWarp ? [firstWarp, secondWarp] : [firstWarp];

    // The combine operator is drawn weighted by how much of the frame the material actually
    // covers (ADR-0017): dense scenes lean toward `flow`, whose softened takeover is what keeps
    // motion visible inside bright figures; sparse scenes lean toward `deposit`, whose sub-unity
    // accumulation is invisible on dense >=1 material anyway. Authored density is a poor proxy
    // for coverage in two known shapes — a stencil gates a dense chain down to its mask interior,
    // and glyph/trace scenes author bright but cover little — so those force the sparse reading.
    // No weight reaches zero and flow's is capped, so no scene class is deterministically one
    // operator.
    const materialNodes = material.nodes.filter((node) =>
        !node.definition.capabilities.includes(DERIVED_STATE)
        && node.definition.outputs.some((output) => output.type === 'color-texture'));
    const sparseShape = material.nodes.some((node) =>
        node.definition.id.startsWith('MaskEffectStencil')
        || node.definition.id.startsWith('TransientGlyphSource'))
        || materialNodes
            .filter((node) => node.definition.category === 'source')
            .every((node) =>
                node.definition.id.startsWith('SignalTraceSource')
                || node.definition.id.startsWith('ParametricCurveSource'));
    const density = sparseShape || materialNodes.length === 0
        ? 0.15
        : materialNodes.reduce((sum, node) => sum + node.definition.character.visualDensity, 0)
            / materialNodes.length;
    const combineDefinition = rng.weighted(combineCandidates, (candidate) => {
        switch (candidate.temporalCombine!.operator) {
            case 'flow':
                return Math.min(0.6, 0.15 + density);
            case 'deposit':
                return 0.15 + (1 - density);
            default:
                // `max` is not drawn. A running maximum against displaced history is a morphological
                // dilation: each frame the state takes the brightest value in a neighbourhood the
                // width of one displacement, and repeated for the life of the material that is a
                // smoothing filter as thorough as a blur, built entirely out of operations that
                // never average. Measured across sixteen rendered scenes against each scene's own
                // memory-blanked render, the scenes drawing it kept 14% to 20% of their material's
                // structure while the accumulating operator kept 99% to 123%.
                //
                // Left in the catalog rather than deleted: an authored document may ask for a flash
                // afterimage on purpose, and ADR-0017's arithmetic is what those documents were
                // written against. What stops here is assembly choosing it for a third of all
                // scenes.
                return 0;
        }
    }) ?? combineCandidates[0];
    // Occurrence counted against the material, not assumed zero: trail transports interposed by
    // `withTrailWarps` may already hold instances of the same warp definition.
    const occurrences = new Map<string, number>();
    for (const node of material.nodes) {
        occurrences.set(node.definition.id, (occurrences.get(node.definition.id) ?? 0) + 1);
    }
    const instanceFor = (definition: VisualPluginDefinition): GraphNode => {
        const occurrence = occurrences.get(definition.id) ?? 0;
        occurrences.set(definition.id, occurrence + 1);
        return { instanceId: instanceIdFor(definition, occurrence), definition };
    };

    const warps = warpDefinitions.map(instanceFor);
    const combine = instanceFor(combineDefinition);
    const contract = combineDefinition.temporalCombine!;
    if (warps.some((warp) => !warp.definition.inputs.some((input) => input.name === 'source'))) {
        return undefined;
    }

    const edges = [
        ...material.edges,
        {
            from: terminals[0],
            to: { instanceId: combine.instanceId, port: contract.sourceInput },
        },
        // The previous state enters the first warp; each warp feeds the next; the last returns
        // through the combine's history input. `analyzeSceneState` verifies the chain by
        // reachability, so the canonical form is unchanged: one previous-frame read of the state,
        // however many displacements it passes through on the way back.
        {
            from: { instanceId: combine.instanceId, port: contract.output },
            to: { instanceId: warps[0].instanceId, port: 'source' },
            feedback: true,
        },
        ...warps.slice(1).map((warp, index) => ({
            from: { instanceId: warps[index].instanceId, port: 'color' },
            to: { instanceId: warp.instanceId, port: 'source' },
        })),
        {
            from: { instanceId: warps[warps.length - 1].instanceId, port: 'color' },
            to: { instanceId: combine.instanceId, port: contract.historyInput },
        },
    ];

    for (const warp of warps) {
        const fieldInput = warp.definition.inputs.find((input) => isMotionSource(input.type));
        if (!fieldInput) {
            continue;
        }
        // A dedicated field plugin's output over a transformer's side-motion, freshest within the
        // preferred class. The reverse-order search alone took whatever motion output happened to
        // sit last in the node order, which was regularly a post-processing stage's side-motion —
        // weak where a procedural field is strong.
        const byInstance = new Map(material.nodes.map((node) => [node.instanceId, node]));
        const compatible = fieldOutputs.filter((output) =>
            portsCompatible(output.type, fieldInput.type));
        const fieldCategory = compatible.filter((output) =>
            ['field', 'simulator'].includes(byInstance.get(output.instanceId)?.definition.category ?? ''));
        const field = [...(fieldCategory.length > 0 ? fieldCategory : compatible)].reverse()[0];
        if (!field) {
            return undefined;
        }
        edges.push({
            from: { instanceId: field.instanceId, port: field.port },
            to: { instanceId: warp.instanceId, port: fieldInput.name },
        });
    }

    return {
        ...material,
        nodes: [...material.nodes, ...warps, combine],
        edges,
        present: { instanceId: combine.instanceId, port: contract.displayOutput ?? contract.output },
    };
}

function buildSceneAttempt(
    entropy: string,
    theme: VisualTheme,
    context: SceneBuildContext,
    profile: QualityProfile,
): SceneBuildResult {
    const effectiveTheme: VisualTheme = profile.reducedGrammar
        ? { ...theme, grammar: REDUCED_GRAMMAR }
        : theme;

    const schedulerContext: SchedulerContext = {
        ...context,
        theme: effectiveTheme,
        allowHighCost: profile.expensivePrimary,
        allowDominant: profile.expensivePrimary,
    };

    const assembled = assembleScene(entropy, schedulerContext);
    if (assembled.violations.length > 0) {
        return {
            ok: false,
            failure: {
                reason: 'grammar',
                detail: assembled.violations.map((violation) => violation.detail).join('; '),
            },
        };
    }

    const settled = settleScene(assembled.plugins, entropy, effectiveTheme, context, schedulerContext);
    if (!settled.ok) {
        return settled;
    }

    const { plugins, wired, graph } = settled;

    let bindings = applyColourPolicy(
        distributeReactivity(wired.nodes, createRng(`${entropy}:bindings`)),
        effectiveTheme.colorPolicy,
    );

    // Transport budgeting. Displacement per second times seconds of memory is smear length, and
    // the escalations that made speed reachable — a composed pair of canonical warps whose
    // displacements add, widened strength ranges, trail transports at the same range — were each
    // verified alone and never jointly: their sum diffused every scene into fog ("did you
    // oversmooth everything into oblivion"). The budget: the canonical CHAIN shares one strength
    // range (each member scaled by 1/chain-length), trail transports ride at a fraction of it
    // (accents, not the state transport), and the flow floor applies to the canonical chain only.
    const combineNode = wired.nodes.find((node) => node.definition.temporalCombine !== undefined);
    const isFlow = combineNode?.definition.temporalCombine?.operator === 'flow';
    // Canonical = a derived warp whose forward path reaches the combine (directly or through the
    // rest of the chain). Trail transports are derived and displacing too, but their forward
    // edges land on material sinks, not the combine.
    const canonicalWarpIds = new Set<string>();
    if (combineNode) {
        let grew = true;
        while (grew) {
            grew = false;
            for (const edge of wired.edges) {
                if (edge.feedback) continue;
                const from = wired.nodes.find((n) => n.instanceId === edge.from.instanceId);
                if (!from?.definition.capabilities.includes(DERIVED_STATE)
                    || !displacesHistory(from.definition)
                    || canonicalWarpIds.has(from.instanceId)) continue;
                // Colour edges only: a trail transport whose MOTION output steers the canonical
                // field warp is not part of the chain, and sweeping it in handed it the chain's
                // scaled flow floor — a collapsed [0.1, 0.1] range on a per-frame-scaled plugin,
                // six frame-widths a second of fog.
                const sink = wired.nodes.find((n) => n.instanceId === edge.to.instanceId);
                const sinkPort = sink?.definition.inputs.find((input) => input.name === edge.to.port);
                if (sinkPort?.type !== 'color-texture') continue;
                if (edge.to.instanceId === combineNode.instanceId
                    || canonicalWarpIds.has(edge.to.instanceId)) {
                    canonicalWarpIds.add(from.instanceId);
                    grew = true;
                }
            }
        }
    }
    const chainLength = Math.max(1, canonicalWarpIds.size);
    const FLOW_STRENGTH_FLOOR = 0.3;
    const TRAIL_STRENGTH_SCALE = 0.35;

    bindings = bindings.map((entry) => {
        const node = wired.nodes.find((candidate) => candidate.instanceId === entry.instanceId);
        if (!node
            || !node.definition.capabilities.includes(DERIVED_STATE)
            || !displacesHistory(node.definition)) {
            return entry;
        }
        const canonical = canonicalWarpIds.has(entry.instanceId);

        return {
            ...entry,
            bindings: entry.bindings.map((binding) => {
                if (binding.parameter !== 'strength' || binding.outputRange[0] < 0) {
                    return binding;
                }
                let [low, high] = binding.outputRange;
                if (canonical) {
                    low /= chainLength;
                    high /= chainLength;
                    if (isFlow) {
                        low = Math.max(low, FLOW_STRENGTH_FLOOR / chainLength);
                        high = Math.max(high, FLOW_STRENGTH_FLOOR / chainLength);
                    }
                } else {
                    low *= TRAIL_STRENGTH_SCALE;
                    high *= TRAIL_STRENGTH_SCALE;
                }
                return { ...binding, outputRange: [low, high] as [number, number] };
            }),
        };
    });

    return {
        ok: true,
        scene: {
            entropy,
            theme: effectiveTheme,
            plugins,
            wired,
            graph,
            bindings,
            // The theme's colour policy reaches the plugins that map colour, so a theme asking for the
            // album palette at full strength actually gets it.
            parameterOverrides: instanceOverrides(wired, effectiveTheme.colorPolicy),
        },
    };
}

/**
 * Splices a mixer into the chain for each branch placement could not find an input for.
 *
 * Joining N branches into one takes N-1 two-input mixers, and nothing was doing that arithmetic: the
 * grammar drew a compositor count from a range and whatever did not fit was left for the layer stack
 * to sum. The count is derived here instead, from what the wiring actually left over.
 *
 * The mixer is spliced into an edge rather than appended to the plugin list. Appended, it went back
 * through wiring, and wiring answered "which two outputs does this mixer read" with the same
 * newest-and-unconsumed search it uses for everything else — which, once the unconsumed outputs ran
 * out, handed the mixer two views of one branch. Measured over 240 builds, 36% of derived joins read
 * a branch together with its own ancestor. Two mixers of that kind in series multiply a bright figure
 * by four and the tone map clamps the rest, which is the scene that came back black with white
 * flashes.
 *
 * Spliced, the two operands are the edge's own producer and the leftover branch, and the branch is a
 * terminal — nothing reads it — so it can be neither an ancestor nor a descendant of the chain it
 * joins as long as the splice point cannot reach it, which is the one condition checked below. A
 * scene with nothing eligible is left as it was, and `structuralViolations` rejects it — the honest
 * outcome for a catalog that cannot join what the grammar asked it to draw.
 *
 * The earliest legal splice point is favoured, so an absorbed branch passes through the transforms,
 * the grade and the palette rather than being pasted onto the finished picture.
 */
function spliceJoins(
    scene: WiredScene,
    entropy: string,
    context: SchedulerContext,
): WiredScene {
    const terminals = unabsorbedOutputs(scene);
    if (terminals.length <= 1) {
        return scene;
    }

    const eligible = context.available.filter((definition) =>
        isBranchJoiner(definition)
        && definition.inputs.every((input) => !input.required || input.type === 'color-texture')
        && !(context.theme.excludedPlugins ?? []).includes(definition.id));
    if (eligible.length === 0) {
        return scene;
    }

    const nodeIndex = new Map(scene.nodes.map((node, index) => [node.instanceId, index]));
    const byInstance = new Map(scene.nodes.map((node) => [node.instanceId, node]));
    const occurrences = new Map<string, number>();
    for (const node of scene.nodes) {
        occurrences.set(node.definition.id, (occurrences.get(node.definition.id) ?? 0) + 1);
    }

    const nodes = [...scene.nodes];
    let edges = [...scene.edges];

    const reachesIn = (
        pool: readonly RenderGraphEdge[],
        instanceId: string,
        colourOnly = false,
    ): Set<string> => {
        const seen = new Set<string>();
        const stack = [instanceId];
        while (stack.length > 0) {
            const current = stack.pop()!;
            for (const edge of pool) {
                if (edge.feedback || edge.from.instanceId !== current || seen.has(edge.to.instanceId)) {
                    continue;
                }
                if (colourOnly) {
                    const sink = byInstance.get(edge.to.instanceId);
                    const port = sink?.definition.inputs.find((input) => input.name === edge.to.port);
                    if (port?.type !== 'color-texture') {
                        continue;
                    }
                }
                seen.add(edge.to.instanceId);
                stack.push(edge.to.instanceId);
            }
        }
        return seen;
    };
    const reaches = (instanceId: string) => reachesIn(edges, instanceId);

    /**
     * Whether a proposed edge set has a forward cycle in it.
     *
     * Checked for the same reason the operand test is: a splice is acyclic in the graph it was
     * measured against, and the next splice changes that graph. Two candidates in 240 reached the
     * compiler with an undeclared cycle and were discarded there, one stage after the decision that
     * made them.
     */
    const closesCycle = (pool: readonly RenderGraphEdge[]): boolean => {
        const indegree = new Map<string, number>();
        const forward = pool.filter((edge) => !edge.feedback);
        for (const edge of forward) {
            indegree.set(edge.to.instanceId, (indegree.get(edge.to.instanceId) ?? 0) + 1);
        }
        const participants = new Set(forward.flatMap((edge) =>
            [edge.from.instanceId, edge.to.instanceId]));
        const ready = [...participants].filter((id) => (indegree.get(id) ?? 0) === 0);
        let settled = 0;
        while (ready.length > 0) {
            const current = ready.shift()!;
            settled += 1;
            for (const edge of forward) {
                if (edge.from.instanceId !== current) {
                    continue;
                }
                const remaining = (indegree.get(edge.to.instanceId) ?? 0) - 1;
                indegree.set(edge.to.instanceId, remaining);
                if (remaining === 0) {
                    ready.push(edge.to.instanceId);
                }
            }
        }

        return settled !== participants.size;
    };

    /**
     * Whether every mixer in a proposed graph still reads two independent pictures.
     *
     * Checked against the result rather than at the moment of each splice, because a splice is only
     * legal in the graph it lands in. Two branches entering the same chain is the case: the second
     * splice sits upstream of the first, so material the first mixer had on one input arrives on its
     * other input too, and a splice that was independent when it was made is not independent
     * afterwards. Colour paths only — a branch steering another's motion field is composition, not
     * the same picture counted twice.
     */
    const operandsIndependent = (
        pool: readonly RenderGraphEdge[],
        nodeList: readonly GraphNode[],
    ): boolean => !closesCycle(pool) && nodeList.filter((node) => isDerivedJoin(node.definition)).every((join) => {
        const operands = pool.filter((edge) =>
            !edge.feedback
            && edge.to.instanceId === join.instanceId
            && join.definition.inputs
                .find((input) => input.name === edge.to.port)?.type === 'color-texture');

        return operands.every((operand) => operands.every((other) =>
            operand === other
            || (operand.from.instanceId !== other.from.instanceId
                && !reachesIn(pool, other.from.instanceId, true).has(operand.from.instanceId))));
    });

    const ordered = [...terminals].sort((left, right) =>
        (nodeIndex.get(left.instanceId) ?? 0) - (nodeIndex.get(right.instanceId) ?? 0));
    let composite = ordered[ordered.length - 1];
    // Bounded so a pathological candidate cannot turn into a scene of mixers. A candidate needing
    // more joins than this is left unconverged and rejected by `structuralViolations`, and another of
    // the thirty-two is tried — which is the right shape: assembly settles on scenes it can actually
    // join rather than paying a pass per leftover branch.
    const branches = ordered.slice(0, -1).slice(0, MAXIMUM_DERIVED_JOINS);

    const rng = createRng(`${entropy}:join`);

    for (const branch of branches) {
        // Where the branch enters. A forward colour edge that neither reaches the branch nor is
        // reached by it: the first would make the splice a cycle, since the mixer's output feeds the
        // edge's sink, and the second would put the branch on both of the mixer's inputs — the same
        // material added to itself, which is the gain chain this rebuild exists to remove. Earliest
        // first, so the mixed result still has the chain's remaining stages to pass through.
        const fromBranch = reachesIn(edges, branch.instanceId, true);
        const points = edges
            .filter((edge) => {
                if (edge.feedback) {
                    return false;
                }
                const sink = byInstance.get(edge.to.instanceId);
                const port = sink?.definition.inputs.find((input) => input.name === edge.to.port);
                if (port?.type !== 'color-texture' || port.structural) {
                    return false;
                }
                if (edge.from.instanceId === branch.instanceId
                    || fromBranch.has(edge.from.instanceId)) {
                    return false;
                }
                return !reaches(edge.from.instanceId).has(branch.instanceId);
            })
            .sort((left, right) =>
                (nodeIndex.get(left.to.instanceId) ?? 0) - (nodeIndex.get(right.to.instanceId) ?? 0));

        // Weighted rather than uniform, and drawn fresh for each branch, so a scene needing three
        // joins can use three different operators. Repeats are allowed: two mixers of one mode
        // joining different pairs of branches is a composition, not a duplicate.
        const drawn = rng.weighted(eligible, (definition) => definition.activationRules.activationWeight)
            ?? eligible[0];
        const definition: VisualPluginDefinition = {
            ...drawn,
            capabilities: [...drawn.capabilities, DERIVED_JOIN],
        };
        const occurrence = occurrences.get(definition.id) ?? 0;
        const join: GraphNode = { instanceId: instanceIdFor(definition, occurrence), definition };
        const colourInputs = definition.inputs.filter((input) => input.type === 'color-texture');
        const output = definition.outputs.find((port) => port.type === 'color-texture')!;
        const proposedNodes = [...nodes, join];
        byInstance.set(join.instanceId, join);

        // The splice point nearest the start of the chain that leaves every mixer in the scene —
        // this one and the ones already placed — reading two independent pictures.
        const spliced = points
            .map((point) => [
                ...edges.filter((edge) => edge !== point),
                { from: point.from, to: { instanceId: join.instanceId, port: colourInputs[0].name } },
                { from: branch, to: { instanceId: join.instanceId, port: colourInputs[1].name } },
                { from: { instanceId: join.instanceId, port: output.name }, to: point.to },
            ])
            .find((proposal) => operandsIndependent(proposal, proposedNodes));

        if (spliced) {
            edges = spliced;
            nodes.push(join);
            nodeIndex.set(join.instanceId, nodeIndex.get(composite.instanceId) ?? nodes.length);
            occurrences.set(definition.id, occurrence + 1);
            continue;
        }

        // Nowhere legal to splice, so the join takes the composite itself and becomes the new one.
        // This is the whole of what the old derivation could do; here it is the fallback for a scene
        // whose chain is a single node.
        const appended = [
            ...edges,
            { from: composite, to: { instanceId: join.instanceId, port: colourInputs[0].name } },
            { from: branch, to: { instanceId: join.instanceId, port: colourInputs[1].name } },
        ];
        if (!operandsIndependent(appended, proposedNodes)) {
            // The fallback would mix the composite with material already inside it. The branch stays
            // loose, the scene fails its terminal count, and one of the other candidates is built
            // instead — cheaper than shipping a doubled operand.
            byInstance.delete(join.instanceId);
            continue;
        }

        edges = appended;
        nodes.push(join);
        nodeIndex.set(join.instanceId, nodeIndex.get(composite.instanceId) ?? nodes.length);
        occurrences.set(definition.id, occurrence + 1);
        composite = { instanceId: join.instanceId, port: output.name };
    }

    return { ...scene, nodes, edges };
}

/**
 * How many joins the builder will add before giving up on a candidate.
 *
 * Six two-input mixers converge seven branches, which is above the widest scene the grammars produce.
 * A candidate past that is not a scene needing help; it is a draw that scattered, and rejecting it
 * costs one of thirty-two attempts.
 */
const MAXIMUM_DERIVED_JOINS = 6;

/**
 * How many times joining and pruning may feed each other before the candidate is abandoned.
 *
 * Each round either adds joins or removes plugins, so a scene that has not settled by the fourth is
 * oscillating rather than converging, and the assembler has thirty-one other candidates to try.
 */
const ASSEMBLY_ROUNDS = 4;

/**
 * Structural checks the grammar can only make once the scene is wired.
 *
 * Category counts describe what a scene contains; these describe how it is joined. A compositor
 * reading one branch twice satisfies every count and composes nothing, which is the difference
 * between a scene that reads as one composition and a scene that merely has the right parts.
 */
export function structuralViolations(
    scene: WiredScene,
    grammar: SceneGrammar,
): GrammarViolation[] {
    const violations: GrammarViolation[] = [];

    const branches = materialBranchCount(scene);
    if (branches < grammar.minimumMaterialBranches) {
        violations.push({
            kind: 'too-few-branches',
            detail: `${branches} material branches below ${grammar.minimumMaterialBranches}`,
        });
    }

    // Counted as edges rather than as plugins carrying a capability. The two agree while each
    // loop-closing plugin nominates one port, and the edge is what a plugin with two of them, or an
    // authored graph, would disagree with the count on. See ADR-0012.
    //
    // Image loops only. `ParticleEmitter`, `ParticleForceField`, and `ParticleCollider` each declare
    // a `previous` port so they can chain — each reads the list built so far — and the first in a
    // chain has no upstream producer, so wiring closes it on itself. That is a harmless empty read
    // of a value port, not a picture fed back into a picture, and counting it put four loops in a
    // family whose ceiling is one.
    const imageLoops = scene.edges.filter((edge) => {
        if (!edge.feedback) {
            return false;
        }

        const sink = scene.nodes.find((node) => node.instanceId === edge.to.instanceId);
        const port = sink?.definition.inputs.find((input) => input.name === edge.to.port);

        return port !== undefined && isImagePortType(port.type);
    });
    // The canonical state loop counts toward the minimum — a scene holding only it is legal — but
    // not against the ceiling, which is a character budget on the material loops a family keeps
    // (ADR-0016). Counted against the ceiling, the infrastructure loop consumed the whole budget
    // of a one-loop grammar and no scene was permitted any material memory of its own.
    const materialLoops = imageLoops.filter((edge) => {
        const sink = scene.nodes.find((node) => node.instanceId === edge.to.instanceId);
        return !sink?.definition.capabilities.includes(DERIVED_STATE);
    });
    if (imageLoops.length < grammar.minimumFeedbackLoops) {
        violations.push({
            kind: 'too-few-feedback',
            detail: `${imageLoops.length} loops below ${grammar.minimumFeedbackLoops}`,
        });
    }
    if (materialLoops.length > grammar.maximumFeedbackLoops) {
        violations.push({
            kind: 'too-many-feedback',
            detail: `${materialLoops.length} material loops exceed ${grammar.maximumFeedbackLoops}`,
        });
    }

    // One image at the composite.
    //
    // Every colour output nothing reads becomes a layer, and the layer stack sums them — so each one
    // past the first is material that reached the canvas without passing through a transform, a
    // mixer, or the scene's loop. Measured before this check existed: a median of three, and the
    // waveform sources unabsorbed about three hundred times in four hundred scenes, which is a
    // spectrum drawn flat across a picture it never interacts with.
    const terminals = unabsorbedOutputs(scene).length;
    if (terminals > 1) {
        violations.push({
            kind: 'too-many-terminals',
            detail: `${terminals} colour outputs reach the canvas unjoined`,
        });
    }

    // A field has to reach something that reads it.
    //
    // This asked whether the scene *contained* a spatial field, which was the right question while a
    // kernel pass summed every one of them whether or not anything was wired to it. ADR-0008 adopted
    // that partly to stop assembly producing orphans and recorded that closing it properly belonged
    // to a predicate about consumption. With the bus retired, a field nothing reads is a pass drawn
    // into a texture that is sampled by nothing.
    if (grammar.requireMotionSource && !consumesMotion(scene)) {
        violations.push({
            kind: 'no-motion-source',
            detail: 'no spatial field reaches a consumer',
        });
    }

    // A loop that only mixes colour gives the scene a memory and no motion. Once the kernel stops
    // dragging the accumulation itself, this is the difference between a picture that flows and one
    // that fades.
    if (grammar.requireSpatialLoop && !imageLoops.some((edge) => {
        const sink = scene.nodes.find((node) => node.instanceId === edge.to.instanceId);
        return sink !== undefined && displacesHistory(sink.definition);
    })) {
        violations.push({
            kind: 'no-spatial-loop',
            detail: 'no loop displaces the image it reads',
        });
    }

    return violations;
}

/** Whether any edge in the scene carries a spatial field from its producer to something that reads it. */
export function consumesMotion(scene: WiredScene): boolean {
    return scene.edges.some((edge) => {
        const producer = scene.nodes.find((node) => node.instanceId === edge.from.instanceId);
        const port = producer?.definition.outputs.find((output) => output.name === edge.from.port);

        return port !== undefined && isMotionSource(port.type);
    });
}

/**
 * Where the picture's material comes into being: colour producers that consume no colour.
 *
 * A branch is a root of the colour graph, not any node on one. Two earlier versions of this counted
 * nodes instead, and each time the excluded set was widened by one category rather than the question
 * being asked properly. First every compositor counted itself, so one source plus one mixer reported
 * two branches; that was fixed by excluding compositors and post-processing, and the count stayed
 * wrong in the same way for transformers — every warp, tile, symmetry and shockwave in the catalog
 * outputs a colour texture, so a single source pushed through four stages reported five branches and
 * satisfied a minimum of three while composing one.
 *
 * Measured over 300 scenes before this was corrected: the old count read 5 or 6 in most scenes, never
 * below its minimum of 3, while the number of actual roots was 1 in fifteen scenes and 2 in
 * sixty-one. A quarter of everything built was a single chain wearing the shape of a composition.
 *
 * A feedback edge does not disqualify a root — a producer reading its own last frame is still where
 * new material enters. Only a forward colour edge makes a node a stage in somebody else's branch.
 */
export function materialBranchCount(scene: WiredScene): number {
    const colourSinks = new Set(
        scene.edges
            .filter((edge) => !edge.feedback)
            .filter((edge) => {
                const sink = scene.nodes.find((node) => node.instanceId === edge.to.instanceId);
                const port = sink?.definition.inputs.find((input) => input.name === edge.to.port);

                return port?.type === 'color-texture';
            })
            .map((edge) => edge.to.instanceId),
    );

    const roots = new Set<string>();

    for (const node of scene.nodes) {
        const producesColour = node.definition.outputs.some((port) => port.type === 'color-texture');

        // A source stays a root even when it consumes colour: a structural input (another
        // branch's image becoming this generator's edge, interior, or domain) makes the
        // generator higher-order, not derivative — material still enters here. Without this,
        // every structural edge cost the scene a branch and nesting was rejected by the
        // minimum-branches grammar it exists to enrich.
        if (
            producesColour
            && !node.definition.capabilities.includes(DERIVED_STATE)
            && (node.definition.category === 'source' || !colourSinks.has(node.instanceId))
        ) {
            roots.add(node.instanceId);
        }
    }

    return roots.size;
}

/**
 * Plugin ids that reach the screen, either through a terminal colour output or through the motion bus.
 *
 * Feedback edges are dependencies but do not make an output intermediate: a feedback texture may be
 * both read next frame and presented now. Forward consumers do make an output intermediate.
 *
 * A spatial field is a contributor whether or not anything in the graph reads it, because the
 * compositor sums every one of them into the motion field that drags the accumulation. Judging
 * contribution by colour paths alone would prune exactly the fields that move the picture.
 */
export function contributingPluginIds(scene: WiredScene): Set<string> {
    const instances = contributingInstanceIds(scene);

    return new Set(
        scene.nodes
            .filter((node) => instances.has(node.instanceId))
            .map((node) => node.definition.id),
    );
}

/**
 * The same question asked of instances, which is the grain the prune has to act on.
 *
 * Answered as definition ids, a scene holding two warps of one mode where only one is connected
 * reported that definition as contributing and kept both, or — once the connected one was the second
 * instance — reported neither and dropped the pair. The definitions are what the plugin list holds,
 * so the prune counts these back into it rather than testing membership.
 */
export function contributingInstanceIds(scene: WiredScene): Set<string> {
    const forwardConsumed = new Set(
        scene.edges
            .filter((edge) => !edge.feedback)
            .map((edge) => `${edge.from.instanceId}.${edge.from.port}`),
    );
    const contributingInstances = new Set<string>();

    for (const node of scene.nodes) {
        // A spatial field used to seed this set unconditionally, because the compositor summed every
        // one of them into the motion bus whether or not the graph read it — so judging contribution
        // by paths through the graph would have pruned exactly the plugins that moved the picture.
        // With the bus retired (ADR-0012) that is no longer true in either direction: a field
        // reaches the picture through an edge like everything else, and one nothing reads is a pass
        // drawn into a texture that is sampled by nothing.
        const hasTerminalColour = node.definition.outputs.some((port) =>
            port.type === 'color-texture'
            && !forwardConsumed.has(`${node.instanceId}.${port.name}`));

        if (hasTerminalColour) {
            contributingInstances.add(node.instanceId);
        }
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const edge of scene.edges) {
            if (
                contributingInstances.has(edge.to.instanceId)
                && !contributingInstances.has(edge.from.instanceId)
            ) {
                contributingInstances.add(edge.from.instanceId);
                changed = true;
            }
        }
    }

    return contributingInstances;
}

/**
 * Tries each theme in turn and returns the first that builds.
 *
 * A theme whose grammar the current catalog cannot satisfy fails rather than producing a broken scene,
 * so falling through to the next one is how the visualizer stays usable while the catalog is still
 * being filled in.
 */
export function buildFirstViableScene(
    entropy: string,
    themes: readonly VisualTheme[],
    context: SceneBuildContext,
    profile: QualityProfile,
): SceneBuildResult {
    let lastFailure: SceneBuildFailure = { reason: 'grammar', detail: 'no themes supplied' };

    for (const theme of themes) {
        const result = buildScene(entropy, theme, context, profile);
        if (result.ok) {
            return result;
        }

        lastFailure = result.failure;
    }

    return { ok: false, failure: lastFailure };
}

/**
 * Varies family priority for each freshly generated scene.
 *
 * Fallback still needs an order, but a static one made the first viable family monopolize every track.
 * The entropy originates from a new browser UUID, so this is not a track-to-theme mapping.
 */
export function variedThemeOrder(
    entropy: string,
    themes: readonly VisualTheme[],
): VisualTheme[] {
    return createRng(`${entropy}:themes`).shuffle(themes);
}
