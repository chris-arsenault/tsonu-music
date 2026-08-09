/**
 * Scene construction: assemble, distribute reactivity, wire, compile.
 *
 * One place that turns per-scene entropy plus a theme into something the runtime can execute, so the
 * host does not have to know the order these steps go in. Pure, so the whole pipeline is testable end
 * to end without a GL context.
 */

import { distributeReactivity, type DistributedBinding } from './audio-mapping';
import { compileGraph, type CompiledGraph } from './graph';
import {
    DERIVED_JOIN,
    displacesHistory,
    grammarViolations,
    REDUCED_GRAMMAR,
    type GrammarViolation,
    type SceneGrammar,
} from './grammar';
import { isMotionSource } from './fields';
import type { QualityProfile } from './performance';
import type { VisualPluginDefinition } from './plugin';
import { createRng, type Rng } from './random';
import { assembleScene, type SchedulerContext, type VisualTheme } from './scheduler';
import {
    isBranchJoiner,
    isImagePortType,
    unabsorbedOutputs,
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
    const rewire = () => wireScene(
        plugins,
        context.assetResources ?? [],
        createRng(`${entropy}:loops`),
        theme.grammar.maximumFeedbackLoops,
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

    // Joining and pruning are each other's input, so they run together until neither changes anything.
    //
    // Joining first was already necessary: contribution is defined by what reaches a terminal, so a
    // plugin feeding a branch about to be absorbed reads as contributing to nothing if the join has
    // not happened yet, and the prune takes the field count with it. The reverse is just as true and
    // was not handled — pruning rewires, rewiring can split the branches back apart, and the join
    // count was computed for a graph that no longer exists. `widen-2` on collision-energy arrived at
    // the structural check with two unjoined terminals for exactly that reason.
    //
    // The prune within a round repeats too, because dropping one plugin can strand the plugin that
    // fed it. `unreachableInstances` had already learned this at render time.
    for (let round = 0; round < ASSEMBLY_ROUNDS; round += 1) {
        const joined = withJoiningCompositors(
            plugins,
            wired,
            schedulerContext,
            createRng(`${entropy}:join`),
        );

        if (joined.length !== plugins.length) {
            plugins = joined;
            wired = rewire();
        }

        // Category counts alone are not enough: an optional field can be selected without anything
        // ever reading it. Keep only plugins that contribute to a terminal colour layer, then
        // re-check the grammar so an allegedly full scene cannot spend passes on disconnected
        // decoration. Compared against the number of distinct definitions in the scene, not the
        // number of nodes: `contributingPluginIds` returns definition ids, so two instances of one
        // definition made the set smaller than the node count on their own.
        let pruned = false;
        for (let pass = 0; pass < plugins.length; pass += 1) {
            const contributing = contributingPluginIds(wired);
            const distinctDefinitions = new Set(wired.nodes.map((node) => node.definition.id)).size;
            if (contributing.size >= distinctDefinitions) {
                break;
            }

            plugins = plugins.filter((definition) => contributing.has(definition.id));
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

            // The same draw, so a prune does not silently move every loop in the scene.
            wired = rewire();
            pruned = true;
        }

        // A round that pruned nothing leaves its own join valid, so there is nothing to re-derive and
        // the usual scene costs exactly what it did before this loop existed: one join, one wiring,
        // one contribution check. Only a scene that lost a plugin pays for a second round.
        if (!pruned) {
            break;
        }
    }

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

    const compiled = compileGraph(wired.nodes, wired.edges, wired.present, wired.assetBindings);
    if (!compiled.ok) {
        return { ok: false, failure: { reason: 'compile', detail: compiled.errors.join('; ') } };
    }

    return { ok: true, plugins, wired, graph: compiled.graph };
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

    return {
        ok: true,
        scene: {
            entropy,
            theme: effectiveTheme,
            plugins,
            wired,
            graph,
            bindings: applyColourPolicy(
                distributeReactivity(wired.nodes, createRng(`${entropy}:bindings`)),
                effectiveTheme.colorPolicy,
            ),
            // The theme's colour policy reaches the plugins that map colour, so a theme asking for the
            // album palette at full strength actually gets it.
            parameterOverrides: instanceOverrides(wired, effectiveTheme.colorPolicy),
        },
    };
}

/**
 * Adds one branch-joining compositor per unabsorbed colour output beyond the first.
 *
 * Joining N branches into one takes N-1 two-input mixers, and nothing was doing that arithmetic: the
 * grammar drew a compositor count from a range and whatever did not fit was left for the layer stack
 * to sum. The count is derived here instead, from what the wiring actually left over.
 *
 * The joiners are drawn from the catalog by the same interaction weight the scheduler uses, so a
 * scene's joins are as characterful as the rest of its choices rather than always the same mixer. A
 * scene with nothing eligible is left as it was, and `structuralViolations` rejects it — which is the
 * honest outcome for a catalog that cannot join what the grammar asked it to draw.
 */
function withJoiningCompositors(
    plugins: readonly VisualPluginDefinition[],
    wired: WiredScene,
    context: SchedulerContext,
    rng: Rng,
): VisualPluginDefinition[] {
    const needed = unabsorbedOutputs(wired).length - 1;
    if (needed <= 0) {
        return [...plugins];
    }

    const eligible = context.available.filter((definition) =>
        isBranchJoiner(definition)
        && !(context.theme.excludedPlugins ?? []).includes(definition.id));

    if (eligible.length === 0) {
        return [...plugins];
    }

    // Bounded so a pathological candidate cannot turn into a scene of mixers. A candidate needing
    // more joins than this is left unconverged and rejected by `structuralViolations`, and another of
    // the thirty-two is tried — which is the right shape: assembly settles on scenes it can actually
    // join rather than paying a pass per leftover branch.
    const limit = Math.min(needed, MAXIMUM_DERIVED_JOINS);

    const added: VisualPluginDefinition[] = [];
    for (let index = 0; index < limit; index += 1) {
        // Weighted rather than uniform, and drawn fresh each time, so a scene needing three joins can
        // use three different operators. Repeats are allowed: two mixers of one mode joining different
        // pairs of branches is a legitimate composition, not a duplicate.
        const drawn = rng.weighted(eligible, (definition) => definition.activationRules.activationWeight)
            ?? eligible[0];

        added.push({
            ...drawn,
            capabilities: [...drawn.capabilities, DERIVED_JOIN],
        });
    }

    return [...plugins, ...added];
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
    const loops = scene.edges.filter((edge) => {
        if (!edge.feedback) {
            return false;
        }

        const sink = scene.nodes.find((node) => node.instanceId === edge.to.instanceId);
        const port = sink?.definition.inputs.find((input) => input.name === edge.to.port);

        return port !== undefined && isImagePortType(port.type);
    });
    if (loops.length < grammar.minimumFeedbackLoops) {
        violations.push({
            kind: 'too-few-feedback',
            detail: `${loops.length} loops below ${grammar.minimumFeedbackLoops}`,
        });
    }
    if (loops.length > grammar.maximumFeedbackLoops) {
        violations.push({
            kind: 'too-many-feedback',
            detail: `${loops.length} loops exceed ${grammar.maximumFeedbackLoops}`,
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
    if (grammar.requireSpatialLoop && !loops.some((edge) => {
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

        if (producesColour && !colourSinks.has(node.instanceId)) {
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

    return new Set(
        scene.nodes
            .filter((node) => contributingInstances.has(node.instanceId))
            .map((node) => node.definition.id),
    );
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
