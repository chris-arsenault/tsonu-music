/** The explicit combine at the centre of the graph-owned scene-state recurrence. */

import { DERIVED_STATE } from '../../core/grammar';
import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import type { RenderPass } from '../../core/passes';
import { QUAD_VERTEX_SHADER } from '../../host/device';

/**
 * How warped history and fresh material become the next state. One scene holds one of these,
 * drawn by the builder, so the operator is a per-scene character choice.
 *
 * `max` was the only operator, and it is a recurrence with a fixed point rather than an
 * accumulator: history can never exceed the fresh redraw, so the state converges to the max of a
 * decaying family of warped copies within seconds and stops changing. Measured with exactly
 * periodic audio, the state buffer *reduced* frame divergence 40–70% — a low-pass, not a memory.
 * It survives as one character among three rather than the definition of memory.
 */
export const SCENE_STATE_COMBINE_MODES = ['stamp', 'screen', 'max'] as const;
export type SceneStateCombineMode = typeof SCENE_STATE_COMBINE_MODES[number];

const FRAGMENT = (mode: SceneStateCombineMode) => `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uHistory;
uniform sampler2D uSource;
uniform float uHistoryWeight;
uniform float uSourceWeight;
uniform float uDelta;

float luma(vec3 rgb) {
    return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
    vec4 historySample = texture(uHistory, vUv);
    vec4 sourceSample = texture(uSource, vUv);
    float survival = uDelta > 0.0
        ? pow(clamp(uHistoryWeight, 0.0, 0.999), uDelta)
        : 1.0;
    vec3 history = historySample.rgb * survival;
    vec3 source = sourceSample.rgb * max(uSourceWeight, 0.0);
${mode === 'stamp' ? `
    // Fresh material is stamped over the decaying warped history where it actually drew, and the
    // history shows through where it did not. Coverage comes from the source's own luminance, so a
    // sparse trace leaves the field of earlier, displaced stamps intact — which is what lets the
    // picture at second five hold material from second one. Bounded by replacement: nothing sums,
    // so a bright source cannot drive the state to white.
    float coverage = clamp(luma(sourceSample.rgb) / (luma(sourceSample.rgb) + 0.08), 0.0, 1.0);
    float stamp = min(coverage * max(uSourceWeight, 0.0), 1.0);
    vec3 result = mix(history, sourceSample.rgb, stamp);
` : ''}${mode === 'screen' ? `
    // Energy accumulates but the sum is bounded: screen approaches one asymptotically, and the
    // survival term pulls the state back down wherever fresh material stops arriving. Glowier than
    // stamp — overlapping trails brighten one another instead of replacing.
    vec3 h = clamp(history, vec3(0.0), vec3(1.0));
    vec3 s = clamp(source * 0.85, vec3(0.0), vec3(1.0));
    vec3 result = vec3(1.0) - (vec3(1.0) - h) * (vec3(1.0) - s);
` : ''}${mode === 'max' ? `
    // Winner-take-all per pixel: a hard-edged flash memory whose ghosts decay in place. History is
    // invisible wherever the fresh frame is at least as bright, so this reads as afterimage rather
    // than accumulation — one character, not the default.
    vec3 result = max(history, source);
` : ''}
    // Numerical guard only. The meter and grade decide presentation exposure.
    fragColor = vec4(clamp(result, vec3(0.0), vec3(256.0)), max(historySample.a, sourceSample.a));
}`;

export function createSceneStateCombine(
    mode: SceneStateCombineMode = 'max',
): VisualPluginDefinition {
    // The bare id stays with `max` so every capture and authored document written before the
    // family existed still resolves to the operator it was written against.
    const id = mode === 'max' ? 'SceneStateCombine' : `SceneStateCombine:${mode}`;

    return {
        id,
        version: 1,
        category: 'compositor',
        inputs: [
            // `historyWeight` is the fraction of the state surviving one second, which is the gain
            // of the canonical cycle closing through this port (ADR-0013). Declaring it is what
            // lets `core/loop-gain.ts` see the decay that actually governs the loop instead of
            // reporting unity.
            {
                name: 'history',
                type: 'color-texture',
                required: true,
                gainParameter: 'historyWeight',
            },
            { name: 'source', type: 'color-texture', required: true },
        ],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
        capabilities: [DERIVED_STATE, 'scene-state-combine'],
        temporalCombine: {
            operator: mode,
            historyInput: 'history',
            sourceInput: 'source',
            output: 'color',
            historyWeightParameter: 'historyWeight',
            sourceWeightParameter: 'sourceWeight',
        },
        cost: { gpu: 1, cpu: 0, memory: 2, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.6,
            motionEnergy: 0.5,
            geometricOrder: 0.5,
            recognizability: 0.5,
            persistence: 1,
            brightness: mode === 'screen' ? 0.7 : 0.5,
            dominance: 'supporting',
        },
        activationRules: { activationWeight: 0 },
        parameters: {
            historyWeight: mode === 'stamp' ? 0.95 : 0.9,
            sourceWeight: 0.9,
        },
        defaultBindings: [
            {
                feature: 'spectralFlux',
                role: 'intensity',
                parameter: 'historyWeight',
                // Stamp keeps a longer memory than the others: its stamps are spatially sparse, so
                // the state can afford to remember tens of seconds without washing out, and that
                // span is where mid-term development lives. Flux still drives forgetting — a busy
                // passage clears the field faster than a still one.
                outputRange: mode === 'stamp' ? [0.985, 0.8] : [0.96, 0.78],
                attack: 0.6,
                release: 2,
                curve: 'smooth',
            },
            {
                feature: 'rms',
                role: 'intensity',
                parameter: 'sourceWeight',
                outputRange: [0.65, 1.05],
                attack: 0.1,
                release: 0.55,
                curve: 'smooth',
            },
        ],
        deactivationPolicy: 'fade',

        create(context): VisualPluginInstance {
            return {
                initialize() {
                    context.registerShader({ id, vertex: QUAD_VERTEX_SHADER, fragment: FRAGMENT(mode) });
                },
                activate() {
                    // State lives in the output resource, not in this instance.
                },
                update() {
                    // Parameter resolution is host-owned.
                },
                render(render): RenderPass[] {
                    const history = render.inputs.history;
                    const source = render.inputs.source;
                    if (!history || !source) {
                        return [];
                    }

                    return [{
                        kind: 'fullscreen',
                        shader: id,
                        inputs: { uHistory: history, uSource: source },
                        output: render.outputs.color,
                        blend: 'none',
                        clear: true,
                        uniforms: {
                            uHistoryWeight: mode === 'stamp' ? 0.95 : 0.9,
                            uSourceWeight: 0.9,
                        },
                    }];
                },
                deactivate() {
                    // The retiring scene owns its resource until the transition completes.
                },
                destroy() {
                    // No private state.
                },
            };
        },
    };
}
