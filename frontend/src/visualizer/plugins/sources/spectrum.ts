/**
 * Spectrum and transient sources (spec section 19.1).
 *
 * `SpectrumGeometrySource` reads the frequency spectrum as geometry; `TransientGlyphSource` draws
 * short-lived marks triggered by onsets and impacts. Both take their material from the feature bus, so
 * neither duplicates any analysis.
 */

import { character } from '../define';
import type { RenderPass } from '../../core/passes';
import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import { impactAge, type ImpactEvent } from '../../core/impact';

/**
 * Identity for an impact, which carries none of its own.
 *
 * Time and position together: two impacts in the same frame at the same point are the same visual
 * event whatever produced them.
 */
function impactKey(impact: ImpactEvent): string {
    return `${impact.playbackTime}:${impact.position[0]}:${impact.position[1]}`;
}

const SPECTRUM_SHADER = 'spectrum-geometry';
const SPECTRUM_MOTION_SHADER = 'spectrum-geometry:motion';
const SPECTRUM_MOTION_GEOMETRY = 'spectrum-motion-vertices';

/**
 * The rise and fall of each band, published as a field (ADR-0012).
 *
 * Vertex `i` is the same bin every frame — the same column of a contour, the same spoke of a radial
 * — so differencing it across frames is how fast that band is growing, which is a real velocity of
 * the material drawn there rather than an artefact of regenerating the geometry.
 *
 * Drawn as sized points rather than the line strip the colour pass uses: a line is one pixel wide
 * wherever `lineWidth` is capped, and a one-pixel displacement field displaces nothing.
 */
const SPECTRUM_MOTION_VERTEX = `#version 300 es
in vec2 aPosition;
in vec2 aVelocity;
out vec2 vVelocity;

uniform float uReach;

void main() {
    vVelocity = aVelocity;
    gl_PointSize = uReach;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const SPECTRUM_MOTION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vVelocity;
out vec4 fragColor;

uniform float uWakeScale;

void main() {
    float falloff = 1.0 - smoothstep(0.1, 0.5, length(gl_PointCoord - 0.5));
    if (falloff <= 0.0) {
        discard;
    }

    // Clip space spans two units across the frame against UV's one.
    vec2 field = vVelocity * 0.5 * uWakeScale * falloff;

    fragColor = vec4(field, falloff, 1.0);
}`;
const GLYPH_SHADER = 'transient-glyph';
const SPECTRUM_GEOMETRY = 'spectrum-vertices';
const GLYPH_GEOMETRY = 'glyph-vertices';

/** Bars, points, or ring segments, all from the same vertex buffer. */
const SPECTRUM_VERTEX = `#version 300 es
in vec2 aPosition;
in float aMagnitude;
out float vMagnitude;
void main() {
    vMagnitude = aMagnitude;
    // The cell-matrix mode draws this buffer as points, and GLSL ES 3.00 leaves an unwritten point
    // size unspecified — the mode rendered at whatever the driver happened to have. Scaled by
    // magnitude so a loud bin reads as a larger cell, since that mode has no size parameter of its own.
    gl_PointSize = 2.0 + aMagnitude * 6.0;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const SPECTRUM_FRAGMENT = `#version 300 es
precision highp float;
in float vMagnitude;
out vec4 fragColor;
uniform float uBrightness;
void main() {
    float energy = clamp(vMagnitude * uBrightness, 0.0, 1.0);
    fragColor = vec4(vec3(energy), energy);
}`;

const GLYPH_VERTEX = `#version 300 es
in vec2 aPosition;
in float aStrength;
out float vStrength;
void main() {
    vStrength = aStrength;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const GLYPH_FRAGMENT = `#version 300 es
precision highp float;
in float vStrength;
out vec4 fragColor;
void main() {
    fragColor = vec4(vec3(vStrength), vStrength);
}`;

export type SpectrumMode =
    | 'contour'
    | 'radial'
    | 'ridge'
    | 'rings'
    | 'ribbon'
    | 'waterfall'
    | 'log-spiral'
    | 'cell-matrix';

export const SPECTRUM_MODES: readonly SpectrumMode[] = [
    'contour', 'radial', 'ridge', 'rings', 'ribbon', 'waterfall', 'log-spiral', 'cell-matrix',
];

/**
 * Writes the spectrum into a vertex buffer for the given mode. Pure, so the shapes are testable.
 *
 * A logarithmic bin mapping is used for the modes that read as pitch rather than as raw bins, because a
 * linear spectrum crowds everything musical into the leftmost eighth.
 */
export function spectrumVertices(
    mode: SpectrumMode,
    spectrum: Float32Array,
    gain: number,
    phase: number,
    vertices: Float32Array,
): number {
    const bins = Math.min(spectrum.length, Math.floor(vertices.length / 3));
    if (bins === 0) {
        return 0;
    }

    for (let index = 0; index < bins; index += 1) {
        const t = bins > 1 ? index / (bins - 1) : 0;
        // Logarithmic so low frequencies are not compressed into a sliver.
        const logIndex = Math.min(bins - 1, Math.floor((Math.exp(t * Math.log(bins)) - 1)));
        const magnitude = Math.min(1, spectrum[logIndex] * gain);
        const write = index * 3;

        let x: number;
        let y: number;

        switch (mode) {
            case 'contour':
                x = t * 2 - 1;
                y = -1 + magnitude * 1.8;
                break;

            case 'radial': {
                const angle = t * Math.PI * 2 + phase;
                const radius = 0.3 + magnitude * 0.65;
                x = Math.cos(angle) * radius;
                y = Math.sin(angle) * radius;
                break;
            }

            case 'ridge':
                x = t * 2 - 1;
                y = -0.6 + magnitude * 1.2 + Math.sin(t * 12 + phase) * 0.05;
                break;

            case 'rings': {
                const ring = Math.floor(t * 4);
                const angle = (t * 4 - ring) * Math.PI * 2 + phase;
                const radius = 0.25 + ring * 0.18 + magnitude * 0.12;
                x = Math.cos(angle) * radius;
                y = Math.sin(angle) * radius;
                break;
            }

            case 'ribbon':
                x = t * 2 - 1;
                y = magnitude * (index % 2 === 0 ? 0.9 : -0.9);
                break;

            case 'waterfall':
                // History is the compositor's job through feedback; this draws the newest row.
                x = t * 2 - 1;
                y = 0.92 - magnitude * 0.12;
                break;

            case 'log-spiral': {
                const angle = t * Math.PI * 6 + phase;
                const radius = 0.08 + t * 0.8 * (0.7 + magnitude * 0.5);
                x = Math.cos(angle) * radius;
                y = Math.sin(angle) * radius;
                break;
            }

            case 'cell-matrix': {
                const columns = 16;
                const column = index % columns;
                const row = Math.floor(index / columns);
                x = (column / (columns - 1)) * 1.8 - 0.9;
                y = 0.9 - (row / Math.max(1, Math.ceil(bins / columns) - 1)) * 1.8;
                break;
            }
        }

        vertices[write] = x;
        vertices[write + 1] = y;
        vertices[write + 2] = Math.max(0.05, magnitude);
    }

    return bins;
}

export function createSpectrumGeometrySource(mode: SpectrumMode = 'radial'): VisualPluginDefinition {
    const MAX_BINS = 512;

    return {
        id: `SpectrumGeometrySource:${mode}`,
        version: 1,
        category: 'source',
        inputs: [],
        outputs: [
            { name: 'color', type: 'color-texture', required: false },
            // How fast each band is rising, which is what this plugin knows about the music that
            // nothing downstream of it can see.
            { name: 'motion', type: 'vector-field', required: false },
        ],
        capabilities: ['spectrum-geometry', 'vector-field'],
        cost: { gpu: 1, cpu: 1, memory: 1, renderPasses: 2, qualityScalable: true, dominant: false },
        character: character({ geometricOrder: 0.85, visualDensity: 0.5, motionEnergy: 0.6 }),
        activationRules: { activationWeight: 1, minimumDuration: 8 },
        parameters: { gain: 1.15, brightness: 1.3, wakeScale: 1.2 },
        defaultBindings: [
            {
                feature: 'rms',
                role: 'intensity',
                parameter: 'gain',
                // Against a spectrum normalized on the bus rather than raw FFT magnitude. The old
                // range of 3.5 to 9.5 was written for values whose median was 7.7e-5, so it needed to
                // be in the hundreds to reach the top of the frame and instead drew a flat line.
                outputRange: [0.75, 2.1],
                attack: 0.12,
                release: 0.5,
                curve: 'smooth',
            },
            {
                // How hard a rising band pulls the image, for anything reading this motion.
                feature: 'bass',
                role: 'large-scale-force',
                parameter: 'wakeScale',
                outputRange: [0.3, 2.4],
                attack: 0.1,
                release: 0.6,
                curve: 'smooth',
            },
        {
            feature: 'spectralCentroid',
            parameter: 'brightness',
            outputRange: [0.9, 1.9],
            attack: 0.1,
            release: 0.4,
            curve: 'linear',
        }],
        deactivationPolicy: 'fade',

        create(context): VisualPluginInstance {
            const vertices = new Float32Array(MAX_BINS * 3);
            /** Last frame's vertices, so each bin can say how fast it is rising. */
            const previous = new Float32Array(MAX_BINS * 3);
            /** Position and velocity per bin, for the pass that publishes the motion. */
            const motion = new Float32Array(MAX_BINS * 4);
            let hasPrevious = false;
            let count = 0;
            let phase = 0;

            return {
                initialize() {
                    context.registerShader({
                        id: SPECTRUM_SHADER,
                        vertex: SPECTRUM_VERTEX,
                        fragment: SPECTRUM_FRAGMENT,
                    });
                    context.registerShader({
                        id: SPECTRUM_MOTION_SHADER,
                        vertex: SPECTRUM_MOTION_VERTEX,
                        fragment: SPECTRUM_MOTION_FRAGMENT,
                    });
                },

                activate() {
                    phase = context.seed * Math.PI * 2;
                    hasPrevious = false;
                },

                update(frame) {
                    phase += frame.deltaSeconds * 0.25;
                    count = spectrumVertices(
                        mode,
                        frame.features.spectrum,
                        frame.parameters.gain ?? 6,
                        phase,
                        vertices,
                    );

                    frame.uploadGeometry({
                        id: SPECTRUM_GEOMETRY,
                        data: vertices.subarray(0, count * 3),
                        attributes: [
                            { name: 'aPosition', components: 2 },
                            { name: 'aMagnitude', components: 1 },
                        ],
                    });

                    // A frozen clock gives no velocity rather than an infinite one, and the first
                    // frame after activation has nothing to difference against.
                    const rate = hasPrevious && frame.deltaSeconds > 0 ? 1 / frame.deltaSeconds : 0;
                    for (let index = 0; index < count; index += 1) {
                        const from = index * 3;
                        const to = index * 4;
                        motion[to] = vertices[from];
                        motion[to + 1] = vertices[from + 1];
                        motion[to + 2] = (vertices[from] - previous[from]) * rate;
                        motion[to + 3] = (vertices[from + 1] - previous[from + 1]) * rate;
                    }

                    previous.set(vertices.subarray(0, count * 3));
                    hasPrevious = true;

                    frame.uploadGeometry({
                        id: SPECTRUM_MOTION_GEOMETRY,
                        data: motion.subarray(0, count * 4),
                        attributes: [
                            { name: 'aPosition', components: 2 },
                            { name: 'aVelocity', components: 2 },
                        ],
                    });
                },

                render(render): RenderPass[] {
                    if (count === 0) {
                        return [];
                    }

                    const passes: RenderPass[] = [{
                        kind: 'geometry',
                        shader: SPECTRUM_SHADER,
                        geometry: SPECTRUM_GEOMETRY,
                        primitive: mode === 'cell-matrix' ? 'points' : 'line-strip',
                        vertexCount: count,
                        output: render.outputs.color,
                        blend: 'add',
                        clear: true,
                        uniforms: { uBrightness: 1.3 },
                    }];

                    if (render.outputs.motion) {
                        passes.push({
                            kind: 'geometry',
                            shader: SPECTRUM_MOTION_SHADER,
                            geometry: SPECTRUM_MOTION_GEOMETRY,
                            // Points, not the line strip above: a one-pixel line displaces nothing.
                            primitive: 'points',
                            vertexCount: count,
                            output: render.outputs.motion,
                            blend: 'add',
                            clear: true,
                            uniforms: { uReach: 16 },
                        });
                    }

                    return passes;
                },

                deactivate() {
                    count = 0;
                },

                destroy() {
                    count = 0;
                },
            };
        },
    };
}

export type GlyphMode =
    | 'expanding-rings'
    | 'polygon-burst'
    | 'radial-cracks'
    | 'star-pulse'
    | 'line-spray'
    | 'shockwave';

export const GLYPH_MODES: readonly GlyphMode[] = [
    'expanding-rings', 'polygon-burst', 'radial-cracks', 'star-pulse', 'line-spray', 'shockwave',
];

interface Glyph {
    x: number;
    y: number;
    age: number;
    strength: number;
}

/**
 * Short-lived geometry triggered by audio events and impacts.
 *
 * Reads both the onset channel and the impact bus, which is what lets one plugin respond to musical
 * transients and to collisions produced elsewhere in the scene.
 */
export function createTransientGlyphSource(mode: GlyphMode = 'expanding-rings'): VisualPluginDefinition {
    const MAX_GLYPHS = 24;
    const POINTS_PER_GLYPH = 48;
    const LIFETIME = 0.7;

    return {
        id: `TransientGlyphSource:${mode}`,
        version: 1,
        category: 'source',
        inputs: [],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
        capabilities: ['transient-geometry', 'impact-consumer'],
        cost: { gpu: 1, cpu: 1, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: character({
            motionEnergy: 0.85,
            visualDensity: 0.3,
            geometricOrder: 0.7,
            persistence: 0.1,
            dominance: 'supporting',
        }),
        activationRules: { activationWeight: 1.5, minimumDuration: 6 },
        parameters: { scale: 1 },
        defaultBindings: [{
            // Onset strength already sets a glyph's brightness; peak level sets how far it reaches.
            feature: 'peak',
            parameter: 'scale',
            outputRange: [0.6, 1.5],
            attack: 0.04,
            release: 0.35,
            curve: 'sqrt',
        }],
        deactivationPolicy: 'drain',

        create(context): VisualPluginInstance {
            const vertices = new Float32Array(MAX_GLYPHS * POINTS_PER_GLYPH * 3);
            let glyphs: Glyph[] = [];
            /** Impacts already given a glyph, so each spawns one rather than one per frame it is new. */
            const spawnedImpacts = new Set<string>();
            let count = 0;
            let emitting = true;

            return {
                initialize() {
                    context.registerShader({
                        id: GLYPH_SHADER,
                        vertex: GLYPH_VERTEX,
                        fragment: GLYPH_FRAGMENT,
                    });
                },

                activate() {
                    glyphs = [];
                    emitting = true;
                },

                update(frame) {
                    // Ages first, so a glyph spawned this frame starts at zero rather than one step in.
                    glyphs = glyphs
                        .map((glyph) => ({ ...glyph, age: glyph.age + frame.deltaSeconds }))
                        .filter((glyph) => glyph.age < LIFETIME);

                    if (emitting) {
                        for (const onset of frame.features.events.onset) {
                            // Placed by a hash of the event time, so the same audio yields the same layout.
                            const jitter = Math.abs(Math.sin(onset.audioTime * 127.1)) ;
                            glyphs.push({
                                x: (jitter * 2 - 1) * 0.6,
                                y: (Math.abs(Math.sin(onset.audioTime * 311.7)) * 2 - 1) * 0.6,
                                age: 0,
                                strength: onset.strength,
                            });
                        }

                        // Each impact spawns one glyph, tracked by id.
                        //
                        // The age test alone is a window, not an event: normalised against a lifetime
                        // of 1.5 seconds, an age under 0.05 is 75 milliseconds, so every impact
                        // spawned four or five glyphs on consecutive frames. The duplicates then
                        // evicted still-live glyphs through the ring buffer's tail slice, so an
                        // impact crowded out the ones before it.
                        for (const impact of frame.impacts.active) {
                            const age = impactAge(impact, frame.clock.playbackTime);
                            const id = impactKey(impact);
                            if (age >= 0 && age < 0.05 && !spawnedImpacts.has(id)) {
                                spawnedImpacts.add(id);
                                glyphs.push({
                                    x: impact.position[0] * 2 - 1,
                                    y: impact.position[1] * 2 - 1,
                                    age: 0,
                                    strength: Math.min(1, impact.energy),
                                });
                            }
                        }

                        // Forgotten once the impact is no longer live, so the set cannot grow without
                        // bound over a track.
                        const live = new Set(frame.impacts.active.map(impactKey));
                        for (const id of spawnedImpacts) {
                            if (!live.has(id)) {
                                spawnedImpacts.delete(id);
                            }
                        }
                    }

                    glyphs = glyphs.slice(-MAX_GLYPHS);
                    count = writeGlyphs(
                        mode,
                        glyphs,
                        LIFETIME,
                        vertices,
                        POINTS_PER_GLYPH,
                        frame.parameters.scale ?? 1,
                    );

                    frame.uploadGeometry({
                        id: GLYPH_GEOMETRY,
                        data: vertices.subarray(0, count * 3),
                        attributes: [
                            { name: 'aPosition', components: 2 },
                            { name: 'aStrength', components: 1 },
                        ],
                    });
                },

                render(render): RenderPass[] {
                    if (count === 0) {
                        return [];
                    }

                    return [{
                        kind: 'geometry',
                        shader: GLYPH_SHADER,
                        geometry: GLYPH_GEOMETRY,
                        primitive: 'lines',
                        vertexCount: count,
                        output: render.outputs.color,
                        blend: 'add',
                        clear: true,
                    }];
                },

                deactivate(deactivation) {
                    // Draining stops emission and lets existing glyphs finish their lifetime.
                    emitting = deactivation.policy !== 'drain';
                },

                destroy() {
                    glyphs = [];
                    count = 0;
                },
            };
        },
    };
}

/** Writes glyph geometry as line pairs. Exported for testing. */
export function writeGlyphs(
    mode: GlyphMode,
    glyphs: readonly Glyph[],
    lifetime: number,
    vertices: Float32Array,
    pointsPerGlyph: number,
    /** How far a glyph reaches at full age. Driven by level, so louder passages throw wider marks. */
    scale = 1,
): number {
    let written = 0;
    const capacity = Math.floor(vertices.length / 3);

    for (const glyph of glyphs) {
        const progress = Math.min(1, glyph.age / lifetime);
        const fade = (1 - progress) * glyph.strength;
        const radius = (0.05 + progress * 0.45) * scale;

        for (let segment = 0; segment < pointsPerGlyph / 2; segment += 1) {
            if (written + 2 > capacity) {
                return written;
            }

            const spokes = mode === 'polygon-burst' ? 6 : mode === 'star-pulse' ? 5 : pointsPerGlyph / 2;
            const angle = (segment / (pointsPerGlyph / 2)) * Math.PI * 2;
            const nextAngle = ((segment + 1) / (pointsPerGlyph / 2)) * Math.PI * 2;

            let inner = radius;
            let outer = radius;

            if (mode === 'radial-cracks' || mode === 'line-spray') {
                inner = radius * 0.4;
            } else if (mode === 'star-pulse') {
                inner = radius * (segment % 2 === 0 ? 1 : 0.5);
            } else if (mode === 'shockwave') {
                outer = radius * 1.08;
            }

            const quantized = mode === 'polygon-burst' || mode === 'star-pulse'
                ? Math.round(angle / (Math.PI * 2 / spokes)) * (Math.PI * 2 / spokes)
                : angle;
            const quantizedNext = mode === 'polygon-burst' || mode === 'star-pulse'
                ? Math.round(nextAngle / (Math.PI * 2 / spokes)) * (Math.PI * 2 / spokes)
                : nextAngle;

            writeVertex(vertices, written, glyph.x + Math.cos(quantized) * inner, glyph.y + Math.sin(quantized) * inner, fade);
            written += 1;
            writeVertex(vertices, written, glyph.x + Math.cos(quantizedNext) * outer, glyph.y + Math.sin(quantizedNext) * outer, fade);
            written += 1;
        }
    }

    return written;
}

function writeVertex(vertices: Float32Array, index: number, x: number, y: number, strength: number): void {
    const offset = index * 3;
    vertices[offset] = x;
    vertices[offset + 1] = y;
    vertices[offset + 2] = strength;
}
