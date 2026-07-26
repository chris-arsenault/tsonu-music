/**
 * Owns the canvas, device, runtime, and the active scene's plugin instances.
 *
 * Sits between the kernel loop and the device so the loop stays about time and the device stays about
 * GL. Handles canvas sizing and context-loss recovery, rebuilding GPU state from retained plugin
 * metadata rather than resetting the scene.
 */

import type { CompiledGraph } from '../core/graph';
import {
    advanceCrossfade,
    blendForCharacter,
    composeLayers,
    createLayer,
    crossfadesBetween,
    isCrossfadeComplete,
    type Crossfade,
    type VisualLayer,
} from '../core/layers';
import {
    persistenceSettings,
    DEFAULT_THEME_PERSISTENCE,
    type PersistenceSettings,
} from '../core/persistence';
import { COMPOSITE_BINDINGS, COMPOSITE_PARAMETERS } from '../core/composite-grade';
import { buildScenePalette, driftPalette, type ScenePalette } from '../core/palette';
import type { PaletteCharacter } from '../core/palettes';
import { resolveParameters } from '../core/parameters';
import { modulateParameters } from '../core/modulation';
import {
    advanceRetirement,
    beginRetirement,
    isRetired,
    retirementFeedbackParticipation,
    retirementOpacity,
    type Retirement,
} from '../core/deactivation';
import type { AudioFeatureBus } from '../core/features';
import type { PlaybackClock } from '../core/clock';
import type { QualityProfile } from '../core/performance';
import type { DiagnosticsControls } from '../core/diagnostics';
import { buildFirstViableScene, buildScene, variedThemeOrder } from '../core/scene-builder';
import { compileGraph } from '../core/graph';
import { distributeReactivity } from '../core/audio-mapping';
import { createRng, freshSceneEntropy, type Rng } from '../core/random';
import {
    decideMutation,
    type ActivePluginRecord,
    type MutationKind,
    type MutationPolicy,
    type SchedulerContext,
} from '../core/scheduler';
import { wireScene } from '../core/wiring';
import { assetResourceId, type AssetResource } from '../core/wiring';
import { createM1Registry } from '../plugins/registry';
import { satisfiableThemes } from '../plugins/themes';
import { PRESENT_SHADER, PRESENT_SHADER_ID } from '../plugins/postprocess/tone-mapper';
import { createDevice, MAX_PIXEL_RATIO, type Device } from './device';
import { createRuntime, type ActiveInstance, type RuntimeStats } from './runtime';
import type { DistributedBinding } from '../core/audio-mapping';
import type { ParameterBinding } from '../core/bindings';
import type { VisualPluginDefinition } from '../core/plugin';

export interface RendererFrame {
    clock: PlaybackClock;
    features: AudioFeatureBus;
    deltaSeconds: number;
    profile: QualityProfile;
    clearTransients?: boolean;
    controls?: DiagnosticsControls;
}

export interface Renderer {
    renderFrame(frame: RendererFrame): RuntimeStats;
    /** Compile errors and shader failures, for the diagnostics overlay. */
    problems(): string[];
    /** Rebuilds the current scene against changed assets or quality constraints. */
    rebuildCurrent(profile: QualityProfile): boolean;
    /** Discards the current scene and selects a fresh random one. */
    newScene(profile: QualityProfile): boolean;
    /** Replaces the resolvable asset set. Takes effect on the next rebuild. */
    setAssets(ids: readonly string[]): void;
    /** Uploads a loaded asset image so the graph can bind it. */
    uploadAsset(assetId: string, kind: 'album-art' | 'mask', image: HTMLImageElement): void;
    availableAssets(): readonly string[];
    /** Ids of the active plugins, for the diagnostics overlay. */
    activePluginIds(): string[];
    /** Instance ids in graph order, for the diagnostics overlay's disable controls. */
    activeInstanceIds(): string[];
    /** Every resource the graph allocates, so an intermediate one can be inspected. */
    resourceIds(): string[];
    /** Graph edges as `from -> to`, feedback marked. */
    edgeSummary(): string[];
    gpuCapabilities(): {
        floatRenderTargets: boolean;
        maxTextureSize: number;
        maxPixelRatio: number;
        contextLost: boolean;
    };
    renderSize(): { width: number; height: number };
    estimatedTextureBytes(): number;
    themeId(): string;
    /**
     * Applies one mutation (spec section 17). Returns what actually happened, which may be less than
     * asked for when no replacement is available.
     */
    mutate(profile: QualityProfile, playbackTime: number): MutationKind | 'none';
    /** Plugin ids active long enough to be replaced, with their instance ids. */
    activeRecords(): ActivePluginRecord[];
    mutationPolicy(): MutationPolicy;
    /** Layers the compositor is blending, for the diagnostics overlay. */
    layerCount(): number;
    /** Visible material producers participating before final post-processing. */
    materialBranchCount(): number;
    /** Audio-bound parameters also receiving concurrent slow modulation. */
    activeModulatorCount(): number;
    /** How strongly the composite accumulates and how far it is dragged, as of the last frame. */
    persistence(): PersistenceSettings;
    resize(): void;
    dispose(): void;
}

export type RendererFailure =
    | 'no-webgl2'
    | 'no-float-render-targets'
    | 'invalid-scene';

export type RendererResult =
    | { ok: true; renderer: Renderer }
    | { ok: false; failure: RendererFailure; detail?: string };

export interface RendererOptions {
    profile: QualityProfile;
    /**
     * Asset ids currently resolvable, for plugins declaring `requiredAssets`. An empty list is normal
     * and is what keeps artwork and masks optional rather than required.
     */
    assets?: readonly string[];
}

export function createRenderer(canvas: HTMLCanvasElement, options: RendererOptions): RendererResult {
    const device = createDevice(canvas);
    if (!device) {
        return { ok: false, failure: 'no-webgl2' };
    }

    if (!device.capabilities.floatRenderTargets) {
        device.dispose();
        return { ok: false, failure: 'no-float-render-targets' };
    }

    const registry = createM1Registry();
    const categories = new Set(registry.all().map((definition) => definition.category));
    const themes = satisfiableThemes(categories);
    const deviceCapabilities = ['float-textures', 'webgl2'];

    let assetIds: readonly string[] = options.assets ?? [];
    let assetResources: readonly AssetResource[] = [];

    function buildFromEntropy(entropy: string, profile: QualityProfile) {
        // A fixed fallback order made the first viable family win every track. Shuffle from the fresh
        // scene entropy so geometric, organic, collision, and image families all get a chance.
        const themeOrder = variedThemeOrder(entropy, themes);
        return buildFirstViableScene(
            entropy,
            themeOrder,
            {
                available: registry.all(),
                assets: assetIds,
                assetResources,
                capabilities: deviceCapabilities,
                history: {},
                playbackTime: 0,
            },
            profile,
        );
    }

    function buildFresh(profile: QualityProfile) {
        return buildFromEntropy(freshSceneEntropy(), profile);
    }

    function buildFreshBranch(profile: QualityProfile) {
        const entropy = freshSceneEntropy();
        return buildScene(
            entropy,
            scene.theme,
            {
                available: registry.all(),
                assets: assetIds,
                assetResources,
                capabilities: deviceCapabilities,
                history: {},
                playbackTime: lastClock.playbackTime,
            },
            profile,
        );
    }

    const initial = buildFresh(options.profile);
    if (!initial.ok) {
        device.dispose();
        return { ok: false, failure: 'invalid-scene', detail: initial.failure.detail };
    }

    const runtime = createRuntime(device, PRESENT_SHADER_ID);
    device.registerShader(PRESENT_SHADER);

    let scene = initial.scene;
    let instances = instantiate(
        device,
        scene.graph,
        scene.bindings,
        [],
        scene.parameterOverrides,
        scene.entropy,
    ).instances;
    let layers = buildLayers(scene.graph);
    let crossfades: readonly Crossfade[] = [];
    runtime.setGraph(scene.graph, instances);

    let lostHandled = false;
    /** Last frame's composite settings, for the diagnostics overlay. */
    let lastPersistence: PersistenceSettings = {
        survivalPerSecond: 0,
        motionScale: 0,
        transientPunch: 0,
    };

    /**
     * The compositor's own parameter state, advanced each frame exactly as a plugin instance's is.
     *
     * Held here rather than inside the runtime because it belongs to the scene: a new scene draws a
     * new colour scheme, and these are the values grading it.
     */
    let gradeParameters: Record<string, number> = { ...COMPOSITE_PARAMETERS };
    let basePalette: ScenePalette = drawPalette();

    function colourStrength(theme: typeof scene.theme): number {
        return theme.colorPolicy?.strength ?? 0.75;
    }

    /**
     * Which family of schemes the theme's colour policy admits.
     *
     * Section 16 gives a theme a colour source, and it was recorded and unread. A policy naming
     * complementary colour should not draw the same schemes as one naming a curated palette.
     */
    function paletteCharacter(): PaletteCharacter | undefined {
        switch (scene.theme.colorPolicy?.source) {
            case 'complementary':
                return 'high-contrast';
            case 'curated':
                return 'hue-anchored';
            case 'album-palette':
                // Artwork brings its own colour, so the scheme around it stays dark and lets it read.
                return 'dark-dominant';
            default:
                return undefined;
        }
    }

    function drawPalette(): ScenePalette {
        return buildScenePalette(
            scene.entropy,
            colourStrength(scene.theme),
            4,
            paletteCharacter(),
        );
    }

    /** Redraws the scheme when the scene changes, so a new composition arrives in new colours. */
    function refreshPalette(): void {
        basePalette = drawPalette();
        gradeParameters = { ...COMPOSITE_PARAMETERS };
    }
    // Last clock seen, so a retirement triggered by a rebuild can be given real playback context.
    let lastClock: PlaybackClock = {
        trackId: null,
        playbackTime: 0,
        duration: 0,
        state: 'idle',
        generation: 0,
    };

    function sizeCanvas(): void {
        // Re-read rather than taken from the capabilities snapshot, which is captured once when the
        // device is created. Moving the window to a display with a different pixel density, or
        // zooming, changes `devicePixelRatio` and fires a resize — which then recomputed the backing
        // store at the ratio from session start and rendered soft for the rest of the session.
        const ratio = Math.min(
            MAX_PIXEL_RATIO,
            typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
        );
        const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const height = Math.max(1, Math.round(canvas.clientHeight * ratio));

        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
    }

    sizeCanvas();

    // Bound after the capability guards above, so the closures below need no further narrowing.
    const activeDevice: Device = device;

    let mutationCount = 0;
    /** Plugins finishing their deactivation policy. Rendered until each retirement completes. */
    const retiring: { active: ActiveInstance; retirement: Retirement }[] = [];
    /** When each instance entered the scene, so mutation can respect the minimum plugin age. */
    const activatedAt = new Map<string, number>();

    const schedulerContext = (playbackTime: number, profile: QualityProfile): SchedulerContext => ({
        available: registry.all(),
        theme: scene.theme,
        assets: assetIds,
        // Selection needs the types too, not just the ids: a plugin whose required input can only come
        // from an asset is otherwise judged unsatisfiable and never chosen as a replacement.
        assetResources,
        capabilities: deviceCapabilities,
        history: {},
        playbackTime,
        allowHighCost: profile.expensivePrimary,
        allowDominant: profile.expensivePrimary,
    });

    const records = (): ActivePluginRecord[] => instances.map((entry) => ({
        instanceId: entry.instanceId,
        pluginId: entry.node.definition.id,
        activationTime: activatedAt.get(entry.instanceId) ?? 0,
    }));

    /** Re-runs reactivity distribution in place. No instance is torn down. */
    const redistribute = (rng: Rng): void => {
        const bindings = distributeReactivity(scene.wired.nodes, rng);
        scene = { ...scene, bindings };

        for (const entry of instances) {
            entry.bindings = bindingsFor(bindings, entry.instanceId, entry.node.definition);
        }
    };

    /**
     * Replaces one plugin in the current scene, keeping every other plugin's instance and state.
     *
     * Rebuilt through the normal wire-and-compile path so the swap is validated exactly as an assembled
     * scene would be, and rejected rather than applied if the result does not compile.
     */
    const swapPlugin = (instanceId: string, replacementId: string): boolean => {
        const target = instances.find((entry) => entry.instanceId === instanceId);
        const replacement = registry.get(replacementId);
        if (!target || !replacement) {
            return false;
        }

        const plugins = scene.plugins.map((definition) =>
            definition.id === target.node.definition.id ? replacement : definition);

        const wired = wireScene(plugins, assetResources);
        if (wired.unsatisfied.length > 0) {
            return false;
        }

        const compiled = compileGraph(wired.nodes, wired.edges, wired.present, wired.assetBindings);
        if (!compiled.ok) {
            return false;
        }

        return applyBuild({
            ok: true,
            scene: { ...scene, plugins, wired, graph: compiled.graph },
        });
    };

    /**
     * Layers for plugins still retiring, at the opacity their policy dictates.
     *
     * A handoff-feedback retirement raises its feedback participation as it fades, which is how a
     * departing image is left in the feedback buffer for its replacement rather than lost.
     */
    const retiringLayers = (): VisualLayer[] => retiring.flatMap((entry) => {
        const colour = entry.active.node.definition.outputs.find((port) => port.type === 'color-texture');
        const resource = colour && entry.active.node.outputs[colour.name];
        if (!resource) {
            return [];
        }

        return [createLayer(`retiring:${entry.active.instanceId}`, resource, {
            order: 1000,
            blendMode: 'screen',
            opacity: retirementOpacity(entry.retirement),
            feedbackParticipation: retirementFeedbackParticipation(entry.retirement),
        })];
    });

    /** Swaps in a newly built scene, keeping the current one if the build failed. */
    const applyBuild = (
        result: ReturnType<typeof buildFromEntropy>,
        preserveInstances = true,
    ): boolean => {
        if (!result.ok) {
            // A failed rebuild is not a reason to stop rendering what already works.
            console.warn('[visualizer] scene rebuild failed', result.failure.detail);
            return false;
        }

        const previousInstances = instances;
        scene = result.scene;
        // Incremental rebuilds reuse unchanged instances. A genuinely new scene recreates all of them,
        // even when random selection happens to choose some of the same plugin ids.
        const rebuilt = instantiate(
            activeDevice,
            scene.graph,
            scene.bindings,
            preserveInstances ? previousInstances : [],
            scene.parameterOverrides,
            scene.entropy,
        );
        const departingInstances = preserveInstances ? rebuilt.retired : previousInstances;

        for (const departing of departingInstances) {
            const policy = departing.node.definition.deactivationPolicy ?? 'immediate';
            departing.instance.deactivate({ policy, clock: lastClock });

            const retirement = beginRetirement(departing.instanceId, policy);
            if (isRetired(retirement)) {
                // Immediate policies have nothing to finish.
                departing.instance.destroy();
                continue;
            }

            // Kept alive and rendering until its policy completes, so particles drain and frozen frames
            // dissolve instead of vanishing between frames.
            retiring.push({ active: departing, retirement });
        }

        instances = rebuilt.instances;

        // Departures are forgotten before arrivals are recorded, not after.
        //
        // Instance ids are the definition id and an index, so a rebuild that replaces the whole
        // graph — which is every non-preserving rebuild — routinely lands a new plugin on an id a
        // departing one just gave up. Setting first and deleting second removed the arrival's
        // timestamp along with the departure's, leaving it at the epoch. `ToneMapper` has an
        // activation weight of ten and is in nearly every scene, so it drew that id constantly. The
        // scheduler then read a one-second-old plugin as arbitrarily mature and its minimum plugin
        // age, which exists to stop the graph churning, did nothing.
        // A timestamp survives only where the same definition holds the same id: that is the same
        // plugin still running, not a new one inheriting a slot.
        const arriving = new Map(
            instances.map((entry) => [entry.instanceId, entry.node.definition.id] as const),
        );
        for (const departing of departingInstances) {
            if (arriving.get(departing.instanceId) !== departing.node.definition.id) {
                activatedAt.delete(departing.instanceId);
            }
        }
        for (const entry of instances) {
            if (!activatedAt.has(entry.instanceId)) {
                activatedAt.set(entry.instanceId, lastClock.playbackTime);
            }
        }
        if (!preserveInstances) {
            mutationCount = 0;
        }

        // Section 10: incoming branches fade up as the outgoing ones fade down.
        //
        // The whole subsystem existed — the type, the weighting, the advance, the completion test,
        // and the runtime's read of the field — and the only caller of `renderFrame` never set it, so
        // no crossfade had ever run. Transitions were handled entirely by the retirement path, which
        // drains a plugin's own simulation but does nothing about a new branch appearing at full
        // opacity in a single frame.
        const departingLayers = layers;
        layers = buildLayers(scene.graph);
        crossfades = crossfadesBetween(departingLayers, layers);
        runtime.setGraph(scene.graph, instances);

        if (!preserveInstances) {
            // A genuinely new scene, so a new colour scheme. An incremental rebuild keeps the current
            // one, or swapping one plugin would recolour everything around it.
            refreshPalette();
        }

        return true;
    };

    return {
        ok: true,
        renderer: {
            renderFrame(frame) {
                // Section 21.3: nothing renders when suspended, at the ladder's floor or page-hidden.
                if (frame.profile.suspended) {
                    return { passesExecuted: 0, targetsAllocated: 0, skippedPasses: 0, suppressedPlugins: 0, pendingShaders: 0 };
                }

                if (device.isLost()) {
                    // Rebuild once per loss. Plugin and asset metadata is retained, so the scene
                    // reappears rather than needing reassembly.
                    if (!lostHandled) {
                        lostHandled = true;
                        runtime.reinitialize();
                        device.registerShader(PRESENT_SHADER);
                    }
                    return { passesExecuted: 0, targetsAllocated: 0, skippedPasses: 0, suppressedPlugins: 0, pendingShaders: 0 };
                }

                lostHandled = false;
                lastClock = frame.clock;
                sizeCanvas();

                // Frozen-aware, so a retirement holds mid-drain while the track is paused rather than
                // completing invisibly.
                for (let index = retiring.length - 1; index >= 0; index -= 1) {
                    const entry = retiring[index];
                    entry.retirement = advanceRetirement(entry.retirement, frame.deltaSeconds);

                    if (isRetired(entry.retirement)) {
                        entry.active.instance.destroy();
                        retiring.splice(index, 1);
                    }
                }

                const composedLayers = [...layers, ...retiringLayers()];

                // A frozen clock passes zero delta, so a transition holds mid-fade rather than
                // completing while paused.
                crossfades = crossfades
                    .map((crossfade) => advanceCrossfade(crossfade, frame.deltaSeconds))
                    .filter((crossfade) => !isCrossfadeComplete(crossfade));

                // The compositor's parameters advance exactly as a plugin instance's do: bindings
                // resolved against the live bus, then the same role-aware slow modulation.
                gradeParameters = resolveParameters(
                    gradeParameters,
                    COMPOSITE_BINDINGS,
                    frame.features,
                    frame.deltaSeconds,
                );
                const grade = modulateParameters(
                    gradeParameters,
                    COMPOSITE_BINDINGS,
                    frame.clock.playbackTime,
                    frame.features.continuous.transient,
                    0,
                );

                lastPersistence = persistenceSettings({
                    themePersistence:
                        scene.theme.targetCharacter?.persistence ?? DEFAULT_THEME_PERSISTENCE,
                    layerWeights: composeLayers(composedLayers).feedbackContributors
                        .map((contributor) => contributor.weight),
                    bass: frame.features.continuous.bass,
                    rms: frame.features.continuous.rms,
                    transient: frame.features.continuous.transient,
                    reducedMotion: frame.profile.reducedMotion,
                });

                return runtime.renderFrame({
                    clock: frame.clock,
                    features: frame.features,
                    deltaSeconds: frame.deltaSeconds,
                    qualityScale: frame.profile.renderScale,
                    renderWidth: canvas.width,
                    renderHeight: canvas.height,
                    layers: composedLayers,
                    crossfades,
                    // Section 11 gives every layer a feedback participation weight and makes injection
                    // the compositor's duty. The weights were computed and consumed by nothing; this is
                    // where they finally decide how strongly the scene accumulates.
                    persistence: lastPersistence,
                    // Walked along the scheme's own colours by the integrated drift, rather than
                    // hue-rotated: rotating a designed palette destroys the relationships that made
                    // it designed within a few seconds.
                    palette: driftPalette(basePalette, grade.hueDrift ?? 0),
                    grade,
                    // A seek or a new track lands on unrelated material; keeping the old image in the
                    // accumulation would drag the previous passage across the new one.
                    clearAccumulation: frame.clearTransients,
                    clearTransients: frame.clearTransients,
                    controls: frame.controls,
                    profile: frame.profile,
                    retiring: retiring.map((entry) => ({
                        active: entry.active,
                        opacity: retirementOpacity(entry.retirement),
                        emitting: entry.retirement.emitting,
                    })),
                });
            },

            problems() {
                return device.shaderErrors().map((error) => `${error.id}: ${error.message}`);
            },

            rebuildCurrent(profile) {
                return applyBuild(buildFromEntropy(scene.entropy, profile));
            },

            newScene(profile) {
                return applyBuild(buildFresh(profile), false);
            },

            activeRecords() {
                return records();
            },

            mutationPolicy() {
                return scene.theme.mutationPolicy;
            },

            layerCount() {
                return layers.length;
            },

            materialBranchCount() {
                return scene.plugins.filter((definition) =>
                    definition.category !== 'postprocess'
                    && definition.outputs.some((port) => port.type === 'color-texture')).length;
            },

            activeModulatorCount() {
                return scene.bindings.reduce(
                    (total, entry) => total + entry.bindings.length,
                    0,
                );
            },

            persistence() {
                return lastPersistence;
            },

            mutate(profile, playbackTime) {
                const policy = scene.theme.mutationPolicy;
                // Stable only for this active scene, so incremental choices remain coherent.
                const rng = createRng(`${scene.entropy}:mutation:${mutationCount}`);
                mutationCount += 1;

                const decision = decideMutation(rng, records(), schedulerContext(playbackTime, profile), policy);

                switch (decision.kind) {
                    case 'scene':
                        // Rare by design: this is the one that discards accumulated state.
                        return applyBuild(buildFresh(profile), false)
                            ? 'scene'
                            : 'none';

                    case 'branch':
                        // Rebuild inside the current family and retain any instances the new branch
                        // still uses. This changes several connected nodes while preserving compatible
                        // feedback and simulation state elsewhere.
                        return applyBuild(buildFreshBranch(profile))
                            ? 'branch'
                            : 'none';

                    case 'plugin': {
                        if (!decision.targetInstanceId || !decision.replacement) {
                            return 'none';
                        }

                        const swapped = swapPlugin(decision.targetInstanceId, decision.replacement.id);
                        return swapped ? decision.kind : 'none';
                    }

                    case 'parameter':
                        // Redistributes which feature drives which parameter. Nothing is torn down, so
                        // every simulator and feedback buffer keeps running.
                        redistribute(rng);
                        return 'parameter';
                }
            },

            setAssets(ids) {
                assetIds = ids;
            },

            uploadAsset(assetId, kind, image) {
                const resource = assetResourceId(assetId);
                device.uploadAssetTexture(resource, image);

                // Album art enters as colour; a mask enters as a mask texture, which is also accepted by
                // anything wanting a distance field's single channel.
                const type = kind === 'mask' ? 'mask-texture' : 'color-texture';
                if (!assetResources.some((entry) => entry.resource === resource)) {
                    assetResources = [...assetResources, { resource, type }];
                }
            },

            availableAssets() {
                return assetIds;
            },

            activePluginIds() {
                return scene.plugins.map((definition) => definition.id);
            },

            activeInstanceIds() {
                return scene.graph.order.map((node) => node.instanceId);
            },

            resourceIds() {
                return scene.graph.resources.map((resource) => resource.id);
            },

            edgeSummary() {
                return [
                    ...scene.wired.edges.map((edge) =>
                        `${edge.from.instanceId}.${edge.from.port} -> ${edge.to.instanceId}.${edge.to.port}`
                        + (edge.feedback ? ' (feedback)' : '')),
                    ...scene.wired.assetBindings.map((binding) =>
                        `${binding.resource} -> ${binding.instanceId}.${binding.port} (asset)`),
                ];
            },

            gpuCapabilities() {
                return {
                    floatRenderTargets: device.capabilities.floatRenderTargets,
                    maxTextureSize: device.capabilities.maxTextureSize,
                    maxPixelRatio: device.capabilities.maxPixelRatio,
                    contextLost: device.isLost(),
                };
            },

            renderSize() {
                return { width: canvas.width, height: canvas.height };
            },

            estimatedTextureBytes() {
                // Half-float RGBA is eight bytes per pixel; a ping-ponged resource counts twice.
                const perTarget = canvas.width * canvas.height * 8;
                const pingPong = scene.graph.pingPong.length;
                return (scene.graph.resources.length + pingPong) * perTarget;
            },

            themeId() {
                return scene.theme.id;
            },

            resize() {
                sizeCanvas();
            },

            dispose() {
                // Retiring instances are the renderer's, not the runtime's, so `runtime.dispose()`
                // never reached them. Closing the modal mid-drain skipped `destroy()` on every plugin
                // still finishing its retirement, and anything they owned outside the GL device
                // outlived the visualizer.
                for (const entry of retiring) {
                    entry.active.instance.destroy();
                }
                retiring.length = 0;

                runtime.dispose();
                device.dispose();
            },
        },
    };
}

/**
 * Builds the active instance list for a graph, reusing any previous instance whose id and plugin are
 * unchanged.
 *
 * Reuse is what makes incremental mutation meaningful: swapping one plugin must not reset the particle
 * state, feedback accumulation, or smoothed parameters of every other plugin in the scene.
 */
function instantiate(
    device: Device,
    graph: CompiledGraph,
    bindings: readonly DistributedBinding[],
    previous: readonly ActiveInstance[] = [],
    overrides: Record<string, Record<string, number>> = {},
    sceneEntropy = '',
): { instances: ActiveInstance[]; retired: ActiveInstance[] } {
    const reusable = new Map(previous.map((entry) => [entry.instanceId, entry]));
    const kept = new Set<string>();

    const instances = graph.order.map((node) => {
        const definition = node.definition;
        const existing = reusable.get(node.instanceId);

        if (existing && existing.node.definition.id === definition.id) {
            kept.add(node.instanceId);
            // Carries state and smoothed parameters across; only the graph position is refreshed.
            return {
                ...existing,
                node,
                bindings: bindingsFor(bindings, node.instanceId, definition),
            };
        }

        return createInstance(
            device,
            node,
            definition,
            bindings,
            overrides[node.instanceId],
            sceneEntropy,
        );
    });

    return {
        instances,
        retired: previous.filter((entry) => !kept.has(entry.instanceId)),
    };
}

function createInstance(
    device: Device,
    node: CompiledGraph['order'][number],
    definition: CompiledGraph['order'][number]['definition'],
    bindings: readonly DistributedBinding[],
    overrides: Record<string, number> = {},
    sceneEntropy = '',
): ActiveInstance {
    {
        const instanceSeed = seedFor(`${sceneEntropy}:${node.instanceId}`);
        const instance = definition.create({
            instanceId: node.instanceId,
            seed: instanceSeed,
            registerShader: (source) => device.registerShader(source),
        });

        void instance.initialize();
        instance.activate({
            clock: { trackId: null, playbackTime: 0, duration: 0, state: 'idle', generation: 0 },
            parameters: definition.parameters ?? {},
        });

        return {
            instanceId: node.instanceId,
            seed: instanceSeed,
            instance,
            node,
            parameters: { ...(definition.parameters ?? {}), ...overrides },
            // The scheduler's redistributed bindings, so reactivity is spread rather than every plugin
            // reading the feature its author happened to pick.
            bindings: bindingsFor(bindings, node.instanceId, definition),
        };
    }
}

/**
 * The bindings for one instance, falling back to what its plugin ships.
 *
 * Matched by instance, so two instances of one definition hold the two distinct assignments
 * distribution made for them. Matched by definition, both read the first entry and moved together.
 */
function bindingsFor(
    distributed: readonly DistributedBinding[],
    instanceId: string,
    definition: VisualPluginDefinition,
): readonly ParameterBinding[] | undefined {
    return distributed.find((entry) => entry.instanceId === instanceId)?.bindings
        ?? definition.defaultBindings;
}

/**
 * The layer stack the compositor blends.
 *
 * Every plugin producing a colour output that nothing else consumes becomes a layer, so a scene with two
 * parallel visual branches genuinely composites rather than presenting only the last one. Order follows
 * graph order, and a plugin whose material is meant to persist contributes to feedback in proportion to
 * its declared persistence.
 */
function buildLayers(graph: CompiledGraph): VisualLayer[] {
    const consumed = new Set<string>();
    for (const node of graph.order) {
        for (const resource of Object.values(node.inputs)) {
            consumed.add(resource);
        }
    }

    const layers: VisualLayer[] = [];

    graph.order.forEach((node, index) => {
        for (const port of node.definition.outputs) {
            if (port.type !== 'color-texture') {
                continue;
            }

            const resource = node.outputs[port.name];
            // A resource something downstream reads is an intermediate, not a layer.
            if (!resource || consumed.has(resource)) {
                continue;
            }

            layers.push(createLayer(node.instanceId, resource, {
                order: index,
                // Chosen from what the plugin says it produces. Every layer above the base used to
                // blend with `screen`, which is a lighten operator: parallel branches accumulated
                // toward white and read as superposition rather than as interaction.
                blendMode: layers.length === 0
                    ? 'normal'
                    : blendForCharacter(node.definition.character),
                feedbackParticipation: node.definition.character.persistence,
            }));
        }
    });

    if (layers.length === 0 && graph.present) {
        // Everything was consumed by something, so present the graph's own output.
        layers.push(createLayer('output', graph.present, { order: 0 }));
    }

    return layers;
}

function seedFor(instanceId: string): number {
    let hash = 2166136261;
    for (let index = 0; index < instanceId.length; index += 1) {
        hash ^= instanceId.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0) / 4294967295;
}
