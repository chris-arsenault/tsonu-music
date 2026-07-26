/**
 * Parameter-to-uniform mapping.
 *
 * A plugin declares parameters by name and binds features to them; its shader reads uniforms. This is
 * the convention joining the two: parameter `strength` becomes uniform `uStrength`.
 *
 * The runtime applies this to every pass centrally rather than each plugin doing it, because a plugin
 * that forgets renders at its static defaults and looks merely unreactive rather than broken — which is
 * exactly how the whole catalog came to ignore its own bindings.
 */

import {
    advanceBinding,
    advanceImpulse,
    bindingMode,
    integrateBinding,
    type ParameterBinding,
} from './bindings';
import type { AudioFeatureBus } from './features';
import type { UniformValue } from './passes';

/** `strength` becomes `uStrength`. Already-prefixed names pass through unchanged. */
export function parameterUniformName(parameter: string): string {
    if (parameter.length === 0) {
        return parameter;
    }

    if (/^u[A-Z]/.test(parameter)) {
        return parameter;
    }

    return `u${parameter.charAt(0).toUpperCase()}${parameter.slice(1)}`;
}

/** Live parameter values as shader uniforms. Non-finite values are dropped rather than sent to GL. */
export function parameterUniforms(
    parameters: Readonly<Record<string, number>>,
): Record<string, UniformValue> {
    const uniforms: Record<string, UniformValue> = {};

    for (const [name, value] of Object.entries(parameters)) {
        if (Number.isFinite(value)) {
            uniforms[parameterUniformName(name)] = value;
        }
    }

    return uniforms;
}

/**
 * Merges live parameters over a pass's static uniforms.
 *
 * Live values win: a static uniform is the plugin's default for when nothing is bound, and a bound
 * parameter is the whole point of the binding.
 */
export function mergeUniforms(
    passUniforms: Readonly<Record<string, UniformValue>> | undefined,
    parameters: Readonly<Record<string, number>>,
): Record<string, UniformValue> {
    return { ...(passUniforms ?? {}), ...parameterUniforms(parameters) };
}

/** Continuous feature by name, or undefined when a binding names something the bus does not carry. */
export function readFeature(features: AudioFeatureBus, name: string): number | undefined {
    const continuous = features.continuous as unknown as Record<string, number>;
    const value = continuous[name];

    return typeof value === 'number' ? value : undefined;
}

// A second IMPULSE_FEATURES lived here, exported, imported by nothing, and disagreeing with the one
// distribution actually uses: it listed `sectionChange`, which the bus has never emitted. Two lists
// of the same name for the same concept, one of them wrong, is worse than one — `audio-mapping.ts`
// holds the only copy now.

/**
 * Strongest event on a channel this frame, or undefined when nothing fired.
 *
 * The bus already holds events until they are audible, so reading them here needs no latency
 * handling of its own.
 */
export function readEventStrength(features: AudioFeatureBus, name: string): number | undefined {
    const channels = features.events as unknown as Record<string, { strength: number }[] | undefined>;
    const events = channels[name];
    if (!events || events.length === 0) {
        return undefined;
    }

    let strongest = 0;
    for (const event of events) {
        if (event.strength > strongest) {
            strongest = event.strength;
        }
    }

    return strongest;
}

/**
 * Advances every bound parameter one frame.
 *
 * Pure, and the whole chain from a feature to a shader uniform runs through here, so that chain is
 * testable end to end rather than only at its ends. A frozen clock passes zero delta and every value
 * holds.
 */
export function resolveParameters(
    previous: Readonly<Record<string, number>>,
    bindings: readonly ParameterBinding[],
    features: AudioFeatureBus,
    deltaSeconds: number,
): Record<string, number> {
    const resolved: Record<string, number> = { ...previous };

    for (const binding of bindings) {
        const mode = bindingMode(binding);

        // An impulse reads the event channels rather than the continuous bus, so it must dispatch
        // before the continuous lookup — `onset` is not a continuous feature and would be skipped.
        if (mode === 'impulse') {
            resolved[binding.parameter] = advanceImpulse(
                binding,
                resolved[binding.parameter],
                readEventStrength(features, binding.feature),
                deltaSeconds,
            );
            continue;
        }

        const raw = readFeature(features, binding.feature);
        if (raw === undefined) {
            continue;
        }

        resolved[binding.parameter] = mode === 'rate'
            ? integrateBinding(binding, resolved[binding.parameter], raw, deltaSeconds)
            : advanceBinding(binding, resolved[binding.parameter], raw, deltaSeconds);
    }

    return resolved;
}
