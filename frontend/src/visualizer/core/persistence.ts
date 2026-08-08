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
    /**
     * How hard the newest frame punches through the accumulation, 0 to 1, from the transient
     * envelope.
     *
     * At rest the accumulation admits only its complement of survival — a couple of percent per
     * frame — which is what makes long trails possible and is also why sparse, fast material was
     * being swallowed whole: particles, glyphs and bursts each contributed a fiftieth of their
     * brightness and were then dragged away. Worse, no musical event could move more than that
     * fraction of the screen, which is what "movement disconnected from the music" is.
     *
     * On a hit the new frame is let through. Between hits it smears. That contrast is the pulse.
     */
    transientPunch: number;
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
    /** The transient envelope: how recently something struck. Drives the pulse. */
    transient: number;
    /** Selects a low-energy profile rather than uniformly slower animation. */
    reducedMotion?: boolean;
}

/**
 * Survival bounds, as the fraction still present one second later.
 *
 * These are also the image's response time, because survival and injection are complements: a scene
 * keeping most of a second's history necessarily takes most of a second to show anything new. The
 * ceiling was 0.8, a half-life over two seconds, which is why the large-scale motion read as sluggish
 * — every change was arriving through a two-second filter.
 *
 * The range now spans roughly a quarter-second trail to three-quarters of a second. The floor is the
 * substance of "no scene is ever completely static"; the ceiling is where trails stop being motion
 * and start being lag.
 */
const SURVIVAL_FLOOR = 0.02;
const SURVIVAL_CEILING = 0.25;

/**
 * Displacement bounds in UV per second, per unit of field magnitude.
 *
 * Raised from a ceiling of 0.34: several field modes are far weaker than unit magnitude — the curl
 * mode differences an fbm over a hundredth of a unit — so the effective drag sat well under the
 * nominal figure and the large-scale motion read as sluggish.
 */
const MOTION_FLOOR = 0.05;
const MOTION_CEILING = 0.85;

/**
 * How much of the new frame a full-strength transient lets through.
 *
 * High enough that a hit visibly arrives; short of one so a strike still leaves the previous image
 * partly standing rather than cutting to a new one.
 */
const TRANSIENT_PUNCH = 0.72;

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

    // Squared, so ordinary playing barely lifts the injection and a real hit lifts it a lot. A linear
    // response here just raises the floor and takes the trails away.
    const strike = clamp01(input.transient);
    const punch = strike * strike * TRANSIENT_PUNCH;

    if (input.reducedMotion) {
        // Low energy rather than slow: the image still accumulates, but it is not dragged far and it
        // does not punch.
        return {
            // No clamp: SURVIVAL_CEILING is 0.25, so a minimum against 0.35 could never bind. It was
            // left behind when the ceiling came down from 0.8 and read as a safeguard that was doing
            // nothing. Removing it changes no value this function can produce.
            survivalPerSecond: survival,
            motionScale: MOTION_FLOOR * 0.5,
            transientPunch: 0,
        };
    }

    return {
        survivalPerSecond: survival,
        // A hit shoves the image as well as brightening it, so the flow lurches with the music
        // rather than drifting past it.
        motionScale: motion * (1 + strike * 0.8),
        transientPunch: punch,
    };
}

/**
 * Values pinned against what the theme and the audio would otherwise decide.
 *
 * Every member is optional and an absent one is not pinned, because these are three separate
 * questions: how long the image lasts, how far it is dragged, and how hard a hit punches through.
 * Pinning survival to study a trail should not also freeze the drag.
 */
export type PersistenceOverrides = Partial<PersistenceSettings>;

/**
 * Applies pinned persistence values over the computed ones.
 *
 * The accumulation is where most of what the eye reads as motion actually happens, and it is
 * computed from the theme, the layer stack and three audio channels at once — so asking whether a
 * fault is in the accumulation means being able to hold it still while everything else keeps
 * running. Non-finite pins are ignored rather than sent to the shader as `NaN`, which would blank
 * the frame and look exactly like the bug being hunted.
 */
export function applyPersistenceOverrides(
    settings: PersistenceSettings,
    overrides: PersistenceOverrides | undefined,
): PersistenceSettings {
    if (!overrides) {
        return settings;
    }

    const pin = (value: number | undefined, current: number): number =>
        (typeof value === 'number' && Number.isFinite(value) ? value : current);

    return {
        survivalPerSecond: clamp01(pin(overrides.survivalPerSecond, settings.survivalPerSecond)),
        motionScale: Math.max(0, pin(overrides.motionScale, settings.motionScale)),
        transientPunch: clamp01(pin(overrides.transientPunch, settings.transientPunch)),
    };
}

/** Smoothstep, so neither end of the persistence range is reached by a small change near the middle. */
function curve(value: number): number {
    const clamped = clamp01(value);
    return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Ceiling on any value read through a historical edge.
 *
 * The kernel owns the combine for its own accumulation, so survival and injection are complements
 * there and a static image provably converges to itself. Once a plugin can close a loop the kernel
 * does not own that combine and cannot promise a fixed point — a loop through an additive mixer
 * converges to a multiple of its input rather than to it. See ADR-0012.
 *
 * Attenuation is what stops a loop growing without bound; this is what stops a divergent one
 * arriving at infinity, and then at `NaN` on the first subtraction, which blanks the frame entirely.
 * A blank frame is the worst failure available here and the hardest to read backwards, so the
 * ceiling exists for the case where the attenuation contract has been satisfied and the loop still
 * runs hot. Well above anything a composed scene reaches, so it never shapes an image that is
 * behaving.
 */
export const HISTORY_CEILING = 8;

/**
 * Fraction of a historical read surviving `deltaSeconds`, from a per-second decay.
 *
 * Every plugin closing a loop needs this, and each of the three that existed wrote its own —
 * `pow(uDecay, delta * 60.0)`, which makes the parameter a per-frame-at-sixty figure and reads as a
 * magic constant at every call site. Expressed per second it is the same quantity `frameSurvival`
 * uses for the kernel's own accumulation, so a trail's length is a duration in both places.
 */
export function historyAttenuation(decayPerSecond: number, deltaSeconds: number): number {
    return frameSurvival(decayPerSecond, deltaSeconds);
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
 * Smallest share of the new frame that always reaches the accumulation.
 *
 * A safety rail rather than a tuning value: the survival ceiling already keeps injection well above
 * it. Raising it further would break the complement relationship and turn the integrator back into a
 * brightness ramp, which is the failure it exists to avoid.
 */
const MINIMUM_INJECTION = 0.01;

/**
 * How much of this frame's composite enters the accumulation.
 *
 * The complement of survival, so the two sum to one and a static image converges to exactly itself.
 * This is what stops the accumulation from being a brightness ramp.
 */
export function injectionFor(survivalPerFrame: number, transientPunch = 0): number {
    const resting = Math.max(1 - clamp01(survivalPerFrame), MINIMUM_INJECTION);

    // A hit overrides the resting complement outright rather than adding to it, so the fixed point is
    // untouched between hits and the trails survive.
    return Math.max(resting, clamp01(transientPunch));
}

/**
 * Subtracted from the accumulation per second so trails reach true black.
 *
 * A purely multiplicative decay approaches zero without arriving, leaving a haze that everything
 * afterwards is composited on top of. Expressed per second like survival, because a per-frame
 * constant erases a trail at whatever rate the display happens to run at — and because at a quarter
 * per second it was consuming dim material faster than the drag could carry it anywhere.
 */
export const BLACK_FLOOR_PER_SECOND = 0.09;

/** Absolute amount removed this frame. Zero while frozen, so a held image does not fade. */
export function blackFloorFor(deltaSeconds: number): number {
    return deltaSeconds > 0 ? BLACK_FLOOR_PER_SECOND * deltaSeconds : 0;
}

/**
 * Combines what the layer stack drew this frame with the decayed accumulation.
 *
 * A leaky integrator, not a screen. Screen combines each channel toward one independently, so the
 * channel nearest one saturates first and the rest follow in order — over hundreds of frames every
 * pixel receiving repeated contribution ends up white, with whatever channel started lowest lagging
 * as a colour cast. That is a brightness ramp with no fixed point, and it is why the image washed out
 * and read yellow.
 *
 * Here a static image converges to exactly itself, and a trail comes from the *warp* — history
 * sampled from a displaced position decays behind whatever moved. With a survival of zero this
 * returns the incoming value unchanged, the degenerate case that makes a non-accumulating scene
 * behave as it did before the accumulator existed.
 */
export function accumulate(
    history: number,
    incoming: number,
    survival: number,
    blackFloor = 0,
): number {
    const kept = Math.max(history * survival - blackFloor, 0);
    return kept + incoming * injectionFor(survival);
}

/**
 * Which of the two accumulation slots holds the image after this frame.
 *
 * The slot flips only when something is written to it. Deriving it from the frame counter instead —
 * which increments on every frame, including the ones a frozen clock skips — left the display
 * swapping between the last two accumulations at refresh rate.
 */
export function advanceAccumulationSlot(current: 0 | 1, advancing: boolean): 0 | 1 {
    if (!advancing) {
        return current;
    }

    return current === 0 ? 1 : 0;
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
