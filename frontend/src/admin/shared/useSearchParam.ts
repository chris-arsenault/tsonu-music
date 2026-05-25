import { useCallback, useEffect, useState } from 'react';
import { navigateTo, useCurrentRoute } from '../../music/routes';

function readParam(name: string): string | undefined {
    if (typeof window === 'undefined') return undefined;
    const params = new URLSearchParams(window.location.search);
    return params.get(name) ?? undefined;
}

function writeParam(name: string, value: string | undefined): void {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (value === undefined || value === '') {
        params.delete(name);
    } else {
        params.set(name, value);
    }
    const queryString = params.toString();
    const pathname = window.location.pathname;
    const next = queryString ? `${pathname}?${queryString}` : pathname;
    if (next !== `${pathname}${window.location.search}`) {
        navigateTo(next);
    }
}

/**
 * Mirrors a single query string param to React state.
 * The default value (`fallback`) is treated as "absent" and omitted from the URL.
 */
export function useSearchParam(name: string, fallback: string): [string, (next: string) => void] {
    const route = useCurrentRoute();
    const [value, setValue] = useState<string>(() => readParam(name) ?? fallback);

    useEffect(() => {
        const next = readParam(name) ?? fallback;
        setValue((current) => (current === next ? current : next));
    }, [name, fallback, route]);

    const update = useCallback((next: string) => {
        setValue(next);
        writeParam(name, next === fallback ? undefined : next);
    }, [name, fallback]);

    return [value, update];
}
