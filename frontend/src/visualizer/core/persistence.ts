/**
 * Kernel-owned persistence (spec section 11).
 *
 * Section 11 makes feedback injection a compositor duty and gives `VisualLayer` a
 * `feedbackParticipation` weight; section 24 lists feedback buffers under Foundation; every one of
 * section 25's example compositions contains a persistence stage. The implementation instead made
 * persistence one optional plugin among roughly a hundred and fifty, so most assembled scenes had no
 * memory of the previous frame at all and every visible change came from a shader reading `uTime`.
 *
 * The kernel now owns an accumulation buffer. Each frame it is dragged through the scene's summed
 * motion field, decayed, and combined with what the layer stack drew. Plugins still shape that loop —
 * `FeedbackFlowTransform`, `FeedbackInjector`, and `ParticleTrailInjector` are unchanged — but they no
 * longer have to exist for a scene to move.
 *
 * All of it is plain arithmetic over numbers, so the recurrence that decides whether the image moves
 * is testable in the Node environment. The composite shaders mirror these functions exactly.
 */

import { clamp01 } from './bindings';
import type { PortType } from './plugin';

/**
 * Field types the accumulated image is dragged through.
 *
 * A vector field was previously consumed only by particle advection, which is why scene assembly kept
 * generating fields nothing looked at and `contributingPluginIds` had to discard whole scenes to
 * remove them. The same data is a displacement in image space, so every field a scene produces now
 * moves the picture — including the mask-derived ones, which is section 12.2's distortion-regions row.
 */
export const MOTION_SOURCE_TYPES: readonly PortType[] = [
    'motion-field',
    'vector-field',
    'collision-field',
];

export function isMotionSource(type: PortType): boolean {
    return MOTION_SOURCE_TYPES.includes(type);
}

export interface PersistenceSettings {
    /** Fraction of the accumulated image still present one second later. */
    survivalPerSecond: number;
    /** UV displacement per second applied to the accumulation, per unit of field magnitude. */
    motionScale: number;
}

export interface PersistenceInput {
    /** The theme's declared persistence character, which states how much the family accumulates. */
    themePersistence: number;
    /**
     * Per-layer feedback participation times opacity, from `composeLayers`. Already computed and,
     * until now, consumed by nothing.
     */
    layerWeights: readonly number[];
    /** Large-scale force, per the section 20 mapping table. Drives how far the image is dragged. */
    bass: number;
    /** Overall intensity, which lengthens trails as a track opens up. */
    rms: number;
    /** Selects a low-energy profile rather than uniformly slower animation. */
    reducedMotion?: boolean;
}

/**
 * Survival bounds.
 *
 * The floor is the substance of "no scene is ever completely static": even a family that wants crisp
 * geometry keeps a trace of the previous frame, which at sixty frames a second is a survival factor
 * around 0.91 per frame. The ceiling stops the accumulation from becoming a smear that never clears.
 */
const SURVIVAL_FLOOR = 0.004;
const SURVIVAL_CEILING = 0.8;

/** Displacement bounds in UV per second, per unit of field magnitude. */
const MOTION_FLOOR = 0.02;
const MOTION_CEILING = 0.34;

/** What a theme leaves unstated. Matches the neutral value in `character`. */
export const DEFAULT_THEME_PERSISTENCE = 0.4;

/**
 * How strongly this scene accumulates, and how far it drags.
 *
 * Persistence comes from the theme and from what the active plugins declare about themselves, so a
 * family built for accumulation gets long trails and one built for clean geometry stays crisp —
 * without either needing a particular plugin to have been selected.
 */
export function persistenceSettings(input: PersistenceInput): PersistenceSettings {
    const declared = clamp01(input.themePersistence);
    // The strongest participating layer, not the mean: one plugin that means to persist should not
    // have its intent averaged away by the post-processing stages beside it, which declare none.
    const strongestLayer = input.layerWeights.reduce(
        (highest, weight) => Math.max(highest, clamp01(weight)),
        0,
    );

    const persistence = Math.max(declared, strongestLayer);
    const survival = SURVIVAL_FLOOR
        + (SURVIVAL_CEILING - SURVIVAL_FLOOR) * curve(persistence + clamp01(input.rms) * 0.12);

    const motion = MOTION_FLOOR
        + (MOTION_CEILING - MOTION_FLOOR) * curve(clamp01(input.bass) * 0.75 + persistence * 0.25);

    if (input.reducedMotion) {
        // Low energy rather than slow: the image still accumulates, but it is not dragged far.
        return { survivalPerSecond: Math.min(survival, 0.35), motionScale: MOTION_FLOOR * 0.5 };
    }

    return { survivalPerSecond: survival, motionScale: motion };
}

/** Smoothstep, so neither end of the persistence range is reached by a small change near the middle. */
function curve(value: number): number {
    const clamped = clamp01(value);
    return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Fraction of the accumulation surviving one frame.
 *
 * Expressed per second and raised to the frame's own delta, so trails last the same wall-clock time
 * at thirty frames a second as at a hundred and forty-four. The feedback plugins previously used a
 * bare per-frame constant, which made the same scene smear differently on different hardware.
 */
export function frameSurvival(survivalPerSecond: number, deltaSeconds: number): number {
    if (!(deltaSeconds > 0)) {
        // A frozen clock decays nothing. The caller skips the update entirely; this keeps the
        // arithmetic honest for anyone who does not.
        return 1;
    }

    const survival = clamp01(survivalPerSecond);
    if (survival <= 0) {
        return 0;
    }

    return Math.pow(survival, deltaSeconds);
}

/**
 * Combines what the layer stack drew this frame with the decayed accumulation.
 *
 * Screen rather than addition, so a bright trail crossing bright new material rolls off toward white
 * instead of clipping there and staying. With a survival of zero this returns the incoming value
 * unchanged, which is the degenerate case that makes a non-accumulating scene behave exactly as it
 * did before the accumulator existed.
 */
export function accumulate(history: number, incoming: number, survival: number): number {
    const kept = history * survival;
    return 1 - (1 - incoming) * (1 - kept);
}

/**
 * Where the accumulation is read from, given the motion field at this point.
 *
 * The image is dragged *against* the field so material appears to travel along it: sampling from
 * behind moves what is there forward. Scaled by delta for the same reason survival is.
 */
export function gatherOffset(
    field: readonly [number, number],
    motionScale: number,
    deltaSeconds: number,
): [number, number] {
    if (!(deltaSeconds > 0)) {
        return [0, 0];
    }

    const step = motionScale * deltaSeconds;
    return [-field[0] * step, -field[1] * step];
}
