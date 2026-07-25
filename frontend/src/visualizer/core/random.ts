/**
 * Per-scene randomness.
 *
 * A fresh entropy token is created whenever the product asks for a new scene. The scheduler then uses
 * one stable stream while assembling that scene so its own choices remain internally coherent; tracks
 * are deliberately not mapped to repeatable scenes.
 */

export interface Rng {
    /** Next value in [0, 1). */
    next(): number;
    /** Integer in [0, bound). */
    int(bound: number): number;
    /** True with the given probability. */
    chance(probability: number): boolean;
    /** Uniform value in [low, high]. */
    range(low: number, high: number): number;
    pick<T>(items: readonly T[]): T | undefined;
    /** Index chosen in proportion to each item's weight. */
    weighted<T>(items: readonly T[], weight: (item: T) => number): T | undefined;
    /** A copy of `items` in a shuffled order. Does not mutate the input. */
    shuffle<T>(items: readonly T[]): T[];
    /** Independent stream derived from this one, so one consumer cannot desync another. */
    fork(label: string): Rng;
}

/** FNV-1a. Turns a seed string into the 32-bit state the generator starts from. */
export function hashSeed(seed: string): number {
    let hash = 2166136261;

    for (let index = 0; index < seed.length; index += 1) {
        hash ^= seed.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
}

export function createRng(seed: string): Rng {
    // mulberry32: small, fast, and good enough for visual selection.
    let state = hashSeed(seed) || 1;

    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };

    const rng: Rng = {
        next,

        int(bound) {
            return bound <= 0 ? 0 : Math.floor(next() * bound);
        },

        chance(probability) {
            return next() < probability;
        },

        range(low, high) {
            return low + (high - low) * next();
        },

        pick(items) {
            return items.length === 0 ? undefined : items[rng.int(items.length)];
        },

        weighted(items, weight) {
            let total = 0;
            for (const item of items) {
                const value = weight(item);
                if (Number.isFinite(value) && value > 0) {
                    total += value;
                }
            }

            if (total <= 0) {
                return undefined;
            }

            let threshold = next() * total;
            for (const item of items) {
                const value = weight(item);
                if (!Number.isFinite(value) || value <= 0) {
                    continue;
                }

                threshold -= value;
                if (threshold <= 0) {
                    return item;
                }
            }

            return items[items.length - 1];
        },

        shuffle(items) {
            const copy = [...items];
            for (let index = copy.length - 1; index > 0; index -= 1) {
                const swap = rng.int(index + 1);
                [copy[index], copy[swap]] = [copy[swap], copy[index]];
            }
            return copy;
        },

        fork(label) {
            return createRng(`${state}:${label}`);
        },
    };

    return rng;
}

let fallbackEntropyCounter = 0;

/**
 * Fresh entropy for a scene selection.
 *
 * Browsers provide `crypto.randomUUID`; the fallback is intentionally time-varying as well. The
 * optional source keeps the contract testable without making production scene selection repeatable.
 */
export function freshSceneEntropy(randomUuid?: () => string): string {
    const source = randomUuid ?? globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    if (source) {
        return `scene:${source()}`;
    }

    fallbackEntropyCounter += 1;
    return `scene:${Date.now().toString(36)}:${fallbackEntropyCounter.toString(36)}`;
}
