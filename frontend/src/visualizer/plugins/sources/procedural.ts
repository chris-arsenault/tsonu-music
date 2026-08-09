/**
 * Procedural sources (spec section 19.2).
 *
 * Generated material needing no asset and no audio history, so these are always eligible and are what
 * the reduced grammar falls back to when everything else has been given up.
 */

import { character, defineShaderPlugin, GLSL_COMMON, GLSL_PERTURB } from '../define';
import type { VisualPluginDefinition } from '../../core/plugin';

/**
 * The port and the parameter that let a source be pushed around by the rest of the scene.
 *
 * Declared once because it is the same on every producer: optional, so a source with nothing wired to
 * it renders exactly as before, and bound to a band so the amount of displacement follows the music
 * rather than sitting at a constant. Shared rather than repeated so the next producer added cannot
 * quietly be another closed one.
 */
export const PERTURB_INPUT = { name: 'field', type: 'vector-field' as const, required: false };

export const PERTURB_UNIFORMS = { uPerturb: 0.12 };
export const PERTURB_PARAMETERS = { perturb: 0.12 };
export const PERTURB_BINDING = {
    feature: 'lowMid',
    role: 'deformation' as const,
    parameter: 'perturb',
    outputRange: [0.02, 0.35] as [number, number],
    attack: 0.15,
    release: 0.7,
    curve: 'smooth' as const,
};

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
${GLSL_PERTURB}

void main() {
    // Sampled through the field, so anything producing one can push this texture around instead of
    // it being redrawn at the same coordinates every frame.
    vec2 p = (perturbed(vUv) - 0.5) * uScale;
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

    // Shaped so the field reads as structure on black rather than as wallpaper.
    //
    // Every mode above returns a value centred near a half, which filled the entire frame with
    // mid-grey: coverage a hundred percent, mean luminance around half scale, and the accumulation
    // converging to exactly that. A raised exponent pushes the middle down to near black and leaves
    // the peaks, which is the difference between a lit field and a lit structure.
    value = pow(clamp(value, 0.0, 1.0), 1.0 + uContrast * 2.0);

    // Alpha carries the same shape, so this does not opaquely occlude whatever it composites over.
    fragColor = vec4(vec3(value), value);
}`;

/**
 * The curve itself, shared by the colour pass and the pass that publishes its direction.
 *
 * Two hundred and twenty iterations, so one copy rather than two — and more importantly one
 * definition, since a motion field describing a different figure from the one on screen would be
 * worse than none.
 */
const PARAMETRIC_CURVE_BODY = `
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
${GLSL_PERTURB}
${PARAMETRIC_CURVE_BODY}

void main() {
    vec2 p = (perturbed(vUv) - 0.5) * 2.0;
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
${GLSL_PERTURB}

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
    vec2 p = (perturbed(vUv) - 0.5) * 2.0;
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

    // Colour and mask. The comment here used to promise "colour, mask, distance, and gradient in one
    // output", and the line below multiplied the gradient by zero before adding it — four extra
    // circle evaluations per pixel, discarded. This output port is a colour texture and its consumers
    // read colour and alpha, so the honest thing is to compute what they read; a plugin that needs
    // the gradient of this shape is what the vector-field port is for.
    float palettePhase = 0.5 + 0.5 * sin(uPhase + uTime * 0.12 + uEnergy * 2.0);
    vec3 colour = mix(vec3(0.12, 0.22, 0.58), vec3(0.95, 0.56, 0.16), palettePhase);
    fragColor = vec4(colour * fill, fill);
}`;

/**
 * A colour ramp indexed by luminance, needing no artwork.
 *
 * `PaletteMapper` is the catalog's only palette-mapping stage, and its `palette` input could be
 * satisfied by exactly one plugin: `AlbumArtPalette`, which requires the album-art asset. On a track
 * with no artwork the mapper was unreachable — measured across three hundred builds, selected zero
 * times — and since every procedural and SDF source writes `vec4(vec3(value), value)`, all colour in
 * such a scene came from the kernel's per-branch ramp. That is the monochrome report.
 *
 * A cosine ramp rather than an interpolation between stops: three channels offset around one cycle
 * stays smooth everywhere and never passes through the grey midpoint two interpolated hues produce.
 */
const PROCEDURAL_PALETTE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uSeed;
uniform float uPhase;
/** Where on the colour circle the ramp begins. */
uniform float uHue;
/** How far around the circle it travels between the dark end and the bright one. */
uniform float uSpread;
/** How much darker the low end is. Without it the ramp is a hue wheel at constant brightness. */
uniform float uDepth;

void main() {
    // The strip is indexed by the source's luminance, so x is dark at nought and bright at one and
    // the ramp has to carry that or it destroys the structure it is colouring.
    float t = vUv.x;
    vec3 phase = vec3(0.0, 0.33, 0.67) + uHue + uPhase * 0.15;
    vec3 colour = 0.5 + 0.5 * cos(6.2831853 * (t * uSpread + phase));

    fragColor = vec4(colour * mix(1.0 - uDepth, 1.0, t), 1.0);
}`;

export function createProceduralPalette(): VisualPluginDefinition {
    return defineShaderPlugin({
        id: 'ProceduralPalette',
        category: 'source',
        inputs: [],
        outputs: [{ name: 'palette', type: 'palette' }],
        capabilities: ['palette', 'procedural'],
        fragment: PROCEDURAL_PALETTE_FRAGMENT,
        uniforms: { uHue: 0.1, uSpread: 0.55, uDepth: 0.8 },
        parameters: { hue: 0.1, spread: 0.55, depth: 0.8 },
        bindings: [
            {
                // Where the scheme sits on the circle. Brightness is where the ear expects colour to
                // move, which is what the section 20 table puts on complexity.
                feature: 'spectralCentroid',
                role: 'complexity',
                parameter: 'hue',
                outputRange: [0, 1],
                attack: 0.5,
                release: 1.6,
                curve: 'linear',
            },
            {
                // How many hues the ramp crosses: narrow is a duotone, wide is a spectrum.
                feature: 'lowMid',
                role: 'deformation',
                parameter: 'spread',
                outputRange: [0.25, 1.1],
                attack: 0.6,
                release: 2,
                curve: 'smooth',
            },
            {
                feature: 'rms',
                role: 'intensity',
                parameter: 'depth',
                outputRange: [0.9, 0.5],
                attack: 0.3,
                release: 1.1,
                curve: 'smooth',
            },
        ],
        // Contributes no visible material of its own, exactly as the album-art palette does.
        character: character({ visualDensity: 0, motionEnergy: 0, brightness: 0.5, dominance: 'supporting' }),
        activationWeight: 3,
        // Pulls the mapper in behind it, and is pulled in by one. Without the pairing a palette
        // producer and its only consumer had to be drawn independently from a catalog of two hundred.
        prefersWith: ['PaletteMapper'],
    });
}

/**
 * Where a procedural texture's pattern is travelling (ADR-0012).
 *
 * These modes do not resample anything — they generate — so there is no read position to difference.
 * What there is instead is exact: every one of them animates by adding `uTime` to a coordinate, and
 * the direction that displaces the pattern in is known from the expression rather than inferred. A
 * stripe field scrolling in x publishes a field pointing along x.
 *
 * The three static modes publish nothing, which is the honest answer for a pattern that does not
 * move. A field of zero is read as no contribution rather than as a contribution of no size.
 */
const PROCEDURAL_TEXTURE_MOTION = `#version 300 es
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
    vec2 field = vec2(0.0);

    if (uMode < 0.5) {                       // stripes: the phase advances along x
        field = vec2(-1.5 / max(uScale, 0.001), 0.0);
    } else if (uMode < 1.5) {                // gradient: its ripple travels along x
        field = vec2(-0.25 / max(uScale, 0.001), 0.0);
    } else if (uMode < 2.5) {                // value noise: the sample point drifts diagonally
        field = vec2(-0.15, -0.15) / max(uScale, 0.001);
    } else if (uMode < 3.5) {                // curl noise: two layers drifting against each other
        field = vec2(-0.1, 0.08) / max(uScale, 0.001);
    } else if (uMode < 4.5) {                // cellular: static
        field = vec2(0.0);
    } else if (uMode < 5.5) {                // checker: the lattice slides diagonally
        field = vec2(-0.2, -0.2) / max(uScale, 0.001);
    } else if (uMode < 6.5) {                // rings: the wavefront travels outward from the centre
        field = normalize(p + 1e-5) * (2.0 / 24.0) / max(uScale, 0.001);
    } else {                                 // angular: the ramp rotates about the centre
        vec2 radial = normalize(p + 1e-5);
        field = vec2(-radial.y, radial.x) * 0.05 * 6.2831853 * length(p);
    }

    fragColor = vec4(field, length(field), 1.0);
}`;

export const PROCEDURAL_TEXTURE_MODES = [
    'stripes', 'gradient', 'value-noise', 'curl-noise', 'cellular', 'checker', 'rings', 'angular',
] as const;

/**
 * Which way the curve is sweeping (ADR-0012).
 *
 * I first excluded this on the grounds that the curve does not travel. That was wrong: `uPhase`
 * carries an audio-driven offset and three modes advance on `uTime`, so the figure moves every
 * frame, and `uFrequency` — bound to beat phase — changes its shape as it goes.
 *
 * Differencing the distance field would cost four more sweeps of a 220-iteration loop, which is not
 * worth it. The gradient is cheaper and says the same thing about direction: it points away from the
 * nearest point on the curve, so rotating a quarter turn gives the tangent, which is the direction
 * material would travel if it were being carried along the figure. Scaled by nearness, so the field
 * is present at the line and absent in the empty space around it.
 */
const PARAMETRIC_CURVE_MOTION = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uPhase;
uniform float uSeed;
uniform float uMode;
uniform float uThickness;
uniform float uFrequency;
${GLSL_COMMON}
${PARAMETRIC_CURVE_BODY}

void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    p.x *= uResolution.x / max(uResolution.y, 1.0);

    float step = uThickness * 0.75;
    float here = curveDistance(p);
    float dx = curveDistance(p + vec2(step, 0.0)) - curveDistance(p - vec2(step, 0.0));
    float dy = curveDistance(p + vec2(0.0, step)) - curveDistance(p - vec2(0.0, step));

    // Perpendicular to the gradient is along the curve. Carrying material into the line instead
    // would pile it against the figure and stop; carrying it around is what reads as a current.
    vec2 gradient = vec2(dx, dy);
    vec2 tangent = vec2(-gradient.y, gradient.x);

    // Present at the line, absent in the space around it.
    float nearness = 1.0 - smoothstep(0.0, uThickness * 3.0, here);
    vec2 field = tangent * nearness * (0.6 + uFrequency * 0.05);

    fragColor = vec4(clamp(field, vec2(-2.0), vec2(2.0)), length(field), 1.0);
}`;

export const PARAMETRIC_CURVE_MODES = [
    'spirograph', 'harmonograph', 'rose', 'hypotrochoid', 'epitrochoid', 'superformula', 'torus-knot', 'pendulum',
] as const;

/**
 * An SDF shape turns and breathes, and both are known exactly (ADR-0012).
 *
 * The colour pass rotates its coordinate by `uTime * 0.035 + uPhase` — where `uPhase` carries the
 * integrated `spin`, a rate the music sets — and scales it by a pulse. A rotation about the centre
 * is a tangential field whose magnitude grows with radius; a pulse is a radial one. This is the
 * plugin's own animation, published so it can reach the accumulated image rather than being redrawn
 * from nothing every frame.
 */
const SDF_SHAPE_MOTION = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uPhase;
uniform float uSeed;
uniform float uMode;
uniform float uMorph;
uniform float uRepeat;
uniform float uEnergy;
${GLSL_COMMON}

/** Matches the colour pass: a slow constant plus whatever the audio-driven spin is adding. */
const float BASE_SPIN = 0.035;

void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    p.x *= uResolution.x / max(uResolution.y, 1.0);

    // Tangential: a rotation carries a point perpendicular to its radius, faster further out.
    vec2 radial = normalize(p + 1e-5);
    vec2 tangent = vec2(-radial.y, radial.x) * (BASE_SPIN + uEnergy * 0.08) * length(p);

    // Radial: the pulse that scales the whole shape, breathing in and out about the centre.
    float breath = 0.06 * 0.8 * cos(uTime * 0.8 + uPhase) + uEnergy * 0.02;

    vec2 field = tangent + radial * breath;

    fragColor = vec4(field, length(field), 1.0);
}`;

export const SDF_SHAPE_MODES = [
    'primitive', 'smooth-union', 'subtraction', 'polygon', 'morph', 'mandala', 'glyph',
] as const;

export function createProceduralTextureSource(
    mode: typeof PROCEDURAL_TEXTURE_MODES[number] = 'value-noise',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `ProceduralTextureSource:${mode}`,
        category: 'source',
        inputs: [PERTURB_INPUT],
        outputs: [
            { name: 'color', type: 'color-texture' },
            { name: 'motion', type: 'vector-field' },
        ],
        capabilities: ['procedural', 'vector-field'],
        fragment: PROCEDURAL_TEXTURE_FRAGMENT,
        motion: { port: 'motion', fragment: PROCEDURAL_TEXTURE_MOTION },
        uniforms: {
            ...PERTURB_UNIFORMS,
            uMode: PROCEDURAL_TEXTURE_MODES.indexOf(mode),
            uScale: 2,
            uContrast: 1.2,
        },
        parameters: { scale: 2, contrast: 1.2 },
        bindings: [
            {
                feature: 'lowMid',
                role: 'deformation',
                parameter: 'scale',
                outputRange: [1.2, 3.4],
                attack: 0.4,
                release: 1.2,
                curve: 'smooth',
            },
        {
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
        inputs: [PERTURB_INPUT],
        outputs: [
            { name: 'color', type: 'color-texture' },
            { name: 'motion', type: 'vector-field' },
        ],
        capabilities: ['procedural', 'parametric-curve', 'vector-field'],
        fragment: PARAMETRIC_CURVE_FRAGMENT,
        motion: { port: 'motion', fragment: PARAMETRIC_CURVE_MOTION },
        uniforms: {
            ...PERTURB_UNIFORMS,
            uMode: PARAMETRIC_CURVE_MODES.indexOf(mode),
            uThickness: 0.02,
            uFrequency: 7,
        },
        parameters: { ...PERTURB_PARAMETERS, thickness: 0.02, frequency: 7 },
        bindings: [
            PERTURB_BINDING,
            {
                feature: 'rmsExcite',
                role: 'intensity',
                parameter: 'thickness',
                outputRange: [0.012, 0.05],
                attack: 0.05,
                release: 0.4,
                curve: 'sqrt',
            },
        {
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
        inputs: [PERTURB_INPUT],
        outputs: [
            { name: 'color', type: 'color-texture' },
            { name: 'motion', type: 'vector-field' },
        ],
        capabilities: ['procedural', 'sdf', 'vector-field'],
        fragment: SDF_SHAPE_FRAGMENT,
        motion: { port: 'motion', fragment: SDF_SHAPE_MOTION },
        uniforms: {
            ...PERTURB_UNIFORMS,
            uMode: SDF_SHAPE_MODES.indexOf(mode),
            uMorph: 0.5,
            uRepeat: 1,
            uEnergy: 0.35,
        },
        parameters: { ...PERTURB_PARAMETERS, morph: 0.5, repeat: 1, energy: 0.35, spin: 0 },
        bindings: [
            PERTURB_BINDING,
            {
                feature: 'subBass',
                role: 'large-scale-force',
                parameter: 'repeat',
                outputRange: [1, 4],
                attack: 0.8,
                release: 2,
                curve: 'smooth',
            },
            {
                feature: 'lowMid',
                role: 'deformation',
                parameter: 'morph',
                outputRange: [0, 1],
                attack: 0.25,
                release: 0.7,
                curve: 'smooth',
            },
            {
                feature: 'rms',
                role: 'intensity',
                parameter: 'energy',
                outputRange: [0.1, 1],
                attack: 0.08,
                release: 0.45,
                curve: 'sqrt',
            },
            {
                // The mandala's sector rotation and the palette phase both read `uPhase`. As a
                // constant they made the shape a fixed emblem; integrated, it turns and its colour
                // walks at a speed the music sets.
                feature: 'highMid',
                role: 'detail',
                mode: 'rate',
                parameter: 'spin',
                outputRange: [0.08, 1.4],
                attack: 0.2,
                release: 0.9,
                curve: 'smooth',
                wrap: Math.PI * 2,
            },
        ],
        character: character({ geometricOrder: 0.9, visualDensity: 0.4, motionEnergy: 0.25 }),
        activationWeight: 1,
        minimumDuration: 10,
    });
}
