/**
 * Graph execution.
 *
 * Walks the compiled graph in order, asks each plugin for its passes, and executes them against the
 * device. Decides nothing: order comes from the graph, target sizes from the render plan, layer order
 * from the compositor.
 */

import { advanceBinding } from '../core/bindings';
import type { AudioFeatureBus } from '../core/features';
import type { PlaybackClock } from '../core/clock';
import type { CompiledGraph, CompiledNode } from '../core/graph';
import { composeLayers, type Crossfade, type VisualLayer } from '../core/layers';
import {
    isPluginDisabled,
    simulationDelta,
    type DiagnosticsControls,
} from '../core/diagnostics';
import {
    clearImpacts,
    createImpactBus,
    expireImpacts,
    publishImpacts,
    type ImpactBus,
} from '../core/impact';
import { resolvePassScale, type RenderPass, type ResourceId } from '../core/passes';
import { liveKeys, planTargets, type RenderPlan } from '../core/render-plan';
import type { VisualPluginInstance } from '../core/plugin';
import type { Device, RenderTarget } from './device';

export interface ActiveInstance {
    instanceId: string;
    instance: VisualPluginInstance;
    node: CompiledNode;
    parameters: Record<string, number>;
}

export interface RuntimeFrame {
    clock: PlaybackClock;
    features: AudioFeatureBus;
    deltaSeconds: number;
    qualityScale: number;
    renderWidth: number;
    renderHeight: number;
    layers: readonly VisualLayer[];
    crossfades?: readonly Crossfade[];
    /** Set on the frame a seek or track change lands, to drop stale impacts alongside audio events. */
    clearTransients?: boolean;
    /** Diagnostics overrides. Absent in normal operation. */
    controls?: DiagnosticsControls;
}

export interface RuntimeStats {
    passesExecuted: number;
    targetsAllocated: number;
    skippedPasses: number;
}

export interface Runtime {
    setGraph(graph: CompiledGraph, instances: readonly ActiveInstance[]): void;
    renderFrame(frame: RuntimeFrame): RuntimeStats;
    /** Rebuilds GPU state after context loss. Plugin state is retained. */
    reinitialize(): void;
    dispose(): void;
}

export function createRuntime(device: Device, presentShaderId: string): Runtime {
    let graph: CompiledGraph | undefined;
    let instances: readonly ActiveInstance[] = [];
    let frameParity = 0;
    // Kernel-level, so an impact published by one plugin is readable by every other.
    let impacts: ImpactBus = createImpactBus();

    function resolveTexture(plan: RenderPlan, resource: ResourceId | undefined, previous: boolean): WebGLTexture | undefined {
        if (!resource) {
            return undefined;
        }

        // Asset resources are host-supplied textures rather than graph targets, so they resolve first.
        const asset = device.assetTexture(resource);
        if (asset) {
            return asset;
        }

        const key = previous ? plan.readKeys[resource] : plan.writeKeys[resource];
        return key ? device.acquireTarget(key, plan.width, plan.height).texture : undefined;
    }

    function executePass(
        pass: RenderPass,
        node: CompiledNode,
        plan: RenderPlan,
        stats: RuntimeStats,
    ): void {
        const program = device.useProgram(pass.shader);
        if (!program) {
            // A failed shader compilation must not take the frame down with it.
            stats.skippedPasses += 1;
            return;
        }

        const scale = resolvePassScale(pass, 1);
        const outputResource = pass.output ?? Object.values(node.outputs)[0];
        const outputKey = outputResource ? plan.writeKeys[outputResource] : undefined;

        let target: RenderTarget | null = null;
        if (outputKey) {
            target = device.acquireTarget(
                outputKey,
                Math.round(plan.width * scale),
                Math.round(plan.height * scale),
            );
        }

        device.beginPass(target, pass.blend ?? 'none', pass.clear ?? true);

        let unit = 0;
        for (const [sampler, resource] of Object.entries(pass.inputs ?? {})) {
            // A resource read through a feedback edge resolves to the previous frame's slot.
            const isPrevious = Object.values(node.previous).includes(resource);
            const texture = resolveTexture(plan, resource, isPrevious);
            if (texture) {
                device.bindTexture(program, sampler, texture, unit);
                unit += 1;
            }
        }

        device.setUniforms(program, {
            uResolution: [target?.width ?? plan.width, target?.height ?? plan.height],
            ...(pass.uniforms ?? {}),
        });

        if (pass.kind === 'geometry') {
            device.drawGeometry(program, pass.geometry, pass.primitive, pass.vertexCount);
        } else {
            device.drawFullscreen();
        }

        stats.passesExecuted += 1;
    }

    return {
        setGraph(next, nextInstances) {
            graph = next;
            instances = nextInstances;
        },

        renderFrame(frame) {
            const stats: RuntimeStats = { passesExecuted: 0, targetsAllocated: 0, skippedPasses: 0 };
            if (!graph || device.isLost()) {
                return stats;
            }

            const plan = planTargets(graph, frame.renderWidth, frame.renderHeight, frame.qualityScale, frameParity);
            frameParity += 1;

            // Expired before the pass, so a plugin never reads an impact past its lifetime. A frozen
            // clock does not advance playback time, so impacts persist through a pause.
            impacts = expireImpacts(impacts, frame.clock.playbackTime);
            if (frame.clearTransients) {
                impacts = clearImpacts();
            }

            device.releaseUnused(liveKeys(plan));
            for (const target of plan.targets) {
                device.acquireTarget(target.key, target.width, target.height);
                stats.targetsAllocated += 1;
            }

            const byInstance = new Map(instances.map((entry) => [entry.instanceId, entry]));

            // Simulation freeze applies here rather than inside each plugin, since zero delta is a
            // contract every plugin already honours.
            const deltaSeconds = frame.controls
                ? simulationDelta(frame.controls, frame.deltaSeconds)
                : frame.deltaSeconds;

            for (const node of graph.order) {
                const active = byInstance.get(node.instanceId);
                if (!active) {
                    continue;
                }

                // A disabled plugin is skipped entirely, so its contribution disappears while everything
                // downstream keeps running against whatever remains.
                if (frame.controls && isPluginDisabled(frame.controls, node.instanceId)) {
                    continue;
                }

                applyBindings(active, { ...frame, deltaSeconds });

                active.instance.update({
                    clock: frame.clock,
                    features: frame.features,
                    deltaSeconds,
                    seed: hashSeed(active.instanceId),
                    renderWidth: plan.width,
                    renderHeight: plan.height,
                    parameters: active.parameters,
                    uploadGeometry: (upload) => device.uploadGeometry(upload),
                    impacts,
                    publishImpacts: (published) => {
                        impacts = publishImpacts(impacts, published);
                    },
                });

                const passes = active.instance.render({
                    inputs: node.inputs,
                    outputs: node.outputs,
                    previous: node.previous,
                    renderWidth: plan.width,
                    renderHeight: plan.height,
                });

                for (const pass of passes) {
                    executePass(pass, node, plan, stats);
                }
            }

            // Inspecting an intermediate resource replaces the composed output, which is how a field,
            // mask, or depth texture is examined directly.
            const inspected = frame.controls?.inspectResource;
            if (inspected && plan.writeKeys[inspected]) {
                presentSingle(device, plan, inspected, presentShaderId, stats);
            } else {
                present(device, plan, frame, presentShaderId, stats);
            }

            return stats;
        },

        reinitialize() {
            device.invalidate();
            for (const active of instances) {
                void active.instance.initialize();
            }
        },

        dispose() {
            for (const active of instances) {
                active.instance.destroy();
            }
            instances = [];
            graph = undefined;
        },
    };
}

/** Draws one resource straight to the canvas, bypassing composition. */
function presentSingle(
    device: Device,
    plan: RenderPlan,
    resource: ResourceId,
    presentShaderId: string,
    stats: RuntimeStats,
): void {
    const program = device.useProgram(presentShaderId);
    const key = plan.writeKeys[resource];
    if (!program || !key) {
        stats.skippedPasses += 1;
        return;
    }

    const target = device.acquireTarget(key, plan.width, plan.height);

    device.beginPass(null, 'none', true);
    device.bindTexture(program, 'uSource', target.texture, 0);
    device.setUniforms(program, {
        uOpacity: 1,
        uResolution: [device.canvas.width, device.canvas.height],
    });
    device.drawFullscreen();
    stats.passesExecuted += 1;
}

/** Composites the layer stack onto the canvas. */
function present(
    device: Device,
    plan: RenderPlan,
    frame: RuntimeFrame,
    presentShaderId: string,
    stats: RuntimeStats,
): void {
    const composition = composeLayers(frame.layers, frame.crossfades);
    const program = device.useProgram(presentShaderId);
    if (!program) {
        stats.skippedPasses += 1;
        return;
    }

    device.beginPass(null, 'none', true);

    const steps = composition.steps.length > 0
        ? composition.steps
        // Nothing declared a layer, so present the graph's own output rather than a black frame.
        : plan.presentKey
            ? [{ layer: { id: 'graph', color: plan.presentKey } as VisualLayer, opacity: 1, blendMode: 'none' as const }]
            : [];

    steps.forEach((step, index) => {
        const resource = step.layer.color;
        if (!resource) {
            return;
        }

        const key = plan.writeKeys[resource] ?? resource;
        const target = device.acquireTarget(key, plan.width, plan.height);

        device.beginPass(null, index === 0 ? 'none' : step.blendMode, index === 0);
        device.bindTexture(program, 'uSource', target.texture, 0);
        device.setUniforms(program, {
            uOpacity: step.opacity,
            uResolution: [device.canvas.width, device.canvas.height],
        });
        device.drawFullscreen();
        stats.passesExecuted += 1;
    });
}

/** Resolves each parameter from its bindings against this frame's features. */
function applyBindings(active: ActiveInstance, frame: RuntimeFrame): void {
    const bindings = active.node.definition.defaultBindings ?? [];

    for (const binding of bindings) {
        const raw = readFeature(frame.features, binding.feature);
        if (raw === undefined) {
            continue;
        }

        active.parameters[binding.parameter] = advanceBinding(
            binding,
            active.parameters[binding.parameter],
            raw,
            frame.deltaSeconds,
        );
    }
}

function readFeature(features: AudioFeatureBus, name: string): number | undefined {
    const continuous = features.continuous as unknown as Record<string, number>;
    const value = continuous[name];

    return typeof value === 'number' ? value : undefined;
}

/** Stable per-instance seed so a scene reproduces from its id set. */
function hashSeed(instanceId: string): number {
    let hash = 2166136261;
    for (let index = 0; index < instanceId.length; index += 1) {
        hash ^= instanceId.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0) / 4294967295;
}

export { hashSeed };
