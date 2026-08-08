/**
 * Compositors and colour (spec section 19.9).
 *
 * These combine layers and shape final output. `PaletteMapper` and `ColorTransform` are what let a
 * scene take its colour from the album palette without any plugin knowing where the palette came from.
 */

import { character, defineShaderPlugin, GLSL_COMMON, GLSL_HISTORY } from '../define';
import type { VisualPluginDefinition } from '../../core/plugin';

const LAYER_MIXER_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uOverlay;
uniform vec2 uResolution;
uniform float uMode;
/**
 * How much of each operand reaches the combine (ADR-0013).
 *
 * These were one convex knob — mix(base, result, uMix) — which is why a mixer could not be the lossy
 * element of an accumulating loop: whatever it gave the overlay it took from the base, so the two
 * coefficients summed to one and the loop's steady state held exactly one copy of its source. Free of
 * each other, a loop closed through the source operand at 0.96 settles at twenty-five copies laid
 * along whatever path the cycle warps them through, and the overlay is free to arrive at full
 * strength rather than at the base's expense.
 */
uniform float uSourceWeight;
uniform float uOverlayWeight;
${GLSL_COMMON}

void main() {
    vec4 baseSample = texture(uSource, vUv);
    vec4 overSample = texture(uOverlay, vUv);

    // Weighted before the combine rather than after it, so each mode's own arithmetic is what scales:
    // add sums two attenuated operands, multiply multiplies them, lighten compares them. Applied to
    // the result instead, every mode would collapse to the same linear fade.
    vec3 base = baseSample.rgb * uSourceWeight;
    vec3 over = overSample.rgb * uOverlayWeight;
    vec3 result;

    if (uMode < 0.5) {                       // normal
        // Alpha is coverage and weight is intensity, so the mask comes from the unweighted sample.
        result = mix(base, over, overSample.a);
    } else if (uMode < 1.5) {                // add
        result = base + over;
    } else if (uMode < 2.5) {                // screen
        result = 1.0 - (1.0 - base) * (1.0 - over);
    } else if (uMode < 3.5) {                // multiply
        result = base * over;
    } else if (uMode < 4.5) {                // difference
        result = abs(base - over);
    } else if (uMode < 5.5) {                // lighten
        result = max(base, over);
    } else if (uMode < 6.5) {                // darken
        result = min(base, over);
    } else {                                 // contrast blend
        result = mix(base, over, smoothstep(0.2, 0.8, luminance(over)));
    }

    fragColor = vec4(result, max(baseSample.a, overSample.a));
}`;

const MASK_ROUTER_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uMask;
/** The second operand for the set operations. Bound only by the modes that need it. */
uniform sampler2D uOther;
uniform vec2 uResolution;
uniform float uMode;
uniform float uFeather;
uniform float uThreshold;
${GLSL_COMMON}

void main() {
    vec4 source = texture(uSource, vUv);
    float mask = texture(uMask, vUv).r;
    float weight;

    if (uMode < 0.5) {                       // apply
        weight = mask;
    } else if (uMode < 1.5) {                // invert
        weight = 1.0 - mask;
    } else if (uMode < 2.5) {                // threshold
        weight = step(uThreshold, mask);
    } else if (uMode < 3.5) {                // feather
        weight = smoothstep(uThreshold - uFeather, uThreshold + uFeather, mask);
    } else if (uMode < 4.5) {                // edge only
        weight = 1.0 - smoothstep(0.0, uFeather * 4.0, abs(mask - uThreshold));
    } else if (uMode < 5.5) {                // distance falloff
        weight = pow(clamp(mask, 0.0, 1.0), 2.2);
    } else if (uMode < 6.5) {                // union
        weight = max(mask, texture(uOther, vUv).r);
    } else if (uMode < 7.5) {                // intersection
        weight = min(mask, texture(uOther, vUv).r);
    } else {                                 // subtraction
        weight = clamp(mask - texture(uOther, vUv).r, 0.0, 1.0);
    }

    fragColor = source * weight;
}`;

const FEEDBACK_INJECTOR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uHistory;
uniform vec2 uResolution;
uniform float uMode;
uniform float uAmount;
uniform float uDecay;
uniform float uDelta;
${GLSL_COMMON}
${GLSL_HISTORY}

void main() {
    vec4 incoming = texture(uSource, vUv);
    // uDecay is the fraction surviving one second, so a trail is a duration whatever rate the
    // display runs at, and the read is bounded. See GLSL_HISTORY and ADR-0012.
    vec4 previous = history(uHistory, vUv, uDecay, uDelta);
    float weight = uAmount;

    if (uMode < 0.5) {                       // continuous
        weight = uAmount;
    } else if (uMode < 1.5) {                // event driven
        weight = uAmount * step(0.15, luminance(incoming.rgb));
    } else if (uMode < 2.5) {                // edge only
        vec2 texel = 1.0 / uResolution;
        float centre = luminance(incoming.rgb);
        float neighbour = luminance(texture(uSource, vUv + texel).rgb);
        weight = uAmount * clamp(abs(centre - neighbour) * 8.0, 0.0, 1.0);
    } else if (uMode < 3.5) {                // masked by luminance
        weight = uAmount * luminance(incoming.rgb);
    } else if (uMode < 4.5) {                // decaying
        weight = uAmount * 0.5;
    } else {                                 // burst
        weight = uAmount * smoothstep(0.5, 1.0, luminance(incoming.rgb));
    }

    fragColor = previous + incoming * weight;
}`;

const PALETTE_MAPPER_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uPalette;
uniform vec2 uResolution;
uniform float uStrength;
uniform float uOffset;
${GLSL_COMMON}

void main() {
    vec4 source = texture(uSource, vUv);
    // Luminance indexes the palette strip, so structure survives while colour is replaced.
    float index = fract(luminance(source.rgb) + uOffset);
    vec3 mapped = texture(uPalette, vec2(index, 0.5)).rgb;

    fragColor = vec4(mix(source.rgb, mapped, uStrength), source.a);
}`;

const COLOR_TRANSFORM_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uMode;
uniform float uAmount;
${GLSL_COMMON}

vec3 hueRotate(vec3 color, float angle) {
    const vec3 k = vec3(0.57735);
    float c = cos(angle);
    return color * c + cross(k, color) * sin(angle) + k * dot(k, color) * (1.0 - c);
}

void main() {
    vec4 source = texture(uSource, vUv);
    vec3 c = source.rgb;
    float l = luminance(c);

    if (uMode < 0.5) {                       // hue rotation
        c = hueRotate(c, uAmount * 6.2831853);
    } else if (uMode < 1.5) {                // saturation shaping
        c = mix(vec3(l), c, 1.0 + uAmount);
    } else if (uMode < 2.5) {                // contrast
        c = clamp((c - 0.5) * (1.0 + uAmount) + 0.5, 0.0, 1.0);
    } else if (uMode < 3.5) {                // solarization
        c = mix(c, 1.0 - abs(1.0 - 2.0 * c), uAmount);
    } else if (uMode < 4.5) {                // inversion
        c = mix(c, 1.0 - c, uAmount);
    } else if (uMode < 5.5) {                // channel permutation
        c = mix(c, vec3(c.b, c.r, c.g), uAmount);
    } else if (uMode < 6.5) {                // duotone
        c = mix(c, mix(vec3(0.1, 0.12, 0.2), vec3(0.95, 0.85, 0.6), l), uAmount);
    } else if (uMode < 7.5) {                // palette quantization
        float steps = mix(32.0, 4.0, clamp(uAmount, 0.0, 1.0));
        c = floor(c * steps) / steps;
    } else {                                 // luminance isolation
        c = mix(c, vec3(l), uAmount);
    }

    fragColor = vec4(c, source.a);
}`;

const GLOW_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uMode;
uniform float uAmount;
uniform float uThreshold;
${GLSL_COMMON}

void main() {
    vec4 source = texture(uSource, vUv);
    vec2 texel = 1.0 / uResolution;
    vec3 accumulated = vec3(0.0);
    float weight = 0.0;

    // 12 taps along a direction set by the mode: cheap enough to keep as one pass.
    for (int i = 1; i <= 12; i += 1) {
        float step_size = float(i);
        vec2 direction;

        if (uMode < 0.5) {                   // soft bloom
            direction = vec2(cos(step_size), sin(step_size));
        } else if (uMode < 1.5) {            // directional streak
            direction = vec2(1.0, 0.0);
        } else if (uMode < 2.5) {            // radial scatter
            direction = normalize(vUv - 0.5 + 1e-5);
        } else if (uMode < 3.5) {            // edge glow
            direction = vec2(cos(step_size * 2.0), sin(step_size * 2.0));
        } else {                             // anamorphic smear
            direction = vec2(1.0, 0.08);
        }

        float falloff = 1.0 / step_size;
        vec3 tap = texture(uSource, clamp(vUv + direction * texel * step_size * 3.0, 0.0, 1.0)).rgb;
        // Only bright material blooms, so mid-tones do not turn to fog.
        accumulated += max(vec3(0.0), tap - uThreshold) * falloff;
        weight += falloff;
    }

    vec3 glow = weight > 0.0 ? accumulated / weight : vec3(0.0);
    fragColor = vec4(source.rgb + glow * uAmount, source.a);
}`;

/**
 * The direction light is being thrown, published as a field (ADR-0012).
 *
 * Each mode already chooses a direction to gather along — a streak runs horizontally, an anamorphic
 * smear almost so, a radial scatter runs outward from the centre. That direction is a displacement
 * of light, and the same choice that decides where the bloom goes can decide where the image
 * beneath it is carried.
 *
 * Scaled by how much there is to bloom. A dark region has no light to throw, so it publishes
 * nothing rather than a direction with no brightness behind it — otherwise the whole frame would be
 * dragged uniformly by a stage that only lit a corner of it.
 */
const GLOW_MOTION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uMode;
uniform float uAmount;
uniform float uThreshold;
${GLSL_COMMON}

void main() {
    vec2 direction;

    if (uMode < 0.5) {                       // soft bloom scatters evenly: no net direction
        direction = vec2(0.0);
    } else if (uMode < 1.5) {                // directional streak
        direction = vec2(1.0, 0.0);
    } else if (uMode < 2.5) {                // radial scatter
        direction = normalize(vUv - 0.5 + 1e-5);
    } else if (uMode < 3.5) {                // edge glow scatters evenly too
        direction = vec2(0.0);
    } else {                                 // anamorphic smear
        direction = normalize(vec2(1.0, 0.08));
    }

    float lit = max(0.0, luminance(texture(uSource, vUv).rgb) - uThreshold);
    vec2 field = direction * lit * uAmount;

    fragColor = vec4(clamp(field, vec2(-2.0), vec2(2.0)), length(field), 1.0);
}`;

/**
 * Couples visible material to a spatial force field.
 *
 * Several earlier plugins could generate sophisticated fields, but nothing was guaranteed to show
 * them: they were often orphaned or used only to push a sparse particle set. This pass integrates the
 * field through image space, uses it to warp the source, and derives coloured flow lines from the same
 * samples. The source, force, colour, and audio-bound parameters therefore evolve as one system.
 */
const FLOW_FIELD_COMPOSITOR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uTime;
uniform float uPhase;
uniform float uAmount;
uniform float uHue;
uniform float uBreath;
${GLSL_COMMON}

vec3 flowPalette(float phase) {
    return 0.52 + 0.48 * cos(6.2831853 * (phase + vec3(0.00, 0.31, 0.67)));
}

void main() {
    vec2 p = vUv;
    vec2 accumulated = vec2(0.0);
    float curvature = 0.0;
    float previousAngle = 0.0;

    // Trace through the field rather than sampling it once. Local changes compound into folds and
    // eddies, which is the chaotic interaction missing from a one-direction displacement.
    for (int step = 0; step < 9; step += 1) {
        vec2 force = texture(uField, clamp(p, 0.0, 1.0)).xy;
        float forceLength = length(force);
        vec2 direction = forceLength > 0.0001 ? force / forceLength : vec2(0.0);
        float angle = atan(direction.y, direction.x);
        if (step > 0) {
            curvature += abs(sin(angle - previousAngle));
        }
        previousAngle = angle;
        accumulated += direction * min(forceLength, 2.5);
        p = fract(p - direction * (0.007 + 0.002 * float(step)) * uAmount);
    }

    vec4 source = texture(uSource, p);
    float flow = length(accumulated) / 9.0;
    float ribbons = 0.5 + 0.5 * sin(
        dot(vUv + accumulated * 0.018, vec2(73.0, 51.0))
        + curvature * 2.6
        - uTime * (0.45 + uBreath * 0.35)
        + uPhase
    );
    ribbons = pow(ribbons, 5.0);

    float pulse = 0.82 + 0.18 * sin(uTime * 0.7 + uPhase) + uBreath * 0.28;
    float paletteIndex = fract(
        uHue
        + luminance(source.rgb) * 0.38
        + flow * 0.22
        + curvature * 0.08
        + uTime * 0.018
    );
    vec3 palette = flowPalette(paletteIndex);
    vec3 colouredSource = mix(source.rgb, palette * (0.35 + luminance(source.rgb)), 0.68);
    vec3 colour = colouredSource * pulse + palette * ribbons * (0.28 + flow * 0.35);

    fragColor = vec4(colour, max(source.a, clamp(ribbons + flow * 0.2, 0.0, 1.0)));
}`;

/**
 * The flow this compositor traced, which is not the field it read (ADR-0012).
 *
 * I first excluded this as a re-publish. It is not: the colour pass walks nine steps through the
 * field, accumulating direction as it goes, and the sum of a path is a different quantity from the
 * vector at its start. Where the field is locally chaotic the accumulated direction is small because
 * the steps cancel; where it is coherent the accumulation runs long. That distinction is exactly
 * what makes an eddy read as an eddy, and nothing else in the graph computes it.
 */
const FLOW_FIELD_MOTION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uTime;
uniform float uPhase;
uniform float uAmount;
uniform float uHue;
uniform float uBreath;
${GLSL_COMMON}

void main() {
    vec2 p = vUv;
    vec2 accumulated = vec2(0.0);

    // The same nine-step trace the colour pass runs, keeping the path rather than the shading.
    for (int step = 0; step < 9; step += 1) {
        vec2 force = texture(uField, clamp(p, 0.0, 1.0)).xy;
        float forceLength = length(force);
        vec2 direction = forceLength > 0.0001 ? force / forceLength : vec2(0.0);
        accumulated += direction * min(forceLength, 2.5);
        p = fract(p - direction * (0.007 + 0.002 * float(step)) * uAmount);
    }

    vec2 field = accumulated / 9.0;

    fragColor = vec4(clamp(field, vec2(-2.0), vec2(2.0)), length(field), 1.0);
}`;

export const LAYER_MIXER_MODES = [
    'normal', 'add', 'screen', 'multiply', 'difference', 'lighten', 'darken', 'contrast',
] as const;

/**
 * Section 19.9's nine operations. Union, intersection, and subtraction were missing, which is what
 * kept masks from composing with one another — they could each route an effect, but not combine.
 * Appended rather than inserted in the specification's order so the existing modes keep their index.
 */
export const MASK_ROUTER_MODES = [
    'apply', 'invert', 'threshold', 'feather', 'edge-only', 'distance-falloff',
    'union', 'intersection', 'subtraction',
] as const;

/** Operations taking a second mask. The other six read one and ignore the port entirely. */
export const MASK_SET_OPERATIONS: readonly typeof MASK_ROUTER_MODES[number][] = [
    'union',
    'intersection',
    'subtraction',
];

export const FEEDBACK_INJECTOR_MODES = [
    'continuous', 'event-driven', 'edge-only', 'masked', 'decaying', 'burst',
] as const;

export const COLOR_TRANSFORM_MODES = [
    'hue-rotate', 'saturation', 'contrast', 'solarize', 'invert', 'permute', 'duotone', 'quantize', 'luminance',
] as const;

export const GLOW_MODES = [
    'soft-bloom', 'directional-streak', 'radial-scatter', 'edge-glow', 'anamorphic',
] as const;

export function createFlowFieldCompositor(): VisualPluginDefinition {
    return defineShaderPlugin({
        id: 'FlowFieldCompositor',
        category: 'compositor',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            { name: 'field', type: 'vector-field', required: true },
        ],
        outputs: [
            { name: 'color', type: 'color-texture' },
            // The traced path, not the field it was traced through.
            { name: 'motion', type: 'vector-field' },
        ],
        capabilities: ['field-composition', 'chromatic-output', 'layer-mixing', 'vector-field'],
        fragment: FLOW_FIELD_COMPOSITOR_FRAGMENT,
        motion: { port: 'motion', fragment: FLOW_FIELD_MOTION_FRAGMENT },
        uniforms: { uAmount: 1, uHue: 0.2, uBreath: 0.5 },
        parameters: { amount: 1, hue: 0.2, breath: 0.5 },
        bindings: [
            {
                feature: 'bass',
                parameter: 'amount',
                outputRange: [0.45, 2.1],
                attack: 0.12,
                release: 0.7,
                curve: 'smooth',
            },
            {
                feature: 'spectralCentroid',
                parameter: 'hue',
                outputRange: [0, 1],
                attack: 0.35,
                release: 1.1,
                curve: 'linear',
            },
            {
                feature: 'rms',
                parameter: 'breath',
                outputRange: [0.1, 1],
                attack: 0.08,
                release: 0.55,
                curve: 'sqrt',
            },
        ],
        character: character({
            visualDensity: 0.72,
            motionEnergy: 0.78,
            geometricOrder: 0.32,
            persistence: 0.45,
            brightness: 0.72,
            dominance: 'supporting',
        }),
        gpuCost: 2,
        activationWeight: 5,
        minimumDuration: 14,
        prefersWith: [
            'ProceduralVectorField:curl',
            'ProceduralVectorField:spiral',
            'ProceduralVectorField:turbulence',
            'ProceduralVectorField:domain-warp',
            'MaskBoundaryField',
        ],
    });
}

export function createLayerMixer(
    mode: typeof LAYER_MIXER_MODES[number] = 'screen',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `LayerMixer:${mode}`,
        category: 'compositor',
        inputs: [
            // The operand a loop is meant to close through, and the one carrying its gain. Under one,
            // so a cycle passing through here converges — see `core/loop-gain.ts`.
            {
                name: 'source',
                type: 'color-texture',
                required: true,
                gainParameter: 'sourceWeight',
            },
            // Fresh material joining what the base already holds. Free to exceed one, because a cycle
            // closed through this port is rejected rather than tuned around.
            {
                name: 'overlay',
                type: 'color-texture',
                required: true,
                gainParameter: 'overlayWeight',
            },
        ],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['layer-mixing', 'blend'],
        fragment: LAYER_MIXER_FRAGMENT,
        uniforms: {
            uMode: LAYER_MIXER_MODES.indexOf(mode),
            uSourceWeight: 0.94,
            uOverlayWeight: 1,
        },
        parameters: { sourceWeight: 0.94, overlayWeight: 1 },
        bindings: [{
            // How long what is already in the base survives being combined with. This is the whole
            // trail: at 0.96 a cycle through this port settles at twenty-five copies of its source,
            // at 0.55 at barely two. Bound low enough that the music decides how far the image
            // remembers rather than a constant deciding it once.
            feature: 'lowMid',
            role: 'deformation',
            parameter: 'sourceWeight',
            outputRange: [0.55, 0.96],
            attack: 0.35,
            release: 1.4,
            curve: 'smooth',
        }, {
            // How hard new material arrives. A mixer pinned at full is a fixed composite however much
            // its two branches move.
            feature: 'rms',
            role: 'intensity',
            parameter: 'overlayWeight',
            outputRange: [0.45, 1.15],
            attack: 0.15,
            release: 0.6,
            curve: 'smooth',
        }],
        character: character({ visualDensity: 0.5, geometricOrder: 0.5, dominance: 'supporting' }),
        // Modes that can only add light are drawn less often than the rest.
        //
        // All eight were equally weighted, so half of every scene's mixers brightened by
        // construction — and mixers chain, so two or three of them compound. Branches were joined by
        // repeatedly making the frame lighter until it was white, which is the additive pile that
        // gets reported as washout. Not removed: screen and add are the right join for sparks over a
        // dark field. Just no longer the coin-flip default.
        activationWeight: BRIGHTENING_MIXER_MODES.includes(mode) ? 1.5 : 3.5,
    });
}

/** Mixer modes whose output is never darker than the brighter of their two inputs. */
const BRIGHTENING_MIXER_MODES: readonly typeof LAYER_MIXER_MODES[number][] = [
    'add', 'screen', 'lighten',
];

export function createMaskRouter(
    mode: typeof MASK_ROUTER_MODES[number] = 'feather',
): VisualPluginDefinition {
    const combines = MASK_SET_OPERATIONS.includes(mode);

    return defineShaderPlugin({
        id: `MaskRouter:${mode}`,
        category: 'compositor',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            { name: 'mask', type: 'mask-texture', required: true },
            // Declared only by the modes that read it, so the other six are not wired to a second
            // mask they would ignore. Wiring reserves distinct producers per port type, so the two
            // operands resolve to different masks rather than to the same one twice.
            ...(combines
                ? [{ name: 'other', type: 'mask-texture' as const, required: true }]
                : []),
        ],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: combines ? ['mask-routing', 'mask-composition'] : ['mask-routing'],
        fragment: MASK_ROUTER_FRAGMENT,
        uniforms: { uMode: MASK_ROUTER_MODES.indexOf(mode) },
        parameters: { feather: 0.08, threshold: 0.5 },
        bindings: [
            {
                feature: 'trebleExcite',
                role: 'detail',
                parameter: 'feather',
                outputRange: [0.03, 0.18],
                attack: 0.05,
                release: 0.4,
                curve: 'sqrt',
            },
        {
            // Where the mask cuts. Moving it is what makes a routed effect breathe with the music
            // instead of holding one fixed silhouette.
            feature: 'mid',
            role: 'deformation',
            parameter: 'threshold',
            outputRange: [0.35, 0.66],
            attack: 0.15,
            release: 0.6,
            curve: 'smooth',
        }],
        character: character({ visualDensity: 0.4, geometricOrder: 0.7, dominance: 'supporting' }),
        activationWeight: 1,
    });
}

export function createFeedbackInjector(
    mode: typeof FEEDBACK_INJECTOR_MODES[number] = 'continuous',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `FeedbackInjector:${mode}`,
        category: 'compositor',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            { name: 'history', type: 'color-texture', required: false },
        ],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['feedback'],
        fragment: FEEDBACK_INJECTOR_FRAGMENT,
        uniforms: { uMode: FEEDBACK_INJECTOR_MODES.indexOf(mode), uAmount: 0.6, uDecay: 0.12 },
        parameters: { amount: 0.6, decay: 0.12 },
        bindings: [{
            feature: 'lowMid',
            role: 'deformation',
            // Per second now, not per frame at sixty. The old [0.88, 0.98] was a survival of
            // 0.0005 to 0.30 over a second once the exponent was applied.
            parameter: 'decay',
            outputRange: [0.02, 0.35],
            attack: 0.3,
            release: 1,
            curve: 'smooth',
        }, {
            feature: 'rms',
            role: 'intensity',
            parameter: 'amount',
            outputRange: [0.25, 0.85],
            attack: 0.1,
            release: 0.5,
            curve: 'smooth',
        }],
        character: character({ persistence: 0.95, visualDensity: 0.6, dominance: 'supporting' }),
        feedbackPort: 'history',
        // Accumulating into the target is the point, so it must not be cleared.
        clear: false,
        memoryCost: 2,
        deactivationPolicy: 'handoff-feedback',
        activationWeight: 1.2,
    });
}

export function createPaletteMapper(): VisualPluginDefinition {
    return defineShaderPlugin({
        id: 'PaletteMapper',
        category: 'postprocess',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            { name: 'palette', type: 'palette', required: true },
        ],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['palette-mapping'],
        fragment: PALETTE_MAPPER_FRAGMENT,
        uniforms: { uStrength: 0.8, uOffset: 0 },
        parameters: { strength: 0.8, offset: 0 },
        bindings: [
            {
                feature: 'rms',
                role: 'intensity',
                parameter: 'strength',
                outputRange: [0.55, 1],
                attack: 0.2,
                release: 0.8,
                curve: 'smooth',
            },
        {
            // Centroid moves the palette, per the section 20 mapping table.
            feature: 'spectralCentroid',
            parameter: 'offset',
            outputRange: [0, 0.35],
            attack: 0.3,
            release: 0.8,
            curve: 'linear',
        }],
        character: character({ visualDensity: 0, brightness: 0.6, dominance: 'supporting' }),
        activationWeight: 2.5,
        // Named so the pairing works in both directions: a palette producer makes this far more
        // likely, and this makes a producer far more likely. Its `palette` input is required, so
        // without a producer already chosen it is not selectable at all — and until `ProceduralPalette`
        // existed the only producer needed album artwork, which left the catalog's one palette-mapping
        // stage unreachable on any track without it.
        prefersWith: ['ProceduralPalette', 'AlbumArtPalette'],
    });
}

export function createColorTransform(
    mode: typeof COLOR_TRANSFORM_MODES[number] = 'saturation',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `ColorTransform:${mode}`,
        category: 'postprocess',
        inputs: [{ name: 'source', type: 'color-texture', required: true }],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['colour-transform'],
        fragment: COLOR_TRANSFORM_FRAGMENT,
        uniforms: { uMode: COLOR_TRANSFORM_MODES.indexOf(mode), uAmount: 0.4 },
        parameters: { amount: 0.4 },
        bindings: [{
            feature: 'highMid',
            parameter: 'amount',
            outputRange: [0.1, 0.8],
            attack: 0.15,
            release: 0.6,
            curve: 'smooth',
        }],
        character: character({ visualDensity: 0, brightness: 0.55, dominance: 'supporting' }),
        activationWeight: 1,
    });
}

export function createGlowAndScatter(
    mode: typeof GLOW_MODES[number] = 'soft-bloom',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `GlowAndScatter:${mode}`,
        category: 'postprocess',
        inputs: [{ name: 'source', type: 'color-texture', required: true }],
        outputs: [
            { name: 'color', type: 'color-texture' },
            { name: 'motion', type: 'vector-field' },
        ],
        // Optional secondary post-processing: the performance ladder gives this up at level five.
        capabilities: ['glow', 'secondary-postprocess', 'vector-field'],
        fragment: GLOW_FRAGMENT,
        motion: { port: 'motion', fragment: GLOW_MOTION_FRAGMENT },
        uniforms: { uMode: GLOW_MODES.indexOf(mode), uAmount: 0.8, uThreshold: 0.55 },
        parameters: { amount: 0.8, threshold: 0.55 },
        bindings: [
            {
                // Section 20 puts onsets on bursts. Tracking `peak` continuously kept the bloom at a
                // near-constant level on compressed material; an envelope fired by the detected onset
                // gives it the transient shape the table asks for.
                feature: 'onset',
                role: 'burst',
                mode: 'impulse',
                parameter: 'amount',
                outputRange: [0.3, 1.6],
                attack: 0.015,
                release: 0.32,
                curve: 'sqrt',
            },
            {
                feature: 'trebleExcite',
                role: 'detail',
                parameter: 'threshold',
                outputRange: [0.62, 0.34],
                attack: 0.08,
                release: 0.5,
                curve: 'smooth',
            },
        ],
        character: character({ brightness: 0.85, visualDensity: 0.3, dominance: 'supporting' }),
        gpuCost: 2,
        activationWeight: 1.2,
    });
}
