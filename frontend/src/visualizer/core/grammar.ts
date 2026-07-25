/**
 * Scene grammar (spec section 15).
 *
 * Compatibility alone produces incoherent scenes: two dominant generators fighting, three symmetry
 * transforms stacked, six plugins all pulsing on the same beat. The grammar constrains category
 * counts and structural limits so a scene reads as one composition.
 */

import type { PluginCategory, VisualPluginDefinition } from './plugin';

export type CountRange = [number, number];

export interface SceneGrammar {
    sourceCount: CountRange;
    fieldCount: CountRange;
    simulatorCount: CountRange;
    transformerCount: CountRange;
    compositorCount: CountRange;
    postprocessCount: CountRange;

    maximumDominantPlugins: number;
    maximumHighCostPlugins: number;
    maximumFeedbackLoops: number;
    maximumSymmetryTransforms: number;

    requireVisibleSource: boolean;
}

/** GPU cost at or above which a plugin counts against the high-cost limit. */
export const HIGH_COST_THRESHOLD = 3;

export const CATEGORY_RANGE_KEYS: Record<PluginCategory, keyof SceneGrammar | undefined> = {
    source: 'sourceCount',
    field: 'fieldCount',
    simulator: 'simulatorCount',
    transformer: 'transformerCount',
    compositor: 'compositorCount',
    postprocess: 'postprocessCount',
};

export interface GrammarViolation {
    kind:
        | 'category-under'
        | 'category-over'
        | 'too-many-dominant'
        | 'too-many-high-cost'
        | 'too-many-feedback'
        | 'too-many-symmetry'
        | 'no-visible-source';
    detail: string;
}

export function countByCategory(
    definitions: readonly VisualPluginDefinition[],
): Record<PluginCategory, number> {
    const counts: Record<PluginCategory, number> = {
        source: 0,
        field: 0,
        simulator: 0,
        transformer: 0,
        compositor: 0,
        postprocess: 0,
    };

    for (const definition of definitions) {
        counts[definition.category] += 1;
    }

    return counts;
}

export function isHighCost(definition: VisualPluginDefinition): boolean {
    return definition.cost.gpu >= HIGH_COST_THRESHOLD;
}

export function declaresCapability(definition: VisualPluginDefinition, capability: string): boolean {
    return definition.capabilities.includes(capability);
}

/**
 * Every way a set violates the grammar. Empty means the set is well-formed.
 *
 * Reported as a list rather than a boolean so the scheduler can tell "needs one more source" from
 * "has two dominant generators" and repair accordingly.
 */
export function grammarViolations(
    definitions: readonly VisualPluginDefinition[],
    grammar: SceneGrammar,
): GrammarViolation[] {
    const violations: GrammarViolation[] = [];
    const counts = countByCategory(definitions);

    for (const [category, key] of Object.entries(CATEGORY_RANGE_KEYS) as [PluginCategory, keyof SceneGrammar | undefined][]) {
        if (!key) {
            continue;
        }

        const [minimum, maximum] = grammar[key] as CountRange;
        const count = counts[category];

        if (count < minimum) {
            violations.push({ kind: 'category-under', detail: `${category} ${count} < ${minimum}` });
        }
        if (count > maximum) {
            violations.push({ kind: 'category-over', detail: `${category} ${count} > ${maximum}` });
        }
    }

    const dominant = definitions.filter((definition) => definition.cost.dominant).length;
    if (dominant > grammar.maximumDominantPlugins) {
        violations.push({
            kind: 'too-many-dominant',
            detail: `${dominant} dominant plugins exceed ${grammar.maximumDominantPlugins}`,
        });
    }

    const highCost = definitions.filter(isHighCost).length;
    if (highCost > grammar.maximumHighCostPlugins) {
        violations.push({
            kind: 'too-many-high-cost',
            detail: `${highCost} high-cost plugins exceed ${grammar.maximumHighCostPlugins}`,
        });
    }

    const feedback = definitions.filter((definition) => declaresCapability(definition, 'feedback')).length;
    if (feedback > grammar.maximumFeedbackLoops) {
        violations.push({
            kind: 'too-many-feedback',
            detail: `${feedback} feedback loops exceed ${grammar.maximumFeedbackLoops}`,
        });
    }

    const symmetry = definitions.filter((definition) => declaresCapability(definition, 'symmetry')).length;
    if (symmetry > grammar.maximumSymmetryTransforms) {
        violations.push({
            kind: 'too-many-symmetry',
            detail: `${symmetry} symmetry transforms exceed ${grammar.maximumSymmetryTransforms}`,
        });
    }

    if (grammar.requireVisibleSource && !definitions.some(isVisibleSource)) {
        violations.push({ kind: 'no-visible-source', detail: 'no source produces visible material' });
    }

    return violations;
}

export function satisfiesGrammar(
    definitions: readonly VisualPluginDefinition[],
    grammar: SceneGrammar,
): boolean {
    return grammarViolations(definitions, grammar).length === 0;
}

/**
 * A source that puts something on screen. A palette or a field is a source category in name but
 * contributes no visible material on its own, so it cannot satisfy `requireVisibleSource`.
 */
export function isVisibleSource(definition: VisualPluginDefinition): boolean {
    if (definition.category !== 'source') {
        return false;
    }

    return definition.outputs.some((port) => port.type === 'color-texture');
}

/** True when adding this plugin would break the grammar. Used to filter candidates during assembly. */
export function wouldViolate(
    current: readonly VisualPluginDefinition[],
    candidate: VisualPluginDefinition,
    grammar: SceneGrammar,
): boolean {
    const violations = grammarViolations([...current, candidate], grammar);

    // Under-count violations are not the candidate's fault: a partially built scene is under-filled
    // by definition, and adding a plugin never causes that.
    return violations.some((violation) => violation.kind !== 'category-under');
}

/* -------------------------------------------------------------------------- */
/* Visual families (spec section 15)                                          */
/* -------------------------------------------------------------------------- */

export const ORGANIC_FLOW: SceneGrammar = {
    sourceCount: [2, 3],
    fieldCount: [1, 2],
    simulatorCount: [0, 1],
    transformerCount: [1, 3],
    compositorCount: [1, 2],
    postprocessCount: [1, 2],
    maximumDominantPlugins: 1,
    maximumHighCostPlugins: 1,
    maximumFeedbackLoops: 1,
    maximumSymmetryTransforms: 1,
    requireVisibleSource: true,
};

export const GEOMETRIC_SIGNAL: SceneGrammar = {
    sourceCount: [2, 3],
    fieldCount: [0, 1],
    // No dense simulator: the family is about clean geometry.
    simulatorCount: [0, 0],
    transformerCount: [2, 3],
    compositorCount: [1, 2],
    postprocessCount: [1, 2],
    maximumDominantPlugins: 1,
    maximumHighCostPlugins: 1,
    maximumFeedbackLoops: 1,
    maximumSymmetryTransforms: 1,
    requireVisibleSource: true,
};

export const COLLISION_ENERGY: SceneGrammar = {
    sourceCount: [1, 2],
    fieldCount: [1, 3],
    simulatorCount: [1, 1],
    transformerCount: [1, 2],
    compositorCount: [1, 2],
    postprocessCount: [1, 3],
    maximumDominantPlugins: 1,
    maximumHighCostPlugins: 2,
    maximumFeedbackLoops: 1,
    maximumSymmetryTransforms: 0,
    requireVisibleSource: false,
};

export const IMAGE_DREAM: SceneGrammar = {
    sourceCount: [2, 3],
    fieldCount: [1, 3],
    simulatorCount: [0, 1],
    transformerCount: [2, 3],
    compositorCount: [1, 2],
    postprocessCount: [1, 3],
    maximumDominantPlugins: 1,
    maximumHighCostPlugins: 1,
    maximumFeedbackLoops: 1,
    maximumSymmetryTransforms: 1,
    requireVisibleSource: true,
};

export const VISUAL_FAMILIES: Readonly<Record<string, SceneGrammar>> = {
    'organic-flow': ORGANIC_FLOW,
    'geometric-signal': GEOMETRIC_SIGNAL,
    'collision-energy': COLLISION_ENERGY,
    'image-dream': IMAGE_DREAM,
};

/** A lower-cost grammar for the bottom of the downgrade ladder (spec section 21.2, step 8). */
export const REDUCED_GRAMMAR: SceneGrammar = {
    sourceCount: [1, 1],
    fieldCount: [0, 1],
    simulatorCount: [0, 0],
    transformerCount: [0, 1],
    compositorCount: [0, 1],
    postprocessCount: [1, 1],
    maximumDominantPlugins: 1,
    maximumHighCostPlugins: 0,
    maximumFeedbackLoops: 1,
    maximumSymmetryTransforms: 0,
    requireVisibleSource: true,
};
