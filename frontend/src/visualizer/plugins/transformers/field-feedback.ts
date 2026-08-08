/**
 * `FieldFeedbackTransform` — the drag, as a plugin (ADR-0012).
 *
 * The kernel used to own this: `PERSISTENCE_SHADER` gathered the accumulation from
 * `vUv − field · scale · dt` and no other operation on the accumulated image was possible. A
 * displacement is a visual behaviour and visual behaviours are plugins, so it lives here, in a
 * position any other plugin could occupy instead — a blur, a threshold, a colour operation, a second
 * mixer. The kernel keeps the guarantee that a scene has memory at all.
 *
 * What makes this the plugin the tunnels come from is the loop rather than the warp. A displacement
 * applied once to freshly generated material is a distortion. The same displacement applied to what
 * it produced last frame, three hundred frames running, is flow — and a two percent per-frame
 * excursion the music drives compounds into something the eye reads as large.
 */

import { character, defineShaderPlugin, GLSL_COMMON, GLSL_HISTORY } from '../define';
import { SPATIAL_FEEDBACK } from '../../core/grammar';
import type { VisualPluginDefinition } from '../../core/plugin';

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uHistory;
uniform sampler2D uField;
uniform vec2 uResolution;
/** UV travelled per second per unit of field magnitude. */
uniform float uMotionScale;
/** Fraction of the history surviving one second. */
uniform float uDecay;
uniform float uDelta;
${GLSL_COMMON}
${GLSL_HISTORY}

void main() {
    vec2 field = texture(uField, vUv).xy;

    // Gathered from behind along the field, so material travels forward along it. Reading from
    // where it came from is what moves it; reading from where it is going drags it backwards.
    vec2 offset = -field * uMotionScale * max(uDelta, 0.0);
    vec4 past = history(uHistory, vUv + offset, uDecay, uDelta);
    vec4 incoming = texture(uSource, vUv);

    // A leaky integrator whose survival and injection are complements, so a static image converges
    // to exactly itself and the trail comes from the warp rather than from a build-up. Screen has no
    // fixed point and climbs to white, which ADR-0007 recorded on a real device.
    float survival = uDelta > 0.0 ? pow(clamp(uDecay, 0.0, 1.0), uDelta) : 1.0;

    fragColor = past + incoming * (1.0 - survival);
}`;

export function createFieldFeedbackTransform(): VisualPluginDefinition {
    return defineShaderPlugin({
        id: 'FieldFeedbackTransform',
        category: 'transformer',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            // Required, unlike the vector-field mode of `FeedbackFlowTransform` whose field is
            // optional and unread by eight of its nine modes. Without a field this plugin is a plain
            // decay, which the kernel already provides.
            { name: 'field', type: 'vector-field', required: true },
            { name: 'history', type: 'color-texture', required: false },
        ],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['feedback', SPATIAL_FEEDBACK, 'field-composition'],
        fragment: FRAGMENT,
        uniforms: { uMotionScale: 0.45, uDecay: 0.12 },
        parameters: { motionScale: 0.45, decay: 0.12 },
        bindings: [
            {
                // How far the image is dragged. Large-scale force, per the section 20 table, and
                // the parameter the music has the most to say about here.
                feature: 'bass',
                role: 'large-scale-force',
                parameter: 'motionScale',
                outputRange: [0.08, 1.4],
                attack: 0.1,
                release: 0.6,
                curve: 'smooth',
            },
            {
                // How long the dragged material lasts. Short, and the flow is a smear behind the
                // present frame; long, and it is a standing structure the present frame writes into.
                feature: 'lowMid',
                role: 'deformation',
                parameter: 'decay',
                outputRange: [0.02, 0.55],
                attack: 0.4,
                release: 1.4,
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
        memoryCost: 2,
        feedbackPort: 'history',
        // Accumulating into the target is the point, as for every other loop-closing plugin.
        clear: false,
        deactivationPolicy: 'handoff-feedback',
        // Comparable to the whole `FeedbackFlowTransform` family rather than far above it. This
        // replaces a kernel stage every scene used to get for free, so it has to be reachable — but
        // `requireSpatialLoop` already guarantees a scene gets *a* spatial loop, and at a weight of
        // five this plugin won that draw in 87 percent of scenes and left the nine warp modes
        // sharing 13. A guarantee that something is present is not a reason for it to be the only
        // thing present.
        activationWeight: 1.4,
        minimumDuration: 14,
        // Matched by family, so one entry covers every mode. The last two are the point of ADR-0012
        // rather than a nicety: a particle's wake and a warp's own displacement are fields like any
        // other, and reading one here is what turns "bodies drawn over a picture" into "bodies
        // dragging the picture they pass through".
        prefersWith: [
            'ProceduralVectorField:curl',
            'AudioImpulseField:centre-shockwave',
            'MaskBoundaryField',
            'ParticleRenderer:discs',
            'CoordinateWarpTransform:twirl',
        ],
    });
}
