import { describe, expect, test } from 'vitest';
import {
    createMemoryStore,
    PREFERENCE_KEY,
    readPreference,
    writePreference,
    type PreferenceStore,
} from './preference';
import { hasSignal } from '../host/simple-waveform';

/** A store that throws on every access, as strict privacy settings can. */
const hostileStore: PreferenceStore = {
    getItem() {
        throw new Error('storage blocked');
    },
    setItem() {
        throw new Error('storage blocked');
    },
};

describe('visualizer preference', () => {
    test('a first-time visitor is opted out', () => {
        expect(readPreference(createMemoryStore())).toBe(false);
    });

    test('an explicit opt-in persists', () => {
        const store = createMemoryStore();
        writePreference(true, store);

        expect(readPreference(store)).toBe(true);
        expect(store.getItem(PREFERENCE_KEY)).toBe('true');
    });

    test('opting back out persists too', () => {
        const store = createMemoryStore({ [PREFERENCE_KEY]: 'true' });
        writePreference(false, store);

        expect(readPreference(store)).toBe(false);
    });

    test('anything other than a stored true reads as off', () => {
        expect(readPreference(createMemoryStore({ [PREFERENCE_KEY]: 'yes' }))).toBe(false);
        expect(readPreference(createMemoryStore({ [PREFERENCE_KEY]: '1' }))).toBe(false);
        expect(readPreference(createMemoryStore({ [PREFERENCE_KEY]: '' }))).toBe(false);
    });

    test('no store available means off rather than an error', () => {
        expect(readPreference(undefined)).toBe(false);
        expect(() => writePreference(true, undefined)).not.toThrow();
    });

    test('a store that throws is treated as absent', () => {
        // Reading must not break page load, and writing must not break the toggle.
        expect(readPreference(hostileStore)).toBe(false);
        expect(() => writePreference(true, hostileStore)).not.toThrow();
    });
});

describe('waveform signal detection', () => {
    test('silence is detected as absent', () => {
        expect(hasSignal(new Float32Array(256))).toBe(false);
        expect(hasSignal(new Float32Array(0))).toBe(false);
    });

    test('a real signal is detected', () => {
        expect(hasSignal(Float32Array.from({ length: 64 }, (_, i) => Math.sin(i / 4)))).toBe(true);
    });

    test('detection is sign-independent', () => {
        expect(hasSignal(Float32Array.from([0, 0, -0.5, 0]))).toBe(true);
    });

    test('numerically negligible values count as silence', () => {
        // Otherwise floating-point dust would keep the tier drawing a flat line forever.
        expect(hasSignal(Float32Array.from([1e-9, -1e-9]))).toBe(false);
    });
});
