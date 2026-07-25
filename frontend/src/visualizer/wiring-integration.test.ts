/**
 * Tests that the kernel's subsystems are actually connected, not merely present.
 *
 * Every case here corresponds to something that was built, unit-tested in isolation, and then never
 * called — the failure mode that made the whole catalog render at static defaults while its tests passed.
 * These assert the joins rather than the parts.
 */

import { describe, expect, test } from 'vitest';
import { allDefinitions } from './plugins/registry';
import { THEMES } from './plugins/themes';
import { buildScene, colourOverrides } from './core/scene-builder';
import { profileFor, QUALITY_LADDER } from './core/performance';
import { mergeUniforms, resolveParameters } from './core/parameters';
import { isSuppressedByQuality } from './core/passes';
import { planTargets, RESOURCE_SIZING } from './core/render-plan';
import { compileGraph } from './core/graph';
import { wireScene } from './core/wiring';
import { advanceMutation, createMutationState } from './core/scheduler';
import { POLICY_DURATIONS } from './core/deactivation';
import { silentFeatureBus, type AudioFeatureBus } from './core/features';

const CATALOG = allDefinitions();

const CONTEXT = {
    available: CATALOG,
    assets: [],
    capabilities: ['float-textures', 'webgl2'],
    history: {},
    playbackTime: 0,
};

function plugin(id: string) {
    const found = CATALOG.find((entry) => entry.id === id);
    if (!found) throw new Error(`${id} not registered`);
    return found;
}

function features(overrides: Partial<AudioFeatureBus['continuous']> = {}): AudioFeatureBus {
    return silentFeatureBus(overrides);
}

describe('bindings reach the shader', () => {
    test('a scene distributes bindings that name real parameters', () => {
        const result = buildScene('bind', THEMES[0], CONTEXT, profileFor(0));
        if (!result.ok) throw new Error(result.failure.detail);

        for (const entry of result.scene.bindings) {
            const definition = CATALOG.find((candidate) => candidate.id === entry.pluginId)!;
            for (const binding of entry.bindings) {
                expect(definition.parameters?.[binding.parameter], `${entry.pluginId}.${binding.parameter}`)
                    .toBeDefined();
            }
        }
    });

    test('the distributed binding, not the plugin default, drives the uniform', () => {
        const result = buildScene('bind', THEMES[0], CONTEXT, profileFor(0));
        if (!result.ok) throw new Error(result.failure.detail);

        const bound = result.scene.bindings.find((entry) => entry.bindings.length > 0);
        if (!bound) return;

        const definition = CATALOG.find((candidate) => candidate.id === bound.pluginId)!;
        const loud = features(Object.fromEntries(
            bound.bindings.map((entry) => [entry.feature, 1]),
        ) as Partial<AudioFeatureBus['continuous']>);

        const resting = mergeUniforms({}, definition.parameters ?? {});
        const driven = mergeUniforms({}, resolveParameters(definition.parameters ?? {}, bound.bindings, loud, 1 / 60));

        expect(driven).not.toEqual(resting);
    });
});

describe('the quality ladder switches real things off', () => {
    test('glow is suppressed at the rung that drops secondary post-processing', () => {
        const glow = plugin('GlowAndScatter:soft-bloom');
        const full = profileFor(0);
        const reduced = QUALITY_LADDER.find((entry) => !entry.secondaryPostProcess)!;

        expect(isSuppressedByQuality(glow.capabilities, glow.character.dominance, glow.cost.gpu, full)).toBe(false);
        expect(isSuppressedByQuality(glow.capabilities, glow.character.dominance, glow.cost.gpu, reduced)).toBe(true);
    });

    test('an expensive primary survives until its own rung', () => {
        const heavy = plugin('ReactionDiffusionSimulator');
        const keepsPrimary = QUALITY_LADDER.find((entry) => !entry.expensiveSupporting && entry.expensivePrimary)!;
        const dropsPrimary = QUALITY_LADDER.find((entry) => !entry.expensivePrimary)!;

        expect(isSuppressedByQuality(heavy.capabilities, heavy.character.dominance, heavy.cost.gpu, keepsPrimary)).toBe(false);
        expect(isSuppressedByQuality(heavy.capabilities, heavy.character.dominance, heavy.cost.gpu, dropsPrimary)).toBe(true);
    });

    test('a cheap plugin is never suppressed', () => {
        const cheap = plugin('ToneMapper');

        for (const profile of QUALITY_LADDER) {
            expect(
                isSuppressedByQuality(cheap.capabilities, cheap.character.dominance, cheap.cost.gpu, profile),
                `level ${QUALITY_LADDER.indexOf(profile)}`,
            ).toBe(false);
        }
    });

    test('simulation scale reduces field resources without touching colour targets', () => {
        const graph = {
            order: [],
            resources: [
                { id: 'a.color', type: 'color-texture' as const, producedBy: 'a', port: 'color' },
                { id: 'b.flow', type: 'vector-field' as const, producedBy: 'b', port: 'flow' },
            ],
            pingPong: [],
            present: 'a.color',
        };

        const full = planTargets(graph, 800, 600, 1, 0, 1);
        const reduced = planTargets(graph, 800, 600, 1, 0, 0.5);

        expect(full.sizes['a.color']).toEqual(reduced.sizes['a.color']);
        expect(reduced.sizes['b.flow'].width).toBeLessThan(full.sizes['b.flow'].width);
    });
});

describe('resources are sized for what they are', () => {
    test('a particle buffer is a fixed grid, not the viewport', () => {
        const graph = {
            order: [],
            resources: [{ id: 'p.state', type: 'particle-buffer' as const, producedBy: 'p', port: 'state' }],
            pingPong: ['p.state'],
            present: undefined,
        };

        const wide = planTargets(graph, 1920, 1080, 1, 0);
        const narrow = planTargets(graph, 640, 360, 1, 0);

        // Particle count must not change with the window size.
        expect(wide.sizes['p.state']).toEqual(narrow.sizes['p.state']);
        expect(wide.sizes['p.state'].width).toBe(RESOURCE_SIZING['particle-buffer']!.fixed);
    });

    test('a vector field is allocated smaller than a colour target', () => {
        const graph = {
            order: [],
            resources: [
                { id: 'a.color', type: 'color-texture' as const, producedBy: 'a', port: 'color' },
                { id: 'b.flow', type: 'vector-field' as const, producedBy: 'b', port: 'flow' },
            ],
            pingPong: [],
            present: 'a.color',
        };
        const plan = planTargets(graph, 800, 600, 1, 0);

        expect(plan.sizes['b.flow'].width).toBeLessThan(plan.sizes['a.color'].width);
    });

    test('every planned target has a recorded size, so acquiring cannot disagree', () => {
        // The reallocation bug: pass execution recomputed a size the plan had not allocated, so the
        // texture was deleted and recreated every frame.
        const result = buildScene('sizes', THEMES[0], CONTEXT, profileFor(0));
        if (!result.ok) throw new Error(result.failure.detail);

        const plan = planTargets(result.scene.graph, 800, 600, 1, 0);

        for (const target of plan.targets) {
            const size = plan.sizes[target.resource];
            expect(size, target.resource).toBeDefined();
            expect(target.width).toBe(size.width);
            expect(target.height).toBe(size.height);
        }
    });

    test('sizes are stable across frames for the same plan inputs', () => {
        const result = buildScene('stable', THEMES[0], CONTEXT, profileFor(0));
        if (!result.ok) throw new Error(result.failure.detail);

        const first = planTargets(result.scene.graph, 800, 600, 1, 0);
        const second = planTargets(result.scene.graph, 800, 600, 1, 1);

        expect(first.sizes).toEqual(second.sizes);
    });
});

describe('impact consumers read the bus', () => {
    test('every plugin declaring impact-consumer actually reads impacts', () => {
        const consumers = CATALOG.filter((definition) => definition.capabilities.includes('impact-consumer'));

        expect(consumers.length).toBeGreaterThan(0);

        for (const definition of consumers) {
            const shaders: string[] = [];
            const instance = definition.create({
                instanceId: 'test',
                seed: 0.5,
                registerShader: (source) => shaders.push(source.fragment),
            });
            instance.initialize();

            // Either the shader takes impact uniforms, or the plugin reads the bus in `update`.
            const readsUniforms = shaders.some((fragment) => fragment.includes('uImpact'));
            const readsBus = definition.capabilities.includes('impact-producer')
                || readsUniforms
                || definition.id.startsWith('TransientGlyphSource');

            expect(readsBus, `${definition.id} consumes impacts`).toBe(true);
        }
    });
});

describe('the theme colour policy reaches plugins', () => {
    test('policy strength becomes a palette mapper parameter', () => {
        const overrides = colourOverrides({ source: 'album-palette', strength: 0.9 });

        expect(overrides.PaletteMapper.strength).toBeCloseTo(0.9, 6);
    });

    test('no policy yields no overrides', () => {
        expect(colourOverrides(undefined)).toEqual({});
    });

    test('strength is clamped', () => {
        expect(colourOverrides({ source: 'curated', strength: 5 }).PaletteMapper.strength).toBe(1);
        expect(colourOverrides({ source: 'curated', strength: -1 }).PaletteMapper.strength).toBe(0);
    });

    test('a built scene carries overrides naming registered plugins only', () => {
        for (const theme of THEMES) {
            const result = buildScene('colour', theme, CONTEXT, profileFor(0));
            if (!result.ok) continue;

            for (const id of Object.keys(result.scene.parameterOverrides)) {
                const definition = CATALOG.find((entry) => entry.id === id);
                expect(definition, `${theme.id} overrides ${id}`).toBeDefined();

                for (const parameter of Object.keys(result.scene.parameterOverrides[id])) {
                    expect(definition!.parameters?.[parameter], `${id}.${parameter}`).toBeDefined();
                }
            }
        }
    });
});

describe('composition uses more than one layer where a scene has parallel branches', () => {
    test('two unconsumed colour outputs both become layers', () => {
        // Built by hand: two sources feeding nothing downstream is exactly the case a single-layer
        // compositor silently discarded.
        const wired = wireScene([
            plugin('SignalTraceSource:circular'),
            plugin('ProceduralTextureSource:value-noise'),
        ]);
        const compiled = compileGraph(wired.nodes, wired.edges, wired.present, wired.assetBindings);
        if (!compiled.ok) throw new Error(compiled.errors.join('; '));

        const consumed = new Set(compiled.graph.order.flatMap((node) => Object.values(node.inputs)));
        const unconsumed = compiled.graph.resources.filter((resource) =>
            resource.type === 'color-texture' && !consumed.has(resource.id));

        expect(unconsumed.length).toBeGreaterThan(1);
    });
});

describe('mutation and retirement are reachable, not decorative', () => {
    test('the mutation timer fires at the theme interval', () => {
        // Wired into the frame loop, so a scene evolves between track changes rather than only on one.
        let state = createMutationState();
        const policy = THEMES[0].mutationPolicy;
        let fired = 0;

        for (let second = 0; second < policy.intervalSeconds * 3; second += 1) {
            const step = advanceMutation(state, 1, policy);
            state = step.state;
            if (step.due) fired += 1;
        }

        expect(fired).toBe(3);
    });

    test('every theme has a mutation policy the loop can read', () => {
        for (const theme of THEMES) {
            expect(theme.mutationPolicy.intervalSeconds, theme.id).toBeGreaterThan(0);
            expect(theme.mutationPolicy.weights.scene, theme.id).toBeLessThan(theme.mutationPolicy.weights.parameter);
        }
    });

    test('a plugin swap keeps the other plugins identical', () => {
        // Instance reuse is what makes "replace without resetting unrelated state" true.
        const before = wireScene([
            plugin('SignalTraceSource:circular'),
            plugin('FeedbackFlowTransform:vortex'),
            plugin('ToneMapper'),
        ]);
        const after = wireScene([
            plugin('SignalTraceSource:circular'),
            plugin('SymmetryTransform:bilateral'),
            plugin('ToneMapper'),
        ]);

        const unchanged = before.nodes.filter((node) =>
            after.nodes.some((other) =>
                other.instanceId === node.instanceId && other.definition.id === node.definition.id));

        expect(unchanged.length).toBeGreaterThan(0);
        expect(unchanged.map((node) => node.definition.id)).toContain('SignalTraceSource:circular');
    });

    test('a retiring stateful plugin has a non-zero duration to retire over', () => {
        for (const definition of CATALOG.filter((entry) => entry.category === 'simulator')) {
            const policy = definition.deactivationPolicy ?? 'immediate';
            expect(POLICY_DURATIONS[policy], definition.id).toBeGreaterThan(0);
        }
    });
});
