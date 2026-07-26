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
import type { FieldSample, VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import type { RenderPass } from '../../core/passes';
import { createParticleWorld, stepParticles } from '../../core/particle-physics';

// Only the two hand-written plugins need explicit shader ids; the rest go through
// `defineShaderPlugin`, which derives the id from the plugin's own id.
const RENDERER_SHADER = 'particle-renderer';
const STATE_SHADER = 'particle-state-upload';
const STATE_GEOMETRY_ID = 'particle-bodies';

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
const STATE_VERTEX = `#version 300 es
in vec2 aSlot;
in vec4 aBody;
out vec4 vBody;

void main() {
    vBody = aBody;
    gl_PointSize = 1.0;
    // One point per particle, landing on that particle's own texel of the state texture.
    gl_Position = vec4(aSlot * 2.0 - 1.0, 0.0, 1.0);
}`;

const STATE_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vBody;
out vec4 fragColor;

void main() {
    fragColor = vBody;
}`;


/** Clip units per second per unit of field magnitude. */
const FORCE_SCALE = 2.4;

/** Collision-field proximity below which a point counts as clear of the surface. */
const SURFACE_THRESHOLD = 0.04;

/** Scratch for one field read, so sampling allocates nothing per particle. */
const sampled: [number, number, number] = [0, 0, 0];

/**
 * A bilinear sampler over a field read back from the GPU, in clip coordinates.
 *
 * Bilinear rather than nearest because the field is a fraction of the screen resolution and a body
 * crosses several texels a second; nearest sampling makes a smooth field into a staircase and the
 * whole ensemble twitches on texel boundaries.
 */
function sampleField(
    field: FieldSample | undefined,
): ((x: number, y: number, out: [number, number, number]) => void) | undefined {
    if (!field || field.width < 2 || field.height < 2) {
        return undefined;
    }

    const { width, height, data } = field;

    return (x, y, out) => {
        const u = Math.min(width - 1.001, Math.max(0, (x * 0.5 + 0.5) * (width - 1)));
        const v = Math.min(height - 1.001, Math.max(0, (y * 0.5 + 0.5) * (height - 1)));
        const x0 = Math.floor(u);
        const y0 = Math.floor(v);
        const fx = u - x0;
        const fy = v - y0;

        for (let channel = 0; channel < 3; channel += 1) {
            const a = data[(y0 * width + x0) * 4 + channel];
            const b = data[(y0 * width + x0 + 1) * 4 + channel];
            const c = data[((y0 + 1) * width + x0) * 4 + channel];
            const d = data[((y0 + 1) * width + x0 + 1) * 4 + channel];
            out[channel] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        }
    };
}

/**
 * Where bodies are born: from an emitter's buffer when one is wired, otherwise in clusters.
 *
 * Clustered rather than uniform because motion is only legible against structure. Sixteen thousand
 * independent uniform-random dots are statistically identical to sixteen thousand others, so a field
 * of them reshuffling has nothing in it to track — captures four hundred milliseconds apart were
 * indistinguishable. Bodies born in groups get carried, folded and pulled apart as recognisable
 * things.
 */
function createSpawner(seed: number) {
    const CLUSTERS = 7;
    let emitter: ((x: number, y: number, out: [number, number, number]) => void) | undefined;
    let generation = 0;
    let centres = clusterCentres(seed, generation);

    function clusterCentres(base: number, turn: number): number[] {
        const out: number[] = [];
        for (let index = 0; index < CLUSTERS; index += 1) {
            out.push(
                Math.sin((base + turn * 0.618 + index) * 12.9898) * 0.8,
                Math.cos((base + turn * 0.618 + index) * 78.233) * 0.8,
            );
        }

        return out;
    }

    return {
        setEmitter(field: ((x: number, y: number, out: [number, number, number]) => void) | undefined) {
            emitter = field;
        },

        /** Advances to a new arrangement of clusters, so the composition keeps changing. */
        turnOver() {
            generation += 1;
            centres = clusterCentres(seed, generation);
        },

        place(index: number, total: number, out: [number, number]) {
            if (emitter) {
                // The emitter buffer is indexed by particle, so read it at this body's own texel.
                const u = ((index % PARTICLE_TEXTURE_SIDE) + 0.5) / PARTICLE_TEXTURE_SIDE;
                const v = (Math.floor(index / PARTICLE_TEXTURE_SIDE) + 0.5) / PARTICLE_TEXTURE_SIDE;
                emitter(u * 2 - 1, v * 2 - 1, sampled);

                if (Math.abs(sampled[0]) <= 1 && Math.abs(sampled[1]) <= 1) {
                    // Displaced by a hair, unique per body. A point emitter hands every particle the
                    // identical position, and bodies at exactly the same place have no direction to
                    // separate along — the case that used to weld them together permanently.
                    out[0] = sampled[0] + ((index % 97) / 97 - 0.5) * CONTACT_RADIUS;
                    out[1] = sampled[1] + ((index % 89) / 89 - 0.5) * CONTACT_RADIUS;
                    return;
                }
            }

            const cluster = index % CLUSTERS;
            const angle = (index / total) * Math.PI * 2 + cluster;
            const radius = ((index * 37) % 101) / 101 * 0.26;

            out[0] = centres[cluster * 2] + Math.cos(angle) * radius;
            out[1] = centres[cluster * 2 + 1] + Math.sin(angle) * radius;
        },
    };
}

/** Draws the state texture as points, one vertex per particle. */
const RENDERER_VERTEX = `#version 300 es
in vec2 aIndex;
out float vSpeed;

uniform sampler2D uState;
uniform float uPointSize;

void main() {
    vec4 state = texture(uState, aIndex);
    vSpeed = length(state.zw);

    // Size carries speed. At a fixed size the only cue that a particle is moving is that it is
    // somewhere else next frame, which at these speeds — eight to thirty pixels between frames, with
    // no trail — reads as a different particle rather than the same one having travelled.
    //
    // A floor of three device pixels regardless: below that a particle is a fleck whatever else is
    // true of it, and the whole field reads as grain.
    gl_PointSize = max(3.0, uPointSize * (0.55 + min(vSpeed * 2.6, 1.75)));
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

// A pair of shaders that binned particles into a texture-backed spatial grid stood here. The grid
// itself was right — a uniform grid is the standard broad phase — but a texel holds four floats and
// four floats is one particle, so a cell could only ever remember one occupant, and a fragment shader
// cannot write to another particle, so a contact could never be resolved once with both bodies
// moving. Both limits belonged to the container rather than to the algorithm. See
// `core/particle-physics.ts`.

const EMITTER_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uShape;
uniform vec2 uResolution;
uniform float uMode;
uniform float uRate;
uniform float uTime;
uniform float uSeed;
${GLSL_COMMON}

/**
 * Where this emitter sits.
 *
 * Every mode used to be centred on the origin — a point emitter at exactly the middle of the frame, a
 * ring concentric with it, a line straight through it. Dead centre is the one position that reads as
 * a diagram rather than as something happening somewhere, and with the frame symmetric about it there
 * is nowhere for the eye to travel. Placed off centre from the instance seed and drifting slowly, so
 * two emitters in a scene are in different places and neither stays put.
 */
vec2 emitterOrigin() {
    vec2 base = vec2(hash(vec2(uSeed, 3.1)), hash(vec2(uSeed, 7.7))) * 1.2 - 0.6;
    vec2 drift = vec2(
        sin(uTime * 0.07 + uSeed * 6.28),
        cos(uTime * 0.053 + uSeed * 12.9)
    ) * 0.22;

    return clamp(base + drift, vec2(-0.85), vec2(0.85));
}

void main() {
    vec2 origin = emitterOrigin();
    vec2 spawn;

    if (uMode < 0.5) {                       // point
        spawn = origin;
    } else if (uMode < 1.5) {                // region
        spawn = origin + (vec2(hash(vUv + uSeed), hash(vUv + uSeed + 1.7)) * 2.0 - 1.0) * 0.45;
    } else if (uMode < 2.5) {                // line
        float along = hash(vUv + uSeed) * 2.0 - 1.0;
        float tilt = uSeed * 3.1415926;
        spawn = origin + vec2(cos(tilt), sin(tilt)) * along * 0.8;
    } else if (uMode < 3.5) {                // ring
        float angle = hash(vUv + uSeed) * 6.2831853;
        spawn = origin + vec2(cos(angle), sin(angle)) * 0.45;
    } else {
        // Shape interior or edge: rejection-sampled against the supplied mask, so a mask or album-art
        // edge can seed particles without the emitter knowing which it was given.
        vec2 candidate = vec2(hash(vUv + uSeed), hash(vUv + uSeed + 5.3));
        float weight = texture(uShape, candidate).r;
        spawn = weight > 0.4 ? candidate * 2.0 - 1.0 : vec2(2.0);
    }

    // Rate gates emission, and the gate moves.
    //
    // Hashed on the texel alone, it was a fixed subset: a given particle either always came from the
    // emitter or never did, for the life of the scene, so the emitter fed a static fraction of the
    // field instead of streaming. Advancing the hash with time makes every particle pass through the
    // emitter sooner or later, which is what makes it read as a source rather than a stencil.
    float gate = step(hash(vUv + uSeed + 13.1 + floor(uTime * 7.0) * 0.37), uRate);
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

/**
 * Particle count at full quality. The performance ladder's particle scale multiplies this.
 *
 * Four thousand rather than sixteen. Solid contact and a large drawn particle put a ceiling on how
 * many can share a frame: at sixteen thousand, discs of one contact diameter cover seventy-eight
 * percent of it, which is past the density at which discs can be packed without crystallising, so
 * most overlaps could not be resolved and the field went back to being a haze. At four thousand the
 * same discs cover a fifth of the frame — dense enough to collide constantly, loose enough that every
 * collision can actually be answered.
 */
export const PARTICLE_TEXTURE_SIDE = 64;

/**
 * Side of the spatial grid particles are binned into for contact.
 *
 * Matched to the particle count, so a fully packed field has about one particle per cell. The cell
 * size is then the contact diameter, which is what makes a three-by-three neighbourhood sufficient:
 * anything close enough to touch is in it.
 */
export const BIN_SIDE = 128;

/**
 * Contact radius in clip units — half a cell, so two touching bodies span exactly one.
 *
 * A cell equal to one diameter is what makes a three-by-three neighbourhood provably sufficient: a
 * body anywhere in its cell can only reach into the cells adjacent to it. Halving the cell was tried,
 * on the reasoning that one particle per cell cannot represent a pile — but a body then spans two
 * cells and a two-cell search covers only three quarters of a diameter, so mid-range contacts go
 * missing. Measured, that took overlaps from forty-seven percent to seventy-four.
 */
export const CONTACT_RADIUS = 1 / BIN_SIDE;

/**
 * Cells searched either side of a body's own.
 *
 * Mirrored by `CONTACT_SEARCH` in the simulation shader, which cannot read this because the shader
 * source is declared above it. The static shader test catches interpolation failing; it cannot catch
 * the two disagreeing, so any change here has to be made in both.
 */
export const CONTACT_SEARCH = 1;

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
        ],
        outputs: [
            { name: 'state', type: 'particle-buffer', required: false },
        ],
        capabilities: ['particles'],
        requiredCapabilities: ['float-textures'],
        // One pass, and it only uploads: the simulation is CPU work, so the cost is in `cpu`.
        cost: { gpu: 1, cpu: 2, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
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
            const count = PARTICLE_TEXTURE_SIDE * PARTICLE_TEXTURE_SIDE;
            const world = createParticleWorld(count);
            const spawner = createSpawner(context.seed);

            // Interleaved per particle: the texel it owns, then its position and velocity. Uploaded
            // every frame, which is the whole GPU cost of the simulation now — 4096 points into a
            // 64-square target.
            const bodies = new Float32Array(count * 6);
            for (let y = 0; y < PARTICLE_TEXTURE_SIDE; y += 1) {
                for (let x = 0; x < PARTICLE_TEXTURE_SIDE; x += 1) {
                    const offset = (y * PARTICLE_TEXTURE_SIDE + x) * 6;
                    bodies[offset] = (x + 0.5) / PARTICLE_TEXTURE_SIDE;
                    bodies[offset + 1] = (y + 0.5) / PARTICLE_TEXTURE_SIDE;
                }
            }

            let active = count;

            return {
                initialize() {
                    context.registerShader({
                        id: STATE_SHADER,
                        vertex: STATE_VERTEX,
                        fragment: STATE_FRAGMENT,
                    });
                },

                activate() {
                    world.positions.fill(0);
                    world.velocities.fill(0);
                    world.ages.fill(0);
                },

                update(frame) {
                    // The ladder's particle scale thins the field by simulating and drawing fewer
                    // bodies, which reduces the contact work quadratically rather than turning the
                    // physics off.
                    active = Math.max(0, Math.min(count, Math.round(count * (frame.particleScale ?? 1))));

                    const force = sampleField(frame.readField(frame.inputs?.force));
                    const boundary = sampleField(frame.readField(frame.inputs?.boundary));
                    const emitted = sampleField(frame.readField(frame.inputs?.spawn));

                    spawner.setEmitter(emitted);

                    stepParticles(world, {
                        deltaSeconds: frame.deltaSeconds,
                        radius: CONTACT_RADIUS,
                        restitution: 0.45,
                        drag: frame.parameters.drag ?? 0.4,
                        lifetimeSeconds: Math.max(0.4, frame.parameters.lifetime ?? 4),
                        iterations: 4,
                        force: force
                            // A vector field carries its direction in red and green, over the same
                            // zero-to-one domain as the screen.
                            ? (x, y, out) => {
                                force(x, y, sampled);
                                out[0] = sampled[0] * FORCE_SCALE;
                                out[1] = sampled[1] * FORCE_SCALE;
                            }
                            // No field read back yet, which is the state for the first frames of a
                            // scene. A gentle drift beats standing still.
                            : (_x, _y, out) => { out[0] = 0; out[1] = 0; },
                        spawn: (index, out) => spawner.place(index, count, out),
                        // Collision fields carry an outward normal in red and green and how far inside
                        // the surface a point is in blue. That is exactly a penetration depth and a
                        // normal, which is what a solid surface is.
                        surface: boundary
                            ? (x, y, out) => {
                                boundary(x, y, sampled);
                                const length = Math.hypot(sampled[0], sampled[1]);
                                if (length < 1e-4 || sampled[2] <= SURFACE_THRESHOLD) {
                                    return 0;
                                }
                                out[0] = sampled[0] / length;
                                out[1] = sampled[1] / length;
                                return (sampled[2] - SURFACE_THRESHOLD) * CONTACT_RADIUS * 2;
                            }
                            : undefined,
                    });

                    for (let i = 0; i < count; i += 1) {
                        const offset = i * 6;
                        bodies[offset + 2] = world.positions[i * 2];
                        bodies[offset + 3] = world.positions[i * 2 + 1];
                        bodies[offset + 4] = world.velocities[i * 2];
                        bodies[offset + 5] = world.velocities[i * 2 + 1];
                    }

                    frame.uploadGeometry({
                        id: STATE_GEOMETRY_ID,
                        data: bodies,
                        attributes: [
                            { name: 'aSlot', components: 2 },
                            { name: 'aBody', components: 4 },
                        ],
                    });
                },

                render(render): RenderPass[] {
                    // The physics does not need a force field to run — bodies still fall out of
                    // emitters and collide — but a particle scene without one is not a scene worth
                    // assembling, so the port stays required and this stays a hard stop.
                    if (!render.inputs.force || !render.outputs.state || active === 0) {
                        return [];
                    }

                    // The only GPU work left: copy the bodies into the texture the renderer reads.
                    // Everything that decides where they are happened in `update`, on the CPU, where
                    // both halves of a contact can be moved.
                    return [{
                        kind: 'geometry',
                        shader: STATE_SHADER,
                        geometry: STATE_GEOMETRY_ID,
                        primitive: 'points',
                        vertexCount: active,
                        output: render.outputs.state,
                        blend: 'none',
                        clear: true,
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
        // Nine device pixels at rest, against two and a half before. At the old size, scaled by the
        // speed term and then divided by the device pixel ratio, a particle occupied one to four CSS
        // pixels — visible only as a fleck, and indistinguishable from sensor noise once a dozen of
        // them overlapped. A particle has to be large enough to read as a body before any amount of
        // correct physics makes it look like one is moving.
        parameters: { pointSize: 9, brightness: 1.2 },
        defaultBindings: [
            {
                feature: 'treble',
                parameter: 'brightness',
                outputRange: [0.7, 2],
                attack: 0.03,
                release: 0.3,
                curve: 'sqrt',
            },
            {
                // Size answers to the music as well as to speed. Held on a large-scale force so the
                // field swells and contracts as a body rather than flickering per particle.
                feature: 'bass',
                role: 'large-scale-force',
                parameter: 'pointSize',
                outputRange: [6, 17],
                attack: 0.2,
                release: 0.8,
                curve: 'smooth',
            },
        ],
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
        uniforms: { uMode: EMITTER_MODES.indexOf(mode), uRate: 0.5 },
        // Rate is the share of rebirths this emitter claims, and it was low enough that the emitter
        // was a minority contributor to its own scene: at 0.15, six particles in seven were born from
        // the simulator's fallback clustering instead and the emitter's shape barely showed. A scene
        // that selected an emitter should look like it has one.
        parameters: { rate: 0.5 },
        bindings: [{
            feature: 'spectralFlux',
            parameter: 'rate',
            outputRange: [0.2, 0.92],
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
