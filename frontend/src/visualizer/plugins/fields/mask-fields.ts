/**
 * Mask-driven fields (spec section 19.4).
 *
 * A mask becomes a signed distance field once, and everything else reads that: containment, boundary
 * deflection, stencilling, glow falloff. Deriving it once and sharing it is why the graph tracks
 * derived-resource reuse.
 *
 * None of these imply a particle system. A mask can shape a stencil or a distortion region with no
 * simulator present at all.
 */

import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import type { RenderPass } from '../../core/passes';
import { QUAD_VERTEX_SHADER } from '../../host/device';

const SDF_SHADER = 'mask-sdf';
const CONTAINMENT_SHADER = 'mask-containment';
const STENCIL_SHADER = 'mask-stencil';
const BOUNDARY_SHADER = 'mask-boundary';

/**
 * Jump-flood would be exact but needs several passes; this samples a ring around each pixel and is a
 * single pass, which is the right trade for a field consumed as a falloff rather than as geometry.
 */
const SDF_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uMask;
uniform vec2 uResolution;
uniform float uThreshold;
uniform float uInvert;
uniform float uSearchRadius;

float maskAt(vec2 uv) {
    float value = texture(uMask, clamp(uv, 0.0, 1.0)).r;
    value = uInvert > 0.5 ? 1.0 - value : value;
    return step(uThreshold, value);
}

void main() {
    float inside = maskAt(vUv);
    float nearest = uSearchRadius;

    // 24 directions is enough for a smooth falloff without the cost of a full jump flood.
    for (int i = 0; i < 24; i += 1) {
        float angle = float(i) / 24.0 * 6.2831853;
        vec2 direction = vec2(cos(angle), sin(angle));

        for (int step_index = 1; step_index <= 12; step_index += 1) {
            float distance = float(step_index) / 12.0 * uSearchRadius;
            // Strictly greater: at the last step the sample distance equals the search radius
            // exactly, and the running minimum starts there, so a non-strict test broke out before
            // ever sampling the outermost ring. The measurable distance stopped at eleven twelfths
            // of the declared radius.
            if (distance > nearest) {
                break;
            }
            if (maskAt(vUv + direction * distance) != inside) {
                nearest = distance;
                break;
            }
        }
    }

    // Signed: negative inside, positive outside, so a consumer can tell containment from proximity.
    float signedDistance = inside > 0.5 ? -nearest : nearest;
    vec2 gradient = vec2(
        maskAt(vUv + vec2(1.0 / uResolution.x, 0.0)) - maskAt(vUv - vec2(1.0 / uResolution.x, 0.0)),
        maskAt(vUv + vec2(0.0, 1.0 / uResolution.y)) - maskAt(vUv - vec2(0.0, 1.0 / uResolution.y))
    );

    fragColor = vec4(signedDistance, gradient, inside);
}`;

/**
 * A ramp falling from one to zero as a signed distance crosses the boundary.
 *
 * Both call sites wrote smoothstep(edge, -edge, x), reversing the edges to invert the ramp. GLSL ES
 * 3.00 leaves the result undefined when edge0 is not less than edge1, and the audit left it on the
 * grounds that every mainstream driver does the intended thing and that changing it without hardware
 * to test on would trade a working behaviour for a guess.
 *
 * That reasoning was wrong twice. Undefined behaviour is not a working behaviour, and this is not a
 * guess: smoothstep's curve is symmetric about its midpoint, so 1 - smoothstep(-e, e, x) is exactly
 * equal to smoothstep(e, -e, x) wherever the latter is defined. The same values, in the form the
 * specification defines.
 *
 * The width is floored because edge0 == edge1 is undefined as well, and a softness or feather of zero
 * is a reachable parameter value rather than a hypothetical one.
 */
const FALLING_RAMP = `
float fallingRamp(float width, float x) {
    float edge = max(width, 1e-4);

    return 1.0 - smoothstep(-edge, edge, x);
}
`;

const CONTAINMENT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uSoftness;
uniform float uOutside;
${FALLING_RAMP}

void main() {
    float signedDistance = texture(uField, vUv).r;
    // Smoothed across the boundary, so a contained system fades rather than clipping.
    float containment = fallingRamp(uSoftness, signedDistance);
    fragColor = vec4(vec3(uOutside > 0.5 ? 1.0 - containment : containment), 1.0);
}`;

const STENCIL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uFeather;
uniform float uEdgeOnly;
${FALLING_RAMP}

void main() {
    float signedDistance = texture(uField, vUv).r;
    float interior = fallingRamp(uFeather, signedDistance);
    // Edge-only routes the effect through a band around the boundary instead of the whole interior.
    float band = 1.0 - smoothstep(0.0, uFeather * 3.0, abs(signedDistance));
    float weight = uEdgeOnly > 0.5 ? band : interior;

    fragColor = texture(uSource, vUv) * weight;
}`;

const BOUNDARY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uStrength;

void main() {
    vec4 field = texture(uField, vUv);
    // The gradient points away from the boundary, which is the deflection direction a simulator wants.
    vec2 normal = length(field.gb) > 0.0001 ? normalize(field.gb) : vec2(0.0);
    float proximity = 1.0 - smoothstep(0.0, 0.15, abs(field.r));

    fragColor = vec4(normal * proximity * uStrength, proximity, 1.0);
}`;

function statelessInstance(
    shaderId: string,
    fragment: string,
    buildPass: (render: Parameters<VisualPluginInstance['render']>[0]) => RenderPass[],
) {
    return (context: Parameters<VisualPluginDefinition['create']>[0]): VisualPluginInstance => ({
        initialize() {
            context.registerShader({ id: shaderId, vertex: QUAD_VERTEX_SHADER, fragment });
        },
        activate() {
            // Derived fields hold no state; they are recomputed from the mask.
        },
        update() {
            // Nothing to advance.
        },
        render: buildPass,
        deactivate() {
            // Nothing retained.
        },
        destroy() {
            // Nothing retained.
        },
    });
}

/** Converts a mask into signed distance, gradient, and interior channels. */
export function createMaskSignedDistanceField(): VisualPluginDefinition {
    return {
        id: 'MaskSignedDistanceField',
        version: 1,
        category: 'field',
        inputs: [{ name: 'mask', type: 'mask-texture', required: true }],
        outputs: [{ name: 'field', type: 'distance-field', required: false }],
        capabilities: ['mask-derivation', 'distance-field'],
        // Medium to generate, low to reuse: one derivation serves every consumer in the scene.
        cost: { gpu: 2, cpu: 0, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0, motionEnergy: 0, geometricOrder: 0.8,
            recognizability: 0.4, persistence: 1, brightness: 0, dominance: 'supporting',
        },
        activationRules: {
            activationWeight: 8,
            requiredAssets: ['mask'],
            prefersWith: ['MaskBoundaryField', 'MaskContainmentField', 'MaskEffectStencil', 'MaskRouter'],
        },
        parameters: { threshold: 0.5, invert: 0, searchRadius: 0.12 },
        defaultBindings: [{
            // The threshold is where the mask's boundary sits, so moving it makes the silhouette
            // breathe — but a silhouette is structure, not detail. Driven from a transient channel
            // across a wide range it swung far enough to take the whole shape past the mask's own
            // tonal range, so the mask flashed into view and vanished again instead of persisting
            // as a scene modifier. Slow role, narrow range: it breathes, it does not blink.
            feature: 'lowMid',
            role: 'deformation',
            parameter: 'threshold',
            outputRange: [0.54, 0.44],
            attack: 0.8,
            release: 2,
            curve: 'smooth',
        }],
        deactivationPolicy: 'immediate',
        create: statelessInstance(SDF_SHADER, SDF_FRAGMENT, (render) => {
            const mask = render.inputs.mask;
            if (!mask) {
                return [];
            }

            // No static uniforms: every one this shader reads is a declared parameter, and the runtime
            // merges the live values over the pass. Restating them here as literals is what made the
            // catalog look reactive while rendering at fixed values.
            return [{
                kind: 'fullscreen',
                shader: SDF_SHADER,
                inputs: { uMask: mask },
                output: render.outputs.field,
                blend: 'none',
                clear: true,
            }];
        }),
    };
}

/** Constrains a visual system inside or outside a mask. */
export function createMaskContainmentField(): VisualPluginDefinition {
    return {
        id: 'MaskContainmentField',
        version: 1,
        category: 'field',
        inputs: [{ name: 'field', type: 'distance-field', required: true }],
        outputs: [{ name: 'containment', type: 'mask-texture', required: false }],
        capabilities: ['mask-derivation', 'containment'],
        cost: { gpu: 1, cpu: 0, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0, motionEnergy: 0, geometricOrder: 0.7,
            recognizability: 0.3, persistence: 1, brightness: 0, dominance: 'supporting',
        },
        activationRules: {
            activationWeight: 5,
            requiredAssets: ['mask'],
            prefersWith: ['MaskSignedDistanceField'],
        },
        parameters: { softness: 0.02, outside: 0 },
        defaultBindings: [{
            // How hard the containment edge is. A loud passage lets what is contained press further
            // past the boundary before it fades.
            feature: 'rms',
            role: 'intensity',
            parameter: 'softness',
            outputRange: [0.012, 0.075],
            attack: 0.12,
            release: 0.5,
            curve: 'smooth',
        }],
        deactivationPolicy: 'fade',
        create: statelessInstance(CONTAINMENT_SHADER, CONTAINMENT_FRAGMENT, (render) => {
            const field = render.inputs.field;
            if (!field) {
                return [];
            }

            return [{
                kind: 'fullscreen',
                shader: CONTAINMENT_SHADER,
                inputs: { uField: field },
                output: render.outputs.containment,
                blend: 'none',
                clear: true,
            }];
        }),
    };
}

/** Routes an effect through a mask, needing no simulation at all. */
export function createMaskEffectStencil(): VisualPluginDefinition {
    return {
        id: 'MaskEffectStencil',
        version: 1,
        category: 'compositor',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            { name: 'field', type: 'distance-field', required: true },
        ],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
        capabilities: ['mask-derivation', 'stencil'],
        cost: { gpu: 1, cpu: 0, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.3, motionEnergy: 0.1, geometricOrder: 0.7,
            recognizability: 0.6, persistence: 0.4, brightness: 0.4, dominance: 'supporting',
        },
        activationRules: {
            activationWeight: 5,
            requiredAssets: ['mask'],
            prefersWith: ['MaskSignedDistanceField'],
        },
        parameters: { feather: 0.03, edgeOnly: 0 },
        defaultBindings: [{
            // Widens the band the effect is routed through, so the stencil's edge shimmers on detail
            // rather than holding one fixed cut.
            feature: 'highMidExcite',
            role: 'detail',
            parameter: 'feather',
            outputRange: [0.014, 0.085],
            attack: 0.05,
            release: 0.4,
            curve: 'sqrt',
        }],
        deactivationPolicy: 'fade',
        create: statelessInstance(STENCIL_SHADER, STENCIL_FRAGMENT, (render) => {
            const source = render.inputs.source;
            const field = render.inputs.field;
            if (!source || !field) {
                return [];
            }

            return [{
                kind: 'fullscreen',
                shader: STENCIL_SHADER,
                inputs: { uSource: source, uField: field },
                output: render.outputs.color,
                // Replaces the target, so the clear changed no pixel and is gone (ADR-0014). What
                // the stencil writes is a transform of the image it read.
                blend: 'none',
                clear: false,
            }];
        }),
    };
}

/** Presents mask edges as a deflection field a simulator can collide against. */
export function createMaskBoundaryField(): VisualPluginDefinition {
    return {
        id: 'MaskBoundaryField',
        version: 1,
        category: 'field',
        inputs: [{ name: 'field', type: 'distance-field', required: true }],
        outputs: [{ name: 'deflection', type: 'collision-field', required: false }],
        capabilities: ['mask-derivation', 'collision'],
        cost: { gpu: 1, cpu: 0, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0, motionEnergy: 0.2, geometricOrder: 0.7,
            recognizability: 0.2, persistence: 1, brightness: 0, dominance: 'supporting',
        },
        activationRules: {
            activationWeight: 7,
            requiredAssets: ['mask'],
            // The mask as a physics surface: this is what particles reflect from.
            prefersWith: ['MaskSignedDistanceField', 'ParticleSimulator'],
        },
        parameters: { strength: 1 },
        defaultBindings: [{
            // This field is both a collision surface for a simulator and, since it is a motion source,
            // one of the vectors the composite drags the accumulated image along. Bass therefore moves
            // the picture away from the mask's edges as well as pushing particles off them — the same
            // large-scale-force row of the section 20 table serving both.
            feature: 'bass',
            role: 'large-scale-force',
            parameter: 'strength',
            outputRange: [0.5, 2.4],
            attack: 0.1,
            release: 0.55,
            curve: 'smooth',
        }],
        deactivationPolicy: 'fade',
        create: statelessInstance(BOUNDARY_SHADER, BOUNDARY_FRAGMENT, (render) => {
            const field = render.inputs.field;
            if (!field) {
                return [];
            }

            return [{
                kind: 'fullscreen',
                shader: BOUNDARY_SHADER,
                inputs: { uField: field },
                output: render.outputs.deflection,
                blend: 'none',
                clear: true,
            }];
        }),
    };
}
