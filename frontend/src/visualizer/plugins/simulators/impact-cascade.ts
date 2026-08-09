/**
 * `ImpactCascadeSimulator` (spec section 19.6).
 *
 * accelerate → collide → burst → fragment spray → field warp. Distinct from ambient particles: the point
 * is the collision, not the drift, so the simulator tracks streams converging on impact cores and
 * publishes an `ImpactEvent` when they meet.
 *
 * The only plugin that publishes impacts. Everything else — shockwave transforms, wave-field impulses,
 * transient glyphs, glow — consumes them through the kernel's impact bus, which is why the event is a
 * kernel type rather than private to this file.
 */

import {
    character,
    decayPass,
    decayShaderSource,
    GLSL_PERTURB_VERTEX,
    SURVIVAL_BINDING,
    SURVIVAL_PARAMETER,
} from '../define';
import type { ImpactEvent } from '../../core/impact';
import type { RenderPass } from '../../core/passes';
import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';

const CASCADE_SHADER = 'impact-cascade';
const CASCADE_GEOMETRY = 'impact-fragments';
const CASCADE_MOTION_SHADER = 'impact-cascade:motion';
const CASCADE_MOTION_GEOMETRY = 'impact-fragments-motion';

/**
 * The wake of a projectile stream (ADR-0012).
 *
 * A `Projectile` carries `vx` and `vy`, so unlike every geometry source in the catalog this needs no
 * differencing and no derivation — the velocity is the simulation's own state. It went unpublished
 * because I did not look, not because there was nothing to publish.
 *
 * Reach is wider than the point the colour pass draws, for the same reason a brush is wider than a
 * bristle: a field the size of the sprite drags only the pixels the sprite already covers.
 */
const CASCADE_MOTION_VERTEX = `#version 300 es
in vec2 aPosition;
in vec2 aVelocity;
out vec2 vVelocity;

uniform float uReach;

void main() {
    vVelocity = aVelocity;
    gl_PointSize = uReach;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const CASCADE_MOTION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vVelocity;
out vec4 fragColor;

uniform float uWakeScale;

void main() {
    float falloff = 1.0 - smoothstep(0.1, 0.5, length(gl_PointCoord - 0.5));
    if (falloff <= 0.0) {
        discard;
    }

    // Clip space spans two units across the frame against UV's one.
    vec2 field = vVelocity * 0.5 * uWakeScale * falloff;

    fragColor = vec4(field, falloff, 1.0);
}`;

const CASCADE_VERTEX = `#version 300 es
in vec2 aPosition;
in float aEnergy;
out float vEnergy;
uniform float uPointSize;
${GLSL_PERTURB_VERTEX}
void main() {
    vEnergy = aEnergy;
    gl_PointSize = uPointSize * (0.5 + aEnergy * 2.0);
    // Displaced by a wired field like every other producer, so a cascade can be blown around by the
    // scene rather than only by its own solver.
    gl_Position = vec4(perturbedPosition(aPosition), 0.0, 1.0);
}`;

const CASCADE_FRAGMENT = `#version 300 es
precision highp float;
in float vEnergy;
out vec4 fragColor;
uniform float uBrightness;
void main() {
    vec2 offset = gl_PointCoord - 0.5;
    float falloff = 1.0 - smoothstep(0.0, 0.5, length(offset));
    float energy = clamp(falloff * vEnergy * uBrightness, 0.0, 1.0);
    // Hotter core than edge, so a fresh fragment reads as incandescent rather than flat.
    fragColor = vec4(vec3(energy) * vec3(1.0, 0.85, 0.7), energy);
}`;

export type CascadeMode =
    | 'head-on'
    | 'orbital-collapse'
    | 'boundary-slam'
    | 'scatter-field'
    | 'gravity-capture'
    | 'magnetic-arc';

export const CASCADE_MODES: readonly CascadeMode[] = [
    'head-on', 'orbital-collapse', 'boundary-slam', 'scatter-field', 'gravity-capture', 'magnetic-arc',
];

interface Projectile {
    x: number;
    y: number;
    vx: number;
    vy: number;
    energy: number;
    /** Fragments are spawned by an impact and do not themselves collide. */
    fragment: boolean;
    age: number;
}

const MAX_PROJECTILES = 384;
const FRAGMENTS_PER_IMPACT = 14;
const COLLISION_RADIUS = 0.06;
const FRAGMENT_LIFETIME = 1.1;

/**
 * Advances the cascade one step and returns whatever impacts occurred.
 *
 * Pure over its inputs so the collision behaviour is testable: the spec wants acceleration, collision,
 * fragmentation, and secondary field distortion to be visibly produced, and the first three are decided
 * here rather than in a shader.
 */
export function advanceCascade(
    mode: CascadeMode,
    projectiles: readonly Projectile[],
    deltaSeconds: number,
    playbackTime: number,
    energyScale: number,
): { projectiles: Projectile[]; impacts: ImpactEvent[] } {
    if (deltaSeconds <= 0) {
        // Frozen clock: nothing accelerates, nothing collides.
        return { projectiles: [...projectiles], impacts: [] };
    }

    const advanced: Projectile[] = [];
    const impacts: ImpactEvent[] = [];

    for (const projectile of projectiles) {
        const acceleration = accelerationFor(mode, projectile);

        const next: Projectile = {
            ...projectile,
            vx: projectile.vx + acceleration[0] * deltaSeconds,
            vy: projectile.vy + acceleration[1] * deltaSeconds,
            age: projectile.age + deltaSeconds,
        };
        next.x += next.vx * deltaSeconds;
        next.y += next.vy * deltaSeconds;

        if (next.fragment) {
            if (next.age < FRAGMENT_LIFETIME) {
                // Fragments decelerate rather than travelling forever.
                next.vx *= 0.985;
                next.vy *= 0.985;
                advanced.push(next);
            }
            continue;
        }

        // Boundary slam collides with the frame edge; the others collide with the centre core.
        const hitBoundary = mode === 'boundary-slam'
            && (Math.abs(next.x) > 0.92 || Math.abs(next.y) > 0.92);
        // Tested against the whole step rather than its endpoint. Near the core the acceleration is
        // large enough that a projectile can cross the collision radius entirely within one frame, and
        // an endpoint test would let it tunnel straight through.
        const hitCore = mode !== 'boundary-slam'
            && segmentDistanceToOrigin(projectile.x, projectile.y, next.x, next.y) < COLLISION_RADIUS;

        if (!hitBoundary && !hitCore) {
            advanced.push(next);
            continue;
        }

        const speed = Math.hypot(next.vx, next.vy);
        const energy = Math.min(4, speed * next.energy * energyScale);

        impacts.push({
            position: [(next.x + 1) / 2, (next.y + 1) / 2],
            energy,
            impulse: [next.vx, next.vy],
            radius: 0.08 + energy * 0.12,
            playbackTime,
        });

        // Fragment spray: the projectile is consumed and its energy redistributed outward.
        for (let index = 0; index < FRAGMENTS_PER_IMPACT; index += 1) {
            const angle = (index / FRAGMENTS_PER_IMPACT) * Math.PI * 2;
            const spread = 0.4 + (index % 3) * 0.25;

            advanced.push({
                x: next.x,
                y: next.y,
                vx: Math.cos(angle) * speed * spread,
                vy: Math.sin(angle) * speed * spread,
                energy: energy * 0.35,
                fragment: true,
                age: 0,
            });
        }
    }

    return { projectiles: advanced.slice(-MAX_PROJECTILES), impacts };
}

/**
 * Closest approach of the segment from (x0, y0) to (x1, y1) to the origin.
 *
 * Exported for testing: swept collision is the difference between a cascade that visibly collides and one
 * whose fastest projectiles silently pass through the core.
 */
export function segmentDistanceToOrigin(x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
        return Math.hypot(x0, y0);
    }

    // Projection of the origin onto the segment, clamped to its endpoints.
    const t = Math.max(0, Math.min(1, -(x0 * dx + y0 * dy) / lengthSquared));

    return Math.hypot(x0 + t * dx, y0 + t * dy);
}

/** Acceleration source per mode (spec section 19.6). */
function accelerationFor(mode: CascadeMode, projectile: Projectile): [number, number] {
    const distance = Math.max(0.02, Math.hypot(projectile.x, projectile.y));
    const toCentre: [number, number] = [-projectile.x / distance, -projectile.y / distance];

    switch (mode) {
        case 'head-on':
            // Opposing streams: each side is pushed toward the other along its own axis.
            return [projectile.x > 0 ? -1.4 : 1.4, 0];

        case 'orbital-collapse': {
            // Gravity plus a decaying tangential component, so orbits tighten rather than hold.
            const tangential: [number, number] = [-projectile.y / distance, projectile.x / distance];
            const gravity = 1.8 / (distance * distance);
            return [
                toCentre[0] * gravity + tangential[0] * 0.35,
                toCentre[1] * gravity + tangential[1] * 0.35,
            ];
        }

        case 'boundary-slam':
            return [projectile.vx * 0.6, projectile.vy * 0.6];

        case 'scatter-field':
            return [Math.sin(projectile.y * 5) * 1.2, Math.cos(projectile.x * 5) * 1.2];

        case 'gravity-capture':
            return [toCentre[0] * (2.4 / (distance * distance)), toCentre[1] * (2.4 / (distance * distance))];

        case 'magnetic-arc': {
            // Velocity-perpendicular force, which curves a straight launch into an arc.
            const speed = Math.max(0.01, Math.hypot(projectile.vx, projectile.vy));
            return [(-projectile.vy / speed) * 2.2, (projectile.vx / speed) * 2.2];
        }
    }
}

/** Initializes a projectile stream from this fresh scene instance's random identity. */
export function seedCascade(mode: CascadeMode, seed: number, count: number): Projectile[] {
    const projectiles: Projectile[] = [];

    for (let index = 0; index < count; index += 1) {
        const t = index / Math.max(1, count - 1);
        const jitter = Math.abs(Math.sin((seed + index) * 127.1)) - 0.5;

        switch (mode) {
            case 'head-on':
                projectiles.push({
                    x: index % 2 === 0 ? -1 : 1,
                    y: jitter * 0.7,
                    vx: index % 2 === 0 ? 0.7 : -0.7,
                    vy: 0,
                    energy: 1,
                    fragment: false,
                    age: 0,
                });
                break;

            case 'boundary-slam':
                projectiles.push({
                    // Both axes took the same jitter, which put all forty-eight projectiles exactly
                    // on the leading diagonal — a line, where the mode is meant to scatter.
                    x: jitter * 0.5,
                    y: Math.cos(t * Math.PI * 4 + jitter) * 0.5,
                    vx: Math.cos(t * Math.PI * 2) * 0.9,
                    vy: Math.sin(t * Math.PI * 2) * 0.9,
                    energy: 1,
                    fragment: false,
                    age: 0,
                });
                break;

            default: {
                const angle = t * Math.PI * 2 + seed;
                const radius = 0.55 + jitter * 0.3;
                projectiles.push({
                    x: Math.cos(angle) * radius,
                    y: Math.sin(angle) * radius,
                    // Tangential launch, so the stream orbits before it collapses.
                    vx: -Math.sin(angle) * 0.5,
                    vy: Math.cos(angle) * 0.5,
                    energy: 1,
                    fragment: false,
                    age: 0,
                });
                break;
            }
        }
    }

    return projectiles;
}

export function createImpactCascadeSimulator(mode: CascadeMode = 'orbital-collapse'): VisualPluginDefinition {
    const STREAM_COUNT = 48;

    return {
        id: `ImpactCascadeSimulator:${mode}`,
        version: 1,
        category: 'simulator',
        inputs: [{ name: 'field', type: 'vector-field', required: false }],
        outputs: [
            { name: 'color', type: 'color-texture', required: false },
            // Velocities the simulation already holds, so this needs no derivation at all.
            { name: 'motion', type: 'vector-field', required: false },
        ],
        capabilities: ['impact-dynamics', 'impact-producer', 'vector-field'],
        cost: {
            gpu: 3,
            cpu: 2,
            memory: 2,
            renderPasses: 3,
            qualityScalable: true,
            // Dominant: the grammar allows only one, so it never competes with another generator.
            dominant: true,
        },
        character: character({
            visualDensity: 0.75,
            motionEnergy: 0.95,
            geometricOrder: 0.25,
            persistence: 0.3,
            brightness: 0.85,
            dominance: 'primary',
        }),
        activationRules: {
            activationWeight: 1,
            minimumDuration: 18,
            // Avoid running alongside another heavy continuous simulator.
            incompatibleWith: ['ReactionDiffusionSimulator'],
            prefersWith: ['ShockwaveTransform:bulge', 'GlowAndScatter:soft-bloom'],
        },
        // Longer than the catalog default: the whole subject is bodies travelling, and how far back
        // the trail reaches is how much of the travel is visible at once.
        parameters: { energyScale: 1, brightness: 1.4, wakeScale: 1.4, [SURVIVAL_PARAMETER]: 0.8 },
        defaultBindings: [SURVIVAL_BINDING, {
            feature: 'bass',
            parameter: 'energyScale',
            outputRange: [0.5, 2.5],
            attack: 0.08,
            release: 0.45,
            curve: 'smooth',
        }, {
            // How hard the stream pulls the image it crosses, for anything reading its wake.
            feature: 'subBass',
            role: 'large-scale-force',
            parameter: 'wakeScale',
            outputRange: [0.4, 2.6],
            attack: 0.1,
            release: 0.6,
            curve: 'smooth',
        }],
        deactivationPolicy: 'drain',

        create(context): VisualPluginInstance {
            const vertices = new Float32Array(MAX_PROJECTILES * 3);
            /** Position and velocity per projectile, for the pass that publishes the wake. */
            const motion = new Float32Array(MAX_PROJECTILES * 4);
            let projectiles: Projectile[] = [];
            let count = 0;
            let emitting = true;

            return {
                initialize() {
                    context.registerShader({
                        id: CASCADE_SHADER,
                        vertex: CASCADE_VERTEX,
                        fragment: CASCADE_FRAGMENT,
                    });
                    context.registerShader({
                        id: CASCADE_MOTION_SHADER,
                        vertex: CASCADE_MOTION_VERTEX,
                        fragment: CASCADE_MOTION_FRAGMENT,
                    });
                    context.registerShader(decayShaderSource('ImpactCascadeSimulator'));
                },

                activate() {
                    projectiles = seedCascade(mode, context.seed, STREAM_COUNT);
                    emitting = true;
                },

                update(frame) {
                    const result = advanceCascade(
                        mode,
                        projectiles,
                        frame.deltaSeconds,
                        frame.clock.playbackTime,
                        frame.parameters.energyScale ?? 1,
                    );

                    projectiles = result.projectiles;

                    // Publishing rather than handling internally is what lets shockwaves, wave impulses,
                    // and glyphs elsewhere in the scene respond to the same collision.
                    if (result.impacts.length > 0) {
                        frame.publishImpacts(result.impacts);
                    }

                    // Replenished so the cascade continues, unless draining.
                    if (emitting && projectiles.filter((entry) => !entry.fragment).length < STREAM_COUNT / 3) {
                        projectiles = [...projectiles, ...seedCascade(mode, context.seed + frame.clock.playbackTime, STREAM_COUNT)];
                    }

                    count = 0;
                    for (const projectile of projectiles) {
                        if (count >= MAX_PROJECTILES) {
                            break;
                        }

                        const offset = count * 3;
                        vertices[offset] = projectile.x;
                        vertices[offset + 1] = projectile.y;
                        vertices[offset + 2] = projectile.fragment
                            ? projectile.energy * Math.max(0, 1 - projectile.age / FRAGMENT_LIFETIME)
                            : projectile.energy * 0.5;

                        const motionOffset = count * 4;
                        motion[motionOffset] = projectile.x;
                        motion[motionOffset + 1] = projectile.y;
                        motion[motionOffset + 2] = projectile.vx;
                        motion[motionOffset + 3] = projectile.vy;
                        count += 1;
                    }

                    frame.uploadGeometry({
                        id: CASCADE_GEOMETRY,
                        data: vertices.subarray(0, count * 3),
                        attributes: [
                            { name: 'aPosition', components: 2 },
                            { name: 'aEnergy', components: 1 },
                        ],
                    });

                    frame.uploadGeometry({
                        id: CASCADE_MOTION_GEOMETRY,
                        data: motion.subarray(0, count * 4),
                        attributes: [
                            { name: 'aPosition', components: 2 },
                            { name: 'aVelocity', components: 2 },
                        ],
                    });
                },

                render(render): RenderPass[] {
                    if (count === 0) {
                        return [];
                    }

                    const passes: RenderPass[] = [];

                    if (render.outputs.color) {
                        passes.push(decayPass('ImpactCascadeSimulator', render.outputs.color));
                    }

                    passes.push({
                        kind: 'geometry',
                        shader: CASCADE_SHADER,
                        geometry: CASCADE_GEOMETRY,
                        inputs: render.inputs.field ? { uField: render.inputs.field } : {},
                        primitive: 'points',
                        vertexCount: count,
                        output: render.outputs.color,
                        // A cascade is a handful of fragments a frame. Drawn into a cleared target it
                        // is a scatter of dots; drawn over a decayed one it is the path they took.
                        blend: 'lighten',
                        clear: false,
                        uniforms: { uPointSize: 3.5, uBrightness: 1.4, uPerturb: 0.12 },
                    });

                    if (render.outputs.motion) {
                        passes.push({
                            kind: 'geometry',
                            shader: CASCADE_MOTION_SHADER,
                            geometry: CASCADE_MOTION_GEOMETRY,
                            primitive: 'points',
                            vertexCount: count,
                            output: render.outputs.motion,
                            // Projectiles crossing drag together where they agree and cancel where
                            // they do not, which is what a collision looks like as a field.
                            blend: 'add',
                            clear: true,
                            uniforms: { uReach: 18 },
                        });
                    }

                    return passes;
                },

                deactivate(deactivation) {
                    // Draining stops replenishment while existing fragments finish their lifetime.
                    emitting = deactivation.policy !== 'drain';
                },

                destroy() {
                    projectiles = [];
                    count = 0;
                },
            };
        },
    };
}
