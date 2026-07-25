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

void main() {
    vec2 field = uHasMotion > 0.5 ? texture(uMotion, vUv).xy : vec2(0.0);

    // gatherOffset(): read from behind along the field, so material travels forward along it.
    vec2 offset = -field * uMotionScale * uDelta;
    vec2 source = clamp(vUv + offset, 0.0, 1.0);

    vec4 history = texture(uHistory, source) * uSurvival;
    vec4 incoming = texture(uComposite, vUv);

    // accumulate(): screen, so a bright trail crossing bright new material rolls off toward white
    // rather than clipping there and staying.
    fragColor = vec4(
        1.0 - (1.0 - incoming.rgb) * (1.0 - history.rgb),
        max(incoming.a, history.a)
    );
}`,
};
