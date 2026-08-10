/**
 * Reactivity distribution.
 *
 * Plugins should not all react to the same audio event, and a parameter should not respond the
 * same way in every scene the system ever builds. Distribution therefore draws two things per
 * binding per scene: which channel drives it, and how it responds.
 *
 * The feature draw is constrained by signal shape (`signal-shapes.ts`), not by a semantic table.
 * An earlier version drew features from category-wide pools and moved feedback expansion onto
 * stereo balance; the correction was a table of roles that narrowed each binding's substitutes to
 * near-duplicates and froze its temporal response entirely — a warp's strength was an EMA of
 * low-frequency energy in every scene, whichever channel fed it. Shape is the property a
 * substitute must preserve (a rider for a rider, a gate for a gate); within a shape, substitution
 * is free, and the response itself becomes a draw.
 *
 * An expression is a draw-time transform producing a plain binding — concrete mode, envelope, and
 * range values. Documents, captures, the editor, and the runtime never see expressions; they see
 * the binding the draw produced.
 */

import { bindingMode, type ParameterBinding } from './bindings';
import type { GraphNode } from './graph';
import type { Rng } from './random';
import { DELIBERATE_ONLY_FEATURES, SIGNAL_SHAPES, shapeOf } from './signal-shapes';

/** Event channels an impulse binding fires from. Distribution never moves one onto a level. */
const IMPULSE_FEATURES: readonly string[] = SIGNAL_SHAPES.event;

/**
 * Every channel a binding may name, for an editor offering the choice.
 *
 * The shape pools plus the deliberate-only channels — substitution never lands on the latter, but
 * choosing one by hand is not substitution.
 */
export const BINDABLE_FEATURES: readonly string[] = [
    ...new Set([
        ...Object.values(SIGNAL_SHAPES).flat(),
        ...DELIBERATE_ONLY_FEATURES,
    ]),
].sort();

export function isEventFeature(feature: string): boolean {
    return IMPULSE_FEATURES.includes(feature);
}

/**
 * How a parameter responds to the channel that drives it. Each expression rewrites the authored
 * binding's mode, envelope, or range, and names the shape pool its feature is drawn from.
 *
 * `follow` is the authored binding as written and is what every binding gets unless its plugin
 * declares more. The others exist because a response authored once is a response the system can
 * never vary: the reported "MilkDrop-style warps feel constant rate" is a warp strength that is
 * the same smoothed follower of the same kind of channel in every scene.
 */
export type BindingExpression = 'follow' | 'glide' | 'punch' | 'swing' | 'spin';

interface ExpressionDraw {
    /** The pool the feature is drawn from. Undefined keeps the authored feature's own shape. */
    pool?: keyof typeof SIGNAL_SHAPES;
    /** Rewrites the authored binding into the drawn response. */
    apply(binding: ParameterBinding, rng: Rng): ParameterBinding;
}

const EXPRESSIONS: Record<BindingExpression, ExpressionDraw> = {
    /** The authored response, feature drawn within its own shape. */
    follow: {
        apply: (binding) => binding,
    },

    /** Phrase-scale swells: the authored envelope stretched fourfold, on a riding channel. */
    glide: {
        pool: 'level',
        apply: (binding) => ({
            ...binding,
            attack: binding.attack * 4,
            release: binding.release * 4,
            curve: 'smooth',
        }),
    },

    /**
     * Beat-kicked: a fast rise and a musical fall, fed by a gate. The ceiling widens so the hit
     * reads over the authored resting level, bounded so a drawn response cannot leave the range
     * the parameter was written to tolerate by more than half again.
     */
    punch: {
        pool: 'pulse',
        apply: (binding, rng) => {
            const [low, high] = binding.outputRange;
            return {
                ...binding,
                mode: 'value',
                attack: rng.range(0.015, 0.05),
                release: rng.range(0.25, 0.6),
                curve: 'sqrt',
                outputRange: [low, low + (high - low) * 1.3] as [number, number],
            };
        },
    },

    /**
     * A signed response: the range recentres on zero, so the parameter crosses it and the motion
     * it drives changes direction with the music instead of only changing speed.
     */
    swing: {
        pool: 'level',
        apply: (binding) => {
            const high = Math.max(...binding.outputRange.map(Math.abs));
            return {
                ...binding,
                mode: 'value',
                outputRange: [-high, high] as [number, number],
            };
        },
    },

    /**
     * Integrated: the feature sets a velocity and the parameter accumulates, wrapped. Only legal
     * where the authored binding declares `wrap` — integration without a wrap is unbounded.
     */
    spin: {
        pool: 'level',
        apply: (binding) => ({
            ...binding,
            mode: 'rate',
        }),
    },
};

export interface DistributedBinding {
    /** The instance these bindings belong to. Two instances of one definition are distinct here. */
    instanceId: string;
    pluginId: string;
    bindings: ParameterBinding[];
}

/**
 * Draws each binding's channel and response for one scene.
 *
 * Assignment is per binding, not per plugin: a plugin that binds amplitude to level and brightness
 * to treble means those to be different signals, and collapsing them onto one feature would undo
 * exactly the separation this function exists to create.
 *
 * Features already claimed are avoided until a shape's pool runs dry, at which point reuse is
 * allowed — a scene with more bindings in one shape than that shape has channels cannot give each
 * an exclusive signal, but it can still avoid every binding sharing one.
 *
 * Distribution runs over instances rather than definitions, so two instances of one plugin can be
 * assigned separately and told apart afterwards.
 */
export function distributeReactivity(
    nodes: readonly GraphNode[],
    rng: Rng,
): DistributedBinding[] {
    const claimed = new Set<string>();

    const claim = (pool: readonly string[], fallback: string): string => {
        if (pool.length === 0) {
            return fallback;
        }

        const unclaimed = pool.filter((feature) => !claimed.has(feature));
        const feature = rng.pick(unclaimed.length > 0 ? unclaimed : pool) ?? pool[0];

        claimed.add(feature);
        return feature;
    };

    return nodes.map(({ instanceId, definition }) => ({
        instanceId,
        pluginId: definition.id,
        bindings: (definition.defaultBindings ?? []).map((binding) => {
            // An impulse names an event channel. Rewriting it onto a continuous feature would leave
            // the binding reading a channel that never fires.
            if (bindingMode(binding) === 'impulse') {
                return strip({ ...binding, feature: claim(IMPULSE_FEATURES, binding.feature) });
            }

            const shape = shapeOf(binding.feature);
            if (!shape) {
                // A feature outside every pool — `beatConfidence`, a raw channel level — is
                // deliberate and specific. Leave it alone rather than guessing at a replacement.
                return strip({ ...binding });
            }

            const expression = drawExpression(binding, rng);
            const draw = EXPRESSIONS[expression];
            const pool = SIGNAL_SHAPES[draw.pool ?? shape];
            const rewritten = draw.apply(binding, rng);

            return strip({ ...rewritten, feature: claim(pool, binding.feature) });
        }),
    }));
}

/**
 * The response drawn for one binding.
 *
 * `follow` is always among the candidates, so an opted-in parameter keeps its authored behaviour
 * as one character among several rather than losing it. `spin` requires an authored `wrap`, and a
 * declaration naming it without one is treated as not naming it.
 */
function drawExpression(binding: ParameterBinding, rng: Rng): BindingExpression {
    const declared = binding.expressions ?? [];
    const legal = declared.filter((expression) =>
        expression !== 'spin' || (binding.wrap !== undefined && binding.wrap > 0));
    const candidates: BindingExpression[] = legal.length > 0
        ? [...new Set<BindingExpression>(['follow', ...legal])]
        : ['follow'];

    return rng.pick(candidates) ?? 'follow';
}

/** Definition-side metadata never reaches a document, a capture, or the runtime. */
function strip(binding: ParameterBinding): ParameterBinding {
    if (binding.expressions === undefined) {
        return binding;
    }

    const rest = { ...binding };
    delete rest.expressions;
    return rest;
}

/**
 * How many instances share each feature. Used to check that a scene's reactivity is spread rather
 * than concentrated.
 */
export function reactivitySpread(distributed: readonly DistributedBinding[]): Map<string, number> {
    const spread = new Map<string, number>();

    for (const entry of distributed) {
        for (const binding of entry.bindings) {
            spread.set(binding.feature, (spread.get(binding.feature) ?? 0) + 1);
        }
    }

    return spread;
}

/**
 * The largest number of instances bound to any one feature. A scene where this equals the instance
 * count is one where everything pulses together.
 */
export function peakConcentration(distributed: readonly DistributedBinding[]): number {
    let peak = 0;

    for (const count of reactivitySpread(distributed).values()) {
        peak = Math.max(peak, count);
    }

    return peak;
}
