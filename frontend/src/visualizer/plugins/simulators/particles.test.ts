import { describe, expect, test } from 'vitest';
import { silentFeatureBus } from '../../core/features';
import { createImpactBus } from '../../core/impact';
import type { FrameContext } from '../../core/plugin';
import {
    createParticleEmitter,
    createParticleRenderer,
    createParticleSimulator,
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
            parameters: { ...(definition.parameters ?? {}) },
            readValue: <T>(resource: string | undefined) =>
                (resource === 'emitter.value' ? emitter : undefined) as T | undefined,
            publishValue: (_resource, value) => { state = value as ParticleState; },
        }));

        expect(state?.activeCount).toBeGreaterThan(0);
        expect(state?.world.radii[0]).toBe(6);
        expect(state?.world.velocities[0]).toBeCloseTo(120);
        expect(definition.parameters).toEqual({
            particleCount: 512,
            drag: 0,
            collisionIterations: 4,
        });
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
        ]);
        expect(definition.parameters).toEqual({ brightness: 1, debug: 0 });
        expect(instance.render({
            inputs: { state: 'ParticleSimulator#0.state' },
            outputs: {
                mask: 'ParticleRenderer:discs#0.mask',
                color: 'ParticleRenderer:discs#0.color',
            },
            previous: {},
            renderWidth: 1280,
            renderHeight: 720,
        })).toMatchObject([
            { output: 'ParticleRenderer:discs#0.mask', vertexCount: 0, clear: true },
            { output: 'ParticleRenderer:discs#0.color', vertexCount: 0, clear: true },
        ]);
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
