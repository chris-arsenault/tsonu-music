/**
 * Owns the canvas, device, runtime, and the active scene's plugin instances.
 *
 * Sits between the kernel loop and the device so the loop stays about time and the device stays about
 * GL. Handles canvas sizing and context-loss recovery, rebuilding GPU state from retained plugin
 * metadata rather than resetting the scene.
 */

import type { CompiledGraph } from '../core/graph';
import { createLayer, type VisualLayer } from '../core/layers';
import type { AudioFeatureBus } from '../core/features';
import type { PlaybackClock } from '../core/clock';
import type { QualityProfile } from '../core/performance';
import type { DiagnosticsControls } from '../core/diagnostics';
import { buildFirstViableScene } from '../core/scene-builder';
import { assetResourceId, type AssetResource } from '../core/wiring';
import { sceneSeed } from '../core/random';
import { createM1Registry } from '../plugins/registry';
import { satisfiableThemes } from '../plugins/themes';
import { PRESENT_SHADER, PRESENT_SHADER_ID } from '../plugins/postprocess/tone-mapper';
import { createDevice, type Device } from './device';
import { createRuntime, type ActiveInstance, type RuntimeStats } from './runtime';

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
    /** Rebuilds the scene for a new seed, on track change or scene mutation. */
    rebuild(trackId: string | null, generation: number, profile: QualityProfile): boolean;
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
    gpuCapabilities(): { floatRenderTargets: boolean; maxTextureSize: number; maxPixelRatio: number };
    renderSize(): { width: number; height: number };
    estimatedTextureBytes(): number;
    themeId(): string;
    seed(): string;
    /** Rebuilds from an explicit seed, so a reported scene can be reproduced exactly. */
    rebuildFromSeed(seed: string, profile: QualityProfile): boolean;
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
    trackId: string | null;
    generation: number;
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

    function buildFromSeed(seed: string, profile: QualityProfile) {
        return buildFirstViableScene(
            seed,
            themes,
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

    function build(trackId: string | null, generation: number, profile: QualityProfile) {
        return buildFromSeed(sceneSeed(trackId, generation), profile);
    }

    const initial = build(options.trackId, options.generation, options.profile);
    if (!initial.ok) {
        device.dispose();
        return { ok: false, failure: 'invalid-scene', detail: initial.failure.detail };
    }

    const runtime = createRuntime(device, PRESENT_SHADER_ID);
    device.registerShader(PRESENT_SHADER);

    let scene = initial.scene;
    let instances = instantiate(device, scene.graph);
    let layers = buildLayers(scene.graph);
    runtime.setGraph(scene.graph, instances);

    let lostHandled = false;

    function sizeCanvas(): void {
        const ratio = device!.capabilities.maxPixelRatio;
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

    /** Swaps in a newly built scene, keeping the current one if the build failed. */
    const applyBuild = (result: ReturnType<typeof buildFromSeed>): boolean => {
        if (!result.ok) {
            // A failed rebuild is not a reason to stop rendering what already works.
            console.warn('[visualizer] scene rebuild failed', result.failure.detail);
            return false;
        }

        runtime.dispose();
        scene = result.scene;
        instances = instantiate(activeDevice, scene.graph);
        layers = buildLayers(scene.graph);
        runtime.setGraph(scene.graph, instances);

        return true;
    };

    return {
        ok: true,
        renderer: {
            renderFrame(frame) {
                // Section 21.3: nothing renders when suspended, at the ladder's floor or page-hidden.
                if (frame.profile.suspended) {
                    return { passesExecuted: 0, targetsAllocated: 0, skippedPasses: 0 };
                }

                if (device.isLost()) {
                    // Rebuild once per loss. Plugin and asset metadata is retained, so the scene
                    // reappears rather than needing reassembly.
                    if (!lostHandled) {
                        lostHandled = true;
                        runtime.reinitialize();
                        device.registerShader(PRESENT_SHADER);
                    }
                    return { passesExecuted: 0, targetsAllocated: 0, skippedPasses: 0 };
                }

                lostHandled = false;
                sizeCanvas();

                return runtime.renderFrame({
                    clock: frame.clock,
                    features: frame.features,
                    deltaSeconds: frame.deltaSeconds,
                    qualityScale: frame.profile.renderScale,
                    renderWidth: canvas.width,
                    renderHeight: canvas.height,
                    layers,
                    clearTransients: frame.clearTransients,
                    controls: frame.controls,
                });
            },

            problems() {
                return device.shaderErrors().map((error) => `${error.id}: ${error.message}`);
            },

            rebuild(trackId, generation, profile) {
                return applyBuild(build(trackId, generation, profile));
            },

            rebuildFromSeed(seed, profile) {
                return applyBuild(buildFromSeed(seed, profile));
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

            seed() {
                return scene.seed;
            },

            resize() {
                sizeCanvas();
            },

            dispose() {
                runtime.dispose();
                device.dispose();
            },
        },
    };
}

function instantiate(device: Device, graph: CompiledGraph): ActiveInstance[] {
    return graph.order.map((node) => {
        const definition = node.definition;
        const instance = definition.create({
            instanceId: node.instanceId,
            seed: seedFor(node.instanceId),
            registerShader: (source) => device.registerShader(source),
        });

        void instance.initialize();
        instance.activate({
            clock: { trackId: null, playbackTime: 0, duration: 0, state: 'idle', generation: 0 },
            parameters: definition.parameters ?? {},
        });

        return {
            instanceId: node.instanceId,
            instance,
            node,
            parameters: { ...(definition.parameters ?? {}) },
        };
    });
}

/**
 * One layer for the presented resource. The scheduler builds richer stacks in M2; the compositor
 * already handles order, blending, and crossfades regardless of how many arrive.
 */
function buildLayers(graph: CompiledGraph): VisualLayer[] {
    return graph.present ? [createLayer('output', graph.present, { order: 0 })] : [];
}

function seedFor(instanceId: string): number {
    let hash = 2166136261;
    for (let index = 0; index < instanceId.length; index += 1) {
        hash ^= instanceId.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0) / 4294967295;
}
