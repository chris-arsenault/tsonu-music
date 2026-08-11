/** The explicit combine at the centre of the graph-owned scene-state recurrence. */

import { DERIVED_STATE } from '../../core/grammar';
import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import type { RenderPass } from '../../core/passes';
import { QUAD_VERTEX_SHADER } from '../../host/device';

/**
 * How warped history and fresh material become the next state. One scene holds one of these,
 * drawn by the builder weighted by the material's density (ADR-0017).
 *
 * `max` is winner-take-all per pixel: fresh brightness erases warped history wherever both are
 * lit, so static bright figures never move and motion survives only in dark regions — measured
 * on three captured scenes. It survives as one character among three, not the definition of
 * memory. `flow` softens the same envelope: fresh takes over at an audio-driven rate instead of
 * in one frame, so history visibly fades inside lit figures while dark regions decay on survival
 * alone. `deposit` accumulates: a normalized additive recurrence whose steady state is a bounded
 * number of copies, with a hue-preserving knee and a fresh-visibility floor.
 */
export const SCENE_STATE_COMBINE_MODES = ['max', 'flow', 'deposit'] as const;
export type SceneStateCombineMode = typeof SCENE_STATE_COMBINE_MODES[number];

const LUMINANCE = `
float luminance(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}`;

const MAX_FRAGMENT = `#version 300 es
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

const FLOW_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uHistory;
uniform sampler2D uSource;
uniform float uHistoryWeight;
uniform float uSourceWeight;
uniform float uInject;
uniform float uDelta;
${LUMINANCE}

void main() {
    vec4 historySample = texture(uHistory, vUv);
    vec4 sourceSample = texture(uSource, vUv);

    float keep = uDelta > 0.0
        ? pow(clamp(uHistoryWeight, 0.0, 0.999), uDelta)
        : 1.0;
    // Fraction of the gap to the envelope closed this frame, from a per-second fraction. Not the
    // survival's complement: an independent audio-driven rate.
    float injectFrame = uDelta > 0.0
        ? 1.0 - pow(clamp(1.0 - uInject, 0.001, 1.0), uDelta)
        : 0.0;

    vec3 history = historySample.rgb * keep;
    vec3 source = sourceSample.rgb * max(uSourceWeight, 0.0);

    // Where the state is empty, fresh material lands immediately. Keyed on history, not source:
    // a dense state disables the fill, so this cannot degenerate to passthrough on dense
    // material the way a source-coverage key did.
    float fill = 1.0 - smoothstep(0.0, 0.08, luminance(history));
    float share = max(injectFrame, fill);

    // Softened max. Where fresh outshines history it takes over at the inject rate rather than
    // in one frame — warped history visibly fades inside bright figures. Where history outshines
    // fresh it survives on the declared port gain alone, so dark-region trails do not die when
    // the music gets loud. share -> 1 recovers bare max continuously.
    vec3 target = max(history, source);
    vec3 result = mix(history, target, share);

    fragColor = vec4(clamp(result, vec3(0.0), vec3(256.0)), max(historySample.a, sourceSample.a));
}`;

const DEPOSIT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uHistory;
uniform sampler2D uSource;
uniform float uHistoryWeight;
uniform float uSourceWeight;
uniform float uInject;
uniform float uDelta;
${LUMINANCE}

/**
 * Luminance asymptote of the recurrence. Kept tight: the present palette clamps luminance at
 * one, so state range far above it is structure the viewer cannot see.
 */
const float KNEE = 1.6;

void main() {
    vec4 historySample = texture(uHistory, vUv);
    vec4 sourceSample = texture(uSource, vUv);

    float keep = uDelta > 0.0
        ? pow(clamp(uHistoryWeight, 0.0, 0.999), uDelta)
        : 1.0;
    // Normalized so a static pixel's steady state is exactly uInject copies of the source,
    // independent of frame rate and of where the survival binding sits. This is deliberately not
    // the convex complement the shader contract forbids: uInject's binding floor exceeds one
    // copy — the fixed point holds MORE than one copy of the source, which is the accumulation
    // that rule exists to protect — and the max() floor below keeps fresh material visible from
    // its first frame. See the deposit-mass contract test.
    float depositShare = uInject * (1.0 - keep);

    vec3 sum = historySample.rgb * keep + sourceSample.rgb * depositShare;

    // Hue-preserving scalar knee bounding the recurrence well below the policy clamp.
    float l = luminance(sum);
    float rolled = l <= 1.0
        ? l
        : 1.0 + (l - 1.0) / (1.0 + (l - 1.0) / (KNEE - 1.0));
    sum *= rolled / max(l, 1e-5);

    // The memory is the pure recurrence. Fresh visibility is the display pass's job (ADR-0017
    // amendment): folding a max floor into the fed-back state made the memory max-like wherever
    // fresh exceeded the accumulation, which quietly restored the erasure this operator exists
    // to avoid.
    fragColor = vec4(clamp(sum, vec3(0.0), vec3(256.0)), max(historySample.a, sourceSample.a));
}`;

/**
 * The presented frame: the state with this frame's material riding on top at full audio rate.
 *
 * Memory and presentation have opposite needs — the recurrence smooths or trails die, the screen
 * needs crisp instant response or the picture goes numb. One texture cannot serve both: shipped
 * with the state presented directly, flow low-passed every fresh pixel to 1.5-6% per frame and
 * deposit buried flashes under its own accumulation, and the reported result was "lost nearly all
 * audio rate movement, just smooth". The display output feeds back into nothing.
 */
const FLOW_DISPLAY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uState;
uniform sampler2D uSource;
uniform float uSourceWeight;

void main() {
    vec4 state = texture(uState, vUv);
    vec4 sourceSample = texture(uSource, vUv);
    vec3 source = sourceSample.rgb * max(uSourceWeight, 0.0);

    // Screen keeps both visible at once: the smooth flowing state underneath, this frame's
    // material at full rate on top. Max here would hand static bright figures the whole display
    // again; screen lets the state's motion read through them.
    vec3 s = clamp(state.rgb, vec3(0.0), vec3(1.0));
    vec3 f = clamp(source * 0.85, vec3(0.0), vec3(1.0));
    vec3 result = vec3(1.0) - (vec3(1.0) - s) * (vec3(1.0) - f);

    fragColor = vec4(result, max(state.a, sourceSample.a));
}`;

const DEPOSIT_DISPLAY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uState;
uniform sampler2D uSource;
uniform float uSourceWeight;

void main() {
    vec4 state = texture(uState, vUv);
    vec4 sourceSample = texture(uSource, vUv);
    vec3 source = sourceSample.rgb * max(uSourceWeight, 0.0);

    // The accumulation routinely exceeds one, so screen would saturate; max is right here — the
    // built field wins wherever it has built past the source, and fresh material lands at full
    // weight everywhere else from its first frame.
    vec3 result = max(state.rgb, source);

    fragColor = vec4(result, max(state.a, sourceSample.a));
}`;

const FRAGMENTS: Record<SceneStateCombineMode, string> = {
    max: MAX_FRAGMENT,
    flow: FLOW_FRAGMENT,
    deposit: DEPOSIT_FRAGMENT,
};

export function createSceneStateCombine(
    mode: SceneStateCombineMode = 'max',
): VisualPluginDefinition {
    // The bare id stays with `max` so every capture and authored document written before the
    // family existed still resolves to the operator it was written against.
    const id = mode === 'max' ? 'SceneStateCombine' : `SceneStateCombine:${mode}`;
    const withInject = mode !== 'max';

    return {
        id,
        version: 1,
        category: 'compositor',
        inputs: [
            // `historyWeight` is the fraction of the state surviving one second, which is the gain
            // of the canonical cycle closing through this port. For `flow` it is exactly the
            // dark-region decay; for `deposit` the series ratio. Declaring it lets
            // `core/loop-gain.ts` see the decay that governs the loop instead of reporting unity.
            {
                name: 'history',
                type: 'color-texture',
                required: true,
                gainParameter: 'historyWeight',
            },
            { name: 'source', type: 'color-texture', required: true },
        ],
        outputs: [
            { name: 'color', type: 'color-texture', required: false },
            ...(withInject
                ? [{ name: 'display', type: 'color-texture' as const, required: false }]
                : []),
        ],
        capabilities: [DERIVED_STATE, 'scene-state-combine'],
        temporalCombine: {
            operator: mode,
            historyInput: 'history',
            sourceInput: 'source',
            output: 'color',
            ...(withInject ? { displayOutput: 'display' } : {}),
            historyWeightParameter: 'historyWeight',
            sourceWeightParameter: 'sourceWeight',
        },
        cost: { gpu: 1, cpu: 0, memory: 2, renderPasses: withInject ? 2 : 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.6,
            motionEnergy: 0.5,
            geometricOrder: 0.5,
            recognizability: 0.5,
            persistence: 1,
            brightness: mode === 'deposit' ? 0.7 : 0.5,
            dominance: 'supporting',
        },
        activationRules: { activationWeight: 0 },
        parameters: {
            historyWeight: mode === 'deposit' ? 0.93 : 0.9,
            sourceWeight: 0.9,
            ...(withInject ? { inject: mode === 'flow' ? 0.8 : 1.2 } : {}),
        },
        defaultBindings: [
            {
                feature: 'spectralFlux',
                parameter: 'historyWeight',
                outputRange: mode === 'deposit' ? [0.97, 0.85] : [0.96, 0.78],
                attack: 0.6,
                release: 2,
                curve: 'smooth',
            },
            {
                feature: 'rms',
                parameter: 'sourceWeight',
                // Deposit's source weight multiplies into the accumulated mass, so its range is
                // narrow — a wide range would double-modulate the mass by two level features.
                outputRange: mode === 'deposit' ? [0.9, 1] : [0.65, 1.05],
                attack: 0.1,
                release: 0.55,
                curve: 'smooth',
            },
            ...(mode === 'flow'
                ? [{
                    // How fast fresh material takes over lit regions, as a fraction per second.
                    // Punch lets a hit slam the takeover — the state flashes to the fresh frame
                    // on onsets and relaxes into trails between them.
                    feature: 'mid',
                    parameter: 'inject',
                    outputRange: [0.6, 0.98] as [number, number],
                    attack: 0.15,
                    release: 0.7,
                    curve: 'smooth' as const,
                    expressions: ['follow', 'punch'] as const,
                }]
                : []),
            ...(mode === 'deposit'
                ? [{
                    // Steady-state mass in copies of the source. The floor stays above one copy —
                    // that is the operator's contract with the anti-complement rule.
                    feature: 'lowMid',
                    parameter: 'inject',
                    outputRange: [1.05, 1.6] as [number, number],
                    attack: 0.3,
                    release: 1.2,
                    curve: 'smooth' as const,
                }]
                : []),
        ],
        deactivationPolicy: 'fade',

        create(context): VisualPluginInstance {
            return {
                initialize() {
                    context.registerShader({ id, vertex: QUAD_VERTEX_SHADER, fragment: FRAGMENTS[mode] });
                    if (withInject) {
                        context.registerShader({
                            id: `${id}/display`,
                            vertex: QUAD_VERTEX_SHADER,
                            fragment: mode === 'flow' ? FLOW_DISPLAY_FRAGMENT : DEPOSIT_DISPLAY_FRAGMENT,
                        });
                    }
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

                    const passes: RenderPass[] = [{
                        kind: 'fullscreen',
                        shader: id,
                        inputs: { uHistory: history, uSource: source },
                        output: render.outputs.color,
                        blend: 'none',
                        clear: true,
                        uniforms: {
                            uHistoryWeight: mode === 'deposit' ? 0.93 : 0.9,
                            uSourceWeight: 0.9,
                            ...(withInject ? { uInject: mode === 'flow' ? 0.8 : 1.2 } : {}),
                        },
                    }];

                    // The presented frame: state beneath, this frame's material at full audio
                    // rate on top. Reads the state written by the pass above.
                    if (withInject && render.outputs.display) {
                        passes.push({
                            kind: 'fullscreen',
                            shader: `${id}/display`,
                            inputs: { uState: render.outputs.color, uSource: source },
                            output: render.outputs.display,
                            blend: 'none',
                            clear: true,
                            uniforms: { uSourceWeight: 0.9 },
                        });
                    }

                    return passes;
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
