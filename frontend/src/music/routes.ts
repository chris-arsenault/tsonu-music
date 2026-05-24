import { useEffect, useState, type MouseEvent } from 'react';

const NAVIGATION_EVENT = 'tsonu:navigation';

export function releasePath(slug: string): string {
    return `/releases/${encodeURIComponent(slug)}`;
}

export function songPath(slug: string): string {
    return `/songs/${encodeURIComponent(slug)}`;
}

export function trackPath(releaseSlug: string, trackSlug: string): string {
    return `/tracks/${encodeURIComponent(releaseSlug)}/${encodeURIComponent(trackSlug)}`;
}

export function decodePathPart(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }

    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function currentRoute(): string {
    if (typeof window === 'undefined') {
        return '/';
    }

    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function navigateTo(path: string): void {
    if (typeof window === 'undefined') {
        return;
    }

    window.history.pushState(null, '', path);
    window.dispatchEvent(new Event(NAVIGATION_EVENT));

    const hash = window.location.hash.slice(1);
    if (hash) {
        window.requestAnimationFrame(() => {
            document.getElementById(hash)?.scrollIntoView({ block: 'start' });
        });
    } else {
        window.scrollTo({ top: 0 });
    }
}

export function useCurrentRoute(): string {
    const [route, setRoute] = useState(currentRoute);

    useEffect(() => {
        const handleChange = () => setRoute(currentRoute());
        window.addEventListener('popstate', handleChange);
        window.addEventListener(NAVIGATION_EVENT, handleChange);
        return () => {
            window.removeEventListener('popstate', handleChange);
            window.removeEventListener(NAVIGATION_EVENT, handleChange);
        };
    }, []);

    return route;
}

export function handleInternalLink(event: MouseEvent<HTMLAnchorElement>, path: string): void {
    if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey
    ) {
        return;
    }

    event.preventDefault();
    navigateTo(path);
}
