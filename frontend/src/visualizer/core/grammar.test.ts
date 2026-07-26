import { describe, expect, test } from 'vitest';
import {
    countByCategory,
    grammarViolations,
    isHighCost,
    isVisibleSource,
    ORGANIC_FLOW,
    REDUCED_GRAMMAR,
    satisfiesGrammar,
    VISUAL_FAMILIES,
    wouldViolate,
    type SceneGrammar,
} from './grammar';
import type { PluginCategory, VisualPluginDefinition } from './plugin';

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
    plugin('trn', 'transformer', { capabilities: ['feedback'] }),
    plugin('trn-b', 'transformer'),
    plugin('mix', 'compositor'),
    plugin('post', 'postprocess'),
];

describe('category counting', () => {
    test('counts every category, including empty ones', () => {
        const counts = countByCategory(WELL_FORMED);

        expect(counts).toEqual({
            source: 3, field: 1, simulator: 0, transformer: 2, compositor: 1, postprocess: 1,
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

    test('stacked feedback loops are rejected', () => {
        const doubled = [
            plugin('src', 'source'),
            plugin('fld', 'field'),
            plugin('f1', 'transformer', { capabilities: ['feedback'] }),
            plugin('f2', 'transformer', { capabilities: ['feedback'] }),
            plugin('post', 'postprocess'),
        ];

        expect(grammarViolations(doubled, ORGANIC_FLOW).some((entry) => entry.kind === 'too-many-feedback')).toBe(true);
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
        const feedback = plugin('f2', 'transformer', { capabilities: ['feedback'] });
        const current = [plugin('f1', 'transformer', { capabilities: ['feedback'] })];

        expect(wouldViolate(current, feedback, ORGANIC_FLOW)).toBe(true);
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
