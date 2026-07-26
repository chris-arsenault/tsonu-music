import { describe, expect, test } from 'vitest';
import {
    buildScenePalette,
    HARMONIES,
    hsl,
    rampAt,
    rampFor,
    rotatePalette,
    wrapTurns,
    type Rgb,
} from './palette';

const chroma = (colour: Rgb): number => Math.max(...colour) - Math.min(...colour);
const luminance = (colour: Rgb): number =>
    0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2];

describe('hue conversion', () => {
    test('primaries land where they should', () => {
        expect(hsl(0, 1, 0.5)[0]).toBeCloseTo(1, 5);
        expect(hsl(1 / 3, 1, 0.5)[1]).toBeCloseTo(1, 5);
        expect(hsl(2 / 3, 1, 0.5)[2]).toBeCloseTo(1, 5);
    });

    test('zero saturation is grey at the requested lightness', () => {
        const grey = hsl(0.4, 0, 0.6);

        expect(chroma(grey)).toBeCloseTo(0, 6);
        expect(grey[0]).toBeCloseTo(0.6, 6);
    });

    test('hue wraps rather than clamping', () => {
        expect(wrapTurns(1.25)).toBeCloseTo(0.25, 6);
        expect(wrapTurns(-0.25)).toBeCloseTo(0.75, 6);
    });
});

describe('a scene draws a scheme, not a rainbow', () => {
    test('every entry sits within a bounded arc of the base hue', () => {
        // The failure this replaces: a cosine ramp across the whole hue circle contains every hue,
        // so no scene can have a colour and consecutive scenes cannot differ in one.
        for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
            const palette = buildScenePalette(seed, 0.8);

            for (const entry of palette.entries) {
                const separation = Math.abs(luminance(entry.mid) - luminance(palette.entries[0].mid));
                expect(separation, seed).toBeLessThan(0.7);
            }
        }
    });

    test('different scenes get different schemes', () => {
        const hues = new Set(
            ['s1', 's2', 's3', 's4', 's5', 's6'].map((seed) => buildScenePalette(seed, 0.8).baseHue.toFixed(3)),
        );

        expect(hues.size).toBeGreaterThan(3);
    });

    test('the same scene always gets the same scheme', () => {
        expect(buildScenePalette('stable', 0.8)).toEqual(buildScenePalette('stable', 0.8));
    });

    test('every harmony produces usable entries', () => {
        for (const harmony of HARMONIES) {
            const entry = rampFor(0.3, 0.8);

            expect(chroma(entry.mid), harmony).toBeGreaterThan(0.05);
            expect(luminance(entry.shadow), harmony).toBeLessThan(luminance(entry.mid));
            expect(luminance(entry.highlight), harmony).toBeGreaterThan(luminance(entry.mid));
        }
    });

    test('a stronger colour policy commits harder', () => {
        expect(chroma(rampFor(0.3, 1).mid)).toBeGreaterThan(chroma(rampFor(0.3, 0.1).mid));
    });
});

describe('the ramp keeps its hue at both ends', () => {
    test('shadows are not black and highlights are not white', () => {
        // A ramp ending at pure black loses its hue in the darks and one ending at pure white loses
        // it in the lights, which is how a saturated scheme still arrives looking washed out.
        const entry = rampFor(0.15, 0.9);

        expect(chroma(entry.shadow)).toBeGreaterThan(0.01);
        expect(chroma(entry.highlight)).toBeGreaterThan(0.05);
        expect(luminance(entry.highlight)).toBeLessThan(0.99);
    });

    test('luminance runs monotonically along the ramp', () => {
        const entry = rampFor(0.6, 0.8);
        let previous = -1;

        for (let light = 0; light <= 1; light += 0.05) {
            const value = luminance(rampAt(entry, light));
            expect(value).toBeGreaterThanOrEqual(previous - 1e-6);
            previous = value;
        }
    });

    test('the ends are the declared stops', () => {
        const entry = rampFor(0.6, 0.8);

        expect(rampAt(entry, 0)).toEqual(entry.shadow);
        expect(rampAt(entry, 1)).toEqual(entry.highlight);
    });
});

describe('rotation moves the scheme as a scheme', () => {
    test('rotating shifts the base hue', () => {
        const palette = buildScenePalette('rot', 0.8);
        const turned = rotatePalette(palette, 0.25, 0.8);

        expect(turned.baseHue).toBeCloseTo(wrapTurns(palette.baseHue + 0.25), 6);
    });

    test('entries keep their relationships to one another', () => {
        // Rotating each entry independently would dissolve the harmony within a few seconds.
        const palette = buildScenePalette('rel', 0.8);
        const turned = rotatePalette(palette, 0.31, 0.8);

        expect(turned.harmony).toBe(palette.harmony);
        expect(turned.entries).toHaveLength(palette.entries.length);
    });

    test('a full turn returns to where it started', () => {
        const palette = buildScenePalette('full', 0.8);
        const turned = rotatePalette(palette, 1, 0.8);

        expect(turned.baseHue).toBeCloseTo(palette.baseHue, 6);
    });
});
