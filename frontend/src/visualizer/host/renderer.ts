/**
 * Owns the canvas, device, runtime, and the active scene's plugin instances.
 *
 * Sits between the kernel loop and the device so the loop stays about time and the device stays about
 * GL. Handles canvas sizing and context-loss recovery, rebuilding GPU state from retained plugin
 * metadata rather than resetting the scene.
 */

import { compileGraph, type CompiledGraph } from '../core/graph';
import { createLayer, type VisualLayer } from '../core/layers';
import type { AudioFeatureBus } from '../core/features';
import type { PlaybackClock } from '../core/clock';
import { createM1Registry, firstLightScene, type SceneDefinition } from '../plugins/registry';
import { PRESENT_SHADER, PRESENT_SHADER_ID } from '../plugins/postprocess/tone-mapper';
import { createDevice, type Device } from './device';
import { createRuntime, type ActiveInstance, type RuntimeStats } from './runtime';

export interface RendererFrame {
    clock: PlaybackClock;
    features: AudioFeatureBus;
    deltaSeconds: number;
    qualityScale: number;
}

export interface Renderer {
    renderFrame(frame: RendererFrame): RuntimeStats;
    /** Compile errors and shader failures, for the diagnostics overlay. */
    problems(): string[];
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

export function createRenderer(canvas: HTMLCanvasElement): RendererResult {
    const device = createDevice(canvas);
    if (!device) {
        return { ok: false, failure: 'no-webgl2' };
    }

    if (!device.capabilities.floatRenderTargets) {
        device.dispose();
        return { ok: false, failure: 'no-float-render-targets' };
    }

    const registry = createM1Registry();
    const scene = firstLightScene(registry);
    const compiled = compileGraph(scene.nodes, scene.edges, scene.present);
    if (!compiled.ok) {
        device.dispose();
        return { ok: false, failure: 'invalid-scene', detail: compiled.errors.join('; ') };
    }

    const runtime = createRuntime(device, PRESENT_SHADER_ID);
    const instances = instantiate(device, scene, compiled.graph);

    device.registerShader(PRESENT_SHADER);
    runtime.setGraph(compiled.graph, instances);

    const layers = buildLayers(compiled.graph);
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
                    qualityScale: frame.qualityScale,
                    renderWidth: canvas.width,
                    renderHeight: canvas.height,
                    layers,
                });
            },

            problems() {
                return device.shaderErrors().map((error) => `${error.id}: ${error.message}`);
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

function instantiate(
    device: Device,
    scene: SceneDefinition,
    graph: CompiledGraph,
): ActiveInstance[] {
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
