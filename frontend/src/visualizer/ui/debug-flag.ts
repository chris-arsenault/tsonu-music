/**
 * Its own module so the app shell can read the flag without importing — and therefore eagerly
 * bundling — the diagnostics panel.
 */

export const VISUALIZER_DEBUG_PARAM = 'viz-debug';

export function isVisualizerDebugEnabled(search?: string): boolean {
    const query = search ?? (typeof window === 'undefined' ? '' : window.location.search);

    return new URLSearchParams(query).get(VISUALIZER_DEBUG_PARAM) === '1';
}
