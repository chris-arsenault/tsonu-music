import { describe, expect, test } from 'vitest';
import { initialMediaEvents } from './media-events';

type FakeElement = Pick<HTMLMediaElement, 'currentTime' | 'duration' | 'paused' | 'ended' | 'readyState'>;

function element(overrides: Partial<FakeElement> = {}): HTMLMediaElement {
    return {
        currentTime: 0,
        duration: Number.NaN,
        paused: true,
        ended: false,
        readyState: 0,
        ...overrides,
    } as HTMLMediaElement;
}

describe('initial media state', () => {
    test('a paused element reports paused, so the clock starts frozen', () => {
        const events = initialMediaEvents(element({ paused: true, currentTime: 12, duration: 100 }));

        expect(events).toContainEqual({ kind: 'pause' });
        expect(events).toContainEqual({ kind: 'time', playbackTime: 12 });
        expect(events).toContainEqual({ kind: 'duration', duration: 100 });
        expect(events).not.toContainEqual({ kind: 'resumed' });
    });

    test('an element already playing with buffered data resumes immediately', () => {
        const events = initialMediaEvents(element({ paused: false, readyState: 4, currentTime: 30 }));

        expect(events).toContainEqual({ kind: 'play' });
        expect(events).toContainEqual({ kind: 'resumed' });
    });

    test('an element playing but still buffering does not resume', () => {
        const events = initialMediaEvents(element({ paused: false, readyState: 1 }));

        expect(events).toContainEqual({ kind: 'play' });
        expect(events).not.toContainEqual({ kind: 'resumed' });
    });

    test('an ended element reports ended rather than paused', () => {
        const events = initialMediaEvents(element({ ended: true, paused: true }));

        expect(events).toContainEqual({ kind: 'ended' });
        expect(events).not.toContainEqual({ kind: 'pause' });
    });

    test('an unknown duration is not reported', () => {
        const events = initialMediaEvents(element({ duration: Number.NaN }));

        expect(events.some((event) => event.kind === 'duration')).toBe(false);
    });
});
