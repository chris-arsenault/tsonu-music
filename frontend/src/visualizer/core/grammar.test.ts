import { describe, expect, test } from 'vitest';
import {
    countByCategory,
    grammarViolations,
    isConfigurationNode,
    isHighCost,
    isSpatialField,
    isVisibleSource,
    ORGANIC_FLOW,
    REDUCED_GRAMMAR,
    satisfiesGrammar,
    VISUAL_FAMILIES,
    wouldViolate,
    type SceneGrammar,
} from './grammar';
import type { PluginCategory, VisualPluginDefinition } from './plugin';
import { createProceduralVectorField } from '../plugins/fields/procedural-fields';
import {
    createParticleCollider,
    createParticleEmitter,
    createParticleForceField,
} from '../plugins/simulators/particles';

function plugin(
    id: string,
    category: PluginCategory,
    overrides: Partial<VisualPluginDefinition> = {},
): VisualPluginDefinition {
    return {
        id,
        version: 1,
        category,
        inputs: [],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
        capabilities: [],
        cost: { gpu: 1, cpu: 1, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.5, motionEnergy: 0.5, geometricOrder: 0.5,
            recognizability: 0.5, persistence: 0.5, brightness: 0.5, dominance: 'either',
        },
        activationRules: { activationWeight: 1 },
        create: () => ({
            initialize: () => undefined,
            activate: () => undefined,
            update: () => undefined,
            render: () => [],
            deactivate: () => undefined,
            destroy: () => undefined,
        }),
        ...overrides,
    };
}

/**
 * A scene that satisfies organic flow: two visible branches, an explicit compositor, and the feedback
 * stage section 15 names for the family.
 */
const WELL_FORMED: VisualPluginDefinition[] = [
    plugin('src-a', 'source'),
    plugin('src-b', 'source'),
    plugin('src-c', 'source'),
    plugin('fld', 'field', { outputs: [{ name: 'flow', type: 'vector-field', required: false }] }),
    // The lossy element a loop needs. ADR-0013: what makes a set loop-capable is a port declaring a
    // gain below one, not a plugin carrying a capability string.
    plugin('trn', 'transformer', {
        inputs: [{ name: 'history', type: 'color-texture', required: false, gainParameter: 'decay' }],
        parameters: { decay: 0.2 },
    }),
    plugin('trn-b', 'transformer'),
    plugin('mix', 'compositor'),
    plugin('mix-b', 'compositor'),
    plugin('post', 'postprocess'),
];

describe('category counting', () => {
    test('counts every category, including empty ones', () => {
        const counts = countByCategory(WELL_FORMED);

        expect(counts).toEqual({
            source: 3, field: 1, simulator: 0, transformer: 2, compositor: 2, postprocess: 1,
        });
    });

    test('an empty set counts zero everywhere', () => {
        expect(countByCategory([]).source).toBe(0);
    });
});

describe('grammar checks', () => {
    test('a well-formed scene passes', () => {
        expect(grammarViolations(WELL_FORMED, ORGANIC_FLOW)).toEqual([]);
        expect(satisfiesGrammar(WELL_FORMED, ORGANIC_FLOW)).toBe(true);
    });

    test('too few in a category is reported as under', () => {
        const violations = grammarViolations([plugin('src', 'source')], ORGANIC_FLOW);

        expect(violations.some((entry) => entry.kind === 'category-under')).toBe(true);
    });

    test('too many in a category is reported as over', () => {
        const crowded = [
            ...WELL_FORMED,
            plugin('t2', 'transformer'),
            plugin('t3', 'transformer'),
            plugin('t4', 'transformer'),
        ];
        const violations = grammarViolations(crowded, ORGANIC_FLOW);

        expect(violations.some((entry) => entry.kind === 'category-over')).toBe(true);
    });

    test('two dominant generators are rejected', () => {
        const dominant = { gpu: 1, cpu: 1, memory: 1, renderPasses: 1, qualityScalable: true, dominant: true };
        const competing = [
            plugin('src', 'source', { cost: dominant }),
            plugin('sim', 'simulator', { cost: dominant }),
            plugin('trn', 'transformer'),
            plugin('post', 'postprocess'),
            plugin('fld', 'field'),
        ];

        const violations = grammarViolations(competing, ORGANIC_FLOW);
        expect(violations.some((entry) => entry.kind === 'too-many-dominant')).toBe(true);
    });

    test('high-cost plugins are limited', () => {
        const expensive = { gpu: 4, cpu: 1, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false };
        const heavy = [
            plugin('src', 'source', { cost: expensive }),
            plugin('fld', 'field', { cost: expensive }),
            plugin('trn', 'transformer'),
            plugin('post', 'postprocess'),
        ];

        expect(grammarViolations(heavy, ORGANIC_FLOW).some((entry) => entry.kind === 'too-many-high-cost')).toBe(true);
    });

    test('the high-cost threshold is on gpu cost', () => {
        expect(isHighCost(plugin('cheap', 'source'))).toBe(false);
        expect(isHighCost(plugin('dear', 'source', {
            cost: { gpu: 3, cpu: 1, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        }))).toBe(true);
    });

    test('a set with nothing lossy cannot close a loop', () => {
        // This asserted the opposite direction — that two feedback-capable plugins were one loop too
        // many. Loops are counted over edges after wiring now (ADR-0013), because any image input can
        // be a historical sink and the plugin list no longer implies how many loops a scene has. What
        // the plugin list still decides is whether a converging loop is possible at all.
        const lossless = [
            plugin('src', 'source'),
            plugin('fld', 'field'),
            plugin('t1', 'transformer'),
            plugin('t2', 'transformer'),
            plugin('post', 'postprocess'),
        ];

        expect(grammarViolations(lossless, ORGANIC_FLOW).some((entry) => entry.kind === 'too-few-feedback')).toBe(true);
    });

    test('stacked symmetry transforms are rejected', () => {
        const doubled = [
            plugin('src', 'source'),
            plugin('fld', 'field'),
            plugin('s1', 'transformer', { capabilities: ['symmetry'] }),
            plugin('s2', 'transformer', { capabilities: ['symmetry'] }),
            plugin('post', 'postprocess'),
        ];

        expect(grammarViolations(doubled, ORGANIC_FLOW).some((entry) => entry.kind === 'too-many-symmetry')).toBe(true);
    });

    test('a scene requiring a visible source rejects one without', () => {
        const invisible = [
            plugin('pal', 'source', { outputs: [{ name: 'palette', type: 'palette', required: false }] }),
            plugin('fld', 'field'),
            plugin('trn', 'transformer'),
            plugin('post', 'postprocess'),
        ];

        expect(grammarViolations(invisible, ORGANIC_FLOW).some((entry) => entry.kind === 'no-visible-source')).toBe(true);
    });

    test('a palette-only source is not a visible source', () => {
        expect(isVisibleSource(plugin('pal', 'source', {
            outputs: [{ name: 'palette', type: 'palette', required: false }],
        }))).toBe(false);
        expect(isVisibleSource(plugin('src', 'source'))).toBe(true);
        // A transformer emitting colour is still not a source.
        expect(isVisibleSource(plugin('trn', 'transformer'))).toBe(false);
    });
});

describe('candidate filtering', () => {
    test('a candidate breaking a structural limit is rejected', () => {
        // Symmetry rather than feedback: organic flow allows one symmetry transform, and the second
        // is the candidate that breaks it. Feedback no longer caps by plugin count (ADR-0013).
        const second = plugin('s2', 'transformer', { capabilities: ['symmetry'] });
        const current = [plugin('s1', 'transformer', { capabilities: ['symmetry'] })];

        expect(wouldViolate(current, second, ORGANIC_FLOW)).toBe(true);
    });

    test('a candidate that only leaves the scene under-filled is accepted', () => {
        // A partially built scene is under-filled by definition; that is not the candidate's fault.
        expect(wouldViolate([], plugin('src', 'source'), ORGANIC_FLOW)).toBe(false);
    });

    test('a candidate exceeding a category maximum is rejected', () => {
        // Organic flow allows up to four transformers, so the fifth is the one that exceeds it.
        // Adding an earlier one used to be rejected too, but for an unrelated shortfall — the partial
        // set had no visible source yet — which is not the candidate's fault and no longer counts.
        const current = [
            plugin('t1', 'transformer'),
            plugin('t2', 'transformer'),
            plugin('t3', 'transformer'),
            plugin('t4', 'transformer'),
        ];

        expect(wouldViolate(current.slice(0, 2), plugin('t3', 'transformer'), ORGANIC_FLOW)).toBe(false);
        expect(wouldViolate(current, plugin('t4', 'transformer'), ORGANIC_FLOW)).toBe(true);
    });

    test('a shortfall the partial set has not filled yet is not blamed on the candidate', () => {
        // A scene under construction is under-filled by definition. Rejecting every candidate until
        // the shortfall is gone would prevent it from ever being filled.
        const empty: VisualPluginDefinition[] = [];

        expect(wouldViolate(empty, plugin('fld', 'field'), ORGANIC_FLOW)).toBe(false);
        expect(wouldViolate(empty, plugin('post', 'postprocess'), ORGANIC_FLOW)).toBe(false);
    });
});

describe('visual families', () => {
    test('every family is registered', () => {
        expect(Object.keys(VISUAL_FAMILIES).sort()).toEqual([
            'collision-energy',
            'geometric-signal',
            'image-dream',
            'organic-flow',
        ]);
    });

    test('every family has coherent ranges and at least one postprocess', () => {
        const ranges: (keyof SceneGrammar)[] = [
            'sourceCount', 'fieldCount', 'simulatorCount', 'transformerCount',
            'compositorCount', 'postprocessCount',
        ];

        for (const [name, grammar] of Object.entries(VISUAL_FAMILIES)) {
            for (const key of ranges) {
                const [minimum, maximum] = grammar[key] as [number, number];
                expect(minimum, `${name}.${key} minimum`).toBeGreaterThanOrEqual(0);
                expect(maximum, `${name}.${key} range`).toBeGreaterThanOrEqual(minimum);
            }

            expect(grammar.postprocessCount[0], `${name} needs tone mapping`).toBeGreaterThanOrEqual(1);
            expect(grammar.compositorCount[0], `${name} needs interacting branches`).toBeGreaterThanOrEqual(1);
            expect(grammar.maximumDominantPlugins, `${name} dominant cap`).toBeLessThanOrEqual(1);
        }
    });

    test('geometric signal admits no simulator', () => {
        expect(VISUAL_FAMILIES['geometric-signal'].simulatorCount).toEqual([0, 0]);
    });

    test('collision energy always has a simulator and forbids symmetry', () => {
        // A second simulator is allowed now: the family is about things striking each other, and one
        // simulator with nothing to strike is a demonstration rather than a collision.
        expect(VISUAL_FAMILIES['collision-energy'].simulatorCount[0]).toBe(1);
        expect(VISUAL_FAMILIES['collision-energy'].maximumSymmetryTransforms).toBe(0);
    });

    test('every family asks for a scene with several things happening in it', () => {
        // The category floors are satisfiable independently, and summed to a scene far thinner than
        // any family implies: two generators, one transform and one post stage was legal everywhere
        // and looks like four things. A frame carried by one element is the failure this prevents.
        for (const [name, grammar] of Object.entries(VISUAL_FAMILIES)) {
            expect(grammar.minimumSceneSize, name).toBeGreaterThanOrEqual(8);
            expect(grammar.sourceCount[0], name).toBeGreaterThanOrEqual(2);
            expect(grammar.transformerCount[0], name).toBeGreaterThanOrEqual(1);
            expect(grammar.minimumFeedbackLoops, name).toBeGreaterThanOrEqual(1);
            expect(grammar.postprocessCount[0], name).toBeGreaterThanOrEqual(1);
            expect(grammar.minimumMaterialBranches, name).toBeGreaterThanOrEqual(3);
        }
    });

    test('the reduced grammar is cheaper than every family', () => {
        expect(REDUCED_GRAMMAR.maximumHighCostPlugins).toBe(0);
        expect(REDUCED_GRAMMAR.simulatorCount).toEqual([0, 0]);

        for (const grammar of Object.values(VISUAL_FAMILIES)) {
            expect(REDUCED_GRAMMAR.sourceCount[1]).toBeLessThanOrEqual(grammar.sourceCount[1]);
            expect(REDUCED_GRAMMAR.maximumHighCostPlugins).toBeLessThanOrEqual(grammar.maximumHighCostPlugins);
        }
    });
});

describe('a configuration node is not a spatial field', () => {
    const emitter = createParticleEmitter('ring');
    const force = createParticleForceField('vortex');
    const collider = createParticleCollider('frame');
    const field = createProceduralVectorField('curl');

    test('emitters, forces, and colliders are configuration nodes', () => {
        for (const definition of [emitter, force, collider]) {
            expect(isConfigurationNode(definition), definition.id).toBe(true);
            expect(isSpatialField(definition), definition.id).toBe(false);
        }
    });

    test('a vector field is a spatial field despite sharing the category', () => {
        expect(field.category).toBe('field');
        expect(collider.category).toBe('field');

        expect(isSpatialField(field)).toBe(true);
        expect(isConfigurationNode(field)).toBe(false);
    });

    test('configuration nodes are counted against their own range, not the field budget', () => {
        // They were rationed by `fieldCount`, which is a budget for GPU passes over a texture — and
        // these cost no passes and produce no spatial data. With organic flow at one to two fields
        // and a motion source required, a scene that spent a slot on an emitter had the other
        // claimed before a force or a collider could be drawn, so no scene ever contained either.
        const grammar: SceneGrammar = { ...ORGANIC_FLOW, fieldCount: [1, 1], configurationCount: [0, 3] };
        const scene = [field, emitter, force, collider];

        const kinds = grammarViolations(scene, grammar).map((violation) => violation.kind);
        expect(kinds).not.toContain('category-over');
    });

    test('too many configuration nodes is still a violation', () => {
        const grammar: SceneGrammar = { ...ORGANIC_FLOW, configurationCount: [0, 1] };

        expect(grammarViolations([emitter, force, collider], grammar).map((v) => v.kind))
            .toContain('category-over');
    });
});
