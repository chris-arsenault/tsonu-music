import { describe, expect, test } from 'vitest';

import {
    createDistributionFollower,
    cumulativeAt,
    followDistribution,
    quantile,
    type DistributionFollower,
} from './distribution';

const STEP = 1 / 46;

/** Runs a series of observations through the follower, returning the final state and outputs. */
function observe(
    values: readonly number[],
    step = STEP,
    follower: DistributionFollower = createDistributionFollower(),
): { follower: DistributionFollower; outputs: number[] } {
    const outputs: number[] = [];
    let current = follower;

    for (const value of values) {
        const result = followDistribution(current, value, step);
        current = result.follower;
        outputs.push(result.normalized);
    }

    return { follower: current, outputs };
}

/** A repeating sweep confined to `low..high`, which is the shape every measured level channel has. */
function confinedSweep(low: number, high: number, count: number): number[] {
    return Array.from({ length: count }, (_, index) =>
        low + (high - low) * (0.5 - 0.5 * Math.cos((index / 37) * Math.PI * 2)));
}

function percentile(values: readonly number[], fraction: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

describe('a channel confined to part of its range is spread across all of it', () => {
    test('a level living between 0.15 and 0.25 comes out occupying nearly all of [0, 1]', () => {
        // `mid`, as measured: p05 0.150, p95 0.254. Bound over [0, 1] it moved a tenth of any
        // parameter's span, which is the defect this module exists to remove.
        const { outputs } = observe(confinedSweep(0.15, 0.25, 4000));
        const settled = outputs.slice(2000);

        expect(percentile(settled, 0.05)).toBeLessThan(0.15);
        expect(percentile(settled, 0.95)).toBeGreaterThan(0.85);
    });

    test('the output is close to uniform, not merely wider', () => {
        // A gain would widen the range and leave the shape alone. The point of a quantile mapping is
        // that each tenth of the output holds a tenth of the observations, so a binding's response
        // curve means what it says.
        const { outputs } = observe(confinedSweep(0.2, 0.32, 6000));
        const settled = outputs.slice(3000);

        const buckets = new Array(10).fill(0);
        for (const value of settled) {
            buckets[Math.min(9, Math.floor(value * 10))] += 1;
        }

        const expected = settled.length / 10;
        for (const count of buckets) {
            expect(count).toBeGreaterThan(expected * 0.4);
            expect(count).toBeLessThan(expected * 1.9);
        }
    });

    test('order is preserved: a larger input never produces a smaller output', () => {
        const { follower } = observe(confinedSweep(0.1, 0.4, 3000));

        let previous = -1;
        for (let value = 0; value <= 1; value += 0.01) {
            const current = cumulativeAt(follower, value);
            expect(current).toBeGreaterThanOrEqual(previous);
            previous = current;
        }
    });
});

describe('a channel that does not vary is left alone', () => {
    test('a constant input passes through rather than being spread across the range', () => {
        // Without the spread guard the measure's own noise fills the histogram and gets amplified to
        // full scale, so an absent band would drive a parameter as hard as a present one.
        const { outputs } = observe(new Array(3000).fill(0.04));

        expect(outputs[outputs.length - 1]).toBeCloseTo(0.04, 3);
    });

    test('a barely-varying input is still close to its raw value', () => {
        const values = Array.from({ length: 3000 }, (_, index) =>
            0.02 + 0.002 * Math.sin(index / 11));
        const { outputs } = observe(values);
        const settled = outputs.slice(1500);

        for (const value of settled) {
            expect(value).toBeLessThan(0.1);
        }
    });

    test('the guard ramps rather than switching, so a quiet channel does not jump mid-track', () => {
        const narrow = observe(confinedSweep(0.3, 0.32, 3000)).outputs.slice(1500);
        const wide = observe(confinedSweep(0.3, 0.4, 3000)).outputs.slice(1500);

        const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

        expect(spread(narrow)).toBeLessThan(spread(wide));
        expect(spread(narrow)).toBeGreaterThan(0.02);
    });
});

describe('dynamics inside the window survive', () => {
    test('a quiet section still reads below a loud one', () => {
        // The reason the window is forty seconds rather than four. Ranking a passage only against
        // itself makes every passage read full scale, which is the failure the shared band ceiling in
        // `features.ts` was written to avoid; a window spanning several sections keeps them apart.
        const section = (level: number) =>
            Array.from({ length: 736 }, (_, index) => level + 0.03 * Math.sin(index / 9));

        let follower = createDistributionFollower();
        const quiet: number[] = [];
        const loud: number[] = [];

        for (let repeat = 0; repeat < 6; repeat += 1) {
            for (const value of section(0.18)) {
                const result = followDistribution(follower, value, STEP);
                follower = result.follower;
                if (repeat >= 4) quiet.push(result.normalized);
            }
            for (const value of section(0.42)) {
                const result = followDistribution(follower, value, STEP);
                follower = result.follower;
                if (repeat >= 4) loud.push(result.normalized);
            }
        }

        const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

        expect(mean(quiet)).toBeLessThan(0.35);
        expect(mean(loud)).toBeGreaterThan(0.65);
    });
});

describe('warm-up and freeze', () => {
    test('the first observations report close to their raw value', () => {
        const { outputs } = observe(confinedSweep(0.15, 0.25, 20));

        for (const value of outputs) {
            expect(value).toBeLessThan(0.45);
        }
    });

    test('a frozen clock neither decays nor accumulates', () => {
        const { follower } = observe(confinedSweep(0.15, 0.25, 2000));
        const before = follower.weight;

        const frozen = followDistribution(follower, 0.2, 0);

        expect(frozen.follower.weight).toBe(before);
        expect(frozen.follower).toBe(follower);
        expect(frozen.normalized).toBeGreaterThan(0);
    });

    test('weight settles at the window length whatever rate observations arrive at', () => {
        const fast = observe(new Array(20000).fill(0.5), 1 / 200).follower.weight;
        const slow = observe(new Array(2000).fill(0.5), 1 / 20).follower.weight;

        expect(fast).toBeCloseTo(slow, 0);
    });
});

describe('the window forgets', () => {
    test('a channel that moves to a new range is re-centred within the window', () => {
        const settled = observe(confinedSweep(0.1, 0.2, 4000)).follower;
        const moved = observe(confinedSweep(0.6, 0.7, 4000), STEP, settled);

        // Sixty-five hundredths is the middle of where the channel now lives, so it should read near
        // the middle of the output rather than at the top where the old distribution would put it.
        expect(cumulativeAt(moved.follower, 0.65)).toBeGreaterThan(0.25);
        expect(cumulativeAt(moved.follower, 0.65)).toBeLessThan(0.75);
    });

    test('recent behaviour outweighs older behaviour of the same length', () => {
        const early = observe(new Array(1800).fill(0.2)).follower;
        const late = observe(new Array(1800).fill(0.8), STEP, early).follower;

        expect(quantile(late, 0.5)).toBeGreaterThan(0.5);
    });
});

describe('degenerate inputs', () => {
    test('an empty follower reports the raw value', () => {
        const empty = createDistributionFollower();

        expect(cumulativeAt(empty, 0.3)).toBeCloseTo(0.3, 6);
        expect(quantile(empty, 0.5)).toBe(0);
    });

    test('values outside [0, 1] are clamped rather than falling outside the histogram', () => {
        const { outputs, follower } = observe([-4, 12, 0.5, 0.5]);

        for (const value of outputs) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
        }
        expect(Number.isFinite(follower.weight)).toBe(true);
    });

    test('a non-finite observation does not corrupt the distribution', () => {
        const { follower } = observe([Number.NaN, 0.4, 0.6]);

        expect(Number.isFinite(follower.weight)).toBe(true);
        expect(Number.isFinite(cumulativeAt(follower, 0.5))).toBe(true);
    });
});
