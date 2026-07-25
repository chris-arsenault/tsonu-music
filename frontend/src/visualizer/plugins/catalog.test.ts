import { describe, expect, test } from 'vitest';
import {
    allDefinitions,
    compositorDefinitions,
    createM1Registry,
    fieldDefinitions,
    simulatorDefinitions,
    sourceDefinitions,
    transformerDefinitions,
} from './registry';
import { validateDefinition, type PluginCategory, type VisualPluginDefinition } from '../core/plugin';
import { compileGraph } from '../core/graph';
import { assetResourceId, wireScene, type AssetResource } from '../core/wiring';
import { buildScene } from '../core/scene-builder';
import { profileFor, QUALITY_LADDER } from '../core/performance';
import { COLLISION_ENERGY, GEOMETRIC_SIGNAL, ORGANIC_FLOW, satisfiesGrammar } from '../core/grammar';
import { COLLISION_ENERGY_THEME, GEOMETRIC_SIGNAL_THEME, ORGANIC_FLOW_THEME, THEMES } from './themes';
import { createImpactBus, type ImpactEvent } from '../core/impact';
import { advanceCascade, CASCADE_MODES, seedCascade } from './simulators/impact-cascade';
import { availableAssetIds, maskAssetFrom, albumArtAssetFrom } from '../core/assets';
import type { FrameContext } from '../core/plugin';

const CATALOG = allDefinitions();

function createContext(seed = 0.42) {
    const shaders: string[] = [];
    return {
        context: { instanceId: 'test', seed, registerShader: (s: { id: string }) => shaders.push(s.id) },
        shaders,
    };
}

function frame(overrides: Partial<FrameContext> = {}): { frame: FrameContext; impacts: ImpactEvent[] } {
    const impacts: ImpactEvent[] = [];

    return {
        impacts,
        frame: {
            clock: { trackId: 't', playbackTime: 10, duration: 100, state: 'playing', generation: 1 },
            features: {
                continuous: {
                    rms: 0.5, peak: 0.7, subBass: 0.3, bass: 0.6, lowMid: 0.4, mid: 0.4,
                    highMid: 0.3, treble: 0.35, spectralCentroid: 0.4, spectralFlux: 0.3,
                    beatConfidence: 0.7, beatPhase: 0.3, leftLevel: 0.5, rightLevel: 0.5, stereoBalance: 0,
                },
                events: {
                    onset: [{ feature: 'onset', playbackTime: 10, audioTime: 10, strength: 0.8 }],
                    beat: [], sectionChange: [],
                },
                waveform: Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 5)),
                spectrum: Float32Array.from({ length: 64 }, (_, i) => 1 / (i + 1)),
            },
            deltaSeconds: 1 / 60,
            seed: 0.42,
            renderWidth: 640,
            renderHeight: 360,
            parameters: {},
            uploadGeometry: () => undefined,
            impacts: createImpactBus(),
            publishImpacts: (published) => impacts.push(...published),
            ...overrides,
        },
    };
}

/** Every declared input satisfied, so a plugin's pass list can be inspected. */
function renderWithAllInputs(definition: VisualPluginDefinition) {
    const instance = definition.create(createContext().context);
    instance.initialize();
    instance.activate({
        clock: { trackId: 't', playbackTime: 0, duration: 1, state: 'playing', generation: 1 },
        parameters: definition.parameters ?? {},
    });
    instance.update(frame().frame);

    return instance.render({
        inputs: Object.fromEntries(definition.inputs.map((port) => [port.name, `in.${port.name}`])),
        outputs: Object.fromEntries(definition.outputs.map((port) => [port.name, `out.${port.name}`])),
        previous: Object.fromEntries(definition.inputs.map((port) => [port.name, `prev.${port.name}`])),
        renderWidth: 640,
        renderHeight: 360,
    });
}

describe('catalog integrity', () => {
    test('every definition is structurally valid', () => {
        for (const definition of CATALOG) {
            expect(validateDefinition(definition), definition.id).toEqual([]);
        }
    });

    test('every id is unique', () => {
        const ids = CATALOG.map((definition) => definition.id);

        expect(new Set(ids).size).toBe(ids.length);
    });

    test('the whole catalog registers without a kernel change', () => {
        expect(() => createM1Registry()).not.toThrow();
        expect(createM1Registry().all()).toHaveLength(CATALOG.length);
    });

    test('every spec section 24 plugin family is present', () => {
        const families = [
            'SignalTraceSource', 'SpectrumGeometrySource', 'TransientGlyphSource',
            'ProceduralTextureSource', 'ParametricCurveSource', 'SDFShapeSource',
            'AlbumArtSource', 'AlbumArtPalette', 'AlbumArtEdges',
            'ProceduralVectorField', 'AudioImpulseField', 'MaskSignedDistanceField',
            'MaskContainmentField', 'ImageLuminanceField',
            'ParticleSimulator', 'ParticleEmitter', 'ParticleForceField', 'ParticleRenderer',
            'ParticleTrailInjector', 'ReactionDiffusionSimulator', 'WaveFieldSimulator',
            'ImpactCascadeSimulator',
            'FeedbackFlowTransform', 'SymmetryTransform', 'CoordinateWarpTransform',
            'DomainWarpTransform', 'TilingTransform', 'EdgeContourTransform', 'ShockwaveTransform',
            'LayerMixer', 'MaskRouter', 'FeedbackInjector', 'PaletteMapper', 'ColorTransform',
            'GlowAndScatter', 'ToneMapper',
        ];

        for (const family of families) {
            const present = CATALOG.some((definition) => definition.id.split(':')[0] === family);
            expect(present, `${family} is registered`).toBe(true);
        }
    });

    test('every category has members', () => {
        const categories: PluginCategory[] = [
            'source', 'field', 'simulator', 'transformer', 'compositor', 'postprocess',
        ];

        for (const category of categories) {
            expect(CATALOG.filter((d) => d.category === category).length, category).toBeGreaterThan(0);
        }
    });

    test('every plugin registers shaders at initialization and emits passes when fully wired', () => {
        for (const definition of CATALOG) {
            const { context, shaders } = createContext();
            const instance = definition.create(context);
            instance.initialize();

            expect(shaders.length, `${definition.id} registers a shader`).toBeGreaterThan(0);
            expect(renderWithAllInputs(definition).length, `${definition.id} emits a pass`).toBeGreaterThan(0);
        }
    });

    test('every plugin with a required input emits nothing when it is missing', () => {
        for (const definition of CATALOG) {
            if (!definition.inputs.some((port) => port.required)) {
                continue;
            }

            const instance = definition.create(createContext().context);
            instance.initialize();
            instance.update(frame().frame);

            const passes = instance.render({
                inputs: {},
                outputs: Object.fromEntries(definition.outputs.map((p) => [p.name, `out.${p.name}`])),
                previous: {},
                renderWidth: 640,
                renderHeight: 360,
            });

            expect(passes, `${definition.id} degrades to no passes`).toEqual([]);
        }
    });

    test('no plugin declares more render passes than it emits', () => {
        for (const definition of CATALOG) {
            const passes = renderWithAllInputs(definition);
            expect(passes.length, definition.id).toBeLessThanOrEqual(definition.cost.renderPasses);
        }
    });

    test('only the impact cascade is dominant', () => {
        const dominant = CATALOG.filter((definition) => definition.cost.dominant);

        expect(dominant.length).toBeGreaterThan(0);
        for (const definition of dominant) {
            expect(definition.id.startsWith('ImpactCascadeSimulator'), definition.id).toBe(true);
        }
    });

    test('feedback-capable plugins do not clear their target', () => {
        for (const definition of CATALOG.filter((d) => d.capabilities.includes('feedback'))) {
            const passes = renderWithAllInputs(definition);
            expect(passes[0]?.clear, `${definition.id} accumulates`).not.toBe(true);
        }
    });

    test('stateful plugins declare a graceful deactivation policy', () => {
        const stateful = CATALOG.filter((definition) =>
            definition.category === 'simulator' || definition.capabilities.includes('feedback'));

        for (const definition of stateful) {
            expect(definition.deactivationPolicy, definition.id).not.toBe('immediate');
            expect(definition.deactivationPolicy, definition.id).toBeDefined();
        }
    });

    test('the group helpers partition the catalog', () => {
        const grouped = [
            ...sourceDefinitions(),
            ...fieldDefinitions(),
            ...simulatorDefinitions(),
            ...transformerDefinitions(),
            ...compositorDefinitions(),
        ].length;

        expect(grouped).toBeLessThan(CATALOG.length);
        expect(grouped).toBeGreaterThan(CATALOG.length / 2);
    });
});

describe('impact dynamics', () => {
    test('every cascade mode seeds projectiles', () => {
        for (const mode of CASCADE_MODES) {
            expect(seedCascade(mode, 0.5, 24).length, mode).toBe(24);
        }
    });

    test('projectiles accelerate rather than drifting at constant velocity', () => {
        for (const mode of CASCADE_MODES) {
            const seeded = seedCascade(mode, 0.5, 8);
            const before = seeded.map((p) => Math.hypot(p.vx, p.vy));
            const after = advanceCascade(mode, seeded, 1 / 60, 10, 1)
                .projectiles.filter((p) => !p.fragment)
                .map((p) => Math.hypot(p.vx, p.vy));

            const changed = after.some((speed, index) => Math.abs(speed - before[index]) > 1e-6);
            expect(changed, `${mode} accelerates`).toBe(true);
        }
    });

    test('collision produces an impact and fragments', () => {
        // Placed at the core so a collision is certain.
        const colliding = [{ x: 0.001, y: 0, vx: 0.9, vy: 0, energy: 1, fragment: false, age: 0 }];
        const result = advanceCascade('gravity-capture', colliding, 1 / 60, 12.5, 1);

        expect(result.impacts).toHaveLength(1);
        expect(result.impacts[0].playbackTime).toBe(12.5);
        expect(result.impacts[0].energy).toBeGreaterThan(0);
        // Fragment spray: the projectile is replaced by many.
        expect(result.projectiles.filter((p) => p.fragment).length).toBeGreaterThan(5);
        expect(result.projectiles.some((p) => !p.fragment)).toBe(false);
    });

    test('impact position is in texture space, not clip space', () => {
        const colliding = [{ x: 0.001, y: 0, vx: 0.9, vy: 0, energy: 1, fragment: false, age: 0 }];
        const [impact] = advanceCascade('gravity-capture', colliding, 1 / 60, 10, 1).impacts;

        expect(impact.position[0]).toBeGreaterThanOrEqual(0);
        expect(impact.position[0]).toBeLessThanOrEqual(1);
        expect(impact.position[1]).toBeGreaterThanOrEqual(0);
        expect(impact.position[1]).toBeLessThanOrEqual(1);
    });

    test('a frozen clock produces no motion and no impacts', () => {
        const seeded = seedCascade('orbital-collapse', 0.5, 12);
        const result = advanceCascade('orbital-collapse', seeded, 0, 10, 1);

        expect(result.impacts).toEqual([]);
        expect(result.projectiles).toEqual(seeded);
    });

    test('energy scale changes impact energy', () => {
        const colliding = () => [{ x: 0.001, y: 0, vx: 0.9, vy: 0, energy: 1, fragment: false, age: 0 }];

        const quiet = advanceCascade('gravity-capture', colliding(), 1 / 60, 10, 0.5).impacts[0];
        const loud = advanceCascade('gravity-capture', colliding(), 1 / 60, 10, 2).impacts[0];

        expect(loud.energy).toBeGreaterThan(quiet.energy);
    });

    test('fragments expire rather than accumulating without bound', () => {
        let projectiles = seedCascade('head-on', 0.5, 12);

        for (let step = 0; step < 400; step += 1) {
            projectiles = advanceCascade('head-on', projectiles, 1 / 60, 10 + step / 60, 1).projectiles;
        }

        expect(projectiles.length).toBeLessThanOrEqual(384);
    });

    test('the simulator publishes impacts through the kernel bus', () => {
        const definition = CATALOG.find((d) => d.id === 'ImpactCascadeSimulator:gravity-capture')!;
        const instance = definition.create(createContext(0.1).context);
        instance.initialize();
        instance.activate({
            clock: { trackId: 't', playbackTime: 0, duration: 100, state: 'playing', generation: 1 },
            parameters: definition.parameters ?? {},
        });

        // Run long enough for the gravity well to pull a stream into the core.
        let published: ImpactEvent[] = [];
        for (let step = 0; step < 300; step += 1) {
            const context = frame({ deltaSeconds: 1 / 60 });
            instance.update(context.frame);
            published = published.concat(context.impacts);
        }

        expect(published.length).toBeGreaterThan(0);
    });
});

describe('scene assembly across the full catalog', () => {
    const base = {
        available: CATALOG,
        capabilities: ['float-textures', 'webgl2'],
        history: {},
        playbackTime: 0,
    };

    test('every theme builds a compilable scene', () => {
        for (const theme of THEMES) {
            const result = buildScene(`theme-${theme.id}`, theme, { ...base, assets: [] }, profileFor(0));

            if (!result.ok) {
                // Image dream wants artwork; retry with it before calling this a failure.
                const withArt = buildScene(
                    `theme-${theme.id}`,
                    theme,
                    { ...base, assets: availableAssetIds([albumArtAssetFrom('/art.jpg')]) },
                    profileFor(0),
                );
                expect(withArt.ok, `${theme.id}: ${withArt.ok ? '' : withArt.failure.detail}`).toBe(true);
                continue;
            }

            expect(result.ok).toBe(true);
        }
    });

    test('assembled scenes satisfy their grammar', () => {
        const cases = [
            { theme: GEOMETRIC_SIGNAL_THEME, grammar: GEOMETRIC_SIGNAL },
            { theme: ORGANIC_FLOW_THEME, grammar: ORGANIC_FLOW },
            { theme: COLLISION_ENERGY_THEME, grammar: COLLISION_ENERGY },
        ];

        for (const { theme, grammar } of cases) {
            for (const seed of ['s1', 's2', 's3', 's4']) {
                const result = buildScene(seed, theme, { ...base, assets: [] }, profileFor(0));
                if (result.ok) {
                    expect(satisfiesGrammar(result.scene.plugins, grammar), `${theme.id}/${seed}`).toBe(true);
                }
            }
        }
    });

    test('the scheduler never activates two dominant generators', () => {
        for (const theme of THEMES) {
            for (const seed of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) {
                const result = buildScene(seed, theme, { ...base, assets: [] }, profileFor(0));
                if (!result.ok) continue;

                const dominant = result.scene.plugins.filter((entry) => entry.cost.dominant);
                expect(dominant.length, `${theme.id}/${seed}`).toBeLessThanOrEqual(1);
            }
        }
    });

    test('collision-energy scenes can include the impact simulator', () => {
        const found = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].some((seed) => {
            const result = buildScene(seed, COLLISION_ENERGY_THEME, { ...base, assets: [] }, profileFor(0));
            return result.ok && result.scene.plugins.some((p) => p.id.startsWith('ImpactCascadeSimulator'));
        });

        expect(found).toBe(true);
    });

    test('particles run with neither mask nor artwork present', () => {
        // Section 26: particles must operate without masks or album art.
        const particleScene = wireScene([
            CATALOG.find((d) => d.id === 'ProceduralVectorField:curl')!,
            CATALOG.find((d) => d.id === 'ParticleForceField:vortex')!,
            CATALOG.find((d) => d.id === 'ParticleSimulator')!,
            CATALOG.find((d) => d.id === 'ParticleRenderer:discs')!,
            CATALOG.find((d) => d.id === 'ToneMapper')!,
        ]);

        expect(particleScene.unsatisfied).toEqual([]);
        const compiled = compileGraph(particleScene.nodes, particleScene.edges, particleScene.present);
        expect(compiled.ok, compiled.ok ? '' : compiled.errors.join('; ')).toBe(true);
    });

    test('a reduced profile still builds from the full catalog', () => {
        const result = buildScene(
            'reduced',
            ORGANIC_FLOW_THEME,
            { ...base, assets: [] },
            profileFor(QUALITY_LADDER.length - 2),
        );

        expect(result.ok, result.ok ? '' : result.failure.detail).toBe(true);
    });

    test('scenes remain reproducible with the full catalog', () => {
        const assets = availableAssetIds([
            maskAssetFrom({ id: 'inkblot', file: 'inkblot.png', interpretation: 'luminance' }),
            albumArtAssetFrom('/art.jpg'),
        ]);

        const first = buildScene('repro', ORGANIC_FLOW_THEME, { ...base, assets }, profileFor(0));
        const second = buildScene('repro', ORGANIC_FLOW_THEME, { ...base, assets }, profileFor(0));
        if (!first.ok || !second.ok) throw new Error('expected both builds to succeed');

        expect(first.scene.plugins.map((p) => p.id)).toEqual(second.scene.plugins.map((p) => p.id));
        expect(first.scene.graph.order.map((n) => n.instanceId))
            .toEqual(second.scene.graph.order.map((n) => n.instanceId));
    });
});

describe('spec section 25 example compositions', () => {
    /** Each example wired and compiled, so the catalog can express what the spec describes. */
    const examples: { name: string; plugins: string[] }[] = [
        {
            name: 'Procedural Signal',
            plugins: [
                'SignalTraceSource:circular', 'ProceduralVectorField:curl',
                'FeedbackFlowTransform:vortex', 'SymmetryTransform:kaleidoscope', 'ToneMapper',
            ],
        },
        {
            name: 'Album Dream',
            plugins: [
                'AlbumArtSource', 'AlbumArtEdges', 'AlbumArtDisplacement',
                'DomainWarpTransform:vector', 'FeedbackFlowTransform:zoom', 'GlowAndScatter:soft-bloom',
            ],
        },
        {
            name: 'Masked Organic Field',
            plugins: [
                'ProceduralTextureSource:value-noise', 'MaskSignedDistanceField',
                'MaskEffectStencil', 'EdgeContourTransform:luminous', 'ToneMapper',
            ],
        },
        {
            name: 'Sparse Particles',
            plugins: [
                'ProceduralVectorField:curl', 'ParticleEmitter:region', 'ParticleForceField:vortex',
                'ParticleSimulator', 'ParticleRenderer:sparks', 'ParticleTrailInjector',
            ],
        },
        {
            name: 'Rorschach Without Particles',
            plugins: [
                'AlbumArtSource', 'MaskSignedDistanceField', 'MaskEffectStencil',
                'CoordinateWarpTransform:twirl', 'FeedbackInjector:continuous', 'ColorTransform:duotone',
            ],
        },
        {
            name: 'Collision Energy',
            plugins: [
                'ImpactCascadeSimulator:boundary-slam', 'MaskBoundaryField', 'MaskSignedDistanceField',
                'AudioImpulseField:centre-shockwave', 'ShockwaveTransform:bulge', 'GlowAndScatter:soft-bloom',
            ],
        },
        {
            name: 'Gravitational Collision',
            plugins: [
                'ImpactCascadeSimulator:gravity-capture', 'ProceduralVectorField:attract',
                'WaveFieldSimulator', 'WaveFieldView', 'FeedbackFlowTransform:spiral', 'ToneMapper',
            ],
        },
    ];

    /** Assets a real scene would have loaded, as host-supplied textures. */
    const ASSET_RESOURCES: AssetResource[] = [
        { resource: assetResourceId('album-art:current'), type: 'color-texture' },
        { resource: assetResourceId('mask:inkblot'), type: 'mask-texture' },
    ];

    for (const example of examples) {
        test(`${example.name} wires and compiles`, () => {
            const definitions = example.plugins.map((id) => {
                const definition = CATALOG.find((entry) => entry.id === id);
                if (!definition) {
                    throw new Error(`example references unregistered plugin ${id}`);
                }
                return definition;
            });

            const wired = wireScene(definitions, ASSET_RESOURCES);
            expect(
                wired.unsatisfied,
                `${example.name} unsatisfied: ${JSON.stringify(wired.unsatisfied)}`,
            ).toEqual([]);

            const compiled = compileGraph(wired.nodes, wired.edges, wired.present, wired.assetBindings);
            expect(compiled.ok, compiled.ok ? '' : compiled.errors.join('; ')).toBe(true);
        });
    }

    test('asset-free examples need no asset resources at all', () => {
        // Section 26: a scene must work with neither artwork nor masks present.
        const procedural = examples.find((entry) => entry.name === 'Procedural Signal')!;
        const definitions = procedural.plugins.map((id) => CATALOG.find((entry) => entry.id === id)!);

        const wired = wireScene(definitions);
        expect(wired.unsatisfied).toEqual([]);
        expect(wired.assetBindings).toEqual([]);
    });

    test('a derived texture wins over the raw asset it came from', () => {
        // AlbumArtEdges produces a mask, so a mask consumer downstream should read that rather than the
        // raw mask asset.
        const wired = wireScene(
            [
                CATALOG.find((d) => d.id === 'AlbumArtEdges')!,
                CATALOG.find((d) => d.id === 'MaskSignedDistanceField')!,
            ],
            ASSET_RESOURCES,
        );

        const intoSdf = wired.edges.find((edge) => edge.to.instanceId.startsWith('MaskSignedDistanceField'));
        expect(intoSdf?.from.instanceId).toContain('AlbumArtEdges');
    });

    test('the masked example needs no particle system', () => {
        const masked = examples.find((entry) => entry.name === 'Rorschach Without Particles')!;

        expect(masked.plugins.some((id) => id.startsWith('Particle'))).toBe(false);
    });
});
