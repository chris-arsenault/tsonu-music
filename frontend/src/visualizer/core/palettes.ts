/**
 * Curated colour schemes.
 *
 * Ported from `packages/world-schema/src/colorPalettes.ts` in the-canonry, where they steer image
 * generation. They are kept as data rather than regenerated because the point of them is that a
 * person chose the colours and the relationships between them.
 *
 * What was here before generated a base hue at random and placed the rest at fixed offsets around
 * the circle. That is an algorithm, and it shows: every scene is the same construction wearing a
 * different rotation, no scene has a colour anybody chose, and nothing in it is more important than
 * anything else. A scheme is not a set of hues at intervals — it is a dominant, something supporting
 * it, and an accent used sparingly, with a decision about where the darks and lights sit.
 *
 * `swatches` keeps the source ordering, which follows each palette's own description: what dominates
 * comes first, accents come later. `character` is what a theme selects on.
 */

export type PaletteCharacter =
    /** A hue owns the frame. Broad, confident, one identity. */
    | 'hue-anchored'
    /** Darkness owns the frame and light is scarce. The closest to what a visualizer wants. */
    | 'dark-dominant'
    /** Two colours in opposition, little in between. */
    | 'high-contrast'
    /** Full spectrum, no dominant hue. */
    | 'natural';

export interface CuratedPalette {
    id: string;
    name: string;
    description: string;
    /** Ordered as the palette's own description reads: dominant first, accents last. */
    swatches: readonly string[];
    character: PaletteCharacter;
}

export const CURATED_PALETTES: readonly CuratedPalette[] = [
    {
        id: 'crimson-dynasty',
        name: 'Crimson Dynasty',
        description: 'Deep ceremonial reds with dramatic contrast',
        swatches: ['#8B0000', '#722F37', '#2C2C2C', '#C5A03F', '#1A1A1A'],
        character: 'hue-anchored',
    },
    {
        id: 'amber-blaze',
        name: 'Amber Blaze',
        description: 'Pure warm oranges with cream and espresso',
        swatches: ['#FF8C00', '#FF6B00', '#FFF5E1', '#3C1A00', '#E8A84C'],
        character: 'hue-anchored',
    },
    {
        id: 'gilded-sunlight',
        name: 'Gilded Sunlight',
        description: 'Radiant golds and yellows, bright and optimistic',
        swatches: ['#FFD700', '#F4C430', '#FFFFF0', '#F5E6C8', '#CD7F32'],
        character: 'hue-anchored',
    },
    {
        id: 'verdant-jungle',
        name: 'Verdant Jungle',
        description: 'Saturated tropical greens with coral pop',
        swatches: ['#006B3C', '#50C878', '#98FF98', '#FF6F61', '#2E8B57'],
        character: 'hue-anchored',
    },
    {
        id: 'arctic-cyan',
        name: 'Arctic Cyan',
        description: 'Cool teals and cyans with crystalline clarity',
        swatches: ['#00CED1', '#008B8B', '#F0FFFF', '#87CEEB', '#001F3F'],
        character: 'hue-anchored',
    },
    {
        id: 'midnight-sapphire',
        name: 'Midnight Sapphire',
        description: 'Deep blues with silver accents',
        swatches: ['#082567', '#0F52BA', '#708090', '#C0C0C0', '#1B1B3A'],
        character: 'hue-anchored',
    },
    {
        id: 'electric-magenta',
        name: 'Electric Magenta',
        description: 'Bold magentas with electric teal contrast',
        swatches: ['#FF00FF', '#FF69B4', '#FFE4E1', '#008080', '#C71585'],
        character: 'hue-anchored',
    },
    {
        id: 'borealis',
        name: 'Borealis',
        description: 'Aurora lights glowing against dark polar sky',
        swatches: ['#00FF7F', '#00CED1', '#FF69B4', '#8A2BE2', '#0D0D2B'],
        character: 'dark-dominant',
    },
    {
        id: 'monochrome-noir',
        name: 'Monochrome Noir',
        description: 'Pure grayscale with extreme contrast',
        swatches: ['#1A1A1A', '#4A4A4A', '#808080', '#C0C0C0', '#F5F5F5'],
        character: 'high-contrast',
    },
    {
        id: 'volcanic-obsidian',
        name: 'Volcanic Obsidian',
        description: 'Black dominant with rare molten glow',
        swatches: ['#0A0A0A', '#1C1C1C', '#3D3D3D', '#FF4500', '#2C2C2C'],
        character: 'dark-dominant',
    },
    {
        id: 'verdigris-patina',
        name: 'Verdigris Patina',
        description: 'Aged copper greens with rust accents',
        swatches: ['#4F9D8E', '#5F8A7E', '#8B6914', '#B87333', '#C25A2C'],
        character: 'hue-anchored',
    },
    {
        id: 'natural-daylight',
        name: 'Natural Daylight',
        description: 'Full spectrum realism under bright daylight',
        swatches: ['#4A90D9', '#6ABF69', '#E8C84A', '#D95F4A', '#F5F0E6'],
        character: 'natural',
    },
    {
        id: 'vivid-realism',
        name: 'Vivid Realism',
        description: 'Saturated but true-to-life, punchy real-world colour',
        swatches: ['#1E90FF', '#32CD32', '#FFD700', '#FF4500', '#FFFFFF'],
        character: 'natural',
    },
    {
        id: 'comic-bold',
        name: 'Comic Bold',
        description: 'Bright, bold, distinct colours with strong separation',
        swatches: ['#FF0000', '#0000FF', '#FFFF00', '#00CC00', '#FF6600'],
        character: 'natural',
    },
    {
        id: 'void-iridescence',
        name: 'Void & Iridescence',
        description: 'Starfield black with electric cobalt, gold, and oil-slick iridescence',
        swatches: ['#0A0A1A', '#0044FF', '#FFD700', '#00CED1', '#8B00FF'],
        character: 'dark-dominant',
    },
    {
        id: 'blood-ivory',
        name: 'Blood & Ivory',
        description: 'Stark arterial red against bone white',
        swatches: ['#8B0000', '#CC0000', '#FFFFF0', '#F5F0DC', '#0A0A0A'],
        character: 'high-contrast',
    },
    {
        id: 'ink-gold',
        name: 'Ink & Gold',
        description: 'Jet black dominant with precious gold illumination',
        swatches: ['#0A0A0A', '#1A1A1A', '#FFD700', '#B8860B', '#2C2C2C'],
        character: 'dark-dominant',
    },
    {
        id: 'jade-obsidian',
        name: 'Jade & Obsidian',
        description: 'Precious jade green against volcanic black',
        swatches: ['#00A86B', '#ACE1AF', '#0A0A0A', '#1C1C1C', '#FFFFF0'],
        character: 'high-contrast',
    },
    {
        id: 'azure-bone',
        name: 'Azure & Bone',
        description: 'Deep azure blue against stark ivory',
        swatches: ['#003DA5', '#0047AB', '#FFFFF0', '#F5F0DC', '#2C2C2C'],
        character: 'high-contrast',
    },
];

/** Parses `#rrggbb` into linear-ish 0..1 channels. Throws on malformed input rather than guessing. */
export function parseHex(hex: string): [number, number, number] {
    const value = hex.replace('#', '');
    if (value.length !== 6) {
        throw new Error(`expected #rrggbb, received ${hex}`);
    }

    return [
        Number.parseInt(value.slice(0, 2), 16) / 255,
        Number.parseInt(value.slice(2, 4), 16) / 255,
        Number.parseInt(value.slice(4, 6), 16) / 255,
    ];
}
