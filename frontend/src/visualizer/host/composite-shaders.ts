/**
 * Kernel-owned composite shaders.
 *
 * These belong to the runtime rather than to any plugin, because section 11 makes layer order, blend
 * modes, and feedback injection the compositor's duties. They mirror `core/persistence.ts` exactly:
 * the arithmetic lives there so it can be tested without a GL context, and is written twice only
 * because one copy has to be GLSL.
 */

import { QUAD_VERTEX_SHADER } from './device';

// A `MOTION_SUM_SHADER` stood here, summing every motion-typed resource in the graph into one
// kernel-owned field that the accumulation was then gathered through (ADR-0008). It is gone with the
// drag it fed. Summing every field a scene happened to contain was, among other things, a way of
// giving a field a consumer whether or not anything wired one — ADR-0008 said so, and recorded that
// closing it properly belonged to a structural predicate requiring a scene's fields to reach one.
// That predicate now exists, and a field reaches the picture by being wired to something that reads
// it, in the graph, where it can be seen.

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
/**
 * Metering: reduces the whole accumulation to one texel holding its average luminance.
 *
 * A fixed exposure cannot serve a catalog this varied. Measured across five consecutive scenes, mean
 * frame luminance ran from 3.7 to 160.7 of 255 — one scene nearly black with seven percent of the
 * frame lit, another saturated across all of it. Both were composed correctly; they simply contain
 * different amounts of material, and a constant multiplier has no way to know that.
 *
 * Averaged from a grid of taps rather than a mip chain, because generating mipmaps for a half-float
 * target is not portable, and blended with its own previous value so exposure drifts toward a scene
 * rather than snapping and pumping. One texel, sampled once per pixel by the grade — the whole thing
 * costs one small pass.
 */
export const METER_SHADER_ID = 'kernel-meter';

export const METER_SHADER = {
    id: METER_SHADER_ID,
    vertex: QUAD_VERTEX_SHADER,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uHistory;
uniform vec2 uResolution;
uniform float uDelta;
/** Seconds for the meter to travel most of the way to a new level. */
uniform float uAdaptSeconds;

const int TAPS = 12;

float luminance(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
    float total = 0.0;

    // A grid inset by half a step, so the taps sample cell centres and none lands on the border.
    for (int y = 0; y < TAPS; y += 1) {
        for (int x = 0; x < TAPS; x += 1) {
            vec2 uv = (vec2(float(x), float(y)) + 0.5) / float(TAPS);
            total += luminance(max(texture(uSource, uv).rgb, vec3(0.0)));
        }
    }

    float measured = total / float(TAPS * TAPS);
    float previous = texture(uHistory, vec2(0.5)).r;

    // Exponential approach, framerate independent. A first frame with no history starts at the
    // measurement rather than crawling up from zero and blowing the exposure out on the way.
    float rate = uAdaptSeconds <= 0.0 ? 1.0 : 1.0 - exp(-uDelta / uAdaptSeconds);
    float blended = previous <= 0.0 ? measured : mix(previous, measured, clamp(rate, 0.0, 1.0));

    fragColor = vec4(vec3(blended), 1.0);
}`,
};

export const GRADE_SHADER_ID = 'kernel-grade';

export const GRADE_SHADER = {
    id: GRADE_SHADER_ID,
    vertex: QUAD_VERTEX_SHADER,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
/** One texel holding the scene's smoothed average luminance. See METER_SHADER. */
uniform sampler2D uMeter;
uniform vec2 uResolution;
uniform float uExposure;
/** Above one, separates values either side of the pivot. Does not move overall brightness. */
uniform float uContrast;
/** Above one, pushes colour away from grey before compression. */
uniform float uSaturation;

float luminance(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float dither(vec2 position) {
    return fract(sin(dot(position, vec2(12.9898, 78.233))) * 43758.5453);
}

/** Luminance the contrast curve pivots about, so raising contrast does not also darken the frame. */
const float PIVOT = 0.42;

/** Below this, luminance passes through untouched; above it, the highlight roll-off takes over. */
const float KNEE = 0.72;

/** Average luminance the metered exposure aims the frame at. */
const float TARGET = 0.30;

/**
 * How far metering is allowed to move the exposure.
 *
 * Bounded above so a nearly empty scene reads as sparse rather than having its few lit pixels
 * amplified into noise. The lower bound is loose, because the thing it has to be able to correct is a
 * genuinely bright composite: several branches chained through mixers arrive at an average of about
 * three quarters of full scale, and reaching the target from there needs a gain near four tenths. At
 * a floor of 0.55 the meter simply could not get there — frames measured at 194 and 214 of 255 with
 * saturation collapsed to 0.13, which is the wash this whole stage exists to prevent, produced by the
 * one control that was supposed to prevent it.
 */
const float MIN_GAIN = 0.12;
const float MAX_GAIN = 6.0;

void main() {
    // Metered, then scaled by the bound exposure parameter. The meter sets the operating point and
    // the binding moves it around from there, which is what lets a transient lift the frame without
    // the frame's own average deciding how bright a scene is allowed to be.
    float average = max(texture(uMeter, vec2(0.5)).r, 1e-4);
    float gain = clamp(TARGET / average, MIN_GAIN, MAX_GAIN);

    vec3 colour = max(texture(uSource, vUv).rgb, vec3(0.0)) * uExposure * gain;

    float light = luminance(colour);
    colour = mix(vec3(light), colour, uSaturation);

    // Contrast about a pivot, which is what contrast means: differences either side of the pivot get
    // larger and the pivot itself does not move.
    //
    // This was pow(colour, uContrast), which is a darkening gamma wearing the name. With the
    // parameter above one it pulled every value down and pulled the darker ones down hardest, so
    // "more contrast" meant "dimmer, with less separation between neighbours" — the exact opposite of
    // the thing it is bound to bass to deliver.
    colour = PIVOT + (colour - PIVOT) * uContrast;

    // Roll off only what is actually above the knee.
    //
    // Reinhard across the whole range maps one to a half. That is correct for scene-referred input
    // running well past one, and wrong here: plugins write display-referred values, so the accumulation
    // sits mostly inside nought to one and the curve simply halved the picture. Measured through this
    // pass, mean luminance fell from 149 to 25 of 255 and neighbour-to-neighbour detail fell by more
    // than three times — a bright, detailed composite arriving at the canvas dim and smooth.
    //
    // Still applied to luminance and rescaled as a scalar, so a hue keeps its ratio between channels
    // through the roll-off rather than being flattened toward white by per-channel compression.
    light = max(luminance(colour), 1e-5);
    float rolled = light <= KNEE
        ? light
        : KNEE + (1.0 - KNEE) * ((light - KNEE) / (light - KNEE + (1.0 - KNEE)));

    colour *= rolled / light;
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
uniform vec2 uResolution;
/** Fraction of the accumulation surviving this frame, from frameSurvival(). */
uniform float uSurvival;
uniform float uDelta;
/** Share of this frame's composite entering the accumulation, from injectionFor(). */
uniform float uInjection;
/** Subtracted each frame so an abandoned trail reaches true black, from BLACK_FLOOR. */
uniform float uBlackFloor;

void main() {
    // No displacement here any more (ADR-0012). This pass gathered the accumulation from a point
    // offset along a summed field, which made translation the only thing that could ever happen to
    // the accumulated image: one verb, fixed in the kernel, in a subsystem whose premise is that
    // behaviour comes from composition. Displacement is a plugin now, and the position it occupies
    // accepts a blur, a threshold, a colour operation, or a second mixer just as readily.
    //
    // What stays is the guarantee. Every scene has a memory whether or not the graph provides one,
    // and this combine has a fixed point.
    vec4 history = texture(uHistory, vUv);
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
