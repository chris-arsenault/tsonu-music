/**
 * The persisted opt-in (ADR-0001).
 *
 * Off for a first-time visitor, so no `AudioContext` and no media-element tap exist until the listener
 * asks for them. Storage access is guarded: a browser with storage blocked should fall back to the
 * default rather than throwing on page load.
 */

export const PREFERENCE_KEY = 'tsonu.visualizer.enabled';

export interface PreferenceStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function defaultStore(): PreferenceStore | undefined {
    try {
        return typeof window === 'undefined' ? undefined : window.localStorage;
    } catch {
        // Storage access can throw outright under strict privacy settings.
        return undefined;
    }
}

/** Reads the opt-in. Anything other than a stored `true` means off. */
export function readPreference(store: PreferenceStore | undefined = defaultStore()): boolean {
    if (!store) {
        return false;
    }

    try {
        return store.getItem(PREFERENCE_KEY) === 'true';
    } catch {
        return false;
    }
}

/** Writes the opt-in. A storage failure is not worth surfacing; the session still works. */
export function writePreference(
    enabled: boolean,
    store: PreferenceStore | undefined = defaultStore(),
): void {
    if (!store) {
        return;
    }

    try {
        store.setItem(PREFERENCE_KEY, enabled ? 'true' : 'false');
    } catch {
        // Ignored deliberately: the preference simply does not persist.
    }
}

/** An in-memory store, for tests and for sessions where persistence is unavailable. */
export function createMemoryStore(initial: Record<string, string> = {}): PreferenceStore {
    const values = new Map(Object.entries(initial));

    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
            values.set(key, value);
        },
    };
}
