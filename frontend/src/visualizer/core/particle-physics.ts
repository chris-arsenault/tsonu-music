/**
 * Particle physics on the CPU: a uniform grid broad phase and sequential contact resolution.
 *
 * This replaces a fragment-shader simulation. The shader version was not slow, it was structurally
 * unable to do the job, for two reasons that no amount of tuning reaches:
 *
 * A texel is four floats, and four floats is one particle. A grid cell backed by a texel therefore
 * holds exactly one body, so in any genuine pile every contact but one is invisible — and a pile is
 * precisely where contact matters. Here a cell holds a list.
 *
 * A fragment shader can only write to its own texel. There is no way to push the other body, so an
 * impulse cannot be equal and opposite: each particle has to independently rediscover the same
 * contact and hope the two halves agree. Resolution is Jacobi by construction, all bodies moving
 * against a frozen snapshot, and in a dense clump the corrections cancel. Here a contact is resolved
 * once, both bodies move, and the next pair sees the result — Gauss-Seidel, which converges.
 *
 * At four thousand bodies this costs a few tens of thousands of distance checks a frame, which is
 * well under a millisecond in typed arrays. The GPU was never the reason to do it there; the state
 * living in a texture was, and that is a choice rather than a constraint.
 */

/** Half-extent of the simulated square, matching clip space. */
export const BOUNDS = 1;

export interface ParticleWorld {
    readonly count: number;
    /** Interleaved x, y per particle. */
    readonly positions: Float32Array;
    /** Interleaved x, y per particle. */
    readonly velocities: Float32Array;
    /** Seconds each body has been alive, so births can be staggered rather than synchronised. */
    readonly ages: Float32Array;
}

export interface ParticleStepOptions {
    deltaSeconds: number;
    /** Contact radius in clip units. Two touching bodies are two radii apart. */
    radius: number;
    /** Share of closing speed returned on contact. Zero is clay, one is billiards. */
    restitution: number;
    /** Velocity lost per second, as a fraction. */
    drag: number;
    /** Seconds a body lives before it is reborn. */
    lifetimeSeconds: number;
    /** Relaxation passes over the contact set. More passes resolve deeper pile-ups. */
    iterations: number;
    /** Acceleration at a point, written into `out`. */
    force(x: number, y: number, out: [number, number]): void;
    /** Where body `index` is born, written into `out`. */
    spawn(index: number, out: [number, number]): void;
    /**
     * Surface test: returns penetration depth at a point and writes the outward normal.
     *
     * Zero or less means clear of every surface. This is how a mask becomes something solid rather
     * than something particles are nudged by.
     */
    surface?(x: number, y: number, out: [number, number]): number;
}

export function createParticleWorld(count: number): ParticleWorld {
    return {
        count,
        positions: new Float32Array(count * 2),
        velocities: new Float32Array(count * 2),
        ages: new Float32Array(count),
    };
}

/**
 * Scratch buffers for the broad phase, reused across frames.
 *
 * Held outside the world because they are a detail of how contacts are found, and rebuilt whenever
 * the grid resolution changes with the contact radius.
 */
interface Grid {
    side: number;
    cellSize: number;
    /** Running offset per cell, length side*side + 1. */
    starts: Int32Array;
    /** Particle indices ordered by cell. */
    items: Int32Array;
    counts: Int32Array;
}

let grid: Grid | undefined;

function gridFor(cellSize: number, count: number): Grid {
    const side = Math.max(1, Math.ceil((BOUNDS * 2) / cellSize));

    if (!grid || grid.side !== side || grid.items.length !== count) {
        grid = {
            side,
            cellSize,
            starts: new Int32Array(side * side + 1),
            items: new Int32Array(count),
            counts: new Int32Array(side * side),
        };
    }

    grid.cellSize = cellSize;
    return grid;
}

/**
 * Bins every body by cell, as a counting sort.
 *
 * Two passes and no allocation: count per cell, prefix-sum into starts, then place. The result is
 * every cell's members contiguous in `items`, which is what makes the neighbour walk a pair of array
 * reads rather than a hash lookup.
 */
function build(world: ParticleWorld, g: Grid): void {
    const cells = g.side * g.side;
    g.counts.fill(0);

    const cellOf = (index: number): number => {
        const x = Math.min(g.side - 1, Math.max(0, Math.floor((world.positions[index * 2] + BOUNDS) / g.cellSize)));
        const y = Math.min(g.side - 1, Math.max(0, Math.floor((world.positions[index * 2 + 1] + BOUNDS) / g.cellSize)));
        return y * g.side + x;
    };

    for (let i = 0; i < world.count; i += 1) {
        g.counts[cellOf(i)] += 1;
    }

    let running = 0;
    for (let cell = 0; cell < cells; cell += 1) {
        g.starts[cell] = running;
        running += g.counts[cell];
    }
    g.starts[cells] = running;

    const cursor = g.counts;
    for (let cell = 0; cell < cells; cell += 1) {
        cursor[cell] = g.starts[cell];
    }

    for (let i = 0; i < world.count; i += 1) {
        const cell = cellOf(i);
        g.items[cursor[cell]] = i;
        cursor[cell] += 1;
    }
}

/**
 * Advances the world one step: forces, integration, births, surfaces, then contacts.
 *
 * Contacts last, because a contact correction is only meaningful against final positions — resolving
 * before integration leaves bodies overlapping by exactly the distance they were about to travel.
 */
export function stepParticles(world: ParticleWorld, options: ParticleStepOptions): void {
    const {
        deltaSeconds: dt, radius, restitution, drag, lifetimeSeconds, iterations,
        force, spawn, surface,
    } = options;

    if (dt <= 0) {
        return;
    }

    const { positions, velocities, ages, count } = world;
    const accel: [number, number] = [0, 0];
    const born: [number, number] = [0, 0];
    const normal: [number, number] = [0, 0];
    const diameter = radius * 2;

    for (let i = 0; i < count; i += 1) {
        const px = i * 2;
        const py = px + 1;

        ages[i] += dt;

        // Birth: on age, on leaving the frame, or on a body that has never been placed.
        const escaped = Math.abs(positions[px]) > BOUNDS * 1.05 || Math.abs(positions[py]) > BOUNDS * 1.05;
        if (ages[i] >= lifetimeSeconds || escaped || (positions[px] === 0 && positions[py] === 0 && velocities[px] === 0)) {
            spawn(i, born);
            positions[px] = born[0];
            positions[py] = born[1];
            // Staggered rather than reset to zero, so the field turns over continuously instead of
            // every body reaching the end of its life on the same frame.
            ages[i] = (i / count) * lifetimeSeconds * 0.5;
            velocities[px] = 0;
            velocities[py] = 0;
        }

        force(positions[px], positions[py], accel);
        velocities[px] = (velocities[px] + accel[0] * dt) * Math.max(0, 1 - drag * dt);
        velocities[py] = (velocities[py] + accel[1] * dt) * Math.max(0, 1 - drag * dt);

        positions[px] += velocities[px] * dt;
        positions[py] += velocities[py] * dt;
    }

    // Surfaces before contacts, so a body pressed into a wall by its neighbours is pushed out and the
    // pile then settles against a surface that has already stopped moving.
    if (surface) {
        for (let i = 0; i < count; i += 1) {
            const px = i * 2;
            const py = px + 1;
            const depth = surface(positions[px], positions[py], normal);
            if (depth <= 0) {
                continue;
            }

            positions[px] += normal[0] * depth;
            positions[py] += normal[1] * depth;

            const into = velocities[px] * normal[0] + velocities[py] * normal[1];
            if (into < 0) {
                velocities[px] -= (1 + restitution) * into * normal[0];
                velocities[py] -= (1 + restitution) * into * normal[1];
            }
        }
    }

    const g = gridFor(diameter, count);

    for (let pass = 0; pass < iterations; pass += 1) {
        // Rebuilt each pass: resolution moves bodies, and a stale grid sends a body that has just
        // crossed a boundary to look for neighbours where it no longer is.
        build(world, g);
        resolveContacts(world, g, radius, restitution);
    }
}

/**
 * One relaxation pass over every contacting pair.
 *
 * Each pair is visited once, from the lower index, and both bodies move — which is the whole reason
 * this is on the CPU. Positions are corrected immediately rather than accumulated, so a body already
 * pushed by an earlier pair is seen in its new place by the next one.
 */
function resolveContacts(
    world: ParticleWorld,
    g: Grid,
    radius: number,
    restitution: number,
): void {
    const { positions, velocities } = world;
    const diameter = radius * 2;

    for (let cellY = 0; cellY < g.side; cellY += 1) {
        for (let cellX = 0; cellX < g.side; cellX += 1) {
            const cell = cellY * g.side + cellX;

            for (let slot = g.starts[cell]; slot < g.starts[cell + 1]; slot += 1) {
                const a = g.items[slot];
                const ax = a * 2;
                const ay = ax + 1;

                // The cell itself and the eight around it. A body can only reach one diameter, and a
                // cell is one diameter across, so nothing outside this can be touching.
                for (let dy = -1; dy <= 1; dy += 1) {
                    const ny = cellY + dy;
                    if (ny < 0 || ny >= g.side) {
                        continue;
                    }

                    for (let dx = -1; dx <= 1; dx += 1) {
                        const nx = cellX + dx;
                        if (nx < 0 || nx >= g.side) {
                            continue;
                        }

                        const neighbour = ny * g.side + nx;
                        for (let other = g.starts[neighbour]; other < g.starts[neighbour + 1]; other += 1) {
                            const b = g.items[other];
                            // Once per pair, not once per body per pair.
                            if (b <= a) {
                                continue;
                            }

                            const bx = b * 2;
                            const by = bx + 1;
                            let sx = positions[ax] - positions[bx];
                            let sy = positions[ay] - positions[by];

                            // Rejected on the squared distance, and the root taken only for the few
                            // pairs that actually touch. Most candidates in the neighbourhood are not
                            // in contact, and `Math.hypot` — which guards against intermediate
                            // overflow nobody here can reach — costs enough at a quarter of a million
                            // calls a frame to dominate the whole step.
                            const squared = sx * sx + sy * sy;
                            if (squared >= diameter * diameter) {
                                continue;
                            }

                            let gap = Math.sqrt(squared);

                            // Exactly coincident bodies have no separating direction to compute, so
                            // one is derived from their indices — deterministic, and never zero.
                            if (gap < 1e-7) {
                                const angle = (a * 2.399963) % (Math.PI * 2);
                                sx = Math.cos(angle);
                                sy = Math.sin(angle);
                                gap = 1e-7;
                            }

                            const inverse = 1 / gap;
                            const normalX = sx * inverse;
                            const normalY = sy * inverse;
                            const half = (diameter - gap) * 0.5;

                            positions[ax] += normalX * half;
                            positions[ay] += normalY * half;
                            positions[bx] -= normalX * half;
                            positions[by] -= normalY * half;

                            // The separation is also motion: leaving velocity alone makes the
                            // correction transient, and whatever pushed the pair together simply
                            // pushes them back next frame.
                            const closing = (velocities[ax] - velocities[bx]) * normalX
                                + (velocities[ay] - velocities[by]) * normalY;

                            // Only a pair that is closing gets an impulse. Adding a separating term to
                            // pairs already moving apart looks like it helps a pile relax and is an
                            // energy pump: every resting contact in a settled pack fires it, every
                            // frame, so the pack can never come to rest. The positional correction
                            // above is what resolves a resting contact, and it needs no help.
                            if (closing < 0) {
                                const impulse = -closing * (1 + restitution) * 0.5;
                                velocities[ax] += normalX * impulse;
                                velocities[ay] += normalY * impulse;
                                velocities[bx] -= normalX * impulse;
                                velocities[by] -= normalY * impulse;
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Fraction of bodies meaningfully closer to a neighbour than one diameter. For tests and diagnostics.
 *
 * The tolerance is not slack, it is the definition. A settled pack has every neighbour at exactly one
 * diameter, so a strict comparison reports a perfect result as total failure the moment rounding puts
 * a contact a millionth under. What matters is penetration a viewer could see.
 */
export function overlapFraction(world: ParticleWorld, radius: number, tolerance = 0.99): number {
    const { positions, count } = world;
    const limit = radius * 2 * tolerance;
    let overlapping = 0;

    for (let a = 0; a < count; a += 1) {
        for (let b = 0; b < count; b += 1) {
            if (a === b) {
                continue;
            }
            const dx = positions[a * 2] - positions[b * 2];
            const dy = positions[a * 2 + 1] - positions[b * 2 + 1];
            if (dx * dx + dy * dy < limit * limit) {
                overlapping += 1;
                break;
            }
        }
    }

    return overlapping / count;
}
