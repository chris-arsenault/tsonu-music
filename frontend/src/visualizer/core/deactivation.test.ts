import { describe, expect, test } from 'vitest';
import {
    advanceRetirement,
    advanceRetirements,
    beginRetirement,
    isRetired,
    POLICY_DURATIONS,
    retirementFeedbackParticipation,
    retirementOpacity,
    retirementProgress,
} from './deactivation';
import type { DeactivationPolicy } from './plugin';

const ALL_POLICIES: DeactivationPolicy[] = [
    'immediate',
    'fade',
    'drain',
    'freeze-and-dissolve',
    'handoff-feedback',
];

/** Runs a retirement to completion in fixed steps. */
function runToEnd(policy: DeactivationPolicy, step = 0.1) {
    let retirement = beginRetirement('i1', policy);
    let iterations = 0;

    while (!isRetired(retirement) && iterations < 1000) {
        retirement = advanceRetirement(retirement, step);
        iterations += 1;
    }

    return { retirement, iterations };
}

describe('retirement lifecycle', () => {
    test('every policy has a duration', () => {
        for (const policy of ALL_POLICIES) {
            expect(POLICY_DURATIONS[policy], policy).toBeGreaterThanOrEqual(0);
        }
    });

    test('immediate retirement is already finished', () => {
        const retirement = beginRetirement('i1', 'immediate');

        expect(isRetired(retirement)).toBe(true);
        expect(retirementProgress(retirement)).toBe(1);
        expect(retirementOpacity(retirement)).toBe(0);
    });

    test('draining takes longer than fading', () => {
        // Existing particles have to age out, which outlasts a crossfade.
        expect(POLICY_DURATIONS.drain).toBeGreaterThan(POLICY_DURATIONS.fade);
    });

    test('every non-immediate policy eventually completes', () => {
        for (const policy of ALL_POLICIES.filter((entry) => entry !== 'immediate')) {
            const { retirement } = runToEnd(policy);
            expect(isRetired(retirement), policy).toBe(true);
        }
    });

    test('a frozen clock holds a retirement in place', () => {
        let retirement = beginRetirement('i1', 'drain');

        for (let frame = 0; frame < 500; frame += 1) {
            retirement = advanceRetirement(retirement, 0);
        }

        expect(isRetired(retirement)).toBe(false);
        expect(retirementProgress(retirement)).toBe(0);
    });

    test('progress is monotonic and bounded', () => {
        let retirement = beginRetirement('i1', 'freeze-and-dissolve');
        let previous = -1;

        for (let step = 0; step < 30; step += 1) {
            retirement = advanceRetirement(retirement, 0.1);
            const progress = retirementProgress(retirement);

            expect(progress).toBeGreaterThanOrEqual(previous);
            expect(progress).toBeLessThanOrEqual(1);
            previous = progress;
        }

        expect(previous).toBe(1);
    });

    test('draining stops emitting while the others keep rendering', () => {
        expect(beginRetirement('i1', 'drain').emitting).toBe(false);

        for (const policy of ALL_POLICIES.filter((entry) => entry !== 'drain')) {
            expect(beginRetirement('i1', policy).emitting, policy).toBe(true);
        }
    });

    test('the default policy is immediate', () => {
        expect(beginRetirement('i1').policy).toBe('immediate');
    });
});

describe('retirement opacity', () => {
    test('fading falls from full to nothing', () => {
        const start = beginRetirement('i1', 'fade');
        expect(retirementOpacity(start)).toBeCloseTo(1, 6);

        const half = advanceRetirement(start, POLICY_DURATIONS.fade / 2);
        expect(retirementOpacity(half)).toBeCloseTo(0.5, 2);

        const { retirement } = runToEnd('fade');
        expect(retirementOpacity(retirement)).toBeCloseTo(0, 6);
    });

    test('draining stays fully visible, since it is the population that shrinks', () => {
        let retirement = beginRetirement('i1', 'drain');

        for (let step = 0; step < 20; step += 1) {
            expect(retirementOpacity(retirement)).toBe(1);
            retirement = advanceRetirement(retirement, 0.1);
        }
    });

    test('freeze-and-dissolve holds before it dissolves', () => {
        const start = beginRetirement('i1', 'freeze-and-dissolve');
        const early = advanceRetirement(start, POLICY_DURATIONS['freeze-and-dissolve'] * 0.2);
        const late = advanceRetirement(start, POLICY_DURATIONS['freeze-and-dissolve'] * 0.8);

        expect(retirementOpacity(early)).toBe(1);
        expect(retirementOpacity(late)).toBeLessThan(1);
        expect(retirementOpacity(late)).toBeGreaterThan(0);
    });

    test('opacity never leaves the unit range for any policy', () => {
        for (const policy of ALL_POLICIES) {
            let retirement = beginRetirement('i1', policy);

            for (let step = 0; step < 40; step += 1) {
                const opacity = retirementOpacity(retirement);
                expect(opacity, policy).toBeGreaterThanOrEqual(0);
                expect(opacity, policy).toBeLessThanOrEqual(1);
                retirement = advanceRetirement(retirement, 0.1);
            }
        }
    });
});

describe('feedback handoff', () => {
    test('handoff participation rises as the plugin fades', () => {
        const start = beginRetirement('i1', 'handoff-feedback');
        const half = advanceRetirement(start, POLICY_DURATIONS['handoff-feedback'] / 2);

        expect(retirementFeedbackParticipation(start)).toBeCloseTo(0, 6);
        expect(retirementFeedbackParticipation(half)).toBeCloseTo(0.5, 2);
        // The departing image is left in the feedback buffer rather than lost.
        expect(retirementFeedbackParticipation(runToEnd('handoff-feedback').retirement)).toBeCloseTo(1, 6);
    });

    test('freeze-and-dissolve gives up its feedback contribution as it goes', () => {
        const start = beginRetirement('i1', 'freeze-and-dissolve');

        expect(retirementFeedbackParticipation(start)).toBeCloseTo(1, 6);
        expect(retirementFeedbackParticipation(runToEnd('freeze-and-dissolve').retirement)).toBeCloseTo(0, 6);
    });

    test('other policies contribute nothing to feedback', () => {
        for (const policy of ['immediate', 'fade', 'drain'] as DeactivationPolicy[]) {
            expect(retirementFeedbackParticipation(beginRetirement('i1', policy)), policy).toBe(0);
        }
    });
});

describe('batch advancement', () => {
    test('separates finished retirements from ongoing ones', () => {
        const retirements = [
            beginRetirement('quick', 'fade'),
            beginRetirement('slow', 'drain'),
        ];

        const result = advanceRetirements(retirements, POLICY_DURATIONS.fade + 0.01);

        expect(result.completed.map((entry) => entry.instanceId)).toEqual(['quick']);
        expect(result.active.map((entry) => entry.instanceId)).toEqual(['slow']);
    });

    test('an immediate retirement completes on the first pass', () => {
        const result = advanceRetirements([beginRetirement('gone', 'immediate')], 0);

        expect(result.completed).toHaveLength(1);
        expect(result.active).toHaveLength(0);
    });

    test('nothing in progress stays nothing', () => {
        const result = advanceRetirements([], 1);

        expect(result.active).toEqual([]);
        expect(result.completed).toEqual([]);
    });

    test('a frozen frame completes nothing', () => {
        const result = advanceRetirements([beginRetirement('slow', 'drain')], 0);

        expect(result.completed).toEqual([]);
        expect(result.active).toHaveLength(1);
    });
});
