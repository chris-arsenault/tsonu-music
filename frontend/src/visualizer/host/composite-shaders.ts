/**
 * Kernel-owned composite shaders.
 *
 * These belong to the runtime rather than to any plugin, because section 11 makes layer order, blend
 * modes, and feedback injection the compositor's duties. They mirror `core/persistence.ts` exactly:
 * the arithmetic lives there so it can be tested without a GL context, and is written twice only
 * because one copy has to be GLSL.
 */

import { QUAD_VERTEX_SHADER } from './device';

/** Sums one field into the scene's motion field. Drawn once per contributing field, additively. */
export const MOTION_SUM_SHADER_ID = 'kernel-motion-sum';

export const MOTION_SUM_SHADER = {
    id: MOTION_SUM_SHADER_ID,
    vertex: QUAD_VERTEX_SHADER,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
/** Scales one contribution so a field with a large magnitude cannot dominate the sum outright. */
uniform float uWeight;

void main() {
    // rg carries the vector for every motion source type. A collision field's b channel is boundary
    // proximity, which is why only two channels are read here.
    vec2 field = texture(uSource, vUv).xy;

    // Fields are authored around unit magnitude but nothing enforces it, so a single wild contributor
    // is bounded before it joins the sum rather than after.
    float magnitude = length(field);
    if (magnitude > 2.0) {
        field *= 2.0 / magnitude;
    }

    fragColor = vec4(field * uWeight, 0.0, 1.0);
}`,
};

/**
 * Advances the accumulation buffer one frame.
 *
 * Drags the previous accumulation through the summed motion field, decays it, and screens this
 * frame's composited layers on top. This is the pass that makes an image move: a displacement applied
 * once to freshly generated material is a distortion, and the same displacement applied to what it
 * produced last frame, three hundred frames running, is flow.
 */
export const PERSISTENCE_SHADER_ID = 'kernel-persistence';

/**
 * Grades the accumulation onto the canvas. The last stage, and the only one that compresses.
 *
 * `ToneMapper` runs inside the graph, which puts it *before* the accumulation — so whatever it
 * carefully rolled off was then accumulated back into clipping and presented raw. Compression has to
 * be the final operation, after everything that can add light.
 *
 * It compresses luminance and rescales the colour by the same factor rather than compressing each
 * channel. Per-channel Reinhard pulls the brightest channel down hardest, which desaturates exactly
 * the material that was most saturated: bold colour becomes pastel and then white. Holding the ratio
 * between channels is what keeps a deep hue deep as it brightens.
 */
export const GRADE_SHADER_ID = 'kernel-grade';

export const GRADE_SHADER = {
    id: GRADE_SHADER_ID,
    vertex: QUAD_VERTEX_SHADER,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uGamma;
/** Above one, pushes colour away from grey before compression. */
uniform float uSaturation;

float luminance(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float dither(vec2 position) {
    return fract(sin(dot(position, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
    vec3 colour = max(texture(uSource, vUv).rgb, vec3(0.0)) * uExposure;

    float light = luminance(colour);
    colour = mix(vec3(light), colour, uSaturation);
    light = max(luminance(colour), 1e-5);

    // Reinhard on luminance alone, applied to the colour as a scalar, so hue and saturation survive
    // the roll-off instead of being flattened by it.
    colour *= (light / (1.0 + light)) / light;

    colour = pow(clamp(colour, 0.0, 1.0), vec3(1.0 / uGamma));
    colour += (dither(vUv * uResolution) - 0.5) * 0.004;

    fragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
}`,
};

export const PERSISTENCE_SHADER = {
    id: PERSISTENCE_SHADER_ID,
    vertex: QUAD_VERTEX_SHADER,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uComposite;
uniform sampler2D uHistory;
uniform sampler2D uMotion;
uniform vec2 uResolution;
/** Fraction of the accumulation surviving this frame, from frameSurvival(). */
uniform float uSurvival;
/** UV per second per unit of field magnitude, from persistenceSettings(). */
uniform float uMotionScale;
uniform float uDelta;
/** Zero when the scene produced no motion field, which leaves the drag out entirely. */
uniform float uHasMotion;
/** Share of this frame's composite entering the accumulation, from injectionFor(). */
uniform float uInjection;
/** Subtracted each frame so an abandoned trail reaches true black, from BLACK_FLOOR. */
uniform float uBlackFloor;

void main() {
    vec2 field = uHasMotion > 0.5 ? texture(uMotion, vUv).xy : vec2(0.0);

    // gatherOffset(): read from behind along the field, so material travels forward along it.
    vec2 offset = -field * uMotionScale * uDelta;
    vec2 source = clamp(vUv + offset, 0.0, 1.0);

    vec4 history = texture(uHistory, source);
    vec4 incoming = texture(uComposite, vUv);

    // accumulate(): a leaky integrator. Survival and injection sum to one, so a static image
    // converges to exactly itself and the trail comes from the warp rather than from a build-up.
    vec3 kept = max(history.rgb * uSurvival - uBlackFloor, vec3(0.0));

    fragColor = vec4(
        kept + incoming.rgb * uInjection,
        max(incoming.a, history.a * uSurvival)
    );
}`,
};
