/**
 * Impact events (spec section 19.6).
 *
 * A first-class kernel event type rather than a channel private to the impact simulator. Section 19.6
 * wants impacts driving wave-field impulses, feedback bulges, glow, shockwave transforms, and secondary
 * emitters — all of which live in other plugins, so the event has to cross the plugin boundary.
 *
 * The kernel carries impacts the same way it carries onsets: a bounded queue that any plugin may read
 * and that a producer publishes to. The kernel understands the shape, never what causes one.
 */

export interface ImpactEvent {
    position: [number, number];
    energy: number;
    impulse: [number, number];
    radius: number;
    playbackTime: number;
}

/**
 * Bounded so a runaway producer cannot grow memory without limit. Impacts are visual punctuation; more
 * than this in one frame is indistinguishable anyway.
 */
export const MAX_IMPACTS = 32;

/** How long an impact stays readable after it happens. */
export const IMPACT_LIFETIME_SECONDS = 1.5;

export interface ImpactBus {
    /** Impacts still within their lifetime, newest last. */
    readonly active: readonly ImpactEvent[];
}

export function createImpactBus(): ImpactBus {
    return { active: [] };
}

/** Publishes impacts, dropping the oldest when the bound is reached. */
export function publishImpacts(
    bus: ImpactBus,
    impacts: readonly ImpactEvent[],
): ImpactBus {
    if (impacts.length === 0) {
        return bus;
    }

    const combined = [...bus.active, ...impacts.filter(isValidImpact)];

    return { active: combined.slice(-MAX_IMPACTS) };
}

/** Expires impacts past their lifetime. A frozen clock advances nothing, so impacts persist. */
export function expireImpacts(bus: ImpactBus, playbackTime: number): ImpactBus {
    const active = bus.active.filter(
        (impact) => playbackTime - impact.playbackTime < IMPACT_LIFETIME_SECONDS,
    );

    return active.length === bus.active.length ? bus : { active };
}

/** Dropped on seek and track change, alongside the rest of the transient history. */
export function clearImpacts(): ImpactBus {
    return createImpactBus();
}

/**
 * Age of an impact as 0 at the moment of impact to 1 at expiry, for consumers shaping a response over
 * its lifetime. Values outside that range mean the impact is not current.
 */
export function impactAge(impact: ImpactEvent, playbackTime: number): number {
    return (playbackTime - impact.playbackTime) / IMPACT_LIFETIME_SECONDS;
}

/** Total live energy, for consumers scaling a global response such as glow. */
export function totalImpactEnergy(bus: ImpactBus, playbackTime: number): number {
    let total = 0;

    for (const impact of bus.active) {
        const age = impactAge(impact, playbackTime);
        if (age >= 0 && age <= 1) {
            // Linear decay: an impact contributes most when fresh.
            total += impact.energy * (1 - age);
        }
    }

    return total;
}

/** The strongest live impact, for consumers that respond to one rather than to all. */
export function strongestImpact(bus: ImpactBus, playbackTime: number): ImpactEvent | undefined {
    let best: ImpactEvent | undefined;
    let bestWeight = 0;

    for (const impact of bus.active) {
        const age = impactAge(impact, playbackTime);
        if (age < 0 || age > 1) {
            continue;
        }

        const weight = impact.energy * (1 - age);
        if (weight > bestWeight) {
            bestWeight = weight;
            best = impact;
        }
    }

    return best;
}

/**
 * Packs impacts for a shader uniform: position, energy, radius per impact.
 *
 * Preallocated and reused so consuming impacts costs no per-frame allocation.
 */
export function packImpacts(
    bus: ImpactBus,
    playbackTime: number,
    into: Float32Array,
    stride = 4,
): number {
    const capacity = Math.floor(into.length / stride);
    let count = 0;

    for (const impact of bus.active) {
        if (count >= capacity) {
            break;
        }

        const age = impactAge(impact, playbackTime);
        if (age < 0 || age > 1) {
            continue;
        }

        const offset = count * stride;
        into[offset] = impact.position[0];
        into[offset + 1] = impact.position[1];
        into[offset + 2] = impact.energy * (1 - age);
        into[offset + 3] = impact.radius;
        count += 1;
    }

    // Zeroes the unused tail, so a shader reading the full array sees no stale impacts.
    into.fill(0, count * stride);

    return count;
}

function isValidImpact(impact: ImpactEvent): boolean {
    return Number.isFinite(impact.position[0])
        && Number.isFinite(impact.position[1])
        && Number.isFinite(impact.energy)
        && impact.energy > 0
        && Number.isFinite(impact.radius)
        && impact.radius > 0
        && Number.isFinite(impact.playbackTime);
}
