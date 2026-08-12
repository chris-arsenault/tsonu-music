import { describe, expect, test } from 'vitest';
import {
    buildFirstViableScene,
    buildScene,
    consumesMotion,
    contributingPluginIds,
    materialBranchCount,
    structuralViolations,
    variedThemeOrder,
    type SceneBuildContext,
} from './scene-builder';
import { profileFor, QUALITY_LADDER } from './performance';
import { isMotionSource } from './fields';
import { peakConcentration } from './audio-mapping';
import { allDefinitions } from '../plugins/registry';
import { GEOMETRIC_SIGNAL_THEME, THEMES } from '../plugins/themes';
import { assetResourceId, wireScene } from './wiring';
import { displacesHistory, isDerivedJoin, ORGANIC_FLOW, REDUCED_GRAMMAR, SPATIAL_FEEDBACK } from './grammar';
import type { PluginCategory, PortType, VisualPluginDefinition } from './plugin';

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

/** What the host actually supplies: artwork, a stencil, and a device that can hold float textures. */
const richContext = context({
    assets: ['album-art', 'album-art:current', 'mask', 'mask:inkblot'],
    capabilities: ['float-textures', 'webgl2'],
    assetResources: [
        { resource: assetResourceId('album-art:current'), type: 'color-texture' },
        { resource: assetResourceId('mask:inkblot'), type: 'mask-texture' },
    ],
});

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
        // A spatial field needs no consumer in the graph: the compositor sums every one of them into
        // the motion field that drags the accumulation, so an unread vector field is contributing
        // rather than orphaned. Simulation state still has to be read by a view.
        const orphanState = result.scene.graph.resources.filter((resource) =>
            resource.type !== 'color-texture'
            && !isMotionSource(resource.type)
            && !consumed.has(resource.id));

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
        // Several entropies per family rather than one. A single seed made this a statement about
        // that seed: assembly draws thirty-two candidates and a family whose sources mostly publish
        // palettes and masks rather than colour — image dream — fails a small share of seeds on the
        // branch minimum. Measured at 58 of 60. The renderer never depends on one seed either; it
        // falls through to the next family. What has to hold is that a family builds, not that it
        // builds at `complex-image-dream`.
        for (const theme of THEMES) {
            const attempts = Array.from({ length: 6 }, (_, index) =>
                buildScene(`complex-${theme.id}-${index}`, theme, richContext, FULL));
            const built = attempts.flatMap((result) => (result.ok ? [result.scene] : []));

            expect(
                built.length,
                `${theme.id}: ${attempts.flatMap((r) => (r.ok ? [] : [r.failure.detail])).join(' | ')}`,
            ).toBeGreaterThanOrEqual(attempts.length - 1);

            for (const scene of built) {
            const result = { ok: true as const, scene };

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
            // Every node's definition reaches a terminal. Compared per node rather than by counting
            // the set against `nodes.length`: `contributingPluginIds` returns definition ids, so a
            // scene holding two instances of one definition failed the count while being entirely
            // connected — which is the mismatch the scene builder's own prune comment describes.
            const contributing = contributingPluginIds(result.scene.wired);
            expect(
                result.scene.wired.nodes
                    .map((node) => node.definition.id)
                    .filter((id) => !contributing.has(id)),
                `${theme.id} nodes reaching nothing`,
            ).toEqual([]);
            }
        }
    });

    test('every previous-frame image read passes through a displacing transport', () => {
        // A feedback edge alone is memory without motion: an echo resamples fixed offsets, a
        // fold-back blends in place. Every image loop must read its past through a transport
        // whose per-frame step compounds — the shape the canonical state proves (ADR-0016). The
        // transport family is anything declaring SPATIAL_FEEDBACK, not one plugin standing in
        // for all motion.
        for (const seed of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8']) {
            const result = buildScene(seed, GEOMETRIC_SIGNAL_THEME, context(), FULL);
            if (!result.ok) continue;

            for (const edge of result.scene.wired.edges) {
                if (!edge.feedback) continue;
                const sink = result.scene.wired.nodes
                    .find((node) => node.instanceId === edge.to.instanceId)!;
                const port = sink.definition.inputs.find((input) => input.name === edge.to.port);
                if (!port || port.type !== 'color-texture') continue;

                expect(
                    displacesHistory(sink.definition),
                    `${seed}: ${edge.from.instanceId} -> ${edge.to.instanceId}.${edge.to.port}`,
                ).toBe(true);
            }
        }
    });

    test('every scene presents its graph-owned image history resource', () => {
        for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']) {
            const result = buildScene(seed, GEOMETRIC_SIGNAL_THEME, context(), FULL);
            if (!result.ok) continue;

            expect(result.scene.graph.state, seed).toBeDefined();
            const imageResources = new Set(result.scene.graph.resources
                .filter((resource) => resource.type === 'color-texture')
                .map((resource) => resource.id));
            // The state resource ping-pongs, and material trails may add their own history buffers
            // beside it (ADR-0016) — those are the scene's material memory, not competitors.
            expect(result.scene.graph.pingPong.filter((resource) => imageResources.has(resource)), seed)
                .toContain(result.scene.graph.state!.stateResource);
            // Presentation may be the combine's display output; the state stays the feedback read.
            const combine = result.scene.wired.nodes
                .find((node) => node.definition.temporalCombine !== undefined)!;
            const presentPort = combine.definition.temporalCombine!.displayOutput
                ?? combine.definition.temporalCombine!.output;
            expect(result.scene.graph.present, seed)
                .toBe(result.scene.graph.state!.stateResource.replace(/\.[^.]+$/, `.${presentPort}`));
        }
    });

    test('no derived join reads a branch that is already inside its other operand', () => {
        // The gain chain behind the black-with-white-flashes scene. A join whose two inputs share
        // material adds a picture to itself: two in series multiply a bright figure by four, the
        // tone map clamps the rest, and the scene reads as flashes on black. It happened because a
        // join was appended to the plugin list and re-wired, so its operands came from the same
        // newest-and-unconsumed search as everything else and, once the unread outputs ran out,
        // resolved to one branch twice. Measured before the mixers became splices: 306 of 850 joins
        // across 240 builds, in 72% of scenes.
        for (const theme of THEMES) {
            for (let index = 0; index < 8; index += 1) {
                const result = buildScene(`self-mix-${theme.id}-${index}`, theme, richContext, FULL);
                if (!result.ok) continue;
                const scene = result.scene.wired;

                const feeds = (instanceId: string): Set<string> => {
                    const seen = new Set<string>();
                    const stack = [instanceId];
                    while (stack.length > 0) {
                        const current = stack.pop()!;
                        for (const edge of scene.edges) {
                            if (edge.feedback || edge.from.instanceId !== current) continue;
                            if (seen.has(edge.to.instanceId)) continue;
                            seen.add(edge.to.instanceId);
                            stack.push(edge.to.instanceId);
                        }
                    }
                    return seen;
                };

                for (const join of scene.nodes.filter((node) => isDerivedJoin(node.definition))) {
                    const operands = scene.edges.filter((edge) =>
                        !edge.feedback
                        && edge.to.instanceId === join.instanceId
                        && join.definition.inputs
                            .find((input) => input.name === edge.to.port)?.type === 'color-texture');

                    for (const operand of operands) {
                        for (const other of operands) {
                            if (operand === other) continue;
                            expect(
                                operand.from.instanceId === other.from.instanceId
                                    || feeds(other.from.instanceId).has(operand.from.instanceId),
                                `${theme.id}-${index} ${join.instanceId}: `
                                + `${other.from.instanceId} + ${operand.from.instanceId}`,
                            ).toBe(false);
                        }
                    }
                }
            }
        }
    });

    test('a leftover branch becomes an argument where an input is open', () => {
        // The composition the whole rebuild is for: given branches f, g and h, the scene should read
        // as f(g(h())) rather than f() + g() + h(). A branch nothing consumes is offered to an open
        // structural input — a generator's edge, interior, domain or profile — before any mixer is
        // considered, so one branch's picture becomes another's geometry.
        let nested = 0;
        let built = 0;
        for (const theme of THEMES) {
            for (let index = 0; index < 10; index += 1) {
                const result = buildScene(`nesting-${theme.id}-${index}`, theme, richContext, FULL);
                if (!result.ok) continue;
                built += 1;
                const scene = result.scene.wired;
                const byInstance = new Map(scene.nodes.map((node) => [node.instanceId, node]));
                const structural = scene.edges.some((edge) => {
                    if (edge.feedback) return false;
                    const sink = byInstance.get(edge.to.instanceId);
                    return sink?.definition.inputs
                        .find((input) => input.name === edge.to.port)?.structural === true;
                });
                if (structural) nested += 1;
            }
        }

        expect(built).toBeGreaterThan(0);
        expect(nested / built).toBeGreaterThan(0.25);
    });

    test('a structural output reaches only a structural input', () => {
        // The spectrum's band strip is data: one bar per bin, meaningful as another generator's edge
        // or profile and meaningless composited over the picture. Wiring offered it to whatever
        // colour input came next, so a mixer drew 64 bars across the frame — the same defect the
        // strip exists to fix, arriving through the wiring instead of the join.
        for (const theme of THEMES) {
            for (let index = 0; index < 6; index += 1) {
                const result = buildScene(`strip-${theme.id}-${index}`, theme, richContext, FULL);
                if (!result.ok) continue;
                const scene = result.scene.wired;
                const byInstance = new Map(scene.nodes.map((node) => [node.instanceId, node]));

                for (const edge of scene.edges) {
                    const producer = byInstance.get(edge.from.instanceId);
                    const output = producer?.definition.outputs
                        .find((port) => port.name === edge.from.port);
                    if (!output?.structural) continue;

                    const sink = byInstance.get(edge.to.instanceId);
                    const input = sink?.definition.inputs.find((port) => port.name === edge.to.port);
                    expect(
                        input?.structural,
                        `${theme.id}-${index}: ${edge.from.instanceId}.${edge.from.port}`
                        + ` -> ${edge.to.instanceId}.${edge.to.port}`,
                    ).toBe(true);
                }
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

/**
 * Category counts describe what a scene contains; these describe how it is joined.
 *
 * A scene could satisfy every count and still be a bag of parts: a field slot filled by a plugin that
 * produces no field, or a compositor reading the same branch on both inputs.
 */
describe('structural predicates', () => {
    const definition = (
        id: string,
        category: PluginCategory,
        outputs: { name: string; type: PortType }[],
        overrides: Partial<VisualPluginDefinition> = {},
    ): VisualPluginDefinition => ({
        id,
        version: 1,
        category,
        inputs: [],
        outputs: outputs.map((port) => ({ ...port, required: false })),
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
    });

    const colour = (id: string, category: PluginCategory = 'source') =>
        definition(id, category, [{ name: 'color', type: 'color-texture' }]);

    /**
     * A stage that consumes a branch and emits one, which is what a post-processing stage is.
     *
     * The fixture used to declare no inputs, so it did not actually transform anything — it sat beside
     * its supposed input as a second unread terminal. Harmless while nothing counted terminals, and
     * wrong once something did.
     */
    const stage = (id: string, category: PluginCategory = 'postprocess') =>
        definition(id, category, [{ name: 'color', type: 'color-texture' }], {
            inputs: [{ name: 'source', type: 'color-texture', required: true }],
        });

    test('a post-processing stage transforms a branch rather than being one', () => {
        const scene = wireScene([colour('a'), stage('post')]);

        expect(materialBranchCount(scene)).toBe(1);
    });

    test('two producers are two branches', () => {
        expect(materialBranchCount(wireScene([colour('a'), colour('b')]))).toBe(2);
    });

    test('a scene below the branch minimum is rejected', () => {
        const scene = wireScene([colour('a'), stage('post')]);

        expect(structuralViolations(scene, ORGANIC_FLOW).map((entry) => entry.kind))
            .toContain('too-few-branches');
        expect(structuralViolations(scene, REDUCED_GRAMMAR)).toEqual([]);
    });

    test('a scene with no loop at all is rejected on the count and on the motion', () => {
        // Both, and they are different complaints: one says the scene has no memory beyond the
        // kernel's, the other that whatever memory it has is never displaced. See ADR-0012.
        const scene = wireScene([colour('a'), colour('b'), colour('c'), stage('post')]);
        const kinds = structuralViolations(scene, ORGANIC_FLOW).map((entry) => entry.kind);

        expect(kinds).toContain('too-few-feedback');
        expect(kinds).toContain('no-spatial-loop');
    });

    test('a colour loop satisfies the count but not the motion', () => {
        const mixer = definition('mix', 'compositor', [{ name: 'color', type: 'color-texture' }], {
            inputs: [
                { name: 'source', type: 'color-texture', required: true },
                { name: 'history', type: 'color-texture', required: false },
            ],
            capabilities: ['feedback'],
        });
        const scene = wireScene([colour('a'), colour('b'), colour('c'), mixer]);
        const kinds = structuralViolations(scene, ORGANIC_FLOW).map((entry) => entry.kind);

        expect(kinds).not.toContain('too-few-feedback');
        expect(kinds).toContain('no-spatial-loop');
    });

    test('a loop into a plugin that displaces what it reads satisfies both', () => {
        const warp = definition('warp', 'transformer', [{ name: 'color', type: 'color-texture' }], {
            inputs: [
                { name: 'source', type: 'color-texture', required: true },
                { name: 'history', type: 'color-texture', required: false },
            ],
            capabilities: ['feedback', SPATIAL_FEEDBACK],
        });
        const scene = wireScene([colour('a'), colour('b'), colour('c'), warp]);
        const kinds = structuralViolations(scene, ORGANIC_FLOW).map((entry) => entry.kind);

        expect(kinds).not.toContain('too-few-feedback');
        expect(kinds).not.toContain('no-spatial-loop');
    });

    test('a value port chaining to itself is not an image loop', () => {
        // `ParticleEmitter` and its neighbours each declare a `previous` port so they can chain, and
        // the first in a chain has no upstream producer, so wiring closes it on itself. Counting
        // that put four loops in a family whose ceiling is one.
        const emitter = definition('emit', 'field', [{ name: 'emitters', type: 'particle-emitter' }], {
            inputs: [{ name: 'previous', type: 'particle-emitter', required: false }],
        });
        const scene = wireScene([colour('a'), colour('b'), colour('c'), emitter]);

        expect(scene.edges.some((edge) => edge.feedback)).toBe(true);
        expect(structuralViolations(scene, ORGANIC_FLOW).map((entry) => entry.kind))
            .toContain('too-few-feedback');
    });

    test('a spatial field nothing reads is pruned like anything else', () => {
        // This asserted the opposite, and was right to while a kernel pass summed every field into
        // the motion bus whether or not the graph read it — judging contribution by paths would have
        // pruned exactly the plugins that moved the picture. With the bus retired (ADR-0012) a field
        // reaches the picture through an edge like everything else, and one nothing reads is a pass
        // drawn into a texture that is sampled by nothing.
        const orphaned = wireScene([
            colour('src'),
            definition('fld', 'field', [{ name: 'flow', type: 'vector-field' }]),
        ]);

        expect(contributingPluginIds(orphaned)).not.toContain('fld');
    });

    test('a spatial field something reads contributes', () => {
        const warp = definition('warp', 'transformer', [{ name: 'color', type: 'color-texture' }], {
            inputs: [
                { name: 'source', type: 'color-texture', required: true },
                { name: 'field', type: 'vector-field', required: true },
            ],
        });
        const wired = wireScene([
            colour('src'),
            definition('fld', 'field', [{ name: 'flow', type: 'vector-field' }]),
            warp,
        ]);

        expect(contributingPluginIds(wired)).toContain('fld');
        expect(consumesMotion(wired)).toBe(true);
    });

    test('a scene whose field reaches nothing fails the motion requirement', () => {
        const scene = wireScene([
            colour('a'),
            colour('b'),
            colour('c'),
            definition('fld', 'field', [{ name: 'flow', type: 'vector-field' }]),
        ]);

        expect(consumesMotion(scene)).toBe(false);
        expect(structuralViolations(scene, ORGANIC_FLOW).map((entry) => entry.kind))
            .toContain('no-motion-source');
    });

    test('a field producing no spatial output is still pruned when nothing reads it', () => {
        const scene = wireScene([
            colour('src'),
            definition('spawn', 'field', [{ name: 'spawn', type: 'particle-buffer' }]),
        ]);

        expect(contributingPluginIds(scene)).not.toContain('spawn');
    });
});
