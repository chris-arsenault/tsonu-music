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
        parameters: { exposure: 1.1, gamma: 2.2, blackLevel: 0.002, grain: 0.006 },
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
                            uGamma: 2.2,
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

/** Presentation shader: draws a resource to the canvas at a given opacity. */
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
uniform float uTime;
uniform float uEnergy;
uniform float uBass;
uniform float uCentroid;
uniform float uLayerPhase;
uniform float uChromatic;

float luminance(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

vec3 breathingPalette(float phase) {
    vec3 base = 0.5 + 0.5 * cos(6.2831853 * (phase + vec3(0.00, 0.34, 0.68)));
    // Squared, which widens the gap between the leading channel and the other two. A raw cosine
    // palette sits around half scale in every channel at once, which is the definition of pastel.
    return base * base;
}

void main() {
    vec4 source = texture(uSource, vUv);
    vec3 color = source.rgb;
    float high = max(color.r, max(color.g, color.b));
    float low = min(color.r, min(color.g, color.b));
    float saturation = high - low;
    float light = luminance(color);

    // Geometry and simulation views often carry useful structure as monochrome intensity. Give that
    // material a living palette at the composition boundary, while preserving already-coloured album
    // art and source shaders. Each layer receives a different phase so parallel branches do not pulse
    // as one flat sheet.
    float palettePhase = fract(
        light * 0.42
        + uCentroid * 0.24
        + uBass * 0.08
        + uTime * (0.012 + uEnergy * 0.01)
        + uLayerPhase
    );
    vec3 palette = breathingPalette(palettePhase);
    float monochrome = (1.0 - smoothstep(0.035, 0.20, saturation)) * uChromatic;
    // Brightness rides on a floor rather than scaling the palette by luminance outright. Multiplying
    // a palette by a luminance near one pushes its leading channel past one, which clips and drags
    // the colour back toward white — the palette was being erased by the thing meant to apply it.
    color = mix(color, palette * (0.28 + light * 0.85), monochrome * 0.92);

    float breath = 0.88
        + 0.10 * sin(uTime * (0.55 + uBass * 0.4) + uLayerPhase * 6.2831853)
        + uEnergy * 0.18;
    color *= mix(1.0, breath, uChromatic);

    fragColor = vec4(color, source.a) * uOpacity;
}`,
};
