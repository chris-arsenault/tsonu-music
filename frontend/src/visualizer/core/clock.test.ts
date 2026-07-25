import { describe, expect, test } from 'vitest';
import {
    advanceClock,
    initialClock,
    isFrozen,
    type ClockEvent,
    type PlaybackClock,
} from './clock';

function run(events: ClockEvent[], from: PlaybackClock = initialClock) {
    return events.reduce(
        (accumulated, event) => {
            const transition = advanceClock(accumulated.clock, event);
            return { clock: transition.clock, effects: transition.effects };
        },
        { clock: from, effects: [] as ReturnType<typeof advanceClock>['effects'] },
    );
}

const startPlaying: ClockEvent[] = [
    { kind: 'track-changed', trackId: 'track_a', duration: 200 },
    { kind: 'play' },
    { kind: 'resumed' },
];

describe('playback clock', () => {
    test('starts idle and frozen', () => {
        expect(initialClock.state).toBe('idle');
        expect(isFrozen(initialClock)).toBe(true);
    });

    test('requesting playback buffers until audio actually advances', () => {
        const requested = run([{ kind: 'track-changed', trackId: 'track_a', duration: 10 }, { kind: 'play' }]);
        expect(requested.clock.state).toBe('buffering');
        expect(isFrozen(requested.clock)).toBe(true);

        const advancing = advanceClock(requested.clock, { kind: 'resumed' });
        expect(advancing.clock.state).toBe('playing');
        expect(isFrozen(advancing.clock)).toBe(false);
    });

    test('only the playing state runs simulation', () => {
        const states = ['idle', 'paused', 'buffering', 'seeking', 'ended'] as const;
        for (const state of states) {
            expect(isFrozen({ ...initialClock, state })).toBe(true);
        }
        expect(isFrozen({ ...initialClock, state: 'playing' })).toBe(false);
    });

    test('pause freezes without clearing state', () => {
        const playing = run(startPlaying);
        const paused = advanceClock(playing.clock, { kind: 'pause' });

        expect(paused.clock.state).toBe('paused');
        expect(paused.clock.trackId).toBe('track_a');
        expect(paused.clock.generation).toBe(playing.clock.generation);
        expect(paused.effects).not.toContain('clear-analysis-history');
    });

    test('resuming clears queued events and suppresses transients', () => {
        const paused = run([...startPlaying, { kind: 'pause' }]);
        const resumed = advanceClock(paused.clock, { kind: 'resumed' });

        expect(resumed.clock.state).toBe('playing');
        expect(resumed.effects).toContain('clear-pending-events');
        expect(resumed.effects).toContain('suppress-transients');
    });

    test('stalling mid-playback freezes as buffering', () => {
        const playing = run(startPlaying);
        const stalled = advanceClock(playing.clock, { kind: 'stalled' });

        expect(stalled.clock.state).toBe('buffering');
        expect(isFrozen(stalled.clock)).toBe(true);
    });

    test('seek start freezes, drops history, and invalidates tempo', () => {
        const playing = run(startPlaying);
        const seeking = advanceClock(playing.clock, { kind: 'seek-start' });

        expect(seeking.clock.state).toBe('seeking');
        expect(isFrozen(seeking.clock)).toBe(true);
        expect(seeking.effects).toEqual(
            expect.arrayContaining(['clear-pending-events', 'clear-analysis-history', 'invalidate-tempo']),
        );
    });

    test('seek completion does not resume simulation on its own', () => {
        const seeking = run([...startPlaying, { kind: 'seek-start' }]);
        const seeked = advanceClock(seeking.clock, { kind: 'seek-end' });

        // Section 6.3: analysis resumes from the new position, simulation waits for real playback.
        expect(seeked.clock.state).toBe('buffering');
        expect(isFrozen(seeked.clock)).toBe(true);

        const resumed = advanceClock(seeked.clock, { kind: 'resumed' });
        expect(isFrozen(resumed.clock)).toBe(false);
    });

    test('seeking while paused stays frozen throughout', () => {
        const paused = run([...startPlaying, { kind: 'pause' }]);
        const seeking = advanceClock(paused.clock, { kind: 'seek-start' });
        expect(isFrozen(seeking.clock)).toBe(true);

        const seeked = advanceClock(seeking.clock, { kind: 'seek-end' });
        expect(isFrozen(seeked.clock)).toBe(true);
    });

    test('track change bumps generation and resets position', () => {
        const playing = run([...startPlaying, { kind: 'time', playbackTime: 92.5 }]);
        expect(playing.clock.playbackTime).toBe(92.5);

        const changed = advanceClock(playing.clock, {
            kind: 'track-changed',
            trackId: 'track_b',
            duration: 150,
        });

        expect(changed.clock.generation).toBe(playing.clock.generation + 1);
        expect(changed.clock.trackId).toBe('track_b');
        expect(changed.clock.playbackTime).toBe(0);
        expect(changed.clock.duration).toBe(150);
        expect(changed.effects).toEqual(
            expect.arrayContaining([
                'clear-analysis-history',
                'clear-pending-events',
                'invalidate-tempo',
                'resolve-assets',
                'reseed-scene',
            ]),
        );
    });

    test('re-announcing the same track is not a track change', () => {
        const playing = run(startPlaying);
        const same = advanceClock(playing.clock, {
            kind: 'track-changed',
            trackId: 'track_a',
            duration: 200,
        });

        expect(same.clock.generation).toBe(playing.clock.generation);
        expect(same.effects).toEqual([]);
        expect(same.clock.state).toBe('playing');
    });

    test('track change during a seek still lands cleanly', () => {
        const seeking = run([...startPlaying, { kind: 'seek-start' }]);
        const changed = advanceClock(seeking.clock, {
            kind: 'track-changed',
            trackId: 'track_b',
            duration: 90,
        });

        expect(changed.clock.state).toBe('buffering');
        expect(changed.clock.generation).toBe(seeking.clock.generation + 1);
        expect(isFrozen(changed.clock)).toBe(true);
    });

    test('clearing the track returns to idle', () => {
        const playing = run(startPlaying);
        const cleared = advanceClock(playing.clock, { kind: 'track-changed', trackId: null, duration: 0 });

        expect(cleared.clock.state).toBe('idle');
        expect(cleared.clock.trackId).toBeNull();
    });

    test('ended freezes and drops queued events', () => {
        const playing = run(startPlaying);
        const ended = advanceClock(playing.clock, { kind: 'ended' });

        expect(ended.clock.state).toBe('ended');
        expect(isFrozen(ended.clock)).toBe(true);
        expect(ended.effects).toContain('clear-pending-events');
    });

    test('nonsense time and duration updates are ignored', () => {
        const playing = run(startPlaying);

        expect(advanceClock(playing.clock, { kind: 'time', playbackTime: Number.NaN }).clock.playbackTime)
            .toBe(playing.clock.playbackTime);
        expect(advanceClock(playing.clock, { kind: 'time', playbackTime: -4 }).clock.playbackTime)
            .toBe(playing.clock.playbackTime);
        expect(advanceClock(playing.clock, { kind: 'duration', duration: Number.POSITIVE_INFINITY }).clock.duration)
            .toBe(playing.clock.duration);
    });

    test('repeated identical events emit no duplicate effects', () => {
        const seeking = run([...startPlaying, { kind: 'seek-start' }]);
        const again = advanceClock(seeking.clock, { kind: 'seek-start' });

        expect(again.effects).toEqual([]);
    });
});
