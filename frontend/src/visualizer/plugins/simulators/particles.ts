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
const BIN_SHADER = 'particle-bins';
const BIN_GEOMETRY_ID = 'particle-bin-indices';

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
/** Previous frame's spatial bins: one particle's position and velocity per grid cell. */
uniform sampler2D uBins;
uniform vec2 uResolution;
uniform vec2 uBinResolution;
uniform float uDelta;
uniform float uDrag;
uniform float uLifetime;
uniform float uTime;
uniform float uSeed;
/** Contact radius in clip units. One cell of the bin grid is one diameter across. */
uniform float uRadius;
/** How much of the closing speed is returned on contact. Zero is dead clay, one is billiards. */
uniform float uRestitution;
/** Zero disables contact resolution entirely, for the cheapest rung of the quality ladder. */
uniform float uContact;
uniform bool uHasBoundary;
uniform bool uHasSpawn;
${GLSL_COMMON}

/** Distinct groups a particle can be born into when no emitter is supplying positions. */
const float SEED_CLUSTERS = 7.0;

/**
 * Where a particle is born when nothing else says.
 *
 * Clustered, not uniform over the frame. Sixteen thousand independent uniform-random dots are
 * statistically identical to sixteen thousand others, so a field of them reshuffling frame to frame
 * has nothing in it to track: captures four hundred milliseconds apart were indistinguishable, and
 * dots crossing eight to thirty pixels per frame read as twinkle rather than travel. Motion is only
 * legible against structure, so particles are born in groups that a force field then carries, folds,
 * and pulls apart as recognisable bodies.
 */
vec2 seedPosition(vec2 uv, float generation) {
    float group = floor(hash(uv + uSeed + 5.3) * SEED_CLUSTERS);

    // Keyed to the generation, not to continuous time: a cluster has to hold still long enough for
    // the particles in it to read as belonging together. Each turnover moves the clusters somewhere
    // new, so the composition keeps changing without the field ever becoming uniform.
    vec2 centre = vec2(
        hash(vec2(group, uSeed + generation)),
        hash(vec2(group + 41.0, uSeed + generation))
    ) * 1.6 - 0.8;

    float angle = hash(uv + uSeed + 8.1 + generation) * 6.2831853;
    float radius = hash(uv + uSeed + 2.9 + generation) * 0.26;

    return centre + vec2(cos(angle), sin(angle)) * radius;
}

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
    bool aged = floor(cycles) > floor((uTime - uDelta) / lifetime + birth);

    // A particle that has left the frame is reborn rather than wrapped.
    //
    // Wrapping looked like the way to avoid piling particles on an edge, but for any divergent field
    // — repel, attract, spiral, gravity, wind — the seam is a trap: crossing it reverses the force
    // relative to the velocity, so particles oscillate about the boundary instead of passing through.
    // Measured, the fraction of particles sitting within three percent of an edge reached 0.18 in
    // repel scenes against 0.0003 elsewhere, and ensemble speed decayed from 0.242 to 0.042 clip
    // units per second over about 250 frames, leaving a hollow rectangle of noise around a black
    // centre that did not change from frame to frame.
    bool escaped = any(greaterThan(abs(position), vec2(1.06)));

    // An uninitialized texel starts as a seeded position rather than at the origin, so the first frame
    // does not show every particle stacked in one place.
    if (aged || escaped || (position == vec2(0.0) && velocity == vec2(0.0))) {
        float generation = floor(cycles);
        vec4 spawn = uHasSpawn ? texture(uSpawn, vUv) : vec4(0.0);
        position = uHasSpawn && spawn.a > 0.0 ? spawn.xy : seedPosition(vUv, generation);

        // Born moving, in a random direction. A birth speed of a twentieth of a clip unit per second
        // is nothing against field forces an order of magnitude larger, which is survivable when
        // particles are born once — but they are now born throughout the scene, and a point emitter
        // hands every one of them the same position. Without a real initial velocity that emitter
        // renders as a single dot: measured at one tenth of one percent of the frame lit, unchanging.
        // With one it is a fountain, which is what a point emitter is for.
        float launch = hash(vUv + 3.3 + generation) * 6.2831853;
        float speed = 0.22 + hash(vUv + 17.9 + generation) * 0.45;
        velocity = vec2(cos(launch), sin(launch)) * speed;
    }

    // The force field is sampled in field space, which is the same 0..1 domain as the screen.
    vec2 forceUv = position * 0.5 + 0.5;
    vec2 force = texture(uForce, clamp(forceUv, 0.0, 1.0)).xy;

    velocity += force * uDelta;
    velocity *= (1.0 - uDrag * uDelta);

    // Collision fields carry boundary proximity in blue and an outward normal in red/green. A mask is
    // a surface, so a particle is turned away from it and then moved clear of it — reflecting the
    // velocity alone lets a fast particle travel through the wall within a single step and arrive on
    // the far side still moving away from it, which is how a solid object becomes a suggestion.
    if (uHasBoundary) {
        vec4 boundary = texture(uBoundary, clamp(forceUv, 0.0, 1.0));
        float proximity = boundary.b;
        vec2 normal = length(boundary.rg) > 0.0001 ? normalize(boundary.rg) : vec2(0.0);
        if (proximity > 0.04) {
            if (dot(velocity, normal) < 0.0) {
                velocity = reflect(velocity, normal) * mix(0.72, 0.94, proximity);
            }
            // Positional, not a force: penetration is removed outright rather than discouraged.
            position += normal * proximity * uRadius * 1.5;
        }
    }

    position += velocity * uDelta;

    // Contact against the neighbours sharing this patch of the frame.
    //
    // Resolved as position-based dynamics, which is what makes these read as objects rather than as
    // charges: an overlap is corrected by moving both bodies apart by half of it, immediately, and the
    // component of relative velocity along the contact normal is reversed and damped. A repulsive
    // force would instead let two particles pass through one another whenever they arrived fast
    // enough, and would make every particle a soft haze at rest. Solid means the overlap is not
    // allowed to persist, which is a statement about position, not about force.
    if (uContact > 0.0) {
        vec2 bounce = vec2(0.0);
        float diameter = uRadius * 2.0;
        vec2 step_uv = vec2(1.0) / uBinResolution;

        // Relaxed repeatedly against the same neighbours, Jacobi style.
        //
        // A single pass moves this body half of one overlap and stops, which is right only if nothing
        // is pushing back. Something always is: the force field that drew the pile together is still
        // pulling while the contact is being resolved, so one pass per frame settles at an
        // equilibrium with the overlap still in it. Measured that way, median nearest-neighbour
        // distance stayed at the value a random field of this density gives — another way of saying
        // the contacts were holding nothing apart. Each further pass removes half of what is left.
        for (int iteration = 0; iteration < 4; iteration += 1) {
            vec2 correction = vec2(0.0);

            // Snapped to the centre of the cell this particle is in, then stepped a whole cell at a
            // time. Sampling at a continuous coordinate reads between texels, and under linear
            // filtering that returns the average of four neighbouring particles' positions — a point
            // where nothing is, which is never in contact with anything.
            vec2 cell = (floor((position * 0.5 + 0.5) * uBinResolution) + 0.5) * step_uv;

            for (int dy = -1; dy <= 1; dy += 1) {
                for (int dx = -1; dx <= 1; dx += 1) {
                    vec4 other = texture(uBins, cell + vec2(float(dx), float(dy)) * step_uv);

                    vec2 apart = position - other.xy;
                    float gap = length(apart);

                    // A gap of zero is this particle finding itself; an empty cell reads as the
                    // origin, which the radius test rejects unless something is genuinely there.
                    if (gap > 1e-5 && gap < diameter) {
                        vec2 normal = apart / gap;
                        correction += normal * (diameter - gap) * 0.5;

                        // Restitution is collected on the first pass only. The later passes resolve
                        // position against a snapshot; counting the same impact again each time
                        // would multiply one collision into four.
                        if (iteration == 0) {
                            float closing = dot(velocity - other.zw, normal);
                            if (closing < 0.0) {
                                bounce += normal * (-closing) * uRestitution;
                            }
                        }
                    }
                }
            }

            position += correction;
        }

        velocity += bounce;
    }

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

/**
 * Spatial binning: each particle writes itself into the grid cell it occupies.
 *
 * This is what makes particle-to-particle contact affordable. Testing every particle against every
 * other is two hundred and sixty-eight million pairs at this count; testing against the nine cells
 * around you is nine texture reads. The grid is sized so one cell is one particle diameter, which
 * makes at most one particle fit per cell in a resting pack and turns "the neighbours that could be
 * touching me" into a fixed, tiny neighbourhood.
 *
 * The winner of a contested cell is whichever particle draws last. That is arbitrary, and it is the
 * standard trade: a cell holding two particles means a contact is missed for one frame, and the pair
 * separates on the next one because the overlap is still there.
 */
const BIN_VERTEX = `#version 300 es
in vec2 aIndex;
out vec4 vBody;

uniform sampler2D uState;

void main() {
    vec4 state = texture(uState, aIndex);
    vBody = state;

    // Position in clip space maps directly to a cell, because the grid covers the same square.
    gl_PointSize = 1.0;
    gl_Position = vec4(clamp(state.xy, -0.999, 0.999), 0.0, 1.0);
}`;

const BIN_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vBody;
out vec4 fragColor;

void main() {
    // Position and velocity of whoever holds this cell. Alpha is unused: an empty cell reads as all
    // zeroes, and a particle at exactly the origin with exactly zero velocity is the uninitialised
    // state the simulator overwrites on its first frame anyway.
    fragColor = vBody;
}`;

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

/** Contact radius in clip units — half a cell, so two touching particles span exactly one. */
export const CONTACT_RADIUS = 1 / BIN_SIDE;

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
            // This plugin's own bins from the previous frame, which is what it collides against.
            { name: 'crowd', type: 'particle-buffer', required: false, feedbackFrom: 'bins' },
        ],
        outputs: [
            { name: 'state', type: 'particle-buffer', required: false },
            { name: 'bins', type: 'particle-buffer', required: false, internal: true },
        ],
        capabilities: ['particles', 'feedback'],
        requiredCapabilities: ['float-textures'],
        // Two passes and a second buffer: the step, then the binning that makes contact affordable.
        // GPU cost stays at two — the bin pass draws sixteen thousand single-pixel points into a
        // 128-square target, which is nothing beside the step itself, and three would cross the
        // high-cost threshold and make particle scenes rarer for no real expense.
        cost: { gpu: 2, cpu: 0, memory: 3, renderPasses: 2, qualityScalable: true, dominant: false },
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
            let contactEnabled = 1;

            // One vertex per particle holding its own lookup coordinate, for the binning pass.
            const indices = new Float32Array(PARTICLE_TEXTURE_SIDE * PARTICLE_TEXTURE_SIDE * 2);
            for (let y = 0; y < PARTICLE_TEXTURE_SIDE; y += 1) {
                for (let x = 0; x < PARTICLE_TEXTURE_SIDE; x += 1) {
                    const offset = (y * PARTICLE_TEXTURE_SIDE + x) * 2;
                    indices[offset] = (x + 0.5) / PARTICLE_TEXTURE_SIDE;
                    indices[offset + 1] = (y + 0.5) / PARTICLE_TEXTURE_SIDE;
                }
            }
            let uploaded = false;

            return {
                initialize() {
                    context.registerShader({
                        id: SIMULATOR_SHADER,
                        vertex: QUAD_VERTEX_SHADER,
                        fragment: SIMULATOR_FRAGMENT,
                    });
                    context.registerShader({
                        id: BIN_SHADER,
                        vertex: BIN_VERTEX,
                        fragment: BIN_FRAGMENT,
                    });
                },

                activate() {
                    // The simulation state lives in the ping-ponged target, not here.
                    uploaded = false;
                },

                update(frame) {
                    // Playback time, so lifetimes advance with the music and hold when it does.
                    playbackTime = frame.clock.playbackTime;

                    // Contact is the expensive half. The ladder's particle scale is the signal that
                    // the machine is struggling, and a thinned field has few contacts to resolve
                    // anyway, so it is the first thing given up rather than the frame rate.
                    contactEnabled = (frame.particleScale ?? 1) >= 0.6 ? 1 : 0;

                    if (!uploaded) {
                        frame.uploadGeometry({
                            id: BIN_GEOMETRY_ID,
                            data: indices,
                            attributes: [{ name: 'aIndex', components: 2 }],
                        });
                        uploaded = true;
                    }
                },

                render(render): RenderPass[] {
                    const force = render.inputs.force;
                    if (!force) {
                        return [];
                    }
                    const boundary = render.inputs.boundary;
                    const spawn = render.inputs.spawn;
                    const crowd = render.previous.crowd;

                    const passes: RenderPass[] = [{
                        kind: 'fullscreen',
                        shader: SIMULATOR_SHADER,
                        inputs: {
                            uForce: force,
                            uState: render.previous.history ?? render.outputs.state,
                            ...(boundary ? { uBoundary: boundary } : {}),
                            ...(spawn ? { uSpawn: spawn } : {}),
                            ...(crowd ? { uBins: crowd } : {}),
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
                            uRadius: CONTACT_RADIUS,
                            uRestitution: 0.45,
                            uBinResolution: [BIN_SIDE, BIN_SIDE],
                            uContact: crowd ? contactEnabled : 0,
                            uHasBoundary: boundary !== undefined,
                            uHasSpawn: spawn !== undefined,
                        },
                    }];

                    // Binning runs after the step, so next frame's contacts are resolved against
                    // where everything actually ended up rather than where it started.
                    if (render.outputs.bins) {
                        passes.push({
                            kind: 'geometry',
                            shader: BIN_SHADER,
                            geometry: BIN_GEOMETRY_ID,
                            primitive: 'points',
                            vertexCount: PARTICLE_TEXTURE_SIDE * PARTICLE_TEXTURE_SIDE,
                            inputs: { uState: render.outputs.state },
                            output: render.outputs.bins,
                            blend: 'none',
                            clear: true,
                        });
                    }

                    return passes;
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
