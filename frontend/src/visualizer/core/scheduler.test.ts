import { describe, expect, test } from 'vitest';
import {
    advanceMutation,
    assembleScene,
    characterFit,
    conflictsWith,
    createMutationState,
    decideMutation,
    DEFAULT_MUTATION_POLICY,
    eligiblePlugins,
    ineligibleReason,
    inputsSatisfiable,
    pickReplacement,
    selectionWeight,
    type ActivePluginRecord,
    type SchedulerContext,
    type VisualTheme,
} from './scheduler';
import { GEOMETRIC_SIGNAL, ORGANIC_FLOW, satisfiesGrammar } from './grammar';
import { createRng } from './random';
import type { PluginCategory, SelectionCharacter, VisualPluginDefinition } from './plugin';

function character(overrides: Partial<SelectionCharacter> = {}): SelectionCharacter {
    return {
        visualDensity: 0.5,
        motionEnergy: 0.5,
        geometricOrder: 0.5,
        recognizability: 0.5,
        persistence: 0.5,
        brightness: 0.5,
        dominance: 'either',
        ...overrides,
    };
}

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
        character: character(),
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

/** A registry wide enough that grammar ranges can actually be filled. */
const CATALOG: VisualPluginDefinition[] = [
    plugin('source-a', 'source'),
    plugin('source-b', 'source'),
    plugin('source-c', 'source'),
    plugin('field-a', 'field', { outputs: [{ name: 'flow', type: 'vector-field', required: false }] }),
    plugin('field-b', 'field', { outputs: [{ name: 'flow', type: 'vector-field', required: false }] }),
    plugin('sim-a', 'simulator'),
    plugin('sim-b', 'simulator'),
    plugin('transform-a', 'transformer', { capabilities: ['feedback'] }),
    plugin('transform-b', 'transformer', { capabilities: ['symmetry'] }),
    plugin('transform-c', 'transformer'),
    plugin('compositor-a', 'compositor'),
    plugin('compositor-b', 'compositor'),
    plugin('post-a', 'postprocess'),
    plugin('post-b', 'postprocess'),
];

function theme(overrides: Partial<VisualTheme> = {}): VisualTheme {
    return {
        id: 'test-theme',
        grammar: ORGANIC_FLOW,
        mutationPolicy: DEFAULT_MUTATION_POLICY,
        ...overrides,
    };
}

function context(overrides: Partial<SchedulerContext> = {}): SchedulerContext {
    return {
        available: CATALOG,
        theme: theme(),
        assets: [],
        capabilities: [],
        history: {},
        playbackTime: 100,
        allowHighCost: true,
        allowDominant: true,
        ...overrides,
    };
}

describe('eligibility', () => {
    test('a plain plugin is eligible', () => {
        expect(ineligibleReason(plugin('x', 'source'), context())).toBeUndefined();
    });

    test('theme exclusion wins over everything', () => {
        const excluded = context({ theme: theme({ excludedPlugins: ['source-a'] }) });

        expect(ineligibleReason(CATALOG[0], excluded)).toMatch(/excluded/);
    });

    test('an allow list omits anything not named', () => {
        const restricted = context({ theme: theme({ allowedPlugins: ['source-a'] }) });

        expect(ineligibleReason(CATALOG[0], restricted)).toBeUndefined();
        expect(ineligibleReason(CATALOG[1], restricted)).toMatch(/allow list/);
    });

    test('a missing required asset blocks activation', () => {
        const needsMask = plugin('masked', 'field', {
            activationRules: { activationWeight: 1, requiredAssets: ['mask:inkblot'] },
        });

        expect(ineligibleReason(needsMask, context())).toMatch(/missing asset/);
        expect(ineligibleReason(needsMask, context({ assets: ['mask:inkblot'] }))).toBeUndefined();
    });

    test('a missing capability blocks activation', () => {
        const needsFloat = plugin('floaty', 'simulator', { requiredCapabilities: ['float-textures'] });

        expect(ineligibleReason(needsFloat, context())).toMatch(/missing capability/);
        expect(ineligibleReason(needsFloat, context({ capabilities: ['float-textures'] }))).toBeUndefined();
    });

    test('cooldown blocks reuse until it expires', () => {
        const cooling = plugin('cooling', 'source', {
            activationRules: { activationWeight: 1, cooldown: 60 },
        });
        const recent = context({ history: { cooling: 80 }, playbackTime: 100 });
        const stale = context({ history: { cooling: 10 }, playbackTime: 100 });

        expect(ineligibleReason(cooling, recent)).toMatch(/cooling down/);
        expect(ineligibleReason(cooling, stale)).toBeUndefined();
    });

    test('the performance controller can exclude high-cost and dominant plugins', () => {
        const expensive = plugin('expensive', 'simulator', {
            cost: { gpu: 4, cpu: 2, memory: 3, renderPasses: 3, qualityScalable: true, dominant: true },
        });

        expect(ineligibleReason(expensive, context({ allowHighCost: false }))).toMatch(/high cost/);
        expect(ineligibleReason(expensive, context({ allowDominant: false }))).toMatch(/dominant/);
        expect(ineligibleReason(expensive, context())).toBeUndefined();
    });

    test('eligible plugins filters the catalog', () => {
        const restricted = context({ theme: theme({ excludedPlugins: ['source-a', 'source-b'] }) });

        expect(eligiblePlugins(restricted).map((entry) => entry.id)).not.toContain('source-a');
        expect(eligiblePlugins(restricted)).toHaveLength(CATALOG.length - 2);
    });
});

describe('conflicts', () => {
    test('a plugin conflicts with itself', () => {
        expect(conflictsWith([CATALOG[0]], CATALOG[0])).toBe(true);
    });

    test('incompatibility is honoured in both directions', () => {
        const left = plugin('left', 'transformer', {
            activationRules: { activationWeight: 1, incompatibleWith: ['right'] },
        });
        const right = plugin('right', 'transformer');

        expect(conflictsWith([left], right)).toBe(true);
        expect(conflictsWith([right], left)).toBe(true);
    });

    test('unrelated plugins do not conflict', () => {
        expect(conflictsWith([CATALOG[0]], CATALOG[1])).toBe(false);
    });
});

describe('character fit', () => {
    test('no target means everything fits', () => {
        expect(characterFit(character(), undefined)).toBe(1);
        expect(characterFit(character(), {})).toBe(1);
    });

    test('an exact match scores one', () => {
        expect(characterFit(character({ motionEnergy: 0.9 }), { motionEnergy: 0.9 })).toBeCloseTo(1, 6);
    });

    test('the opposite extreme scores zero', () => {
        expect(characterFit(character({ motionEnergy: 0 }), { motionEnergy: 1 })).toBeCloseTo(0, 6);
    });

    test('a closer plugin outscores a further one', () => {
        const target = { geometricOrder: 0.9, visualDensity: 0.2 };
        const clean = character({ geometricOrder: 0.85, visualDensity: 0.25 });
        const dense = character({ geometricOrder: 0.2, visualDensity: 0.9 });

        expect(characterFit(clean, target)).toBeGreaterThan(characterFit(dense, target));
    });

    test('dominance is matched when both sides commit to one', () => {
        const primary = character({ dominance: 'primary' });

        expect(characterFit(primary, { dominance: 'primary' })).toBeGreaterThan(
            characterFit(primary, { dominance: 'supporting' }),
        );
    });

    test('selection weight combines activation weight, preference, and fit', () => {
        const preferred = context({
            theme: theme({
                preferredPlugins: [{ pluginId: 'source-a', weight: 5 }],
                targetCharacter: { motionEnergy: 0.5 },
            }),
        });

        expect(selectionWeight(CATALOG[0], preferred)).toBeGreaterThan(selectionWeight(CATALOG[1], preferred));
    });

    test('a zero activation weight is never selected', () => {
        const never = plugin('never', 'source', { activationRules: { activationWeight: 0 } });

        expect(selectionWeight(never, context())).toBe(0);
    });
});

describe('dependency awareness', () => {
    const producer = plugin('producer', 'field', {
        outputs: [{ name: 'sdf', type: 'distance-field', required: false }],
    });
    const consumer = plugin('consumer', 'field', {
        inputs: [{ name: 'field', type: 'distance-field', required: true }],
        outputs: [{ name: 'out', type: 'mask-texture', required: false }],
    });

    test('a consumer is unsatisfiable with nothing chosen', () => {
        expect(inputsSatisfiable([], consumer)).toBe(false);
    });

    test('a consumer becomes satisfiable once its producer is chosen', () => {
        expect(inputsSatisfiable([producer], consumer)).toBe(true);
    });

    test('a plugin with no required inputs is always satisfiable', () => {
        expect(inputsSatisfiable([], producer)).toBe(true);
    });

    test('an optional input never blocks selection', () => {
        const optional = plugin('optional', 'transformer', {
            inputs: [{ name: 'mask', type: 'mask-texture', required: false }],
        });

        expect(inputsSatisfiable([], optional)).toBe(true);
    });

    test('a feedback plugin satisfies its own history port', () => {
        const feedback = plugin('feedback', 'transformer', {
            capabilities: ['feedback'],
            inputs: [{ name: 'history', type: 'color-texture', required: true }],
        });

        expect(inputsSatisfiable([], feedback)).toBe(true);
    });

    test('compatible substitution counts as satisfaction', () => {
        const wantsMask = plugin('wants-mask', 'transformer', {
            inputs: [{ name: 'mask', type: 'mask-texture', required: true }],
        });

        // A distance field satisfies a mask input, per the graph's compatibility rules.
        expect(inputsSatisfiable([producer], wantsMask)).toBe(true);
    });

    test('assembly never selects a consumer without its producer', () => {
        const catalog = [
            plugin('src', 'source'),
            producer,
            consumer,
            plugin('post', 'postprocess'),
        ];

        for (const seed of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) {
            const scene = assembleScene(seed, context({ available: catalog }));
            const ids = scene.plugins.map((entry) => entry.id);

            if (ids.includes('consumer')) {
                expect(ids, seed).toContain('producer');
            }
        }
    });
});

describe('scene assembly', () => {
    test('produces a grammar-satisfying scene', () => {
        const scene = assembleScene('seed-1', context());

        expect(scene.violations).toEqual([]);
        expect(satisfiesGrammar(scene.plugins, ORGANIC_FLOW)).toBe(true);
    });

    test('different seeds generally produce different scenes', () => {
        const scenes = new Set(
            ['a', 'b', 'c', 'd', 'e', 'f'].map((seed) =>
                assembleScene(seed, context()).plugins.map((entry) => entry.id).join(',')),
        );

        expect(scenes.size).toBeGreaterThan(1);
    });

    test('never selects the same plugin twice', () => {
        for (const seed of ['x', 'y', 'z', 'w']) {
            const ids = assembleScene(seed, context()).plugins.map((entry) => entry.id);
            expect(new Set(ids).size, seed).toBe(ids.length);
        }
    });

    test('respects a category range of zero', () => {
        // Geometric signal forbids simulators outright.
        for (const seed of ['g1', 'g2', 'g3', 'g4']) {
            const scene = assembleScene(seed, context({ theme: theme({ grammar: GEOMETRIC_SIGNAL }) }));
            expect(scene.plugins.filter((entry) => entry.category === 'simulator'), seed).toEqual([]);
        }
    });

    test('never exceeds one dominant generator', () => {
        const dominantCatalog = CATALOG.map((entry) => ({
            ...entry,
            cost: { ...entry.cost, dominant: true },
        }));

        for (const seed of ['d1', 'd2', 'd3', 'd4', 'd5']) {
            const scene = assembleScene(seed, context({ available: dominantCatalog }));
            const dominant = scene.plugins.filter((entry) => entry.cost.dominant);
            expect(dominant.length, seed).toBeLessThanOrEqual(ORGANIC_FLOW.maximumDominantPlugins);
        }
    });

    test('never exceeds the feedback limit', () => {
        const feedbackCatalog = CATALOG.map((entry) => ({ ...entry, capabilities: ['feedback'] }));

        for (const seed of ['f1', 'f2', 'f3']) {
            const scene = assembleScene(seed, context({ available: feedbackCatalog }));
            const feedback = scene.plugins.filter((entry) => entry.capabilities.includes('feedback'));
            expect(feedback.length, seed).toBeLessThanOrEqual(ORGANIC_FLOW.maximumFeedbackLoops);
        }
    });

    test('includes a visible source when the grammar requires one', () => {
        for (const seed of ['v1', 'v2', 'v3']) {
            const scene = assembleScene(seed, context());
            const visible = scene.plugins.some((entry) =>
                entry.category === 'source' && entry.outputs.some((port) => port.type === 'color-texture'));
            expect(visible, seed).toBe(true);
        }
    });

    test('an empty catalog yields an empty scene rather than throwing', () => {
        const scene = assembleScene('empty', context({ available: [] }));

        expect(scene.plugins).toEqual([]);
        // The violations report what is missing, so a caller can fall back.
        expect(scene.violations.length).toBeGreaterThan(0);
    });

    test('honours theme exclusions during assembly', () => {
        const restricted = context({
            theme: theme({ excludedPlugins: ['source-a', 'source-b', 'source-c'] }),
        });
        const scene = assembleScene('excluded', restricted);

        expect(scene.plugins.map((entry) => entry.id)).not.toContain('source-a');
    });

    test('excluding high-cost plugins still yields a scene', () => {
        const expensiveCatalog = [
            ...CATALOG,
            plugin('expensive', 'simulator', {
                cost: { gpu: 5, cpu: 3, memory: 4, renderPasses: 4, qualityScalable: true, dominant: true },
            }),
        ];
        const scene = assembleScene('cheap', context({ available: expensiveCatalog, allowHighCost: false }));

        expect(scene.plugins.map((entry) => entry.id)).not.toContain('expensive');
        expect(scene.violations).toEqual([]);
    });
});

describe('mutation', () => {
    const active: ActivePluginRecord[] = [
        { instanceId: 'i1', pluginId: 'source-a', activationTime: 0 },
        { instanceId: 'i2', pluginId: 'transform-a', activationTime: 0 },
    ];

    test('the timer only fires at the interval', () => {
        let state = createMutationState();
        const policy = { ...DEFAULT_MUTATION_POLICY, intervalSeconds: 10 };

        for (let second = 0; second < 9; second += 1) {
            const step = advanceMutation(state, 1, policy);
            state = step.state;
            expect(step.due).toBe(false);
        }

        const final = advanceMutation(state, 1, policy);
        expect(final.due).toBe(true);
        expect(final.state.secondsSinceMutation).toBe(0);
    });

    test('a frozen clock does not accumulate mutations', () => {
        let state = createMutationState();

        for (let frame = 0; frame < 1000; frame += 1) {
            state = advanceMutation(state, 0, DEFAULT_MUTATION_POLICY).state;
        }

        expect(state.secondsSinceMutation).toBe(0);
    });

    test('scene mutation is the rarest kind', () => {
        const weights = DEFAULT_MUTATION_POLICY.weights;

        expect(weights.scene).toBeLessThan(weights.branch);
        expect(weights.branch).toBeLessThan(weights.plugin);
        expect(weights.plugin).toBeLessThan(weights.parameter);
    });

    test('plugin mutation targets a mature instance and offers a same-category replacement', () => {
        const rng = createRng('mutate');
        const forced = { ...DEFAULT_MUTATION_POLICY, weights: { parameter: 0, plugin: 1, branch: 0, scene: 0 } };
        const decision = decideMutation(rng, active, context({ playbackTime: 100 }), forced);

        expect(decision.kind).toBe('plugin');
        expect(['i1', 'i2']).toContain(decision.targetInstanceId);
        expect(decision.replacement).toBeDefined();

        const target = active.find((record) => record.instanceId === decision.targetInstanceId)!;
        const original = CATALOG.find((entry) => entry.id === target.pluginId)!;
        expect(decision.replacement!.category).toBe(original.category);
        expect(decision.replacement!.id).not.toBe(original.id);
    });

    test('an immature scene falls back to parameter mutation rather than churning', () => {
        const rng = createRng('young');
        const forced = { ...DEFAULT_MUTATION_POLICY, weights: { parameter: 0, plugin: 1, branch: 0, scene: 0 } };
        // Everything activated moments ago.
        const decision = decideMutation(rng, active, context({ playbackTime: 1 }), forced);

        expect(decision.kind).toBe('parameter');
    });

    test('replacement never picks a plugin already active', () => {
        const rng = createRng('unique');
        const current = CATALOG.find((entry) => entry.id === 'transform-a')!;
        const allActive: ActivePluginRecord[] = [
            { instanceId: 'i1', pluginId: 'transform-a', activationTime: 0 },
            { instanceId: 'i2', pluginId: 'transform-b', activationTime: 0 },
        ];

        const replacement = pickReplacement(rng, current, allActive, context());

        expect(replacement?.id).toBe('transform-c');
    });

    test('replacement returns nothing when no alternative exists', () => {
        const rng = createRng('alone');
        const only = plugin('only-one', 'simulator');

        expect(pickReplacement(rng, only, [], context({ available: [only] }))).toBeUndefined();
    });

});
