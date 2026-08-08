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
 * Both answer the same question — where does this pixel read its history from — and one of them then
 * samples while the other reports the displacement. Sharing the function is what stops them drifting
 * apart, which two copies of nine branches would guarantee eventually.
 */
const WARP_BODY = `
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
}`;

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
/** How hard this frame's material enters the loop. Independent of uDecay — see main(). */
uniform float uInject;
uniform float uRotation;
uniform vec2 uDrift;
uniform float uDelta;
${GLSL_HISTORY}

/** Frames a second the strength constant is tuned against. */
const float REFERENCE_RATE = 60.0;

${WARP_BODY}

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
    vec4 previous = history(uHistory, sampleUv, uDecay, uDelta);
    vec4 incoming = texture(uSource, vUv);

    // New material is drawn *over* the trail, not added to it.
    //
    // Two combines came before this one and both were wrong in the same place — the choice of
    // operator, which neither of them examined.
    //
    // The first was convex: incoming times one-minus-survival, so the two coefficients summed to one.
    // The weights of a convex blend sum to one however many frames it runs, so the steady state held
    // exactly one copy of the source, warped into a smear and no further. A motion blur, from the
    // part of the catalog most obviously meant to make tunnels.
    //
    // The second freed the coefficient and kept the sum, which converges to
    // incoming / (1 - perFrameSurvival) — at a survival of 0.4 per second and an injection of 0.5,
    // thirty-three copies. The grade can pull down about eight, so the frame went white. Measured on
    // the render harness: scenes either saturated or had memory too short to compound, and the band
    // between them is narrow, which is why so few looked like anything.
    //
    // The bound was then going to be a tuned ceiling on that steady state. It did not need to be: a
    // sum is only one operator, and it is the one operator here that is expansive. This composites
    // instead, so the output never exceeds the brighter of the two inputs — which means the trail can
    // last as long as uDecay says without the picture climbing anywhere at all. Memory length and
    // brightness stop being the same knob.
    //
    // Where new material lands the result is that material, so the loop has a fixed point rather than
    // a ramp. Where none lands the result is the decayed previous frame, sampled from a warped
    // coordinate, which is exactly the transport this family exists to produce.
    //
    // The particle trail injector and the temporal transform already close their loops this way,
    // with max and with mix. They were the two that could safely hold a long trail, and nothing in
    // the code said so.
    // Taken as the brighter of the two, not as a blend between them.
    //
    // Compositing fixed the saturation and left a subtler version of the same mistake: a blend
    // toward the incoming frame spends the history to make room for it. At an injection of 0.57
    // against a source that fills the frame, 57 percent of the trail is replaced every frame — a
    // time constant of twenty milliseconds, against the one-and-a-half seconds uDecay was set for.
    // Measured on the harness as correlation surviving about a second, and visible as memory that
    // exists where the source happens to be dark and is erased everywhere it is bright.
    //
    // Under max the two are independent. How long the trail lasts is uDecay and nothing else; how
    // brightly new material writes is uInject and nothing else; and the result still cannot exceed
    // the brighter input, so the bound survives. New material appears at full strength on the frame
    // it is drawn rather than fading in over several, and the trail behind it decays on its own
    // clock. That is the combine the particle trail injector has always used, which is the second
    // reason it was one of the two that could hold a long trail.
    fragColor = max(previous, incoming * uInject);
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
uniform sampler2D uHistory;
uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uMode;
uniform float uStrength;
uniform float uDecay;
uniform float uRotation;
uniform vec2 uDrift;
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
            // Fed by a historical edge, and the lossy element of whatever cycle that edge closes:
            // `decay` is the fraction of the trail surviving one second, so it is exactly the gain
            // `core/loop-gain.ts` multiplies around the loop (ADR-0013).
            {
                name: 'history',
                type: 'color-texture',
                required: false,
                gainParameter: 'decay',
            },
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
        capabilities: ['feedback', SPATIAL_FEEDBACK],
        // Two passes: the loop, and the affine it publishes.
        cost: { gpu: 1, cpu: 0, memory: 2, renderPasses: 2, qualityScalable: true, dominant: false },
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
        parameters: { strength: 0.02, decay: 0.5, inject: 0.5, rotation: 0.15 },
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
                // Trail length, as the fraction surviving one second. The ceiling was 0.4 — a time
                // constant of about a second — set while the combine was a sum, where a longer trail
                // meant a brighter frame and eventually a white one. Compositing decouples the two,
                // so this can reach the several seconds a compounding warp needs: 0.9 per second is a
                // time constant near ten, which is where a two percent per-frame displacement turns
                // into a tunnel rather than a smudge.
                feature: 'rms',
                role: 'intensity',
                parameter: 'decay',
                outputRange: [0.15, 0.9],
                attack: 0.25,
                release: 0.9,
                curve: 'smooth',
            },
            {
                // How brightly new material writes against the trail. It does not decide how long the
                // trail lasts — under max the two are independent, which is the whole point of the
                // operator. Near one so the present is not dimmer than its own history, which would
                // read as the scene being lit from the past.
                feature: 'rms',
                role: 'intensity',
                parameter: 'inject',
                outputRange: [0.7, 1.1],
                attack: 0.12,
                release: 0.5,
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
                    context.registerShader({
                        id: MOTION_SHADER_ID,
                        vertex: QUAD_VERTEX_SHADER,
                        fragment: MOTION_FRAGMENT,
                    });
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

                    const inputs = {
                        uSource: source,
                        // Falls back to the incoming frame when no feedback edge is wired, so the
                        // plugin degrades to a passthrough rather than sampling nothing.
                        uHistory: render.previous.history ?? source,
                        ...(field ? { uField: field } : {}),
                    };
                    const uniforms = {
                        uMode: feedbackModeIndex(mode),
                        uStrength: 0.02,
                        uDecay: 0.5,
                        uInject: 0.5,
                        uRotation: 0.15,
                        uDrift: drift,
                    };

                    const passes: RenderPass[] = [{
                        kind: 'fullscreen',
                        shader: SHADER_ID,
                        inputs,
                        output: render.outputs.color,
                        blend: 'none',
                        clear: false,
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
                    // Handoff: the accumulated image stays in the feedback buffer for a replacement.
                },

                destroy() {
                    drift = [0, 0];
                },
            };
        },
    };
}
