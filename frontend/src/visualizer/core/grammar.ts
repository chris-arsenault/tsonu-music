/**
 * Scene grammar (spec section 15).
 *
 * Compatibility alone produces incoherent scenes: two dominant generators fighting, three symmetry
 * transforms stacked, six plugins all pulsing on the same beat. The grammar constrains category
 * counts and structural limits so a scene reads as one composition.
 */

import { isMotionSource } from './persistence';
import { isValuePortType, type PluginCategory, type VisualPluginDefinition } from './plugin';

export type CountRange = [number, number];

export interface SceneGrammar {
    sourceCount: CountRange;
    /** Spatial fields only. Configuration nodes are counted separately; see `configurationCount`. */
    fieldCount: CountRange;
    /**
     * Emitters, forces, and colliders: field-category plugins that produce a value rather than a
     * texture.
     *
     * They were rationed by `fieldCount` alongside `ProceduralVectorField`, which is a budget for
     * GPU passes over a spatial field — and these cost no passes and produce no spatial data. With
     * `ORGANIC_FLOW.fieldCount` at one to two and a motion source required, a scene that spent one
     * slot on an emitter had the other claimed before a force or a collider could be drawn.
     * Measured across three hundred builds, no scene contained either: particles were advected by
     * nothing and collided with nothing, in every scene that had them.
     */
    configurationCount: CountRange;
    simulatorCount: CountRange;
    transformerCount: CountRange;
    compositorCount: CountRange;
    postprocessCount: CountRange;

    maximumDominantPlugins: number;
    maximumHighCostPlugins: number;
    maximumFeedbackLoops: number;
    /**
     * Feedback stages the family requires.
     *
     * Only a ceiling existed, so a scene could legally contain none — and with roughly a hundred and
     * fifty plugins to choose from, most did. Section 15 names a feedback stage in three of the four
     * families; the kernel's own accumulation is the floor beneath all of them, and this is what puts
     * the plugin-level stage those three describe into the scene.
     */
    minimumFeedbackLoops: number;
    maximumSymmetryTransforms: number;

    requireVisibleSource: boolean;
    /**
     * The scene must produce at least one spatial field.
     *
     * Category counts alone cannot express this: `fieldCount` is satisfied by any plugin in the field
     * category, and `ParticleEmitter` sits there while producing a spawn buffer rather than a
     * displacement. A scene that filled its field slot that way accumulated and decayed but was never
     * dragged, because the compositor's motion bus had nothing to sum.
     */
    requireMotionSource: boolean;
    /**
     * Distinct material producers that must feed one compositor.
     *
     * Checked after wiring rather than here, since it is a question about edges. A scene with a
     * compositor reading one branch twice is not composing anything.
     */
    minimumMaterialBranches: number;
    /**
     * Plugins the scene must contain in total.
     *
     * The category ranges each have a floor, but they are satisfiable independently and their floors
     * summed to a scene far thinner than any of them implies — two generators, one transform and one
     * post stage is a legal scene under every family here, and it looks like four things. A visualizer
     * wants several elements running at once so that no single one has to carry the frame: a couple of
     * generators, something warping them, something feeding back, and an effect on top.
     */
    minimumSceneSize: number;
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
        | 'too-few-feedback'
        | 'too-many-symmetry'
        | 'no-visible-source'
        | 'no-motion-source'
        | 'too-few-branches'
        | 'too-few-plugins';
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

/**
 * A field-category plugin that publishes a value rather than producing a texture.
 *
 * Derived from the port types rather than tabulated, so a new emitter or force cannot be added
 * without landing in the right budget. `isValuePortType` already names exactly these ports.
 */
export function isConfigurationNode(definition: VisualPluginDefinition): boolean {
    return definition.category === 'field'
        && definition.outputs.length > 0
        && definition.outputs.every((port) => isValuePortType(port.type));
}

/** A field that occupies space: the kind `fieldCount` is a budget for. */
export function isSpatialField(definition: VisualPluginDefinition): boolean {
    return definition.category === 'field' && !isConfigurationNode(definition);
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

    // `countByCategory` reports what each plugin declares itself to be, which is what it is for.
    // The field budget is about spatial fields, so the configuration nodes sharing that category are
    // moved out of it and checked against their own range.
    const configuration = definitions.filter(isConfigurationNode).length;
    counts.field -= configuration;

    const [minimumConfiguration, maximumConfiguration] = grammar.configurationCount;
    if (configuration < minimumConfiguration) {
        violations.push({
            kind: 'category-under',
            detail: `configuration ${configuration} < ${minimumConfiguration}`,
        });
    }
    if (configuration > maximumConfiguration) {
        violations.push({
            kind: 'category-over',
            detail: `configuration ${configuration} > ${maximumConfiguration}`,
        });
    }

    if (definitions.length < grammar.minimumSceneSize) {
        violations.push({
            kind: 'too-few-plugins',
            detail: `${definitions.length} plugins below ${grammar.minimumSceneSize}`,
        });
    }

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
    if (feedback < grammar.minimumFeedbackLoops) {
        violations.push({
            kind: 'too-few-feedback',
            detail: `${feedback} feedback loops below ${grammar.minimumFeedbackLoops}`,
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

    if (grammar.requireMotionSource && !definitions.some(producesMotion)) {
        violations.push({ kind: 'no-motion-source', detail: 'no plugin produces a spatial field' });
    }

    return violations;
}

/** Produces a field the compositor can drag the accumulated image through. */
export function producesMotion(definition: VisualPluginDefinition): boolean {
    return definition.outputs.some((port) => isMotionSource(port.type));
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
    const shortfalls: GrammarViolation['kind'][] = [
        'category-under',
        'too-few-feedback',
        'no-visible-source',
        'no-motion-source',
        'too-few-branches',
        'too-few-plugins',
    ];

    return violations.some((violation) => !shortfalls.includes(violation.kind));
}

/* -------------------------------------------------------------------------- */
/* Visual families (spec section 15)                                          */
/* -------------------------------------------------------------------------- */

export const ORGANIC_FLOW: SceneGrammar = {
    sourceCount: [2, 4],
    fieldCount: [1, 2],
    // Enough for an emitter, a force, and something to collide with. They cost no GPU passes, so
    // the ceiling is about how many distinct influences a viewer can read at once, not about budget.
    configurationCount: [0, 4],
    simulatorCount: [0, 1],
    transformerCount: [2, 4],
    // Two, because one compositor can only join two branches. Everything it cannot reach stays a
    // branch of its own and is summed into the frame at the end, which is the additive pile the
    // chained wiring exists to avoid — with ten colour producers in a scene and a single two-input
    // mixer, most of them never pass through anything another one made.
    compositorCount: [2, 3],
    postprocessCount: [1, 3],
    maximumDominantPlugins: 1,
    maximumHighCostPlugins: 1,
    maximumFeedbackLoops: 1,
    minimumFeedbackLoops: 1,
    maximumSymmetryTransforms: 1,
    requireVisibleSource: true,
    requireMotionSource: true,
    minimumMaterialBranches: 3,
    minimumSceneSize: 8,
};

export const GEOMETRIC_SIGNAL: SceneGrammar = {
    sourceCount: [2, 4],
    fieldCount: [0, 2],
    // No simulator to configure, so an emitter here would be an orphan the prune pass removes.
    configurationCount: [0, 0],
    // No dense simulator: the family is about clean geometry.
    simulatorCount: [0, 0],
    transformerCount: [2, 4],
    // Two, because one compositor can only join two branches. Everything it cannot reach stays a
    // branch of its own and is summed into the frame at the end, which is the additive pile the
    // chained wiring exists to avoid — with ten colour producers in a scene and a single two-input
    // mixer, most of them never pass through anything another one made.
    compositorCount: [2, 3],
    postprocessCount: [1, 3],
    maximumDominantPlugins: 1,
    maximumHighCostPlugins: 1,
    maximumFeedbackLoops: 1,
    // Clean geometry still wants a trail behind it; without one this family had the least motion of
    // the four while being the one whose shapes move most legibly.
    minimumFeedbackLoops: 1,
    maximumSymmetryTransforms: 1,
    requireVisibleSource: true,
    requireMotionSource: false,
    minimumMaterialBranches: 3,
    minimumSceneSize: 8,
};

export const COLLISION_ENERGY: SceneGrammar = {
    sourceCount: [2, 3],
    fieldCount: [1, 3],
    // The family whose whole subject is bodies hitting things, so it gets the most room for them.
    configurationCount: [0, 5],
    simulatorCount: [1, 2],
    transformerCount: [1, 3],
    // See the note on organic flow: one mixer joins two branches and leaves the rest to be summed.
    compositorCount: [2, 3],
    postprocessCount: [1, 3],
    maximumDominantPlugins: 1,
    maximumHighCostPlugins: 2,
    maximumFeedbackLoops: 1,
    minimumFeedbackLoops: 1,
    maximumSymmetryTransforms: 0,
    requireVisibleSource: false,
    requireMotionSource: true,
    minimumMaterialBranches: 3,
    minimumSceneSize: 8,
};

export const IMAGE_DREAM: SceneGrammar = {
    sourceCount: [2, 4],
    fieldCount: [1, 3],
    configurationCount: [0, 4],
    simulatorCount: [0, 1],
    transformerCount: [2, 4],
    // Two, because one compositor can only join two branches. Everything it cannot reach stays a
    // branch of its own and is summed into the frame at the end, which is the additive pile the
    // chained wiring exists to avoid — with ten colour producers in a scene and a single two-input
    // mixer, most of them never pass through anything another one made.
    compositorCount: [2, 3],
    postprocessCount: [1, 3],
    maximumDominantPlugins: 1,
    maximumHighCostPlugins: 1,
    maximumFeedbackLoops: 1,
    minimumFeedbackLoops: 1,
    maximumSymmetryTransforms: 1,
    requireVisibleSource: true,
    requireMotionSource: true,
    minimumMaterialBranches: 3,
    minimumSceneSize: 8,
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
    configurationCount: [0, 0],
    simulatorCount: [0, 0],
    transformerCount: [0, 1],
    compositorCount: [0, 1],
    postprocessCount: [1, 1],
    maximumDominantPlugins: 1,
    maximumHighCostPlugins: 0,
    maximumFeedbackLoops: 1,
    minimumFeedbackLoops: 0,
    maximumSymmetryTransforms: 0,
    requireVisibleSource: true,
    requireMotionSource: false,
    minimumMaterialBranches: 1,
    // The point of this rung is that the machine cannot afford a scene. Whatever composes is enough.
    minimumSceneSize: 1,
};
