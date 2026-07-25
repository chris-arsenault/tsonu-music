/**
 * Graceful deactivation (spec section 18).
 *
 * A stateful plugin cut mid-frame leaves a visible hole: particles vanish, a fluid field snaps to
 * black. Each policy describes how a plugin leaves, and the runtime keeps it rendering until it says
 * it is finished.
 */

import { clamp01 } from './bindings';
import type { DeactivationPolicy } from './plugin';

export interface Retirement {
    instanceId: string;
    policy: DeactivationPolicy;
    /** Seconds elapsed since retirement began. */
    elapsedSeconds: number;
    /** How long this policy takes. Zero for immediate. */
    durationSeconds: number;
    /** Whether the plugin should keep producing new material while retiring. */
    emitting: boolean;
}

/** How long each policy takes to complete. */
export const POLICY_DURATIONS: Record<DeactivationPolicy, number> = {
    immediate: 0,
    fade: 0.6,
    // Draining waits for existing particles to age out, which takes longer than a fade.
    drain: 2.5,
    'freeze-and-dissolve': 1.5,
    'handoff-feedback': 0.9,
};

export function beginRetirement(
    instanceId: string,
    policy: DeactivationPolicy = 'immediate',
): Retirement {
    return {
        instanceId,
        policy,
        elapsedSeconds: 0,
        durationSeconds: POLICY_DURATIONS[policy],
        // Draining stops emission but keeps simulating; the others keep rendering what they have.
        emitting: policy !== 'drain',
    };
}

/** A frozen clock passes zero delta, so a retirement holds rather than completing while paused. */
export function advanceRetirement(retirement: Retirement, deltaSeconds: number): Retirement {
    return { ...retirement, elapsedSeconds: retirement.elapsedSeconds + Math.max(0, deltaSeconds) };
}

export function isRetired(retirement: Retirement): boolean {
    return retirement.elapsedSeconds >= retirement.durationSeconds;
}

/** Progress through retirement, 0 at the start and 1 when finished. */
export function retirementProgress(retirement: Retirement): number {
    if (retirement.durationSeconds <= 0) {
        return 1;
    }

    return clamp01(retirement.elapsedSeconds / retirement.durationSeconds);
}

/**
 * Opacity a retiring plugin's layer should carry.
 *
 * Freeze-and-dissolve holds full opacity briefly before dissolving, which is what makes a frozen final
 * frame read as deliberate rather than as a dropped layer.
 */
export function retirementOpacity(retirement: Retirement): number {
    const progress = retirementProgress(retirement);

    switch (retirement.policy) {
        case 'immediate':
            return 0;

        case 'fade':
        case 'handoff-feedback':
            return 1 - progress;

        case 'drain':
            // Stays fully visible; what shrinks is the population, not the opacity.
            return 1;

        case 'freeze-and-dissolve':
            return progress < 0.35 ? 1 : 1 - (progress - 0.35) / 0.65;
    }
}

/** Whether the plugin's contribution should still enter the feedback buffer as it leaves. */
export function retirementFeedbackParticipation(retirement: Retirement): number {
    if (retirement.policy === 'handoff-feedback') {
        // Rises as it fades, so the departing image is handed to feedback rather than lost.
        return retirementProgress(retirement);
    }

    return retirement.policy === 'freeze-and-dissolve' ? 1 - retirementProgress(retirement) : 0;
}

/** Retirements still in progress, with completed ones dropped. */
export function advanceRetirements(
    retirements: readonly Retirement[],
    deltaSeconds: number,
): { active: Retirement[]; completed: Retirement[] } {
    const advanced = retirements.map((retirement) => advanceRetirement(retirement, deltaSeconds));

    return {
        active: advanced.filter((retirement) => !isRetired(retirement)),
        completed: advanced.filter(isRetired),
    };
}
