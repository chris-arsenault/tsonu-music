/**
 * `SignalTraceSource` (spec section 19.1) — waveform-derived geometry.
 *
 * A geometry-pass plugin: it rewrites a vertex buffer from the waveform each frame and asks for a
 * line draw. Its modes are shapes of the same trace, so one plugin covers what would otherwise be
 * eight near-duplicate definitions.
 */

import type {
    VisualPluginDefinition,
    VisualPluginInstance,
} from '../../core/plugin';
import type { GeometryUpload, RenderPass } from '../../core/passes';

export type SignalTraceMode =
    | 'oscilloscope'
    | 'mirrored-ribbon'
    | 'circular'
    | 'spiral'
    | 'stacked'
    | 'lissajous'
    | 'radial-petals'
    | 'filament';

export const SIGNAL_TRACE_MODES: readonly SignalTraceMode[] = [
    'oscilloscope',
    'mirrored-ribbon',
    'circular',
    'spiral',
    'stacked',
    'lissajous',
    'radial-petals',
    'filament',
];

const SHADER_ID = 'signal-trace';
const GEOMETRY_ID = 'signal-trace-vertices';
const MAX_VERTICES = 2048;

const VERTEX = `#version 300 es
in vec2 aPosition;
in float aIntensity;
out float vIntensity;
uniform float uThickness;
void main() {
    vIntensity = aIntensity;
    gl_PointSize = uThickness;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in float vIntensity;
out vec4 fragColor;
uniform float uBrightness;
void main() {
    float energy = clamp(vIntensity * uBrightness, 0.0, 1.0);
    fragColor = vec4(vec3(energy), energy);
}`;

/**
 * Writes `waveform` into `vertices` as x, y, intensity triples for the given mode.
 * Exported for testing: the shapes are pure geometry and want covering without a GL context.
 */
export function traceVertices(
    mode: SignalTraceMode,
    waveform: Float32Array,
    amplitude: number,
    phase: number,
    vertices: Float32Array,
): number {
    const count = Math.min(waveform.length, Math.floor(vertices.length / 3));

    for (let index = 0; index < count; index += 1) {
        const t = count > 1 ? index / (count - 1) : 0;
        const sample = waveform[index] * amplitude;
        const write = index * 3;

        let x: number;
        let y: number;

        switch (mode) {
            case 'oscilloscope':
                x = t * 2 - 1;
                y = sample;
                break;

            case 'mirrored-ribbon':
                x = t * 2 - 1;
                y = Math.abs(sample) * (index % 2 === 0 ? 1 : -1);
                break;

            case 'circular': {
                const angle = t * Math.PI * 2 + phase;
                const radius = 0.5 + sample * 0.4;
                x = Math.cos(angle) * radius;
                y = Math.sin(angle) * radius;
                break;
            }

            case 'spiral': {
                const angle = t * Math.PI * 8 + phase;
                const radius = t * (0.85 + sample * 0.15);
                x = Math.cos(angle) * radius;
                y = Math.sin(angle) * radius;
                break;
            }

            case 'stacked': {
                const rows = 4;
                // Clamped: at t === 1 the raw floor lands one row past the last, pushing the final
                // vertex outside clip space.
                const row = Math.min(rows - 1, Math.floor(t * rows));
                const withinRow = t * rows - row;
                x = withinRow * 2 - 1;
                y = (row / (rows - 1)) * 1.6 - 0.8 + sample * 0.2;
                break;
            }

            case 'lissajous': {
                // Stereo Lissajous, approximated from one buffer by offsetting the second axis.
                const other = waveform[(index + Math.floor(count / 4)) % count] * amplitude;
                x = sample;
                y = other;
                break;
            }

            case 'radial-petals': {
                const petals = 6;
                const angle = t * Math.PI * 2 + phase;
                const radius = (0.35 + Math.abs(sample) * 0.5) * Math.abs(Math.cos(angle * petals * 0.5));
                x = Math.cos(angle) * radius;
                y = Math.sin(angle) * radius;
                break;
            }

            case 'filament': {
                // Smoothed against its neighbours, so a noisy buffer still reads as one line.
                const previous = waveform[Math.max(0, index - 1)] * amplitude;
                const next = waveform[Math.min(count - 1, index + 1)] * amplitude;
                x = t * 2 - 1;
                y = (previous + sample * 2 + next) / 4;
                break;
            }
        }

        vertices[write] = x;
        vertices[write + 1] = y;
        vertices[write + 2] = Math.min(1, Math.abs(sample) * 2 + 0.15);
    }

    return count;
}

export function createSignalTraceSource(mode: SignalTraceMode = 'oscilloscope'): VisualPluginDefinition {
    return {
        id: `SignalTraceSource:${mode}`,
        version: 1,
        category: 'source',
        inputs: [],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
        capabilities: ['waveform-geometry'],
        cost: { gpu: 1, cpu: 1, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.35,
            motionEnergy: 0.6,
            geometricOrder: 0.8,
            recognizability: 0.2,
            persistence: 0.1,
            brightness: 0.6,
            dominance: 'either',
        },
        activationRules: {
            // High: an audio-derived trace is the material a music visualizer is about, and the
            // whole family now competes as one rather than as eight.
            activationWeight: 7,
            minimumDuration: 8,
        },
        parameters: { amplitude: 0.6, thickness: 2, brightness: 1.4 },
        defaultBindings: [
            {
                feature: 'rmsExcite',
                role: 'intensity',
                parameter: 'thickness',
                outputRange: [1.2, 3.8],
                attack: 0.06,
                release: 0.4,
                curve: 'sqrt',
            },
            {
                feature: 'rms',
                parameter: 'amplitude',
                outputRange: [0.15, 0.85],
                attack: 0.05,
                release: 0.25,
                curve: 'sqrt',
            },
            {
                feature: 'treble',
                parameter: 'brightness',
                outputRange: [0.9, 2.2],
                attack: 0.02,
                release: 0.3,
                curve: 'linear',
            },
        ],
        deactivationPolicy: 'fade',

        create(context): VisualPluginInstance {
            const vertices = new Float32Array(MAX_VERTICES * 3);
            let vertexCount = 0;
            let phase = 0;

            return {
                initialize() {
                    context.registerShader({ id: SHADER_ID, vertex: VERTEX, fragment: FRAGMENT });
                },

                activate() {
                    phase = context.seed * Math.PI * 2;
                },

                update(frame) {
                    // Zero delta on a frozen clock, so the trace holds its last shape.
                    phase += frame.deltaSeconds * 0.4;

                    vertexCount = traceVertices(
                        mode,
                        frame.features.waveform,
                        frame.parameters.amplitude ?? 0.6,
                        phase,
                        vertices,
                    );

                    const upload: GeometryUpload = {
                        id: GEOMETRY_ID,
                        data: vertices.subarray(0, vertexCount * 3),
                        attributes: [
                            { name: 'aPosition', components: 2 },
                            { name: 'aIntensity', components: 1 },
                        ],
                    };
                    frame.uploadGeometry(upload);
                },

                render(render): RenderPass[] {
                    if (vertexCount === 0) {
                        return [];
                    }

                    return [{
                        kind: 'geometry',
                        shader: SHADER_ID,
                        geometry: GEOMETRY_ID,
                        primitive: mode === 'lissajous' ? 'points' : 'line-strip',
                        vertexCount,
                        output: render.outputs.color,
                        blend: 'add',
                        clear: true,
                        uniforms: {
                            uThickness: 2,
                            uBrightness: 1.4,
                        },
                    }];
                },

                deactivate() {
                    vertexCount = 0;
                },

                destroy() {
                    vertexCount = 0;
                },
            };
        },
    };
}
