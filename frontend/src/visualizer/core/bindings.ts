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

export interface ParameterBinding {
    feature: string;
    parameter: string;

    inputRange?: [number, number];
    outputRange: [number, number];

    /** Seconds to approach a rising target. 0 follows instantly. */
    attack: number;
    /** Seconds to approach a falling target. 0 follows instantly. */
    release: number;

    curve: BindingCurve;

    polarity?: 1 | -1;
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
