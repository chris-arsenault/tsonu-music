import { describe, expect, test } from 'vitest';
import { silentFeatureBus } from './features';
import { DELIBERATE_ONLY_FEATURES, SIGNAL_SHAPES, shapeOf } from './signal-shapes';

describe('signal shapes', () => {
    test('every continuous channel is classified or deliberate-only', () => {
        // A channel in neither place is one distribution silently never draws and an editor never
        // offers — the failure mode that left `transient` unreachable for months under the old
        // role table.
        for (const feature of Object.keys(silentFeatureBus().continuous)) {
            const placed = shapeOf(feature) !== undefined
                || DELIBERATE_ONLY_FEATURES.includes(feature);
            expect(placed, feature).toBe(true);
        }
    });

    test('the pools are disjoint', () => {
        const seen = new Map<string, string>();
        for (const [shape, features] of Object.entries(SIGNAL_SHAPES)) {
            for (const feature of features) {
                expect(seen.get(feature), `${feature} in ${shape} and ${seen.get(feature)}`).toBeUndefined();
                seen.set(feature, shape);
            }
        }
        for (const feature of DELIBERATE_ONLY_FEATURES) {
            expect(seen.has(feature), feature).toBe(false);
        }
    });

    test('shapes reflect the bus mechanics', () => {
        // Riders are distribution-normalized; gates are not; the sawtooth and the events are their
        // own things. These pins guard against a channel being reclassified casually — the shape
        // is what makes substitution safe.
        expect(shapeOf('bass')).toBe('level');
        expect(shapeOf('stereoBalance')).toBe('level');
        expect(shapeOf('bassExcite')).toBe('pulse');
        expect(shapeOf('spectralFlux')).toBe('pulse');
        expect(shapeOf('transient')).toBe('pulse');
        expect(shapeOf('beatPhase')).toBe('phase');
        expect(shapeOf('onset')).toBe('event');
        expect(shapeOf('beatConfidence')).toBeUndefined();
    });
});
