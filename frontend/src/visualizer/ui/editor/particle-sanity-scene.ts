import {
    AUTHORED_SCENE_VERSION,
    edgeIdFor,
    type AuthoredScene,
} from '../../core/authored-scene';

const EMITTER = 'ParticleEmitter:point#0';
const FORCE = 'ParticleForceField:attract#0';
const FRAME = 'ParticleCollider:frame#0';
const OBSTACLE = 'ParticleCollider:circle#0';
const SIMULATOR = 'ParticleSimulator#0';
const RENDERER = 'ParticleRenderer:discs#0';

/**
 * A deliberately plain Lab scene for checking particle physics.
 *
 * Every influence is authored in the graph, all music bindings are disabled, and the renderer's
 * debug overlay exposes the physical circle radii, emitter, frame, obstacle, and force extent.
 */
export function particleSanityScene(): AuthoredScene {
    return {
        version: AUTHORED_SCENE_VERSION,
        entropy: 'lab:particle-sanity',
        nodes: [
            {
                id: EMITTER,
                pluginId: 'ParticleEmitter:point',
                position: { x: -520, y: -120 },
                parameters: {
                    originX: -240,
                    originY: 0,
                    emissionRadius: 0,
                    direction: 0,
                    spread: 6,
                    speed: 180,
                    radius: 8,
                    radiusJitter: 0,
                    rate: 18,
                    mass: 1,
                    elasticity: 0.92,
                    friction: 0.05,
                    lifetime: 8,
                    colorR: 1,
                    colorG: 1,
                    colorB: 1,
                },
                bindings: [],
            },
            {
                id: FORCE,
                pluginId: 'ParticleForceField:attract',
                position: { x: -520, y: 120 },
                parameters: {
                    x: 100,
                    y: 40,
                    radius: 180,
                    strength: 900,
                },
                bindings: [],
            },
            {
                id: FRAME,
                pluginId: 'ParticleCollider:frame',
                position: { x: -190, y: 230 },
                parameters: {
                    elasticity: 0.92,
                    friction: 0.05,
                },
                bindings: [],
            },
            {
                id: OBSTACLE,
                pluginId: 'ParticleCollider:circle',
                position: { x: 100, y: 230 },
                parameters: {
                    x: 110,
                    y: -70,
                    radius: 65,
                    elasticity: 0.92,
                    friction: 0.05,
                },
                bindings: [],
            },
            {
                id: SIMULATOR,
                pluginId: 'ParticleSimulator',
                position: { x: -80, y: -80 },
                parameters: {
                    particleCount: 512,
                    drag: 0,
                    collisionIterations: 4,
                },
                bindings: [],
            },
            {
                id: RENDERER,
                pluginId: 'ParticleRenderer:discs',
                position: { x: 280, y: -80 },
                parameters: {
                    brightness: 1,
                    debug: 1,
                },
                bindings: [],
            },
        ],
        edges: [
            edge(EMITTER, 'emitters', SIMULATOR, 'emitters'),
            edge(FORCE, 'forces', SIMULATOR, 'forces'),
            edge(FRAME, 'colliders', OBSTACLE, 'previous'),
            edge(OBSTACLE, 'colliders', SIMULATOR, 'colliders'),
            edge(SIMULATOR, 'state', RENDERER, 'state'),
        ],
        assetBindings: [],
        present: { node: RENDERER, port: 'color' },
        kernel: {
            compositeInputs: [`${RENDERER}.color`],
            grade: { bindings: [] },
            // The accumulation used to be pinned to zero here, so the sanity scene showed the bodies
            // the simulator produced this frame and nothing else. There is no accumulation to pin
            // (ADR-0013), and the scene contains no loop, so it is already what it was asking for.
            palette: { id: 'monochrome-noir', strength: 0 },
        },
    };
}

function edge(
    fromNode: string,
    fromPort: string,
    toNode: string,
    toPort: string,
) {
    const from = { node: fromNode, port: fromPort };
    const to = { node: toNode, port: toPort };
    return { id: edgeIdFor(from, to), from, to };
}
