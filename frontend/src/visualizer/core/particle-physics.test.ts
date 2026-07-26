import { describe, expect, test } from 'vitest';
import {
    createParticleWorld,
    emitParticle,
    stepParticles,
    type ParticleSpawn,
    type ParticleStepOptions,
} from './particle-physics';

const BODY: ParticleSpawn = {
    position: [0, 0],
    velocity: [0, 0],
    radius: 5,
    mass: 1,
    elasticity: 1,
    friction: 0,
    lifetime: 100,
    color: [1, 1, 1],
    emitterId: 0,
};

function options(overrides: Partial<ParticleStepOptions> = {}): ParticleStepOptions {
    return {
        deltaSeconds: 1 / 120,
        drag: 0,
        iterations: 4,
        forces: [],
        colliders: [],
        ...overrides,
    };
}

describe('physical particle world', () => {
    test('stores radius and material on each emitted body', () => {
        const world = createParticleWorld(1);
        emitParticle(world, {
            ...BODY,
            radius: 9,
            mass: 2,
            elasticity: 0.75,
            color: [0.2, 0.4, 0.6],
        });

        expect(world.radii[0]).toBe(9);
        expect(world.inverseMasses[0]).toBe(0.5);
        expect(world.elasticities[0]).toBe(0.75);
        expect([...world.colors]).toEqual(expect.arrayContaining([
            expect.closeTo(0.2),
            expect.closeTo(0.4),
            expect.closeTo(0.6),
        ]));
    });

    test('equal elastic circles exchange their head-on velocities', () => {
        const world = createParticleWorld(2);
        emitParticle(world, { ...BODY, position: [-5.1, 0], velocity: [20, 0] });
        emitParticle(world, { ...BODY, position: [5.1, 0], velocity: [-20, 0] });

        stepParticles(world, options({ deltaSeconds: 1 / 60 }));

        expect(world.velocities[0]).toBeLessThan(-19);
        expect(world.velocities[2]).toBeGreaterThan(19);
    });

    test('a body bounces with its radius inside the fixed frame', () => {
        const world = createParticleWorld(1);
        world.width = 200;
        world.height = 100;
        emitParticle(world, { ...BODY, position: [94, 0], velocity: [120, 0] });

        stepParticles(world, options({
            deltaSeconds: 1 / 60,
            colliders: [{ kind: 'frame', elasticity: 1, friction: 0 }],
        }));

        expect(world.positions[0]).toBeLessThanOrEqual(95);
        expect(world.velocities[0]).toBeLessThan(0);
    });

    test('a gravity well only affects bodies inside its radius', () => {
        const world = createParticleWorld(2);
        emitParticle(world, { ...BODY, position: [40, 0] });
        emitParticle(world, { ...BODY, position: [140, 0] });

        stepParticles(world, options({
            forces: [{
                kind: 'well',
                position: [0, 0],
                radius: 100,
                strength: 1000,
                repel: false,
            }],
        }));

        expect(world.velocities[0]).toBeLessThan(0);
        expect(world.velocities[2]).toBe(0);
    });

    test('a static circle behaves as a solid obstacle', () => {
        const world = createParticleWorld(1);
        emitParticle(world, { ...BODY, position: [13, 0], velocity: [-20, 0] });

        stepParticles(world, options({
            colliders: [{
                kind: 'circle',
                position: [0, 0],
                radius: 10,
                elasticity: 1,
                friction: 0,
            }],
        }));

        expect(world.positions[0]).toBeGreaterThanOrEqual(15);
        expect(world.velocities[0]).toBeGreaterThan(0);
    });

    test('lifetime removes a body instead of silently respawning it', () => {
        const world = createParticleWorld(1);
        emitParticle(world, { ...BODY, lifetime: 0.01 });

        stepParticles(world, options({ deltaSeconds: 0.02 }));

        expect(world.active[0]).toBe(0);
    });
});
