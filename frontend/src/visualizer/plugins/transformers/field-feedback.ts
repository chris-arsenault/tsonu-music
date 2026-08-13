/**
 * `FieldAdvectTransform` — displacement, and only displacement (ADR-0013).
 *
 * This was `FieldFeedbackTransform`, which did three jobs in one fragment: read a historical texture,
 * displace it along a field, and combine the result with a source. Fusing them is why it had to carry
 * its own combine, and why that combine had to be convex — a plugin that closes its own loop is the
 * only thing standing between the scene and a runaway, so it cannot be allowed to amplify. A convex
 * combine cannot accumulate: its weights sum to one however many frames it runs for, so the steady
 * state held exactly one copy of its source, motion-blurred along the flow. Reported as a picture that
 * pulses in place, which is what it was.
 *
 * Split apart, the loop is wired rather than hardcoded. This plugin resamples; a blend node combines;
 * the cycle's loss lives in the blend's source weight where `core/loop-gain.ts` can see it. The
 * displacement in the loop can now be any transform in the catalog, and the combine any mode the
 * mixer has, which is the composition the previous shape allowed exactly one of.
 *
 * It declares no gain, and that is not an omission. Resampling moves material without diminishing it,
 * so a cycle made of warps alone has unity gain and never settles — something else on the loop has to
 * be the lossy element, and making that explicit is the point of the contract.
 */

import { character, defineShaderPlugin, GLSL_COMMON, GLSL_RESAMPLE } from '../define';
import { SPATIAL_FEEDBACK } from '../../core/grammar';
import type { VisualPluginDefinition } from '../../core/plugin';

/**
 * Where this pixel reads from, shared between the colour pass and the motion pass.
 *
 * A field is a velocity in UV per second, so the offset is a distance only once multiplied by the
 * frame's own delta. Gathered from behind along the field, so material travels forward along it:
 * reading from where it came from is what moves it, and reading from where it is going drags it
 * backwards.
 */
const SOURCE_COORD = `
vec2 sourceCoord(vec2 uv) {
    vec2 field = texture(uField, uv).xy;

    return clamp(uv - field * uMotionScale * max(uDelta, 0.0), 0.0, 1.0);
}
`;

const UNIFORMS = `
uniform sampler2D uSource;
uniform sampler2D uField;
uniform vec2 uResolution;
/** UV travelled per second per unit of field magnitude. */
uniform float uMotionScale;
uniform float uDelta;
`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${UNIFORMS}
${GLSL_COMMON}
${GLSL_RESAMPLE}
${SOURCE_COORD}

void main() {
    // Unfiltered: this plugin recirculates, so a bilinear tap here is a blur applied once a frame
    // for the life of the material. See the resample helper.
    fragColor = resample(uSource, sourceCoord(vUv));
}`;

const MOTION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${UNIFORMS}
${GLSL_COMMON}
${SOURCE_COORD}

void main() {
    vec2 field = clamp((vUv - sourceCoord(vUv)) * 1.4, vec2(-2.0), vec2(2.0));

    fragColor = vec4(field, length(field), 1.0);
}`;

export function createFieldAdvectTransform(): VisualPluginDefinition {
    return defineShaderPlugin({
        id: 'FieldAdvectTransform',
        category: 'transformer',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            // Required. Without a field this plugin is a copy, and a copy in a loop is a loop that
            // remembers without moving — which is the failure the whole apparatus exists to avoid.
            { name: 'field', type: 'vector-field', required: true },
        ],
        outputs: [
            { name: 'color', type: 'color-texture' },
            { name: 'motion', type: 'vector-field' },
        ],
        capabilities: [SPATIAL_FEEDBACK, 'field-composition'],
        fragment: FRAGMENT,
        motion: { port: 'motion', fragment: MOTION_FRAGMENT },
        uniforms: { uMotionScale: 0.45 },
        parameters: { motionScale: 0.45 },
        bindings: [
            {
                // How far the image is dragged per second. Large-scale force, per the section 20
                // table, and the parameter the music has the most to say about here.
                //
                // What a cycle through this plugin travels before it fades is this times the number
                // of frames the loop's gain keeps material alive for, so this and a blend's source
                // weight are the two numbers that decide whether a scene reads as a smear or a tunnel.
                feature: 'bass',
                role: 'large-scale-force',
                parameter: 'motionScale',
                outputRange: [0.08, 1.4],
                attack: 0.1,
                release: 0.6,
                curve: 'smooth',
            },
        ],
        character: character({
            motionEnergy: 0.85,
            persistence: 0.9,
            visualDensity: 0.55,
            geometricOrder: 0.3,
            brightness: 0.5,
            dominance: 'supporting',
        }),
        gpuCost: 2,
        memoryCost: 1,
        minimumDuration: 14,
        // Comparable to the warp families rather than far above them. At a weight of five this
        // plugin's predecessor won its draw in 87 percent of scenes and left the nine warp modes
        // sharing thirteen. A guarantee that something is present is not a reason for it to be the
        // only thing present.
        activationWeight: 1.4,
        prefersWith: [
            'ProceduralVectorField:curl',
            'AudioImpulseField:centre-shockwave',
            'MaskBoundaryField',
            'ParticleRenderer:discs',
            'CoordinateWarpTransform:twirl',
        ],
    });
}
