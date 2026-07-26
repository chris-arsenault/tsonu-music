/**
 * Particle system (spec section 19.5).
 *
 * State lives in a ping-ponged float texture rather than on the CPU: position, velocity, and age per
 * particle, advanced by a shader each frame. That is what `EXT_color_buffer_float` is required for.
 *
 * Split across plugins as the spec describes, so an emitter or a force field can be replaced without
 * resetting the particle state the simulator holds.
 */

import { character, defineShaderPlugin, GLSL_COMMON } from '../define';
import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import type { RenderPass } from '../../core/passes';
import { QUAD_VERTEX_SHADER } from '../../host/device';

// Only the two hand-written plugins need explicit shader ids; the rest go through
// `defineShaderPlugin`, which derives the id from the plugin's own id.
const SIMULATOR_SHADER = 'particle-simulator';
const RENDERER_SHADER = 'particle-renderer';

/**
 * Each texel is one particle: xy position in clip space, zw velocity.
 *
 * There is no room left for age — all four channels are spent — so age is not stored. It is derived
 * from playback time and a per-particle birth offset, which costs one hash and behaves identically:
 * every particle runs a cycle of `uLifetime` seconds, and the offsets stagger them so the field does
 * not blink as one.
 *
 * The header here used to claim age rode in "the alpha of a second channel set", describing storage
 * that does not exist. `uLifetime` was declared, supplied twice, and read nowhere, so particles were
 * immortal: the respawn test was position and velocity both exactly zero, true only on the first
 * frame or two. Everything downstream of that followed — a `ParticleEmitter`'s shape, ring, and line
 * patterns were sampled once and never again, its rate binding did nothing, and a field that decayed
 * into a corner had no mechanism to refill.
 */
const SIMULATOR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uState;
uniform sampler2D uForce;
uniform sampler2D uBoundary;
uniform sampler2D uSpawn;
uniform vec2 uResolution;
uniform float uDelta;
uniform float uDrag;
uniform float uLifetime;
uniform float uTime;
uniform float uSeed;
uniform bool uHasBoundary;
uniform bool uHasSpawn;
${GLSL_COMMON}

void main() {
    vec4 state = texture(uState, vUv);
    vec2 position = state.xy;
    vec2 velocity = state.zw;

    // Age without storing it: the particle's own cycle position, offset per particle so respawns are
    // spread evenly through the lifetime rather than the whole field turning over at once. A cycle
    // completed within this frame is a rebirth. Playback time is the clock, so a paused track ages
    // nothing.
    float lifetime = max(uLifetime, 0.05);
    float birth = hash(vUv + uSeed + 19.7);
    float cycles = uTime / lifetime + birth;
    bool reborn = floor(cycles) > floor((uTime - uDelta) / lifetime + birth);

    // An uninitialized texel starts as a seeded position rather than at the origin, so the first frame
    // does not show every particle stacked in one place.
    if (reborn || (position == vec2(0.0) && velocity == vec2(0.0))) {
        vec4 spawn = uHasSpawn ? texture(uSpawn, vUv) : vec4(0.0);
        position = uHasSpawn && spawn.a > 0.0
            ? spawn.xy
            : vec2(hash(vUv + uSeed + cycles), hash(vUv + uSeed + 3.7 + cycles)) * 2.0 - 1.0;
        velocity = vec2(hash(vUv + 7.1 + cycles) - 0.5, hash(vUv + 11.3 + cycles) - 0.5) * 0.1;
    }

    // The force field is sampled in field space, which is the same 0..1 domain as the screen.
    vec2 forceUv = position * 0.5 + 0.5;
    vec2 force = texture(uForce, clamp(forceUv, 0.0, 1.0)).xy;

    velocity += force * uDelta;
    velocity *= (1.0 - uDrag * uDelta);

    // Collision fields carry boundary proximity in blue and an outward normal in red/green. Reflect
    // particles that are moving into the mask edge, then push them clear so they do not jitter inside
    // the boundary on the following frame.
    if (uHasBoundary) {
        vec4 boundary = texture(uBoundary, clamp(forceUv, 0.0, 1.0));
        float proximity = boundary.b;
        vec2 normal = length(boundary.rg) > 0.0001 ? normalize(boundary.rg) : vec2(0.0);
        if (proximity > 0.04 && dot(velocity, normal) < 0.0) {
            velocity = reflect(velocity, normal) * mix(0.72, 0.94, proximity);
            velocity += normal * proximity * 0.35;
        }
    }

    position += velocity * uDelta;

    // Wraps rather than clamps, so a field pushing outward does not pile particles on the edge.
    position = mod(position + 1.0, 2.0) - 1.0;

    fragColor = vec4(position, velocity);
}`;

/** Draws the state texture as points, one vertex per particle. */
const RENDERER_VERTEX = `#version 300 es
in vec2 aIndex;
out float vSpeed;

uniform sampler2D uState;
uniform float uPointSize;

void main() {
    vec4 state = texture(uState, aIndex);
    vSpeed = length(state.zw);
    gl_PointSize = uPointSize;
    gl_Position = vec4(state.xy, 0.0, 1.0);
}`;

const RENDERER_FRAGMENT = `#version 300 es
precision highp float;
in float vSpeed;
out vec4 fragColor;

uniform float uMode;
uniform float uBrightness;

void main() {
    vec2 offset = gl_PointCoord - 0.5;
    float distance = length(offset);
    float shape;

    if (uMode < 0.5) {                       // points
        shape = 1.0;
    } else if (uMode < 1.5) {                // discs
        shape = 1.0 - smoothstep(0.35, 0.5, distance);
    } else if (uMode < 2.5) {                // sparks
        shape = (1.0 - smoothstep(0.0, 0.5, distance)) * (0.4 + vSpeed * 3.0);
    } else {                                 // comets
        shape = (1.0 - smoothstep(0.0, 0.5, distance)) * exp(-abs(offset.y) * 8.0);
    }

    float energy = clamp(shape * uBrightness * (0.3 + vSpeed * 2.0), 0.0, 1.0);
    fragColor = vec4(vec3(energy), energy);
}`;

const EMITTER_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uShape;
uniform vec2 uResolution;
uniform float uMode;
uniform float uRate;
uniform float uSeed;
${GLSL_COMMON}

void main() {
    vec2 spawn;

    if (uMode < 0.5) {                       // point
        spawn = vec2(0.0);
    } else if (uMode < 1.5) {                // region
        spawn = vec2(hash(vUv + uSeed), hash(vUv + uSeed + 1.7)) * 2.0 - 1.0;
    } else if (uMode < 2.5) {                // line
        spawn = vec2(hash(vUv + uSeed) * 2.0 - 1.0, 0.0);
    } else if (uMode < 3.5) {                // ring
        float angle = hash(vUv + uSeed) * 6.2831853;
        spawn = vec2(cos(angle), sin(angle)) * 0.7;
    } else {
        // Shape interior or edge: rejection-sampled against the supplied mask, so a mask or album-art
        // edge can seed particles without the emitter knowing which it was given.
        vec2 candidate = vec2(hash(vUv + uSeed), hash(vUv + uSeed + 5.3));
        float weight = texture(uShape, candidate).r;
        spawn = weight > 0.4 ? candidate * 2.0 - 1.0 : vec2(2.0);
    }

    // Rate gates emission: a texel outside the rate window emits nothing this frame.
    float gate = step(hash(vUv + uSeed + 13.1), uRate);
    fragColor = vec4(spawn, 0.0, gate);
}`;

const FORCE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uMode;
uniform float uStrength;
${GLSL_COMMON}

void main() {
    vec2 field = texture(uField, vUv).xy;
    vec2 p = (vUv - 0.5) * 2.0;
    vec2 force;

    if (uMode < 0.5) {                       // attraction
        force = -normalize(p + 1e-5) * uStrength;
    } else if (uMode < 1.5) {                // repulsion
        force = normalize(p + 1e-5) * uStrength;
    } else if (uMode < 2.5) {                // vortex
        force = vec2(-p.y, p.x) * uStrength;
    } else if (uMode < 3.5) {                // gravity
        force = vec2(0.0, -uStrength);
    } else if (uMode < 4.5) {                // wind
        force = vec2(uStrength, 0.0);
    } else {                                 // curl from the supplied field
        force = field * uStrength;
    }

    fragColor = vec4(force + field * 0.5, 0.0, 1.0);
}`;

const TRAIL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uHistory;
uniform vec2 uResolution;
uniform float uDecay;
uniform float uAmount;
uniform float uDelta;
${GLSL_COMMON}

void main() {
    // Particle motion accumulates into a dedicated trail texture rather than the main feedback buffer,
    // so trails can persist at a different rate from the rest of the scene. Decay is per frame and
    // corrected to the frame this is, so trail length is a duration rather than a frame count.
    vec4 history = texture(uHistory, vUv) * pow(uDecay, max(uDelta, 0.0) * 60.0);
    vec4 incoming = texture(uSource, vUv) * uAmount;

    fragColor = max(history, incoming);
}`;

export const PARTICLE_RENDER_MODES = ['points', 'discs', 'sparks', 'comets'] as const;
export const EMITTER_MODES = ['point', 'region', 'line', 'ring', 'shape'] as const;
export const FORCE_MODES = ['attract', 'repel', 'vortex', 'gravity', 'wind', 'curl'] as const;

/** Particle count at full quality. The performance ladder's particle scale multiplies this. */
export const PARTICLE_TEXTURE_SIDE = 128;

/**
 * Holds particle state across frames in a ping-ponged float texture.
 *
 * The only plugin here that carries state, which is why it drains rather than cutting: existing particles
 * finish their motion while emission stops.
 */
export function createParticleSimulator(): VisualPluginDefinition {
    return {
        id: 'ParticleSimulator',
        version: 1,
        category: 'simulator',
        inputs: [
            { name: 'force', type: 'vector-field', required: true },
            { name: 'boundary', type: 'collision-field', required: false },
            { name: 'spawn', type: 'particle-buffer', required: false },
            { name: 'history', type: 'particle-buffer', required: false },
        ],
        outputs: [{ name: 'state', type: 'particle-buffer', required: false }],
        capabilities: ['particles', 'feedback'],
        requiredCapabilities: ['float-textures'],
        cost: { gpu: 2, cpu: 0, memory: 2, renderPasses: 1, qualityScalable: true, dominant: false },
        character: character({
            visualDensity: 0.7,
            motionEnergy: 0.8,
            geometricOrder: 0.2,
            persistence: 0.7,
            dominance: 'either',
        }),
        activationRules: {
            activationWeight: 6,
            minimumDuration: 16,
            // The chain has to assemble as a chain: a simulator with no renderer shows nothing,
            // and a mask boundary is what gives it a surface to collide with.
            prefersWith: ['ParticleRenderer', 'ParticleEmitter', 'ProceduralVectorField', 'MaskBoundaryField'],
        },
        parameters: { drag: 0.4, lifetime: 4 },
        defaultBindings: [{
            feature: 'bass',
            parameter: 'drag',
            outputRange: [0.15, 0.9],
            attack: 0.15,
            release: 0.6,
            curve: 'smooth',
        }],
        deactivationPolicy: 'drain',

        create(context): VisualPluginInstance {
            let playbackTime = 0;

            return {
                initialize() {
                    context.registerShader({
                        id: SIMULATOR_SHADER,
                        vertex: QUAD_VERTEX_SHADER,
                        fragment: SIMULATOR_FRAGMENT,
                    });
                },

                activate() {
                    // The simulation state lives in the ping-ponged target, not here.
                },

                update(frame) {
                    // Playback time, so lifetimes advance with the music and hold when it does.
                    playbackTime = frame.clock.playbackTime;
                },

                render(render): RenderPass[] {
                    const force = render.inputs.force;
                    if (!force) {
                        return [];
                    }
                    const boundary = render.inputs.boundary;
                    const spawn = render.inputs.spawn;

                    return [{
                        kind: 'fullscreen',
                        shader: SIMULATOR_SHADER,
                        inputs: {
                            uForce: force,
                            uState: render.previous.history ?? render.outputs.state,
                            ...(boundary ? { uBoundary: boundary } : {}),
                            ...(spawn ? { uSpawn: spawn } : {}),
                        },
                        output: render.outputs.state,
                        blend: 'none',
                        clear: false,
                        uniforms: {
                            // No `uDelta`: the kernel supplies the frame's delta, already clamped
                            // against the long steps a hidden tab or a stall produces.
                            uDrag: 0.4,
                            uLifetime: 4,
                            uTime: playbackTime,
                            uSeed: context.seed,
                            uHasBoundary: boundary !== undefined,
                            uHasSpawn: spawn !== undefined,
                        },
                    }];
                },

                deactivate() {
                    // Draining: the runtime keeps rendering while particles finish their motion.
                },

                destroy() {
                    // Nothing retained.
                },
            };
        },
    };
}

/** Draws the particle state as points. */
export function createParticleRenderer(
    mode: typeof PARTICLE_RENDER_MODES[number] = 'discs',
): VisualPluginDefinition {
    const GEOMETRY_ID = 'particle-indices';

    return {
        id: `ParticleRenderer:${mode}`,
        version: 1,
        category: 'compositor',
        inputs: [{ name: 'state', type: 'particle-buffer', required: true }],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
        capabilities: ['particle-rendering'],
        cost: { gpu: 2, cpu: 0, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: character({ visualDensity: 0.7, motionEnergy: 0.8, brightness: 0.7, dominance: 'supporting' }),
        activationRules: {
            activationWeight: 5,
            prefersWith: ['ParticleSimulator', 'MaskSignedDistanceField'],
        },
        parameters: { pointSize: 2.5, brightness: 1.2 },
        defaultBindings: [{
            feature: 'treble',
            parameter: 'brightness',
            outputRange: [0.7, 2],
            attack: 0.03,
            release: 0.3,
            curve: 'sqrt',
        }],
        deactivationPolicy: 'fade',

        create(context): VisualPluginInstance {
            // One vertex per particle, holding only its lookup coordinate; positions come from the texture.
            const indices = new Float32Array(PARTICLE_TEXTURE_SIDE * PARTICLE_TEXTURE_SIDE * 2);
            let uploaded = false;
            let activeCount = PARTICLE_TEXTURE_SIDE * PARTICLE_TEXTURE_SIDE;

            for (let y = 0; y < PARTICLE_TEXTURE_SIDE; y += 1) {
                for (let x = 0; x < PARTICLE_TEXTURE_SIDE; x += 1) {
                    const offset = (y * PARTICLE_TEXTURE_SIDE + x) * 2;
                    indices[offset] = (x + 0.5) / PARTICLE_TEXTURE_SIDE;
                    indices[offset + 1] = (y + 0.5) / PARTICLE_TEXTURE_SIDE;
                }
            }

            return {
                initialize() {
                    context.registerShader({
                        id: RENDERER_SHADER,
                        vertex: RENDERER_VERTEX,
                        fragment: RENDERER_FRAGMENT,
                    });
                },

                activate() {
                    uploaded = false;
                },

                update(frame) {
                    // Ladder rung 2 reduces particle count. Applied by drawing fewer vertices from the
                    // same buffer, so nothing is reallocated when quality changes.
                    activeCount = Math.max(
                        0,
                        Math.min(
                            PARTICLE_TEXTURE_SIDE * PARTICLE_TEXTURE_SIDE,
                            Math.round(PARTICLE_TEXTURE_SIDE * PARTICLE_TEXTURE_SIDE * (frame.particleScale ?? 1)),
                        ),
                    );

                    // Uploaded once: the index buffer never changes, only the state texture it reads.
                    if (!uploaded) {
                        frame.uploadGeometry({
                            id: GEOMETRY_ID,
                            data: indices,
                            attributes: [{ name: 'aIndex', components: 2 }],
                        });
                        uploaded = true;
                    }
                },

                render(render): RenderPass[] {
                    const state = render.inputs.state;
                    if (!state || activeCount === 0) {
                        return [];
                    }

                    return [{
                        kind: 'geometry',
                        shader: RENDERER_SHADER,
                        geometry: GEOMETRY_ID,
                        primitive: 'points',
                        vertexCount: activeCount,
                        inputs: { uState: state },
                        output: render.outputs.color,
                        blend: 'add',
                        clear: true,
                        uniforms: {
                            uMode: PARTICLE_RENDER_MODES.indexOf(mode),
                            uPointSize: 2.5,
                            uBrightness: 1.2,
                        },
                    }];
                },

                deactivate() {
                    // Nothing retained; the simulator owns the state.
                },

                destroy() {
                    uploaded = false;
                },
            };
        },
    };
}

export function createParticleEmitter(
    mode: typeof EMITTER_MODES[number] = 'region',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `ParticleEmitter:${mode}`,
        category: 'field',
        inputs: [
            // Optional, so a region or ring emitter works with no mask or artwork present at all.
            { name: 'shape', type: 'mask-texture', required: mode === 'shape' },
        ],
        outputs: [{ name: 'spawn', type: 'particle-buffer' }],
        capabilities: ['particle-emission'],
        fragment: EMITTER_FRAGMENT,
        uniforms: { uMode: EMITTER_MODES.indexOf(mode), uRate: 0.15 },
        parameters: { rate: 0.15 },
        bindings: [{
            feature: 'spectralFlux',
            parameter: 'rate',
            outputRange: [0.02, 0.5],
            attack: 0.02,
            release: 0.35,
            curve: 'sqrt',
        }],
        character: character({ visualDensity: 0, motionEnergy: 0.6, brightness: 0, dominance: 'supporting' }),
        activationWeight: 5,
        prefersWith: ['ParticleSimulator', 'ParticleTrailInjector'],
    });
}

export function createParticleForceField(
    mode: typeof FORCE_MODES[number] = 'vortex',
): VisualPluginDefinition {
    return defineShaderPlugin({
        id: `ParticleForceField:${mode}`,
        category: 'field',
        inputs: [{ name: 'field', type: 'vector-field', required: true }],
        outputs: [{ name: 'force', type: 'vector-field' }],
        capabilities: ['particle-force'],
        fragment: FORCE_FRAGMENT,
        uniforms: { uMode: FORCE_MODES.indexOf(mode), uStrength: 1 },
        parameters: { strength: 1 },
        bindings: [{
            feature: 'subBass',
            parameter: 'strength',
            outputRange: [0.3, 2.5],
            attack: 0.12,
            release: 0.5,
            curve: 'smooth',
        }],
        character: character({ visualDensity: 0, motionEnergy: 0.75, brightness: 0, dominance: 'supporting' }),
        scale: 0.5,
        activationWeight: 4,
        prefersWith: ['ParticleSimulator'],
    });
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
        bindings: [{
            feature: 'rms',
            role: 'intensity',
            parameter: 'decay',
            outputRange: [0.86, 0.98],
            attack: 0.25,
            release: 0.9,
            curve: 'smooth',
        }, {
            feature: 'trebleExcite',
            role: 'detail',
            parameter: 'amount',
            outputRange: [0.5, 1.6],
            attack: 0.04,
            release: 0.4,
            curve: 'sqrt',
        }],
        character: character({ persistence: 0.9, visualDensity: 0.6, dominance: 'supporting' }),
        feedbackPort: 'history',
        clear: false,
        memoryCost: 2,
        deactivationPolicy: 'handoff-feedback',
        activationWeight: 4,
        prefersWith: ['ParticleRenderer', 'ParticleSimulator'],
    });
}
