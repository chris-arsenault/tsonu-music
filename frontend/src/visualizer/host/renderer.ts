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
import { buildFirstViableScene } from '../core/scene-builder';
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
}

export interface Renderer {
    renderFrame(frame: RendererFrame): RuntimeStats;
    /** Compile errors and shader failures, for the diagnostics overlay. */
    problems(): string[];
    /** Rebuilds the scene for a new seed, on track change or scene mutation. */
    rebuild(trackId: string | null, generation: number, profile: QualityProfile): boolean;
    /** Replaces the resolvable asset set. Takes effect on the next rebuild. */
    setAssets(ids: readonly string[]): void;
    availableAssets(): readonly string[];
    /** Ids of the active plugins, for the diagnostics overlay. */
    activePluginIds(): string[];
    themeId(): string;
    seed(): string;
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

    function build(trackId: string | null, generation: number, profile: QualityProfile) {
        return buildFirstViableScene(
            sceneSeed(trackId, generation),
            themes,
            {
                available: registry.all(),
                assets: assetIds,
                capabilities: deviceCapabilities,
                history: {},
                playbackTime: 0,
            },
            profile,
        );
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
                });
            },

            problems() {
                return device.shaderErrors().map((error) => `${error.id}: ${error.message}`);
            },

            rebuild(trackId, generation, profile) {
                const result = build(trackId, generation, profile);
                if (!result.ok) {
                    // Keep the current scene rather than blanking: a failed rebuild is not a reason to
                    // stop rendering what already works.
                    console.warn('[visualizer] scene rebuild failed', result.failure.detail);
                    return false;
                }

                runtime.dispose();
                scene = result.scene;
                instances = instantiate(device, scene.graph);
                layers = buildLayers(scene.graph);
                runtime.setGraph(scene.graph, instances);

                return true;
            },

            setAssets(ids) {
                assetIds = ids;
            },

            availableAssets() {
                return assetIds;
            },

            activePluginIds() {
                return scene.plugins.map((definition) => definition.id);
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
