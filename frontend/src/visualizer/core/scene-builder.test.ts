import { describe, expect, test } from 'vitest';
import {
    buildFirstViableScene,
    buildScene,
    contributingPluginIds,
    variedThemeOrder,
    type SceneBuildContext,
} from './scene-builder';
import { profileFor, QUALITY_LADDER } from './performance';
import { peakConcentration } from './audio-mapping';
import { allDefinitions } from '../plugins/registry';
import { GEOMETRIC_SIGNAL_THEME, THEMES } from '../plugins/themes';
import { assetResourceId } from './wiring';

const FULL_CATALOG = allDefinitions();

function context(overrides: Partial<SceneBuildContext> = {}): SceneBuildContext {
    return {
        available: FULL_CATALOG,
        assets: [],
        capabilities: [],
        history: {},
        playbackTime: 0,
        ...overrides,
    };
}

const FULL = profileFor(0);

describe('scene building', () => {
    test('builds a compilable connected scene from the full catalog', () => {
        const result = buildScene('seed-1', GEOMETRIC_SIGNAL_THEME, context(), FULL);

        expect(result.ok, result.ok ? '' : result.failure.detail).toBe(true);
        if (!result.ok) return;

        expect(result.scene.graph.order.length).toBeGreaterThan(0);
        expect(result.scene.graph.present).toBeDefined();
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

    test('the reported polygon seed has no orphan field or mismatched simulation view', () => {
        const result = buildScene(
            'reported-static-silhouette',
            GEOMETRIC_SIGNAL_THEME,
            context({
                available: FULL_CATALOG,
                assets: ['album-art', 'album-art:current', 'mask', 'mask:inkblot'],
                capabilities: ['float-textures', 'webgl2'],
                assetResources: [
                    { resource: assetResourceId('album-art:current'), type: 'color-texture' },
                    { resource: assetResourceId('mask:inkblot'), type: 'mask-texture' },
                ],
            }),
            FULL,
        );

        expect(result.ok, result.ok ? '' : result.failure.detail).toBe(true);
        if (!result.ok) return;

        const ids = result.scene.plugins.map((entry) => entry.id);
        expect(ids).not.toContain('ProceduralVectorField:attract');
        if (ids.includes('WaveFieldView')) {
            expect(ids).toContain('WaveFieldSimulator');
        }
        if (ids.includes('ReactionDiffusionView')) {
            expect(ids).toContain('ReactionDiffusionSimulator');
        }

        const consumed = new Set(
            result.scene.graph.order.flatMap((node) => [
                ...Object.values(node.inputs),
                ...Object.values(node.previous),
            ]),
        );
        const orphanState = result.scene.graph.resources.filter((resource) =>
            resource.type !== 'color-texture' && !consumed.has(resource.id));

        expect(orphanState).toEqual([]);
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

    test('every visual family builds a connected composition with explicit interaction', () => {
        const richContext = context({
            assets: ['album-art', 'album-art:current', 'mask', 'mask:inkblot'],
            capabilities: ['float-textures', 'webgl2'],
            assetResources: [
                { resource: assetResourceId('album-art:current'), type: 'color-texture' },
                { resource: assetResourceId('mask:inkblot'), type: 'mask-texture' },
            ],
        });

        for (const theme of THEMES) {
            const result = buildScene(`complex-${theme.id}`, theme, richContext, FULL);

            expect(result.ok, result.ok ? '' : `${theme.id}: ${result.failure.detail}`).toBe(true);
            if (!result.ok) continue;

            expect(
                result.scene.plugins.filter((entry) =>
                    entry.category !== 'postprocess'
                    && entry.outputs.some((port) => port.type === 'color-texture')).length,
                `${theme.id} visible material branches`,
            ).toBeGreaterThanOrEqual(2);
            expect(
                result.scene.plugins.some((entry) => entry.category === 'compositor'),
                `${theme.id} compositor`,
            ).toBe(true);
            expect(contributingPluginIds(result.scene.wired).size, `${theme.id} connected nodes`)
                .toBe(result.scene.wired.nodes.length);
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

    test('fresh scene entropy varies which visual family gets first chance', () => {
        const firstChoices = new Set(
            Array.from({ length: 24 }, (_, index) =>
                variedThemeOrder(`fresh-${index}`, THEMES)[0]?.id),
        );

        expect(firstChoices.size).toBe(THEMES.length);
    });
});
