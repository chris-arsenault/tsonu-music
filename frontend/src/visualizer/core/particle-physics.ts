/**
 * Authoritative two-dimensional particle physics.
 *
 * The world is measured in render pixels with its origin at the centre of the viewport. A radius is
 * therefore the same physical and visible size on every aspect ratio. Rendering is only a projection
 * of this state; it never invents particle geometry.
 */

export interface ParticleWorld {
    readonly capacity: number;
    width: number;
    height: number;
    readonly positions: Float32Array;
    readonly previousPositions: Float32Array;
    readonly velocities: Float32Array;
    readonly radii: Float32Array;
    readonly inverseMasses: Float32Array;
    readonly elasticities: Float32Array;
    readonly frictions: Float32Array;
    readonly ages: Float32Array;
    readonly lifetimes: Float32Array;
    /** Interleaved RGB in linear zero-to-one values. */
    readonly colors: Float32Array;
    readonly emitterIds: Int32Array;
    readonly active: Uint8Array;
}

export interface ParticleSpawn {
    position: readonly [number, number];
    velocity: readonly [number, number];
    radius: number;
    mass: number;
    elasticity: number;
    friction: number;
    lifetime: number;
    color: readonly [number, number, number];
    emitterId: number;
}

export type ParticleForce =
    | {
        kind: 'uniform';
        acceleration: readonly [number, number];
    }
    | {
        kind: 'well';
        position: readonly [number, number];
        radius: number;
        strength: number;
        repel: boolean;
    }
    | {
        kind: 'vortex';
        position: readonly [number, number];
        radius: number;
        tangentialStrength: number;
        inwardStrength: number;
    }
    | {
        kind: 'field';
        strength: number;
        sample(x: number, y: number, out: [number, number]): void;
    };

export interface StaticMaterial {
    elasticity: number;
    friction: number;
}

export type ParticleCollider =
    | ({
        kind: 'frame';
    } & StaticMaterial)
    | ({
        kind: 'segment';
        start: readonly [number, number];
        end: readonly [number, number];
    } & StaticMaterial)
    | ({
        kind: 'circle';
        position: readonly [number, number];
        radius: number;
    } & StaticMaterial)
    | ({
        kind: 'mask';
        width: number;
        height: number;
        data: Float32Array;
        containInside: boolean;
    } & StaticMaterial);

export interface ParticleStepOptions {
    deltaSeconds: number;
    drag: number;
    iterations: number;
    forces: readonly ParticleForce[];
    colliders: readonly ParticleCollider[];
}

export function createParticleWorld(capacity: number): ParticleWorld {
    return {
        capacity,
        width: 1,
        height: 1,
        positions: new Float32Array(capacity * 2),
        previousPositions: new Float32Array(capacity * 2),
        velocities: new Float32Array(capacity * 2),
        radii: new Float32Array(capacity),
        inverseMasses: new Float32Array(capacity),
        elasticities: new Float32Array(capacity),
        frictions: new Float32Array(capacity),
        ages: new Float32Array(capacity),
        lifetimes: new Float32Array(capacity),
        colors: new Float32Array(capacity * 3),
        emitterIds: new Int32Array(capacity).fill(-1),
        active: new Uint8Array(capacity),
    };
}

export function resetParticleWorld(world: ParticleWorld): void {
    world.positions.fill(0);
    world.previousPositions.fill(0);
    world.velocities.fill(0);
    world.radii.fill(0);
    world.inverseMasses.fill(0);
    world.elasticities.fill(0);
    world.frictions.fill(0);
    world.ages.fill(0);
    world.lifetimes.fill(0);
    world.colors.fill(0);
    world.emitterIds.fill(-1);
    world.active.fill(0);
}

export function activeParticleCount(world: ParticleWorld): number {
    let count = 0;
    for (let index = 0; index < world.capacity; index += 1) {
        count += world.active[index] ? 1 : 0;
    }
    return count;
}

/** Adds a body to the first free slot. Returns its slot, or -1 when the world is full. */
export function emitParticle(world: ParticleWorld, spawn: ParticleSpawn): number {
    const index = world.active.indexOf(0);
    if (index < 0) {
        return -1;
    }

    const vector = index * 2;
    const color = index * 3;
    world.active[index] = 1;
    world.positions[vector] = spawn.position[0];
    world.positions[vector + 1] = spawn.position[1];
    world.previousPositions[vector] = spawn.position[0];
    world.previousPositions[vector + 1] = spawn.position[1];
    world.velocities[vector] = spawn.velocity[0];
    world.velocities[vector + 1] = spawn.velocity[1];
    world.radii[index] = Math.max(0.5, spawn.radius);
    world.inverseMasses[index] = 1 / Math.max(1e-6, spawn.mass);
    world.elasticities[index] = clamp01(spawn.elasticity);
    world.frictions[index] = clamp01(spawn.friction);
    world.ages[index] = 0;
    world.lifetimes[index] = Math.max(1e-3, spawn.lifetime);
    world.colors[color] = clamp01(spawn.color[0]);
    world.colors[color + 1] = clamp01(spawn.color[1]);
    world.colors[color + 2] = clamp01(spawn.color[2]);
    world.emitterIds[index] = spawn.emitterId;
    return index;
}

/** Advances one fixed physics step. The caller owns the fixed-step accumulator. */
export function stepParticles(world: ParticleWorld, options: ParticleStepOptions): void {
    const dt = options.deltaSeconds;
    if (!(dt > 0)) {
        return;
    }

    const acceleration: [number, number] = [0, 0];
    const damping = Math.exp(-Math.max(0, options.drag) * dt);

    for (let index = 0; index < world.capacity; index += 1) {
        if (!world.active[index]) {
            continue;
        }

        world.ages[index] += dt;
        if (world.ages[index] >= world.lifetimes[index]) {
            world.active[index] = 0;
            continue;
        }

        const vector = index * 2;
        world.previousPositions[vector] = world.positions[vector];
        world.previousPositions[vector + 1] = world.positions[vector + 1];

        acceleration[0] = 0;
        acceleration[1] = 0;
        applyForces(world, index, options.forces, acceleration);

        world.velocities[vector] = (world.velocities[vector] + acceleration[0] * dt) * damping;
        world.velocities[vector + 1] = (world.velocities[vector + 1] + acceleration[1] * dt) * damping;
        world.positions[vector] += world.velocities[vector] * dt;
        world.positions[vector + 1] += world.velocities[vector + 1] * dt;
    }

    const iterations = Math.max(1, Math.round(options.iterations));
    for (let pass = 0; pass < iterations; pass += 1) {
        resolveStaticColliders(world, options.colliders);
        resolveParticleContacts(world);
    }
}

function applyForces(
    world: ParticleWorld,
    index: number,
    forces: readonly ParticleForce[],
    out: [number, number],
): void {
    const vector = index * 2;
    const x = world.positions[vector];
    const y = world.positions[vector + 1];
    const sampled: [number, number] = [0, 0];

    for (const force of forces) {
        if (force.kind === 'uniform') {
            out[0] += force.acceleration[0];
            out[1] += force.acceleration[1];
            continue;
        }

        if (force.kind === 'field') {
            force.sample(x, y, sampled);
            out[0] += sampled[0] * force.strength;
            out[1] += sampled[1] * force.strength;
            continue;
        }

        const dx = force.position[0] - x;
        const dy = force.position[1] - y;
        const distance = Math.hypot(dx, dy);
        if (!(distance > 1e-6) || distance >= force.radius) {
            continue;
        }

        const normalX = dx / distance;
        const normalY = dy / distance;
        const falloff = 1 - distance / Math.max(1e-6, force.radius);

        if (force.kind === 'well') {
            const direction = force.repel ? -1 : 1;
            const magnitude = force.strength * falloff * direction;
            out[0] += normalX * magnitude;
            out[1] += normalY * magnitude;
        } else {
            const tangential = force.tangentialStrength * falloff;
            const inward = force.inwardStrength * falloff;
            out[0] += -normalY * tangential + normalX * inward;
            out[1] += normalX * tangential + normalY * inward;
        }
    }
}

function resolveStaticColliders(world: ParticleWorld, colliders: readonly ParticleCollider[]): void {
    for (let index = 0; index < world.capacity; index += 1) {
        if (!world.active[index]) {
            continue;
        }

        for (const collider of colliders) {
            if (collider.kind === 'frame') {
                resolveFrame(world, index, collider);
            } else if (collider.kind === 'segment') {
                resolveSegment(world, index, collider);
            } else if (collider.kind === 'circle') {
                resolveCircleCollider(world, index, collider);
            } else {
                resolveMask(world, index, collider);
            }
        }
    }
}

function resolveFrame(
    world: ParticleWorld,
    index: number,
    material: StaticMaterial,
): void {
    const vector = index * 2;
    const radius = world.radii[index];
    const halfWidth = Math.max(0, world.width * 0.5 - radius);
    const halfHeight = Math.max(0, world.height * 0.5 - radius);
    const x = world.positions[vector];
    const y = world.positions[vector + 1];

    if (x < -halfWidth) {
        resolveStaticContact(world, index, 1, 0, -halfWidth - x, material);
    } else if (x > halfWidth) {
        resolveStaticContact(world, index, -1, 0, x - halfWidth, material);
    }

    if (y < -halfHeight) {
        resolveStaticContact(world, index, 0, 1, -halfHeight - y, material);
    } else if (y > halfHeight) {
        resolveStaticContact(world, index, 0, -1, y - halfHeight, material);
    }
}

function resolveSegment(
    world: ParticleWorld,
    index: number,
    collider: Extract<ParticleCollider, { kind: 'segment' }>,
): void {
    const vector = index * 2;
    const x = world.positions[vector];
    const y = world.positions[vector + 1];
    const ax = collider.start[0];
    const ay = collider.start[1];
    const bx = collider.end[0];
    const by = collider.end[1];
    const segmentX = bx - ax;
    const segmentY = by - ay;
    const lengthSquared = segmentX * segmentX + segmentY * segmentY;
    const along = lengthSquared > 1e-8
        ? clamp01(((x - ax) * segmentX + (y - ay) * segmentY) / lengthSquared)
        : 0;
    const closestX = ax + segmentX * along;
    const closestY = ay + segmentY * along;
    let normalX = x - closestX;
    let normalY = y - closestY;
    let distance = Math.hypot(normalX, normalY);
    const radius = world.radii[index];

    if (distance >= radius) {
        return;
    }

    if (distance < 1e-6) {
        const inverseLength = 1 / Math.max(1e-6, Math.hypot(segmentX, segmentY));
        normalX = -segmentY * inverseLength;
        normalY = segmentX * inverseLength;
        const into = world.velocities[vector] * normalX + world.velocities[vector + 1] * normalY;
        if (into > 0) {
            normalX = -normalX;
            normalY = -normalY;
        }
        distance = 0;
    } else {
        normalX /= distance;
        normalY /= distance;
    }

    resolveStaticContact(world, index, normalX, normalY, radius - distance, collider);
}

function resolveCircleCollider(
    world: ParticleWorld,
    index: number,
    collider: Extract<ParticleCollider, { kind: 'circle' }>,
): void {
    const vector = index * 2;
    let normalX = world.positions[vector] - collider.position[0];
    let normalY = world.positions[vector + 1] - collider.position[1];
    let distance = Math.hypot(normalX, normalY);
    const required = world.radii[index] + Math.max(0, collider.radius);

    if (distance >= required) {
        return;
    }

    if (distance < 1e-6) {
        normalX = 1;
        normalY = 0;
        distance = 0;
    } else {
        normalX /= distance;
        normalY /= distance;
    }

    resolveStaticContact(world, index, normalX, normalY, required - distance, collider);
}

function resolveMask(
    world: ParticleWorld,
    index: number,
    collider: Extract<ParticleCollider, { kind: 'mask' }>,
): void {
    if (collider.width < 2 || collider.height < 2) {
        return;
    }

    const vector = index * 2;
    const x = world.positions[vector];
    const y = world.positions[vector + 1];
    const distance = sampleMaskDistance(world, collider, x, y);
    const radius = world.radii[index];
    const penetration = collider.containInside ? distance + radius : radius - distance;
    if (!(penetration > 0)) {
        return;
    }

    const pixelX = world.width / collider.width;
    const pixelY = world.height / collider.height;
    const gradientX = sampleMaskDistance(world, collider, x + pixelX, y)
        - sampleMaskDistance(world, collider, x - pixelX, y);
    const gradientY = sampleMaskDistance(world, collider, x, y + pixelY)
        - sampleMaskDistance(world, collider, x, y - pixelY);
    const length = Math.hypot(gradientX, gradientY);
    if (length < 1e-6) {
        return;
    }

    const direction = collider.containInside ? -1 : 1;
    resolveStaticContact(
        world,
        index,
        gradientX / length * direction,
        gradientY / length * direction,
        penetration,
        collider,
    );
}

function sampleMaskDistance(
    world: ParticleWorld,
    collider: Extract<ParticleCollider, { kind: 'mask' }>,
    x: number,
    y: number,
): number {
    const u = clamp((x / world.width + 0.5) * (collider.width - 1), 0, collider.width - 1.001);
    const v = clamp((y / world.height + 0.5) * (collider.height - 1), 0, collider.height - 1.001);
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    const at = (sampleX: number, sampleY: number) =>
        collider.data[(sampleY * collider.width + sampleX) * 4];
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    const normalized = top * (1 - fy) + bottom * fy;
    return normalized * Math.min(world.width, world.height);
}

function resolveStaticContact(
    world: ParticleWorld,
    index: number,
    normalX: number,
    normalY: number,
    penetration: number,
    material: StaticMaterial,
): void {
    if (!(penetration > 0)) {
        return;
    }

    const vector = index * 2;
    world.positions[vector] += normalX * penetration;
    world.positions[vector + 1] += normalY * penetration;
    const into = world.velocities[vector] * normalX + world.velocities[vector + 1] * normalY;
    if (into >= 0) {
        return;
    }

    const elasticity = world.elasticities[index] * clamp01(material.elasticity);
    world.velocities[vector] -= (1 + elasticity) * into * normalX;
    world.velocities[vector + 1] -= (1 + elasticity) * into * normalY;

    const tangentX = -normalY;
    const tangentY = normalX;
    const tangentSpeed = world.velocities[vector] * tangentX + world.velocities[vector + 1] * tangentY;
    const friction = world.frictions[index] * clamp01(material.friction);
    world.velocities[vector] -= tangentSpeed * friction * tangentX;
    world.velocities[vector + 1] -= tangentSpeed * friction * tangentY;
}

function resolveParticleContacts(world: ParticleWorld): void {
    let maximumRadius = 0;
    for (let index = 0; index < world.capacity; index += 1) {
        if (world.active[index]) {
            maximumRadius = Math.max(maximumRadius, world.radii[index]);
        }
    }
    if (!(maximumRadius > 0)) {
        return;
    }

    const cellSize = maximumRadius * 2;
    const columns = Math.max(1, Math.ceil(world.width / cellSize));
    const rows = Math.max(1, Math.ceil(world.height / cellSize));
    const cells = new Map<number, number[]>();

    for (let index = 0; index < world.capacity; index += 1) {
        if (!world.active[index]) {
            continue;
        }
        const vector = index * 2;
        const column = clamp(
            Math.floor((world.positions[vector] + world.width * 0.5) / cellSize),
            0,
            columns - 1,
        );
        const row = clamp(
            Math.floor((world.positions[vector + 1] + world.height * 0.5) / cellSize),
            0,
            rows - 1,
        );
        const key = row * columns + column;
        const members = cells.get(key);
        if (members) {
            members.push(index);
        } else {
            cells.set(key, [index]);
        }
    }

    for (const [key, members] of cells) {
        const row = Math.floor(key / columns);
        const column = key % columns;
        for (const a of members) {
            for (let y = Math.max(0, row - 1); y <= Math.min(rows - 1, row + 1); y += 1) {
                for (let x = Math.max(0, column - 1); x <= Math.min(columns - 1, column + 1); x += 1) {
                    for (const b of cells.get(y * columns + x) ?? []) {
                        if (b <= a) {
                            continue;
                        }
                        resolveParticlePair(world, a, b);
                    }
                }
            }
        }
    }
}

function resolveParticlePair(world: ParticleWorld, a: number, b: number): void {
    const av = a * 2;
    const bv = b * 2;
    let normalX = world.positions[bv] - world.positions[av];
    let normalY = world.positions[bv + 1] - world.positions[av + 1];
    let distance = Math.hypot(normalX, normalY);
    const required = world.radii[a] + world.radii[b];
    if (distance >= required) {
        return;
    }

    if (distance < 1e-6) {
        const angle = ((a + 1) * 2.399963) % (Math.PI * 2);
        normalX = Math.cos(angle);
        normalY = Math.sin(angle);
        distance = 0;
    } else {
        normalX /= distance;
        normalY /= distance;
    }

    const inverseA = world.inverseMasses[a];
    const inverseB = world.inverseMasses[b];
    const inverseTotal = inverseA + inverseB;
    if (!(inverseTotal > 0)) {
        return;
    }

    const penetration = required - distance;
    const correction = Math.max(0, penetration - 0.01) * 0.9 / inverseTotal;
    world.positions[av] -= normalX * correction * inverseA;
    world.positions[av + 1] -= normalY * correction * inverseA;
    world.positions[bv] += normalX * correction * inverseB;
    world.positions[bv + 1] += normalY * correction * inverseB;

    const relativeX = world.velocities[bv] - world.velocities[av];
    const relativeY = world.velocities[bv + 1] - world.velocities[av + 1];
    const closing = relativeX * normalX + relativeY * normalY;
    if (closing >= 0) {
        return;
    }

    const elasticity = world.elasticities[a] * world.elasticities[b];
    const impulse = -(1 + elasticity) * closing / inverseTotal;
    world.velocities[av] -= impulse * inverseA * normalX;
    world.velocities[av + 1] -= impulse * inverseA * normalY;
    world.velocities[bv] += impulse * inverseB * normalX;
    world.velocities[bv + 1] += impulse * inverseB * normalY;

    const tangentX = relativeX - closing * normalX;
    const tangentY = relativeY - closing * normalY;
    const tangentLength = Math.hypot(tangentX, tangentY);
    if (tangentLength < 1e-6) {
        return;
    }

    const unitTangentX = tangentX / tangentLength;
    const unitTangentY = tangentY / tangentLength;
    const tangentSpeed = relativeX * unitTangentX + relativeY * unitTangentY;
    const friction = Math.sqrt(world.frictions[a] * world.frictions[b]);
    const frictionImpulse = clamp(-tangentSpeed / inverseTotal, -impulse * friction, impulse * friction);
    world.velocities[av] -= frictionImpulse * inverseA * unitTangentX;
    world.velocities[av + 1] -= frictionImpulse * inverseA * unitTangentY;
    world.velocities[bv] += frictionImpulse * inverseB * unitTangentX;
    world.velocities[bv + 1] += frictionImpulse * inverseB * unitTangentY;
}

/** Fraction of active particles overlapping any other particle beyond a small numerical tolerance. */
export function overlapFraction(world: ParticleWorld, tolerance = 0.99): number {
    let overlapping = 0;
    let active = 0;

    for (let a = 0; a < world.capacity; a += 1) {
        if (!world.active[a]) {
            continue;
        }
        active += 1;
        let touches = false;
        for (let b = 0; b < world.capacity; b += 1) {
            if (a === b || !world.active[b]) {
                continue;
            }
            const distance = Math.hypot(
                world.positions[a * 2] - world.positions[b * 2],
                world.positions[a * 2 + 1] - world.positions[b * 2 + 1],
            );
            if (distance < (world.radii[a] + world.radii[b]) * tolerance) {
                touches = true;
                break;
            }
        }
        overlapping += touches ? 1 : 0;
    }

    return active > 0 ? overlapping / active : 0;
}

function clamp01(value: number): number {
    return clamp(value, 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}
