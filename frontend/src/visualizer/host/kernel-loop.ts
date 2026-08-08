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
import type { AuthoredProblem, AuthoredScene } from '../core/authored-scene';
import type { ParameterBinding } from '../core/bindings';
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
        /**
         * Gain of each cycle in the live scene, largest first.
         *
         * This was the kernel accumulation's survival per second, which described one buffer that no
         * longer exists (ADR-0013). How long a scene remembers is now a property of its loops: at 0.9
         * a cycle settles at ten copies of what enters it, and at one or above it never settles.
         */
        loopGains: readonly number[];
        /** Every live instance's resolved parameters, so the editor can show them moving. */
        parameters: Record<string, Record<string, number>>;
        /** The document in control, if one is. */
        authored?: AuthoredScene;
        /** Why the last document did not resolve, anchored to its nodes and edges. */
        problems: readonly AuthoredProblem[];
    };
    gpu?: {
        floatRenderTargets: boolean;
        maxTextureSize: number;
        maxPixelRatio: number;
        renderWidth: number;
        renderHeight: number;
        /** True while the GL context is gone. The fallback ladder reads this to pick a tier. */
        contextLost: boolean;
    };
}

/** Controls the overlay drives. Read every frame, so a change takes effect immediately. */
export interface KernelControlHandle {
    setControls(controls: DiagnosticsControls): void;
    /** Discards the current composition and selects a fresh random scene. */
    newScene(): boolean;

    /** Freezes whatever is rendering into an editable document. */
    captureScene(): AuthoredScene | undefined;
    /** Puts a document in control. Returns why it could not be, or an empty list. */
    setAuthoredScene(document: AuthoredScene): AuthoredProblem[];
    /** Hands the scene back to the scheduler. */
    clearAuthoredScene(): boolean;
    /** The document in control, if any. */
    authoredScene(): AuthoredScene | undefined;
    /** Writes one parameter on one live node, taking effect next frame with no teardown. */
    setNodeParameter(nodeId: string, parameter: string, value: number): boolean;
    /** Replaces what drives one live node's parameters. */
    setNodeBindings(nodeId: string, bindings: readonly ParameterBinding[]): boolean;
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
    /** Milliseconds the last frame spent inside `renderFrame`. Drives the quality ladder. */
    let renderCostMs = 0;

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

        // A scene under study is rendered at full quality whatever the ladder thinks.
        //
        // From level five the ladder stops reducing resolution and starts dropping whole plugins, so
        // a graph being examined would lose the node in question the moment frame time slipped, and
        // the picture would change for a reason nothing on screen accounts for. The ladder's own
        // reading still advances and is still reported; it simply does not reach the graph.
        const profile = profileFor(controls.authoring ? 0 : performance.level);
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
            // The cost of the previous frame's render, not the interval between frames.
            //
            // The interval is floored by the display's refresh rate, so on a 60 Hz panel it cannot go
            // below 16.7 ms however little work the frame did — and the recovery budget is 12 ms.
            // Recovery was therefore unreachable by construction: the ladder only ever descended, and
            // one hiccup was permanent. Observed dropping 0 to 1 to 3 to 6 to 9 with no return, which
            // matters because level 6 suppresses the particle renderer outright, so particles vanish
            // from a scene that still lists them.
            //
            // Measuring the work makes both budgets mean what they are named. It lags by a frame,
            // since the sample is taken before this frame renders; against counters of thirty and a
            // hundred and eighty frames that is immaterial.
            frameTimeMs: renderCostMs,
            forwardBufferSeconds: buffer?.forwardBufferSeconds,
            bufferStalled: buffer?.stalled,
        });

        const profile = currentProfile();

        // Nothing is rebuilt or mutated while suspended, because nothing renders while suspended.
        //
        // `renderFrame` returns before the retirement drain when the profile is suspended, but the
        // mutation timer below kept running and kept pushing entries onto the retiring list that were
        // never advanced and never destroyed. The rebuild test fed it: the suspended profile is the
        // ladder's last rung and declares a reduced grammar, so comparing it against the previous
        // *level* reported a grammar change on every frame the page was hidden, rebuilding the entire
        // scene each time.
        if (renderer && !profile.suspended) {
            // A track change reseeds the scene (section 6.4). A quality step that changes the grammar
            // rebuilds too, since the scene has to be assembled within the new budget. Freezing
            // mutations suppresses both, so a scene can be studied without shifting underneath.
            const grammarChanged = profileFor(previousLevel).reducedGrammar !== profile.reducedGrammar;
            const trackChanged = clock.generation !== lastRebuiltGeneration;
            const shouldRebuild = trackChanged || grammarChanged;

            // A document owns the graph while it is in control, so a track change reseeds the clock
            // and the audio and leaves the scene exactly where it is.
            if (shouldRebuild && !controls.freezeMutations && !controls.authoring) {
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
            if (step.due && !controls.freezeMutations && !controls.authoring) {
                lastMutation = renderer.mutate(profile, clock.playbackTime);
                if (lastMutation !== 'none') {
                    activationHistory = recordActivation(activationHistory, `mutate:${lastMutation}`);
                }
            }

            const renderStart = globalThis.performance.now();
            const stats = renderer.renderFrame({
                clock,
                features: features.bus,
                deltaSeconds,
                profile,
                // Impacts are transient history, dropped alongside audio events on seek and track change.
                clearTransients: effects.includes('clear-analysis-history'),
                controls,
            });
            renderCostMs = globalThis.performance.now() - renderStart;
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
                        loopGains: [...renderer.loopGains()].sort((left, right) => right - left),
                        parameters: renderer.liveParameters(),
                        authored: renderer.authoredScene(),
                        problems: renderer.sceneProblems(),
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

        captureScene() {
            return renderer?.captureCurrentScene();
        },

        setAuthoredScene(document) {
            if (!renderer) {
                return [{ kind: 'compile', detail: 'the renderer is not running' }];
            }

            const problems = renderer.setAuthoredScene(document);
            if (problems.length === 0) {
                // The scheduler's timers are meaningless while a document is in control, and leaving
                // them running would bank a mutation that fires the moment it is handed back.
                mutation = createMutationState();
                lastMutation = 'none';
                lastRebuiltGeneration = clock.generation;
            }

            return problems;
        },

        clearAuthoredScene() {
            const cleared = renderer?.clearAuthoredScene(currentProfile()) ?? false;
            if (cleared) {
                mutation = createMutationState();
                lastMutation = 'scene';
                lastRebuiltGeneration = clock.generation;
            }

            return cleared;
        },

        authoredScene() {
            return renderer?.authoredScene();
        },

        setNodeParameter(nodeId, parameter, value) {
            return renderer?.setNodeParameter(nodeId, parameter, value) ?? false;
        },

        setNodeBindings(nodeId, bindings) {
            return renderer?.setNodeBindings(nodeId, bindings) ?? false;
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
