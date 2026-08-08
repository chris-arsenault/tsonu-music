/**
 * Physical particle system.
 *
 * Emitters, forces, and colliders publish synchronous authored data. The simulator owns the only
 * mutable particle world, and the renderer projects that exact state into matching mask and colour
 * textures. No texture is used as a substitute for an emitter or a force configuration.
 */

import { character, defineShaderPlugin, GLSL_COMMON } from '../define';
import type { ParameterBinding } from '../../core/bindings';
import { resourceIdFor } from '../../core/graph';
import type {
    FieldSample,
    VisualPluginDefinition,
    VisualPluginInstance,
} from '../../core/plugin';
import type { RenderPass } from '../../core/passes';
import {
    activeParticleCount,
    createParticleWorld,
    emitParticle,
    resetParticleWorld,
    stepParticles,
    type ParticleCollider,
    type ParticleForce,
    type ParticleWorld,
} from '../../core/particle-physics';

const STATE_OUTPUT = 'state';
const EMITTER_OUTPUT = 'emitters';
const FORCE_OUTPUT = 'forces';
const COLLIDER_OUTPUT = 'colliders';
const PARTICLE_CAPACITY = 4096;
const FIXED_STEP = 1 / 120;
const MAX_CATCH_UP = 0.1;

export const PARTICLE_RENDER_MODES = ['points', 'discs', 'sparks', 'comets'] as const;
export const EMITTER_MODES = ['point', 'region', 'line', 'ring', 'shape'] as const;
export const FORCE_MODES = ['attract', 'repel', 'vortex', 'gravity', 'wind', 'curl'] as const;
export const COLLIDER_MODES = ['frame', 'segment', 'circle', 'mask'] as const;

type EmitterMode = typeof EMITTER_MODES[number];
type ForceMode = typeof FORCE_MODES[number];
type ColliderMode = typeof COLLIDER_MODES[number];

export interface ParticleEmitterConfig {
    id: string;
    mode: EmitterMode;
    seed: number;
    origin: readonly [number, number];
    emissionRadius: number;
    directionDegrees: number;
    spreadDegrees: number;
    speed: number;
    radius: number;
    radiusJitter: number;
    rate: number;
    mass: number;
    elasticity: number;
    friction: number;
    lifetime: number;
    color: readonly [number, number, number];
    shape?: FieldSample;
}

export type ParticleForceConfig =
    | {
        id: string;
        kind: 'uniform';
        acceleration: readonly [number, number];
    }
    | {
        id: string;
        kind: 'well';
        position: readonly [number, number];
        radius: number;
        strength: number;
        repel: boolean;
    }
    | {
        id: string;
        kind: 'vortex';
        position: readonly [number, number];
        radius: number;
        tangentialStrength: number;
        inwardStrength: number;
    }
    | {
        id: string;
        kind: 'field';
        strength: number;
        field?: FieldSample;
    };

export type ParticleColliderConfig =
    | Exclude<ParticleCollider, { kind: 'mask' }>
    | ({
        kind: 'mask';
        field?: FieldSample;
        containInside: boolean;
        elasticity: number;
        friction: number;
    });

export interface ParticleState {
    world: ParticleWorld;
    activeCount: number;
    emitters: EmitterList;
    forces: ForceList;
    colliders: readonly ParticleCollider[];
}

type EmitterList = readonly ParticleEmitterConfig[];
type ForceList = readonly ParticleForceConfig[];
type ColliderList = readonly ParticleColliderConfig[];

const PARTICLE_VERTEX = `#version 300 es
in vec2 aPosition;
in float aRadius;
in vec3 aColor;
out vec3 vColor;

uniform vec2 uWorldSize;

void main() {
    vColor = aColor;
    gl_PointSize = max(1.0, aRadius * 2.0);
    gl_Position = vec4(aPosition / max(vec2(1.0), uWorldSize * 0.5), 0.0, 1.0);
}`;

const PARTICLE_MASK_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;

void main() {
    float distanceFromCentre = length(gl_PointCoord - 0.5);
    float coverage = 1.0 - smoothstep(0.47, 0.5, distanceFromCentre);
    if (coverage <= 0.0) {
        discard;
    }
    fragColor = vec4(vec3(coverage), coverage);
}`;

const PARTICLE_COLOR_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;

uniform float uBrightness;

void main() {
    float distanceFromCentre = length(gl_PointCoord - 0.5);
    float coverage = 1.0 - smoothstep(0.47, 0.5, distanceFromCentre);
    if (coverage <= 0.0) {
        discard;
    }
    fragColor = vec4(vColor * uBrightness * coverage, coverage);
}`;

const PARTICLE_DEBUG_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;

void main() {
    float distanceFromCentre = length(gl_PointCoord - 0.5);
    float ring = 1.0 - smoothstep(0.015, 0.03, abs(distanceFromCentre - 0.47));
    if (ring <= 0.0) {
        discard;
    }
    fragColor = vec4(1.0, 0.25, 0.08, ring);
}`;

const DEBUG_LINE_VERTEX = `#version 300 es
in vec2 aPosition;
in vec3 aColor;
out vec3 vColor;

uniform vec2 uWorldSize;

void main() {
    vColor = aColor;
    gl_Position = vec4(aPosition / max(vec2(1.0), uWorldSize * 0.5), 0.0, 1.0);
}`;

const DEBUG_LINE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;

void main() {
    fragColor = vec4(vColor, 0.9);
}`;

const TRAIL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uHistory;
uniform float uDecay;
uniform float uAmount;
uniform float uDelta;
${GLSL_COMMON}

void main() {
    vec4 history = texture(uHistory, vUv) * pow(uDecay, max(uDelta, 0.0) * 60.0);
    vec4 incoming = texture(uSource, vUv) * uAmount;
    fragColor = max(history, incoming);
}`;

export function createParticleEmitter(mode: EmitterMode = 'point'): VisualPluginDefinition {
    const id = `ParticleEmitter:${mode}`;

    return {
        id,
        version: 1,
        category: 'field',
        inputs: [
            { name: 'previous', type: 'particle-emitter', required: false },
            ...(mode === 'shape'
                ? [{ name: 'shape', type: 'mask-texture' as const, required: true }]
                : []),
        ],
        outputs: [{ name: EMITTER_OUTPUT, type: 'particle-emitter', required: false }],
        capabilities: ['particle-emission'],
        cost: { gpu: 0, cpu: 0, memory: 0, renderPasses: 0, qualityScalable: true, dominant: false },
        character: character({ visualDensity: 0, motionEnergy: 0, brightness: 0, dominance: 'supporting' }),
        activationRules: {
            activationWeight: 5,
            prefersWith: ['ParticleSimulator'],
        },
        parameters: {
            originX: 0,
            originY: 0,
            emissionRadius: mode === 'point' ? 0 : 60,
            direction: 0,
            spread: 20,
            speed: 160,
            radius: 5,
            radiusJitter: 0,
            rate: 24,
            mass: 1,
            elasticity: 0.9,
            friction: 0.1,
            lifetime: 6,
            colorR: 1,
            colorG: 1,
            colorB: 1,
        },
        defaultBindings: emitterBindings(mode),
        deactivationPolicy: 'immediate',

        create(context): VisualPluginInstance {
            const resource = resourceIdFor(context.instanceId, EMITTER_OUTPUT);

            return semanticInstance((frame) => {
                const previous = frame.readValue?.<EmitterList>(frame.inputs.previous) ?? [];
                const shape = mode === 'shape' ? frame.readField(frame.inputs.shape) : undefined;
                const own: ParticleEmitterConfig = {
                    id: context.instanceId,
                    mode,
                    seed: context.seed,
                    origin: [frame.parameters.originX ?? 0, frame.parameters.originY ?? 0],
                    emissionRadius: Math.max(0, frame.parameters.emissionRadius ?? 0),
                    directionDegrees: frame.parameters.direction ?? 0,
                    spreadDegrees: Math.max(0, frame.parameters.spread ?? 0),
                    speed: frame.parameters.speed ?? 160,
                    radius: Math.max(0.5, frame.parameters.radius ?? 5),
                    radiusJitter: clamp(frame.parameters.radiusJitter ?? 0, 0, 1),
                    rate: Math.max(0, frame.parameters.rate ?? 24),
                    mass: Math.max(1e-3, frame.parameters.mass ?? 1),
                    elasticity: clamp01(frame.parameters.elasticity ?? 0.9),
                    friction: clamp01(frame.parameters.friction ?? 0.1),
                    lifetime: Math.max(0.05, frame.parameters.lifetime ?? 6),
                    color: [
                        clamp01(frame.parameters.colorR ?? 1),
                        clamp01(frame.parameters.colorG ?? 1),
                        clamp01(frame.parameters.colorB ?? 1),
                    ],
                    shape,
                };
                frame.publishValue?.(resource, [...previous, own]);
            });
        },
    };
}

export function createParticleForceField(mode: ForceMode = 'vortex'): VisualPluginDefinition {
    const id = `ParticleForceField:${mode}`;

    return {
        id,
        version: 1,
        category: 'field',
        inputs: [
            { name: 'previous', type: 'particle-force', required: false },
            ...(mode === 'curl'
                ? [{ name: 'field', type: 'vector-field' as const, required: true }]
                : []),
        ],
        outputs: [{ name: FORCE_OUTPUT, type: 'particle-force', required: false }],
        capabilities: ['particle-force'],
        cost: { gpu: 0, cpu: 0, memory: 0, renderPasses: 0, qualityScalable: true, dominant: false },
        character: character({ visualDensity: 0, motionEnergy: 0, brightness: 0, dominance: 'supporting' }),
        activationRules: {
            activationWeight: 4,
            prefersWith: ['ParticleSimulator'],
        },
        parameters: forceParameters(mode),
        defaultBindings: forceBindings(mode),
        deactivationPolicy: 'immediate',

        create(context): VisualPluginInstance {
            const resource = resourceIdFor(context.instanceId, FORCE_OUTPUT);

            return semanticInstance((frame) => {
                const previous = frame.readValue?.<ForceList>(frame.inputs.previous) ?? [];
                const position = [
                    frame.parameters.x ?? 0,
                    frame.parameters.y ?? 0,
                ] as const;
                const strength = frame.parameters.strength ?? 0;
                let own: ParticleForceConfig;

                if (mode === 'attract' || mode === 'repel') {
                    own = {
                        id: context.instanceId,
                        kind: 'well',
                        position,
                        radius: Math.max(1, frame.parameters.radius ?? 180),
                        strength,
                        repel: mode === 'repel',
                    };
                } else if (mode === 'vortex') {
                    own = {
                        id: context.instanceId,
                        kind: 'vortex',
                        position,
                        radius: Math.max(1, frame.parameters.radius ?? 180),
                        tangentialStrength: strength,
                        inwardStrength: frame.parameters.inwardStrength ?? 0,
                    };
                } else if (mode === 'gravity') {
                    own = {
                        id: context.instanceId,
                        kind: 'uniform',
                        acceleration: [0, -strength],
                    };
                } else if (mode === 'wind') {
                    const direction = degrees(frame.parameters.direction ?? 0);
                    own = {
                        id: context.instanceId,
                        kind: 'uniform',
                        acceleration: [Math.cos(direction) * strength, Math.sin(direction) * strength],
                    };
                } else {
                    own = {
                        id: context.instanceId,
                        kind: 'field',
                        strength,
                        field: frame.readField(frame.inputs.field),
                    };
                }

                frame.publishValue?.(resource, [...previous, own]);
            });
        },
    };
}

export function createParticleCollider(mode: ColliderMode = 'frame'): VisualPluginDefinition {
    const id = `ParticleCollider:${mode}`;

    return {
        id,
        version: 1,
        category: 'field',
        inputs: [
            { name: 'previous', type: 'particle-collider', required: false },
            ...(mode === 'mask'
                ? [{ name: 'field', type: 'distance-field' as const, required: true }]
                : []),
        ],
        outputs: [{ name: COLLIDER_OUTPUT, type: 'particle-collider', required: false }],
        capabilities: ['particle-collision'],
        cost: { gpu: 0, cpu: 0, memory: 0, renderPasses: 0, qualityScalable: true, dominant: false },
        character: character({ visualDensity: 0, motionEnergy: 0, brightness: 0, dominance: 'supporting' }),
        activationRules: {
            activationWeight: 4,
            prefersWith: ['ParticleSimulator'],
        },
        parameters: colliderParameters(mode),
        defaultBindings: colliderBindings(mode),
        deactivationPolicy: 'immediate',

        create(context): VisualPluginInstance {
            const resource = resourceIdFor(context.instanceId, COLLIDER_OUTPUT);

            return semanticInstance((frame) => {
                const previous = frame.readValue?.<ColliderList>(frame.inputs.previous) ?? [];
                const elasticity = clamp01(frame.parameters.elasticity ?? 0.9);
                const friction = clamp01(frame.parameters.friction ?? 0.1);
                let own: ParticleColliderConfig;

                if (mode === 'frame') {
                    own = { kind: 'frame', elasticity, friction };
                } else if (mode === 'segment') {
                    own = {
                        kind: 'segment',
                        start: [frame.parameters.x1 ?? -100, frame.parameters.y1 ?? 0],
                        end: [frame.parameters.x2 ?? 100, frame.parameters.y2 ?? 0],
                        elasticity,
                        friction,
                    };
                } else if (mode === 'circle') {
                    own = {
                        kind: 'circle',
                        position: [frame.parameters.x ?? 0, frame.parameters.y ?? 0],
                        radius: Math.max(1, frame.parameters.radius ?? 80),
                        elasticity,
                        friction,
                    };
                } else {
                    own = {
                        kind: 'mask',
                        field: frame.readField(frame.inputs.field),
                        containInside: (frame.parameters.containInside ?? 1) > 0.5,
                        elasticity,
                        friction,
                    };
                }

                frame.publishValue?.(resource, [...previous, own]);
            });
        },
    };
}

export function createParticleSimulator(): VisualPluginDefinition {
    return {
        id: 'ParticleSimulator',
        version: 1,
        category: 'simulator',
        inputs: [
            { name: EMITTER_OUTPUT, type: 'particle-emitter', required: true },
            { name: FORCE_OUTPUT, type: 'particle-force', required: false },
            { name: COLLIDER_OUTPUT, type: 'particle-collider', required: false },
        ],
        outputs: [{ name: STATE_OUTPUT, type: 'particle-state', required: false }],
        capabilities: ['particles'],
        cost: { gpu: 0, cpu: 3, memory: 1, renderPasses: 0, qualityScalable: true, dominant: false },
        character: character({
            visualDensity: 0,
            motionEnergy: 0.8,
            geometricOrder: 0.4,
            persistence: 0.7,
            dominance: 'either',
        }),
        activationRules: {
            activationWeight: 6,
            minimumDuration: 16,
            prefersWith: ['ParticleRenderer', 'ParticleEmitter'],
        },
        parameters: {
            // Population, not capacity. Equilibrium is emission rate times lifetime, so this is the
            // ceiling that decides whether the layer covers the frame: at the previous 512 against an
            // emitter running at 24 a second for six seconds, the field settled at 144 bodies — 0.78
            // percent of a 1600 by 900 frame, which is a scatter rather than a layer.
            particleCount: 700,
            drag: 0.2,
            collisionIterations: 4,
        },
        defaultBindings: [
            {
                feature: 'rms',
                role: 'intensity',
                parameter: 'particleCount',
                outputRange: [240, 1200],
                attack: 0.6,
                release: 2.5,
                curve: 'smooth',
            },
            {
                // Velocity damping. Low, the field keeps its momentum and streams; high, it settles
                // into whatever the forces hold it against.
                feature: 'lowMid',
                role: 'deformation',
                parameter: 'drag',
                outputRange: [0, 1.1],
                attack: 0.3,
                release: 1.1,
                curve: 'smooth',
            },
        ],
        deactivationPolicy: 'drain',

        create(context): VisualPluginInstance {
            const resource = resourceIdFor(context.instanceId, STATE_OUTPUT);
            const world = createParticleWorld(PARTICLE_CAPACITY);
            const emissionCredit = new Map<string, number>();
            const randomState = new Map<string, number>();
            let accumulator = 0;

            return {
                initialize() {
                    // CPU simulation; no shader.
                },

                activate() {
                    resetParticleWorld(world);
                    emissionCredit.clear();
                    randomState.clear();
                    accumulator = 0;
                },

                update(frame) {
                    world.width = Math.max(1, frame.renderWidth);
                    world.height = Math.max(1, frame.renderHeight);
                    const emitters = frame.readValue?.<EmitterList>(frame.inputs.emitters) ?? [];
                    const forceConfigs = frame.readValue?.<ForceList>(frame.inputs.forces) ?? [];
                    const colliderConfigs = frame.readValue?.<ColliderList>(frame.inputs.colliders) ?? [];
                    const maximum = clamp(
                        Math.round(
                            (frame.parameters.particleCount ?? 512)
                            * (frame.particleScale ?? 1),
                        ),
                        0,
                        PARTICLE_CAPACITY,
                    );
                    const forces = materializeForces(forceConfigs, world);
                    const colliders = materializeColliders(colliderConfigs);

                    accumulator = Math.min(MAX_CATCH_UP, accumulator + Math.max(0, frame.deltaSeconds));
                    while (accumulator >= FIXED_STEP) {
                        emitFrom(
                            world,
                            emitters,
                            maximum,
                            FIXED_STEP,
                            emissionCredit,
                            randomState,
                        );
                        stepParticles(world, {
                            deltaSeconds: FIXED_STEP,
                            drag: Math.max(0, frame.parameters.drag ?? 0),
                            iterations: Math.max(1, Math.round(frame.parameters.collisionIterations ?? 4)),
                            forces,
                            colliders,
                        });
                        accumulator -= FIXED_STEP;
                    }

                    frame.publishValue?.(resource, {
                        world,
                        activeCount: activeParticleCount(world),
                        emitters,
                        forces: forceConfigs,
                        colliders,
                    } satisfies ParticleState);
                },

                render() {
                    return [];
                },

                deactivate() {
                    // Existing bodies remain in the snapshot until the instance is destroyed.
                },

                destroy() {
                    resetParticleWorld(world);
                },
            };
        },
    };
}

export function createParticleRenderer(
    mode: typeof PARTICLE_RENDER_MODES[number] = 'discs',
): VisualPluginDefinition {
    const maskShader = `particle-mask:${mode}`;
    const colorShader = `particle-color:${mode}`;
    const debugShader = `particle-debug:${mode}`;
    const debugLineShader = `particle-debug-lines:${mode}`;

    return {
        id: `ParticleRenderer:${mode}`,
        version: 1,
        category: 'compositor',
        inputs: [{ name: STATE_OUTPUT, type: 'particle-state', required: true }],
        outputs: [
            { name: 'mask', type: 'mask-texture', required: false },
            { name: 'color', type: 'color-texture', required: false },
        ],
        capabilities: ['particle-rendering'],
        cost: { gpu: 2, cpu: 1, memory: 1, renderPasses: 4, qualityScalable: true, dominant: false },
        character: character({
            visualDensity: 0.6,
            motionEnergy: 0.8,
            brightness: 0.7,
            dominance: 'supporting',
        }),
        activationRules: {
            activationWeight: 5,
            prefersWith: ['ParticleSimulator'],
        },
        parameters: {
            brightness: 1,
            debug: 0,
        },
        defaultBindings: [{
            // The transient envelope rather than a level: a particle field is sparse, fast material
            // and the accumulation admits only a few percent of it per frame, so what makes a body
            // read at all is arriving bright on the hit that threw it.
            feature: 'transient',
            role: 'detail',
            parameter: 'brightness',
            outputRange: [0.55, 1.9],
            attack: 0.03,
            release: 0.35,
            curve: 'sqrt',
        }],
        deactivationPolicy: 'fade',

        create(context): VisualPluginInstance {
            const geometryId = `particle-geometry:${mode}:${context.instanceId}`;
            const debugLineGeometryId = `particle-debug-line-geometry:${mode}:${context.instanceId}`;
            const bodies = new Float32Array(PARTICLE_CAPACITY * 6);
            let count = 0;
            let worldSize: readonly [number, number] = [1, 1];
            let debug = false;
            let debugLineCount = 0;

            return {
                initialize() {
                    context.registerShader({
                        id: maskShader,
                        vertex: PARTICLE_VERTEX,
                        fragment: PARTICLE_MASK_FRAGMENT,
                    });
                    context.registerShader({
                        id: colorShader,
                        vertex: PARTICLE_VERTEX,
                        fragment: PARTICLE_COLOR_FRAGMENT,
                    });
                    context.registerShader({
                        id: debugShader,
                        vertex: PARTICLE_VERTEX,
                        fragment: PARTICLE_DEBUG_FRAGMENT,
                    });
                    context.registerShader({
                        id: debugLineShader,
                        vertex: DEBUG_LINE_VERTEX,
                        fragment: DEBUG_LINE_FRAGMENT,
                    });
                },

                activate() {
                    count = 0;
                },

                update(frame) {
                    const state = frame.readValue?.<ParticleState>(frame.inputs.state);
                    if (!state) {
                        count = 0;
                        return;
                    }

                    const { world } = state;
                    worldSize = [world.width, world.height];
                    debug = (frame.parameters.debug ?? 0) > 0.5;
                    count = 0;
                    for (let index = 0; index < world.capacity; index += 1) {
                        if (!world.active[index]) {
                            continue;
                        }

                        const output = count * 6;
                        bodies[output] = world.positions[index * 2];
                        bodies[output + 1] = world.positions[index * 2 + 1];
                        bodies[output + 2] = world.radii[index];
                        bodies[output + 3] = world.colors[index * 3];
                        bodies[output + 4] = world.colors[index * 3 + 1];
                        bodies[output + 5] = world.colors[index * 3 + 2];
                        count += 1;
                    }

                    frame.uploadGeometry({
                        id: geometryId,
                        data: bodies.subarray(0, count * 6),
                        attributes: [
                            { name: 'aPosition', components: 2 },
                            { name: 'aRadius', components: 1 },
                            { name: 'aColor', components: 3 },
                        ],
                    });

                    debugLineCount = 0;
                    if (debug) {
                        const lines = debugLines(state);
                        debugLineCount = lines.length / 5;
                        frame.uploadGeometry({
                            id: debugLineGeometryId,
                            data: lines,
                            attributes: [
                                { name: 'aPosition', components: 2 },
                                { name: 'aColor', components: 3 },
                            ],
                        });
                    }
                },

                render(render): RenderPass[] {
                    const passes: RenderPass[] = [
                        {
                            kind: 'geometry',
                            shader: maskShader,
                            geometry: geometryId,
                            primitive: 'points',
                            vertexCount: count,
                            output: render.outputs.mask,
                            blend: 'none',
                            clear: true,
                            uniforms: {
                                uWorldSize: worldSize,
                            },
                        },
                        {
                            kind: 'geometry',
                            shader: colorShader,
                            geometry: geometryId,
                            primitive: 'points',
                            vertexCount: count,
                            output: render.outputs.color,
                            blend: 'none',
                            clear: true,
                            // No static `uBrightness`: the resolved parameter carries it, and a
                            // pass-level default for a bound parameter is the shape that let two
                            // simulators integrate a fixed sixtieth of a second per frame.
                            uniforms: {
                                uWorldSize: worldSize,
                            },
                        },
                    ];

                    if (debug && count > 0) {
                        passes.push({
                            kind: 'geometry',
                            shader: debugShader,
                            geometry: geometryId,
                            primitive: 'points',
                            vertexCount: count,
                            output: render.outputs.color,
                            blend: 'add',
                            clear: false,
                            uniforms: {
                                uWorldSize: worldSize,
                            },
                        });

                    }

                    if (debug && debugLineCount > 0) {
                        passes.push({
                            kind: 'geometry',
                            shader: debugLineShader,
                            geometry: debugLineGeometryId,
                            primitive: 'lines',
                            vertexCount: debugLineCount,
                            output: render.outputs.color,
                            blend: 'add',
                            clear: false,
                            uniforms: { uWorldSize: worldSize },
                        });
                    }

                    return passes;
                },

                deactivate() {
                    // Stateless projection.
                },

                destroy() {
                    count = 0;
                },
            };
        },
    };
}

export function createParticleTrailInjector(): VisualPluginDefinition {
    return defineShaderPlugin({
        id: 'ParticleTrailInjector',
        category: 'compositor',
        inputs: [
            { name: 'source', type: 'color-texture', required: true },
            { name: 'history', type: 'color-texture', required: false },
        ],
        outputs: [{ name: 'color', type: 'color-texture' }],
        capabilities: ['feedback', 'particle-trails'],
        fragment: TRAIL_FRAGMENT,
        uniforms: { uDecay: 0.9, uAmount: 1 },
        parameters: { decay: 0.9, amount: 1 },
        bindings: [
            {
                feature: 'lowMid',
                role: 'deformation',
                parameter: 'decay',
                outputRange: [0.86, 0.985],
                attack: 0.35,
                release: 1.2,
                curve: 'smooth',
            },
            {
                feature: 'rms',
                role: 'intensity',
                parameter: 'amount',
                outputRange: [0.5, 1],
                attack: 0.12,
                release: 0.55,
                curve: 'smooth',
            },
        ],
        character: character({ persistence: 0.9, visualDensity: 0.6, dominance: 'supporting' }),
        feedbackPort: 'history',
        clear: false,
        memoryCost: 2,
        deactivationPolicy: 'handoff-feedback',
        activationWeight: 4,
        prefersWith: ['ParticleRenderer', 'ParticleSimulator'],
    });
}

function semanticInstance(update: VisualPluginInstance['update']): VisualPluginInstance {
    return {
        initialize() {
            // CPU value node.
        },
        activate() {
            // No retained state.
        },
        update,
        render() {
            return [];
        },
        deactivate() {
            // No retained state.
        },
        destroy() {
            // No retained state.
        },
    };
}

/**
 * What the music does to an emitter.
 *
 * Every particle plugin shipped with `defaultBindings: []`, so a scene's particle nodes ran at their
 * declaration defaults for its whole life: a jet of twenty-four bodies a second leaving the centre of
 * the screen at a fixed hundred and sixty pixels a second, pointing right, on every track. The
 * subsystem appeared in about a fifth of assembled scenes and was the same picture in all of them.
 *
 * Rate is the one that decides whether this is a layer or a scatter, so it takes an event channel;
 * the rest shape what a body is and where it goes.
 */
function emitterBindings(mode: EmitterMode): ParameterBinding[] {
    return [
        {
            feature: 'spectralFlux',
            role: 'burst',
            parameter: 'rate',
            outputRange: [12, 240],
            attack: 0.05,
            release: 0.9,
            curve: 'sqrt',
        },
        {
            feature: 'bass',
            role: 'large-scale-force',
            parameter: 'speed',
            outputRange: [70, 430],
            attack: 0.1,
            release: 0.5,
            curve: 'smooth',
        },
        {
            feature: 'mid',
            role: 'deformation',
            parameter: 'spread',
            outputRange: [8, 150],
            attack: 0.25,
            release: 0.8,
            curve: 'smooth',
        },
        {
            feature: 'rms',
            role: 'intensity',
            parameter: 'radius',
            outputRange: [3, 9],
            attack: 0.15,
            release: 0.6,
            curve: 'smooth',
        },
        {
            feature: 'treble',
            role: 'detail',
            parameter: 'radiusJitter',
            outputRange: [0.05, 0.6],
            attack: 0.1,
            release: 0.5,
            curve: 'linear',
        },
        {
            // Degrees per second, integrated: the jet *turns* at a speed the stereo image sets, so a
            // wide mix sweeps and a centred one holds. A value binding could only aim it, and aiming
            // a jet from a channel that sits near its middle is a jet that does not move.
            feature: 'stereoBalance',
            role: 'lateral-force',
            mode: 'rate',
            parameter: 'direction',
            outputRange: [-120, 120],
            attack: 0.3,
            release: 0.9,
            curve: 'linear',
            wrap: 360,
        },
        {
            // A point emitter has almost none of this by definition; the others are a shape whose
            // size is worth moving.
            feature: 'lowMid',
            role: 'deformation',
            parameter: 'emissionRadius',
            outputRange: mode === 'point' ? [0, 26] : [20, 190],
            attack: 0.4,
            release: 1.2,
            curve: 'smooth',
        },
    ];
}

/** What the music does to a force. Ranges are taken from the mode's own default magnitude. */
function forceBindings(mode: ForceMode): ParameterBinding[] {
    const strength = forceParameters(mode).strength;

    const bindings: ParameterBinding[] = [{
        feature: 'bass',
        role: 'large-scale-force',
        parameter: 'strength',
        outputRange: [strength * 0.25, strength * 1.7],
        attack: 0.08,
        release: 0.45,
        curve: 'smooth',
    }];

    if (mode === 'attract' || mode === 'repel' || mode === 'vortex') {
        bindings.push({
            // How far the well reaches. Static, it is a fixed region of the frame that behaves
            // differently from the rest of it for the whole of a track.
            feature: 'lowMid',
            role: 'deformation',
            parameter: 'radius',
            outputRange: [90, 340],
            attack: 0.5,
            release: 1.4,
            curve: 'smooth',
        });
    }

    if (mode === 'vortex') {
        bindings.push({
            // Crosses zero, so the spiral breathes out as well as in rather than only tightening.
            feature: 'mid',
            role: 'deformation',
            parameter: 'inwardStrength',
            outputRange: [-140, 320],
            attack: 0.3,
            release: 1,
            curve: 'smooth',
        });
    }

    if (mode === 'wind') {
        bindings.push({
            feature: 'stereoBalance',
            role: 'lateral-force',
            mode: 'rate',
            parameter: 'direction',
            outputRange: [-60, 60],
            attack: 0.4,
            release: 1.2,
            curve: 'linear',
            wrap: 360,
        });
    }

    return bindings;
}

/**
 * What the music does to a collider.
 *
 * Mostly nothing, deliberately. A wall is a wall, and its elasticity and friction are what a surface
 * *is* rather than what it does — moving them each frame changes the material under a body mid-bounce.
 * A circular obstacle is the exception: its size is a shape in the frame, and a breathing one is
 * something the eye can follow.
 */
function colliderBindings(mode: ColliderMode): ParameterBinding[] {
    if (mode !== 'circle') {
        return [];
    }

    return [{
        feature: 'subBass',
        role: 'large-scale-force',
        parameter: 'radius',
        outputRange: [40, 190],
        attack: 0.2,
        release: 0.8,
        curve: 'smooth',
    }];
}

function forceParameters(mode: ForceMode): Record<string, number> {
    if (mode === 'gravity') {
        return { strength: 300 };
    }
    if (mode === 'wind') {
        return { strength: 120, direction: 0 };
    }
    if (mode === 'curl') {
        return { strength: 180 };
    }
    if (mode === 'vortex') {
        return { x: 0, y: 0, radius: 180, strength: 1200, inwardStrength: 120 };
    }
    return { x: 0, y: 0, radius: 180, strength: 1200 };
}

function colliderParameters(mode: ColliderMode): Record<string, number> {
    const material = { elasticity: 0.9, friction: 0.1 };
    if (mode === 'segment') {
        return { ...material, x1: -100, y1: 0, x2: 100, y2: 0 };
    }
    if (mode === 'circle') {
        return { ...material, x: 0, y: 0, radius: 80 };
    }
    if (mode === 'mask') {
        return { ...material, containInside: 1 };
    }
    return material;
}

function materializeForces(
    configs: ForceList,
    world: ParticleWorld,
): ParticleForce[] {
    return configs.flatMap((config): ParticleForce[] => {
        if (config.kind !== 'field') {
            return [config];
        }
        if (!config.field) {
            return [];
        }

        const field = config.field;
        const sampled: [number, number] = [0, 0];
        return [{
            kind: 'field',
            strength: config.strength,
            sample(x, y, out) {
                sampleField(field, world, x, y, sampled);
                out[0] = sampled[0];
                out[1] = sampled[1];
            },
        }];
    });
}

function materializeColliders(configs: ColliderList): ParticleCollider[] {
    return configs.flatMap((config): ParticleCollider[] => {
        if (config.kind !== 'mask') {
            return [config];
        }
        if (!config.field) {
            return [];
        }
        return [{
            kind: 'mask',
            width: config.field.width,
            height: config.field.height,
            data: config.field.data,
            containInside: config.containInside,
            elasticity: config.elasticity,
            friction: config.friction,
        }];
    });
}

function emitFrom(
    world: ParticleWorld,
    emitters: EmitterList,
    maximum: number,
    dt: number,
    credit: Map<string, number>,
    randomState: Map<string, number>,
): void {
    let active = activeParticleCount(world);
    if (active >= maximum || emitters.length === 0) {
        return;
    }

    for (const emitter of emitters) {
        let available = (credit.get(emitter.id) ?? 0) + emitter.rate * dt;
        while (available >= 1 && active < maximum) {
            const random = () => nextRandom(emitter, randomState);
            const position = emissionPosition(emitter, world, random);
            if (!position) {
                available -= 1;
                continue;
            }

            const angle = degrees(
                emitter.directionDegrees + (random() - 0.5) * emitter.spreadDegrees,
            );
            const radius = Math.max(
                0.5,
                emitter.radius * (1 + (random() * 2 - 1) * emitter.radiusJitter),
            );
            const emitted = emitParticle(world, {
                position,
                velocity: [Math.cos(angle) * emitter.speed, Math.sin(angle) * emitter.speed],
                radius,
                mass: emitter.mass,
                elasticity: emitter.elasticity,
                friction: emitter.friction,
                lifetime: emitter.lifetime,
                color: emitter.color,
                emitterId: hashId(emitter.id),
            });
            if (emitted < 0) {
                break;
            }

            active += 1;
            available -= 1;
        }
        credit.set(emitter.id, Math.min(available, 1));
    }
}

function emissionPosition(
    emitter: ParticleEmitterConfig,
    world: ParticleWorld,
    random: () => number,
): [number, number] | undefined {
    const radius = emitter.emissionRadius;

    if (emitter.mode === 'shape' && emitter.shape) {
        for (let attempt = 0; attempt < 24; attempt += 1) {
            const u = random();
            const v = random();
            const x = Math.min(emitter.shape.width - 1, Math.floor(u * emitter.shape.width));
            const y = Math.min(emitter.shape.height - 1, Math.floor(v * emitter.shape.height));
            if (emitter.shape.data[(y * emitter.shape.width + x) * 4] > 0.5) {
                return [
                    (u - 0.5) * world.width + emitter.origin[0],
                    (v - 0.5) * world.height + emitter.origin[1],
                ];
            }
        }
        return undefined;
    }

    if (emitter.mode === 'line') {
        const along = (random() * 2 - 1) * radius;
        const direction = degrees(emitter.directionDegrees + 90);
        return [
            emitter.origin[0] + Math.cos(direction) * along,
            emitter.origin[1] + Math.sin(direction) * along,
        ];
    }

    if (emitter.mode === 'ring') {
        const angle = random() * Math.PI * 2;
        return [
            emitter.origin[0] + Math.cos(angle) * radius,
            emitter.origin[1] + Math.sin(angle) * radius,
        ];
    }

    if (emitter.mode === 'region') {
        return [
            emitter.origin[0] + (random() * 2 - 1) * radius,
            emitter.origin[1] + (random() * 2 - 1) * radius,
        ];
    }

    const distance = Math.sqrt(random()) * radius;
    const angle = random() * Math.PI * 2;
    return [
        emitter.origin[0] + Math.cos(angle) * distance,
        emitter.origin[1] + Math.sin(angle) * distance,
    ];
}

function nextRandom(
    emitter: ParticleEmitterConfig,
    states: Map<string, number>,
): number {
    const initial = (Math.floor(Math.abs(emitter.seed) * 0xffffffff) ^ hashId(emitter.id)) >>> 0;
    const previous = states.get(emitter.id) ?? initial;
    const next = (Math.imul(previous, 1664525) + 1013904223) >>> 0;
    states.set(emitter.id, next);
    return next / 0x100000000;
}

function sampleField(
    field: FieldSample,
    world: ParticleWorld,
    x: number,
    y: number,
    out: [number, number],
): void {
    if (field.width < 2 || field.height < 2) {
        out[0] = 0;
        out[1] = 0;
        return;
    }

    const u = clamp((x / world.width + 0.5) * (field.width - 1), 0, field.width - 1.001);
    const v = clamp((y / world.height + 0.5) * (field.height - 1), 0, field.height - 1.001);
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;

    for (let channel = 0; channel < 2; channel += 1) {
        const at = (sampleX: number, sampleY: number) =>
            field.data[(sampleY * field.width + sampleX) * 4 + channel];
        const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
        const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
        out[channel] = top * (1 - fy) + bottom * fy;
    }
}

function debugLines(state: ParticleState): Float32Array {
    const values: number[] = [];
    const add = (
        start: readonly [number, number],
        end: readonly [number, number],
        color: readonly [number, number, number],
    ) => {
        values.push(start[0], start[1], color[0], color[1], color[2]);
        values.push(end[0], end[1], color[0], color[1], color[2]);
    };
    const circle = (
        centre: readonly [number, number],
        radius: number,
        color: readonly [number, number, number],
    ) => {
        const segments = 32;
        for (let segment = 0; segment < segments; segment += 1) {
            const first = segment / segments * Math.PI * 2;
            const second = (segment + 1) / segments * Math.PI * 2;
            add(
                [centre[0] + Math.cos(first) * radius, centre[1] + Math.sin(first) * radius],
                [centre[0] + Math.cos(second) * radius, centre[1] + Math.sin(second) * radius],
                color,
            );
        }
    };

    for (const collider of state.colliders) {
        if (collider.kind === 'frame') {
            const x = state.world.width * 0.5;
            const y = state.world.height * 0.5;
            add([-x, -y], [x, -y], [0.2, 1, 0.45]);
            add([x, -y], [x, y], [0.2, 1, 0.45]);
            add([x, y], [-x, y], [0.2, 1, 0.45]);
            add([-x, y], [-x, -y], [0.2, 1, 0.45]);
        } else if (collider.kind === 'segment') {
            add(collider.start, collider.end, [0.2, 1, 0.45]);
        } else if (collider.kind === 'circle') {
            circle(collider.position, collider.radius, [0.2, 1, 0.45]);
        }
    }

    for (const force of state.forces) {
        if (force.kind === 'well') {
            circle(force.position, force.radius, force.repel ? [1, 0.25, 0.25] : [0.3, 0.55, 1]);
        } else if (force.kind === 'vortex') {
            circle(force.position, force.radius, [0.75, 0.3, 1]);
        }
    }

    for (const emitter of state.emitters) {
        const color: readonly [number, number, number] = [1, 0.8, 0.2];
        const centre = emitter.origin;
        add([centre[0] - 8, centre[1]], [centre[0] + 8, centre[1]], color);
        add([centre[0], centre[1] - 8], [centre[0], centre[1] + 8], color);
        if (emitter.emissionRadius > 0) {
            circle(centre, emitter.emissionRadius, color);
        }
    }

    return new Float32Array(values);
}

function hashId(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash | 0;
}

function degrees(value: number): number {
    return value * Math.PI / 180;
}

function clamp01(value: number): number {
    return clamp(value, 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}
