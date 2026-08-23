/**
 * Activation scheduler (spec sections 14, 16, 17).
 *
 * Assembles scenes from grammar plus character rather than picking whatever is compatible, then
 * evolves them by incremental mutation. The host supplies fresh entropy for every new scene.
 */

import { clamp01 } from './bindings';
import {
    DERIVED_STATE,
    declaresCapability,
    displacesHistory,
    grammarViolations,
    isConfigurationNode,
    isSpatialField,
    isVisibleSource,
    producesMotion,
    wouldViolate,
    type SceneGrammar,
} from './grammar';
import { portsCompatible } from './graph';
import {
    isValuePortType,
    type PortType,
    type SelectionCharacter,
    type VisualPluginDefinition,
} from './plugin';
import { createRng, type Rng } from './random';

export interface WeightedPluginPreference {
    pluginId: string;
    weight: number;
}

export type MutationKind = 'parameter' | 'plugin' | 'branch' | 'scene';

export interface MutationPolicy {
    /** Seconds between mutation attempts. */
    intervalSeconds: number;
    /** Relative likelihood of each kind. Scene mutation should stay rare. */
    weights: Record<MutationKind, number>;
    /** A plugin may not be replaced before it has been active this long. */
    minimumPluginAgeSeconds: number;
}

export interface ColorPolicy {
    source: 'album-palette' | 'curated' | 'complementary' | 'time-varying' | 'track-specific';
    /** How strongly the policy overrides plugin-local colour, 0 to 1. */
    strength: number;
}

export interface VisualTheme {
    id: string;
    allowedPlugins?: string[];
    excludedPlugins?: string[];
    preferredPlugins?: WeightedPluginPreference[];
    grammar: SceneGrammar;
    targetCharacter?: Partial<SelectionCharacter>;
    mutationPolicy: MutationPolicy;
    colorPolicy?: ColorPolicy;
}

export interface ActivePluginRecord {
    instanceId: string;
    pluginId: string;
    activationTime: number;
}

export interface SchedulerContext {
    /** Candidate plugins. The scheduler never reaches past this list. */
    available: readonly VisualPluginDefinition[];
    theme: VisualTheme;
    /** Asset ids currently resolvable, for `requiredAssets`. */
    assets: readonly string[];
    /**
     * Port types those assets can be bound to. Structural rather than the wiring type, so selection
     * needs no dependency on the wiring module to know that a loaded mask satisfies a mask input.
     */
    assetResources?: readonly { type: PortType }[];
    /** Capabilities the device offers, for `requiredCapabilities`. */
    capabilities: readonly string[];
    /** Plugin ids used recently, with the playback time they were last deactivated. */
    history: Readonly<Record<string, number>>;
    playbackTime: number;
    /** Excludes high-cost plugins when the performance controller has stepped down. */
    allowHighCost: boolean;
    allowDominant: boolean;
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* -------------------------------------------------------------------------- */

/** Why a plugin cannot be activated right now. Undefined means it can. */
export function ineligibleReason(
    definition: VisualPluginDefinition,
    context: SchedulerContext,
): string | undefined {
    const { theme } = context;

    if (definition.capabilities.includes(DERIVED_STATE)) {
        return 'derived by scene builder';
    }

    if (theme.excludedPlugins?.includes(definition.id)) {
        return 'excluded by theme';
    }

    if (theme.allowedPlugins && !theme.allowedPlugins.includes(definition.id)) {
        return 'not in theme allow list';
    }

    for (const asset of definition.activationRules.requiredAssets ?? []) {
        if (!context.assets.includes(asset)) {
            return `missing asset ${asset}`;
        }
    }

    const required = definition.requiredCapabilities ?? definition.activationRules.requiredCapabilities ?? [];
    for (const capability of required) {
        if (!context.capabilities.includes(capability)) {
            return `missing capability ${capability}`;
        }
    }

    const cooldown = definition.activationRules.cooldown;
    const lastUsed = context.history[definition.id];
    if (cooldown !== undefined && lastUsed !== undefined && context.playbackTime - lastUsed < cooldown) {
        return 'cooling down';
    }

    if (!context.allowHighCost && definition.cost.gpu >= 3) {
        return 'high cost disallowed';
    }

    if (!context.allowDominant && definition.cost.dominant) {
        return 'dominant disallowed';
    }

    return undefined;
}

export function eligiblePlugins(context: SchedulerContext): VisualPluginDefinition[] {
    return context.available.filter((definition) => ineligibleReason(definition, context) === undefined);
}

/** True when `candidate` conflicts with anything already chosen, in either direction. */
export function conflictsWith(
    chosen: readonly VisualPluginDefinition[],
    candidate: VisualPluginDefinition,
): boolean {
    for (const existing of chosen) {
        if (existing.activationRules.incompatibleWith?.includes(candidate.id)) {
            return true;
        }
        if (candidate.activationRules.incompatibleWith?.includes(existing.id)) {
            return true;
        }
        if (existing.id === candidate.id) {
            return true;
        }
    }

    return false;
}

/* -------------------------------------------------------------------------- */
/* Character fit                                                              */
/* -------------------------------------------------------------------------- */

const CHARACTER_AXES: readonly (keyof SelectionCharacter)[] = [
    'visualDensity',
    'motionEnergy',
    'geometricOrder',
    'recognizability',
    'persistence',
    'brightness',
];

/**
 * How well a plugin matches the theme's target character, 0 to 1.
 *
 * This is what makes a scene cohere rather than being a bag of compatible plugins: a theme asking for
 * high geometric order and low density selects clean line work over dense particle fields.
 */
export function characterFit(
    character: SelectionCharacter,
    target: Partial<SelectionCharacter> | undefined,
): number {
    if (!target) {
        return 1;
    }

    let total = 0;
    let axes = 0;

    for (const axis of CHARACTER_AXES) {
        const wanted = target[axis];
        if (typeof wanted !== 'number') {
            continue;
        }

        total += 1 - Math.abs(clamp01(wanted) - clamp01(character[axis] as number));
        axes += 1;
    }

    if (target.dominance && target.dominance !== 'either' && character.dominance !== 'either') {
        total += character.dominance === target.dominance ? 1 : 0;
        axes += 1;
    }

    return axes === 0 ? 1 : total / axes;
}

/** Selection weight: activation weight, theme preference, and character fit combined. */
/** The part of an id before the mode: `TilingTransform:hex` and `TilingTransform:brick` are one family. */
export function pluginFamily(id: string): string {
    return id.split(':')[0];
}

/**
 * How many registered variants share a plugin's family.
 *
 * Weight is declared once per definition, and a family that happens to enumerate nine modes
 * registers nine definitions. Its influence over selection was therefore its declared weight times
 * however many modes its author wrote — `TilingTransform` at nine outweighing `ParticleSimulator` at
 * one by nine to one, for no reason anybody chose. Scenes came out tiled and without particles.
 */
const familyCounts = new WeakMap<object, Map<string, number>>();

export function familySize(
    definition: VisualPluginDefinition,
    available: readonly VisualPluginDefinition[],
): number {
    // Memoised against the candidate list. Selection weight is evaluated for every candidate at every
    // slot of every build attempt, so counting the catalog inside it made assembly quadratic — scene
    // building went from milliseconds to seconds.
    let counts = familyCounts.get(available);
    if (!counts) {
        counts = new Map<string, number>();
        for (const candidate of available) {
            const key = pluginFamily(candidate.id);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        familyCounts.set(available, counts);
    }

    return Math.max(1, counts.get(pluginFamily(definition.id)) ?? 1);
}

export function selectionWeight(
    definition: VisualPluginDefinition,
    context: SchedulerContext,
): number {
    const preference = context.theme.preferredPlugins
        ?.find((entry) => entry.pluginId === definition.id)?.weight ?? 1;
    const fit = characterFit(definition.character, context.theme.targetCharacter);

    // Divided across the family, so activation weight means what the family is worth rather than
    // what each of its modes is worth. A long mode list now buys variety, not influence.
    const share = 1 / familySize(definition, context.available);

    // Fit is squared so a poor match is strongly penalised rather than merely ranked lower.
    return Math.max(0, definition.activationRules.activationWeight)
        * Math.max(0, preference) * fit * fit * share;
}

/**
 * Raises the weight of plugins that explicitly cooperate with material already in the graph.
 *
 * `prefersWith` used to be inert metadata. That made a particle renderer no more likely after a
 * particle simulator, and a simulation view no more likely after its state producer. Pair affinity is
 * deliberately a weight rather than a hard rule, so fresh scenes still vary.
 */
export function interactionWeight(
    definition: VisualPluginDefinition,
    chosen: readonly VisualPluginDefinition[],
    context: SchedulerContext,
): number {
    // Matched by family rather than by exact id. Naming one mode of a nine-mode family meant the
    // preference fired only when that exact mode had been chosen, so chains that were supposed to
    // pull each other in — a field, then a simulator, then a renderer — almost never linked up.
    const chosenFamilies = new Set(chosen.map((entry) => pluginFamily(entry.id)));
    const family = pluginFamily(definition.id);

    const forwardPreference = definition.activationRules.prefersWith
        ?.some((id) => chosenFamilies.has(pluginFamily(id))) ?? false;
    const reversePreference = chosen.some((entry) =>
        entry.activationRules.prefersWith?.some((id) => pluginFamily(id) === family));

    return selectionWeight(definition, context) * (forwardPreference || reversePreference ? 6 : 1);
}

/* -------------------------------------------------------------------------- */
/* Scene assembly                                                             */
/* -------------------------------------------------------------------------- */

export interface AssembledScene {
    seed: string;
    plugins: VisualPluginDefinition[];
    violations: ReturnType<typeof grammarViolations>;
}

/**
 * Whether everything `candidate` requires is produced by something already chosen.
 *
 * Without this the scheduler can pick a consumer without its producer — a mask containment field with
 * no distance field to read — and the scene fails to wire. Selection has to understand dependencies,
 * not just categories and weights.
 */
export function inputsSatisfiable(
    chosen: readonly VisualPluginDefinition[],
    candidate: VisualPluginDefinition,
    /**
     * Port types the host can supply directly from a loaded asset.
     *
     * Wiring has always known that an asset satisfies an input; selection did not. A plugin whose
     * required input can only come from an asset — every mask field, since a mask texture is not
     * produced by any plugin — was therefore judged unsatisfiable and never chosen. Masks were
     * authored, generated, deployed, loaded, and then unreachable by any scene the scheduler built.
     */
    assetTypes: readonly PortType[] = [],
): boolean {
    const produced = new Set<PortType>(assetTypes);
    for (const definition of chosen) {
        for (const port of definition.outputs) {
            produced.add(port.type);
        }
    }

    // A feedback-capable plugin closes its own history port, so that one needs no upstream producer.
    const selfSatisfied = candidate.capabilities.includes('feedback')
        ? new Set(candidate.outputs.map((port) => port.type))
        : new Set<PortType>();

    return candidate.inputs
        .filter((port) => port.required)
        .every((port) => [...produced, ...selfSatisfied].some((type) => portsCompatible(type, port.type)));
}

/**
 * Fill order, and what each phase draws from.
 *
 * Sources first, so later choices have something to work on. Configuration nodes come after the
 * spatial fields whose textures some of them read, and before the simulators that consume them.
 *
 * A phase is a pool predicate and a grammar range rather than a bare category, because the field
 * category holds two different things: fields that occupy space and configuration nodes that
 * publish a value. Ranging them together meant one budget for a GPU pass over a texture and for a
 * struct describing an emitter.
 */
interface FillPhase {
    key: keyof SceneGrammar;
    includes(definition: VisualPluginDefinition): boolean;
}

const FILL_PHASES: readonly FillPhase[] = [
    { key: 'sourceCount', includes: (definition) => definition.category === 'source' },
    { key: 'fieldCount', includes: isSpatialField },
    { key: 'configurationCount', includes: isConfigurationNode },
    { key: 'simulatorCount', includes: (definition) => definition.category === 'simulator' },
    { key: 'transformerCount', includes: (definition) => definition.category === 'transformer' },
    { key: 'compositorCount', includes: (definition) => definition.category === 'compositor' },
    { key: 'postprocessCount', includes: (definition) => definition.category === 'postprocess' },
];

/**
 * Builds a scene from one fresh entropy token.
 *
 * Fills each category to a count drawn from its grammar range, choosing within a category by weight.
 * A candidate that would break a structural limit is skipped rather than accepted and repaired, so the
 * result satisfies the grammar by construction wherever the registry allows it.
 */
export function assembleScene(seed: string, context: SchedulerContext): AssembledScene {
    const rng = createRng(seed);
    const eligible = eligiblePlugins(context);
    const chosen: VisualPluginDefinition[] = [];
    const { grammar } = context.theme;
    const assetTypes = (context.assetResources ?? []).map((resource) => resource.type);

    for (const phase of FILL_PHASES) {
        const [minimum, maximum] = grammar[phase.key] as [number, number];
        if (maximum === 0) {
            continue;
        }

        const target = minimum + rng.int(maximum - minimum + 1);
        const pool = eligible.filter((definition) => phase.includes(definition));

        for (let slot = 0; slot < target; slot += 1) {
            const candidates = pool.filter((definition) =>
                !conflictsWith(chosen, definition)
                && !wouldViolate(chosen, definition, grammar)
                && inputsSatisfiable(chosen, definition, assetTypes));

            const picked = rng.weighted(
                candidates,
                (definition) => interactionWeight(definition, chosen, context),
            );
            if (!picked) {
                break;
            }

            chosen.push(picked);
        }
    }

    // A family that names a feedback stage should have one. Repaired here rather than left to a
    // retry, because a feedback plugin is a small share of a large catalog and random selection
    // missed it far more often than not — which is why most assembled scenes had no persistence.
    const feedbackShortfall = grammar.minimumFeedbackLoops
        - chosen.filter((definition) => declaresCapability(definition, 'feedback')).length;
    for (let missing = 0; missing < feedbackShortfall; missing += 1) {
        const candidates = eligible.filter((definition) =>
            declaresCapability(definition, 'feedback')
            && !conflictsWith(chosen, definition)
            && !wouldViolate(chosen, definition, grammar)
            && inputsSatisfiable(chosen, definition, assetTypes));

        const picked = rng.weighted(
            candidates,
            (definition) => interactionWeight(definition, chosen, context),
        );
        if (!picked) {
            break;
        }

        chosen.push(picked);
    }

    // And at least one of those loops has to displace what it reads, or the scene has a memory and
    // no motion. Repaired here for the same reason as the shortfall above: the plugins that warp
    // their own history are a handful in a catalog of two hundred, and leaving it to a retry spends
    // build attempts on a condition that can simply be satisfied.
    if (grammar.requireSpatialLoop && !chosen.some(displacesHistory)) {
        const candidates = eligible.filter((definition) =>
            displacesHistory(definition)
            && !conflictsWith(chosen, definition)
            && !wouldViolate(chosen, definition, grammar)
            && inputsSatisfiable(chosen, definition, assetTypes));

        const picked = rng.weighted(
            candidates,
            (definition) => interactionWeight(definition, chosen, context),
        );
        if (picked) {
            chosen.push(picked);
        }
    }

    // A family asking to be dragged needs something to be dragged by. The field category alone does
    // not guarantee it: `ParticleEmitter` sits there and produces a spawn buffer, so a scene could
    // satisfy its field count and still leave the compositor's motion bus with nothing to sum.
    if (grammar.requireMotionSource && !chosen.some(producesMotion)) {
        const candidates = eligible.filter((definition) =>
            producesMotion(definition)
            && !conflictsWith(chosen, definition)
            && !wouldViolate(chosen, definition, grammar)
            && inputsSatisfiable(chosen, definition, assetTypes));

        const picked = rng.weighted(
            candidates,
            (definition) => interactionWeight(definition, chosen, context),
        );
        if (picked) {
            chosen.push(picked);
        }
    }

    // A repair guaranteeing a field *consumer* stood here briefly and is recorded because it did not
    // work: the failing candidates already contain one, and wiring still leaves the field unread. The
    // gap is in wiring rather than in selection, and guessing further at it would have been guessing.
    // See docs/backlog.md.

    // A scene requiring a visible source that has none is unusable, so try once to add one.
    if (grammar.requireVisibleSource && !chosen.some(isVisibleSource)) {
        const visible = eligible.filter((definition) =>
            isVisibleSource(definition)
            && !conflictsWith(chosen, definition)
            // Checked here as the feedback and motion repairs above both do. Without it this repair
            // could push the source count past its own maximum, failing the assembly it was added to
            // rescue.
            && !wouldViolate(chosen, definition, grammar)
            && inputsSatisfiable(chosen, definition, assetTypes));
        const picked = rng.weighted(
            visible,
            (definition) => interactionWeight(definition, chosen, context),
        );
        if (picked) {
            chosen.push(picked);
        }
    }

    // An optional value input is a plugin saying "I can use this if it is there", and nothing ever
    // put it there. The producers for a particle simulator's force and collider ports are drawn in
    // an earlier phase than the simulator itself, so a scene had to have picked them speculatively,
    // before anything wanted them — which the field budget made impossible and chance made rare.
    // Measured across three hundred builds, no scene contained a particle force or a collider at
    // all: the bodies were advected by nothing and collided with nothing.
    //
    // Restricted to value ports, so this cannot quietly add a texture stage. A port whose type the
    // plugin also produces is skipped: that is the chaining idiom, where each emitter reads the list
    // built so far, and satisfying it would draw an endless line of emitters.
    for (const definition of [...chosen]) {
        for (const port of definition.inputs) {
            if (port.required || !isValuePortType(port.type)) {
                continue;
            }
            if (definition.outputs.some((output) => portsCompatible(output.type, port.type))) {
                continue;
            }
            if (chosen.some((entry) => entry.outputs.some((output) => portsCompatible(output.type, port.type)))) {
                continue;
            }

            const candidates = eligible.filter((candidate) =>
                candidate.outputs.some((output) => portsCompatible(output.type, port.type))
                && !conflictsWith(chosen, candidate)
                && !wouldViolate(chosen, candidate, grammar)
                && inputsSatisfiable(chosen, candidate, assetTypes));

            const picked = rng.weighted(
                candidates,
                (candidate) => interactionWeight(candidate, chosen, context),
            );
            if (picked) {
                chosen.push(picked);
            }
        }
    }

    return { seed, plugins: chosen, violations: grammarViolations(chosen, grammar) };
}

/* -------------------------------------------------------------------------- */
/* Mutation                                                                   */
/* -------------------------------------------------------------------------- */

export interface MutationDecision {
    kind: MutationKind;
    /** Instance to replace, for plugin and branch mutation. */
    targetInstanceId?: string;
    /** Replacement, for plugin mutation. */
    replacement?: VisualPluginDefinition;
}

export interface MutationState {
    secondsSinceMutation: number;
}

export function createMutationState(): MutationState {
    return { secondsSinceMutation: 0 };
}

/**
 * Advances the mutation timer. Returns a decision only when one is due.
 *
 * The timer takes frozen-aware delta, so a paused track does not accumulate mutations that all fire at
 * once on resume.
 */
export function advanceMutation(
    state: MutationState,
    deltaSeconds: number,
    policy: MutationPolicy,
): { state: MutationState; due: boolean } {
    const elapsed = state.secondsSinceMutation + Math.max(0, deltaSeconds);

    if (elapsed < policy.intervalSeconds) {
        return { state: { secondsSinceMutation: elapsed }, due: false };
    }

    return { state: { secondsSinceMutation: 0 }, due: true };
}

/**
 * Chooses a mutation. Prefers the smallest change that is available, since visual evolution should
 * come from incremental mutation rather than repeated scene replacement.
 */
export function decideMutation(
    rng: Rng,
    active: readonly ActivePluginRecord[],
    context: SchedulerContext,
    policy: MutationPolicy,
): MutationDecision {
    const kind = rng.weighted(
        Object.keys(policy.weights) as MutationKind[],
        (candidate) => policy.weights[candidate],
    ) ?? 'parameter';

    if (kind === 'parameter' || kind === 'scene') {
        return { kind };
    }

    const mature = active.filter((record) =>
        context.playbackTime - record.activationTime >= policy.minimumPluginAgeSeconds);
    const target = rng.pick(mature);

    if (!target) {
        // Nothing is old enough to replace, so fall back to the least disruptive option.
        return { kind: 'parameter' };
    }

    if (kind === 'branch') {
        return { kind: 'branch', targetInstanceId: target.instanceId };
    }

    const current = context.available.find((definition) => definition.id === target.pluginId);
    const replacement = pickReplacement(rng, current, active, context);

    return replacement
        ? { kind: 'plugin', targetInstanceId: target.instanceId, replacement }
        : { kind: 'parameter' };
}

/** A same-category, non-conflicting alternative, so a swap preserves the scene's shape. */
export function pickReplacement(
    rng: Rng,
    current: VisualPluginDefinition | undefined,
    active: readonly ActivePluginRecord[],
    context: SchedulerContext,
): VisualPluginDefinition | undefined {
    if (!current) {
        return undefined;
    }

    const activeIds = new Set(active.map((record) => record.pluginId));
    const candidates = eligiblePlugins(context).filter((definition) =>
        definition.category === current.category
        && definition.id !== current.id
        && !activeIds.has(definition.id));

    return rng.weighted(candidates, (definition) => selectionWeight(definition, context));
}

/* -------------------------------------------------------------------------- */
/* Default themes                                                            */
/* -------------------------------------------------------------------------- */

export const DEFAULT_MUTATION_POLICY: MutationPolicy = {
    // Faster, because every mutation is now small. A branch change used to rebuild the whole scene,
    // so the interval had to be long enough to make that bearable; with both structural mutations
    // swapping plugins in place and leaving the rest of the graph running, a change every five
    // seconds reads as an image that keeps evolving rather than as a series of scenes.
    intervalSeconds: 5,
    // Weighted toward changes that are visible. At eight to three to two, three mutations in five
    // only redistributed which feature drove which parameter — nothing a viewer would read as the
    // scene shifting — so a structural change arrived about every thirty-four seconds.
    //
    // Scene replacement is now rare to the point of being an event. It is the only mutation that
    // discards accumulated state, and at the previous weight one arrived every couple of minutes on
    // top of a branch rebuild every half minute, which is what made the output read as a slideshow.
    weights: { parameter: 2, plugin: 5, branch: 4, scene: 0.15 },
    // Shorter than the interval, deliberately. This exists so a plugin is not swapped out moments
    // after arriving, but when it exceeds the mutation interval it does something quite different:
    // nothing in the scene qualifies, every structural mutation falls back to redistributing
    // parameters, and the image stops changing for stretches far longer than the interval. Measured
    // at six seconds against intervals of four to eight, gaps of forty seconds appeared between
    // visible changes.
    minimumPluginAgeSeconds: 3,
};
