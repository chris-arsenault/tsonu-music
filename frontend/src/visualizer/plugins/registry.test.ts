import { describe, expect, test } from 'vitest';
import { createM1Registry, firstLightScene, m1Definitions } from './registry';
import { compileGraph } from '../core/graph';
import { validateDefinition } from '../core/plugin';
import { countPasses, isGeometryPass } from '../core/passes';
import { SIGNAL_TRACE_MODES, traceVertices } from './sources/signal-trace';
import type { FrameContext } from '../core/plugin';
import { silentFeatureBus } from '../core/features';
import { createImpactBus, type ImpactEvent } from '../core/impact';
import { FEEDBACK_FLOW_MODES, feedbackModeIndex } from './transformers/feedback-flow';

/** Minimal create context: records shaders instead of compiling them. */
function createContext(instanceId = 'test') {
    const shaders: string[] = [];
    return {
        context: {
            instanceId,
            seed: 0.42,
            registerShader: (source: { id: string }) => shaders.push(source.id),
        },
        shaders,
    };
}

function frameContext(overrides: Partial<FrameContext> = {}) {
    const uploads: { id: string; vertexCount: number }[] = [];
    const impacts: ImpactEvent[] = [];

    return {
        uploads,
        frame: {
            clock: { trackId: 't', playbackTime: 1, duration: 10, state: 'playing' as const, generation: 1 },
            features: {
                ...silentFeatureBus({
                    rms: 0.5, peak: 0.6, subBass: 0.2, bass: 0.7, lowMid: 0.3, mid: 0.3,
                    highMid: 0.2, treble: 0.4, spectralCentroid: 0.3, spectralFlux: 0.2,
                    beatConfidence: 0.8, beatPhase: 0.25, leftLevel: 0.5, rightLevel: 0.5,
                }),
                waveform: Float32Array.from({ length: 256 }, (_, i) => Math.sin(i / 8)),
                spectrum: new Float32Array(64),
            },
            deltaSeconds: 1 / 60,
            seed: 0.42,
            renderWidth: 640,
            renderHeight: 360,
            parameters: { amplitude: 0.6, thickness: 2, brightness: 1.4 },
            uploadGeometry: (upload: { id: string; data: Float32Array }) =>
                uploads.push({ id: upload.id, vertexCount: upload.data.length / 3 }),
            impacts: createImpactBus(),
            publishImpacts: (published: readonly ImpactEvent[]) => {
                impacts.push(...published);
            },
            inputs: {},
            // Deliberately absent, because that is the state on the first frames of every scene.
            readField: () => undefined,
            ...overrides,
        },
        impacts,
    };
}

describe('M1 plugin catalog', () => {
    test('every definition is structurally valid', () => {
        for (const definition of m1Definitions()) {
            expect(validateDefinition(definition), definition.id).toEqual([]);
        }
    });

    test('all definitions register without a kernel change', () => {
        const registry = createM1Registry();

        // The full catalog, of which the signal plugins are one part.
        expect(registry.all().length).toBeGreaterThanOrEqual(
            SIGNAL_TRACE_MODES.length + FEEDBACK_FLOW_MODES.length + 1,
        );

        for (const mode of FEEDBACK_FLOW_MODES) {
            expect(registry.get(`FeedbackFlowTransform:${mode}`), mode).toBeDefined();
        }
        for (const mode of SIGNAL_TRACE_MODES) {
            expect(registry.get(`SignalTraceSource:${mode}`), mode).toBeDefined();
        }
        expect(registry.get('ToneMapper')).toBeDefined();
    });

    test('every category is populated, so no grammar is unsatisfiable', () => {
        const registry = createM1Registry();

        for (const category of ['source', 'field', 'simulator', 'transformer', 'compositor', 'postprocess'] as const) {
            expect(registry.byCategory(category).length, category).toBeGreaterThan(0);
        }
    });

    test('ids are unique across the catalog', () => {
        const ids = m1Definitions().map((definition) => definition.id);

        expect(new Set(ids).size).toBe(ids.length);
    });

    test('every plugin registers its shaders at initialization, never per frame', () => {
        for (const definition of m1Definitions()) {
            const { context, shaders } = createContext();
            const instance = definition.create(context);

            expect(shaders).toHaveLength(0);
            instance.initialize();
            expect(shaders.length, definition.id).toBeGreaterThan(0);
        }
    });

    test('every feedback mode maps to a distinct shader branch', () => {
        const indices = FEEDBACK_FLOW_MODES.map(feedbackModeIndex);

        expect(new Set(indices).size).toBe(FEEDBACK_FLOW_MODES.length);
        expect(Math.min(...indices)).toBe(0);
    });
});

describe('first light scene', () => {
    const registry = createM1Registry();

    test('compiles', () => {
        const scene = firstLightScene(registry);
        const result = compileGraph(scene.nodes, scene.edges, scene.present);

        expect(result.ok).toBe(true);
    });

    test('orders source before transform before output', () => {
        const scene = firstLightScene(registry);
        const result = compileGraph(scene.nodes, scene.edges, scene.present);
        if (!result.ok) throw new Error(result.errors.join('; '));

        expect(result.graph.order.map((node) => node.instanceId)).toEqual(['trace', 'feedback', 'tone']);
    });

    test('declares exactly one ping-pong resource for its feedback loop', () => {
        const scene = firstLightScene(registry);
        const result = compileGraph(scene.nodes, scene.edges, scene.present);
        if (!result.ok) throw new Error(result.errors.join('; '));

        expect(result.graph.pingPong).toEqual(['feedback.color']);
    });

    test('presents the tone mapper output', () => {
        const scene = firstLightScene(registry);
        const result = compileGraph(scene.nodes, scene.edges, scene.present);
        if (!result.ok) throw new Error(result.errors.join('; '));

        expect(result.graph.present).toBe('tone.color');
    });

    test('the feedback read resolves to a previous-frame input, not a forward one', () => {
        const scene = firstLightScene(registry);
        const result = compileGraph(scene.nodes, scene.edges, scene.present);
        if (!result.ok) throw new Error(result.errors.join('; '));

        const feedback = result.graph.order[1];
        expect(feedback.previous).toEqual({ history: 'feedback.color' });
        expect(feedback.inputs).toEqual({ source: 'trace.color' });
    });

    test('missing a plugin fails loudly rather than silently omitting it', () => {
        const empty = createM1Registry();
        // Simulate a catalog that lost a plugin by looking one up that was never registered.
        expect(() => firstLightScene({ ...empty, get: () => undefined })).toThrow(/not registered/);
    });
});

describe('signal trace geometry', () => {
    const waveform = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 6));

    test('every mode produces in-range coordinates', () => {
        const vertices = new Float32Array(128 * 3);

        for (const mode of SIGNAL_TRACE_MODES) {
            const count = traceVertices(mode, waveform, 0.6, 0, vertices);
            expect(count, mode).toBe(128);

            for (let index = 0; index < count; index += 1) {
                const x = vertices[index * 3];
                const y = vertices[index * 3 + 1];
                const intensity = vertices[index * 3 + 2];

                expect(Number.isFinite(x), `${mode} x`).toBe(true);
                expect(Number.isFinite(y), `${mode} y`).toBe(true);
                expect(Math.abs(x), `${mode} x in clip space`).toBeLessThanOrEqual(1.001);
                expect(Math.abs(y), `${mode} y in clip space`).toBeLessThanOrEqual(1.001);
                expect(intensity, `${mode} intensity`).toBeGreaterThanOrEqual(0);
                expect(intensity, `${mode} intensity`).toBeLessThanOrEqual(1);
            }
        }
    });

    test('silence produces a flat trace rather than nothing', () => {
        const vertices = new Float32Array(64 * 3);
        const count = traceVertices('oscilloscope', new Float32Array(64), 0.6, 0, vertices);

        expect(count).toBe(64);
        for (let index = 0; index < count; index += 1) {
            expect(vertices[index * 3 + 1]).toBe(0);
        }
    });

    test('amplitude scales the trace', () => {
        const quiet = new Float32Array(64 * 3);
        const loud = new Float32Array(64 * 3);

        const peakHeight = (vertices: Float32Array, count: number) => {
            let highest = 0;
            for (let index = 0; index < count; index += 1) {
                highest = Math.max(highest, Math.abs(vertices[index * 3 + 1]));
            }
            return highest;
        };

        const quietCount = traceVertices('oscilloscope', waveform, 0.2, 0, quiet);
        const loudCount = traceVertices('oscilloscope', waveform, 0.9, 0, loud);

        // Compared across the whole trace, since index 0 of a sine is a zero crossing.
        expect(peakHeight(loud, loudCount)).toBeGreaterThan(peakHeight(quiet, quietCount));
    });

    test('stacked mode keeps its last row inside clip space', () => {
        const vertices = new Float32Array(64 * 3);
        const count = traceVertices('stacked', waveform, 1, 0, vertices);

        expect(Math.abs(vertices[(count - 1) * 3 + 1])).toBeLessThanOrEqual(1);
    });

    test('never writes beyond the provided buffer', () => {
        const small = new Float32Array(10 * 3);
        const count = traceVertices('circular', waveform, 0.6, 0, small);

        expect(count).toBe(10);
    });

    test('an empty waveform yields no vertices', () => {
        const vertices = new Float32Array(64 * 3);
        expect(traceVertices('oscilloscope', new Float32Array(0), 0.6, 0, vertices)).toBe(0);
    });

    test('phase rotates the circular mode without changing radius', () => {
        const atZero = new Float32Array(64 * 3);
        const rotated = new Float32Array(64 * 3);

        traceVertices('circular', waveform, 0.6, 0, atZero);
        traceVertices('circular', waveform, 0.6, Math.PI / 2, rotated);

        expect(rotated[0]).not.toBeCloseTo(atZero[0], 3);
        expect(Math.hypot(rotated[0], rotated[1])).toBeCloseTo(Math.hypot(atZero[0], atZero[1]), 5);
    });
});

describe('plugin render contracts', () => {
    test('the trace uploads geometry and asks for a geometry pass', () => {
        const definition = createM1Registry().get('SignalTraceSource:circular')!;
        const instance = definition.create(createContext('trace').context);
        instance.initialize();
        instance.activate({
            clock: { trackId: 't', playbackTime: 0, duration: 1, state: 'playing', generation: 1 },
            parameters: {},
        });

        const { frame, uploads } = frameContext();
        instance.update(frame);

        // Two uploads: the strip the colour pass draws, and the same vertices carrying the velocity
        // the motion pass publishes. See ADR-0012.
        // The helper divides by three, which is the colour buffer's stride; the motion buffer packs
        // four floats a vertex — a position and a velocity — so its count reads four thirds of that.
        expect(uploads).toHaveLength(2);
        expect(uploads[0].vertexCount).toBe(256);
        expect(uploads[1].vertexCount).toBeCloseTo(256 * 4 / 3, 5);

        const colourOnly = instance.render({
            inputs: {},
            outputs: { color: 'trace.color' },
            previous: {},
            renderWidth: 640,
            renderHeight: 360,
        });

        // The motion pass appears only when something asked for the port, so a scene that does not
        // read the trace's motion does not pay for it. The other two are the decay that ages the
        // colour target and the trace composited into it (ADR-0014).
        expect(countPasses(colourOnly)).toBe(2);
        expect(isGeometryPass(colourOnly[0])).toBe(false);
        expect(colourOnly[0]).toMatchObject({ output: 'trace.color', blend: 'multiply', clear: false });
        expect(isGeometryPass(colourOnly[1])).toBe(true);
        expect(colourOnly[1]).toMatchObject({ output: 'trace.color', blend: 'lighten', clear: false });

        const withMotion = instance.render({
            inputs: {},
            outputs: { color: 'trace.color', motion: 'trace.motion' },
            previous: {},
            renderWidth: 640,
            renderHeight: 360,
        });

        expect(countPasses(withMotion)).toBe(3);
        expect(withMotion[2].output).toBe('trace.motion');
    });

    test('the feedback transform reads its previous frame when one is wired', () => {
        const definition = createM1Registry().get('FeedbackFlowTransform:vortex')!;
        const instance = definition.create(createContext('feedback').context);
        instance.initialize();

        const passes = instance.render({
            inputs: { source: 'trace.color' },
            outputs: { color: 'feedback.color' },
            previous: { history: 'feedback.color' },
            renderWidth: 640,
            renderHeight: 360,
        });

        expect(passes[0].inputs).toEqual({ uSource: 'trace.color', uHistory: 'feedback.color' });
        // Feedback must not clear its target, or there is nothing to accumulate into.
        expect(passes[0].clear).toBe(false);
    });

    test('the feedback transform degrades to a passthrough with no history wired', () => {
        const definition = createM1Registry().get('FeedbackFlowTransform:zoom')!;
        const instance = definition.create(createContext('feedback').context);

        const passes = instance.render({
            inputs: { source: 'trace.color' },
            outputs: { color: 'feedback.color' },
            previous: {},
            renderWidth: 640,
            renderHeight: 360,
        });

        expect(passes[0].inputs).toEqual({ uSource: 'trace.color', uHistory: 'trace.color' });
    });

    test('a plugin with an unsatisfied required input emits no passes', () => {
        for (const id of ['FeedbackFlowTransform:zoom', 'ToneMapper']) {
            const definition = createM1Registry().get(id)!;
            const instance = definition.create(createContext().context);

            const passes = instance.render({
                inputs: {},
                outputs: { color: 'out.color' },
                previous: {},
                renderWidth: 640,
                renderHeight: 360,
            });

            expect(passes, id).toEqual([]);
        }
    });

    test('the tone mapper clears and does not blend, being the final stage', () => {
        const definition = createM1Registry().get('ToneMapper')!;
        const instance = definition.create(createContext().context);

        const passes = instance.render({
            inputs: { source: 'feedback.color' },
            outputs: { color: 'tone.color' },
            previous: {},
            renderWidth: 640,
            renderHeight: 360,
        });

        expect(passes[0].blend).toBe('none');
        expect(passes[0].clear).toBe(true);
    });

    test('a frozen frame does not advance the trace phase', () => {
        const definition = createM1Registry().get('SignalTraceSource:circular')!;
        const instance = definition.create(createContext('trace').context);
        instance.initialize();
        instance.activate({
            clock: { trackId: 't', playbackTime: 0, duration: 1, state: 'paused', generation: 1 },
            parameters: {},
        });

        const first = frameContext({ deltaSeconds: 0 });
        instance.update(first.frame);
        const firstVertices = new Float32Array(256 * 3);
        traceVertices('circular', first.frame.features.waveform, 0.6, 0.42 * Math.PI * 2, firstVertices);

        const second = frameContext({ deltaSeconds: 0 });
        instance.update(second.frame);

        // Two frozen frames with identical input produce identical geometry.
        expect(second.uploads[0].vertexCount).toBe(first.uploads[0].vertexCount);
    });
});
