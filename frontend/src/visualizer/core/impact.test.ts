import { describe, expect, test } from 'vitest';
import {
    clearImpacts,
    createImpactBus,
    expireImpacts,
    impactAge,
    IMPACT_LIFETIME_SECONDS,
    MAX_IMPACTS,
    packImpacts,
    publishImpacts,
    strongestImpact,
    totalImpactEnergy,
    type ImpactEvent,
} from './impact';

function impact(overrides: Partial<ImpactEvent> = {}): ImpactEvent {
    return {
        position: [0.5, 0.5],
        energy: 1,
        impulse: [0, 0],
        radius: 0.2,
        playbackTime: 100,
        ...overrides,
    };
}

describe('impact bus', () => {
    test('starts empty', () => {
        expect(createImpactBus().active).toEqual([]);
    });

    test('publishing adds impacts', () => {
        const bus = publishImpacts(createImpactBus(), [impact(), impact({ energy: 2 })]);

        expect(bus.active).toHaveLength(2);
    });

    test('publishing nothing leaves the bus untouched', () => {
        const bus = createImpactBus();

        expect(publishImpacts(bus, [])).toBe(bus);
    });

    test('the queue is bounded, dropping oldest first', () => {
        let bus = createImpactBus();

        for (let index = 0; index < MAX_IMPACTS * 3; index += 1) {
            bus = publishImpacts(bus, [impact({ energy: index + 1 })]);
        }

        expect(bus.active).toHaveLength(MAX_IMPACTS);
        // The most recent survive.
        expect(bus.active[bus.active.length - 1].energy).toBe(MAX_IMPACTS * 3);
    });

    test('malformed impacts are rejected rather than stored', () => {
        const bus = publishImpacts(createImpactBus(), [
            impact({ energy: 0 }),
            impact({ energy: -1 }),
            impact({ radius: 0 }),
            impact({ position: [Number.NaN, 0.5] }),
            impact({ playbackTime: Number.POSITIVE_INFINITY }),
            impact(),
        ]);

        expect(bus.active).toHaveLength(1);
    });

    test('clearing drops everything, as seek and track change require', () => {
        const bus = publishImpacts(createImpactBus(), [impact()]);

        expect(clearImpacts().active).toEqual([]);
        expect(bus.active).toHaveLength(1);
    });
});

describe('expiry', () => {
    test('an impact expires after its lifetime', () => {
        const bus = publishImpacts(createImpactBus(), [impact({ playbackTime: 100 })]);

        expect(expireImpacts(bus, 100).active).toHaveLength(1);
        expect(expireImpacts(bus, 100 + IMPACT_LIFETIME_SECONDS / 2).active).toHaveLength(1);
        expect(expireImpacts(bus, 100 + IMPACT_LIFETIME_SECONDS + 0.01).active).toHaveLength(0);
    });

    test('expiry returns the same bus when nothing changed, avoiding churn', () => {
        const bus = publishImpacts(createImpactBus(), [impact()]);

        expect(expireImpacts(bus, 100)).toBe(bus);
    });

    test('a frozen clock keeps impacts alive', () => {
        // Playback time does not advance while frozen, so nothing ages out.
        const bus = publishImpacts(createImpactBus(), [impact({ playbackTime: 100 })]);

        for (let frame = 0; frame < 200; frame += 1) {
            expect(expireImpacts(bus, 100).active).toHaveLength(1);
        }
    });

    test('impacts from different times expire independently', () => {
        const bus = publishImpacts(createImpactBus(), [
            impact({ playbackTime: 100 }),
            impact({ playbackTime: 101 }),
        ]);

        const later = expireImpacts(bus, 100 + IMPACT_LIFETIME_SECONDS + 0.01);
        expect(later.active).toHaveLength(1);
        expect(later.active[0].playbackTime).toBe(101);
    });
});

describe('age and energy', () => {
    test('age runs from zero at impact to one at expiry', () => {
        const event = impact({ playbackTime: 100 });

        expect(impactAge(event, 100)).toBe(0);
        expect(impactAge(event, 100 + IMPACT_LIFETIME_SECONDS / 2)).toBeCloseTo(0.5, 6);
        expect(impactAge(event, 100 + IMPACT_LIFETIME_SECONDS)).toBeCloseTo(1, 6);
    });

    test('total energy decays as impacts age', () => {
        const bus = publishImpacts(createImpactBus(), [impact({ energy: 4, playbackTime: 100 })]);

        expect(totalImpactEnergy(bus, 100)).toBeCloseTo(4, 6);
        expect(totalImpactEnergy(bus, 100 + IMPACT_LIFETIME_SECONDS / 2)).toBeCloseTo(2, 6);
        expect(totalImpactEnergy(bus, 100 + IMPACT_LIFETIME_SECONDS)).toBeCloseTo(0, 6);
    });

    test('total energy sums live impacts and ignores expired ones', () => {
        const bus = publishImpacts(createImpactBus(), [
            impact({ energy: 2, playbackTime: 100 }),
            impact({ energy: 3, playbackTime: 100 }),
            impact({ energy: 10, playbackTime: 0 }),
        ]);

        expect(totalImpactEnergy(bus, 100)).toBeCloseTo(5, 6);
    });

    test('an empty bus has no energy and no strongest impact', () => {
        const bus = createImpactBus();

        expect(totalImpactEnergy(bus, 100)).toBe(0);
        expect(strongestImpact(bus, 100)).toBeUndefined();
    });

    test('the strongest impact accounts for age, not just energy', () => {
        const bus = publishImpacts(createImpactBus(), [
            // Older but stronger, decayed below the fresher one.
            impact({ energy: 3, radius: 0.1, playbackTime: 100 }),
            impact({ energy: 2, radius: 0.9, playbackTime: 100 + IMPACT_LIFETIME_SECONDS * 0.9 }),
        ]);

        const now = 100 + IMPACT_LIFETIME_SECONDS * 0.9;
        expect(strongestImpact(bus, now)?.radius).toBe(0.9);
    });
});

describe('shader packing', () => {
    test('packs position, decayed energy, and radius', () => {
        const bus = publishImpacts(createImpactBus(), [
            impact({ position: [0.25, 0.75], energy: 2, radius: 0.3, playbackTime: 100 }),
        ]);
        const buffer = new Float32Array(8);

        const count = packImpacts(bus, 100, buffer);

        expect(count).toBe(1);
        expect(buffer[0]).toBeCloseTo(0.25, 6);
        expect(buffer[1]).toBeCloseTo(0.75, 6);
        expect(buffer[2]).toBeCloseTo(2, 6);
        expect(buffer[3]).toBeCloseTo(0.3, 6);
    });

    test('zeroes the unused tail so no stale impact is read', () => {
        const bus = publishImpacts(createImpactBus(), [impact()]);
        const buffer = new Float32Array(12).fill(9);

        packImpacts(bus, 100, buffer);

        expect([...buffer.slice(4)]).toEqual(new Array(8).fill(0));
    });

    test('respects the buffer capacity rather than overflowing', () => {
        let bus = createImpactBus();
        for (let index = 0; index < 10; index += 1) {
            bus = publishImpacts(bus, [impact()]);
        }

        const buffer = new Float32Array(8);
        expect(packImpacts(bus, 100, buffer)).toBe(2);
    });

    test('expired impacts are skipped during packing', () => {
        const bus = publishImpacts(createImpactBus(), [
            impact({ playbackTime: 0 }),
            impact({ playbackTime: 100 }),
        ]);
        const buffer = new Float32Array(16);

        expect(packImpacts(bus, 100, buffer)).toBe(1);
    });

    test('an empty bus packs nothing and clears the buffer', () => {
        const buffer = new Float32Array(8).fill(5);

        expect(packImpacts(createImpactBus(), 100, buffer)).toBe(0);
        expect([...buffer]).toEqual(new Array(8).fill(0));
    });
});
