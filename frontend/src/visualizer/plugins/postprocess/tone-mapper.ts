/**
 * `ToneMapper` (spec section 19.9) — the final output stage, normally active.
 *
 * Half-float targets accumulate values above 1, especially through additive feedback, so something
 * has to compress the highlights before presentation. Without it a bright scene clips to flat white.
 */

import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import type { RenderPass } from '../../core/passes';
import { QUAD_VERTEX_SHADER } from '../../host/device';

const SHADER_ID = 'tone-mapper';

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uGamma;
uniform float uBlackLevel;
uniform float uGrain;

// Ordered dithering, breaking up the banding that 8-bit output would otherwise show in gradients.
float dither(vec2 position) {
    return fract(sin(dot(position, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
    vec4 source = texture(uSource, vUv);
    vec3 color = max(vec3(0.0), source.rgb - uBlackLevel) * uExposure;

    // Reinhard-style compression: rolls highlights off instead of clipping them.
    color = color / (1.0 + color);
    color = pow(color, vec3(1.0 / uGamma));
    color += (dither(vUv * uResolution) - 0.5) * uGrain;

    fragColor = vec4(clamp(color, 0.0, 1.0), source.a);
}`;

export function createToneMapper(): VisualPluginDefinition {
    return {
        id: 'ToneMapper',
        version: 1,
        category: 'postprocess',
        inputs: [{ name: 'source', type: 'color-texture', required: true }],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
        capabilities: ['tone-mapping', 'output-conversion'],
        cost: { gpu: 1, cpu: 0, memory: 1, renderPasses: 1, qualityScalable: false, dominant: false },
        character: {
            visualDensity: 0,
            motionEnergy: 0,
            geometricOrder: 0.5,
            recognizability: 0,
            persistence: 0,
            brightness: 0.5,
            dominance: 'supporting',
        },
        // Weighted high because a scene without it looks broken rather than merely different.
        activationRules: { activationWeight: 10 },
        // Gamma is neutral: the kernel's grade is the final stage and owns the output transfer. Two
        // transfer curves in series lifted near-black to mid-grey and washed the whole frame out.
        parameters: { exposure: 1.1, gamma: 1, blackLevel: 0.002, grain: 0.006 },
        deactivationPolicy: 'immediate',

        create(context): VisualPluginInstance {
            return {
                initialize() {
                    context.registerShader({ id: SHADER_ID, vertex: QUAD_VERTEX_SHADER, fragment: FRAGMENT });
                },

                activate() {
                    // Nothing to initialize: output conversion is stateless.
                },

                update() {
                    // Stateless.
                },

                render(render): RenderPass[] {
                    const source = render.inputs.source;
                    if (!source) {
                        return [];
                    }

                    return [{
                        kind: 'fullscreen',
                        shader: SHADER_ID,
                        inputs: { uSource: source },
                        output: render.outputs.color,
                        blend: 'none',
                        clear: true,
                        uniforms: {
                            uExposure: 1.1,
                            uGamma: 1,
                            uBlackLevel: 0.002,
                            uGrain: 0.006,
                        },
                    }];
                },

                deactivate() {
                    // Nothing retained.
                },

                destroy() {
                    // Nothing retained.
                },
            };
        },
    };
}

/**
 * Presentation shader: draws one layer into the composite through its branch colour.
 *
 * Each material branch is handed one entry of the scene's colour scheme as three stops, and the
 * layer's own luminance runs along them. That is the whole colour model.
 *
 * What it replaces: hue indexed by luminance, so every lit pixel in the scene was the same colour as
 * every other lit pixel of the same brightness; a per-pixel test for "is this monochrome" that split
 * the frame into two colour regimes disagreeing about where the boundary was; and a cosine ramp over
 * the entire hue circle, which contains every hue and therefore cannot give a scene one.
 */
export const PRESENT_SHADER_ID = 'present';

export const PRESENT_SHADER = {
    id: PRESENT_SHADER_ID,
    vertex: QUAD_VERTEX_SHADER,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uOpacity;
/** This branch's three stops, from the scene's colour scheme. */
uniform vec3 uShadow;
uniform vec3 uMid;
uniform vec3 uHighlight;
/** How far material is pulled toward its branch colour, against keeping its own. */
uniform float uTint;
/** Zero when the layer is presented raw, as when a single resource is being inspected. */
uniform float uChromatic;

float luminance(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
    vec4 source = texture(uSource, vUv);
    vec3 colour = source.rgb;
    float light = clamp(luminance(colour), 0.0, 1.0);

    // rampAt(): shadow through the branch hue to a warm highlight. Neither end is neutral, so the
    // hue survives into the darks and the lights instead of washing out at both.
    vec3 ramp = light < 0.5
        ? mix(uShadow, uMid, light * 2.0)
        : mix(uMid, uHighlight, (light - 0.5) * 2.0);

    // Scaled by the material's own luminance, so unlit pixels stay unlit rather than being painted
    // with the scheme — an empty pixel tinted is a coloured fog with no structure in it.
    ramp *= light;

    // Already-coloured material keeps its identity by being pulled toward the branch hue rather than
    // excluded from grading. Its own chroma decides how far it travels, which is a continuous
    // relationship instead of a threshold the material can cross mid-gradient.
    float high = max(colour.r, max(colour.g, colour.b));
    float low = min(colour.r, min(colour.g, colour.b));
    float chroma = high - low;
    float pull = uTint * (1.0 - smoothstep(0.05, 0.45, chroma) * 0.75);

    colour = mix(colour, ramp, clamp(pull, 0.0, 1.0) * uChromatic);

    fragColor = vec4(colour, source.a) * uOpacity;
}`,
};
