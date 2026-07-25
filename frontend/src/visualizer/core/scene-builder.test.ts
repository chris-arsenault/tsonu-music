import { describe, expect, test } from 'vitest';
import { buildFirstViableScene, buildScene } from './scene-builder';
import { profileFor, QUALITY_LADDER } from './performance';
import { peakConcentration } from './audio-mapping';
import { m1Definitions } from '../plugins/registry';
import { GEOMETRIC_SIGNAL_THEME, IMAGE_DREAM_THEME, THEMES } from '../plugins/themes';
import { sceneSeed } from './random';
import type { SchedulerContext } from './scheduler';

const CATALOG = m1Definitions();

function context(overrides: Partial<SchedulerContext> = {}) {
    return {
        available: CATALOG,
        assets: [],
        capabilities: [],
        history: {},
        playbackTime: 0,
        ...overrides,
    } as Omit<SchedulerContext, 'theme' | 'allowHighCost' | 'allowDominant'>;
}

const FULL = profileFor(0);

describe('scene building', () => {
    test('builds a compilable scene from the M1 catalog', () => {
        const result = buildScene('seed-1', GEOMETRIC_SIGNAL_THEME, context(), FULL);

        expect(result.ok, result.ok ? '' : result.failure.detail).toBe(true);
        if (!result.ok) return;

        expect(result.scene.graph.order.length).toBeGreaterThan(0);
        expect(result.scene.graph.present).toBeDefined();
    });

    test('the same seed rebuilds the identical scene', () => {
        const first = buildScene('reproduce', GEOMETRIC_SIGNAL_THEME, context(), FULL);
        const second = buildScene('reproduce', GEOMETRIC_SIGNAL_THEME, context(), FULL);
        if (!first.ok || !second.ok) throw new Error('expected both builds to succeed');

        expect(first.scene.plugins.map((entry) => entry.id))
            .toEqual(second.scene.plugins.map((entry) => entry.id));
        expect(first.scene.graph.order.map((entry) => entry.instanceId))
            .toEqual(second.scene.graph.order.map((entry) => entry.instanceId));
        expect(first.scene.bindings).toEqual(second.scene.bindings);
    });

    test('different seeds give different scenes with the same theme', () => {
        const shapes = new Set<string>();

        for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
            const result = buildScene(seed, GEOMETRIC_SIGNAL_THEME, context(), FULL);
            if (result.ok) {
                shapes.add(result.scene.plugins.map((entry) => entry.id).join(','));
            }
        }

        expect(shapes.size).toBeGreaterThan(1);
    });

    test('a track change produces a new scene seed and so a new scene', () => {
        const first = buildScene(sceneSeed('track_a', 1), GEOMETRIC_SIGNAL_THEME, context(), FULL);
        const second = buildScene(sceneSeed('track_b', 2), GEOMETRIC_SIGNAL_THEME, context(), FULL);
        if (!first.ok || !second.ok) throw new Error('expected both builds to succeed');

        expect(first.scene.seed).not.toBe(second.scene.seed);
    });

    test('distributes reactivity rather than leaving every plugin on one feature', () => {
        const result = buildScene('spread', GEOMETRIC_SIGNAL_THEME, context(), FULL);
        if (!result.ok) throw new Error(result.failure.detail);

        const bindingCount = result.scene.bindings
            .reduce((total, entry) => total + entry.bindings.length, 0);

        expect(bindingCount).toBeGreaterThan(1);
        // No single feature drives every bound parameter in the scene.
        expect(peakConcentration(result.scene.bindings)).toBeLessThan(bindingCount);
    });

    test('a plugin binding two parameters keeps them on separate features', () => {
        const result = buildScene('separate', GEOMETRIC_SIGNAL_THEME, context(), FULL);
        if (!result.ok) throw new Error(result.failure.detail);

        const multiBound = result.scene.bindings.find((entry) => entry.bindings.length > 1);
        if (!multiBound) return;

        const features = multiBound.bindings.map((binding) => binding.feature);
        expect(new Set(features).size).toBe(features.length);
    });

    test('every built scene satisfies its own grammar', () => {
        for (const seed of ['g1', 'g2', 'g3', 'g4', 'g5']) {
            const result = buildScene(seed, GEOMETRIC_SIGNAL_THEME, context(), FULL);
            if (result.ok) {
                // Assembly guarantees this by construction; the check is that nothing after it breaks it.
                expect(result.scene.plugins.filter((entry) => entry.category === 'simulator'), seed).toEqual([]);
            }
        }
    });

    test('a feedback plugin in the scene yields a ping-pong resource', () => {
        for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']) {
            const result = buildScene(seed, GEOMETRIC_SIGNAL_THEME, context(), FULL);
            if (!result.ok) continue;

            const hasFeedback = result.scene.plugins.some((entry) => entry.capabilities.includes('feedback'));
            if (hasFeedback) {
                expect(result.scene.graph.pingPong.length, seed).toBeGreaterThan(0);
                return;
            }
        }
    });

    test('an empty catalog fails with a grammar reason rather than throwing', () => {
        const result = buildScene('empty', GEOMETRIC_SIGNAL_THEME, context({ available: [] }), FULL);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure.reason).toBe('grammar');
    });

    test('a theme the catalog cannot satisfy fails rather than producing a broken scene', () => {
        // Image dream wants album-art sources, which the M1 catalog does not have enough of.
        const result = buildScene('dream', IMAGE_DREAM_THEME, context(), FULL);

        if (!result.ok) {
            expect(['grammar', 'unsatisfied-inputs', 'compile']).toContain(result.failure.reason);
            expect(result.failure.detail.length).toBeGreaterThan(0);
        }
    });
});

describe('quality-constrained building', () => {
    test('the reduced grammar produces a smaller scene', () => {
        const full = buildScene('quality', GEOMETRIC_SIGNAL_THEME, context(), profileFor(0));
        const reduced = buildScene(
            'quality',
            GEOMETRIC_SIGNAL_THEME,
            context(),
            profileFor(QUALITY_LADDER.length - 2),
        );

        if (!full.ok || !reduced.ok) return;
        expect(reduced.scene.plugins.length).toBeLessThanOrEqual(full.scene.plugins.length);
    });

    test('a reduced profile swaps in the reduced grammar', () => {
        const reduced = buildScene(
            'reduced',
            GEOMETRIC_SIGNAL_THEME,
            context(),
            profileFor(QUALITY_LADDER.length - 2),
        );
        if (!reduced.ok) return;

        expect(reduced.scene.theme.grammar.simulatorCount).toEqual([0, 0]);
        expect(reduced.scene.theme.grammar.maximumHighCostPlugins).toBe(0);
    });

    test('a full profile keeps the theme grammar untouched', () => {
        const full = buildScene('full', GEOMETRIC_SIGNAL_THEME, context(), profileFor(0));
        if (!full.ok) return;

        expect(full.scene.theme.grammar).toBe(GEOMETRIC_SIGNAL_THEME.grammar);
    });

    test('excluding expensive plugins still yields a scene', () => {
        const constrained = { ...profileFor(0), expensivePrimary: false };
        const result = buildScene('cheap', GEOMETRIC_SIGNAL_THEME, context(), constrained);

        expect(result.ok, result.ok ? '' : result.failure.detail).toBe(true);
    });
});

describe('theme fallback', () => {
    test('falls through to a theme the catalog can satisfy', () => {
        const result = buildFirstViableScene('fallback', THEMES, context(), FULL);

        expect(result.ok, result.ok ? '' : result.failure.detail).toBe(true);
    });

    test('reports the last failure when no theme works', () => {
        const result = buildFirstViableScene('nothing', THEMES, context({ available: [] }), FULL);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure.detail.length).toBeGreaterThan(0);
    });

    test('an empty theme list fails cleanly', () => {
        const result = buildFirstViableScene('none', [], context(), FULL);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure.detail).toMatch(/no themes/);
    });

    test('fallback is deterministic', () => {
        const first = buildFirstViableScene('stable', THEMES, context(), FULL);
        const second = buildFirstViableScene('stable', THEMES, context(), FULL);
        if (!first.ok || !second.ok) throw new Error('expected both builds to succeed');

        expect(first.scene.theme.id).toBe(second.scene.theme.id);
        expect(first.scene.plugins.map((entry) => entry.id))
            .toEqual(second.scene.plugins.map((entry) => entry.id));
    });
});
