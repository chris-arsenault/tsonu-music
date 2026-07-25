/**
 * Procedural sources (spec section 19.2).
 *
 * Generated material needing no asset and no audio history, so these are always eligible and are what
 * the reduced grammar falls back to when everything else has been given up.
 */

import { character, defineShaderPlugin, GLSL_COMMON } from '../define';
import type { VisualPluginDefinition } from '../../core/plugin';

const PROCEDURAL_TEXTURE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uPhase;
uniform float uSeed;
uniform float uMode;
uniform float uScale;
uniform float uContrast;
${GLSL_COMMON}

void main() {
    vec2 p = (vUv - 0.5) * uScale;
    float value;

    if (uMode < 0.5) {                       // oscillator stripes
        value = 0.5 + 0.5 * sin(p.x * 18.0 + uTime * 1.5 + uPhase);
    } else if (uMode < 1.5) {                // gradient field
        value = clamp(0.5 + p.y + 0.15 * sin(p.x * 4.0 + uTime), 0.0, 1.0);
    } else if (uMode < 2.5) {                // value noise
        value = valueNoise(p * 6.0 + uTime * 0.15);
    } else if (uMode < 3.5) {                // curl-like noise
        float a = fbm(p * 3.0 + uTime * 0.1);
        float b = fbm(p * 3.0 + vec2(5.2, 1.3) - uTime * 0.08);
        value = length(vec2(a, b) - 0.5) * 1.6;
    } else if (uMode < 4.5) {                // cellular
        float nearest = 1.0;
        for (int gy = -1; gy <= 1; gy += 1) {
            for (int gx = -1; gx <= 1; gx += 1) {
                vec2 cell = floor(p * 5.0) + vec2(float(gx), float(gy));
                vec2 point = cell + vec2(hash(cell), hash(cell + 3.7));
                nearest = min(nearest, length(p * 5.0 - point));
            }
        }
        value = nearest;
    } else if (uMode < 5.5) {                // checker
        vec2 cells = floor(p * 8.0 + uTime * 0.2);
        value = mod(cells.x + cells.y, 2.0);
    } else if (uMode < 6.5) {                // concentric rings
        value = 0.5 + 0.5 * sin(length(p) * 24.0 - uTime * 2.0);
    } else {                                 // angular ramp
        value = fract(atan(p.y, p.x) / 6.2831853 + uTime * 0.05 + uSeed);
    }

    value = clamp((value - 0.5) * uContrast + 0.5, 0.0, 1.0);
    fragColor = vec4(vec3(value), 1.0);
}`;

const PARAMETRIC_CURVE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uPhase;
uniform float uMode;
uniform float uThickness;
uniform float uFrequency;
${GLSL_COMMON}

/** Distance from the current pixel to the nearest point on the parametric curve. */
float curveDistance(vec2 p) {
    float nearest = 10.0;

    for (int i = 0; i < 220; i += 1) {
        float t = float(i) / 220.0 * 6.2831853 * 3.0;
        vec2 point;

        if (uMode < 0.5) {                   // spirograph
            point = vec2(cos(t) + 0.45 * cos(t * uFrequency), sin(t) + 0.45 * sin(t * uFrequency)) * 0.4;
        } else if (uMode < 1.5) {            // harmonograph
            point = vec2(
                sin(t * 2.0 + uPhase) * exp(-t * 0.01),
                sin(t * 3.0 + uTime * 0.3) * exp(-t * 0.012)
            ) * 0.7;
        } else if (uMode < 2.5) {            // rose curve
            float r = cos(uFrequency * t) * 0.7;
            point = vec2(cos(t), sin(t)) * r;
        } else if (uMode < 3.5) {            // hypotrochoid
            float ratio = 0.35;
            point = vec2(
                (1.0 - ratio) * cos(t) + ratio * cos(t * (1.0 - ratio) / ratio),
                (1.0 - ratio) * sin(t) - ratio * sin(t * (1.0 - ratio) / ratio)
            ) * 0.65;
        } else if (uMode < 4.5) {            // epitrochoid
            float ratio = 0.3;
            point = vec2(
                (1.0 + ratio) * cos(t) - ratio * cos(t * (1.0 + ratio) / ratio),
                (1.0 + ratio) * sin(t) - ratio * sin(t * (1.0 + ratio) / ratio)
            ) * 0.45;
        } else if (uMode < 5.5) {            // superformula-like
            float angle = t;
            float r = pow(pow(abs(cos(angle * uFrequency * 0.25)), 3.0)
                + pow(abs(sin(angle * uFrequency * 0.25)), 3.0), -0.3) * 0.35;
            point = vec2(cos(angle), sin(angle)) * r;
        } else if (uMode < 6.5) {            // torus knot projection
            point = vec2(
                cos(t * 2.0) * (0.6 + 0.25 * cos(t * 3.0)),
                sin(t * 2.0) * (0.6 + 0.25 * cos(t * 3.0))
            );
        } else {                             // pendulum
            point = vec2(
                sin(t * 1.0 + uPhase) * 0.7,
                sin(t * 1.41 + uTime * 0.2) * 0.7
            );
        }

        nearest = min(nearest, length(p - point));
    }

    return nearest;
}

void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    p.x *= uResolution.x / max(uResolution.y, 1.0);

    float distance = curveDistance(p);
    float line = 1.0 - smoothstep(0.0, uThickness, distance);

    fragColor = vec4(vec3(line), line);
}`;

const SDF_SHAPE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uPhase;
uniform float uMode;
uniform float uMorph;
uniform float uRepeat;
uniform float uEnergy;
${GLSL_COMMON}

float circle(vec2 p, float r) { return length(p) - r; }

float box(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float polygon(vec2 p, float sides, float r) {
    float angle = atan(p.y, p.x);
    float segment = 6.2831853 / sides;
    float a = mod(angle, segment) - segment * 0.5;
    return length(p) * cos(a) - r;
}

float smoothUnion(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    p.x *= uResolution.x / max(uResolution.y, 1.0);
    float pulse = 1.0 + 0.06 * sin(uTime * 0.8 + uPhase) + 0.12 * uEnergy;
    p = rotate(p / pulse, uTime * 0.035 + uEnergy * 0.08);

    if (uRepeat > 1.5) {
        // Domain repetition: one shape becomes a lattice without extra geometry.
        p = mod(p + 1.0 / uRepeat, 2.0 / uRepeat) - 1.0 / uRepeat;
    }

    float shape;

    if (uMode < 0.5) {
        shape = circle(p, 0.5);
    } else if (uMode < 1.5) {
        shape = smoothUnion(circle(p - vec2(0.22, 0.0), 0.32), circle(p + vec2(0.22, 0.0), 0.32), 0.18);
    } else if (uMode < 2.5) {
        shape = max(box(p, vec2(0.45)), -circle(p, 0.32));
    } else if (uMode < 3.5) {
        shape = polygon(p, 6.0, 0.45);
    } else if (uMode < 4.5) {
        // Morph between a circle and a hexagon, driven by a parameter rather than time alone.
        shape = mix(circle(p, 0.45), polygon(p, 6.0, 0.45), clamp(uMorph, 0.0, 1.0));
    } else if (uMode < 5.5) {
        // Mandala: rotational repetition of one petal.
        float sectors = 12.0;
        float angle = atan(p.y, p.x) + uPhase;
        float segment = 6.2831853 / sectors;
        vec2 folded = rotate(p, -floor(angle / segment + 0.5) * segment);
        shape = box(folded - vec2(0.42, 0.0), vec2(0.16, 0.05));
    } else {
        float glyph = box(p, vec2(0.34, 0.06));
        glyph = min(glyph, box(rotate(p, 1.0472), vec2(0.34, 0.06)));
        shape = min(glyph, box(rotate(p, -1.0472), vec2(0.34, 0.06)));
    }

    float fill = 1.0 - smoothstep(0.0, 0.012, shape);
    vec2 gradient = vec2(
        circle(p + vec2(0.002, 0.0), 0.5) - circle(p - vec2(0.002, 0.0), 0.5),
        circle(p + vec2(0.0, 0.002), 0.5) - circle(p - vec2(0.0, 0.002), 0.5)
    );

    // Colour, mask, distance, and gradient in one output, as section 19.2 describes.
    float palettePhase = 0.5 + 0.5 * sin(uPhase + uTime * 0.12 + uEnergy * 2.0);
    vec3 colour = mix(vec3(0.12, 0.22, 0.58), vec3(0.95, 0.56, 0.16), palettePhase);
    fragColor = vec4(colour * fill, fill) + vec4(0.0, gradient, 0.0) * 0.0 + vec4(0.0);
}`;

export const PROCEDURAL_TEXTURE_MODES = [
    'stripes', 'gradient', 'value-noise', 'curl-noise', 'cellular', 'checker', 'rings', 'angular',
] as const;

export const PARAMETRIC_CURVE_MODES = [
    'spirograph', 'harmonograph', 'rose', 'hypotrochoid', 'epitrochoid', 'superformula', 'torus-knot', 'pendulum',
] as const;

export const SDF_SHAPE_MODES = [
    'primitive', 'smooth-union', 'subtraction', 'polygon', 'morph', 'mandala', 'glyph',
] as const;

export function createProceduralTextureSource(
    mode: typeof PROCEDURAL_TEXTURE_MODES[number] = 'value-noise',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `ProceduralTextureSource:${mode}`,
        category: 'source',
        inputs: [],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['procedural'],
        fragment: PROCEDURAL_TEXTURE_FRAGMENT,
        uniforms: {
            uMode: PROCEDURAL_TEXTURE_MODES.indexOf(mode),
            uScale: 2,
            uContrast: 1.2,
        },
        parameters: { scale: 2, contrast: 1.2 },
        bindings: [{
            feature: 'mid',
            parameter: 'contrast',
            outputRange: [0.9, 2],
            attack: 0.1,
            release: 0.4,
            curve: 'smooth',
        }],
        character: character({ geometricOrder: 0.5, motionEnergy: 0.35, visualDensity: 0.6 }),
        activationWeight: 1,
        minimumDuration: 10,
    });
}

export function createParametricCurveSource(
    mode: typeof PARAMETRIC_CURVE_MODES[number] = 'spirograph',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `ParametricCurveSource:${mode}`,
        category: 'source',
        inputs: [],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['procedural', 'parametric-curve'],
        fragment: PARAMETRIC_CURVE_FRAGMENT,
        uniforms: { uMode: PARAMETRIC_CURVE_MODES.indexOf(mode), uThickness: 0.02, uFrequency: 7 },
        parameters: { thickness: 0.02, frequency: 7 },
        bindings: [{
            feature: 'beatPhase',
            parameter: 'frequency',
            outputRange: [5, 9],
            attack: 0.2,
            release: 0.6,
            curve: 'smooth',
        }],
        // The curve is the whole image, so it reads as a primary generator.
        character: character({ geometricOrder: 0.95, visualDensity: 0.3, motionEnergy: 0.5, dominance: 'primary' }),
        gpuCost: 2,
        activationWeight: 1,
        minimumDuration: 12,
    });
}

export function createSdfShapeSource(
    mode: typeof SDF_SHAPE_MODES[number] = 'mandala',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `SDFShapeSource:${mode}`,
        category: 'source',
        inputs: [],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['procedural', 'sdf'],
        fragment: SDF_SHAPE_FRAGMENT,
        uniforms: { uMode: SDF_SHAPE_MODES.indexOf(mode), uMorph: 0.5, uRepeat: 1, uEnergy: 0.35 },
        parameters: { morph: 0.5, repeat: 1, energy: 0.35 },
        bindings: [
            {
                feature: 'lowMid',
                parameter: 'morph',
                outputRange: [0, 1],
                attack: 0.25,
                release: 0.7,
                curve: 'smooth',
            },
            {
                feature: 'rms',
                parameter: 'energy',
                outputRange: [0.1, 1],
                attack: 0.08,
                release: 0.45,
                curve: 'sqrt',
            },
        ],
        character: character({ geometricOrder: 0.9, visualDensity: 0.4, motionEnergy: 0.25 }),
        activationWeight: 1,
        minimumDuration: 10,
    });
}
