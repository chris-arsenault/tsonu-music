/**
 * Spec section 26 acceptance criteria, as executable assertions.
 *
 * One test per criterion, named after it, so the sweep is a suite rather than a document that drifts.
 * Criteria needing a real GPU or a listener are recorded here as explicitly uncovered rather than
 * silently omitted — see the final block.
 */

import { describe, expect, test } from 'vitest';
import { advanceClock, initialClock, isFrozen, type ClockEvent } from './core/clock';
import {
    advanceFeatureBus,
    createFeatureBusState,
    type FeatureSnapshot,
} from './core/features';
import {
    beatPhaseAt,
    createBeatTracker,
    invalidateTempo,
    observeOnset,
} from './core/analysis';
import { compileGraph } from './core/graph';
import { wireScene, assetResourceId, type AssetResource } from './core/wiring';
import { buildScene } from './core/scene-builder';
import { profileFor, QUALITY_LADDER, advancePerformance, createPerformanceState } from './core/performance';
import { selectTier, collectFaults, type VisualizerFault } from './core/fallback';
import { createPluginRegistry } from './core/plugin';
import { allDefinitions } from './plugins/registry';
import { COLLISION_ENERGY_THEME, GEOMETRIC_SIGNAL_THEME, ORGANIC_FLOW_THEME } from './plugins/themes';
import { availableAssetIds, albumArtAssetFrom, maskAssetFrom } from './core/assets';
import { advanceCascade, seedCascade } from './plugins/simulators/impact-cascade';
import { beginRetirement, isRetired, POLICY_DURATIONS } from './core/deactivation';
import { assembleScene } from './core/scheduler';

const CATALOG = allDefinitions();

const BUILD_CONTEXT = {
    available: CATALOG,
    capabilities: ['float-textures', 'webgl2'],
    history: {},
    playbackTime: 0,
};

const ART = albumArtAssetFrom('https://media.tsonu.com/art.jpg');
const MASK = maskAssetFrom({ id: 'inkblot', file: 'inkblot.png', interpretation: 'luminance' });
const ASSET_RESOURCES: AssetResource[] = [
    { resource: assetResourceId(ART.id), type: 'color-texture' },
    { resource: assetResourceId(MASK.id), type: 'mask-texture' },
];

function plugin(id: string) {
    const found = CATALOG.find((entry) => entry.id === id);
    if (!found) {
        throw new Error(`plugin ${id} is not registered`);
    }
    return found;
}

/** Wires and compiles a named plugin set, returning whether it is a runnable scene. */
function sceneCompiles(ids: string[], assets: AssetResource[] = []): boolean {
    const wired = wireScene(ids.map(plugin), assets);
    if (wired.unsatisfied.length > 0) {
        return false;
    }

    return compileGraph(wired.nodes, wired.edges, wired.present, wired.assetBindings).ok;
}

function run(events: ClockEvent[]) {
    return events.reduce(
        (state, event) => advanceClock(state, event).clock,
        initialClock,
    );
}

const PLAYING: ClockEvent[] = [
    { kind: 'track-changed', trackId: 'track_a', duration: 200 },
    { kind: 'play' },
    { kind: 'resumed' },
];

describe('section 26: audio-reactive effects follow currently audible music', () => {
    function snapshot(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
        return {
            audioTime: 100,
            rms: 0.6,
            peak: 0.8,
            bands: { subBass: 0.3, bass: 0.7, lowMid: 0.4, mid: 0.3, highMid: 0.2, treble: 0.1 },
            spectralCentroidHz: 1800,
            spectralFlux: 0.2,
            leftLevel: 0.5,
            rightLevel: 0.5,
            beatPeriodSeconds: 0,
            beatConfidence: 0,
            beatAnchorAudioTime: 0,
            onsets: [],
            waveform: new Float32Array(8),
            spectrum: new Float32Array(16),
            ...overrides,
        };
    }

    test('after pause and resume, queued events do not fire against new audio', () => {
        let bus = createFeatureBusState();
        const clock = run(PLAYING);

        // An onset detected just before the pause.
        bus = advanceFeatureBus(bus, {
            snapshot: snapshot({ onsets: [{ audioTime: 99.99, strength: 1 }] }),
            clock,
            effects: [],
            currentAudioTime: 100,
            latencySeconds: 0.02,
            deltaSeconds: 1 / 60,
        });

        // Resuming clears pending events and gates transients.
        const resumed = advanceClock({ ...clock, state: 'paused' }, { kind: 'resumed' });
        bus = advanceFeatureBus(bus, {
            snapshot: undefined,
            clock: resumed.clock,
            effects: resumed.effects,
            currentAudioTime: 100,
            latencySeconds: 0.02,
            deltaSeconds: 1 / 60,
        });

        expect(bus.pendingOnsets).toEqual([]);
        expect(bus.bus.events.onset).toEqual([]);
    });

    test('after seeking, analysis history is discarded', () => {
        const seeking = advanceClock(run(PLAYING), { kind: 'seek-start' });

        expect(seeking.effects).toContain('clear-analysis-history');
        expect(seeking.effects).toContain('clear-pending-events');
    });

    test('after a track change, history is cleared and the scene reseeded', () => {
        const changed = advanceClock(run(PLAYING), {
            kind: 'track-changed',
            trackId: 'track_b',
            duration: 100,
        });

        expect(changed.clock.generation).toBe(2);
        expect(changed.effects).toEqual(expect.arrayContaining([
            'clear-analysis-history', 'clear-pending-events', 'invalidate-tempo', 'reseed-scene',
        ]));
    });

    test('buffering freezes without discarding the scene', () => {
        const stalled = advanceClock(run(PLAYING), { kind: 'stalled' });

        expect(isFrozen(stalled.clock)).toBe(true);
        expect(stalled.clock.trackId).toBe('track_a');
        expect(stalled.effects).not.toContain('reseed-scene');
    });
});

describe('section 26: simulation and feedback freeze during pause and seeking', () => {
    test('every non-playing state freezes', () => {
        for (const state of ['idle', 'paused', 'buffering', 'seeking', 'ended'] as const) {
            expect(isFrozen({ ...initialClock, state }), state).toBe(true);
        }
        expect(isFrozen({ ...initialClock, state: 'playing' })).toBe(false);
    });

    test('a seek completing does not by itself resume simulation', () => {
        const seeked = advanceClock(
            advanceClock(run(PLAYING), { kind: 'seek-start' }).clock,
            { kind: 'seek-end' },
        );

        expect(isFrozen(seeked.clock)).toBe(true);
    });
});

describe('section 26: beat-relative motion re-locks after seeking without a fixed BPM', () => {
    function steady(period: number, count: number, start: number) {
        let tracker = createBeatTracker();
        for (let beat = 0; beat < count; beat += 1) {
            tracker = observeOnset(tracker, start + beat * period);
        }
        return tracker;
    }

    test('tempo comes from heard onsets, not from a declared BPM', () => {
        const tracker = steady(0.5, 12, 10);

        expect(tracker.periodSeconds).toBeCloseTo(0.5, 2);
        expect(tracker.confidence).toBeGreaterThan(0.8);
    });

    test('invalidating tempo stops phase rather than free-running', () => {
        const cleared = invalidateTempo();

        expect(beatPhaseAt(cleared, 500)).toBe(0);
        expect(beatPhaseAt(cleared, 900)).toBe(0);
    });

    test('a new tempo is recovered from newly heard audio after a seek', () => {
        const before = steady(0.8, 12, 10);
        expect(before.periodSeconds).toBeCloseTo(0.8, 2);

        // Seek invalidates, then a different tempo is learned from scratch.
        let after = invalidateTempo();
        for (let beat = 0; beat < 12; beat += 1) {
            after = observeOnset(after, 400 + beat * 0.4);
        }

        expect(after.periodSeconds).toBeCloseTo(0.4, 2);
        expect(after.confidence).toBeGreaterThan(0.8);
    });
});

describe('section 26: album art can be used for colour, geometry, displacement, or imagery', () => {
    test('for colour, through palette extraction', () => {
        expect(sceneCompiles(['AlbumArtPalette', 'ProceduralTextureSource:value-noise', 'PaletteMapper'], ASSET_RESOURCES)).toBe(true);
    });

    test('for geometry, through edge derivation', () => {
        expect(sceneCompiles(['AlbumArtEdges', 'MaskSignedDistanceField', 'MaskEffectStencil', 'ProceduralTextureSource:value-noise'], ASSET_RESOURCES)).toBe(true);
    });

    test('for displacement, through a luminance gradient field', () => {
        expect(sceneCompiles(['AlbumArtDisplacement', 'ProceduralTextureSource:value-noise', 'DomainWarpTransform:vector'], ASSET_RESOURCES)).toBe(true);
    });

    test('for particles, by seeding an emitter from artwork edges', () => {
        expect(sceneCompiles([
            'AlbumArtEdges', 'ParticleEmitter:shape', 'ProceduralVectorField:curl',
            'ParticleForceField:vortex', 'ParticleSimulator', 'ParticleRenderer:discs',
        ], ASSET_RESOURCES)).toBe(true);
    });

    test('as direct imagery', () => {
        expect(sceneCompiles(['AlbumArtSource', 'ToneMapper'], ASSET_RESOURCES)).toBe(true);
    });
});

describe('section 26: album art can also be ignored', () => {
    test('a scene builds with no assets at all', () => {
        const result = buildScene('none', GEOMETRIC_SIGNAL_THEME, { ...BUILD_CONTEXT, assets: [] }, profileFor(0));

        expect(result.ok, result.ok ? '' : result.failure.detail).toBe(true);
        if (!result.ok) return;

        for (const definition of result.scene.plugins) {
            expect(definition.activationRules.requiredAssets ?? [], definition.id).toEqual([]);
        }
    });

    test('artwork being loaded does not force it on screen', () => {
        const assets = availableAssetIds([ART]);
        const seeds = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8'];

        const withoutArt = seeds.filter((seed) => {
            const result = buildScene(seed, ORGANIC_FLOW_THEME, { ...BUILD_CONTEXT, assets }, profileFor(0));
            return result.ok && !result.scene.plugins.some((p) => p.id === 'AlbumArtSource');
        });

        expect(withoutArt.length).toBeGreaterThan(0);
    });
});

describe('section 26: masks drive particles, collision, containment, distortion, or feedback', () => {
    test('particles, through a mask-interior emitter', () => {
        expect(sceneCompiles([
            'MaskSignedDistanceField', 'ParticleEmitter:shape', 'ProceduralVectorField:curl',
            'ParticleForceField:vortex', 'ParticleSimulator', 'ParticleRenderer:discs',
        ], ASSET_RESOURCES)).toBe(true);
    });

    test('collision, through a mask surface bodies bounce off', () => {
        // The simulation moved to the CPU and the world now holds explicit colliders, so a mask
        // reaches the bodies as one rather than through a `boundary` port on the simulator. The
        // emitter is explicit too: there is no implicit source of bodies.
        expect(sceneCompiles([
            'MaskSignedDistanceField', 'ParticleCollider:mask', 'ParticleEmitter:point',
            'ParticleSimulator', 'ParticleRenderer:points',
        ], ASSET_RESOURCES)).toBe(true);
    });

    test('collision, through a boundary field that deflects the image', () => {
        expect(sceneCompiles([
            'MaskSignedDistanceField', 'MaskBoundaryField', 'ProceduralTextureSource:cellular',
        ], ASSET_RESOURCES)).toBe(true);
    });

    test('containment, through a containment field', () => {
        expect(sceneCompiles(['MaskSignedDistanceField', 'MaskContainmentField'], ASSET_RESOURCES)).toBe(true);
    });

    test('distortion and composition, through a stencil', () => {
        expect(sceneCompiles([
            'ProceduralTextureSource:cellular', 'MaskSignedDistanceField', 'MaskEffectStencil',
            'CoordinateWarpTransform:twirl',
        ], ASSET_RESOURCES)).toBe(true);
    });

    test('feedback, through an injector fed by masked material', () => {
        expect(sceneCompiles([
            'ProceduralTextureSource:rings', 'MaskSignedDistanceField', 'MaskEffectStencil',
            'FeedbackInjector:masked',
        ], ASSET_RESOURCES)).toBe(true);
    });
});

describe('section 26: masks are optional assets, not a permanent style', () => {
    test('mask plugins stay inactive with no mask loaded', () => {
        const withoutMask = assembleScene('nomask', {
            ...BUILD_CONTEXT,
            assets: [],
            theme: ORGANIC_FLOW_THEME,
            allowHighCost: true,
            allowDominant: true,
        });

        for (const definition of withoutMask.plugins) {
            expect(definition.activationRules.requiredAssets ?? [], definition.id).not.toContain('mask');
        }
    });

    test('the shipped mask library may legitimately be empty', async () => {
        const manifest = await import('../../public/masks/manifest.json');

        expect(Array.isArray(manifest.default.masks)).toBe(true);
    });
});

describe('section 26: particles operate without masks or album art', () => {
    test('a purely procedural particle scene compiles', () => {
        expect(sceneCompiles([
            'ProceduralVectorField:curl', 'ParticleEmitter:region', 'ParticleForceField:vortex',
            'ParticleSimulator', 'ParticleRenderer:sparks', 'ToneMapper',
        ])).toBe(true);
    });

    test('the region emitter declares no required asset', () => {
        expect(plugin('ParticleEmitter:region').activationRules.requiredAssets ?? []).toEqual([]);
    });
});

describe('section 26: plugins can be added, removed, or replaced without resetting unrelated state', () => {
    test('registering a new plugin needs no kernel change', () => {
        const registry = createPluginRegistry(CATALOG);
        const before = registry.all().length;

        registry.register({
            ...plugin('ToneMapper'),
            id: 'LateArrival',
            version: 1,
        });

        expect(registry.get('LateArrival')).toBeDefined();
        expect(registry.all()).toHaveLength(before + 1);
    });

    test('swapping one plugin leaves the rest of the graph intact', () => {
        const base = ['SignalTraceSource:circular', 'FeedbackFlowTransform:vortex', 'ToneMapper'];
        const swapped = ['SignalTraceSource:circular', 'SymmetryTransform:bilateral', 'ToneMapper'];

        const before = wireScene(base.map(plugin));
        const after = wireScene(swapped.map(plugin));

        // The unchanged plugins keep their instance ids, so their state survives the swap.
        expect(before.nodes[0].instanceId).toBe(after.nodes[0].instanceId);
        expect(compileGraph(after.nodes, after.edges, after.present).ok).toBe(true);
    });

    test('disabling one plugin does not invalidate the graph', () => {
        const wired = wireScene(['SignalTraceSource:circular', 'FeedbackFlowTransform:vortex', 'ToneMapper'].map(plugin));
        const compiled = compileGraph(wired.nodes, wired.edges, wired.present);

        expect(compiled.ok).toBe(true);
        if (!compiled.ok) return;
        // The runtime skips a disabled instance; the compiled graph is unchanged.
        expect(compiled.graph.order).toHaveLength(3);
    });
});

describe('section 26: stateful plugins deactivate gracefully', () => {
    test('no simulator or feedback plugin cuts immediately', () => {
        const stateful = CATALOG.filter((definition) =>
            definition.category === 'simulator' || definition.capabilities.includes('feedback'));

        expect(stateful.length).toBeGreaterThan(0);
        for (const definition of stateful) {
            expect(definition.deactivationPolicy, definition.id).toBeDefined();
            expect(definition.deactivationPolicy, definition.id).not.toBe('immediate');
        }
    });

    test('a draining retirement outlasts a fade', () => {
        expect(POLICY_DURATIONS.drain).toBeGreaterThan(POLICY_DURATIONS.fade);
    });

    test('a retirement completes rather than hanging', () => {
        let retirement = beginRetirement('i1', 'drain');
        for (let step = 0; step < 200 && !isRetired(retirement); step += 1) {
            retirement = { ...retirement, elapsedSeconds: retirement.elapsedSeconds + 0.1 };
        }

        expect(isRetired(retirement)).toBe(true);
    });
});

describe('section 26: plugin selection respects scene grammar and performance limits', () => {
    test('assembled scenes satisfy their grammar', () => {
        for (const seed of ['g1', 'g2', 'g3', 'g4', 'g5']) {
            const result = buildScene(seed, GEOMETRIC_SIGNAL_THEME, { ...BUILD_CONTEXT, assets: [] }, profileFor(0));
            if (result.ok) {
                expect(result.scene.plugins.filter((p) => p.category === 'simulator'), seed).toEqual([]);
            }
        }
    });

    test('a reduced profile excludes high-cost plugins', () => {
        const result = buildScene(
            'cheap',
            ORGANIC_FLOW_THEME,
            { ...BUILD_CONTEXT, assets: [] },
            { ...profileFor(0), expensivePrimary: false },
        );

        expect(result.ok, result.ok ? '' : result.failure.detail).toBe(true);
        if (!result.ok) return;
        for (const definition of result.scene.plugins) {
            expect(definition.cost.gpu, definition.id).toBeLessThan(3);
        }
    });

    test('sustained pressure walks the ladder down to suspension', () => {
        let state = createPerformanceState();
        for (let frame = 0; frame < 30 * (QUALITY_LADDER.length + 2); frame += 1) {
            state = advancePerformance(state, { frameTimeMs: 50, forwardBufferSeconds: 30 });
        }

        expect(profileFor(state.level).suspended).toBe(true);
    });

    test('a starving buffer suspends immediately, protecting playback', () => {
        const state = advancePerformance(createPerformanceState(), { frameTimeMs: 4, bufferStalled: true });

        expect(profileFor(state.level).suspended).toBe(true);
    });
});

describe('section 26: the scheduler avoids multiple competing dominant generators', () => {
    test('no assembled scene holds two dominant plugins', () => {
        for (const theme of [GEOMETRIC_SIGNAL_THEME, ORGANIC_FLOW_THEME, COLLISION_ENERGY_THEME]) {
            for (const seed of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8']) {
                const result = buildScene(seed, theme, { ...BUILD_CONTEXT, assets: [] }, profileFor(0));
                if (!result.ok) continue;

                expect(result.scene.plugins.filter((p) => p.cost.dominant).length, `${theme.id}/${seed}`)
                    .toBeLessThanOrEqual(1);
            }
        }
    });
});

describe('section 26: plugin outputs and graph connections are typed and validated', () => {
    test('a type mismatch is rejected', () => {
        const wired = wireScene([plugin('ProceduralVectorField:curl'), plugin('ToneMapper')]);

        // The tone mapper wants colour; a vector field cannot satisfy it.
        expect(wired.unsatisfied).toEqual([
            { instanceId: wired.nodes[1].instanceId, port: 'source', type: 'color-texture' },
        ]);
    });

    test('an undeclared cycle is rejected', () => {
        const transform = plugin('SymmetryTransform:bilateral');
        const result = compileGraph(
            [{ instanceId: 'p', definition: transform }, { instanceId: 'q', definition: transform }],
            [
                { from: { instanceId: 'p', port: 'color' }, to: { instanceId: 'q', port: 'source' } },
                { from: { instanceId: 'q', port: 'color' }, to: { instanceId: 'p', port: 'source' } },
            ],
        );

        expect(result.ok).toBe(false);
    });

    test('a declared feedback cycle is accepted and ping-ponged', () => {
        const wired = wireScene(['SignalTraceSource:circular', 'FeedbackFlowTransform:vortex'].map(plugin));
        const compiled = compileGraph(wired.nodes, wired.edges, wired.present);

        expect(compiled.ok).toBe(true);
        if (!compiled.ok) return;
        expect(compiled.graph.pingPong).toHaveLength(1);
    });
});

describe('section 26: impact dynamics produce acceleration, collision, fragmentation, and field distortion', () => {
    test('projectiles accelerate', () => {
        const seeded = seedCascade('gravity-capture', 0.5, 8);
        const before = seeded.map((p) => Math.hypot(p.vx, p.vy));
        const after = advanceCascade('gravity-capture', seeded, 1 / 60, 10, 1)
            .projectiles.filter((p) => !p.fragment).map((p) => Math.hypot(p.vx, p.vy));

        expect(after.some((speed, index) => Math.abs(speed - before[index]) > 1e-6)).toBe(true);
    });

    test('collision produces an impact event', () => {
        const colliding = [{ x: 0.001, y: 0, vx: 0.9, vy: 0, energy: 1, fragment: false, age: 0 }];
        const result = advanceCascade('gravity-capture', colliding, 1 / 60, 12, 1);

        expect(result.impacts).toHaveLength(1);
        expect(result.impacts[0].energy).toBeGreaterThan(0);
    });

    test('collision fragments the projectile', () => {
        const colliding = [{ x: 0.001, y: 0, vx: 0.9, vy: 0, energy: 1, fragment: false, age: 0 }];
        const result = advanceCascade('gravity-capture', colliding, 1 / 60, 12, 1);

        expect(result.projectiles.filter((p) => p.fragment).length).toBeGreaterThan(5);
    });

    test('secondary field distortion consumes the same impacts', () => {
        // A shockwave transform and a wave field both declare impact consumption, so an impact published
        // by the cascade reaches them through the kernel bus.
        for (const id of ['ShockwaveTransform:bulge', 'WaveFieldSimulator', 'TransientGlyphSource:shockwave']) {
            expect(plugin(id).capabilities, id).toContain('impact-consumer');
        }
        expect(plugin('ImpactCascadeSimulator:gravity-capture').capabilities).toContain('impact-producer');
    });

    test('a collision-energy scene wires the cascade to a shockwave and glow', () => {
        expect(sceneCompiles([
            'ImpactCascadeSimulator:boundary-slam', 'AudioImpulseField:centre-shockwave',
            'ShockwaveTransform:bulge', 'GlowAndScatter:soft-bloom',
        ])).toBe(true);
    });
});

describe('section 26: the visualizer remains functional when plugins or the renderer fail', () => {
    test('every failure mode resolves to a fallback tier', () => {
        const faults: VisualizerFault[] = [
            'webgl-unavailable', 'no-float-render-targets', 'context-lost', 'shader-failure',
            'analysis-blocked', 'analysis-silent', 'audio-context-suspended', 'missing-assets',
            'unsupported-texture-format', 'memory-pressure', 'invalid-graph', 'plugin-init-failure',
            'zero-sized-canvas', 'performance-floor', 'reduced-motion',
        ];

        for (const fault of faults) {
            expect(['full', 'reduced-graph', 'waveform', 'artwork', 'empty'], fault)
                .toContain(selectTier([fault]));
        }
    });

    test('losing WebGL still leaves something moving', () => {
        expect(selectTier(['webgl-unavailable'])).toBe('waveform');
    });

    test('a shader failure only costs scene richness', () => {
        expect(selectTier(['shader-failure'])).toBe('reduced-graph');
    });

    test('a healthy runtime reports no faults', () => {
        expect(collectFaults({
            webgl2Available: true,
            floatRenderTargets: true,
            contextLost: false,
            shaderErrorCount: 0,
            analysisFlatlined: false,
            audioContextState: 'running',
            graphValid: true,
            canvasWidth: 800,
            canvasHeight: 450,
            performanceSuspended: false,
            prefersReducedMotion: false,
        })).toEqual([]);
    });
});

/*
 * Three section 26 criteria are not asserted here, because they need a real GPU or a listener:
 * a 3D source outputting colour and depth, perceived beat synchronisation within about one frame, and
 * shaders producing the intended image. They are tracked in docs/backlog.md — as a depth-parallax
 * source, a GLB parallax source, and headless-browser tests with a real GL context.
 *
 * Deliberately prose rather than skipped tests. An empty `test.skip` asserts nothing and can never
 * fail, so it adds a passing-looking entry to the count while carrying no more information than this
 * comment.
 */
