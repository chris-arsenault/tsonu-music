/** Spatial image warps that publish the corresponding motion field. */

import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import type { RenderPass } from '../../core/passes';
import { QUAD_VERTEX_SHADER } from '../../host/device';
import { SPATIAL_FEEDBACK } from '../../core/grammar';

export type FeedbackFlowMode =
    | 'zoom'
    | 'rotate'
    | 'translate'
    | 'spiral'
    | 'radial'
    | 'pinch'
    | 'vortex'
    | 'drift'
    | 'vector-field';

/**
 * Section 19.8's nine modes. Vector-field flow was the one missing.
 *
 * The other eight are closed-form warps: the same shape of motion wherever the material came from.
 * This one is steered by a field the scene produced, so a mask's boundary gradient, a curl field, or
 * an audio impulse decides where the accumulated image travels. It is the branch-level counterpart to
 * the composite's motion bus — that drags the whole frame, this drags one branch.
 */
export const FEEDBACK_FLOW_MODES: readonly FeedbackFlowMode[] = [
    'zoom',
    'rotate',
    'translate',
    'spiral',
    'radial',
    'pinch',
    'vortex',
    'drift',
    'vector-field',
];

const SHADER_ID = 'feedback-flow';
const MOTION_SHADER_ID = 'feedback-flow:motion';

/** Mode selector passed as a uniform, so one program serves every mode. */
export function feedbackModeIndex(mode: FeedbackFlowMode): number {
    return FEEDBACK_FLOW_MODES.indexOf(mode);
}

/**
 * The nine warps, shared by the colour pass and the pass that publishes them.
 *
 * Both answer the same question — where does this pixel read its source from — and one of them then
 * samples while the other reports the displacement. Sharing the function is what stops them drifting
 * apart, which two copies of nine branches would guarantee eventually.
 */
const WARP_BODY = `
vec2 warp(vec2 uv, float mode, float strength) {
    // Seed-drawn per instance: pivoting every radial mode on the frame centre put all of a
    // scene's rotations and zooms on one axis, so persistent material converged on concentric
    // orbits and two transports could never conflict.
    vec2 centered = uv - uCentre;
    float radius = length(centered);
    float angle = atan(centered.y, centered.x);

    if (mode < 0.5) {                      // zoom
        centered *= 1.0 - strength;
    } else if (mode < 1.5) {               // rotate
        float c = cos(uRotation * strength);
        float s = sin(uRotation * strength);
        centered = mat2(c, -s, s, c) * centered;
    } else if (mode < 2.5) {               // translate
        centered -= uDrift * strength;
    } else if (mode < 3.5) {               // spiral
        angle += strength * 0.6;
        radius *= 1.0 - strength * 0.5;
        centered = vec2(cos(angle), sin(angle)) * radius;
    } else if (mode < 4.5) {               // radial expansion
        centered *= 1.0 + strength;
    } else if (mode < 5.5) {               // pinch
        centered *= 1.0 - strength * (1.0 - radius);
    } else if (mode < 6.5) {               // vortex
        angle += strength * (1.0 - radius) * 2.0;
        centered = vec2(cos(angle), sin(angle)) * radius;
    } else {                               // directional drift
        centered -= uDrift * strength * (0.5 + radius);
    }

    return centered + uCentre;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
/** Steers the vector-field mode. Unbound and unread by the other eight. */
uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uMode;
uniform float uStrength;
uniform float uRotation;
uniform vec2 uDrift;
uniform vec2 uCentre;
uniform float uDelta;

/** Frames a second the strength constant is tuned against. */
const float REFERENCE_RATE = 60.0;

${WARP_BODY}

void main() {
    // uStrength describes what one frame does, so it is corrected for the frame this actually is.
    float step = uStrength * max(uDelta, 0.0) * REFERENCE_RATE;

    vec2 sampleUv;
    if (uMode > 7.5) {
        // Read from behind along the field, so material travels forward along it — the same
        // convention the composite's gather uses. Scaled up because a warp's strength is a fraction
        // of the frame while a field vector is already close to unit length.
        vec2 field = texture(uField, vUv).xy;
        sampleUv = clamp(vUv - field * step * 3.0, 0.0, 1.0);
    } else {
        sampleUv = warp(vUv, uMode, step);
    }

    fragColor = texture(uSource, clamp(sampleUv, 0.0, 1.0));
}`;

/**
 * The affine this plugin applies to its own history, published as a field (ADR-0012).
 *
 * These nine modes are MilkDrop's `zoom`, `rot`, `dx/dy`, and the warps between them, and they are
 * already driven by audio-bound parameters. The plugin applies them to its own loop; publishing them
 * lets a second stage apply the same transform to something else — a branch that is not this one, or
 * the whole composed image.
 *
 * The vector-field mode publishes nothing. It is reading a field to decide its warp, so republishing
 * it would put the same displacement into the graph twice under two names, and anything summing both
 * would double it.
 */
const MOTION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uMode;
uniform float uStrength;
uniform float uRotation;
uniform vec2 uDrift;
uniform vec2 uCentre;
uniform float uDelta;

const float REFERENCE_RATE = 60.0;

${WARP_BODY}

void main() {
    if (uMode > 7.5) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // Per second rather than per frame, which is what the bus carries: the warp is expressed for
    // this frame's delta, so dividing by it recovers the rate.
    float step = uStrength * max(uDelta, 0.0) * REFERENCE_RATE;
    vec2 source = warp(vUv, uMode, step);

    // Reversed against the sampling offset, as everywhere: the colour pass reads at the warped
    // point and writes at this one, so material travels from there toward here.
    vec2 field = clamp((vUv - source) * REFERENCE_RATE, vec2(-2.0), vec2(2.0));

    fragColor = vec4(field, length(field), 1.0);
}`;

export function createFeedbackFlowTransform(mode: FeedbackFlowMode = 'zoom'): VisualPluginDefinition {
    return {
        id: `FeedbackFlowTransform:${mode}`,
        version: 1,
        category: 'transformer',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            // Only the vector-field mode declares a field, so the other eight are not wired to one
            // they would ignore. Required, because without it this mode is a passthrough.
            ...(mode === 'vector-field'
                ? [{ name: 'field', type: 'vector-field' as const, required: true }]
                : []),
        ],
        outputs: [
            { name: 'color', type: 'color-texture', required: false },
            // MilkDrop's zoom, rot and dx/dy, offered to the rest of the graph rather than kept for
            // this plugin's own loop. The vector-field mode publishes zero: it is reading a field to
            // decide its warp, and republishing it would put one displacement into the graph twice.
            { name: 'motion', type: 'vector-field', required: false },
        ],
        // Every mode of this plugin resamples the history through a warp — zoom, rotate, translate,
        // spiral, pinch, vortex, drift — so a loop closed here accumulates motion rather than only
        // brightness. That is what `requireSpatialLoop` is asking for.
        capabilities: ['spatial-warp', SPATIAL_FEEDBACK],
        cost: { gpu: 1, cpu: 0, memory: 1, renderPasses: 2, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.6,
            motionEnergy: 0.7,
            geometricOrder: 0.4,
            recognizability: 0.1,
            persistence: 0.9,
            brightness: 0.5,
            dominance: 'supporting',
        },
        activationRules: { activationWeight: 1.5, minimumDuration: 12, prefersWith: ['PaletteMapper'] },
        parameters: { strength: 0.02, rotation: 0.15 },
        defaultBindings: [
            {
                // Low-frequency energy drives large-scale expansion by default; the per-scene
                // draw may instead make it swell over phrases or kick on hits.
                feature: 'bass',
                parameter: 'strength',
                outputRange: [0.004, 0.05],
                attack: 0.08,
                release: 0.4,
                curve: 'smooth',
                expressions: ['follow', 'glide', 'punch'],
            },
            {
                // The angle the warp turns through. Only the rotate mode reads it, and it read a
                // constant. `swing` recentres the range on zero, so the turn can change direction
                // with the music instead of only changing speed.
                feature: 'mid',
                parameter: 'rotation',
                outputRange: [0.04, 0.55],
                attack: 0.3,
                release: 1,
                curve: 'smooth',
                expressions: ['follow', 'glide', 'swing'],
            },
        ],
        deactivationPolicy: 'fade',

        create(context): VisualPluginInstance {
            let drift: [number, number] = [0, 0];
            let centre: [number, number] = [0.5, 0.5];

            return {
                initialize() {
                    context.registerShader({ id: SHADER_ID, vertex: QUAD_VERTEX_SHADER, fragment: FRAGMENT });
                    context.registerShader({
                        id: MOTION_SHADER_ID,
                        vertex: QUAD_VERTEX_SHADER,
                        fragment: MOTION_FRAGMENT,
                    });
                },

                activate() {
                    const angle = context.seed * Math.PI * 2;
                    drift = [Math.cos(angle) * 0.01, Math.sin(angle) * 0.01];
                    const pivot = context.seed * Math.PI * 2 * 3.7;
                    centre = [
                        0.5 + Math.cos(pivot) * 0.18,
                        0.5 + Math.sin(pivot) * 0.18,
                    ];
                },

                update() {
                    // Stateless between frames: all persistence lives in the feedback texture, which
                    // is what lets this plugin be replaced without losing the accumulated image.
                },

                render(render): RenderPass[] {
                    const source = render.inputs.source;
                    if (!source) {
                        return [];
                    }

                    const field = render.inputs.field;
                    if (mode === 'vector-field' && !field) {
                        return [];
                    }

                    const inputs = {
                        uSource: source,
                        ...(field ? { uField: field } : {}),
                    };
                    const uniforms = {
                        uMode: feedbackModeIndex(mode),
                        uStrength: 0.02,
                        uRotation: 0.15,
                        uDrift: drift,
                        uCentre: centre,
                    };

                    const passes: RenderPass[] = [{
                        kind: 'fullscreen',
                        shader: SHADER_ID,
                        inputs,
                        output: render.outputs.color,
                        blend: 'none',
                        clear: true,
                        uniforms,
                    }];

                    // The affine, published so a second stage can apply the same transform to
                    // something that is not this plugin's own loop. Same uniforms, so the two passes
                    // describe one warp.
                    if (render.outputs.motion) {
                        passes.push({
                            kind: 'fullscreen',
                            shader: MOTION_SHADER_ID,
                            inputs,
                            output: render.outputs.motion,
                            blend: 'none',
                            clear: true,
                            uniforms,
                        });
                    }

                    return passes;
                },

                deactivate() {
                    // Stateless transform.
                },

                destroy() {
                    drift = [0, 0];
                },
            };
        },
    };
}
