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
import {
    advanceAccumulationSlot,
    blackFloorFor,
    frameSurvival,
    injectionFor,
    isMotionSource,
    type PersistenceSettings,
} from '../core/persistence';
import { liveKeys, planTargets, withRetiringNodes, type RenderPlan } from '../core/render-plan';
import type { VisualPluginInstance } from '../core/plugin';
import type { Device, RenderTarget } from './device';
import {
    GRADE_SHADER,
    GRADE_SHADER_ID,
    MOTION_SUM_SHADER,
    MOTION_SUM_SHADER_ID,
    PERSISTENCE_SHADER,
    PERSISTENCE_SHADER_ID,
} from './composite-shaders';

/**
 * Kernel-owned targets, outside the graph because they belong to the compositor rather than to any
 * plugin. Named so `releaseUnused` can be told to keep them across scene changes.
 */
const COMPOSITE_KEY = 'kernel:composite';
const MOTION_KEY = 'kernel:motion';
const ACCUMULATE_KEYS = ['kernel:accumulate#0', 'kernel:accumulate#1'] as const;

/** The motion field is a force, not an image; it needs no pixel detail. */
const MOTION_SCALE = 0.5;

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
     * How strongly this scene accumulates and how far the accumulation is dragged, decided in
     * `core/persistence.ts` from the theme, the layer stack, and the audio.
     */
    persistence: PersistenceSettings;
    /** Discards the accumulation, for a seek or track change landing on unrelated material. */
    clearAccumulation?: boolean;
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
    /**
     * False until the accumulation has been written at least once. Without this a track opening
     * paused would present a buffer nothing had drawn into.
     */
    let accumulationPrimed = false;
    /**
     * Which accumulation slot currently holds the image.
     *
     * Tracked rather than derived from the frame counter, because the accumulation is written only on
     * frames that advance while the counter increments on every one.
     */
    let accumulationSlot: 0 | 1 = 0;

    device.registerShader(MOTION_SUM_SHADER);
    device.registerShader(PERSISTENCE_SHADER);
    device.registerShader(GRADE_SHADER);

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
        deltaSeconds: number,
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
            // Supplied centrally so any shader integrating across frames — feedback decay, warp
            // strength — can correct for the frame it actually got instead of assuming sixty a
            // second. A frozen clock passes zero and those shaders hold.
            uDelta: Math.max(0, deltaSeconds),
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
            const planningGraph = withRetiringNodes(graph, retiring.map((entry) => entry.active.node));

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

            // The kernel's own targets outlive any scene, so they are declared live alongside the
            // plan's. Without this a scene change would delete the accumulation and every trail in it.
            const kernelKeys = new Set<string>([COMPOSITE_KEY, MOTION_KEY, ...ACCUMULATE_KEYS]);
            device.releaseUnused(new Set([...liveKeys(plan), ...kernelKeys]));
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
                    executePass(pass, node, plan, stats, renderedParameters, deltaSeconds);
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
                    executePass(pass, active.node, plan, stats, renderedParameters, deltaSeconds);
                }
            }

            // Inspecting an intermediate resource replaces the composed output, which is how a field,
            // mask, or depth texture is examined directly.
            const inspected = frame.controls?.inspectResource;
            if (inspected && plan.writeKeys[inspected]) {
                presentSingle(device, plan, inspected, presentShaderId, stats);
            } else {
                if (frame.clearAccumulation) {
                    accumulationPrimed = false;
                }

                composite(device, plan, frame, presentShaderId, stats);
                const hasMotion = sumMotion(device, graph, plan, stats);

                // A frozen clock advances nothing, so the accumulation holds exactly rather than
                // screening the same frame into itself and brightening while paused.
                if (deltaSeconds > 0 || !accumulationPrimed) {
                    // The slot flips only when something is actually written to it. Deriving it from
                    // the frame counter instead meant that under a frozen clock — a pause, or simply
                    // an element that has not started — the write was skipped while the slot kept
                    // alternating, so the screen swapped between the last two accumulations every
                    // frame. That is a flicker at refresh rate.
                    const write = advanceAccumulationSlot(accumulationSlot, true);

                    advanceAccumulation(
                        device,
                        plan,
                        frame,
                        deltaSeconds,
                        { write, read: accumulationSlot, hasMotion },
                        stats,
                    );

                    accumulationSlot = write;
                    accumulationPrimed = true;
                }

                presentTarget(device, ACCUMULATE_KEYS[accumulationSlot], plan, stats);
            }

            stats.pendingShaders = device.pendingShaderCount();
            return stats;
        },

        reinitialize() {
            device.invalidate();
            // The kernel's shaders and its accumulation went with the context, so both are rebuilt
            // here rather than leaving the composite stage pointing at programs that no longer exist.
            device.registerShader(MOTION_SUM_SHADER);
            device.registerShader(PERSISTENCE_SHADER);
            device.registerShader(GRADE_SHADER);
            accumulationPrimed = false;

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

/**
 * Composites the layer stack into the kernel's composite target.
 *
 * Previously this drew straight to the canvas, which left nowhere for section 11's feedback injection
 * to happen and made the composed image unavailable to anything. It now produces a texture, and the
 * accumulation stage is what reaches the screen.
 */
function composite(
    device: Device,
    plan: RenderPlan,
    frame: RuntimeFrame,
    presentShaderId: string,
    stats: RuntimeStats,
): void {
    const composition = composeLayers(frame.layers, frame.crossfades);
    const program = device.useProgram(presentShaderId);
    const target = device.acquireTarget(COMPOSITE_KEY, plan.width, plan.height);

    if (!program) {
        stats.skippedPasses += 1;
        return;
    }

    const steps = composition.steps.length > 0
        ? composition.steps
        // Nothing declared a layer, so present the graph's own output rather than a black frame.
        : plan.presentKey
            ? [{ layer: { id: 'graph', color: plan.presentKey } as VisualLayer, opacity: 1, blendMode: 'none' as const }]
            : [];

    // Cleared even with no steps, so a scene that produces nothing this frame reads as black rather
    // than as whatever the pool last left in the texture.
    device.beginPass(target, 'none', true);

    steps.forEach((step, index) => {
        const resource = step.layer.color;
        if (!resource) {
            return;
        }

        const key = plan.writeKeys[resource] ?? resource;
        const size = plan.sizes[resource] ?? { width: plan.width, height: plan.height };
        const source = device.acquireTarget(key, size.width, size.height);

        device.beginPass(target, index === 0 ? 'none' : step.blendMode, index === 0);
        device.bindTexture(program, 'uSource', source.texture, 0);
        device.setUniforms(program, {
            uOpacity: step.opacity,
            uResolution: [plan.width, plan.height],
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

/**
 * Sums every field the scene produced into one motion field.
 *
 * Contributions add rather than overwrite, so two fields compound into a single coherent drag instead
 * of one winning. This is what makes several layers contribute to one sense of flow, and it is why
 * fields no longer have to be consumed by a particle system to be worth generating.
 *
 * Returns false when the scene produced no field at all, which leaves the drag out of the
 * accumulation entirely rather than gathering through a stale texture.
 */
function sumMotion(
    device: Device,
    graph: CompiledGraph,
    plan: RenderPlan,
    stats: RuntimeStats,
): boolean {
    const sources = graph.resources.filter((resource) => isMotionSource(resource.type));
    const width = Math.max(1, Math.round(plan.width * MOTION_SCALE));
    const height = Math.max(1, Math.round(plan.height * MOTION_SCALE));
    const target = device.acquireTarget(MOTION_KEY, width, height);

    if (sources.length === 0) {
        return false;
    }

    const program = device.useProgram(MOTION_SUM_SHADER_ID);
    if (!program) {
        stats.skippedPasses += 1;
        return false;
    }

    // Softened by the square root of the contributor count rather than divided by it. Dividing meant
    // a scene with two fields was dragged half as far as one with a single field, which read as the
    // richer scenes being the slowest; the root keeps the sum bounded without cancelling it.
    const weight = 1 / Math.sqrt(sources.length);
    let drawn = 0;

    for (const resource of sources) {
        const key = plan.writeKeys[resource.id];
        if (!key) {
            continue;
        }

        const size = plan.sizes[resource.id] ?? { width, height };
        const source = device.acquireTarget(key, size.width, size.height);

        device.beginPass(target, drawn === 0 ? 'none' : 'add', drawn === 0);
        device.bindTexture(program, 'uSource', source.texture, 0);
        device.setUniforms(program, { uResolution: [width, height], uWeight: weight });
        device.drawFullscreen();

        drawn += 1;
        stats.passesExecuted += 1;
    }

    return drawn > 0;
}

/**
 * Drags the accumulation through the motion field, decays it, and screens the new composite on top.
 *
 * The one pass that gives the subsystem a memory. Everything upstream of it regenerates from nothing
 * each frame, which is exactly why the result read as a still picture with small local animation.
 */
function advanceAccumulation(
    device: Device,
    plan: RenderPlan,
    frame: RuntimeFrame,
    deltaSeconds: number,
    slots: { write: 0 | 1; read: 0 | 1; hasMotion: boolean },
    stats: RuntimeStats,
): void {
    const program = device.useProgram(PERSISTENCE_SHADER_ID);
    if (!program) {
        stats.skippedPasses += 1;
        return;
    }

    const write = device.acquireTarget(ACCUMULATE_KEYS[slots.write], plan.width, plan.height);
    const read = device.acquireTarget(ACCUMULATE_KEYS[slots.read], plan.width, plan.height);
    const compositeTarget = device.acquireTarget(COMPOSITE_KEY, plan.width, plan.height);
    const motion = device.acquireTarget(
        MOTION_KEY,
        Math.max(1, Math.round(plan.width * MOTION_SCALE)),
        Math.max(1, Math.round(plan.height * MOTION_SCALE)),
    );

    const survival = frameSurvival(frame.persistence.survivalPerSecond, deltaSeconds);

    device.beginPass(write, 'none', true);
    device.bindTexture(program, 'uComposite', compositeTarget.texture, 0);
    device.bindTexture(program, 'uHistory', read.texture, 1);
    device.bindTexture(program, 'uMotion', motion.texture, 2);
    device.setUniforms(program, {
        uResolution: [plan.width, plan.height],
        uSurvival: survival,
        // Complement of survival, so a static image converges to exactly itself rather than ramping.
        uInjection: injectionFor(survival),
        uBlackFloor: blackFloorFor(deltaSeconds),
        uMotionScale: frame.persistence.motionScale,
        uDelta: Math.max(0, deltaSeconds),
        uHasMotion: slots.hasMotion,
    });
    device.drawFullscreen();
    stats.passesExecuted += 1;
}

/**
 * Grades the accumulation onto the canvas.
 *
 * The final stage, and the only one that compresses. `ToneMapper` sits inside the graph, so it runs
 * before the accumulation and cannot be the last word: whatever it rolled off was accumulated back
 * into clipping and then presented with no compression at all.
 */
function presentTarget(
    device: Device,
    key: string,
    plan: RenderPlan,
    stats: RuntimeStats,
): void {
    const program = device.useProgram(GRADE_SHADER_ID);
    if (!program) {
        stats.skippedPasses += 1;
        return;
    }

    const target = device.acquireTarget(key, plan.width, plan.height);

    device.beginPass(null, 'none', true);
    device.bindTexture(program, 'uSource', target.texture, 0);
    device.setUniforms(program, {
        uResolution: [device.canvas.width, device.canvas.height],
        uExposure: 1.15,
        uContrast: 1.35,
        // Above one, so material that survived the accumulation reaches the screen with its colour
        // rather than tending toward grey.
        uSaturation: 1.35,
    });
    device.drawFullscreen();
    stats.passesExecuted += 1;
}
