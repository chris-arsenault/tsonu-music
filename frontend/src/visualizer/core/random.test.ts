import { describe, expect, test } from 'vitest';
import { createRng, hashSeed, sceneSeed } from './random';

describe('seed hashing', () => {
    test('is stable for the same input', () => {
        expect(hashSeed('tsonu')).toBe(hashSeed('tsonu'));
    });

    test('differs for different inputs', () => {
        expect(hashSeed('a')).not.toBe(hashSeed('b'));
        expect(hashSeed('track_1#0')).not.toBe(hashSeed('track_1#1'));
    });

    test('scene seeds separate tracks and generations', () => {
        expect(sceneSeed('track_a', 0)).not.toBe(sceneSeed('track_b', 0));
        expect(sceneSeed('track_a', 0)).not.toBe(sceneSeed('track_a', 1));
        // Replaying the same track at the same generation reproduces the scene.
        expect(sceneSeed('track_a', 2)).toBe(sceneSeed('track_a', 2));
    });

    test('a missing track still yields a usable seed', () => {
        expect(sceneSeed(null, 0)).toBe('none#0');
    });
});

describe('generator', () => {
    test('is fully deterministic for a seed', () => {
        const first = Array.from({ length: 20 }, () => createRng('fixed').next());
        const second = Array.from({ length: 20 }, () => createRng('fixed').next());

        expect(first).toEqual(second);
    });

    test('a single stream produces a varied sequence', () => {
        const rng = createRng('sequence');
        const values = Array.from({ length: 50 }, () => rng.next());

        expect(new Set(values).size).toBeGreaterThan(45);
    });

    test('values stay in the unit interval', () => {
        const rng = createRng('bounds');

        for (let draw = 0; draw < 500; draw += 1) {
            const value = rng.next();
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
    });

    test('different seeds diverge', () => {
        expect(createRng('one').next()).not.toBe(createRng('two').next());
    });

    test('the distribution is roughly uniform', () => {
        const rng = createRng('uniform');
        const buckets = new Array(10).fill(0);

        for (let draw = 0; draw < 10000; draw += 1) {
            buckets[Math.floor(rng.next() * 10)] += 1;
        }

        for (const count of buckets) {
            expect(count).toBeGreaterThan(700);
            expect(count).toBeLessThan(1300);
        }
    });
});

describe('derived helpers', () => {
    test('int stays below the bound', () => {
        const rng = createRng('ints');

        for (let draw = 0; draw < 200; draw += 1) {
            const value = rng.int(5);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(5);
            expect(Number.isInteger(value)).toBe(true);
        }
    });

    test('a non-positive bound yields zero rather than NaN', () => {
        const rng = createRng('zero');

        expect(rng.int(0)).toBe(0);
        expect(rng.int(-3)).toBe(0);
    });

    test('range spans its endpoints', () => {
        const rng = createRng('range');

        for (let draw = 0; draw < 200; draw += 1) {
            const value = rng.range(5, 10);
            expect(value).toBeGreaterThanOrEqual(5);
            expect(value).toBeLessThanOrEqual(10);
        }
    });

    test('chance honours its probability', () => {
        const rng = createRng('chance');
        let hits = 0;

        for (let draw = 0; draw < 2000; draw += 1) {
            if (rng.chance(0.25)) {
                hits += 1;
            }
        }

        expect(hits).toBeGreaterThan(400);
        expect(hits).toBeLessThan(600);
    });

    test('chance of zero and one are absolute', () => {
        const rng = createRng('absolute');

        for (let draw = 0; draw < 50; draw += 1) {
            expect(rng.chance(0)).toBe(false);
            expect(rng.chance(1)).toBe(true);
        }
    });

    test('pick returns a member, and nothing from an empty list', () => {
        const rng = createRng('pick');
        const items = ['a', 'b', 'c'];

        expect(items).toContain(rng.pick(items));
        expect(rng.pick([])).toBeUndefined();
    });

    test('weighted selection follows the weights', () => {
        const rng = createRng('weighted');
        const items = [{ id: 'rare', weight: 1 }, { id: 'common', weight: 9 }];
        let common = 0;

        for (let draw = 0; draw < 2000; draw += 1) {
            if (rng.weighted(items, (item) => item.weight)?.id === 'common') {
                common += 1;
            }
        }

        expect(common).toBeGreaterThan(1700);
        expect(common).toBeLessThan(1950);
    });

    test('weighted selection never returns a zero-weight item', () => {
        const rng = createRng('zero-weight');
        const items = [{ id: 'off', weight: 0 }, { id: 'on', weight: 1 }];

        for (let draw = 0; draw < 200; draw += 1) {
            expect(rng.weighted(items, (item) => item.weight)?.id).toBe('on');
        }
    });

    test('weighted selection returns nothing when all weights are unusable', () => {
        const rng = createRng('unusable');

        expect(rng.weighted([{ weight: 0 }], (item) => item.weight)).toBeUndefined();
        expect(rng.weighted([{ weight: Number.NaN }], (item) => item.weight)).toBeUndefined();
        expect(rng.weighted([{ weight: -5 }], (item) => item.weight)).toBeUndefined();
        expect(rng.weighted([], () => 1)).toBeUndefined();
    });

    test('shuffle permutes without mutating the input', () => {
        const rng = createRng('shuffle');
        const original = [1, 2, 3, 4, 5, 6, 7, 8];
        const shuffled = rng.shuffle(original);

        expect(original).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(shuffled.slice().sort((a, b) => a - b)).toEqual(original);
    });

    test('shuffle is deterministic for a seed', () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8];

        expect(createRng('same').shuffle(items)).toEqual(createRng('same').shuffle(items));
    });

    test('forked streams are independent and reproducible', () => {
        const parent = createRng('parent');
        const left = parent.fork('left');
        const right = parent.fork('right');

        expect(left.next()).not.toBe(right.next());

        const again = createRng('parent');
        expect(again.fork('left').next()).toBe(createRng('parent').fork('left').next());
    });

    test('draining a fork does not disturb its parent', () => {
        const parent = createRng('isolation');
        const fork = parent.fork('child');
        for (let draw = 0; draw < 100; draw += 1) {
            fork.next();
        }

        // The parent's own sequence is unchanged by whatever the fork consumed.
        const reference = createRng('isolation');
        reference.fork('child');
        expect(parent.next()).toBe(reference.next());
    });
});
