import { describe, expect, test } from 'vitest';
import {
    accumulate,
    advanceAccumulationSlot,
    applyPersistenceOverrides,
    blackFloorFor,
    DEFAULT_THEME_PERSISTENCE,
    frameSurvival,
    gatherOffset,
    injectionFor,
    isMotionSource,
    persistenceSettings,
    type PersistenceSettings,
} from './persistence';

describe('pinned persistence', () => {
    const computed: PersistenceSettings = {
        survivalPerSecond: 0.2,
        motionScale: 0.4,
        transientPunch: 0.3,
    };

    test('no overrides leaves the computed settings alone', () => {
        expect(applyPersistenceOverrides(computed, undefined)).toEqual(computed);
        expect(applyPersistenceOverrides(computed, {})).toEqual(computed);
    });

    test('pinning one value leaves the other two following the audio', () => {
        // Three separate questions. Holding the trail still to look at it should not also stop the
        // drag, or what is being looked at is a different scene.
        const pinned = applyPersistenceOverrides(computed, { survivalPerSecond: 0.9 });

        expect(pinned.survivalPerSecond).toBe(0.9);
        expect(pinned.motionScale).toBe(computed.motionScale);
        expect(pinned.transientPunch).toBe(computed.transientPunch);
    });

    test('zero is a pin, not an absence', () => {
        const pinned = applyPersistenceOverrides(computed, {
            survivalPerSecond: 0,
            motionScale: 0,
            transientPunch: 0,
        });

        expect(pinned).toEqual({ survivalPerSecond: 0, motionScale: 0, transientPunch: 0 });
    });

    test('survival and punch are clamped to the unit interval, drag to non-negative', () => {
        const pinned = applyPersistenceOverrides(computed, {
            survivalPerSecond: 5,
            motionScale: -2,
            transientPunch: -1,
        });

        expect(pinned).toEqual({ survivalPerSecond: 1, motionScale: 0, transientPunch: 0 });
    });

    test('a non-finite pin is ignored rather than sent to the shader', () => {
        // NaN reaching the accumulation blanks the frame, which looks exactly like the fault being
        // hunted.
        const pinned = applyPersistenceOverrides(computed, {
            survivalPerSecond: Number.NaN,
            motionScale: Number.POSITIVE_INFINITY,
        });

        expect(pinned.survivalPerSecond).toBe(computed.survivalPerSecond);
        expect(pinned.motionScale).toBe(computed.motionScale);
    });
});

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
            transient: 0,
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

/**
 * At rest the accumulation admits only the complement of survival — a couple of percent per frame.
 * That is what makes long trails possible, and it is also why sparse fast material was swallowed:
 * a particle contributed a fiftieth of its brightness and was then dragged away. Worse, no musical
 * event could move more than that fraction of the screen, whatever the features were doing.
 */
describe('transients punch through the accumulation', () => {
    const settings = (transient: number) => persistenceSettings({
        themePersistence: 0.7,
        layerWeights: [],
        bass: 0.5,
        rms: 0.5,
        transient,
    });

    test('at rest the injection is the complement of survival, so trails survive', () => {
        const resting = settings(0);
        const survival = frameSurvival(resting.survivalPerSecond, 1 / 60);

        expect(resting.transientPunch).toBe(0);
        expect(injectionFor(survival, resting.transientPunch)).toBeCloseTo(1 - survival, 6);
    });

    test('a strike lets far more of the new frame through', () => {
        const survival = frameSurvival(settings(0).survivalPerSecond, 1 / 60);
        const resting = injectionFor(survival, settings(0).transientPunch);
        const struck = injectionFor(survival, settings(1).transientPunch);

        expect(struck).toBeGreaterThan(resting * 10);
    });

    test('ordinary playing barely lifts it, so the response is a pulse and not a floor', () => {
        // Squared, so a half-strength transient is a quarter of the punch rather than half of it.
        expect(settings(0.5).transientPunch).toBeLessThan(settings(1).transientPunch * 0.3);
    });

    test('a strike shoves the image as well as brightening it', () => {
        expect(settings(1).motionScale).toBeGreaterThan(settings(0).motionScale * 1.5);
    });

    test('reduced motion does not punch', () => {
        const reduced = persistenceSettings({
            themePersistence: 0.7, layerWeights: [], bass: 0.5, rms: 0.5,
            transient: 1, reducedMotion: true,
        });

        expect(reduced.transientPunch).toBe(0);
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

    test('history and new material both reach the result', () => {
        // Compression is the grade's job now, at the end of the frame. Holding headroom here is what
        // lets the final tone map roll off on luminance and keep the hue.
        const combined = accumulate(0.8, 0.8, 0.95);

        expect(combined).toBeGreaterThan(0.7);
        expect(combined).toBeLessThan(0.85);
    });

    test('a static image converges to itself rather than ramping', () => {
        // Survival and injection are complements, so the fixed point is the input. A screen combine
        // had no fixed point at all: every pixel receiving repeated contribution climbed to white,
        // with the channel that started lowest lagging behind as a colour cast.
        for (const survival of [0.9, 0.95, 0.99]) {
            let value = 0;
            for (let frame = 0; frame < 3000; frame += 1) {
                value = accumulate(value, 0.4, survival);
            }

            expect(value, `survival ${survival}`).toBeLessThanOrEqual(0.4);
            expect(value, `survival ${survival}`).toBeGreaterThan(0.2);
        }
    });

    test('an abandoned trail reaches true black rather than lingering', () => {
        // A purely multiplicative decay approaches zero without arriving, leaving a haze under
        // everything drawn afterwards.
        let value = 1;
        for (let frame = 0; frame < 600; frame += 1) {
            value = accumulate(value, 0, 0.98, blackFloorFor(1 / 60));
        }

        expect(value).toBe(0);
    });

    test('the black floor is a rate, so a trail dies over the same time at any frame rate', () => {
        expect(blackFloorFor(1 / 30)).toBeCloseTo(blackFloorFor(1 / 60) * 2, 10);
    });

    test('a frozen clock removes nothing, so a held image does not fade', () => {
        expect(blackFloorFor(0)).toBe(0);
    });
});

describe('accumulation slots', () => {
    test('the slot flips when the accumulation advances', () => {
        expect(advanceAccumulationSlot(0, true)).toBe(1);
        expect(advanceAccumulationSlot(1, true)).toBe(0);
    });

    test('a frozen frame holds the slot, so the screen does not swap between two accumulations', () => {
        // The flicker: the frame counter increments every frame, but the accumulation is written only
        // on frames that advance. Taking the slot from the counter made a paused visualizer alternate
        // between the last two images at refresh rate.
        expect(advanceAccumulationSlot(1, false)).toBe(1);
        expect(advanceAccumulationSlot(0, false)).toBe(0);
    });

    test('a run of frozen frames presents one image throughout', () => {
        let slot: 0 | 1 = advanceAccumulationSlot(0, true);
        const presented = new Set<number>();

        for (let frame = 0; frame < 120; frame += 1) {
            slot = advanceAccumulationSlot(slot, false);
            presented.add(slot);
        }

        expect(presented.size).toBe(1);
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
                next[y * SIDE + x] = accumulate(
                    history,
                    composite[y * SIDE + x],
                    survival,
                    blackFloorFor(deltaSeconds),
                );
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
    // A larger UV rate than a real scene uses, because this grid is twenty-four texels across: the
    // recurrence is what is under test, and it needs the drag to cover comparable ground per frame.
    const moving: PersistenceSettings = {
        survivalPerSecond: 0.4,
        motionScale: 1.6,
        transientPunch: 0,
    };

    test('a moving source leaves a trail lagging behind it', () => {
        // The property that matters, and the one the leaky integrator actually provides. A screen
        // combine also produced motion from a *static* source, but only by ramping every pixel toward
        // white — motion as a symptom of the washout rather than as an image.
        const travelling = (frame: number) => {
            const grid = new Float32Array(SIDE * SIDE);
            const column = 4 + Math.floor(frame / 12) % 12;
            for (let y = 0; y < SIDE; y += 1) {
                grid[y * SIDE + column] = 1;
            }
            return grid;
        };

        let accumulation = new Float32Array(SIDE * SIDE);
        const survival = frameSurvival(moving.survivalPerSecond, 1 / 60);
        const floor = blackFloorFor(1 / 60);

        for (let frame = 0; frame < 200; frame += 1) {
            const composite = travelling(frame);
            const next = new Float32Array(SIDE * SIDE);
            for (let y = 0; y < SIDE; y += 1) {
                for (let x = 0; x < SIDE; x += 1) {
                    const [dx, dy] = gatherOffset(swirlField(x, y), moving.motionScale, 1 / 60);
                    const history = sample(accumulation, x + dx * SIDE, y + dy * SIDE);
                    next[y * SIDE + x] = accumulate(history, composite[y * SIDE + x], survival, floor);
                }
            }
            accumulation = next;
        }

        const current = travelling(199);
        let behind = 0;
        for (let index = 0; index < accumulation.length; index += 1) {
            // Lit in the accumulation but not drawn this frame: it can only be history.
            if (accumulation[index] > 0.02 && current[index] === 0) {
                behind += 1;
            }
        }

        expect(behind).toBeGreaterThan(SIDE);
    });

    test('a static source converges to itself rather than ramping', () => {
        // Survival and injection are complements, so a genuinely unchanging input reaches a fixed
        // point equal to that input. This is the assertion the screen combine could never satisfy:
        // it had no fixed point, so a still image climbed to white and stayed there.
        const { deltas, final } = run(moving, 1 / 60, 400);

        expect(deltas[399]).toBeLessThan(deltas[20]);
        expect(Math.max(...final)).toBeLessThanOrEqual(1);
    });

    test('a stronger field carries material further from where it was drawn', () => {
        // Measured as spread rather than as frame-to-frame delta: a fast drag samples further from
        // the lit column each frame, so the temporal difference can fall even as the motion rises.
        const spread = (motionScale: number) => {
            const { final } = run({ ...moving, motionScale }, 1 / 60, 180);
            let lit = 0;
            for (let index = 0; index < final.length; index += 1) {
                if (final[index] > 0.01) {
                    lit += 1;
                }
            }
            return lit;
        };

        expect(spread(2.4)).toBeGreaterThan(spread(0.15));
    });

    test('one second of playback looks the same at thirty frames as at sixty', () => {
        // A gentler drag than the default, so the comparison measures the per-second formulation
        // rather than how differently a coarse step samples a strong swirl.
        const gentle: PersistenceSettings = { ...moving, motionScale: 0.5 };
        const atSixty = run(gentle, 1 / 60, 60).final;
        const atThirty = run(gentle, 1 / 30, 30).final;

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
                if (Math.abs(x - 4) > 2 && final[y * SIDE + x] > 0.002) {
                    litAway += 1;
                }
            }
        }

        expect(litAway).toBeGreaterThan(SIDE);
    });

    test('with no accumulation the frame is exactly what was drawn', () => {
        const still: PersistenceSettings = {
            survivalPerSecond: 0,
            motionScale: 0,
            transientPunch: 0,
        };
        const { final, deltas } = run(still, 1 / 60, 30);
        const composite = staticComposite();

        for (let index = 0; index < final.length; index += 1) {
            expect(final[index]).toBeCloseTo(composite[index], 6);
        }
        // And it is provably static, which is what the subsystem was doing everywhere.
        expect(deltas[deltas.length - 1]).toBe(0);
    });
});
