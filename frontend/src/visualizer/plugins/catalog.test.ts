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
import {
    isValuePortType,
    validateDefinition,
    type PluginCategory,
    type VisualPluginDefinition,
} from '../core/plugin';
import { silentFeatureBus } from '../core/features';
import { compileGraph } from '../core/graph';
import { assetResourceId, wireScene, type AssetResource } from '../core/wiring';
import { buildScene, consumesMotion } from '../core/scene-builder';
import { profileFor, QUALITY_LADDER } from '../core/performance';
import { COLLISION_ENERGY, GEOMETRIC_SIGNAL, ORGANIC_FLOW, satisfiesGrammar } from '../core/grammar';
import { COLLISION_ENERGY_THEME, GEOMETRIC_SIGNAL_THEME, IMAGE_DREAM_THEME, ORGANIC_FLOW_THEME, THEMES } from './themes';
import { createImpactBus, type ImpactEvent } from '../core/impact';
import { advanceCascade, CASCADE_MODES, seedCascade } from './simulators/impact-cascade';
import { availableAssetIds, albumArtAssetFrom } from '../core/assets';
import { isMotionSource } from '../core/fields';
import { TEMPORAL_MODES } from './transformers/transforms';
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
                ...silentFeatureBus({
                    rms: 0.5, peak: 0.7, subBass: 0.3, bass: 0.6, lowMid: 0.4, mid: 0.4,
                    highMid: 0.3, treble: 0.35, spectralCentroid: 0.4, spectralFlux: 0.3,
                    beatConfidence: 0.7, beatPhase: 0.3, leftLevel: 0.5, rightLevel: 0.5,
                }),
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
            inputs: {},
            // No field readback in a headless catalog check: a plugin must cope with the field not
            // having arrived yet, since that is the state on the first frames of every scene.
            readField: () => undefined,
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
        // Empty, because the compiler records a previous-frame resource only for a port an edge was
        // actually drawn into as historical. Offering one for every input made this fixture a graph
        // where every edge is a back edge, which no scene is — and once ADR-0013 made a present
        // `previous` entry the whole condition for reading it, that fixture started binding every
        // sampler to a previous frame. The historical path has its own test below.
        previous: {},
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

    test('every GPU plugin registers shaders and emits passes when fully wired', () => {
        for (const definition of CATALOG) {
            const { context, shaders } = createContext();
            const instance = definition.create(context);
            instance.initialize();

            if (definition.cost.renderPasses > 0) {
                expect(shaders.length, `${definition.id} registers a shader`).toBeGreaterThan(0);
                if (!definition.inputs.some((port) => isValuePortType(port.type))) {
                    expect(renderWithAllInputs(definition).length, `${definition.id} emits a pass`).toBeGreaterThan(0);
                }
            } else {
                expect(shaders, `${definition.id} is a CPU value node`).toEqual([]);
            }
        }
    });

    test('every plugin with a missing required input draws no content', () => {
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

            if (definition.inputs.some((port) => isValuePortType(port.type))) {
                expect(
                    passes.every((pass) =>
                        pass.kind === 'geometry' && pass.vertexCount === 0 && pass.clear === true),
                    `${definition.id} only clears stale value-renderer outputs`,
                ).toBe(true);
            } else {
                expect(passes, `${definition.id} degrades to no passes`).toEqual([]);
            }
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

    test('continuous simulation views require their own state type', () => {
        const definition = (id: string) => CATALOG.find((entry) => entry.id === id)!;

        expect(definition('ReactionDiffusionSimulator').outputs[0].type).toBe('reaction-diffusion-state');
        expect(definition('ReactionDiffusionView').inputs[0].type).toBe('reaction-diffusion-state');
        expect(definition('WaveFieldSimulator').outputs[0].type).toBe('wave-field-state');
        expect(definition('WaveFieldView').inputs[0].type).toBe('wave-field-state');
    });

    test('the flow compositor couples visible material to a spatial field', () => {
        const flow = CATALOG.find((entry) => entry.id === 'FlowFieldCompositor')!;
        const passes = renderWithAllInputs(flow);

        expect(flow.category).toBe('compositor');
        expect(flow.capabilities).toEqual(expect.arrayContaining([
            'field-composition',
            'chromatic-output',
            'layer-mixing',
        ]));
        expect(flow.inputs.map((port) => [port.name, port.type])).toEqual([
            ['source', 'color-texture'],
            ['field', 'vector-field'],
        ]);
        expect(passes[0].inputs).toEqual({
            uSource: 'in.source',
            uField: 'in.field',
        });
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

    test('a palette-mapped scene is reachable with no album artwork', () => {
        // `PaletteMapper` is the catalog's only palette-mapping stage, and its `palette` input could
        // be satisfied by exactly one plugin, which requires the album-art asset. On any track
        // without artwork it was unreachable — selected zero times across three hundred builds — and
        // every procedural source writes greyscale, so all colour came from the kernel's per-branch
        // ramp. That is the monochrome report.
        const seeds = Array.from({ length: 24 }, (_, index) => `palette-${index}`);
        const mapped = seeds.filter((seed) =>
            THEMES.some((theme) => {
                const result = buildScene(seed, theme, { ...base, assets: [] }, profileFor(0));
                return result.ok
                    && result.scene.plugins.some((entry) => entry.id === 'PaletteMapper');
            }));

        expect(mapped.length).toBeGreaterThan(0);
    });

    test('a palette producer and its only consumer are drawn together or not at all', () => {
        // The mapper cannot be selected without a producer, since the input is required. The reverse
        // is what the pairing buys: a producer with no mapper is an orphan the prune pass removes,
        // which costs a build attempt.
        for (const theme of THEMES) {
            for (const seed of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
                const result = buildScene(seed, theme, { ...base, assets: [] }, profileFor(0));
                if (!result.ok) continue;

                const ids = result.scene.plugins.map((entry) => entry.id);
                expect(ids.includes('ProceduralPalette'), `${theme.id}/${seed}`)
                    .toBe(ids.includes('PaletteMapper'));
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
        // Sixteen seeds, because eight is inside the noise: measured over a hundred, the simulator
        // lands in 19 of them, so a run of eight misses about one time in five. It did after the loop
        // wiring changed under ADR-0013, which is a different scene shape rather than a lost plugin.
        const found = Array.from({ length: 16 }, (_, index) => `c${index}`).some((seed) => {
            const result = buildScene(seed, COLLISION_ENERGY_THEME, { ...base, assets: [] }, profileFor(0));
            return result.ok && result.scene.plugins.some((p) => p.id.startsWith('ImpactCascadeSimulator'));
        });

        expect(found).toBe(true);
    });

    test('particles run with neither mask nor artwork present', () => {
        // Section 26: particles must operate without masks or album art.
        const particleScene = wireScene([
            CATALOG.find((d) => d.id === 'ParticleEmitter:point')!,
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

/**
 * Assembled scenes had no memory of the previous frame.
 *
 * The grammar capped feedback loops without requiring any, so with roughly a hundred and fifty
 * plugins to draw from, random selection produced a persistence stage only occasionally — and every
 * other scene regenerated itself from nothing each frame. Asserted across many seeds because the
 * defect was probabilistic and a single passing seed proves nothing.
 */
describe('scenes accumulate and move', () => {
    const base = {
        available: CATALOG,
        capabilities: ['float-textures', 'webgl2'],
        history: {},
        playbackTime: 0,
    };

    const SEEDS = Array.from({ length: 24 }, (_, index) => `motion-${index}`);

    const scenesFor = (theme: typeof THEMES[number]) => SEEDS
        .map((seed) => buildScene(seed, theme, { ...base, assets: [] }, profileFor(0)))
        .flatMap((result) => (result.ok ? [result.scene] : []));

    test('a family that names a feedback stage always gets one', () => {
        for (const theme of [ORGANIC_FLOW_THEME, COLLISION_ENERGY_THEME]) {
            const scenes = scenesFor(theme);
            expect(scenes.length, `${theme.id} builds`).toBeGreaterThan(10);

            for (const scene of scenes) {
                const feedback = scene.plugins.filter((definition) =>
                    definition.capabilities.includes('feedback'));

                expect(feedback.length, `${theme.id}/${scene.entropy}`).toBeGreaterThan(0);
            }
        }
    });

    test('every spatial field a scene contains reaches the motion bus', () => {
        // A field used to be worth generating only if a particle system consumed it, which is why
        // assembly kept producing orphans. Every spatial field now drags the accumulated image, so
        // none of them can be present in a scene without the motion sum finding it.
        for (const theme of THEMES) {
            for (const scene of scenesFor(theme)) {
                const spatial = scene.plugins.flatMap((definition) =>
                    definition.outputs.filter((port) => isMotionSource(port.type)));
                if (spatial.length === 0) {
                    continue;
                }

                const exposed = scene.graph.resources.filter((resource) => isMotionSource(resource.type));
                expect(exposed.length, `${theme.id}/${scene.entropy}`).toBe(spatial.length);
            }
        }
    });

    test('a family asking to be dragged always produces a field to be dragged by', () => {
        // Category counts could not express this: `fieldCount` is satisfied by any plugin in the field
        // category, and `ParticleEmitter` sits there producing a spawn buffer. About one scene in five
        // filled its field slot that way and accumulated without ever being dragged.
        for (const theme of [ORGANIC_FLOW_THEME, COLLISION_ENERGY_THEME, IMAGE_DREAM_THEME]) {
            const scenes = scenesFor(theme);
            expect(scenes.length, `${theme.id} builds`).toBeGreaterThan(10);

            for (const scene of scenes) {
                const motion = scene.graph.resources.filter((resource) => isMotionSource(resource.type));
                expect(motion.length, `${theme.id}/${scene.entropy}`).toBeGreaterThan(0);
            }
        }
    });

    test('a family built for clean geometry is not forced to be dragged', () => {
        // Section 15 describes geometric signal as a waveform or spectrum source, parametric or SDF
        // geometry, symmetry, and restrained feedback. It names no field, so its scenes accumulate and
        // decay without being dragged. Requiring motion everywhere would erase the distinction.
        //
        // Asked about consumption rather than production. Almost every transform now publishes the
        // displacement it applies (ADR-0012), so a scene containing one has a motion resource
        // whether or not anything reads it — and being dragged is a fact about an edge.
        const undragged = scenesFor(GEOMETRIC_SIGNAL_THEME).filter((scene) => !consumesMotion(scene.wired));

        expect(undragged.length).toBeGreaterThan(0);
    });

    test('every layer stack has something that means to persist', () => {
        for (const theme of THEMES) {
            for (const scene of scenesFor(theme)) {
                const persistence = scene.plugins.reduce(
                    (highest, definition) => Math.max(highest, definition.character.persistence),
                    0,
                );

                expect(persistence, `${theme.id}/${scene.entropy}`).toBeGreaterThan(0);
            }
        }
    });
});

/**
 * `TemporalTransform` (spec section 19.8, section 24 secondary scope).
 *
 * The first plugin to keep frames, and therefore the first consumer of `historyDepth` — a value the
 * quality ladder has always computed and threaded through `FrameContext` that nothing read.
 */
describe('temporal transform', () => {
    const temporal = (mode: typeof TEMPORAL_MODES[number]) =>
        CATALOG.find((definition) => definition.id === `TemporalTransform:${mode}`)!;

    /** Renders one pass at a given ladder profile and reports the depth uniform it emitted. */
    function depthAt(historyDepth: number): number {
        const definition = temporal('echo');
        const instance = definition.create(createContext().context);
        instance.initialize();
        instance.activate({
            clock: { trackId: 't', playbackTime: 0, duration: 1, state: 'playing', generation: 1 },
            parameters: definition.parameters ?? {},
        });
        instance.update(frame({ historyDepth }).frame);

        const passes = instance.render({
            inputs: { source: 'in.source' },
            outputs: { color: 'out.color' },
            previous: { history: 'prev.history' },
            renderWidth: 640,
            renderHeight: 360,
        });

        return passes[0].uniforms!.uDepth as number;
    }

    test('every mode section 19.8 lists is registered', () => {
        expect(TEMPORAL_MODES).toHaveLength(9);
        for (const mode of TEMPORAL_MODES) {
            expect(temporal(mode), mode).toBeDefined();
        }
    });

    test('the quality ladder reduces how much history is kept', () => {
        // The rung that drops history depth now changes what a plugin does, rather than reducing a
        // number nothing consumed.
        const full = QUALITY_LADDER[0].historyDepth;
        const floor = QUALITY_LADDER[QUALITY_LADDER.length - 1].historyDepth;

        expect(depthAt(full)).toBe(1);
        expect(depthAt(floor)).toBeLessThan(depthAt(full));
        expect(depthAt(floor)).toBeGreaterThan(0);
    });

    test('a port an edge was drawn into historically reads the previous frame', () => {
        const definition = temporal('delayed-mirror');
        const instance = definition.create(createContext().context);
        instance.initialize();
        instance.update(frame().frame);

        // A present `previous` entry is the whole condition (ADR-0013): the compiler records one only
        // for an edge wiring actually drew as historical, so the plugin no longer has to have
        // declared which of its ports is allowed to be that edge's sink.
        const passes = instance.render({
            inputs: { source: 'in.source', history: 'in.history' },
            outputs: { color: 'out.color' },
            previous: { history: 'prev.history' },
            renderWidth: 640,
            renderHeight: 360,
        });

        expect(passes[0].inputs?.uHistory).toBe('prev.history');
        expect(passes[0].inputs?.uSource).toBe('in.source');
        expect(passes[0].clear).toBe(false);
    });

    test('it leaves gracefully, since it holds frames', () => {
        expect(temporal('slit-scan').deactivationPolicy).toBe('freeze-and-dissolve');
    });
});
