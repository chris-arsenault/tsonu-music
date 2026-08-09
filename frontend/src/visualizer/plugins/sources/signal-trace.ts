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
import { GLSL_COMMON, GLSL_PERTURB_VERTEX } from '../define';

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
const MOTION_SHADER_ID = 'signal-trace:motion';
const MOTION_GEOMETRY_ID = 'signal-trace-motion-vertices';

/**
 * The trace's own movement, published as a field (ADR-0012).
 *
 * Drawn as sized points rather than as the line strip the colour pass uses. A line is one pixel wide
 * on every driver that caps `lineWidth`, and a displacement field one pixel wide displaces nothing —
 * it has to have reach before anything reading it can carry material along the trace.
 */
const MOTION_VERTEX = `#version 300 es
in vec2 aPosition;
in vec2 aVelocity;
out vec2 vVelocity;

uniform float uReach;

void main() {
    vVelocity = aVelocity;
    gl_PointSize = uReach;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const MOTION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vVelocity;
out vec4 fragColor;

uniform float uWakeScale;

void main() {
    float falloff = 1.0 - smoothstep(0.1, 0.5, length(gl_PointCoord - 0.5));
    if (falloff <= 0.0) {
        discard;
    }

    // Positions are already in clip space, which spans two units across the frame against UV's one.
    vec2 field = vVelocity * 0.5 * uWakeScale * falloff;

    fragColor = vec4(field, falloff, 1.0);
}`;
const MAX_VERTICES = 2048;

const VERTEX = `#version 300 es
in vec2 aPosition;
in float aIntensity;
out float vIntensity;
out vec2 vTracePosition;
uniform float uThickness;
${GLSL_PERTURB_VERTEX}
void main() {
    vIntensity = aIntensity;
    gl_PointSize = uThickness;

    // Displaced by whatever field is wired in, per vertex. Sampling in the vertex stage rather than
    // reading the field back to the CPU: the trace is a few hundred points and the field is already
    // on the GPU. Unwired, the sampler reads the device's empty texture and this is the identity.
    vec2 placed = perturbedPosition(aPosition);

    vTracePosition = placed;
    gl_Position = vec4(placed, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in float vIntensity;
in vec2 vTracePosition;
out vec4 fragColor;
uniform float uBrightness;
uniform float uHue;
${GLSL_COMMON}
void main() {
    float energy = clamp(vIntensity * uBrightness, 0.0, 1.0);

    // Chromatic, not grey.
    //
    // This wrote vec3(energy) — white lines — as 58 other plugins in the catalog still do. Colour
    // then only ever arrived if a palette mapper happened to land downstream, which is about a third
    // of scenes; in the rest the trace was white on black whatever the music was doing. The hue runs
    // along the trace and is bound, so the line reads as a coloured object rather than a monochrome
    // overlay, and a palette mapper downstream still has something coherent to remap.
    float along = atan(vTracePosition.y, vTracePosition.x) / 6.2831853 + 0.5;
    vec3 tint = hsv2rgb(vec3(fract(uHue + along * 0.35), 0.75, 1.0));

    fragColor = vec4(tint * energy, energy);
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
        // The port that lets the rest of the scene act on this one. A mask boundary, a curl field, a
        // warp's published displacement — anything producing a field can now push the trace around,
        // where before nothing in the graph could reach it and it was redrawn at the same coordinates
        // every frame no matter what else was happening.
        inputs: [{ name: 'field', type: 'vector-field', required: false }],
        outputs: [
            { name: 'color', type: 'color-texture', required: false },
            // What the waveform is doing to the shape, which is the thing this plugin knows and
            // nothing else in the graph can see.
            { name: 'motion', type: 'vector-field', required: false },
        ],
        capabilities: ['waveform-geometry', 'vector-field'],
        cost: { gpu: 1, cpu: 1, memory: 1, renderPasses: 2, qualityScalable: true, dominant: false },
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
        parameters: {
            amplitude: 0.6,
            thickness: 2,
            brightness: 1.4,
            wakeScale: 1.2,
            perturb: 0.12,
            // Driven by a rate binding rather than a value one, so it is integrated by the kernel and
            // walks instead of tracking a band and returning to the same colour whenever that band
            // returns to the same level. Of 448 bindings in the catalog, 21 were integrated and none
            // of them was on a source's appearance.
            hue: 0,
        },
        defaultBindings: [
            {
                // How far the wired field pushes the trace.
                feature: 'lowMid',
                role: 'deformation',
                parameter: 'perturb',
                outputRange: [0.02, 0.35],
                attack: 0.15,
                release: 0.7,
                curve: 'smooth',
            },
            {
                // Integrated, so the colour walks and does not come back. A value binding here would
                // make the hue a function of the current band, which returns to the same colour every
                // time the band returns to the same level — the periodicity that reads as the picture
                // bouncing in place rather than going anywhere.
                feature: 'mid',
                mode: 'rate',
                role: 'complexity',
                parameter: 'hue',
                outputRange: [0.01, 0.12],
                attack: 0.3,
                release: 1.2,
                curve: 'smooth',
                wrap: 1,
            },
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
                // How hard the trace pulls the image it is drawn over, for anything reading its
                // motion. Large-scale force, as every other drag parameter takes.
                feature: 'bass',
                role: 'large-scale-force',
                parameter: 'wakeScale',
                outputRange: [0.3, 2.4],
                attack: 0.1,
                release: 0.6,
                curve: 'smooth',
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
            /**
             * Last frame's vertices, so the trace can say how fast it is moving (ADR-0012).
             *
             * Vertex `i` is the same position along the trace every frame — the same angle on a
             * circle, the same column on an oscilloscope — so differencing it across frames is a
             * genuine velocity of the material drawn there, not an artefact of regenerating the
             * geometry. It is what the waveform is doing to the shape, which is the thing this
             * plugin knows and nothing else in the graph can see.
             */
            const previous = new Float32Array(MAX_VERTICES * 3);
            /** Position and velocity per vertex, for the pass that publishes the motion. */
            const motion = new Float32Array(MAX_VERTICES * 4);
            let hasPrevious = false;
            let vertexCount = 0;
            let phase = 0;

            return {
                initialize() {
                    context.registerShader({ id: SHADER_ID, vertex: VERTEX, fragment: FRAGMENT });
                    context.registerShader({
                        id: MOTION_SHADER_ID,
                        vertex: MOTION_VERTEX,
                        fragment: MOTION_FRAGMENT,
                    });
                },

                activate() {
                    phase = context.seed * Math.PI * 2;
                    hasPrevious = false;
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

                    // A frozen clock gives no velocity rather than an infinite one, and the first
                    // frame after activation has nothing to difference against.
                    const rate = hasPrevious && frame.deltaSeconds > 0 ? 1 / frame.deltaSeconds : 0;
                    for (let index = 0; index < vertexCount; index += 1) {
                        const from = index * 3;
                        const to = index * 4;
                        motion[to] = vertices[from];
                        motion[to + 1] = vertices[from + 1];
                        motion[to + 2] = (vertices[from] - previous[from]) * rate;
                        motion[to + 3] = (vertices[from + 1] - previous[from + 1]) * rate;
                    }

                    previous.set(vertices.subarray(0, vertexCount * 3));
                    hasPrevious = true;

                    frame.uploadGeometry({
                        id: MOTION_GEOMETRY_ID,
                        data: motion.subarray(0, vertexCount * 4),
                        attributes: [
                            { name: 'aPosition', components: 2 },
                            { name: 'aVelocity', components: 2 },
                        ],
                    });
                },

                render(render): RenderPass[] {
                    if (vertexCount === 0) {
                        return [];
                    }

                    // The field the vertex shader displaces by, when the scene wired one. Absent, the
                    // device binds its empty texture and the displacement is the identity.
                    const inputs: Record<string, string> = {};
                    if (render.inputs.field) {
                        inputs.uField = render.inputs.field;
                    }

                    const passes: RenderPass[] = [{
                        kind: 'geometry',
                        shader: SHADER_ID,
                        geometry: GEOMETRY_ID,
                        inputs,
                        primitive: mode === 'lissajous' ? 'points' : 'line-strip',
                        vertexCount,
                        output: render.outputs.color,
                        blend: 'add',
                        clear: true,
                        uniforms: {
                            uThickness: 2,
                            uBrightness: 1.4,
                            uPerturb: 0.12,
                            uHue: 0,
                        },
                    }];

                    if (render.outputs.motion) {
                        passes.push({
                            kind: 'geometry',
                            shader: MOTION_SHADER_ID,
                            geometry: MOTION_GEOMETRY_ID,
                            // Points, not the line strip above: a one-pixel line displaces nothing.
                            primitive: 'points',
                            vertexCount,
                            output: render.outputs.motion,
                            // Overlapping samples moving together drag harder; moving apart, cancel.
                            blend: 'add',
                            clear: true,
                            uniforms: { uReach: 14 },
                        });
                    }

                    return passes;
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
