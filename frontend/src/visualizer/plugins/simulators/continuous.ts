/**
 * Continuous simulators (spec section 19.7).
 *
 * Both hold state in a ping-ponged float texture and evolve it every frame, so both freeze completely
 * when the clock does: a paused track leaves the pattern exactly where it was rather than continuing to
 * grow silently.
 */

import { character, defineShaderPlugin, GLSL_COMMON } from '../define';
import type { VisualPluginDefinition } from '../../core/plugin';

/**
 * Gray-Scott reaction-diffusion. Two chemicals in the red and green channels; feed and kill rates decide
 * whether the result reads as spots, stripes, or coral.
 */
const REACTION_DIFFUSION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uHistory;
uniform sampler2D uSeedTexture;
uniform vec2 uResolution;
uniform float uDelta;
uniform float uFeed;
uniform float uKill;
uniform float uImpulse;
${GLSL_COMMON}

vec2 laplacian(vec2 uv, vec2 texel) {
    vec2 sum = vec2(0.0);
    sum += texture(uHistory, uv + texel * vec2(-1.0, 0.0)).rg * 0.2;
    sum += texture(uHistory, uv + texel * vec2(1.0, 0.0)).rg * 0.2;
    sum += texture(uHistory, uv + texel * vec2(0.0, -1.0)).rg * 0.2;
    sum += texture(uHistory, uv + texel * vec2(0.0, 1.0)).rg * 0.2;
    sum += texture(uHistory, uv + texel * vec2(-1.0, -1.0)).rg * 0.05;
    sum += texture(uHistory, uv + texel * vec2(1.0, -1.0)).rg * 0.05;
    sum += texture(uHistory, uv + texel * vec2(-1.0, 1.0)).rg * 0.05;
    sum += texture(uHistory, uv + texel * vec2(1.0, 1.0)).rg * 0.05;
    return sum - texture(uHistory, uv).rg;
}

void main() {
    vec2 texel = 1.0 / uResolution;
    vec4 state = texture(uHistory, vUv);
    vec2 chemicals = state.rg;

    // An empty field never reacts, so it is primed with chemical A everywhere and scattered B.
    if (chemicals == vec2(0.0)) {
        chemicals = vec2(1.0, hash(vUv * 37.0) > 0.96 ? 1.0 : 0.0);
    }

    // Seeded from a mask or album luminance where one is supplied.
    float seed = texture(uSeedTexture, vUv).r;
    chemicals.g = max(chemicals.g, seed > 0.7 ? uImpulse : 0.0);

    vec2 diffused = laplacian(vUv, texel);
    float a = chemicals.r;
    float b = chemicals.g;
    float reaction = a * b * b;

    // Scaled by delta so the pattern evolves at the same rate regardless of frame rate, and stops dead
    // when the clock is frozen.
    float step_scale = clamp(uDelta * 60.0, 0.0, 1.5);
    a += (1.0 * diffused.r - reaction + uFeed * (1.0 - a)) * step_scale;
    b += (0.5 * diffused.g + reaction - (uKill + uFeed) * b) * step_scale;

    fragColor = vec4(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0), b, 1.0);
}`;

/** Colourizes the concentration field into something presentable. */
const REACTION_VIEW_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uContrast;
${GLSL_COMMON}

void main() {
    vec2 texel = 1.0 / uResolution;
    float centre = texture(uSource, vUv).g;
    float right = texture(uSource, vUv + vec2(texel.x, 0.0)).g;
    float up = texture(uSource, vUv + vec2(0.0, texel.y)).g;

    float value = clamp((centre - 0.15) * uContrast, 0.0, 1.0);
    // Edge from the concentration gradient, which is what makes the membranes read as structure.
    float edge = clamp(length(vec2(right - centre, up - centre)) * 24.0, 0.0, 1.0);

    fragColor = vec4(vec3(value + edge * 0.6), max(value, edge));
}`;

/**
 * Damped wave equation. Height in red, velocity in green, so one texel carries a full oscillator.
 */
const WAVE_FIELD_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uHistory;
uniform sampler2D uImpulse;
uniform vec2 uResolution;
uniform float uDelta;
uniform float uDamping;
uniform float uSpeed;
uniform float uOnset;
uniform vec2 uImpactCentre;
uniform float uImpactRadius;
uniform float uImpactEnergy;
${GLSL_COMMON}

void main() {
    vec2 texel = 1.0 / uResolution;
    vec4 state = texture(uHistory, vUv);
    float height = state.r;
    float velocity = state.g;

    float neighbours =
        texture(uHistory, vUv + vec2(texel.x, 0.0)).r +
        texture(uHistory, vUv - vec2(texel.x, 0.0)).r +
        texture(uHistory, vUv + vec2(0.0, texel.y)).r +
        texture(uHistory, vUv - vec2(0.0, texel.y)).r;

    float acceleration = (neighbours - 4.0 * height) * uSpeed;

    // Onsets inject impulses, which is the section 20 mapping for transient events.
    float injected = texture(uImpulse, vUv).r * uOnset;

    // An impact drops a localized ring into the surface where the collision happened (section 19.6).
    if (uImpactEnergy > 0.001) {
        float ring = 1.0 - smoothstep(0.0, max(uImpactRadius, 0.02), length(vUv - uImpactCentre));
        injected += ring * uImpactEnergy * 0.15;
    }

    float step_scale = clamp(uDelta * 60.0, 0.0, 1.5);
    velocity = (velocity + acceleration * step_scale) * (1.0 - uDamping * step_scale);
    height += (velocity + injected) * step_scale;

    // Normals from the height gradient, so a consumer can refract through the surface.
    float dx = texture(uHistory, vUv + vec2(texel.x, 0.0)).r - height;
    float dy = texture(uHistory, vUv + vec2(0.0, texel.y)).r - height;

    fragColor = vec4(clamp(height, -1.0, 1.0), velocity, dx, dy);
}`;

const WAVE_VIEW_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uGain;
${GLSL_COMMON}

void main() {
    vec4 state = texture(uSource, vUv);
    float height = state.r * uGain;
    // Ripples read as brightness on both crests and troughs, so the interference pattern is visible.
    float shade = clamp(abs(height) * 1.4, 0.0, 1.0);
    float rim = clamp(length(state.ba) * 30.0, 0.0, 1.0);

    fragColor = vec4(vec3(shade + rim * 0.5), max(shade, rim));
}`;

export function createReactionDiffusionSimulator(): VisualPluginDefinition {
    return defineShaderPlugin({
        id: 'ReactionDiffusionSimulator',
        category: 'simulator',
        inputs: [
            { name: 'history', type: 'reaction-diffusion-state', required: false },
            // Optional: mask or album luminance seeds the pattern, but it self-seeds without one.
            // Sampler named explicitly: the default would be `uSeed`, which collides with the
            // per-instance random scalar every shader plugin already receives under that name. The
            // driver rejected one of the two every frame.
            { name: 'seed', type: 'mask-texture', required: false, sampler: 'uSeedTexture' },
        ],
        outputs: [{ name: 'field', type: 'reaction-diffusion-state' }],
        capabilities: ['reaction-diffusion', 'feedback'],
        fragment: REACTION_DIFFUSION_FRAGMENT,
        // No `uDelta` here: the kernel supplies the frame's real delta to every pass. Declaring it
        // statically pinned the integration to a sixtieth of a second per frame, which ran fast on a
        // high-refresh display and kept the reaction evolving while playback was paused.
        uniforms: { uFeed: 0.037, uKill: 0.06, uImpulse: 0.6 },
        parameters: { feed: 0.037, kill: 0.06, impulse: 0.6 },
        bindings: [
            {
                feature: 'mid',
                role: 'deformation',
                parameter: 'kill',
                outputRange: [0.055, 0.068],
                attack: 0.6,
                release: 1.8,
                curve: 'smooth',
            },
            {
                feature: 'onset',
                role: 'burst',
                mode: 'impulse',
                parameter: 'impulse',
                outputRange: [0.2, 1.4],
                attack: 0.01,
                release: 0.35,
                curve: 'sqrt',
            },
        {
            // Small changes in feed rate change the pattern family entirely, so the range is tight.
            feature: 'lowMid',
            parameter: 'feed',
            outputRange: [0.03, 0.045],
            attack: 0.5,
            release: 1.2,
            curve: 'smooth',
        }],
        character: character({
            visualDensity: 0.8,
            motionEnergy: 0.3,
            geometricOrder: 0.2,
            persistence: 0.95,
            dominance: 'primary',
        }),
        gpuCost: 3,
        memoryCost: 2,
        feedbackPort: 'history',
        clear: false,
        // Half resolution comes from the render plan, which sizes every resource by its port type.
        deactivationPolicy: 'freeze-and-dissolve',
        activationWeight: 1,
        minimumDuration: 20,
    });
}

export function createReactionDiffusionView(): VisualPluginDefinition {
    return defineShaderPlugin({
        id: 'ReactionDiffusionView',
        category: 'transformer',
        inputs: [{ name: 'source', type: 'reaction-diffusion-state', required: true }],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['reaction-diffusion-view'],
        fragment: REACTION_VIEW_FRAGMENT,
        uniforms: { uContrast: 3 },
        parameters: { contrast: 3 },
        bindings: [
            {
                feature: 'highMid',
                role: 'detail',
                parameter: 'contrast',
                outputRange: [1.8, 4.5],
                attack: 0.15,
                release: 0.6,
                curve: 'smooth',
            },
        ],
        character: character({ visualDensity: 0.7, brightness: 0.6, dominance: 'supporting' }),
        activationWeight: 2,
        prefersWith: ['ReactionDiffusionSimulator'],
    });
}

export function createWaveFieldSimulator(): VisualPluginDefinition {
    return defineShaderPlugin({
        // Impacts inject height impulses, which is section 19.6's wave-field response to a collision.
        impactDriven: true,
        id: 'WaveFieldSimulator',
        category: 'simulator',
        inputs: [
            { name: 'history', type: 'wave-field-state', required: false },
            { name: 'impulse', type: 'vector-field', required: true },
        ],
        outputs: [{ name: 'field', type: 'wave-field-state' }],
        capabilities: ['wave-field', 'feedback', 'impact-consumer'],
        fragment: WAVE_FIELD_FRAGMENT,
        // See the note on the reaction-diffusion pass above: `uDelta` is the kernel's to supply.
        uniforms: { uDamping: 0.015, uSpeed: 0.4, uOnset: 0.5 },
        parameters: { damping: 0.015, speed: 0.4, onset: 0.5 },
        bindings: [
            {
                feature: 'rms',
                role: 'intensity',
                parameter: 'damping',
                outputRange: [0.004, 0.03],
                attack: 0.3,
                release: 1,
                curve: 'smooth',
            },
            {
                feature: 'lowMid',
                role: 'deformation',
                parameter: 'speed',
                outputRange: [0.22, 0.62],
                attack: 0.3,
                release: 1,
                curve: 'smooth',
            },
        {
            feature: 'spectralFlux',
            parameter: 'onset',
            outputRange: [0.05, 1.2],
            attack: 0.01,
            release: 0.25,
            curve: 'sqrt',
        }],
        character: character({
            visualDensity: 0.55,
            motionEnergy: 0.7,
            geometricOrder: 0.5,
            persistence: 0.8,
            dominance: 'either',
        }),
        gpuCost: 2,
        memoryCost: 2,
        feedbackPort: 'history',
        clear: false,
        deactivationPolicy: 'freeze-and-dissolve',
        activationWeight: 1.2,
        minimumDuration: 16,
    });
}

export function createWaveFieldView(): VisualPluginDefinition {
    return defineShaderPlugin({
        id: 'WaveFieldView',
        category: 'transformer',
        inputs: [{ name: 'source', type: 'wave-field-state', required: true }],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['wave-field-view'],
        fragment: WAVE_VIEW_FRAGMENT,
        uniforms: { uGain: 2.5 },
        parameters: { gain: 2.5 },
        bindings: [
            {
                feature: 'rms',
                role: 'intensity',
                parameter: 'gain',
                outputRange: [1.4, 3.8],
                attack: 0.12,
                release: 0.5,
                curve: 'smooth',
            },
        ],
        character: character({ visualDensity: 0.5, brightness: 0.6, dominance: 'supporting' }),
        activationWeight: 2,
        prefersWith: ['WaveFieldSimulator'],
    });
}
