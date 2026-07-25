/**
 * Parameter bindings (spec section 7.3).
 *
 * A binding maps one named feature onto one plugin parameter with its own range, response curve, and
 * asymmetric smoothing. Plugins declare bindings rather than reading features directly, which is what
 * lets the scheduler distribute reactivity instead of every parameter pulsing on every beat.
 */

export type BindingCurve =
    | 'linear'
    | 'smooth'
    | 'square'
    | 'sqrt'
    | 'exponential';

/**
 * What a binding is *for*, drawn from the section 20 mapping table.
 *
 * A binding declares a role rather than only a feature so the scheduler can distribute reactivity
 * across a scene without changing what a parameter means. Choosing a feature at random from a
 * category-wide pool moved a feedback expansion onto stereo balance, which is the specific failure
 * the table exists to prevent.
 */
export type BindingRole =
    | 'intensity'
    | 'large-scale-force'
    | 'deformation'
    | 'detail'
    | 'burst'
    | 'repeating-motion'
    | 'complexity'
    | 'lateral-force';

/**
 * How a feature reaches a parameter.
 *
 * `value` drives the parameter directly and is the default, so every binding written before this
 * existed keeps its behaviour.
 *
 * `rate` drives the parameter's derivative: the output range is units per second and the kernel
 * integrates. This is the only way audio can change how fast something moves rather than how far it
 * is displaced, which no amount of tuning a `value` binding can reach.
 *
 * `impulse` fires a decaying envelope from a detected event rather than tracking a continuous
 * measure, so any parameter of any plugin can punch on an onset or a beat.
 */
export type BindingMode = 'value' | 'rate' | 'impulse';

export interface ParameterBinding {
    feature: string;
    parameter: string;

    mode?: BindingMode;
    role?: BindingRole;

    inputRange?: [number, number];
    outputRange: [number, number];

    /** Seconds to approach a rising target. 0 follows instantly. */
    attack: number;
    /** Seconds to approach a falling target. 0 follows instantly. */
    release: number;

    curve: BindingCurve;

    polarity?: 1 | -1;

    /**
     * Wraps an integrated parameter into `[0, wrap)`. Only meaningful for `rate`, where the value
     * accumulates without bound and would otherwise lose float precision over a long session.
     */
    wrap?: number;
}

export function bindingMode(binding: ParameterBinding): BindingMode {
    return binding.mode ?? 'value';
}

const EXPONENTIAL_CURVE_BASE = 4;

/** Applies range mapping, polarity, and the response curve. No smoothing. */
export function bindingTarget(binding: ParameterBinding, rawValue: number): number {
    const [inputLow, inputHigh] = binding.inputRange ?? [0, 1];
    const normalized = normalize(rawValue, inputLow, inputHigh);
    const polarized = binding.polarity === -1 ? 1 - normalized : normalized;
    const shaped = applyCurve(binding.curve, polarized);
    const [outputLow, outputHigh] = binding.outputRange;

    return outputLow + (outputHigh - outputLow) * shaped;
}

/**
 * Advances a bound parameter toward its target using attack or release depending on direction.
 * `deltaSeconds` is frozen-aware time: a frozen clock passes 0 and the value holds.
 */
export function advanceBinding(
    binding: ParameterBinding,
    previous: number,
    rawValue: number,
    deltaSeconds: number,
): number {
    const target = bindingTarget(binding, rawValue);

    if (!Number.isFinite(previous)) {
        return target;
    }

    if (deltaSeconds <= 0) {
        return previous;
    }

    const timeConstant = target >= previous ? binding.attack : binding.release;
    if (timeConstant <= 0) {
        return target;
    }

    // Exponential approach, framerate-independent: the same wall-clock time produces the same
    // approach regardless of how many frames it took.
    const factor = 1 - Math.exp(-deltaSeconds / timeConstant);
    return previous + (target - previous) * factor;
}

/**
 * Integrates a rate binding for one frame.
 *
 * The target is a velocity in units per second, so a frozen clock passing zero delta holds the
 * accumulated value exactly where it was — the same freeze contract every other advance honours,
 * for free.
 */
export function integrateBinding(
    binding: ParameterBinding,
    previous: number,
    rawValue: number,
    deltaSeconds: number,
): number {
    const start = Number.isFinite(previous) ? previous : 0;
    if (deltaSeconds <= 0) {
        return start;
    }

    const advanced = start + bindingTarget(binding, rawValue) * deltaSeconds;

    if (binding.wrap === undefined || binding.wrap <= 0 || !Number.isFinite(advanced)) {
        return Number.isFinite(advanced) ? advanced : start;
    }

    const wrapped = advanced % binding.wrap;
    return wrapped < 0 ? wrapped + binding.wrap : wrapped;
}

/**
 * Advances an impulse envelope for one frame.
 *
 * An event sets the envelope from its strength and never lowers it, so two onsets inside one frame
 * leave the stronger one standing. With no event the envelope falls toward the range floor over
 * `release`. Attack is honoured on the rise, so a binding can ask for a fast punch or a swell.
 */
export function advanceImpulse(
    binding: ParameterBinding,
    previous: number,
    /** Strongest event strength this frame, or undefined when nothing fired. */
    eventStrength: number | undefined,
    deltaSeconds: number,
): number {
    const floor = Math.min(...binding.outputRange);
    const start = Number.isFinite(previous) ? previous : floor;

    if (deltaSeconds <= 0) {
        return start;
    }

    if (eventStrength !== undefined) {
        const target = bindingTarget(binding, eventStrength);
        if (target <= start) {
            return start;
        }

        if (binding.attack <= 0) {
            return target;
        }

        return start + (target - start) * (1 - Math.exp(-deltaSeconds / binding.attack));
    }

    if (binding.release <= 0) {
        return floor;
    }

    return start + (floor - start) * (1 - Math.exp(-deltaSeconds / binding.release));
}

export function applyCurve(curve: BindingCurve, value: number): number {
    const clamped = clamp01(value);

    switch (curve) {
        case 'linear':
            return clamped;

        case 'smooth':
            return clamped * clamped * (3 - 2 * clamped);

        case 'square':
            return clamped * clamped;

        case 'sqrt':
            return Math.sqrt(clamped);

        case 'exponential':
            return (Math.exp(EXPONENTIAL_CURVE_BASE * clamped) - 1) / (Math.exp(EXPONENTIAL_CURVE_BASE) - 1);
    }
}

export function normalize(value: number, low: number, high: number): number {
    if (!Number.isFinite(value) || high === low) {
        return 0;
    }

    return clamp01((value - low) / (high - low));
}

export function clamp01(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return value < 0 ? 0 : value > 1 ? 1 : value;
}
