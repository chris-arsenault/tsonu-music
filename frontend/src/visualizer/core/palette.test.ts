import { describe, expect, test } from 'vitest';
import {
    buildScenePalette,
    chromaOf,
    driftPalette,
    luminanceOf,
    palettesFor,
    presentStops,
    rampAt,
    scenePaletteFrom,
    wrapTurns,
} from './palette';
import { CURATED_PALETTES, parseHex } from './palettes';

describe('the curated schemes', () => {
    test('every scheme parses and carries enough colours to assign', () => {
        for (const palette of CURATED_PALETTES) {
            expect(palette.swatches.length, palette.id).toBeGreaterThanOrEqual(3);

            for (const swatch of palette.swatches) {
                expect(() => parseHex(swatch), `${palette.id} ${swatch}`).not.toThrow();
            }
        }
    });

    test('every scheme has at least one colour that is not a neutral', () => {
        // A scheme of only greys leaves nothing to colour a branch with. Monochrome noir is the
        // deliberate exception and is tagged high-contrast so a theme has to ask for it.
        for (const palette of CURATED_PALETTES) {
            if (palette.id === 'monochrome-noir') continue;

            const coloured = palette.swatches.map(parseHex).filter((c) => chromaOf(c) >= 0.06);
            expect(coloured.length, palette.id).toBeGreaterThan(0);
        }
    });

    test('ids are unique, since a theme selects on them', () => {
        const ids = CURATED_PALETTES.map((palette) => palette.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('a character filter narrows the draw and never empties it', () => {
        for (const character of ['dark-dominant', 'high-contrast', 'hue-anchored', 'natural'] as const) {
            const matching = palettesFor(character);

            expect(matching.length, character).toBeGreaterThan(0);
            expect(matching.every((palette) => palette.character === character), character).toBe(true);
        }
    });

    test('malformed hex is rejected rather than silently becoming black', () => {
        expect(() => parseHex('#fff')).toThrow();
        expect(() => parseHex('nonsense')).toThrow();
    });
});

describe('a scene is coloured from one scheme', () => {
    test('the frame sits on a dark that still carries the scheme', () => {
        // Several schemes are entirely light. A visualizer whose frame is mostly unlit needs the unlit
        // part to be dark, and to be dark *in the scheme* rather than merely black.
        for (const palette of CURATED_PALETTES) {
            const scene = scenePaletteFrom(palette, 0.8);

            for (const entry of scene.entries) {
                expect(luminanceOf(entry.shadow), palette.id).toBeLessThan(0.08);
            }
        }
    });

    test('every branch shares the darks and lights of the scheme', () => {
        // Separately coloured branches read as one composition only if they meet at the same ends.
        const scene = scenePaletteFrom(CURATED_PALETTES[0], 0.8, 4);

        for (const entry of scene.entries) {
            expect(entry.shadow).toEqual(scene.entries[0].shadow);
            expect(entry.highlight).toEqual(scene.entries[0].highlight);
        }
    });

    test('branches get different colours from one another', () => {
        const scene = scenePaletteFrom(CURATED_PALETTES[0], 1, 3);
        const mids = new Set(scene.entries.map((entry) => entry.mid.join(',')));

        expect(mids.size).toBeGreaterThan(1);
    });

    test('a stronger colour policy commits harder to the scheme', () => {
        const committed = scenePaletteFrom(CURATED_PALETTES[0], 1, 2);
        const relaxed = scenePaletteFrom(CURATED_PALETTES[0], 0, 2);

        expect(chromaOf(committed.entries[0].mid)).toBeGreaterThan(chromaOf(relaxed.entries[0].mid));
    });

    test('the same scene always draws the same scheme', () => {
        expect(buildScenePalette('stable', 0.8)).toEqual(buildScenePalette('stable', 0.8));
    });

    test('different scenes draw different schemes', () => {
        const drawn = new Set(
            ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map((seed) => buildScenePalette(seed, 0.8).id),
        );

        expect(drawn.size).toBeGreaterThan(2);
    });

    test('a theme character restricts what a scene can draw', () => {
        for (const seed of ['a', 'b', 'c', 'd']) {
            expect(buildScenePalette(seed, 0.8, 4, 'dark-dominant').character).toBe('dark-dominant');
        }
    });
});

describe('the ramp keeps hue at both ends', () => {
    test('luminance runs monotonically from shadow to highlight', () => {
        const scene = scenePaletteFrom(CURATED_PALETTES[0], 0.8);
        let previous = -1;

        for (let light = 0; light <= 1; light += 0.05) {
            const value = luminanceOf(rampAt(scene.entries[0], light));
            expect(value).toBeGreaterThanOrEqual(previous - 1e-6);
            previous = value;
        }
    });

    test('the ends are the declared stops', () => {
        const entry = scenePaletteFrom(CURATED_PALETTES[0], 0.8).entries[0];

        expect(rampAt(entry, 0)).toEqual(entry.shadow);
        expect(rampAt(entry, 1)).toEqual(entry.highlight);
    });
});

describe('the composite presents the whole scheme', () => {
    // The composite indexed the scheme by presented branch, and requiring a scene to converge to one
    // terminal made that index constantly zero — measured in 200 of 200 and 300 of 300 built scenes.
    // Three quarters of every scheme was unreachable and the frame was one three-stop ramp.
    const scene = scenePaletteFrom(CURATED_PALETTES[0], 0.8, 4);

    test('every entry contributes its stops, in order', () => {
        const stops = presentStops(scene);

        expect(stops).toHaveLength(scene.entries.length * 3);
        for (const [index, entry] of scene.entries.entries()) {
            expect(stops[index * 3], `entry ${index} shadow`).toEqual(entry.shadow);
            expect(stops[index * 3 + 1], `entry ${index} mid`).toEqual(entry.mid);
            expect(stops[index * 3 + 2], `entry ${index} highlight`).toEqual(entry.highlight);
        }
    });

    test('the stops reaching the frame are not all one colour', () => {
        // The property the defect removed: a ramp built from a single entry cannot show two hues,
        // whatever the material underneath it does.
        const chromatic = presentStops(scene).filter((stop) => chromaOf(stop) > 0.06);
        const directions = new Set(chromatic.map((stop) => {
            const total = stop[0] + stop[1] + stop[2];
            return total > 0 ? `${Math.round(stop[0] / total * 8)}:${Math.round(stop[1] / total * 8)}` : 'black';
        }));

        expect(chromatic.length).toBeGreaterThan(2);
        expect(directions.size).toBeGreaterThan(1);
    });
});

describe('drift stays inside the scheme', () => {
    test('drifting changes the branch colours', () => {
        const scene = scenePaletteFrom(CURATED_PALETTES[0], 1, 4);
        const drifted = driftPalette(scene, 0.5);

        expect(drifted.entries[0].mid).not.toEqual(scene.entries[0].mid);
    });

    test('a whole turn returns every branch to where it began', () => {
        const scene = scenePaletteFrom(CURATED_PALETTES[0], 1, 4);
        const turned = driftPalette(scene, 1);

        turned.entries.forEach((entry, index) => {
            expect(entry.mid[0]).toBeCloseTo(scene.entries[index].mid[0], 6);
            expect(entry.mid[1]).toBeCloseTo(scene.entries[index].mid[1], 6);
            expect(entry.mid[2]).toBeCloseTo(scene.entries[index].mid[2], 6);
        });
    });

    test('drift never invents a colour outside the scheme', () => {
        // The whole reason drift walks the scheme rather than rotating hue: a rotation leaves the
        // design within seconds, and every colour after that was chosen by arithmetic.
        const scene = scenePaletteFrom(CURATED_PALETTES[0], 1, 4);
        const inside = (value: number) => value >= -1e-6 && value <= 1 + 1e-6;

        for (let turns = 0; turns < 1; turns += 0.05) {
            for (const entry of driftPalette(scene, turns).entries) {
                expect(entry.mid.every(inside), `turns ${turns}`).toBe(true);
            }
        }
    });

    test('the ends hold still while the middle moves', () => {
        const scene = scenePaletteFrom(CURATED_PALETTES[0], 1, 4);
        const drifted = driftPalette(scene, 0.37);

        expect(drifted.entries[0].shadow).toEqual(scene.entries[0].shadow);
        expect(drifted.entries[0].highlight).toEqual(scene.entries[0].highlight);
    });

    test('turns wrap rather than clamping', () => {
        expect(wrapTurns(1.25)).toBeCloseTo(0.25, 6);
        expect(wrapTurns(-0.25)).toBeCloseTo(0.75, 6);
    });

    test('drift moves every branch at every point in the cycle', () => {
        // A scheme with fewer inks than branches has to repeat one, and walking the branch list
        // directly landed a branch back on its own colour at every whole step — drift that did
        // nothing for a measurable share of its cycle. Walking the distinct colours avoids it.
        for (const palette of CURATED_PALETTES) {
            const scene = scenePaletteFrom(palette, 1, 4);
            const distinct = new Set(scene.entries.map((entry) => entry.mid.join(',')));
            if (distinct.size < 2) {
                continue;
            }

            let still = 0;
            for (let turn = 0.05; turn < 1; turn += 0.05) {
                const drifted = driftPalette(scene, turn);
                if (drifted.entries.every((entry, index) => entry.mid.join(',') === scene.entries[index].mid.join(','))) {
                    still += 1;
                }
            }

            expect(still, `${palette.id} holds still mid-drift`).toBe(0);
        }
    });
});

describe('accent placement', () => {
    test('the accent lands on the last branch whatever the ink count', () => {
        for (const palette of CURATED_PALETTES) {
            for (const count of [2, 3, 4, 5, 6]) {
                const scene = scenePaletteFrom(palette, 1, count);
                const mids = scene.entries.map((entry) => entry.mid);
                const last = mids[mids.length - 1];

                // The accent is the most chromatic ink, so no other branch may out-chroma the last.
                const chroma = (colour: readonly number[]) => Math.max(...colour) - Math.min(...colour);
                for (const mid of mids.slice(0, -1)) {
                    expect(chroma(mid), `${palette.id} at ${count} branches`)
                        .toBeLessThanOrEqual(chroma(last) + 1e-9);
                }
            }
        }
    });
});
