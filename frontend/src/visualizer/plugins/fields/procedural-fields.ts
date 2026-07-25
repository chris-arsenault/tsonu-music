/**
 * Procedural and audio-driven fields (spec section 19.4).
 *
 * Fields produce spatial data other plugins consume rather than anything visible themselves. That is why
 * their character reports zero visual density: a scene made only of fields shows nothing.
 */

import { character, defineShaderPlugin, GLSL_COMMON } from '../define';
import type { VisualPluginDefinition } from '../../core/plugin';

const VECTOR_FIELD_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uPhase;
uniform float uMode;
uniform float uStrength;
uniform float uScale;
${GLSL_COMMON}

void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    vec2 field;

    if (uMode < 0.5) {                       // curl
        float e = 0.01;
        float n1 = fbm((p + vec2(0.0, e)) * uScale + uTime * 0.1);
        float n2 = fbm((p - vec2(0.0, e)) * uScale + uTime * 0.1);
        float n3 = fbm((p + vec2(e, 0.0)) * uScale + uTime * 0.1);
        float n4 = fbm((p - vec2(e, 0.0)) * uScale + uTime * 0.1);
        field = vec2(n1 - n2, n4 - n3) / (2.0 * e);
    } else if (uMode < 1.5) {                // radial attraction
        field = -normalize(p + 1e-5) * (1.0 - length(p) * 0.5);
    } else if (uMode < 2.5) {                // radial repulsion
        field = normalize(p + 1e-5) * (1.0 - length(p) * 0.5);
    } else if (uMode < 3.5) {                // spiral
        field = rotate(normalize(p + 1e-5), 1.9) * (1.0 - length(p) * 0.4);
    } else if (uMode < 4.5) {                // saddle
        field = vec2(p.x, -p.y);
    } else if (uMode < 5.5) {                // sinusoidal lattice
        field = vec2(sin(p.y * 6.0 + uTime), sin(p.x * 6.0 - uTime));
    } else if (uMode < 6.5) {                // turbulence
        field = vec2(
            fbm(p * uScale * 2.0 + uPhase) - 0.5,
            fbm(p * uScale * 2.0 + 7.3 - uPhase) - 0.5
        ) * 2.0;
    } else {                                 // domain-warped flow
        vec2 warp = vec2(fbm(p * 1.5 + uTime * 0.05), fbm(p * 1.5 + 3.1));
        field = vec2(sin((p.y + warp.y) * 4.0), cos((p.x + warp.x) * 4.0));
    }

    // Bounded so a consumer integrating this cannot be thrown off screen by one frame.
    field = clamp(field * uStrength, vec2(-4.0), vec2(4.0));
    fragColor = vec4(field, length(field), 1.0);
}`;

/**
 * Temporary forces from audio features. Impacts are packed into a uniform array rather than a texture,
 * because there are at most a few dozen and a uniform avoids an upload per frame.
 */
const IMPULSE_FIELD_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uMode;
uniform float uBass;
uniform float uTreble;
uniform float uStereo;
uniform float uOnset;
uniform float uBeatPhase;
${GLSL_COMMON}

void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    vec2 field = vec2(0.0);

    if (uMode < 0.5) {                       // centre shockwave
        float ring = 1.0 - smoothstep(0.0, 0.35, abs(length(p) - uOnset * 1.2));
        field = normalize(p + 1e-5) * ring * uOnset * 3.0;
    } else if (uMode < 1.5) {                // localized impulse
        vec2 centre = vec2(uStereo, 0.0);
        float falloff = exp(-length(p - centre) * 3.0);
        field = normalize(p - centre + 1e-5) * falloff * uOnset * 2.5;
    } else if (uMode < 2.5) {                // bass compression
        field = -normalize(p + 1e-5) * uBass * 2.0;
    } else if (uMode < 3.5) {                // treble turbulence
        field = vec2(
            valueNoise(p * 14.0 + uTreble * 5.0) - 0.5,
            valueNoise(p * 14.0 + 9.1 - uTreble * 5.0) - 0.5
        ) * uTreble * 4.0;
    } else if (uMode < 4.5) {                // stereo lateral push
        field = vec2(uStereo * 2.0, 0.0) * (1.0 - abs(p.y));
    } else {                                 // beat-ring propagation
        float ring = 1.0 - smoothstep(0.0, 0.2, abs(length(p) - uBeatPhase * 1.3));
        field = normalize(p + 1e-5) * ring * 2.0;
    }

    fragColor = vec4(clamp(field, vec2(-4.0), vec2(4.0)), length(field), 1.0);
}`;

export const VECTOR_FIELD_MODES = [
    'curl', 'attract', 'repel', 'spiral', 'saddle', 'lattice', 'turbulence', 'domain-warp',
] as const;

export const IMPULSE_FIELD_MODES = [
    'centre-shockwave', 'localized', 'bass-compression', 'treble-turbulence', 'stereo-push', 'beat-ring',
] as const;

export function createProceduralVectorField(
    mode: typeof VECTOR_FIELD_MODES[number] = 'curl',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `ProceduralVectorField:${mode}`,
        category: 'field',
        inputs: [],
        outputs: [{ name: 'flow', type: 'vector-field' }],
        capabilities: ['vector-field'],
        fragment: VECTOR_FIELD_FRAGMENT,
        uniforms: { uMode: VECTOR_FIELD_MODES.indexOf(mode), uStrength: 1, uScale: 2 },
        parameters: { strength: 1, scale: 2 },
        bindings: [{
            // Bass drives large-scale force, per the section 20 mapping.
            feature: 'bass',
            parameter: 'strength',
            outputRange: [0.4, 2.2],
            attack: 0.1,
            release: 0.45,
            curve: 'smooth',
        }],
        // Produces no visible material of its own.
        character: character({ visualDensity: 0, motionEnergy: 0.6, brightness: 0, dominance: 'supporting' }),
        // Half resolution: a force field consumed by advection needs no pixel detail.
        scale: 0.5,
        activationWeight: 1.5,
    });
}

export function createAudioImpulseField(
    mode: typeof IMPULSE_FIELD_MODES[number] = 'centre-shockwave',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `AudioImpulseField:${mode}`,
        category: 'field',
        inputs: [],
        outputs: [{ name: 'impulse', type: 'vector-field' }],
        capabilities: ['vector-field', 'audio-impulse'],
        fragment: IMPULSE_FIELD_FRAGMENT,
        uniforms: {
            uMode: IMPULSE_FIELD_MODES.indexOf(mode),
            uBass: 0,
            uTreble: 0,
            uStereo: 0,
            uOnset: 0,
            uBeatPhase: 0,
        },
        parameters: { bass: 0, treble: 0, stereo: 0, onset: 0, beatPhase: 0 },
        bindings: [
            {
                feature: 'bass',
                parameter: 'bass',
                outputRange: [0, 1],
                attack: 0.04,
                release: 0.3,
                curve: 'sqrt',
            },
            {
                feature: 'treble',
                parameter: 'treble',
                outputRange: [0, 1],
                attack: 0.02,
                release: 0.2,
                curve: 'sqrt',
            },
        ],
        character: character({ visualDensity: 0, motionEnergy: 0.9, brightness: 0, dominance: 'supporting' }),
        scale: 0.5,
        activationWeight: 1.5,
    });
}
