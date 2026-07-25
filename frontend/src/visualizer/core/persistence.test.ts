import { describe, expect, test } from 'vitest';
import {
    accumulate,
    DEFAULT_THEME_PERSISTENCE,
    frameSurvival,
    gatherOffset,
    isMotionSource,
    persistenceSettings,
    type PersistenceSettings,
} from './persistence';

describe('motion sources', () => {
    test('every field type a scene can produce drags the image', () => {
        // A vector field used to be consumed only by particle advection, which is why assembly kept
        // generating fields nothing looked at.
        expect(isMotionSource('vector-field')).toBe(true);
        expect(isMotionSource('collision-field')).toBe(true);
        expect(isMotionSource('motion-field')).toBe(true);
    });

    test('material and state are not motion', () => {
        expect(isMotionSource('color-texture')).toBe(false);
        expect(isMotionSource('particle-buffer')).toBe(false);
        expect(isMotionSource('palette')).toBe(false);
    });
});

describe('persistence settings', () => {
    const settings = (overrides: Partial<Parameters<typeof persistenceSettings>[0]> = {}) =>
        persistenceSettings({
            themePersistence: DEFAULT_THEME_PERSISTENCE,
            layerWeights: [],
            bass: 0.5,
            rms: 0.5,
            ...overrides,
        });

    test('an accumulating theme keeps more than a crisp one', () => {
        const organic = settings({ themePersistence: 0.8 });
        const geometric = settings({ themePersistence: 0.1 });

        expect(organic.survivalPerSecond).toBeGreaterThan(geometric.survivalPerSecond);
    });

    test('no scene is ever completely static', () => {
        // The substance of the missing feedback floor: whatever the theme and the layers ask for,
        // something of the previous frame survives, so the image is never regenerated from nothing.
        const barest = settings({ themePersistence: 0, layerWeights: [], bass: 0, rms: 0 });

        expect(barest.survivalPerSecond).toBeGreaterThan(0);
        expect(barest.motionScale).toBeGreaterThan(0);
    });

    test('a layer that means to persist is not averaged away by the stages beside it', () => {
        const withTrails = settings({ themePersistence: 0.1, layerWeights: [0.95, 0, 0, 0] });
        const without = settings({ themePersistence: 0.1, layerWeights: [0, 0, 0, 0] });

        expect(withTrails.survivalPerSecond).toBeGreaterThan(without.survivalPerSecond);
    });

    test('bass drags the image further, per the section 20 mapping table', () => {
        expect(settings({ bass: 1 }).motionScale)
            .toBeGreaterThan(settings({ bass: 0 }).motionScale);
    });

    test('reduced motion still accumulates but is barely dragged', () => {
        const reduced = settings({ themePersistence: 0.9, bass: 1, reducedMotion: true });
        const normal = settings({ themePersistence: 0.9, bass: 1 });

        expect(reduced.motionScale).toBeLessThan(normal.motionScale * 0.25);
        expect(reduced.survivalPerSecond).toBeGreaterThan(0);
    });

    test('settings stay inside sane bounds for any input', () => {
        for (const persistence of [0, 0.25, 0.5, 0.75, 1]) {
            for (const bass of [0, 0.5, 1]) {
                const result = settings({ themePersistence: persistence, bass, rms: bass });

                expect(result.survivalPerSecond).toBeGreaterThan(0);
                expect(result.survivalPerSecond).toBeLessThan(1);
                expect(result.motionScale).toBeGreaterThan(0);
                expect(result.motionScale).toBeLessThan(1);
            }
        }
    });
});

describe('frame survival', () => {
    test('trails last the same wall-clock time at any frame rate', () => {
        // The defect: a bare per-frame constant meant a scene smeared differently on a 144Hz display
        // than on a 60Hz one.
        const oneSecondAtSixty = Math.pow(frameSurvival(0.2, 1 / 60), 60);
        const oneSecondAtThirty = Math.pow(frameSurvival(0.2, 1 / 30), 30);

        expect(oneSecondAtSixty).toBeCloseTo(0.2, 6);
        expect(oneSecondAtThirty).toBeCloseTo(0.2, 6);
    });

    test('a frozen clock decays nothing', () => {
        expect(frameSurvival(0.5, 0)).toBe(1);
    });

    test('zero survival keeps nothing', () => {
        expect(frameSurvival(0, 1 / 60)).toBe(0);
    });
});

describe('accumulation', () => {
    test('with no survival the accumulation is exactly what was drawn', () => {
        // The degenerate case that makes a non-accumulating scene behave as it did before the
        // accumulator existed.
        expect(accumulate(0.9, 0.3, 0)).toBeCloseTo(0.3, 10);
    });

    test('a trail crossing new material rolls off rather than clipping', () => {
        const combined = accumulate(0.8, 0.8, 1);

        expect(combined).toBeGreaterThan(0.8);
        expect(combined).toBeLessThan(1);
    });

    test('repeated accumulation approaches white without exceeding it', () => {
        let value = 0;
        for (let frame = 0; frame < 500; frame += 1) {
            value = accumulate(value, 0.4, 0.99);
        }

        expect(value).toBeLessThanOrEqual(1);
    });
});

describe('gather offset', () => {
    test('the image is dragged along the field, not against it', () => {
        // Sampling from behind is what moves material forward.
        expect(gatherOffset([1, 0], 0.2, 1)).toEqual([-0.2, -0]);
    });

    test('displacement is a rate, so it is frame-rate independent', () => {
        const [slow] = gatherOffset([1, 0], 0.2, 1 / 30);
        const [fast] = gatherOffset([1, 0], 0.2, 1 / 60);

        expect(slow).toBeCloseTo(fast * 2, 10);
    });

    test('a frozen clock does not drag', () => {
        expect(gatherOffset([1, 1], 0.5, 0)).toEqual([0, 0]);
    });
});

/* -------------------------------------------------------------------------- */
/* The recurrence                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A CPU reference of the composite stage, on a small grid.
 *
 * The subsystem shipped rendering static compositions and every test passed, because nothing ran the
 * loop that decides whether the image moves. `core/persistence.ts` holds that arithmetic precisely so
 * it can be run here; `host/composite-shaders.ts` mirrors it in GLSL. What this cannot see is whether
 * the GPU path is wired to the same numbers, which stays a device check in the backlog alongside the
 * other three criteria needing real hardware.
 */
const SIDE = 24;

type Grid = Float32Array;

function sample(grid: Grid, x: number, y: number): number {
    // Bilinear, clamped at the edges, matching how the shader samples a clamped texture.
    const cx = Math.min(Math.max(x, 0), SIDE - 1);
    const cy = Math.min(Math.max(y, 0), SIDE - 1);
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(x0 + 1, SIDE - 1);
    const y1 = Math.min(y0 + 1, SIDE - 1);
    const fx = cx - x0;
    const fy = cy - y0;

    const top = grid[y0 * SIDE + x0] * (1 - fx) + grid[y0 * SIDE + x1] * fx;
    const bottom = grid[y1 * SIDE + x0] * (1 - fx) + grid[y1 * SIDE + x1] * fx;

    return top * (1 - fy) + bottom * fy;
}

/** A single bright stripe, regenerated identically every frame — the still picture case. */
function staticComposite(): Grid {
    const grid = new Float32Array(SIDE * SIDE);
    for (let y = 0; y < SIDE; y += 1) {
        grid[y * SIDE + 4] = 1;
    }
    return grid;
}

/** A rotational field, as a `ProceduralVectorField` in swirl mode produces. */
function swirlField(x: number, y: number): [number, number] {
    const cx = x / (SIDE - 1) - 0.5;
    const cy = y / (SIDE - 1) - 0.5;
    return [-cy, cx];
}

interface RunResult {
    /** Mean absolute per-pixel change between successive frames. */
    deltas: number[];
    final: Grid;
}

function run(
    settings: PersistenceSettings | ((frame: number) => PersistenceSettings),
    deltaSeconds: number,
    frames: number,
    composite = staticComposite(),
): RunResult {
    let grid = new Float32Array(SIDE * SIDE);
    const deltas: number[] = [];
    const settingsFor = typeof settings === 'function' ? settings : () => settings;

    for (let frame = 0; frame < frames; frame += 1) {
        const next = new Float32Array(SIDE * SIDE);
        const current = settingsFor(frame);
        const survival = frameSurvival(current.survivalPerSecond, deltaSeconds);

        for (let y = 0; y < SIDE; y += 1) {
            for (let x = 0; x < SIDE; x += 1) {
                const [dx, dy] = gatherOffset(swirlField(x, y), current.motionScale, deltaSeconds);
                // The offset is in UV; the grid is in texels.
                const history = sample(grid, x + dx * SIDE, y + dy * SIDE);
                next[y * SIDE + x] = accumulate(history, composite[y * SIDE + x], survival);
            }
        }

        let change = 0;
        for (let index = 0; index < next.length; index += 1) {
            change += Math.abs(next[index] - grid[index]);
        }
        deltas.push(change / next.length);
        grid = next;
    }

    return { deltas, final: grid };
}

describe('the composite recurrence produces motion', () => {
    const moving: PersistenceSettings = { survivalPerSecond: 0.4, motionScale: 0.25 };

    test('a source that regenerates the same image still produces a moving picture', () => {
        // This is the whole defect in one assertion. The stripe never changes; only the accumulation
        // being dragged and decayed makes the frame differ from the last.
        const { deltas } = run(moving, 1 / 60, 120);
        const settled = deltas.slice(60);

        for (const delta of settled) {
            expect(delta).toBeGreaterThan(1e-4);
        }
    });

    test('a frozen source and a frozen field settle only after seconds, not frames', () => {
        // With a genuinely unchanging input and an unchanging field this is a fixed-point iteration
        // and it does eventually settle — correctly so, and G-Force would do the same. What matters
        // is that the transient is long: the accumulation turns a moment of input into seconds of
        // evolving picture rather than resolving within a frame or two.
        const { deltas } = run(moving, 1 / 60, 400);

        expect(deltas[120]).toBeGreaterThan(1e-4);
        expect(deltas[399]).toBeLessThan(deltas[120]);
    });

    test('a field that moves with the music never settles', () => {
        // The real case: `motionScale` is bass-driven and the field itself is audio-modulated, so the
        // operator being iterated changes every frame and the picture keeps reorganizing. This is why
        // making the audio features actually vary was a prerequisite rather than a separate concern.
        const breathing = (frame: number): PersistenceSettings => ({
            survivalPerSecond: moving.survivalPerSecond,
            motionScale: 0.06 + 0.28 * (0.5 + 0.5 * Math.sin(frame / 37)),
        });

        const { deltas } = run(breathing, 1 / 60, 400);

        expect(deltas[399]).toBeGreaterThan(1e-4);
    });

    test('a frozen clock holds the frame exactly', () => {
        const primed = run(moving, 1 / 60, 30);
        const frozenSurvival = frameSurvival(moving.survivalPerSecond, 0);
        const [dx, dy] = gatherOffset(swirlField(3, 3), moving.motionScale, 0);

        expect(frozenSurvival).toBe(1);
        expect([dx, dy]).toEqual([0, 0]);
        expect(primed.final.some((value) => value > 0)).toBe(true);
    });

    test('a stronger field moves the picture more', () => {
        const gentle = run({ ...moving, motionScale: 0.02 }, 1 / 60, 120).deltas.slice(60);
        const strong = run({ ...moving, motionScale: 0.34 }, 1 / 60, 120).deltas.slice(60);

        const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
        expect(mean(strong)).toBeGreaterThan(mean(gentle));
    });

    test('one second of playback looks the same at thirty frames as at sixty', () => {
        const atSixty = run(moving, 1 / 60, 60).final;
        const atThirty = run(moving, 1 / 30, 30).final;

        let difference = 0;
        for (let index = 0; index < atSixty.length; index += 1) {
            difference += Math.abs(atSixty[index] - atThirty[index]);
        }

        // Not identical — a coarser step samples the swirl less often — but the same image, which is
        // what the per-second formulation buys.
        expect(difference / atSixty.length).toBeLessThan(0.05);
    });

    test('material spreads beyond where it was drawn', () => {
        // The stripe occupies one column. Anything lit outside it arrived by being dragged there.
        const { final } = run(moving, 1 / 60, 180);

        let litAway = 0;
        for (let y = 0; y < SIDE; y += 1) {
            for (let x = 0; x < SIDE; x += 1) {
                if (Math.abs(x - 4) > 2 && final[y * SIDE + x] > 0.01) {
                    litAway += 1;
                }
            }
        }

        expect(litAway).toBeGreaterThan(SIDE);
    });

    test('with no accumulation the frame is exactly what was drawn', () => {
        const still: PersistenceSettings = { survivalPerSecond: 0, motionScale: 0 };
        const { final, deltas } = run(still, 1 / 60, 30);
        const composite = staticComposite();

        for (let index = 0; index < final.length; index += 1) {
            expect(final[index]).toBeCloseTo(composite[index], 6);
        }
        // And it is provably static, which is what the subsystem was doing everywhere.
        expect(deltas[deltas.length - 1]).toBe(0);
    });
});
