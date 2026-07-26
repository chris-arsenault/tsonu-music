import { describe, expect, test } from 'vitest';
import {
    advanceCrossfade,
    blendFactors,
    blendForCharacter,
    composeLayers,
    createLayer,
    crossfadesBetween,
    crossfadeWeight,
    CROSSFADE_SECONDS,
    isCrossfadeComplete,
    type Crossfade,
} from './layers';
import type { BlendMode } from './passes';
import type { SelectionCharacter } from './plugin';

const ALL_MODES: BlendMode[] = [
    'none',
    'normal',
    'add',
    'screen',
    'multiply',
    'difference',
    'lighten',
    'darken',
];

describe('layer composition', () => {
    test('sorts by order', () => {
        const composition = composeLayers([
            createLayer('top', 'a.color', { order: 10 }),
            createLayer('bottom', 'b.color', { order: -5 }),
            createLayer('middle', 'c.color', { order: 0 }),
        ]);

        expect(composition.steps.map((step) => step.layer.id)).toEqual(['bottom', 'middle', 'top']);
    });

    test('breaks order ties by id so the active composition is stable', () => {
        const forward = composeLayers([
            createLayer('zebra', 'z.color'),
            createLayer('alpha', 'a.color'),
        ]);
        const reversed = composeLayers([
            createLayer('alpha', 'a.color'),
            createLayer('zebra', 'z.color'),
        ]);

        expect(forward.steps.map((step) => step.layer.id)).toEqual(['alpha', 'zebra']);
        expect(reversed.steps.map((step) => step.layer.id)).toEqual(['alpha', 'zebra']);
    });

    test('forces the bottom layer to normal blending', () => {
        const composition = composeLayers([
            createLayer('bottom', 'a.color', { order: 0, blendMode: 'add' }),
            createLayer('top', 'b.color', { order: 1, blendMode: 'add' }),
        ]);

        expect(composition.steps[0].blendMode).toBe('normal');
        expect(composition.steps[1].blendMode).toBe('add');
    });

    test('drops fully transparent layers', () => {
        const composition = composeLayers([
            createLayer('visible', 'a.color', { opacity: 0.5 }),
            createLayer('invisible', 'b.color', { opacity: 0 }),
        ]);

        expect(composition.steps.map((step) => step.layer.id)).toEqual(['visible']);
    });

    test('drops layers with no colour resource', () => {
        const composition = composeLayers([
            { ...createLayer('nothing', 'x'), color: undefined },
            createLayer('real', 'a.color'),
        ]);

        expect(composition.steps.map((step) => step.layer.id)).toEqual(['real']);
    });

    test('clamps an out-of-range opacity', () => {
        const composition = composeLayers([createLayer('over', 'a.color', { opacity: 3 })]);

        expect(composition.steps[0].opacity).toBe(1);
    });

    test('an empty scene composes to nothing rather than failing', () => {
        const composition = composeLayers([]);

        expect(composition.steps).toEqual([]);
        expect(composition.feedbackContributors).toEqual([]);
    });
});

describe('feedback participation', () => {
    test('only participating layers contribute', () => {
        const composition = composeLayers([
            createLayer('in', 'a.color', { feedbackParticipation: 0.5 }),
            createLayer('out', 'b.color', { feedbackParticipation: 0 }),
        ]);

        expect(composition.feedbackContributors.map((entry) => entry.id)).toEqual(['in']);
        expect(composition.feedbackContributors[0].weight).toBeCloseTo(0.5, 6);
    });

    test('contribution scales with layer opacity', () => {
        const composition = composeLayers([
            createLayer('faded', 'a.color', { feedbackParticipation: 1, opacity: 0.25 }),
        ]);

        expect(composition.feedbackContributors[0].weight).toBeCloseTo(0.25, 6);
    });

    test('a fully transparent layer contributes nothing to feedback', () => {
        const composition = composeLayers([
            createLayer('gone', 'a.color', { feedbackParticipation: 1, opacity: 0 }),
        ]);

        expect(composition.feedbackContributors).toEqual([]);
    });
});

describe('crossfades', () => {
    const crossfade: Crossfade = {
        fromLayerId: 'old',
        toLayerId: 'new',
        progress: 0,
        durationSeconds: 2,
    };

    test('an uninvolved layer keeps full weight', () => {
        expect(crossfadeWeight('unrelated', [crossfade])).toBe(1);
    });

    test('weights move from outgoing to incoming', () => {
        expect(crossfadeWeight('old', [crossfade])).toBe(1);
        expect(crossfadeWeight('new', [crossfade])).toBe(0);

        const midway = { ...crossfade, progress: 0.5 };
        expect(crossfadeWeight('old', [midway])).toBe(0.5);
        expect(crossfadeWeight('new', [midway])).toBe(0.5);

        const done = { ...crossfade, progress: 1 };
        expect(crossfadeWeight('old', [done])).toBe(0);
        expect(crossfadeWeight('new', [done])).toBe(1);
    });

    test('weights sum to one throughout, so total brightness holds', () => {
        for (let step = 0; step <= 10; step += 1) {
            const partial = { ...crossfade, progress: step / 10 };
            const total = crossfadeWeight('old', [partial]) + crossfadeWeight('new', [partial]);
            expect(total).toBeCloseTo(1, 6);
        }
    });

    test('a layer in two crossfades takes the lowest weight', () => {
        const second: Crossfade = {
            fromLayerId: 'new',
            toLayerId: 'newer',
            progress: 0.75,
            durationSeconds: 1,
        };

        // Incoming at 0.5 from the first fade, outgoing at 0.25 from the second.
        const weight = crossfadeWeight('new', [{ ...crossfade, progress: 0.5 }, second]);
        expect(weight).toBeCloseTo(0.25, 6);
    });

    test('crossfade weighting multiplies into composed opacity', () => {
        const composition = composeLayers(
            [createLayer('new', 'a.color', { opacity: 0.8 })],
            [{ ...crossfade, progress: 0.5 }],
        );

        expect(composition.steps[0].opacity).toBeCloseTo(0.4, 6);
    });

    test('advances proportionally to elapsed time', () => {
        const advanced = advanceCrossfade(crossfade, 0.5);
        expect(advanced.progress).toBeCloseTo(0.25, 6);
    });

    test('a frozen frame does not advance it', () => {
        const held = advanceCrossfade({ ...crossfade, progress: 0.3 }, 0);
        expect(held.progress).toBe(0.3);
    });

    test('never overshoots completion', () => {
        const advanced = advanceCrossfade({ ...crossfade, progress: 0.9 }, 10);

        expect(advanced.progress).toBe(1);
        expect(isCrossfadeComplete(advanced)).toBe(true);
    });

    test('a zero-duration crossfade completes immediately', () => {
        const instant = advanceCrossfade({ ...crossfade, durationSeconds: 0 }, 0);

        expect(isCrossfadeComplete(instant)).toBe(true);
    });
});

describe('blend factors', () => {
    test('every mode maps to factors', () => {
        for (const mode of ALL_MODES) {
            expect(blendFactors(mode)).toBeDefined();
        }
    });

    test('only none disables blending', () => {
        expect(blendFactors('none').enabled).toBe(false);

        for (const mode of ALL_MODES.filter((candidate) => candidate !== 'none')) {
            expect(blendFactors(mode).enabled, mode).toBe(true);
        }
    });

    test('normal is source-over', () => {
        expect(blendFactors('normal')).toMatchObject({
            sourceFactor: 'src-alpha',
            destinationFactor: 'one-minus-src-alpha',
            equation: 'add',
        });
    });

    test('additive accumulates into the target', () => {
        expect(blendFactors('add').destinationFactor).toBe('one');
    });

    test('lighten and darken use min and max rather than factors', () => {
        expect(blendFactors('lighten').equation).toBe('max');
        expect(blendFactors('darken').equation).toBe('min');
    });
});

/**
 * Every layer above the base blended with `screen`, a lighten operator, so parallel branches
 * accumulated toward white and read as superposition rather than interaction. Section 11 defines
 * seven modes and makes the choice the compositor's.
 */
describe('blend selection', () => {
    const character = (overrides: Partial<SelectionCharacter> = {}): SelectionCharacter => ({
        visualDensity: 0.5,
        motionEnergy: 0.5,
        geometricOrder: 0.5,
        recognizability: 0.2,
        persistence: 0.4,
        brightness: 0.5,
        dominance: 'either',
        ...overrides,
    });

    test('bright sparse material adds, because it is light being emitted', () => {
        expect(blendForCharacter(character({ brightness: 0.85, visualDensity: 0.3 }))).toBe('add');
    });

    test('bright dense material screens', () => {
        expect(blendForCharacter(character({ brightness: 0.75, visualDensity: 0.8 }))).toBe('screen');
    });

    test('dense dim material composites over, so it can occlude', () => {
        expect(blendForCharacter(character({ brightness: 0.3, visualDensity: 0.8 }))).toBe('normal');
    });

    test('the catalog does not all reduce to one mode', () => {
        const modes = new Set([
            blendForCharacter(character({ brightness: 0.9, visualDensity: 0.2 })),
            blendForCharacter(character({ brightness: 0.65, visualDensity: 0.7 })),
            blendForCharacter(character({ brightness: 0.2, visualDensity: 0.9 })),
        ]);

        expect(modes.size).toBe(3);
    });

    test('multiply is never chosen at the top level, where it would collapse the frame', () => {
        for (let brightness = 0; brightness <= 1; brightness += 0.1) {
            for (let visualDensity = 0; visualDensity <= 1; visualDensity += 0.1) {
                expect(blendForCharacter(character({ brightness, visualDensity }))).not.toBe('multiply');
            }
        }
    });
});

/**
 * Section 10 crossfades. Every piece of this existed and nothing ever built one, so scene
 * transitions swapped the frame's contents between two consecutive frames.
 */
describe('pairing branches across a scene change', () => {
    const outgoing = [createLayer('old-a', 'a.color'), createLayer('old-b', 'b.color')];
    const incoming = [createLayer('new-a', 'c.color'), createLayer('new-b', 'd.color')];

    test('every departing and arriving layer is accounted for', () => {
        const fades = crossfadesBetween(outgoing, incoming);

        expect(fades).toHaveLength(2);
        expect(fades.map((fade) => fade.fromLayerId)).toEqual(['old-a', 'old-b']);
        expect(fades.map((fade) => fade.toLayerId)).toEqual(['new-a', 'new-b']);
    });

    test('a fade starts fully on the outgoing branch', () => {
        const [fade] = crossfadesBetween(outgoing, incoming);

        expect(crossfadeWeight('old-a', [fade])).toBe(1);
        expect(crossfadeWeight('new-a', [fade])).toBe(0);
    });

    test('a fade completes in its declared duration and not before', () => {
        let [fade] = crossfadesBetween(outgoing, incoming);

        fade = advanceCrossfade(fade, CROSSFADE_SECONDS * 0.5);
        expect(isCrossfadeComplete(fade)).toBe(false);
        expect(crossfadeWeight('new-a', [fade])).toBeCloseTo(0.5, 6);

        fade = advanceCrossfade(fade, CROSSFADE_SECONDS * 0.5);
        expect(isCrossfadeComplete(fade)).toBe(true);
    });

    test('a scene that gains a branch fades it in rather than popping it', () => {
        const fades = crossfadesBetween(outgoing, [...incoming, createLayer('extra', 'e.color')]);

        expect(fades).toHaveLength(3);
        expect(crossfadeWeight('extra', fades)).toBe(0);
    });

    test('a frozen clock holds a transition mid-fade', () => {
        let [fade] = crossfadesBetween(outgoing, incoming);
        fade = advanceCrossfade(fade, CROSSFADE_SECONDS * 0.4);
        const held = advanceCrossfade(fade, 0);

        expect(held.progress).toBe(fade.progress);
    });
});
