/**
 * Scene colour (spec section 19.9's colour policy, and section 16's theme colour source).
 *
 * The previous approach graded at the composition boundary by asking each pixel whether it looked
 * monochrome, and if so replacing its colour from a cosine ramp indexed by its own luminance. Three
 * things were wrong with that, and they compound:
 *
 * Indexing hue by luminance welds brightness to hue. Every bright pixel in a scene is the same
 * colour as every other bright pixel, so the image reads as one rainbow gradient repeated wherever
 * something is lit — mechanical, and the same mechanical in every scene.
 *
 * Testing whether a pixel "is monochrome" splits the frame into two colour regimes that do not agree.
 * Grey material gets a palette, slightly-tinted material keeps whatever it had, and the boundary
 * between them moves with the material rather than with the composition.
 *
 * A cosine ramp over the full hue circle is not a palette. It contains every hue, so no scene can
 * have a colour, and consecutive scenes cannot differ in one.
 *
 * This replaces all of it. A scene draws a small set of harmonically related colours; each material
 * branch takes one; and within a branch, luminance runs along a three-stop ramp — a deep cool
 * shadow, the branch's own hue at full chroma, and a warm highlight. That is a colour scheme rather
 * than a hue lookup, and it is what gives an image depth instead of a flat wash.
 */

import { clamp01 } from './bindings';
import { createRng } from './random';

export type Rgb = readonly [number, number, number];

/**
 * How a scene's colours relate to one another.
 *
 * Named rather than free-form, because "related" is the whole point: a set of unrelated hues is
 * exactly the rainbow this exists to avoid.
 */
export type Harmony =
    | 'analogous'
    | 'complementary'
    | 'split-complementary'
    | 'triadic'
    | 'monochromatic';

export const HARMONIES: readonly Harmony[] = [
    'analogous',
    'complementary',
    'split-complementary',
    'triadic',
    'monochromatic',
];

/**
 * One branch's colour, as the three stops its luminance runs between.
 *
 * Shadow is not black and highlight is not white. A ramp that ends at pure black loses its hue in
 * the darks, and one that ends at pure white loses it in the lights — which is how a saturated
 * palette still arrives on screen looking washed out.
 */
export interface PaletteEntry {
    shadow: Rgb;
    mid: Rgb;
    highlight: Rgb;
}

export interface ScenePalette {
    /** The hue every entry is derived from, in turns. Rotating this moves the whole scheme together. */
    baseHue: number;
    harmony: Harmony;
    entries: readonly PaletteEntry[];
}

/** Hue offsets in turns that each harmony places its entries at, relative to the base. */
const HARMONY_OFFSETS: Record<Harmony, readonly number[]> = {
    analogous: [0, 0.083, -0.083, 0.166],
    complementary: [0, 0.5, 0.042, 0.458],
    'split-complementary': [0, 0.417, 0.583, 0.083],
    triadic: [0, 0.333, 0.667, 0.166],
    // Not hueless: one hue at several chroma and lightness levels, which is a scheme in itself.
    monochromatic: [0, 0.02, -0.02, 0.04],
};

/**
 * Warm and cool shifts applied to the ends of a ramp.
 *
 * Shifting shadows toward the cool side and highlights toward the warm side is what makes a gradient
 * read as light falling on something rather than as one colour getting darker. Small: enough to see,
 * not enough to leave the scheme.
 */
const SHADOW_HUE_SHIFT = -0.045;
const HIGHLIGHT_HUE_SHIFT = 0.035;

/** Builds a scene's colour scheme. Pure, so what a scene looks like is testable without a GPU. */
export function buildScenePalette(
    entropy: string,
    /** How strongly the scheme should commit, from the theme's colour policy. 0 to 1. */
    strength: number,
    count = 4,
): ScenePalette {
    const rng = createRng(`${entropy}:palette`);
    const baseHue = rng.next();
    const harmony = rng.pick(HARMONIES) ?? 'analogous';
    const offsets = HARMONY_OFFSETS[harmony];
    const commit = clamp01(strength);

    const entries: PaletteEntry[] = [];
    for (let index = 0; index < count; index += 1) {
        const hue = wrapTurns(baseHue + (offsets[index % offsets.length] ?? 0));
        // Monochromatic separates its entries by lightness instead of by hue, or every branch would
        // arrive the same colour.
        const level = harmony === 'monochromatic' ? 1 - (index % offsets.length) * 0.18 : 1;

        entries.push(rampFor(hue, commit, level));
    }

    return { baseHue, harmony, entries };
}

/** The three stops for one hue. */
export function rampFor(hue: number, strength: number, level = 1): PaletteEntry {
    const chroma = 0.35 + 0.6 * strength;

    return {
        shadow: hsl(wrapTurns(hue + SHADOW_HUE_SHIFT), chroma * 0.85, 0.06 * level),
        mid: hsl(hue, chroma, 0.42 * level),
        highlight: hsl(wrapTurns(hue + HIGHLIGHT_HUE_SHIFT), chroma * 0.55, 0.86),
    };
}

/**
 * Rotates a whole scheme, keeping the relationships between its entries.
 *
 * This is what a hue-drift parameter drives. Rotating the base rather than each entry is why the
 * scheme stays a scheme while it moves.
 */
export function rotatePalette(palette: ScenePalette, turns: number, strength: number): ScenePalette {
    const baseHue = wrapTurns(palette.baseHue + turns);
    const offsets = HARMONY_OFFSETS[palette.harmony];

    return {
        ...palette,
        baseHue,
        entries: palette.entries.map((entry, index) => {
            const hue = wrapTurns(baseHue + (offsets[index % offsets.length] ?? 0));
            const level = palette.harmony === 'monochromatic'
                ? 1 - (index % offsets.length) * 0.18
                : 1;

            return rampFor(hue, strength, level);
        }),
    };
}

/** Where along a ramp a luminance sits. Mirrors the grade shader's interpolation. */
export function rampAt(entry: PaletteEntry, luminance: number): Rgb {
    const light = clamp01(luminance);

    if (light < 0.5) {
        return mixRgb(entry.shadow, entry.mid, light * 2);
    }

    return mixRgb(entry.mid, entry.highlight, (light - 0.5) * 2);
}

export function wrapTurns(value: number): number {
    const wrapped = value % 1;
    return wrapped < 0 ? wrapped + 1 : wrapped;
}

function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
    const t = clamp01(amount);
    return [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
    ];
}

/** Hue in turns, saturation and lightness 0 to 1. */
export function hsl(hue: number, saturation: number, lightness: number): Rgb {
    const s = clamp01(saturation);
    const l = clamp01(lightness);
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const h = wrapTurns(hue) * 6;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const m = l - c / 2;

    const [r, g, b] = h < 1 ? [c, x, 0]
        : h < 2 ? [x, c, 0]
            : h < 3 ? [0, c, x]
                : h < 4 ? [0, x, c]
                    : h < 5 ? [x, 0, c]
                        : [c, 0, x];

    return [r + m, g + m, b + m];
}
