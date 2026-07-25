/**
 * Translates media-element events into clock events.
 *
 * Deliberately mechanical: it decides nothing, it only names what happened. The distinction that
 * matters is `play` (playback requested) against `playing` (audio actually advancing) — only the
 * second releases the clock's freeze.
 */

import type { ClockEvent } from '../core/clock';

type Listener = () => void;

const EVENT_MAP: Array<[keyof HTMLMediaElementEventMap, (element: HTMLMediaElement) => ClockEvent]> = [
    ['play', () => ({ kind: 'play' })],
    ['playing', () => ({ kind: 'resumed' })],
    ['pause', () => ({ kind: 'pause' })],
    ['waiting', () => ({ kind: 'stalled' })],
    ['stalled', () => ({ kind: 'stalled' })],
    ['seeking', () => ({ kind: 'seek-start' })],
    ['seeked', () => ({ kind: 'seek-end' })],
    ['ended', () => ({ kind: 'ended' })],
    ['timeupdate', (element) => ({ kind: 'time', playbackTime: element.currentTime })],
    ['durationchange', (element) => ({ kind: 'duration', duration: element.duration })],
    ['loadedmetadata', (element) => ({ kind: 'duration', duration: element.duration })],
];

/**
 * Subscribes to the element and pushes clock events into `emit`. Returns an unsubscribe function.
 */
export function subscribeMediaEvents(
    element: HTMLMediaElement,
    emit: (event: ClockEvent) => void,
): () => void {
    const listeners: Array<[string, Listener]> = [];

    for (const [name, toEvent] of EVENT_MAP) {
        const listener: Listener = () => emit(toEvent(element));
        element.addEventListener(name, listener);
        listeners.push([name, listener]);
    }

    return () => {
        for (const [name, listener] of listeners) {
            element.removeEventListener(name, listener);
        }
    };
}

/**
 * The element's current state as clock events, for use when the kernel starts mid-playback rather
 * than at page load.
 */
export function initialMediaEvents(element: HTMLMediaElement): ClockEvent[] {
    const events: ClockEvent[] = [];

    if (Number.isFinite(element.duration) && element.duration > 0) {
        events.push({ kind: 'duration', duration: element.duration });
    }

    events.push({ kind: 'time', playbackTime: element.currentTime });

    if (element.ended) {
        events.push({ kind: 'ended' });
    } else if (element.paused) {
        events.push({ kind: 'pause' });
    } else {
        events.push({ kind: 'play' });
        // `readyState` at or above HAVE_FUTURE_DATA means audio is genuinely advancing.
        if (element.readyState >= 3) {
            events.push({ kind: 'resumed' });
        }
    }

    return events;
}
