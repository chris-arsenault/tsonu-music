/**
 * The frame loop.
 *
 * `requestAnimationFrame` schedules work here and contributes nothing to visual time: every value
 * the loop produces comes from the playback clock and the audio thread. When the clock is frozen the
 * loop still runs, but it advances nothing — which is what retains the current visual state through
 * pause, stall, and seek instead of resetting it.
 */

import {
    advanceClock,
    initialClock,
    isFrozen,
    type ClockEffect,
    type ClockEvent,
    type PlaybackClock,
} from '../core/clock';
import {
    advanceFeatureBus,
    createFeatureBusState,
    type AudioFeatureBus,
} from '../core/features';
import { acquireTap, type AudioTap } from './audio-tap';
import { initialMediaEvents, subscribeMediaEvents } from './media-events';
import { createRenderer, type Renderer, type RendererFailure } from './renderer';

export interface KernelReadout {
    clock: PlaybackClock;
    frozen: boolean;
    bus: AudioFeatureBus;
    latencySeconds: number;
    contextState: AudioContextState | 'starting' | 'failed';
    flatlined: boolean;
    /** Wall-clock milliseconds for the last frame, for the performance controller in M2. */
    frameTimeMs: number;
    /** Absent when no canvas was supplied or the renderer could not start. */
    render?: {
        passesExecuted: number;
        targetsAllocated: number;
        skippedPasses: number;
        problems: string[];
    };
    renderFailure?: RendererFailure;
}

export interface KernelOptions {
    element: HTMLMediaElement;
    /** Current track identity. Changing it is what bumps the clock's generation. */
    trackId: string | null;
    trackDurationSeconds: number;
    /** Omit to run analysis only, with no rendering. */
    canvas?: HTMLCanvasElement;
    /** Called at a throttled rate for display; never once per frame. */
    onReadout: (readout: KernelReadout) => void;
}

export interface KernelHandle {
    setTrack(trackId: string | null, durationSeconds: number): void;
    stop(): void;
}

/** Readout callbacks per second. Display only — the loop itself runs every frame. */
const READOUT_HZ = 12;

export function startKernel(options: KernelOptions): KernelHandle {
    const { element, onReadout } = options;

    let clock = initialClock;
    let features = createFeatureBusState();
    let tap: AudioTap | undefined;
    let contextState: KernelReadout['contextState'] = 'starting';

    const queue: ClockEvent[] = [];
    const emit = (event: ClockEvent) => queue.push(event);

    let trackId = options.trackId;
    let trackDuration = options.trackDurationSeconds;
    emit({ kind: 'track-changed', trackId, duration: trackDuration });
    for (const event of initialMediaEvents(element)) {
        emit(event);
    }

    const unsubscribe = subscribeMediaEvents(element, emit);

    let running = true;
    let frameHandle = 0;
    let lastFrameTime = 0;
    let lastReadoutTime = 0;

    let renderer: Renderer | undefined;
    let renderFailure: RendererFailure | undefined;
    let renderStats: KernelReadout['render'];

    if (options.canvas) {
        const result = createRenderer(options.canvas);
        if (result.ok) {
            renderer = result.renderer;
        } else {
            renderFailure = result.failure;
            console.warn('[visualizer] renderer unavailable', result.failure, result.detail ?? '');
        }
    }

    void acquireTap(element)
        .then(async (acquired) => {
            if (!running) {
                acquired.dispose();
                return;
            }

            tap = acquired;
            await acquired.resume();
            contextState = acquired.context.state;
        })
        .catch((error: unknown) => {
            contextState = 'failed';
            console.warn('[visualizer] could not start audio analysis', error);
        });

    const frame = (now: number) => {
        if (!running) {
            return;
        }

        const wallDelta = lastFrameTime === 0 ? 0 : (now - lastFrameTime) / 1000;
        lastFrameTime = now;

        const effects: ClockEffect[] = [];
        while (queue.length > 0) {
            const transition = advanceClock(clock, queue.shift()!);
            clock = transition.clock;
            effects.push(...transition.effects);
        }

        // Section 6.2 and 6.3: a frozen clock advances nothing. Passing zero here is what freezes
        // smoothing, beat phase, and every simulator that will later read this delta.
        const frozen = isFrozen(clock);
        const deltaSeconds = frozen ? 0 : wallDelta;

        if (tap) {
            contextState = tap.context.state;

            // Autoplay policy can suspend the context after it was started. Recover on the frames
            // where audio is genuinely playing.
            if (tap.context.state === 'suspended' && !element.paused) {
                void tap.resume();
            }

            // Short-term history is dropped in the worklet, not just in the bus, so a stale onset
            // cannot arrive after the reset.
            if (effects.includes('clear-analysis-history')) {
                tap.reset();
            }
        }

        features = advanceFeatureBus(features, {
            snapshot: tap?.takeSnapshot(),
            clock,
            effects,
            currentAudioTime: tap?.context.currentTime ?? 0,
            latencySeconds: tap?.latencySeconds() ?? 0,
            deltaSeconds,
        });

        if (renderer) {
            // Quality is fixed at full until the performance controller lands in M2.
            const stats = renderer.renderFrame({
                clock,
                features: features.bus,
                deltaSeconds,
                qualityScale: 1,
            });
            renderStats = { ...stats, problems: renderer.problems() };
        }

        if (now - lastReadoutTime >= 1000 / READOUT_HZ) {
            lastReadoutTime = now;
            onReadout({
                clock,
                frozen,
                bus: features.bus,
                latencySeconds: tap?.latencySeconds() ?? 0,
                contextState,
                flatlined: tap?.isFlatlined() ?? false,
                frameTimeMs: wallDelta * 1000,
                render: renderStats,
                renderFailure,
            });
        }

        frameHandle = requestAnimationFrame(frame);
    };

    frameHandle = requestAnimationFrame(frame);

    return {
        setTrack(nextTrackId, durationSeconds) {
            if (nextTrackId === trackId && durationSeconds === trackDuration) {
                return;
            }

            trackId = nextTrackId;
            trackDuration = durationSeconds;
            emit({ kind: 'track-changed', trackId: nextTrackId, duration: durationSeconds });
        },

        stop() {
            running = false;
            cancelAnimationFrame(frameHandle);
            unsubscribe();
            renderer?.dispose();
            // The tap's media-element source is never detached; only the analysis branch is released.
            tap?.dispose();
        },
    };
}
