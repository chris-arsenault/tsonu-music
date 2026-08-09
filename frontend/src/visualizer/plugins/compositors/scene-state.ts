/** The explicit combine at the centre of the graph-owned scene-state recurrence. */

import { DERIVED_STATE } from '../../core/grammar';
import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import type { RenderPass } from '../../core/passes';
import { QUAD_VERTEX_SHADER } from '../../host/device';

const SHADER_ID = 'SceneStateCombine';

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uHistory;
uniform sampler2D uSource;
uniform float uHistoryWeight;
uniform float uSourceWeight;
uniform float uDelta;

void main() {
    vec4 historySample = texture(uHistory, vUv);
    vec4 sourceSample = texture(uSource, vUv);
    float survival = uDelta > 0.0
        ? pow(clamp(uHistoryWeight, 0.0, 0.999), uDelta)
        : 1.0;
    vec3 history = historySample.rgb * survival;
    vec3 source = sourceSample.rgb * max(uSourceWeight, 0.0);
    vec3 result = max(history, source);

    // Numerical guard only. The meter and grade decide presentation exposure.
    fragColor = vec4(clamp(result, vec3(0.0), vec3(256.0)), max(historySample.a, sourceSample.a));
}`;

export function createSceneStateCombine(): VisualPluginDefinition {
    return {
        id: 'SceneStateCombine',
        version: 1,
        category: 'compositor',
        inputs: [
            // `historyWeight` is the fraction of the state surviving one second, which is the gain
            // of the canonical cycle closing through this port. Declaring it lets `core/loop-gain.ts`
            // see the decay that actually governs the loop instead of reporting unity.
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
            operator: 'max',
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
            brightness: 0.5,
            dominance: 'supporting',
        },
        activationRules: { activationWeight: 0 },
        parameters: { historyWeight: 0.9, sourceWeight: 0.9 },
        defaultBindings: [
            {
                feature: 'spectralFlux',
                role: 'intensity',
                parameter: 'historyWeight',
                outputRange: [0.96, 0.78],
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
                    context.registerShader({ id: SHADER_ID, vertex: QUAD_VERTEX_SHADER, fragment: FRAGMENT });
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
                        shader: SHADER_ID,
                        inputs: { uHistory: history, uSource: source },
                        output: render.outputs.color,
                        blend: 'none',
                        clear: true,
                        uniforms: {
                            uHistoryWeight: 0.9,
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
