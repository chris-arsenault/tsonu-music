/**
 * The spatial half of the graph-owned scene-state transition.
 *
 * Its source is wired from the previous frame of `SceneStateCombine`. It only resamples that image;
 * it neither injects fresh material nor owns a private buffer. The following combine node performs
 * the recurrence explicitly.
 */

import { DERIVED_STATE, SPATIAL_FEEDBACK } from '../../core/grammar';
import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import { previousTexture, type RenderPass } from '../../core/passes';
import { QUAD_VERTEX_SHADER } from '../../host/device';

export const SCENE_HISTORY_MODES = ['zoom', 'rotate', 'drift', 'spiral', 'field'] as const;
export type SceneHistoryMode = typeof SCENE_HISTORY_MODES[number];

const SHADER_ID = 'SceneHistoryWarp';

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uField;
uniform float uMode;
uniform float uStrength;
uniform float uRotation;
uniform vec2 uDrift;
/**
 * Where the radial modes pivot. Hardcoded at frame centre, every rotation and zoom in a scene
 * shared one axis: persistent material collapsed onto concentric orbits — the reported "turns
 * into a circle" — and two transports could never conflict. Seed-drawn per instance.
 */
uniform vec2 uCentre;
uniform float uDelta;

vec2 rotateAroundCentre(vec2 uv, float angle) {
    vec2 p = uv - uCentre;
    float c = cos(angle);
    float s = sin(angle);
    return mat2(c, -s, s, c) * p + uCentre;
}

void main() {
    float delta = max(uDelta, 0.0);
    float stepSize = uStrength * delta;
    vec2 source = vUv;

    if (uMode < 0.5) {
        source = (vUv - uCentre) * (1.0 - stepSize) + uCentre;
    } else if (uMode < 1.5) {
        source = rotateAroundCentre(vUv, uRotation * delta);
    } else if (uMode < 2.5) {
        source = vUv - uDrift * stepSize;
    } else if (uMode < 3.5) {
        vec2 p = vUv - uCentre;
        source = rotateAroundCentre(vUv, stepSize * (0.4 + length(p) * 2.4));
    } else {
        vec2 field = texture(uField, clamp(vUv, 0.0, 1.0)).xy;
        source = vUv - field * stepSize;
    }

    fragColor = texture(uSource, clamp(source, 0.0, 1.0));
}`;

export function createSceneHistoryWarp(mode: SceneHistoryMode): VisualPluginDefinition {
    return {
        id: `SceneHistoryWarp:${mode}`,
        version: 1,
        category: 'transformer',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            ...(mode === 'field'
                ? [{ name: 'field', type: 'vector-field' as const, required: true }]
                : []),
        ],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
        capabilities: [DERIVED_STATE, SPATIAL_FEEDBACK, 'scene-history-warp'],
        cost: { gpu: 1, cpu: 0, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.5,
            motionEnergy: 0.75,
            geometricOrder: 0.45,
            recognizability: 0.4,
            persistence: 1,
            brightness: 0.5,
            dominance: 'supporting',
        },
        activationRules: { activationWeight: 0 },
        parameters: { strength: 0.16, rotation: 0.3 },
        defaultBindings: [
            {
                // The state's travel per second, as a fraction of the frame. The ceiling was 0.4,
                // which put MilkDrop-typical speed (an ordinary preset zooms at the equivalent of
                // ~0.6/s) permanently out of reach — measured, the reported "never fast". The
                // range decides what is reachable; the EMA and the expression draw decide where
                // in it a scene actually lives.
                feature: 'bass',
                parameter: 'strength',
                outputRange: [0.06, 1.2],
                attack: 0.12,
                release: 0.7,
                curve: 'smooth',
                expressions: ['follow', 'glide', 'punch'],
            },
            {
                feature: 'mid',
                parameter: 'rotation',
                outputRange: [-1.5, 1.5],
                attack: 0.25,
                release: 1,
                curve: 'smooth',
                expressions: ['follow', 'glide', 'swing'],
            },
        ],
        deactivationPolicy: 'fade',

        create(context): VisualPluginInstance {
            let drift: [number, number] = [0, 0];
            let centre: [number, number] = [0.5, 0.5];

            return {
                initialize() {
                    context.registerShader({ id: SHADER_ID, vertex: QUAD_VERTEX_SHADER, fragment: FRAGMENT });
                },
                activate() {
                    const angle = context.seed * Math.PI * 2;
                    drift = [Math.cos(angle), Math.sin(angle)];
                    // A different derivation from the same seed, so the pivot and the drift do not
                    // point the same way by construction.
                    const pivot = context.seed * Math.PI * 2 * 3.7;
                    centre = [
                        0.5 + Math.cos(pivot) * 0.18,
                        0.5 + Math.sin(pivot) * 0.18,
                    ];
                },
                update() {
                    // The image state belongs to the graph resource feeding `source`.
                },
                render(render): RenderPass[] {
                    const previous = render.previous.source;
                    const source = previous ?? render.inputs.source;
                    const field = render.inputs.field;
                    if (!source || (mode === 'field' && !field)) {
                        return [];
                    }

                    return [{
                        kind: 'fullscreen',
                        shader: SHADER_ID,
                        inputs: {
                            uSource: previous ? previousTexture(source) : source,
                            ...(field ? { uField: field } : {}),
                        },
                        output: render.outputs.color,
                        blend: 'none',
                        clear: true,
                        uniforms: {
                            uMode: SCENE_HISTORY_MODES.indexOf(mode),
                            uStrength: 0.16,
                            uRotation: 0.3,
                            uDrift: drift,
                            uCentre: centre,
                        },
                    }];
                },
                deactivate() {
                    // The state resource is graph-owned, so this instance has nothing to hand off.
                },
                destroy() {
                    drift = [0, 0];
                },
            };
        },
    };
}
