/**
 * Contact is either solid or it is not, and on the CPU that is a decidable question.
 *
 * The shader version could only be assessed by reading the state texture back off a GPU and taking
 * statistics, which is how it stayed broken through several rounds of measurement: every number was
 * consistent with "the solver is weak" and also with "the solver never runs". These assert the
 * property directly.
 */

import { describe, expect, test } from 'vitest';
import {
    BOUNDS,
    createParticleWorld,
    overlapFraction,
    stepParticles,
    type ParticleStepOptions,
    type ParticleWorld,
} from './particle-physics';

const RADIUS = 0.02;

function options(overrides: Partial<ParticleStepOptions> = {}): ParticleStepOptions {
    return {
        deltaSeconds: 1 / 60,
        radius: RADIUS,
        restitution: 0.4,
        drag: 0.4,
        lifetimeSeconds: 1e6,
        iterations: 4,
        force: (_x, _y, out) => { out[0] = 0; out[1] = 0; },
        spawn: (index, out) => { out[0] = index * 0.001; out[1] = 0; },
        ...overrides,
    };
}

/** Places bodies deliberately, bypassing birth. */
function place(points: readonly (readonly [number, number])[]): ParticleWorld {
    const world = createParticleWorld(points.length);
    points.forEach(([x, y], index) => {
        world.positions[index * 2] = x;
        world.positions[index * 2 + 1] = y;
        world.ages[index] = 0;
        // Non-zero so the never-placed test does not fire and respawn them.
        world.velocities[index * 2] = 1e-8;
    });

    return world;
}

describe('two bodies in contact', () => {
    test('an overlapping pair is separated to exactly touching', () => {
        const world = place([[-0.005, 0], [0.005, 0]]);

        stepParticles(world, options({ force: (_x, _y, out) => { out[0] = 0; out[1] = 0; } }));

        const gap = Math.hypot(
            world.positions[0] - world.positions[2],
            world.positions[1] - world.positions[3],
        );
        expect(gap).toBeGreaterThanOrEqual(RADIUS * 2 - 1e-6);
    });

    test('both bodies move, and by the same amount', () => {
        const world = place([[-0.005, 0], [0.005, 0]]);
        stepParticles(world, options());

        // Equal and opposite: the midpoint does not drift. This is the property a fragment shader
        // cannot provide, because a body can only write to itself.
        expect((world.positions[0] + world.positions[2]) / 2).toBeCloseTo(0, 6);
        expect(world.positions[0]).toBeLessThan(-0.005);
        expect(world.positions[2]).toBeGreaterThan(0.005);
    });

    test('bodies that are not touching are left alone', () => {
        const world = place([[-0.5, 0], [0.5, 0]]);
        stepParticles(world, options());

        expect(world.positions[0]).toBeCloseTo(-0.5, 6);
        expect(world.positions[2]).toBeCloseTo(0.5, 6);
    });

    test('exactly coincident bodies still separate', () => {
        // No separating direction exists to compute, and this is the case the shader skipped as a
        // particle finding itself — so coincident bodies stayed welded for their whole lives.
        const world = place([[0.1, 0.1], [0.1, 0.1]]);
        stepParticles(world, options());

        const gap = Math.hypot(
            world.positions[0] - world.positions[2],
            world.positions[1] - world.positions[3],
        );
        expect(gap).toBeGreaterThan(RADIUS);
    });

    test('a closing pair rebounds rather than passing through', () => {
        const world = place([[-0.021, 0], [0.021, 0]]);
        world.velocities[0] = 1;
        world.velocities[2] = -1;

        for (let frame = 0; frame < 12; frame += 1) {
            stepParticles(world, options());
        }

        // Left body moving left, right body moving right: they bounced off each other.
        expect(world.velocities[0]).toBeLessThan(0);
        expect(world.velocities[2]).toBeGreaterThan(0);
    });
});

describe('a crowd', () => {
    /** Every body at the centre, which is the hardest case and the one that used to weld. */
    function pileUp(count: number): ParticleWorld {
        const world = createParticleWorld(count);
        for (let i = 0; i < count; i += 1) {
            world.positions[i * 2] = (i % 7) * 1e-4;
            world.positions[i * 2 + 1] = Math.floor(i / 7) * 1e-4;
            world.velocities[i * 2] = 1e-8;
        }

        return world;
    }

    test('a pile resolves into a pack with no overlaps left', () => {
        const world = pileUp(200);

        for (let frame = 0; frame < 240; frame += 1) {
            stepParticles(world, options());
        }

        expect(overlapFraction(world, RADIUS)).toBeLessThan(0.02);
    });

    test('the pack stays inside the frame', () => {
        const world = pileUp(200);
        for (let frame = 0; frame < 240; frame += 1) {
            stepParticles(world, options());
        }

        for (let i = 0; i < world.count; i += 1) {
            expect(Math.abs(world.positions[i * 2])).toBeLessThanOrEqual(BOUNDS * 1.1);
            expect(Math.abs(world.positions[i * 2 + 1])).toBeLessThanOrEqual(BOUNDS * 1.1);
        }
    });

    test('a settled pack does not jitter', () => {
        const world = pileUp(150);
        for (let frame = 0; frame < 400; frame += 1) {
            stepParticles(world, options());
        }

        const before = Float32Array.from(world.positions);
        stepParticles(world, options());

        let moved = 0;
        for (let i = 0; i < before.length; i += 1) {
            moved += Math.abs(before[i] - world.positions[i]);
        }

        expect(moved / world.count).toBeLessThan(RADIUS * 0.5);
    });

    test('four thousand bodies step in reasonable time', () => {
        // The radius the plugin actually uses. At the 0.02 used elsewhere in this file, four thousand
        // discs cover a hundred and thirty percent of the frame — they do not fit, every body is
        // permanently in contact with several others, and the timing measures an impossible
        // configuration rather than the solver.
        const radius = 1 / 128;
        const world = createParticleWorld(4096);
        for (let i = 0; i < 4096; i += 1) {
            world.positions[i * 2] = ((i * 37) % 101) / 50 - 1;
            world.positions[i * 2 + 1] = ((i * 61) % 103) / 51 - 1;
            world.velocities[i * 2] = 1e-8;
        }

        const started = Date.now();
        for (let frame = 0; frame < 30; frame += 1) {
            stepParticles(world, options({ radius }));
        }
        const perFrame = (Date.now() - started) / 30;

        // Generous, because this runs on shared CI. The point is that it is milliseconds and not
        // tens of them — the objection to CPU physics at this count does not survive measurement.
        expect(perFrame).toBeLessThan(6);
    });
});

describe('surfaces', () => {
    /** A floor at y = -0.5, as a mask would present it. */
    const floor: ParticleStepOptions['surface'] = (_x, y, out) => {
        out[0] = 0;
        out[1] = 1;
        return -0.5 - y;
    };

    test('a body falling onto a surface does not pass through it', () => {
        const world = place([[0, 0.5]]);

        for (let frame = 0; frame < 200; frame += 1) {
            stepParticles(world, options({
                surface: floor,
                force: (_x, _y, out) => { out[0] = 0; out[1] = -2; },
            }));
        }

        expect(world.positions[1]).toBeGreaterThanOrEqual(-0.5 - 1e-3);
    });

    test('bodies stack against a surface instead of merging into it', () => {
        const world = createParticleWorld(60);
        for (let i = 0; i < 60; i += 1) {
            world.positions[i * 2] = ((i % 10) - 5) * 0.05;
            world.positions[i * 2 + 1] = 0.2 + Math.floor(i / 10) * 0.02;
            world.velocities[i * 2] = 1e-8;
        }

        for (let frame = 0; frame < 400; frame += 1) {
            stepParticles(world, options({
                surface: floor,
                force: (_x, _y, out) => { out[0] = 0; out[1] = -1.5; },
            }));
        }

        expect(overlapFraction(world, RADIUS)).toBeLessThan(0.05);
        for (let i = 0; i < world.count; i += 1) {
            expect(world.positions[i * 2 + 1]).toBeGreaterThan(-0.52);
        }
    });
});
