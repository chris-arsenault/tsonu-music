/**
 * Coordinate and image transformers (spec section 19.8).
 *
 * Each modifies an existing layer rather than producing material, so all of them require a colour input
 * and emit nothing without one. `SymmetryTransform` declares the `symmetry` capability the grammar caps,
 * since stacking two of them reads as noise rather than as order.
 */

import { character, defineShaderPlugin, GLSL_COMMON, GLSL_HISTORY } from '../define';
import type { VisualPluginDefinition } from '../../core/plugin';

const SYMMETRY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uMode;
uniform float uSectors;
uniform float uPhase;
${GLSL_COMMON}

void main() {
    vec2 p = vUv - 0.5;

    if (uMode < 0.5) {                       // horizontal mirror
        p.x = abs(p.x);
    } else if (uMode < 1.5) {                // vertical mirror
        p.y = abs(p.y);
    } else if (uMode < 2.5) {                // bilateral: mirrored across the leading diagonal
        // Was byte-identical to the horizontal mirror above, so two separately registered plugins
        // were the same transform and a mutation could swap one for the other with no visible
        // change. Bilateral symmetry folds about an axis the other two modes do not offer.
        if (p.y > p.x) {
            p = p.yx;
        }
    } else if (uMode < 3.5) {                // four-way
        p = abs(p);
    } else if (uMode < 4.5) {                // kaleidoscope
        float angle = atan(p.y, p.x) + uPhase;
        float radius = length(p);
        float segment = 6.2831853 / max(uSectors, 2.0);
        angle = abs(mod(angle, segment) - segment * 0.5);
        p = vec2(cos(angle), sin(angle)) * radius;
    } else if (uMode < 5.5) {                // radial sector repetition
        float angle = atan(p.y, p.x) + uPhase;
        float radius = length(p);
        float segment = 6.2831853 / max(uSectors, 2.0);
        angle = mod(angle, segment);
        p = vec2(cos(angle), sin(angle)) * radius;
    } else if (uMode < 6.5) {                // rotational symmetry
        float angle = atan(p.y, p.x);
        float radius = length(p);
        float segment = 6.2831853 / max(uSectors, 2.0);
        p = vec2(cos(mod(angle, segment) + uPhase), sin(mod(angle, segment) + uPhase)) * radius;
    } else {                                 // dihedral
        float angle = atan(p.y, p.x);
        float radius = length(p);
        float segment = 6.2831853 / max(uSectors, 2.0);
        angle = abs(mod(angle + uPhase, segment) - segment * 0.5);
        p = vec2(cos(angle), sin(angle)) * radius;
        p.x = abs(p.x);
    }

    fragColor = texture(uSource, clamp(p + 0.5, 0.0, 1.0));
}`;

const COORDINATE_WARP_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uMode;
uniform float uAmount;
uniform float uTime;
${GLSL_COMMON}

void main() {
    vec2 p = vUv - 0.5;
    float radius = length(p);
    float angle = atan(p.y, p.x);

    if (uMode < 0.5) {                       // polar
        float ripple = sin(radius * 18.0 - uTime * 0.7) * uAmount * 0.04;
        p = vec2(angle / 6.2831853 + 0.5 + ripple, radius * (1.0 + uAmount * 0.12)) - 0.5;
    } else if (uMode < 1.5) {                // log-polar tunnel
        p = vec2(angle / 6.2831853, log(max(radius, 0.001)) * 0.25 + uTime * 0.1) - 0.5;
    } else if (uMode < 2.5) {                // twirl
        p = rotate(p, uAmount * (1.0 - radius * 2.0));
    } else if (uMode < 3.5) {                // bulge
        p *= 1.0 - uAmount * (1.0 - radius);
    } else if (uMode < 4.5) {                // pinch
        p *= 1.0 + uAmount * (1.0 - radius);
    } else if (uMode < 5.5) {                // fisheye
        p *= 1.0 + uAmount * radius * radius;
    } else if (uMode < 6.5) {                // wave warp
        p += vec2(sin(p.y * 14.0 + uTime * 2.0), sin(p.x * 14.0 - uTime * 1.7)) * uAmount * 0.06;
    } else if (uMode < 7.5) {                // barrel
        p *= 1.0 - uAmount * 0.4 * radius * radius;
    } else {                                 // perspective fold
        p.x += p.y * uAmount * 0.3;
    }

    fragColor = texture(uSource, clamp(p + 0.5, 0.0, 1.0));
}`;

/**
 * The displacement the warp above applies, published rather than discarded (ADR-0012).
 *
 * The same nine branches produce the same `p`, and where the source is read *from* against where it
 * is written *to* is exactly a displacement. Applied once to freshly generated material that is a
 * distortion; read by a feedback warp and applied to what it produced last frame, it compounds.
 *
 * Sign is reversed against the sampling offset: the pass above reads at `p` and writes at `vUv`, so
 * material travels from `p` toward `vUv`, and a field is a velocity — it points where the material
 * is going.
 */
const COORDINATE_WARP_MOTION = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uMode;
uniform float uAmount;
uniform float uTime;
${GLSL_COMMON}

/** How much of the warp is expressed per second. A warp is a position; a field is a rate. */
const float WARP_RATE = 1.4;

void main() {
    vec2 p = vUv - 0.5;
    float radius = length(p);
    float angle = atan(p.y, p.x);

    if (uMode < 0.5) {
        float ripple = sin(radius * 18.0 - uTime * 0.7) * uAmount * 0.04;
        p = vec2(angle / 6.2831853 + 0.5 + ripple, radius * (1.0 + uAmount * 0.12)) - 0.5;
    } else if (uMode < 1.5) {
        p = vec2(angle / 6.2831853, log(max(radius, 0.001)) * 0.25 + uTime * 0.1) - 0.5;
    } else if (uMode < 2.5) {
        p = rotate(p, uAmount * (1.0 - radius * 2.0));
    } else if (uMode < 3.5) {
        p *= 1.0 - uAmount * (1.0 - radius);
    } else if (uMode < 4.5) {
        p *= 1.0 + uAmount * (1.0 - radius);
    } else if (uMode < 5.5) {
        p *= 1.0 + uAmount * radius * radius;
    } else if (uMode < 6.5) {
        p += vec2(sin(p.y * 14.0 + uTime * 2.0), sin(p.x * 14.0 - uTime * 1.7)) * uAmount * 0.06;
    } else if (uMode < 7.5) {
        p *= 1.0 - uAmount * 0.4 * radius * radius;
    } else {
        p.x += p.y * uAmount * 0.3;
    }

    // The two polar modes rewrite the coordinate outright rather than nudging it, so their
    // difference spans the frame rather than describing a local displacement. Bounded so one mode
    // cannot dominate every field it is read beside.
    vec2 field = clamp(((vUv - 0.5) - p) * WARP_RATE, vec2(-2.0), vec2(2.0));

    fragColor = vec4(field, length(field), 1.0);
}`;

const DOMAIN_WARP_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uMode;
uniform float uAmount;
${GLSL_COMMON}

void main() {
    vec4 driver = texture(uField, vUv);
    vec2 offset;

    if (uMode < 0.5) {                       // luminance displacement
        offset = vec2(luminance(driver.rgb) - 0.5) * uAmount * 0.2;
    } else if (uMode < 1.5) {                // vector displacement
        offset = driver.rg * uAmount * 0.1;
    } else if (uMode < 2.5) {                // angular displacement
        float angle = (luminance(driver.rgb) - 0.5) * uAmount * 3.0;
        offset = rotate(vUv - 0.5, angle) - (vUv - 0.5);
    } else if (uMode < 3.5) {                // scale modulation
        offset = (vUv - 0.5) * (luminance(driver.rgb) - 0.5) * uAmount * 0.4;
    } else if (uMode < 4.5) {                // rotation modulation
        offset = rotate(vUv - 0.5, driver.r * uAmount) - (vUv - 0.5);
    } else {                                 // local zoom
        offset = -(vUv - 0.5) * luminance(driver.rgb) * uAmount * 0.3;
    }

    fragColor = texture(uSource, clamp(vUv + offset, 0.0, 1.0));
}`;

const TILING_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uMode;
uniform float uRepeat;
uniform float uTime;
${GLSL_COMMON}

void main() {
    vec2 p = vUv;
    float repeat = max(uRepeat, 1.0);

    if (uMode < 0.5) {                       // repeat
        p = fract(p * repeat);
    } else if (uMode < 1.5) {                // mirror repeat
        vec2 scaled = p * repeat;
        p = abs(mod(scaled, 2.0) - 1.0);
    } else if (uMode < 2.5) {                // brick offset
        vec2 scaled = p * repeat;
        scaled.x += floor(scaled.y) * 0.5;
        p = fract(scaled);
    } else if (uMode < 3.5) {                // polar tiles
        vec2 centred = p - 0.5;
        float angle = atan(centred.y, centred.x);
        p = fract(vec2(angle / 6.2831853 * repeat, length(centred) * repeat));
    } else if (uMode < 4.5) {                // hex-like
        vec2 scaled = p * repeat;
        scaled.x += mod(floor(scaled.y), 2.0) * 0.5;
        p = fract(scaled);
    } else if (uMode < 5.5) {                // infinite zoom lattice
        float zoom = fract(uTime * 0.1);
        p = fract((p - 0.5) * exp2(zoom) * repeat + 0.5);
    } else if (uMode < 6.5) {                // recursive frames
        vec2 centred = abs(p - 0.5) * 2.0;
        float ring = floor(max(centred.x, centred.y) * repeat);
        p = fract((p - 0.5) * (1.0 + ring * 0.4) + 0.5);
    } else {                                 // truchet-like orientation
        vec2 scaled = p * repeat;
        vec2 cell = floor(scaled);
        vec2 local = fract(scaled);
        p = hash(cell) > 0.5 ? local : vec2(local.y, 1.0 - local.x);
    }

    fragColor = texture(uSource, clamp(p, 0.0, 1.0));
}`;

const EDGE_CONTOUR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uMode;
uniform float uStrength;
${GLSL_COMMON}

void main() {
    vec2 texel = 1.0 / uResolution;
    vec3 centre = texture(uSource, vUv).rgb;

    float l00 = luminance(texture(uSource, vUv + texel * vec2(-1.0, -1.0)).rgb);
    float l10 = luminance(texture(uSource, vUv + texel * vec2(0.0, -1.0)).rgb);
    float l20 = luminance(texture(uSource, vUv + texel * vec2(1.0, -1.0)).rgb);
    float l01 = luminance(texture(uSource, vUv + texel * vec2(-1.0, 0.0)).rgb);
    float l21 = luminance(texture(uSource, vUv + texel * vec2(1.0, 0.0)).rgb);
    float l02 = luminance(texture(uSource, vUv + texel * vec2(-1.0, 1.0)).rgb);
    float l12 = luminance(texture(uSource, vUv + texel * vec2(0.0, 1.0)).rgb);
    float l22 = luminance(texture(uSource, vUv + texel * vec2(1.0, 1.0)).rgb);

    float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
    float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
    float edge = length(vec2(gx, gy)) * uStrength;

    if (uMode < 0.5) {                       // sobel contour
        fragColor = vec4(vec3(edge), 1.0);
    } else if (uMode < 1.5) {                // luminous edge
        fragColor = vec4(centre + vec3(edge), 1.0);
    } else if (uMode < 2.5) {                // embossed
        fragColor = vec4(vec3(0.5 + (gx + gy) * uStrength * 0.5), 1.0);
    } else if (uMode < 3.5) {                // gradient coloured
        fragColor = vec4(vec3(abs(gx), abs(gy), edge) * uStrength, 1.0);
    } else if (uMode < 4.5) {                // repeated edge feedback
        fragColor = vec4(centre * 0.4 + vec3(edge) * 0.9, 1.0);
    } else {                                 // edge stencil
        float mask = smoothstep(0.1, 0.4, edge);
        fragColor = vec4(centre * mask, mask);
    }
}`;

const SHOCKWAVE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uMode;
uniform float uAmount;
uniform float uRadius;
uniform vec2 uCentre;
uniform vec2 uImpactCentre;
uniform float uImpactRadius;
uniform float uImpactEnergy;
${GLSL_COMMON}

void main() {
    // A live impact wins: the ring is centred where the collision happened and travels outward with it.
    // With no impact, spectral flux drives a ring from the centre so the transform still responds to audio.
    bool hasImpact = uImpactEnergy > 0.001;
    vec2 centre = hasImpact ? uImpactCentre : uCentre;
    float ringRadius = hasImpact ? uImpactRadius : uRadius;
    float strength = uAmount * (hasImpact ? clamp(uImpactEnergy, 0.0, 2.0) : 1.0);

    vec2 toCentre = vUv - centre;
    float distance = length(toCentre);
    // A band travelling outward, rather than a global distortion.
    float band = 1.0 - smoothstep(0.0, 0.14, abs(distance - ringRadius));
    vec2 direction = normalize(toCentre + 1e-5);
    vec2 offset = vec2(0.0);

    if (uMode < 0.5) {                       // radial bulge
        offset = direction * band * strength * 0.08;
    } else if (uMode < 1.5) {                // compression ring
        offset = -direction * band * strength * 0.06;
    } else if (uMode < 2.5) {                // refraction ring
        offset = direction * band * strength * 0.05 * sin(distance * 40.0);
    } else if (uMode < 3.5) {                // chromatic shock
        float shift = band * strength * 0.02;
        fragColor = vec4(
            texture(uSource, clamp(vUv + direction * shift, 0.0, 1.0)).r,
            texture(uSource, vUv).g,
            texture(uSource, clamp(vUv - direction * shift, 0.0, 1.0)).b,
            1.0
        );
        return;
    } else if (uMode < 4.5) {                // directional blast
        offset = vec2(band * strength * 0.09, 0.0);
    } else {                                 // gravitational lens
        offset = -direction * strength * 0.05 / max(distance * distance, 0.02);
    }

    fragColor = texture(uSource, clamp(vUv + offset, 0.0, 1.0));
}`;

export const SYMMETRY_MODES = [
    'horizontal', 'vertical', 'bilateral', 'four-way', 'kaleidoscope', 'radial-sector', 'rotational', 'dihedral',
] as const;

export const COORDINATE_WARP_MODES = [
    'polar', 'log-polar', 'twirl', 'bulge', 'pinch', 'fisheye', 'wave', 'barrel', 'fold',
] as const;

export const DOMAIN_WARP_MODES = [
    'luminance', 'vector', 'angular', 'scale', 'rotation', 'local-zoom',
] as const;

export const TILING_MODES = [
    'repeat', 'mirror', 'brick', 'polar', 'hex', 'infinite-zoom', 'recursive-frames', 'truchet',
] as const;

export const EDGE_CONTOUR_MODES = [
    'sobel', 'luminous', 'emboss', 'gradient-colour', 'edge-feedback', 'stencil',
] as const;

export const SHOCKWAVE_MODES = [
    'bulge', 'compression', 'refraction', 'chromatic', 'directional', 'lens',
] as const;

export function createSymmetryTransform(
    mode: typeof SYMMETRY_MODES[number] = 'kaleidoscope',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `SymmetryTransform:${mode}`,
        category: 'transformer',
        inputs: [{ name: 'source', type: 'color-texture', required: true }],
        outputs: [{ name: 'color', type: 'color-texture' }],
        // Declared so the grammar's symmetry cap applies; two stacked read as noise.
        capabilities: ['symmetry'],
        fragment: SYMMETRY_FRAGMENT,
        uniforms: { uMode: SYMMETRY_MODES.indexOf(mode), uSectors: 6 },
        parameters: { sectors: 6, spin: 0 },
        bindings: [
            {
                feature: 'beatPhase',
                role: 'repeating-motion',
                parameter: 'sectors',
                outputRange: [4, 10],
                attack: 0.4,
                release: 0.8,
                curve: 'smooth',
            },
            {
                // Every angular mode offsets by `uPhase`, which was a per-instance constant — the
                // kaleidoscope held one fixed orientation for as long as it was on screen. Bound as a
                // rate, the midrange sets how fast the symmetry axis turns, per section 20's
                // midrange-to-rotation row.
                feature: 'mid',
                role: 'deformation',
                mode: 'rate',
                parameter: 'spin',
                outputRange: [0.05, 0.9],
                attack: 0.3,
                release: 1,
                curve: 'smooth',
                wrap: Math.PI * 2,
            },
        ],
        character: character({ geometricOrder: 0.95, visualDensity: 0.6, motionEnergy: 0.3 }),
        activationWeight: 1.2,
        minimumDuration: 14,
    });
}

export function createCoordinateWarpTransform(
    mode: typeof COORDINATE_WARP_MODES[number] = 'twirl',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `CoordinateWarpTransform:${mode}`,
        category: 'transformer',
        inputs: [{ name: 'source', type: 'color-texture', required: true }],
        outputs: [
            { name: 'color', type: 'color-texture' },
            // What it did to the coordinates, for anything that wants to do the same to something
            // else — a feedback warp most usefully, which is where the compounding comes from.
            { name: 'motion', type: 'vector-field' },
        ],
        capabilities: ['coordinate-warp', 'vector-field'],
        fragment: COORDINATE_WARP_FRAGMENT,
        motion: { port: 'motion', fragment: COORDINATE_WARP_MOTION },
        uniforms: { uMode: COORDINATE_WARP_MODES.indexOf(mode), uAmount: 0.4 },
        parameters: { amount: 0.4 },
        bindings: [{
            feature: 'lowMid',
            parameter: 'amount',
            outputRange: [0.1, 0.9],
            attack: 0.12,
            release: 0.5,
            curve: 'smooth',
        }],
        character: character({ geometricOrder: 0.6, motionEnergy: 0.5, visualDensity: 0.5 }),
        activationWeight: 1.2,
        minimumDuration: 10,
    });
}

export function createDomainWarpTransform(
    mode: typeof DOMAIN_WARP_MODES[number] = 'vector',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `DomainWarpTransform:${mode}`,
        category: 'transformer',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            // Uses one source or field to distort another, so the driver is required.
            { name: 'field', type: 'vector-field', required: true },
        ],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['domain-warp'],
        fragment: DOMAIN_WARP_FRAGMENT,
        uniforms: { uMode: DOMAIN_WARP_MODES.indexOf(mode), uAmount: 1 },
        parameters: { amount: 1 },
        bindings: [{
            feature: 'mid',
            parameter: 'amount',
            outputRange: [0.3, 2],
            attack: 0.1,
            release: 0.45,
            curve: 'smooth',
        }],
        character: character({ geometricOrder: 0.3, motionEnergy: 0.65, visualDensity: 0.6 }),
        gpuCost: 2,
        activationWeight: 1.2,
    });
}

export function createTilingTransform(
    mode: typeof TILING_MODES[number] = 'mirror',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `TilingTransform:${mode}`,
        category: 'transformer',
        inputs: [{ name: 'source', type: 'color-texture', required: true }],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['tiling'],
        fragment: TILING_FRAGMENT,
        uniforms: { uMode: TILING_MODES.indexOf(mode), uRepeat: 3 },
        parameters: { repeat: 3 },
        bindings: [{
            // The lattice count. Left static this transform produced one fixed tiling for as long as
            // it was on screen.
            feature: 'lowMid',
            role: 'deformation',
            parameter: 'repeat',
            outputRange: [2, 6],
            attack: 0.6,
            release: 1.5,
            curve: 'smooth',
        }],
        character: character({ geometricOrder: 0.85, visualDensity: 0.75, motionEnergy: 0.25 }),
        // Low: a lattice applies one decision everywhere, and the frame stops reading as a scene
        // rather than as wallpaper. It should be an occasional device, not a default.
        activationWeight: 0.3,
        minimumDuration: 12,
    });
}

export function createEdgeContourTransform(
    mode: typeof EDGE_CONTOUR_MODES[number] = 'luminous',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `EdgeContourTransform:${mode}`,
        category: 'transformer',
        inputs: [{ name: 'source', type: 'color-texture', required: true }],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['edge-contour'],
        fragment: EDGE_CONTOUR_FRAGMENT,
        uniforms: { uMode: EDGE_CONTOUR_MODES.indexOf(mode), uStrength: 1.4 },
        parameters: { strength: 1.4 },
        bindings: [{
            feature: 'treble',
            parameter: 'strength',
            outputRange: [0.7, 2.6],
            attack: 0.03,
            release: 0.3,
            curve: 'sqrt',
        }],
        character: character({ geometricOrder: 0.7, visualDensity: 0.45, brightness: 0.6 }),
        activationWeight: 1,
    });
}

export function createShockwaveTransform(
    mode: typeof SHOCKWAVE_MODES[number] = 'bulge',
): VisualPluginDefinition {
    // Declares impact consumption and actually reads the bus: the ring is centred on the strongest live
    // impact and its radius grows with that impact's age, so a collision elsewhere in the scene distorts
    // this layer where it happened.
    return defineShaderPlugin({
        impactDriven: true,
        id: `ShockwaveTransform:${mode}`,
        category: 'transformer',
        inputs: [{ name: 'source', type: 'color-texture', required: true }],
        outputs: [{ name: 'color', type: 'color-texture' }],
        // Consumes impacts and onsets, which is why it belongs beside the impact simulator.
        capabilities: ['shockwave', 'impact-consumer'],
        fragment: SHOCKWAVE_FRAGMENT,
        uniforms: { uMode: SHOCKWAVE_MODES.indexOf(mode), uAmount: 1, uRadius: 0.3, uCentre: [0.5, 0.5] },
        parameters: { amount: 1, radius: 0.3 },
        bindings: [{
            feature: 'onset',
            role: 'burst',
            mode: 'impulse',
            parameter: 'amount',
            outputRange: [0.2, 1.8],
            attack: 0.01,
            release: 0.3,
            curve: 'sqrt',
        }, {
            feature: 'spectralFlux',
            role: 'burst',
            parameter: 'radius',
            outputRange: [0.05, 0.85],
            attack: 0.02,
            release: 0.5,
            curve: 'linear',
        }],
        character: character({ motionEnergy: 0.8, geometricOrder: 0.5, persistence: 0.1 }),
        activationWeight: 1,
        prefersWith: ['ImpactCascadeSimulator'],
    });
}

/* -------------------------------------------------------------------------- */
/* Temporal transform (spec section 19.8, section 24 secondary scope)          */
/* -------------------------------------------------------------------------- */

/**
 * Bounded frame history, read at an offset that varies across the image.
 *
 * Every other transformer here rewrites the current frame. This one is the first plugin to consume
 * `historyDepth` — a value the quality ladder has always computed and threaded through `FrameContext`
 * that nothing read — and it is the first to make *when* a pixel came from a spatial property. A slit
 * scan reading one column per frame and a delayed mirror reflecting the past against the present are
 * the same operation with a different offset function.
 *
 * The kernel's accumulation buffer holds one blended history; this holds several discrete ones, so the
 * two are complementary rather than redundant: accumulation smears, this one quotes.
 */
const TEMPORAL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uHistory;
uniform vec2 uResolution;
uniform float uMode;
uniform float uTime;
uniform float uPhase;
uniform float uAmount;
/** Frames of history the quality ladder permits, normalized against the full-quality depth. */
uniform float uDepth;
uniform float uDecay;
uniform float uDelta;
${GLSL_COMMON}
${GLSL_HISTORY}

void main() {
    vec4 present = texture(uSource, vUv);
    // The history texture holds one more generation of the past each frame. Attenuation and the
    // bound come from the shared helper; what stays here is the ladder's permitted depth, which
    // reduces how much of the past survives at lower quality rather than how fast it decays.
    float retain = clamp(0.55 + uDepth * 0.42, 0.0, 1.0);

    vec2 tap = vUv;
    float mix_weight = uAmount;

    if (uMode < 0.5) {                       // echo
        tap = vUv;
    } else if (uMode < 1.5) {                // multi-tap delay
        // Three taps at diminishing offsets read three different depths of the same history.
        vec3 taps = vec3(
            luminance(history(uHistory, vUv + vec2(0.012, 0.0), uDecay, uDelta).rgb),
            luminance(history(uHistory, vUv + vec2(-0.008, 0.006), uDecay, uDelta).rgb),
            luminance(history(uHistory, vUv + vec2(0.004, -0.010), uDecay, uDelta).rgb)
        );
        float delayed = dot(taps, vec3(0.5, 0.32, 0.18));
        fragColor = vec4(mix(present.rgb, present.rgb + vec3(delayed) * retain, uAmount), present.a);
        return;
    } else if (uMode < 2.5) {                // slit scan
        // One moving column is present; everything else is held from history.
        float slit = fract(uTime * 0.11 + uPhase);
        mix_weight = abs(vUv.x - slit) < 0.012 ? 0.0 : uAmount;
    } else if (uMode < 3.5) {                // time slices
        // Horizontal bands each quote a different generation.
        float band = floor(vUv.y * 9.0);
        tap = vUv + vec2(mod(band, 3.0) * 0.006 * uAmount, 0.0);
    } else if (uMode < 4.5) {                // directional smear
        tap = vUv - vec2(cos(uPhase), sin(uPhase)) * 0.01 * uAmount;
    } else if (uMode < 5.5) {                // frame mosaic
        vec2 cell = floor(vUv * 4.0);
        tap = vUv + (hash(cell) - 0.5) * 0.02 * uAmount;
    } else if (uMode < 6.5) {                // delayed mirror
        // The past reflected against the present, which is what makes the two readable as separate.
        tap = vec2(1.0 - vUv.x, vUv.y);
    } else if (uMode < 7.5) {                // temporal difference
        vec3 past = history(uHistory, vUv, uDecay, uDelta).rgb;
        fragColor = vec4(mix(present.rgb, abs(present.rgb - past * retain) * 2.0, uAmount), present.a);
        return;
    } else {                                 // frozen fragments
        // Cells whose hash falls below the threshold stop updating and hold whatever they last had.
        vec2 cell = floor(vUv * 12.0);
        mix_weight = hash(cell + floor(uTime * 0.25)) < uAmount * 0.5 ? 1.0 : 0.0;
    }

    vec3 past = history(uHistory, tap, uDecay, uDelta).rgb * retain;
    fragColor = vec4(mix(present.rgb, max(present.rgb, past), mix_weight), present.a);
}`;

export const TEMPORAL_MODES = [
    'echo', 'multi-tap', 'slit-scan', 'time-slices', 'directional-smear',
    'frame-mosaic', 'delayed-mirror', 'temporal-difference', 'frozen-fragments',
] as const;

export function createTemporalTransform(
    mode: typeof TEMPORAL_MODES[number] = 'echo',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `TemporalTransform:${mode}`,
        category: 'transformer',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            { name: 'history', type: 'color-texture', required: false },
        ],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['feedback', 'temporal'],
        fragment: TEMPORAL_FRAGMENT,
        historyDriven: true,
        uniforms: { uMode: TEMPORAL_MODES.indexOf(mode), uDecay: 0.06 },
        // `depth` is the ladder's to set, not a parameter: `historyDriven` supplies it.
        parameters: { amount: 0.55, decay: 0.06 },
        bindings: [{
            // How much of the past is quoted. Midrange rather than a transient measure, so the effect
            // develops over a phrase instead of flickering on every hit.
            feature: 'mid',
            role: 'deformation',
            parameter: 'amount',
            outputRange: [0.2, 0.9],
            attack: 0.2,
            release: 0.7,
            curve: 'smooth',
        }, {
            // How long the past lasts, as the fraction surviving one second. Separate from how much
            // of it is quoted: a short echo quoted heavily and a long one quoted faintly are
            // different effects, and one parameter could only reach the diagonal between them.
            feature: 'lowMid',
            role: 'deformation',
            parameter: 'decay',
            outputRange: [0.005, 0.3],
            attack: 0.4,
            release: 1.3,
            curve: 'smooth',
        }],
        character: character({
            persistence: 0.85,
            motionEnergy: 0.55,
            visualDensity: 0.5,
            geometricOrder: 0.35,
            dominance: 'supporting',
        }),
        gpuCost: 2,
        memoryCost: 2,
        // Reads its own previous output: the history is the plugin's own past, not the scene's.
        feedbackPort: 'history',
        // Accumulating into the target is the point, as for every other feedback-capable plugin.
        clear: false,
        deactivationPolicy: 'freeze-and-dissolve',
        activationWeight: 1.1,
        minimumDuration: 14,
    });
}
