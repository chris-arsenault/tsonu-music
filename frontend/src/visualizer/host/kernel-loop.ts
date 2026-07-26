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
import {
    albumArtAssetFrom,
    availableAssetIds,
    type VisualAsset,
} from '../core/assets';
import { loadMaskAssets, loadTextures } from './asset-loader';
import {
    createDiagnosticsControls,
    recordActivation,
    type DiagnosticsControls,
} from '../core/diagnostics';
import {
    advanceMutation,
    createMutationState,
    type MutationKind,
} from '../core/scheduler';
import {
    advancePerformance,
    applyReducedMotion,
    createPerformanceState,
    profileFor,
    suspendedProfile,
    type PerformanceState,
    type QualityProfile,
} from '../core/performance';
import { acquireTap, type AudioTap } from './audio-tap';
import { initialMediaEvents, subscribeMediaEvents } from './media-events';
import { createRenderer, type Renderer, type RendererFailure } from './renderer';

export interface KernelReadout {
    clock: PlaybackClock;
    frozen: boolean;
    bus: AudioFeatureBus;
    latencySeconds: number;
    contextState: AudioContextState | 'starting' | 'failed';
    /**
     * Where audio analysis is running. `main-thread` means `AudioWorklet` was unavailable — most
     * often because the page is not a secure context — and precision is reduced accordingly.
     */
    analysisPath: 'worklet' | 'main-thread' | 'starting';
    flatlined: boolean;
    /** Wall-clock milliseconds for the last frame, for the performance controller in M2. */
    frameTimeMs: number;
    /** Absent when no canvas was supplied or the renderer could not start. */
    render?: {
        passesExecuted: number;
        targetsAllocated: number;
        skippedPasses: number;
        suppressedPlugins: number;
        /** Programs still linking. Non-zero only briefly after a scene change. */
        pendingShaders: number;
        problems: string[];
    };
    renderFailure?: RendererFailure;
    /** Current quality level and profile, and the scene the scheduler assembled. */
    performance?: {
        level: number;
        downgrades: number;
        bufferConstrained: boolean;
        profile: QualityProfile;
    };
    scene?: {
        themeId: string;
        pluginIds: string[];
        instanceIds: string[];
        resourceIds: string[];
        edges: string[];
        assets: readonly string[];
        activationHistory: readonly string[];
        estimatedTextureBytes: number;
        /** The most recent mutation the scheduler applied. */
        lastMutation: string;
        /** Layers the compositor is blending this frame. */
        layerCount: number;
        /** Visible branches interacting before final presentation. */
        materialBranchCount: number;
        /** Independently phased, audio-bound parameters moving this frame. */
        activeModulatorCount: number;
        /** Fraction of the accumulated image surviving one second. */
        survivalPerSecond: number;
        /** UV per second the accumulation is dragged through the scene's motion field. */
        motionScale: number;
    };
    gpu?: {
        floatRenderTargets: boolean;
        maxTextureSize: number;
        maxPixelRatio: number;
        renderWidth: number;
        renderHeight: number;
    };
}

/** Controls the overlay drives. Read every frame, so a change takes effect immediately. */
export interface KernelControlHandle {
    setControls(controls: DiagnosticsControls): void;
    /** Discards the current composition and selects a fresh random scene. */
    newScene(): boolean;
}

export interface KernelOptions {
    element: HTMLMediaElement;
    /** Current track identity. Changing it is what bumps the clock's generation. */
    trackId: string | null;
    trackDurationSeconds: number;
    /** Omit to run analysis only, with no rendering. */
    canvas?: HTMLCanvasElement;
    /** Honoured as a low-energy profile rather than by slowing everything down. */
    prefersReducedMotion?: boolean;
    /** Reports HLS forward-buffer health. Omit when unavailable; frame time is then the only input. */
    bufferHealth?: () => { forwardBufferSeconds?: number; stalled?: boolean };
    /** Album artwork for asset-derivation plugins. Omit to run without artwork. */
    artworkSrc?: string;
    /** Called at a throttled rate for display; never once per frame. */
    onReadout: (readout: KernelReadout) => void;
    /**
     * Readout callbacks per second. The player's overlay is text and does not need many; a meter
     * being watched to judge whether a feature moves does, and at twelve the meter itself looks like
     * the thing under test is stuttering.
     */
    readoutHz?: number;
}

export interface KernelHandle extends KernelControlHandle {
    setTrack(trackId: string | null, durationSeconds: number): void;
    stop(): void;
}

/** Default readout callbacks per second. Display only — the loop itself runs every frame. */
const READOUT_HZ = 12;

/**
 * Longest step any simulator, integrator, or decay is asked to take in one frame.
 *
 * The wall delta was passed through unbounded, and audio in a hidden tab keeps the clock playing, so
 * returning to the tab after two minutes delivered a delta of roughly a hundred and twenty seconds to
 * every `update()` in the graph. That wipes the accumulation buffer outright, and any explicit Euler
 * step launches its state to infinity in a single frame — particle drag is bound as high as 0.9, and
 * `1 - drag * delta` turns negative past about 1.1 seconds, so velocity inverts and the whole
 * ensemble collapses. One garbage collection or shader compile was enough to trigger it; deltas of
 * 1.4 seconds were observed in normal use.
 *
 * A quarter second is well beyond any frame that will actually be presented, so this changes nothing
 * during smooth playback. Time skipped past the cap is dropped rather than accumulated: a simulator
 * catching up on two minutes of physics in one frame is not a state anybody wants to arrive at.
 */
const MAXIMUM_FRAME_SECONDS = 0.25;

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

    let performance: PerformanceState = createPerformanceState();
    let lastRebuiltGeneration = clock.generation;
    let controls: DiagnosticsControls = createDiagnosticsControls();
    let activationHistory: readonly string[] = [];
    let mutation = createMutationState();
    let lastMutation: MutationKind | 'none' = 'none';

    const currentProfile = (): QualityProfile => {
        if (typeof document !== 'undefined' && document.hidden) {
            return suspendedProfile();
        }

        const profile = profileFor(performance.level);
        return options.prefersReducedMotion ? applyReducedMotion(profile) : profile;
    };

    if (options.canvas) {
        const result = createRenderer(options.canvas, {
            profile: currentProfile(),
        });

        if (result.ok) {
            renderer = result.renderer;
        } else {
            renderFailure = result.failure;
            console.warn('[visualizer] renderer unavailable', result.failure, result.detail ?? '');
        }
    }

    // Masks load asynchronously and are optional, so the scene starts without them and is rebuilt once
    // they arrive rather than blocking the first frame on a fetch.
    void (async () => {
        const masks = await loadMaskAssets();
        const assets: VisualAsset[] = [...masks];
        if (options.artworkSrc) {
            assets.push(albumArtAssetFrom(options.artworkSrc));
        }

        if (assets.length === 0 || !running || !renderer) {
            return;
        }

        // Only assets whose texture actually uploaded are advertised, so a plugin is never activated for
        // an asset the graph cannot bind.
        const loaded = await loadTextures(assets.map((asset) => ({
            assetId: asset.id,
            src: 'src' in asset ? asset.src : '',
        })));

        if (!running || !renderer) {
            return;
        }

        const uploadedIds = new Set<string>();
        for (const texture of loaded) {
            const asset = assets.find((candidate) => candidate.id === texture.assetId);
            if (!asset || (asset.kind !== 'mask' && asset.kind !== 'album-art')) {
                continue;
            }

            renderer.uploadAsset(asset.id, asset.kind, texture.image);
            uploadedIds.add(asset.id);
        }

        const usable = assets.filter((asset) => uploadedIds.has(asset.id));
        if (usable.length === 0) {
            return;
        }

        renderer.setAssets(availableAssetIds(usable));
        renderer.rebuildCurrent(currentProfile());
    })();

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
        const deltaSeconds = frozen ? 0 : Math.min(wallDelta, MAXIMUM_FRAME_SECONDS);

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

        const buffer = options.bufferHealth?.();
        const previousLevel = performance.level;
        performance = advancePerformance(performance, {
            frameTimeMs: wallDelta * 1000,
            forwardBufferSeconds: buffer?.forwardBufferSeconds,
            bufferStalled: buffer?.stalled,
        });

        const profile = currentProfile();

        if (renderer) {
            // A track change reseeds the scene (section 6.4). A quality step that changes the grammar
            // rebuilds too, since the scene has to be assembled within the new budget. Freezing
            // mutations suppresses both, so a scene can be studied without shifting underneath.
            const grammarChanged = profileFor(previousLevel).reducedGrammar !== profile.reducedGrammar;
            const trackChanged = clock.generation !== lastRebuiltGeneration;
            const shouldRebuild = trackChanged || grammarChanged;

            if (shouldRebuild && !controls.freezeMutations) {
                lastRebuiltGeneration = clock.generation;
                const rebuilt = trackChanged
                    ? renderer.newScene(profile)
                    : renderer.rebuildCurrent(profile);
                if (rebuilt) {
                    activationHistory = renderer.activeInstanceIds().reduce(
                        (history, instanceId) => recordActivation(history, instanceId),
                        activationHistory,
                    );
                }
            }

            // Section 17: scenes evolve by mutation between track changes. The timer takes frozen-aware
            // delta, so a paused track does not bank mutations that all fire at once on resume.
            const step = advanceMutation(mutation, deltaSeconds, renderer.mutationPolicy());
            mutation = step.state;
            if (step.due && !controls.freezeMutations) {
                lastMutation = renderer.mutate(profile, clock.playbackTime);
                if (lastMutation !== 'none') {
                    activationHistory = recordActivation(activationHistory, `mutate:${lastMutation}`);
                }
            }

            const stats = renderer.renderFrame({
                clock,
                features: features.bus,
                deltaSeconds,
                profile,
                // Impacts are transient history, dropped alongside audio events on seek and track change.
                clearTransients: effects.includes('clear-analysis-history'),
                controls,
            });
            renderStats = { ...stats, problems: renderer.problems() };
        }

        if (now - lastReadoutTime >= 1000 / (options.readoutHz ?? READOUT_HZ)) {
            lastReadoutTime = now;
            onReadout({
                clock,
                frozen,
                bus: features.bus,
                latencySeconds: tap?.latencySeconds() ?? 0,
                contextState,
                analysisPath: tap?.analysisPath() ?? 'starting',
                flatlined: tap?.isFlatlined() ?? false,
                frameTimeMs: wallDelta * 1000,
                render: renderStats,
                renderFailure,
                performance: {
                    level: performance.level,
                    downgrades: performance.downgrades,
                    bufferConstrained: performance.bufferConstrained,
                    profile,
                },
                scene: renderer
                    ? {
                        themeId: renderer.themeId(),
                        pluginIds: renderer.activePluginIds(),
                        instanceIds: renderer.activeInstanceIds(),
                        resourceIds: renderer.resourceIds(),
                        edges: renderer.edgeSummary(),
                        assets: renderer.availableAssets(),
                        activationHistory,
                        estimatedTextureBytes: renderer.estimatedTextureBytes(),
                        lastMutation,
                        layerCount: renderer.layerCount(),
                        materialBranchCount: renderer.materialBranchCount(),
                        activeModulatorCount: renderer.activeModulatorCount(),
                        survivalPerSecond: renderer.persistence().survivalPerSecond,
                        motionScale: renderer.persistence().motionScale,
                    }
                    : undefined,
                gpu: renderer
                    ? {
                        ...renderer.gpuCapabilities(),
                        renderWidth: renderer.renderSize().width,
                        renderHeight: renderer.renderSize().height,
                    }
                    : undefined,
            });
        }

        frameHandle = requestAnimationFrame(frame);
    };

    frameHandle = requestAnimationFrame(frame);

    return {
        setControls(next) {
            controls = next;
        },

        newScene() {
            const rebuilt = renderer?.newScene(currentProfile()) ?? false;
            if (rebuilt && renderer) {
                activationHistory = renderer.activeInstanceIds().reduce<readonly string[]>(
                    (history, instanceId) => recordActivation(history, instanceId),
                    [],
                );
                lastMutation = 'scene';
                mutation = createMutationState();
            }
            return rebuilt;
        },

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
