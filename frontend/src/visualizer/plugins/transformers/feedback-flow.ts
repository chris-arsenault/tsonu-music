/**
 * `FeedbackFlowTransform` (spec section 19.8) — the foundational feedback transformer.
 *
 * Samples its own previous frame through a coordinate warp and mixes it with incoming material. This
 * is the plugin that makes trails, tunnels, and vortices possible, and the reason the graph supports
 * declared feedback edges at all.
 */

import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import type { RenderPass } from '../../core/passes';
import { QUAD_VERTEX_SHADER } from '../../host/device';
import { GLSL_HISTORY } from '../define';

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

/** Mode selector passed as a uniform, so one program serves every mode. */
export function feedbackModeIndex(mode: FeedbackFlowMode): number {
    return FEEDBACK_FLOW_MODES.indexOf(mode);
}

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uHistory;
/** Steers the vector-field mode. Unbound and unread by the other eight. */
uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uMode;
uniform float uStrength;
uniform float uDecay;
uniform float uRotation;
uniform vec2 uDrift;
uniform float uDelta;
${GLSL_HISTORY}

/** Frames a second the strength constant is tuned against. */
const float REFERENCE_RATE = 60.0;

vec2 warp(vec2 uv, float mode, float strength) {
    vec2 centered = uv - 0.5;
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

    return centered + 0.5;
}

void main() {
    // uStrength describes what one frame does, so it is corrected for the frame this actually is.
    // Without it the same scene drifted at different rates on different hardware. Decay is no longer
    // corrected here: it is a per-second figure that history() raises to the frame's own delta.
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

    // Attenuated and bounded, through the one helper every historical read uses. uDecay is the
    // fraction surviving a second, so a trail is a duration rather than a frame count.
    float survival = uDelta > 0.0 ? pow(clamp(uDecay, 0.0, 1.0), uDelta) : 1.0;
    vec4 previous = history(uHistory, sampleUv, uDecay, uDelta);
    vec4 incoming = texture(uSource, vUv);

    // A leaky integrator, not a screen. Screen combines each channel toward one independently and
    // has no fixed point, so any pixel receiving repeated contribution climbs to white and the
    // channels saturate in the order they started — which is the wash with a colour cast ADR-0007
    // recorded on a real device and fixed for the kernel's own accumulation. This loop had the same
    // combine: a source at 0.3 against a survival of 0.97 settles at 0.935.
    //
    // Survival and injection are complements here too, so a static image converges to exactly
    // itself and the trail comes from the warp — which is the whole subject of this plugin.
    fragColor = previous + incoming * (1.0 - survival);
}`;

export function createFeedbackFlowTransform(mode: FeedbackFlowMode = 'zoom'): VisualPluginDefinition {
    return {
        id: `FeedbackFlowTransform:${mode}`,
        version: 1,
        category: 'transformer',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            // Fed by a declared feedback edge from this plugin's own output.
            { name: 'history', type: 'color-texture', required: false },
            // Only the vector-field mode declares a field, so the other eight are not wired to one
            // they would ignore. Required, because without it this mode is a passthrough.
            ...(mode === 'vector-field'
                ? [{ name: 'field', type: 'vector-field' as const, required: true }]
                : []),
        ],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
        capabilities: ['feedback'],
        cost: { gpu: 1, cpu: 0, memory: 2, renderPasses: 1, qualityScalable: true, dominant: false },
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
        // `decay` is the fraction of a trail surviving one second. It was 0.94 per frame at sixty,
        // which is 0.024 over a second.
        parameters: { strength: 0.02, decay: 0.024, rotation: 0.15 },
        defaultBindings: [
            {
                // Bass drives large-scale expansion, per the section 20 mapping table.
                feature: 'bass',
                role: 'large-scale-force',
                parameter: 'strength',
                outputRange: [0.004, 0.05],
                attack: 0.08,
                release: 0.4,
                curve: 'smooth',
            },
            {
                // Trail length. Static, every scene smeared by exactly the same amount whatever the
                // music did, which is most of why the accumulation read as a fixed haze.
                feature: 'rms',
                role: 'intensity',
                parameter: 'decay',
                outputRange: [0.002, 0.4],
                attack: 0.25,
                release: 0.9,
                curve: 'smooth',
            },
            {
                // The angle the warp turns through. Only the rotate mode reads it, and it read a
                // constant.
                feature: 'mid',
                role: 'deformation',
                parameter: 'rotation',
                outputRange: [0.04, 0.55],
                attack: 0.3,
                release: 1,
                curve: 'smooth',
            },
        ],
        deactivationPolicy: 'handoff-feedback',

        create(context): VisualPluginInstance {
            let drift: [number, number] = [0, 0];

            return {
                initialize() {
                    context.registerShader({ id: SHADER_ID, vertex: QUAD_VERTEX_SHADER, fragment: FRAGMENT });
                },

                activate() {
                    const angle = context.seed * Math.PI * 2;
                    drift = [Math.cos(angle) * 0.01, Math.sin(angle) * 0.01];
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

                    return [{
                        kind: 'fullscreen',
                        shader: SHADER_ID,
                        inputs: {
                            uSource: source,
                            // Falls back to the incoming frame when no feedback edge is wired, so the
                            // plugin degrades to a passthrough rather than sampling nothing.
                            uHistory: render.previous.history ?? source,
                            ...(field ? { uField: field } : {}),
                        },
                        output: render.outputs.color,
                        blend: 'none',
                        clear: false,
                        uniforms: {
                            uMode: feedbackModeIndex(mode),
                            uStrength: 0.02,
                            uDecay: 0.024,
                            uRotation: 0.15,
                            uDrift: drift,
                        },
                    }];
                },

                deactivate() {
                    // Handoff: the accumulated image stays in the feedback buffer for a replacement.
                },

                destroy() {
                    drift = [0, 0];
                },
            };
        },
    };
}
