import { describe, expect, test } from 'vitest';
import { silentFeatureBus } from '../../core/features';
import { createParticleWorld, emitParticle } from '../../core/particle-physics';
import { createImpactBus } from '../../core/impact';
import type { FrameContext } from '../../core/plugin';
import {
    createParticleEmitter,
    createParticleForceField,
    createParticleRenderer,
    createParticleSimulator,
    EMITTER_MODES,
    FORCE_MODES,
    type ParticleState,
} from './particles';

const CLOCK = {
    trackId: null,
    playbackTime: 0,
    duration: 0,
    state: 'playing' as const,
    generation: 0,
};

describe('particle graph contract', () => {
    test('the emitter publishes authored physical properties', () => {
        const definition = createParticleEmitter('point');
        const instance = definition.create({
            instanceId: 'ParticleEmitter:point#0',
            seed: 0.25,
            registerShader: () => undefined,
        });
        const values = new Map<string, unknown>();

        instance.update(frame({
            parameters: {
                ...(definition.parameters ?? {}),
                originX: -100,
                radius: 8,
                speed: 240,
                elasticity: 0.7,
            },
            publishValue: (resource, value) => values.set(resource, value),
        }));

        const emitters = values.get('ParticleEmitter:point#0.emitters') as Array<{
            origin: readonly [number, number];
            radius: number;
            speed: number;
            elasticity: number;
        }>;
        expect(emitters[0]).toMatchObject({
            origin: [-100, 0],
            radius: 8,
            speed: 240,
            elasticity: 0.7,
        });
    });

    test('the simulator consumes semantic emitters without requiring a force texture', () => {
        const definition = createParticleSimulator();
        const instance = definition.create({
            instanceId: 'ParticleSimulator#0',
            seed: 0.5,
            registerShader: () => undefined,
        });
        let state: ParticleState | undefined;
        const emitter = [{
            id: 'emitter',
            mode: 'point' as const,
            seed: 0.2,
            origin: [-100, 0] as const,
            emissionRadius: 0,
            directionDegrees: 0,
            spreadDegrees: 0,
            speed: 120,
            radius: 6,
            radiusJitter: 0,
            rate: 120,
            mass: 1,
            elasticity: 1,
            friction: 0,
            lifetime: 10,
            color: [1, 1, 1] as const,
        }];

        instance.activate({ clock: CLOCK, parameters: definition.parameters ?? {} });
        instance.update(frame({
            deltaSeconds: 1 / 60,
            inputs: { emitters: 'emitter.value' },
            // Drag pinned off: this test is about the emitter's configuration arriving on a body,
            // and the default drag damps the velocity by a fifth of a percent over the frame's
            // substeps, which would make an exact check about emission fail for a reason about
            // integration.
            parameters: { ...(definition.parameters ?? {}), drag: 0 },
            readValue: <T>(resource: string | undefined) =>
                (resource === 'emitter.value' ? emitter : undefined) as T | undefined,
            publishValue: (_resource, value) => { state = value as ParticleState; },
        }));

        expect(state?.activeCount).toBeGreaterThan(0);
        expect(state?.world.radii[0]).toBe(6);
        expect(state?.world.velocities[0]).toBeCloseTo(120);
        expect(Object.keys(definition.parameters ?? {}).sort())
            .toEqual(['collisionIterations', 'drag', 'particleCount']);
    });

    test('every particle plugin follows the music', () => {
        // The subsystem shipped with `defaultBindings: []` on all twenty of its definitions, so a
        // scene's particle nodes ran at their declaration defaults for its whole life: a jet of
        // twenty-four bodies a second from the centre of the screen, pointing right, on every track.
        // The scheduler distributes what a plugin declares, so declaring nothing is inert by
        // construction and no amount of scene assembly can rescue it.
        const bound = (definition: { defaultBindings?: readonly unknown[] }) =>
            (definition.defaultBindings ?? []).length;

        expect(bound(createParticleSimulator())).toBeGreaterThan(0);
        expect(bound(createParticleRenderer('discs'))).toBeGreaterThan(0);
        for (const mode of EMITTER_MODES) {
            expect(bound(createParticleEmitter(mode)), mode).toBeGreaterThan(0);
        }
        for (const mode of FORCE_MODES) {
            expect(bound(createParticleForceField(mode)), mode).toBeGreaterThan(0);
        }
    });

    test('a field settles at a population that covers the frame', () => {
        // Equilibrium is emission rate times lifetime, capped by the simulator's count. At the
        // previous defaults — twenty-four a second for six seconds against a cap of 512 — the field
        // settled at 144 bodies, which is 0.78 percent of a 1600 by 900 frame: a scatter, not a
        // layer, and the reason scene saturation fell when the rewrite landed.
        const emitter = createParticleEmitter('point');
        const rate = emitter.defaultBindings?.find((entry) => entry.parameter === 'rate');
        const radius = emitter.defaultBindings?.find((entry) => entry.parameter === 'radius');
        const count = createParticleSimulator().defaultBindings
            ?.find((entry) => entry.parameter === 'particleCount');

        const lifetime = emitter.parameters?.lifetime ?? 0;
        const midpoint = (binding: { outputRange: [number, number] } | undefined) =>
            binding ? (binding.outputRange[0] + binding.outputRange[1]) / 2 : 0;

        const population = Math.min(midpoint(rate) * lifetime, midpoint(count));
        const coverage = population * Math.PI * midpoint(radius) ** 2 / (1600 * 900);

        expect(population).toBeGreaterThan(500);
        expect(coverage).toBeGreaterThan(0.03);
    });

    test('the renderer exposes matching mask and color outputs', () => {
        const definition = createParticleRenderer('discs');
        const instance = definition.create({
            instanceId: 'ParticleRenderer:discs#0',
            seed: 0.5,
            registerShader: () => undefined,
        });

        expect(definition.inputs).toEqual([
            { name: 'state', type: 'particle-state', required: true },
        ]);
        expect(definition.outputs.map((port) => [port.name, port.type])).toEqual([
            ['mask', 'mask-texture'],
            ['color', 'color-texture'],
            // The wake. Bodies already carry velocities; publishing them is what lets a body drag
            // the image it passes through rather than only being drawn on top of it. See ADR-0012.
            ['wake', 'vector-field'],
        ]);
        expect(Object.keys(definition.parameters ?? {}).sort())
            .toEqual(['brightness', 'debug', 'wakeScale']);
        expect(instance.render({
            inputs: { state: 'ParticleSimulator#0.state' },
            outputs: {
                mask: 'ParticleRenderer:discs#0.mask',
                color: 'ParticleRenderer:discs#0.color',
                wake: 'ParticleRenderer:discs#0.wake',
            },
            previous: {},
            renderWidth: 1280,
            renderHeight: 720,
        })).toMatchObject([
            { output: 'ParticleRenderer:discs#0.mask', vertexCount: 0, clear: true },
            { output: 'ParticleRenderer:discs#0.color', vertexCount: 0, blend: 'lighten', clear: true },
            { output: 'ParticleRenderer:discs#0.wake', vertexCount: 0, blend: 'add' },
        ]);
    });

    test('the wake carries each body velocity into the geometry it draws', () => {
        // The brush-on-water-colour case: what a body is doing has to reach the buffer before it can
        // reach a field. Eight floats a body — position, radius, colour, velocity.
        const definition = createParticleRenderer('discs');
        let uploaded: { data: Float32Array; attributes: readonly { name: string }[] } | undefined;

        const instance = definition.create({
            instanceId: 'ParticleRenderer:discs#0',
            seed: 0.5,
            registerShader: () => undefined,
        });

        const world = createParticleWorld(4);
        world.width = 800;
        world.height = 600;
        emitParticle(world, {
            position: [10, 20],
            velocity: [120, -60],
            radius: 5,
            mass: 1,
            elasticity: 1,
            friction: 0,
            lifetime: 5,
            color: [1, 1, 1],
            emitterId: 1,
        });

        instance.update(frame({
            inputs: { state: 'sim.state' },
            readValue: <T>(resource: string | undefined) => (resource === 'sim.state'
                ? { world, activeCount: 1, emitters: [], forces: [], colliders: [] }
                : undefined) as T | undefined,
            uploadGeometry: (upload) => { uploaded = upload; },
        }));

        expect(uploaded?.attributes.map((attribute) => attribute.name))
            .toEqual(['aPosition', 'aRadius', 'aColor', 'aVelocity']);
        expect([...(uploaded?.data ?? [])].slice(6, 8)).toEqual([120, -60]);
    });
});

function frame(overrides: Partial<FrameContext> = {}): FrameContext {
    return {
        clock: CLOCK,
        features: silentFeatureBus(),
        deltaSeconds: 1 / 120,
        seed: 0.5,
        renderWidth: 1280,
        renderHeight: 720,
        inputs: {},
        parameters: {},
        uploadGeometry: () => undefined,
        impacts: createImpactBus(),
        publishImpacts: () => undefined,
        readField: () => undefined,
        ...overrides,
    };
}
