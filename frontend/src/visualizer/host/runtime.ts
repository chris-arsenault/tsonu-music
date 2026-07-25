/**
 * Graph execution.
 *
 * Walks the compiled graph in order, asks each plugin for its passes, and executes them against the
 * device. Decides nothing: order comes from the graph, target sizes from the render plan, layer order
 * from the compositor.
 */

import type { ParameterBinding } from '../core/bindings';
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
import { mergeUniforms, resolveParameters } from '../core/parameters';
import { modulateParameters } from '../core/modulation';
import { isSuppressedByQuality, type RenderPass, type ResourceId } from '../core/passes';
import type { QualityProfile } from '../core/performance';
import { liveKeys, planTargets, type RenderPlan } from '../core/render-plan';
import type { VisualPluginInstance } from '../core/plugin';
import type { Device, RenderTarget } from './device';

export interface ActiveInstance {
    instanceId: string;
    /** Random identity for this instance within its current scene. */
    seed: number;
    instance: VisualPluginInstance;
    node: CompiledNode;
    parameters: Record<string, number>;
    /** Scene bindings from the scheduler's reactivity distribution, if any. */
    bindings?: readonly ParameterBinding[];
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
    /** The active quality profile, so the ladder's plugin-level rungs take effect. */
    profile?: QualityProfile;
    /**
     * Plugins that have left the scene but are still finishing their deactivation policy. They keep
     * updating and rendering into their old resources, which is what makes drain and dissolve visible
     * rather than an instant cut.
     */
    retiring?: readonly RetiringInstance[];
}

export interface RetiringInstance {
    active: ActiveInstance;
    /** Layer opacity for this frame, from the retirement policy. */
    opacity: number;
    /** False once a draining plugin should stop producing new material. */
    emitting: boolean;
}

export interface RuntimeStats {
    passesExecuted: number;
    targetsAllocated: number;
    skippedPasses: number;
    /** Plugins the quality ladder switched off this frame. */
    suppressedPlugins: number;
    /** Programs still linking. A pass whose program is not ready is skipped, not stalled on. */
    pendingShaders: number;
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
        if (!key) {
            return undefined;
        }

        // The plan owns every size, so acquiring never disagrees with what was allocated.
        const size = plan.sizes[resource] ?? { width: plan.width, height: plan.height };
        return device.acquireTarget(key, size.width, size.height).texture;
    }

    function executePass(
        pass: RenderPass,
        node: CompiledNode,
        plan: RenderPlan,
        stats: RuntimeStats,
        parameters: Readonly<Record<string, number>>,
    ): void {
        const program = device.useProgram(pass.shader);
        if (!program) {
            // A failed shader compilation must not take the frame down with it.
            stats.skippedPasses += 1;
            return;
        }

        const outputResource = pass.output ?? Object.values(node.outputs)[0];
        const outputKey = outputResource ? plan.writeKeys[outputResource] : undefined;

        let target: RenderTarget | null = null;
        if (outputKey && outputResource) {
            // Sized from the plan rather than from the pass. Recomputing it here disagreed with what
            // planTargets allocated, so every scaled pass deleted and recreated its texture each frame.
            const size = plan.sizes[outputResource] ?? { width: plan.width, height: plan.height };
            target = device.acquireTarget(outputKey, size.width, size.height);
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

        // Live bound parameters override the pass's static defaults. Applied here so every plugin gets
        // its bindings for free and none can silently render at fixed values.
        device.setUniforms(program, {
            uResolution: [target?.width ?? plan.width, target?.height ?? plan.height],
            ...mergeUniforms(pass.uniforms, parameters),
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
            const stats: RuntimeStats = { passesExecuted: 0, targetsAllocated: 0, skippedPasses: 0, suppressedPlugins: 0, pendingShaders: 0 };
            if (!graph || device.isLost()) {
                return stats;
            }

            // Retiring plugins' resources are planned alongside the live graph's, so a departing plugin
            // still has somewhere to draw while it finishes.
            const retiring = frame.retiring ?? [];
            const planningGraph: CompiledGraph = retiring.length === 0
                ? graph
                : {
                    ...graph,
                    resources: [
                        ...graph.resources,
                        ...retiring.flatMap((entry) =>
                            entry.active.node.definition.outputs.map((port) => ({
                                id: entry.active.node.outputs[port.name],
                                type: port.type,
                                producedBy: entry.active.instanceId,
                                port: port.name,
                            }))),
                    ],
                };

            const plan = planTargets(
                planningGraph,
                frame.renderWidth,
                frame.renderHeight,
                frame.qualityScale,
                frameParity,
                frame.profile?.simulationScale ?? 1,
            );
            frameParity += 1;

            // Expired before the pass, so a plugin never reads an impact past its lifetime. A frozen
            // clock does not advance playback time, so impacts persist through a pause.
            impacts = expireImpacts(impacts, frame.clock.playbackTime);
            if (frame.clearTransients) {
                impacts = clearImpacts();
            }

            // Programs linked since the last frame become usable here rather than blocking at first use.
            device.advanceCompilation();

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

                // Ladder rungs 5 to 7 drop whole plugins rather than reducing resolution.
                if (frame.profile && isSuppressedByQuality(
                    node.definition.capabilities,
                    node.definition.character.dominance,
                    node.definition.cost.gpu,
                    frame.profile,
                )) {
                    stats.suppressedPlugins += 1;
                    continue;
                }

                // Scene bindings override the plugin's defaults, since the scheduler redistributes them
                // across features to keep a scene from pulsing together.
                const bindings = active.bindings ?? active.node.definition.defaultBindings ?? [];
                active.parameters = resolveParameters(
                    active.parameters,
                    bindings,
                    frame.features,
                    deltaSeconds,
                );
                const renderedParameters = modulateParameters(
                    active.parameters,
                    bindings,
                    frame.clock.playbackTime,
                    frame.features.continuous.beatPhase,
                    frame.features.continuous.beatConfidence,
                    active.seed,
                );

                active.instance.update({
                    clock: frame.clock,
                    features: frame.features,
                    deltaSeconds,
                    seed: active.seed,
                    renderWidth: plan.width,
                    renderHeight: plan.height,
                    parameters: renderedParameters,
                    uploadGeometry: (upload) => device.uploadGeometry(upload),
                    particleScale: frame.profile?.particleScale,
                    historyDepth: frame.profile?.historyDepth,
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
                    executePass(pass, node, plan, stats, renderedParameters);
                }
            }

            // Retiring plugins render after the live graph, into the resources they already owned.
            for (const entry of retiring) {
                const active = entry.active;
                const bindings = active.bindings ?? active.node.definition.defaultBindings ?? [];
                const renderedParameters = modulateParameters(
                    active.parameters,
                    bindings,
                    frame.clock.playbackTime,
                    frame.features.continuous.beatPhase,
                    frame.features.continuous.beatConfidence,
                    active.seed,
                );
                active.instance.update({
                    clock: frame.clock,
                    features: frame.features,
                    deltaSeconds,
                    seed: active.seed,
                    renderWidth: plan.width,
                    renderHeight: plan.height,
                    parameters: renderedParameters,
                    uploadGeometry: (upload) => device.uploadGeometry(upload),
                    // A draining plugin keeps simulating but stops emitting new material.
                    particleScale: entry.emitting ? frame.profile?.particleScale : 0,
                    historyDepth: frame.profile?.historyDepth,
                    impacts,
                    publishImpacts: () => undefined,
                });

                for (const pass of active.instance.render({
                    inputs: active.node.inputs,
                    outputs: active.node.outputs,
                    previous: active.node.previous,
                    renderWidth: plan.width,
                    renderHeight: plan.height,
                })) {
                    executePass(pass, active.node, plan, stats, renderedParameters);
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

            stats.pendingShaders = device.pendingShaderCount();
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

    const size = plan.sizes[resource] ?? { width: plan.width, height: plan.height };
    const target = device.acquireTarget(key, size.width, size.height);

    device.beginPass(null, 'none', true);
    device.bindTexture(program, 'uSource', target.texture, 0);
    device.setUniforms(program, {
        uOpacity: 1,
        uResolution: [device.canvas.width, device.canvas.height],
        // Resource inspection is diagnostic: show the raw field or texture without presentation
        // grading so its channels remain meaningful.
        uChromatic: 0,
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
        const size = plan.sizes[resource] ?? { width: plan.width, height: plan.height };
        const target = device.acquireTarget(key, size.width, size.height);

        device.beginPass(null, index === 0 ? 'none' : step.blendMode, index === 0);
        device.bindTexture(program, 'uSource', target.texture, 0);
        device.setUniforms(program, {
            uOpacity: step.opacity,
            uResolution: [device.canvas.width, device.canvas.height],
            uTime: frame.clock.playbackTime,
            uEnergy: frame.features.continuous.rms,
            uBass: frame.features.continuous.bass,
            uCentroid: frame.features.continuous.spectralCentroid,
            // Golden-ratio spacing keeps simultaneously presented branches chromatically distinct.
            uLayerPhase: (index * 0.61803398875) % 1,
            uChromatic: 1,
        });
        device.drawFullscreen();
        stats.passesExecuted += 1;
    });
}
