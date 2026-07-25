/**
 * Activation scheduler (spec sections 14, 16, 17).
 *
 * Assembles scenes from grammar plus character rather than picking whatever is compatible, then
 * evolves them by incremental mutation. The host supplies fresh entropy for every new scene.
 */

import { clamp01 } from './bindings';
import {
    grammarViolations,
    isVisibleSource,
    wouldViolate,
    type SceneGrammar,
} from './grammar';
import { portsCompatible } from './graph';
import type {
    PluginCategory,
    PortType,
    SelectionCharacter,
    VisualPluginDefinition,
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
export function selectionWeight(
    definition: VisualPluginDefinition,
    context: SchedulerContext,
): number {
    const preference = context.theme.preferredPlugins
        ?.find((entry) => entry.pluginId === definition.id)?.weight ?? 1;
    const fit = characterFit(definition.character, context.theme.targetCharacter);

    // Fit is squared so a poor match is strongly penalised rather than merely ranked lower.
    return Math.max(0, definition.activationRules.activationWeight) * Math.max(0, preference) * fit * fit;
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
    const chosenIds = new Set(chosen.map((entry) => entry.id));
    const forwardPreference = definition.activationRules.prefersWith
        ?.some((id) => chosenIds.has(id)) ?? false;
    const reversePreference = chosen.some((entry) =>
        entry.activationRules.prefersWith?.includes(definition.id));

    return selectionWeight(definition, context) * (forwardPreference || reversePreference ? 4 : 1);
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
): boolean {
    const produced = new Set<PortType>();
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

/** Category fill order: sources first so later choices have something to work on. */
const FILL_ORDER: readonly PluginCategory[] = [
    'source',
    'field',
    'simulator',
    'transformer',
    'compositor',
    'postprocess',
];

const CATEGORY_RANGES: Record<PluginCategory, keyof SceneGrammar | undefined> = {
    source: 'sourceCount',
    field: 'fieldCount',
    simulator: 'simulatorCount',
    transformer: 'transformerCount',
    compositor: 'compositorCount',
    postprocess: 'postprocessCount',
};

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

    for (const category of FILL_ORDER) {
        const rangeKey = CATEGORY_RANGES[category];
        const [minimum, maximum] = rangeKey ? (grammar[rangeKey] as [number, number]) : [0, 0];
        if (maximum === 0) {
            continue;
        }

        const target = minimum + rng.int(maximum - minimum + 1);
        const pool = eligible.filter((definition) => definition.category === category);

        for (let slot = 0; slot < target; slot += 1) {
            const candidates = pool.filter((definition) =>
                !conflictsWith(chosen, definition)
                && !wouldViolate(chosen, definition, grammar)
                && inputsSatisfiable(chosen, definition));

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

    // A scene requiring a visible source that has none is unusable, so try once to add one.
    if (grammar.requireVisibleSource && !chosen.some(isVisibleSource)) {
        const visible = eligible.filter((definition) =>
            isVisibleSource(definition)
            && !conflictsWith(chosen, definition)
            && inputsSatisfiable(chosen, definition));
        const picked = rng.weighted(
            visible,
            (definition) => interactionWeight(definition, chosen, context),
        );
        if (picked) {
            chosen.push(picked);
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
    intervalSeconds: 14,
    // Continuous modulation supplies the constant motion; these slower structural changes reshape the
    // relationships without repeatedly discarding the whole composition.
    weights: { parameter: 8, plugin: 3, branch: 2, scene: 0.5 },
    minimumPluginAgeSeconds: 10,
};
