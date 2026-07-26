/**
 * Scene colour (spec section 19.9's colour policy, section 16's theme colour source).
 *
 * A scene takes one curated scheme from `palettes.ts` and every branch is coloured from it. Nothing
 * here invents a colour; it decides which of a designed set each part of the frame gets, and how
 * material travels between the scheme's dark and light ends.
 *
 * Two earlier attempts are worth recording, because both failed in ways that looked fine in code.
 *
 * The first indexed hue by luminance from a cosine ramp. That welds brightness to hue — every lit
 * pixel of a given brightness is the same colour as every other — and a ramp spanning the whole hue
 * circle contains every hue, so no scene could have a colour and consecutive scenes could not differ
 * in one.
 *
 * The second generated a base hue at random and placed the rest at fixed offsets: analogous,
 * triadic, and so on. Better, but still an algorithm wearing a different rotation each scene. Hues at
 * intervals are not a scheme. A scheme has a colour that dominates, one supporting it, and an accent
 * that appears rarely — decisions about weight and scarcity that no offset table encodes.
 */

import { clamp01 } from './bindings';
import { createRng } from './random';
import { CURATED_PALETTES, parseHex, type CuratedPalette, type PaletteCharacter } from './palettes';

export type Rgb = readonly [number, number, number];

/**
 * One branch's colour, as the three stops its luminance runs between.
 *
 * Shadow and highlight come from the scheme itself rather than being synthesised per branch, which is
 * what makes separately coloured branches read as one composition instead of as several.
 */
export interface PaletteEntry {
    shadow: Rgb;
    mid: Rgb;
    highlight: Rgb;
}

export interface ScenePalette {
    /** Which curated scheme this scene drew. Carried for diagnostics. */
    id: string;
    name: string;
    character: PaletteCharacter;
    entries: readonly PaletteEntry[];
}

/**
 * Luminance the scheme's darkest colour is pulled down to.
 *
 * Several schemes are entirely light — gilded sunlight has no dark at all — and a visualizer whose
 * frame is mostly unlit needs somewhere for the unlit part to sit. Pulling the darkest swatch down
 * rather than substituting black keeps the scheme's hue in the shadows, which is the difference
 * between a dark scene that has a colour and one that is merely dim.
 */
const SHADOW_LUMINANCE = 0.045;

/** Chroma below which a swatch is a neutral rather than a colour, and cannot serve as a branch ink. */
const NEUTRAL_CHROMA = 0.06;

export function luminanceOf(colour: Rgb): number {
    return 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2];
}

export function chromaOf(colour: Rgb): number {
    return Math.max(...colour) - Math.min(...colour);
}

/** Schemes a theme's colour policy admits. */
export function palettesFor(character?: PaletteCharacter): readonly CuratedPalette[] {
    if (!character) {
        return CURATED_PALETTES;
    }

    const matching = CURATED_PALETTES.filter((palette) => palette.character === character);
    return matching.length > 0 ? matching : CURATED_PALETTES;
}

/**
 * Draws a scheme for a scene and assigns its colours to branches.
 *
 * Branch order is the composition's order, so the first material branch takes what the scheme leads
 * with and later branches take what supports it. The most chromatic swatch is held back for the last
 * branch, which is how "accents sparingly" survives contact with a renderer: the accent colours the
 * branch least likely to fill the frame.
 */
export function buildScenePalette(
    entropy: string,
    /** How strongly the scheme commits, from the theme's colour policy. 0 to 1. */
    strength: number,
    count = 4,
    character?: PaletteCharacter,
): ScenePalette {
    const candidates = palettesFor(character);
    const palette = createRng(`${entropy}:palette`).pick(candidates) ?? CURATED_PALETTES[0];

    return scenePaletteFrom(palette, strength, count);
}

/** Builds the branch entries for a named scheme. Separated so a chosen scheme can be rebuilt. */
export function scenePaletteFrom(
    palette: CuratedPalette,
    strength: number,
    count = 4,
): ScenePalette {
    const swatches = palette.swatches.map(parseHex);
    const commit = clamp01(strength);

    const byLuminance = [...swatches].sort((a, b) => luminanceOf(a) - luminanceOf(b));
    const shadow = anchorShadow(byLuminance[0]);

    // The brightest *coloured* swatch, not simply the brightest. Several schemes carry an ivory or
    // bone as their paper — the ground a subject is drawn on — and taking that as the highlight sends
    // every lit pixel toward white, which is the wash this whole model exists to avoid. Where a
    // scheme has no colour bright enough to serve, its brightest neutral is pulled down instead.
    const brightestInk = byLuminance
        .filter((colour) => chromaOf(colour) >= NEUTRAL_CHROMA)
        .pop();
    const highlight = brightestInk ?? capLuminance(byLuminance[byLuminance.length - 1], 0.78);

    // Inks are the scheme's colours in its own order, neutrals dropped: a grey is what the shadow and
    // highlight are for, and colouring a branch with it wastes the branch.
    const inks = swatches.filter((colour) => chromaOf(colour) >= NEUTRAL_CHROMA);
    const ordered = inks.length > 0 ? inks : swatches;

    // The most chromatic ink is the accent. Moved to the end so it lands on the last branch.
    const accentIndex = ordered.reduce(
        (best, colour, index) => (chromaOf(colour) > chromaOf(ordered[best]) ? index : best),
        0,
    );
    const accent = ordered[accentIndex];
    const supporting = ordered.filter((_, index) => index !== accentIndex);

    const entries: PaletteEntry[] = [];
    for (let index = 0; index < count; index += 1) {
        // The accent goes on the last branch, chosen rather than fallen into. Cycling the whole
        // assignment with a modulo only landed it last when the ink count happened to divide the
        // branch count: with three inks and four branches it landed on branch two and branch three
        // repeated a supporting colour, and a scheme with fewer inks than that could drop the accent
        // entirely — which is the opposite of using it sparingly.
        const isAccent = index === count - 1 || supporting.length === 0;
        const ink = isAccent ? accent : supporting[index % supporting.length];

        entries.push({
            shadow,
            // Commit pulls toward the scheme's own colour; below full it relaxes toward a neutral of
            // the same luminance, which desaturates without changing how bright the branch reads.
            // Relaxing toward the highlight instead would *raise* chroma on any scheme whose
            // highlight is itself a colour, and several of them are — the gold in crimson dynasty.
            mid: mixRgb(neutralOf(ink), ink, 0.35 + 0.65 * commit),
            highlight,
        });
    }

    return { id: palette.id, name: palette.name, character: palette.character, entries };
}

/**
 * Advances a scheme without leaving it.
 *
 * Hue-rotating a designed palette destroys the thing that made it designed — a few seconds in, the
 * relationships its author chose are gone. Drift instead walks each branch along the scheme's own
 * colours, crossfading from one to the next, so the frame keeps changing and every colour in it was
 * still chosen by a person.
 */
export function driftPalette(
    palette: ScenePalette,
    /** Turns through the scheme's colours. One whole turn returns every branch to where it began. */
    turns: number,
): ScenePalette {
    // The distinct colours in play, not the branches. A scheme with fewer inks than branches has to
    // repeat one, and walking the branch list directly then lands a branch back on its own colour at
    // every whole step — drift that measurably does nothing for a third of its cycle.
    const stops: Rgb[] = [];
    for (const entry of palette.entries) {
        if (!stops.some((stop) => sameRgb(stop, entry.mid))) {
            stops.push(entry.mid);
        }
    }

    if (stops.length < 2) {
        // One colour has nowhere to walk to. Holding still is the honest result.
        return palette;
    }

    const position = wrapTurns(turns) * stops.length;
    const step = Math.floor(position);
    const blend = position - step;

    return {
        ...palette,
        entries: palette.entries.map((entry) => {
            const start = stops.findIndex((stop) => sameRgb(stop, entry.mid));
            const from = stops[(start + step) % stops.length];
            const to = stops[(start + step + 1) % stops.length];

            return {
                shadow: entry.shadow,
                mid: mixRgb(from, to, blend),
                highlight: entry.highlight,
            };
        }),
    };
}

/** Where along a ramp a luminance sits. Mirrors the composite shader's interpolation. */
export function rampAt(entry: PaletteEntry, luminance: number): Rgb {
    const light = clamp01(luminance);

    if (light < 0.5) {
        return mixRgb(entry.shadow, entry.mid, light * 2);
    }

    return mixRgb(entry.mid, entry.highlight, (light - 0.5) * 2);
}

/** Pulls a colour down to at most `ceiling` luminance, keeping its hue. */
function capLuminance(colour: Rgb, ceiling: number): Rgb {
    const light = luminanceOf(colour);
    if (light <= ceiling) {
        return colour;
    }

    const scale = ceiling / Math.max(light, 1e-4);
    return [colour[0] * scale, colour[1] * scale, colour[2] * scale];
}

/** The grey a colour would be with its chroma removed, at the same brightness. */
function neutralOf(colour: Rgb): Rgb {
    const light = luminanceOf(colour);
    return [light, light, light];
}

/** Pulls a colour down to the shadow anchor, keeping its hue. */
function anchorShadow(colour: Rgb): Rgb {
    const light = luminanceOf(colour);
    if (light <= SHADOW_LUMINANCE) {
        return colour;
    }

    const scale = SHADOW_LUMINANCE / Math.max(light, 1e-4);
    return [colour[0] * scale, colour[1] * scale, colour[2] * scale];
}

export function wrapTurns(value: number): number {
    const wrapped = value % 1;
    return wrapped < 0 ? wrapped + 1 : wrapped;
}

function sameRgb(a: Rgb, b: Rgb): boolean {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
    const t = clamp01(amount);

    return [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
    ];
}
