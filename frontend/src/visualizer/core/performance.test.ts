import { describe, expect, test } from 'vitest';
import {
    advancePerformance,
    applyReducedMotion,
    createPerformanceState,
    DEFAULT_THRESHOLDS,
    isLowestLevel,
    profileFor,
    QUALITY_LADDER,
    suspendedProfile,
    type PerformanceSample,
    type PerformanceState,
} from './performance';

const HEALTHY_BUFFER = 30;

function feed(
    state: PerformanceState,
    sample: PerformanceSample,
    frames: number,
): PerformanceState {
    let current = state;
    for (let frame = 0; frame < frames; frame += 1) {
        current = advancePerformance(current, sample);
    }
    return current;
}

const slow: PerformanceSample = { frameTimeMs: 40, forwardBufferSeconds: HEALTHY_BUFFER };
const fast: PerformanceSample = { frameTimeMs: 6, forwardBufferSeconds: HEALTHY_BUFFER };

describe('quality ladder', () => {
    test('starts at full quality', () => {
        const profile = profileFor(0);

        expect(profile.renderScale).toBe(1);
        expect(profile.suspended).toBe(false);
        expect(profile.secondaryPostProcess).toBe(true);
    });

    test('descends the spec order without ever increasing cost', () => {
        for (let level = 1; level < QUALITY_LADDER.length; level += 1) {
            const better = QUALITY_LADDER[level - 1];
            const worse = QUALITY_LADDER[level];

            expect(worse.renderScale, `level ${level} renderScale`).toBeLessThanOrEqual(better.renderScale);
            expect(worse.particleScale, `level ${level} particleScale`).toBeLessThanOrEqual(better.particleScale);
            expect(worse.simulationScale, `level ${level} simulationScale`).toBeLessThanOrEqual(better.simulationScale);
            expect(worse.historyDepth, `level ${level} historyDepth`).toBeLessThanOrEqual(better.historyDepth);
        }
    });

    test('gives things up in the specified order', () => {
        // Resolution first, then particles, then simulation resolution, then history.
        expect(QUALITY_LADDER[1].renderScale).toBeLessThan(QUALITY_LADDER[0].renderScale);
        expect(QUALITY_LADDER[2].particleScale).toBeLessThan(QUALITY_LADDER[1].particleScale);
        expect(QUALITY_LADDER[3].simulationScale).toBeLessThan(QUALITY_LADDER[2].simulationScale);
        expect(QUALITY_LADDER[4].historyDepth).toBeLessThan(QUALITY_LADDER[3].historyDepth);
        // Then optional post-processing, then supporting, then primary, then the grammar.
        expect(QUALITY_LADDER[5].secondaryPostProcess).toBe(false);
        expect(QUALITY_LADDER[6].expensiveSupporting).toBe(false);
        expect(QUALITY_LADDER[7].expensivePrimary).toBe(false);
        expect(QUALITY_LADDER[8].reducedGrammar).toBe(true);
    });

    test('only the last rung suspends', () => {
        for (let level = 0; level < QUALITY_LADDER.length - 1; level += 1) {
            expect(QUALITY_LADDER[level].suspended, `level ${level}`).toBe(false);
        }
        expect(QUALITY_LADDER[QUALITY_LADDER.length - 1].suspended).toBe(true);
    });

    test('out-of-range levels clamp instead of returning undefined', () => {
        expect(profileFor(-5)).toBe(QUALITY_LADDER[0]);
        expect(profileFor(999)).toBe(QUALITY_LADDER[QUALITY_LADDER.length - 1]);
    });
});

describe('frame-time budgeting', () => {
    test('a comfortable frame rate holds full quality', () => {
        const state = feed(createPerformanceState(), fast, 100);

        expect(state.level).toBe(0);
    });

    test('sustained over-budget frames downgrade one rung', () => {
        const state = feed(createPerformanceState(), slow, DEFAULT_THRESHOLDS.downgradeAfterFrames);

        expect(state.level).toBe(1);
        expect(state.downgrades).toBe(1);
    });

    test('a brief spike does not downgrade', () => {
        let state = feed(createPerformanceState(), slow, DEFAULT_THRESHOLDS.downgradeAfterFrames - 1);
        state = advancePerformance(state, fast);

        expect(state.level).toBe(0);
        // The counter resets, so the next spike starts over rather than accumulating.
        expect(state.overBudgetFrames).toBe(0);
    });

    test('continued pressure walks down the whole ladder and stops', () => {
        const state = feed(
            createPerformanceState(),
            slow,
            DEFAULT_THRESHOLDS.downgradeAfterFrames * (QUALITY_LADDER.length + 4),
        );

        expect(isLowestLevel(state)).toBe(true);
        expect(state.level).toBe(QUALITY_LADDER.length - 1);
    });

    test('recovery is slower than degradation', () => {
        expect(DEFAULT_THRESHOLDS.upgradeAfterFrames).toBeGreaterThan(DEFAULT_THRESHOLDS.downgradeAfterFrames);
    });

    test('recovers one rung at a time once comfortable', () => {
        let state = feed(createPerformanceState(), slow, DEFAULT_THRESHOLDS.downgradeAfterFrames * 2);
        expect(state.level).toBe(2);

        state = feed(state, fast, DEFAULT_THRESHOLDS.upgradeAfterFrames);
        expect(state.level).toBe(1);

        state = feed(state, fast, DEFAULT_THRESHOLDS.upgradeAfterFrames);
        expect(state.level).toBe(0);
    });

    test('does not recover past full quality', () => {
        const state = feed(createPerformanceState(), fast, DEFAULT_THRESHOLDS.upgradeAfterFrames * 3);

        expect(state.level).toBe(0);
    });

    test('frame times between the budgets neither degrade nor recover', () => {
        const middling: PerformanceSample = { frameTimeMs: 16, forwardBufferSeconds: HEALTHY_BUFFER };
        let state = feed(createPerformanceState(), slow, DEFAULT_THRESHOLDS.downgradeAfterFrames);
        expect(state.level).toBe(1);

        state = feed(state, middling, 1000);
        expect(state.level).toBe(1);
    });
});

describe('buffer health', () => {
    test('a stall suspends immediately, without waiting out the frame counter', () => {
        const state = advancePerformance(createPerformanceState(), {
            frameTimeMs: 5,
            forwardBufferSeconds: HEALTHY_BUFFER,
            bufferStalled: true,
        });

        expect(profileFor(state.level).suspended).toBe(true);
        expect(state.bufferConstrained).toBe(true);
    });

    test('a starved buffer suspends even at a comfortable frame rate', () => {
        const state = advancePerformance(createPerformanceState(), {
            frameTimeMs: 4,
            forwardBufferSeconds: 1,
        });

        expect(profileFor(state.level).suspended).toBe(true);
    });

    test('a low buffer downgrades one rung per sample', () => {
        let state = advancePerformance(createPerformanceState(), { frameTimeMs: 5, forwardBufferSeconds: 4 });
        expect(state.level).toBe(1);
        expect(state.bufferConstrained).toBe(true);

        state = advancePerformance(state, { frameTimeMs: 5, forwardBufferSeconds: 4 });
        expect(state.level).toBe(2);
    });

    test('a low buffer degrades despite frame time being fine', () => {
        // The point of ADR-0004: frame time cannot see a starving buffer coming.
        const state = advancePerformance(createPerformanceState(), { frameTimeMs: 3, forwardBufferSeconds: 5 });

        expect(state.level).toBeGreaterThan(0);
    });

    test('a healthy buffer with a comfortable frame rate is unconstrained', () => {
        const state = advancePerformance(createPerformanceState(), fast);

        expect(state.bufferConstrained).toBe(false);
    });

    test('unknown buffer health falls back to frame time alone', () => {
        const state = feed(
            createPerformanceState(),
            { frameTimeMs: 40 },
            DEFAULT_THRESHOLDS.downgradeAfterFrames,
        );

        expect(state.level).toBe(1);
        expect(state.bufferConstrained).toBe(false);
    });

    test('recovery resumes once the buffer is healthy again', () => {
        let state = advancePerformance(createPerformanceState(), { frameTimeMs: 5, forwardBufferSeconds: 1 });
        expect(isLowestLevel(state)).toBe(true);

        state = feed(state, fast, DEFAULT_THRESHOLDS.upgradeAfterFrames);
        expect(state.level).toBeLessThan(QUALITY_LADDER.length - 1);
        expect(state.bufferConstrained).toBe(false);
    });

    test('downgrade count does not inflate once at the floor', () => {
        let state = advancePerformance(createPerformanceState(), { frameTimeMs: 5, bufferStalled: true });
        const atFloor = state.downgrades;

        state = advancePerformance(state, { frameTimeMs: 5, bufferStalled: true });
        expect(state.downgrades).toBe(atFloor);
    });
});

describe('preference and visibility profiles', () => {
    test('reduced motion cuts motion rather than everything', () => {
        const reduced = applyReducedMotion(profileFor(0));

        expect(reduced.particleScale).toBeLessThanOrEqual(0.25);
        expect(reduced.historyDepth).toBe(1);
        // Resolution and post-processing are not motion, so they stay.
        expect(reduced.renderScale).toBe(1);
        expect(reduced.secondaryPostProcess).toBe(true);
        expect(reduced.suspended).toBe(false);
    });

    test('reduced motion never raises a lowered profile', () => {
        const low = profileFor(QUALITY_LADDER.length - 2);
        const reduced = applyReducedMotion(low);

        expect(reduced.particleScale).toBeLessThanOrEqual(low.particleScale);
    });

    test('a hidden page renders nothing', () => {
        expect(suspendedProfile().suspended).toBe(true);
    });

    test('the recovery budget is reachable on a sixty hertz display', () => {
        // The controller is fed the cost of rendering a frame, not the interval between frames. When
        // it was fed the interval, this budget sat below the 16.7 ms vsync floor and no amount of
        // spare capacity could satisfy it: the ladder only ever descended, and since level six drops
        // the particle renderer outright, one transient hiccup deleted particles for the session.
        expect(DEFAULT_THRESHOLDS.recoveryBudgetMs).toBeLessThan(DEFAULT_THRESHOLDS.frameBudgetMs);
        expect(DEFAULT_THRESHOLDS.recoveryBudgetMs).toBeGreaterThan(0);
    });

    test('a degraded level climbs back once frames are cheap again', () => {
        let state = createPerformanceState();

        for (let frame = 0; frame < DEFAULT_THRESHOLDS.downgradeAfterFrames + 1; frame += 1) {
            state = advancePerformance(state, { frameTimeMs: DEFAULT_THRESHOLDS.frameBudgetMs + 5 });
        }
        const degraded = state.level;
        expect(degraded).toBeGreaterThan(0);

        // Comfortable frames at a cost a real machine reaches: well inside the budget, and below the
        // vsync interval that used to be reported in its place.
        for (let frame = 0; frame < DEFAULT_THRESHOLDS.upgradeAfterFrames + 1; frame += 1) {
            state = advancePerformance(state, { frameTimeMs: 4 });
        }

        expect(state.level).toBeLessThan(degraded);
    });
});
