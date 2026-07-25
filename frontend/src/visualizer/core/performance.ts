/**
 * Performance budgeting (spec section 21, ADR-0004).
 *
 * Two inputs, not one. Frame time catches rendering cost; HLS forward-buffer length catches the
 * failure that actually harms the listener, where main-thread contention stalls playback while frame
 * time still looks fine. Playback always wins: at the floor the visualizer suspends rather than
 * letting the buffer run dry.
 */

export interface QualityProfile {
    /** Render resolution multiplier. */
    renderScale: number;
    /** Multiplier on particle and agent counts. */
    particleScale: number;
    /** Simulation texture resolution multiplier. */
    simulationScale: number;
    /** Frames of temporal history a plugin may retain. */
    historyDepth: number;
    /** Whether optional glow and secondary post-processing run. */
    secondaryPostProcess: boolean;
    /** Whether the most expensive supporting plugin stays active. */
    expensiveSupporting: boolean;
    /** Whether an optional primary plugin stays active. */
    expensivePrimary: boolean;
    /** Whether scene assembly must use the reduced grammar. */
    reducedGrammar: boolean;
    /** Nothing renders at all. The bottom of the ladder. */
    suspended: boolean;
}

/**
 * The ladder, best first. Each rung is the spec's downgrade order applied cumulatively, so descending
 * one step gives up exactly one thing.
 */
export const QUALITY_LADDER: readonly QualityProfile[] = [
    { renderScale: 1.0, particleScale: 1.0, simulationScale: 1.0, historyDepth: 8, secondaryPostProcess: true, expensiveSupporting: true, expensivePrimary: true, reducedGrammar: false, suspended: false },
    { renderScale: 0.85, particleScale: 1.0, simulationScale: 1.0, historyDepth: 8, secondaryPostProcess: true, expensiveSupporting: true, expensivePrimary: true, reducedGrammar: false, suspended: false },
    { renderScale: 0.7, particleScale: 0.6, simulationScale: 1.0, historyDepth: 8, secondaryPostProcess: true, expensiveSupporting: true, expensivePrimary: true, reducedGrammar: false, suspended: false },
    { renderScale: 0.7, particleScale: 0.6, simulationScale: 0.6, historyDepth: 8, secondaryPostProcess: true, expensiveSupporting: true, expensivePrimary: true, reducedGrammar: false, suspended: false },
    { renderScale: 0.6, particleScale: 0.5, simulationScale: 0.5, historyDepth: 3, secondaryPostProcess: true, expensiveSupporting: true, expensivePrimary: true, reducedGrammar: false, suspended: false },
    { renderScale: 0.6, particleScale: 0.5, simulationScale: 0.5, historyDepth: 3, secondaryPostProcess: false, expensiveSupporting: true, expensivePrimary: true, reducedGrammar: false, suspended: false },
    { renderScale: 0.55, particleScale: 0.4, simulationScale: 0.5, historyDepth: 2, secondaryPostProcess: false, expensiveSupporting: false, expensivePrimary: true, reducedGrammar: false, suspended: false },
    { renderScale: 0.5, particleScale: 0.3, simulationScale: 0.4, historyDepth: 2, secondaryPostProcess: false, expensiveSupporting: false, expensivePrimary: false, reducedGrammar: false, suspended: false },
    { renderScale: 0.5, particleScale: 0.25, simulationScale: 0.35, historyDepth: 1, secondaryPostProcess: false, expensiveSupporting: false, expensivePrimary: false, reducedGrammar: true, suspended: false },
    { renderScale: 0.5, particleScale: 0, simulationScale: 0.25, historyDepth: 1, secondaryPostProcess: false, expensiveSupporting: false, expensivePrimary: false, reducedGrammar: true, suspended: true },
];

export interface PerformanceThresholds {
    /** Frame time above which the controller starts giving things up. */
    frameBudgetMs: number;
    /** Frame time below which recovery is considered. */
    recoveryBudgetMs: number;
    /** Consecutive over-budget samples before downgrading. */
    downgradeAfterFrames: number;
    /** Consecutive comfortable samples before upgrading. One rung at a time. */
    upgradeAfterFrames: number;
    /** Forward buffer below this many seconds forces a downgrade regardless of frame time. */
    bufferFloorSeconds: number;
    /** Forward buffer below this suspends outright. */
    bufferPanicSeconds: number;
}

export const DEFAULT_THRESHOLDS: PerformanceThresholds = {
    // Roughly 60fps with headroom; sustained work beyond this is what the listener notices.
    frameBudgetMs: 20,
    recoveryBudgetMs: 12,
    downgradeAfterFrames: 30,
    // Recovery is deliberately slower than degradation, so quality does not oscillate.
    upgradeAfterFrames: 180,
    bufferFloorSeconds: 6,
    bufferPanicSeconds: 2,
};

export interface PerformanceState {
    level: number;
    overBudgetFrames: number;
    comfortableFrames: number;
    /** Set while buffer health is forcing the level down, so recovery waits for playback. */
    bufferConstrained: boolean;
    /** Rungs the controller has descended, for diagnostics. */
    downgrades: number;
}

export interface PerformanceSample {
    frameTimeMs: number;
    /** Seconds of audio buffered ahead, or undefined when unknown. */
    forwardBufferSeconds?: number;
    /** True when hls.js reported a stall this frame. */
    bufferStalled?: boolean;
}

export function createPerformanceState(): PerformanceState {
    return {
        level: 0,
        overBudgetFrames: 0,
        comfortableFrames: 0,
        bufferConstrained: false,
        downgrades: 0,
    };
}

export function profileFor(level: number): QualityProfile {
    const clamped = level < 0 ? 0 : level >= QUALITY_LADDER.length ? QUALITY_LADDER.length - 1 : level;

    return QUALITY_LADDER[clamped];
}

export function isLowestLevel(state: PerformanceState): boolean {
    return state.level >= QUALITY_LADDER.length - 1;
}

/**
 * Folds one sample into the controller.
 *
 * Buffer health short-circuits: a stall or a starved buffer downgrades immediately rather than waiting
 * out the frame counter, because by the time thirty frames have passed the audio has already dropped.
 */
export function advancePerformance(
    state: PerformanceState,
    sample: PerformanceSample,
    thresholds: PerformanceThresholds = DEFAULT_THRESHOLDS,
): PerformanceState {
    const buffer = sample.forwardBufferSeconds;
    const starved = sample.bufferStalled === true
        || (buffer !== undefined && buffer <= thresholds.bufferPanicSeconds);

    if (starved) {
        return {
            level: QUALITY_LADDER.length - 1,
            overBudgetFrames: 0,
            comfortableFrames: 0,
            bufferConstrained: true,
            downgrades: state.downgrades + (isLowestLevel(state) ? 0 : 1),
        };
    }

    const constrained = buffer !== undefined && buffer < thresholds.bufferFloorSeconds;
    if (constrained) {
        return {
            ...state,
            level: Math.min(state.level + 1, QUALITY_LADDER.length - 1),
            overBudgetFrames: 0,
            comfortableFrames: 0,
            bufferConstrained: true,
            downgrades: state.downgrades + (isLowestLevel(state) ? 0 : 1),
        };
    }

    const overBudget = sample.frameTimeMs > thresholds.frameBudgetMs;
    const comfortable = sample.frameTimeMs < thresholds.recoveryBudgetMs;

    const overBudgetFrames = overBudget ? state.overBudgetFrames + 1 : 0;
    const comfortableFrames = comfortable ? state.comfortableFrames + 1 : 0;

    if (overBudgetFrames >= thresholds.downgradeAfterFrames && !isLowestLevel(state)) {
        return {
            level: state.level + 1,
            overBudgetFrames: 0,
            comfortableFrames: 0,
            bufferConstrained: false,
            downgrades: state.downgrades + 1,
        };
    }

    if (comfortableFrames >= thresholds.upgradeAfterFrames && state.level > 0) {
        return {
            level: state.level - 1,
            overBudgetFrames: 0,
            comfortableFrames: 0,
            bufferConstrained: false,
            downgrades: state.downgrades,
        };
    }

    return { ...state, overBudgetFrames, comfortableFrames, bufferConstrained: false };
}

/**
 * A reduced-motion preference selects a low-energy profile rather than merely slowing animation
 * (spec section 21.3). Motion is what the preference is about, so history and secondary effects stay.
 */
export function applyReducedMotion(profile: QualityProfile): QualityProfile {
    return { ...profile, particleScale: Math.min(profile.particleScale, 0.25), historyDepth: 1 };
}

/** Page hidden: nothing renders (spec section 21.3). */
export function suspendedProfile(): QualityProfile {
    return { ...QUALITY_LADDER[QUALITY_LADDER.length - 1], suspended: true };
}
