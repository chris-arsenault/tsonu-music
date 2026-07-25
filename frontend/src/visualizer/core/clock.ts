/**
 * Playback clock (spec section 6).
 *
 * Visual time follows actual playback. `requestAnimationFrame` schedules frames and contributes
 * nothing here. This module is a pure reducer over media events so the freeze semantics for pause,
 * stall, seek, and track change are verifiable without a browser.
 */

export type PlaybackState =
    | 'idle'
    | 'playing'
    | 'paused'
    | 'buffering'
    | 'seeking'
    | 'ended';

export interface PlaybackClock {
    trackId: string | null;
    playbackTime: number;
    duration: number;
    state: PlaybackState;
    generation: number;
}

/**
 * Media-side events the clock reacts to. `resumed` is distinct from `play`: `play` fires when
 * playback is requested, `resumed` when audio is actually advancing again, and only the latter
 * releases the freeze.
 */
export type ClockEvent =
    | { kind: 'track-changed'; trackId: string | null; duration: number }
    | { kind: 'play' }
    | { kind: 'resumed' }
    | { kind: 'pause' }
    | { kind: 'stalled' }
    | { kind: 'seek-start' }
    | { kind: 'seek-end' }
    | { kind: 'ended' }
    | { kind: 'time', playbackTime: number }
    | { kind: 'duration', duration: number };

/**
 * Consequences a transition has for state held outside the clock. The feature bus applies these;
 * the clock never reaches into it.
 */
export type ClockEffect =
    | 'clear-analysis-history'
    | 'clear-pending-events'
    | 'invalidate-tempo'
    | 'suppress-transients'
    | 'resolve-assets'
    | 'reseed-scene';

export interface ClockTransition {
    clock: PlaybackClock;
    effects: ClockEffect[];
}

export const initialClock: PlaybackClock = {
    trackId: null,
    playbackTime: 0,
    duration: 0,
    state: 'idle',
    generation: 0,
};

/**
 * Simulators, feedback evolution, mutation timers, and beat-phase interpolation advance only while
 * audio is actually playing. Every other state freezes them, retaining the current frame.
 */
export function isFrozen(clock: PlaybackClock): boolean {
    return clock.state !== 'playing';
}

export function advanceClock(clock: PlaybackClock, event: ClockEvent): ClockTransition {
    switch (event.kind) {
        case 'track-changed':
            return trackChanged(clock, event.trackId, event.duration);

        case 'play':
            // Requesting playback does not by itself mean audio is advancing. Buffering resolves
            // through `resumed`.
            return clock.state === 'playing'
                ? unchanged(clock)
                : withEffects({ ...clock, state: 'buffering' }, []);

        case 'resumed':
            if (clock.state === 'playing') {
                return unchanged(clock);
            }

            // Leaving a frozen state discards transient history so a stale onset queued before the
            // freeze cannot fire against newly heard audio.
            return withEffects({ ...clock, state: 'playing' }, [
                'clear-pending-events',
                'suppress-transients',
            ]);

        case 'pause':
            return clock.state === 'paused'
                ? unchanged(clock)
                : withEffects({ ...clock, state: 'paused' }, []);

        case 'stalled':
            return clock.state === 'buffering' || clock.state === 'seeking'
                ? unchanged(clock)
                : withEffects({ ...clock, state: 'buffering' }, []);

        case 'seek-start':
            if (clock.state === 'seeking') {
                return unchanged(clock);
            }

            // Section 6.3: freeze, drop queued events and short-term history, and stop trusting the
            // tempo estimate. Exact historical reconstruction is not required.
            return withEffects({ ...clock, state: 'seeking' }, [
                'clear-pending-events',
                'clear-analysis-history',
                'invalidate-tempo',
            ]);

        case 'seek-end':
            if (clock.state !== 'seeking') {
                return unchanged(clock);
            }

            // Analysis resumes from the new position, but simulation stays frozen until playback
            // actually resumes.
            return withEffects({ ...clock, state: 'buffering' }, []);

        case 'ended':
            return clock.state === 'ended'
                ? unchanged(clock)
                : withEffects({ ...clock, state: 'ended' }, ['clear-pending-events']);

        case 'time':
            return Number.isFinite(event.playbackTime) && event.playbackTime >= 0
                ? unchanged({ ...clock, playbackTime: event.playbackTime })
                : unchanged(clock);

        case 'duration':
            return Number.isFinite(event.duration) && event.duration > 0
                ? unchanged({ ...clock, duration: event.duration })
                : unchanged(clock);
    }
}

function trackChanged(clock: PlaybackClock, trackId: string | null, duration: number): ClockTransition {
    if (trackId === clock.trackId) {
        return unchanged(clock);
    }

    // Section 6.4. The generation increment is what lets in-flight work from the previous track be
    // discarded rather than applied to the new one.
    return withEffects(
        {
            trackId,
            playbackTime: 0,
            duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
            state: trackId === null ? 'idle' : 'buffering',
            generation: clock.generation + 1,
        },
        [
            'clear-analysis-history',
            'clear-pending-events',
            'invalidate-tempo',
            'resolve-assets',
            'reseed-scene',
        ],
    );
}

function unchanged(clock: PlaybackClock): ClockTransition {
    return { clock, effects: [] };
}

function withEffects(clock: PlaybackClock, effects: ClockEffect[]): ClockTransition {
    return { clock, effects };
}
