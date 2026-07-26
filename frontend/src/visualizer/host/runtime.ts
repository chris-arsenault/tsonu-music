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
import {
    isSuppressedByQuality,
    unreachableInstances,
    type RenderPass,
    type ResourceId,
} from '../core/passes';
import type { QualityProfile } from '../core/performance';
import {
    advanceAccumulationSlot,
    blackFloorFor,
    frameSurvival,
    injectionFor,
    isMotionSource,
    type PersistenceSettings,
} from '../core/persistence';
import type { ScenePalette } from '../core/palette';
import { liveKeys, planTargets, withRetiringNodes, type RenderPlan } from '../core/render-plan';
import type { VisualPluginInstance } from '../core/plugin';
import type { Device, RenderTarget } from './device';
import {
    GRADE_SHADER,
    GRADE_SHADER_ID,
    METER_SHADER,
    METER_SHADER_ID,
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

/** Whichever accumulation slot currently holds the presented image, as an inspectable name. */
const ACCUMULATE_KEY = 'kernel:accumulate';

const METER_KEYS = ['kernel:meter#0', 'kernel:meter#1'] as const;

/** One texel. The grid of taps happens inside the shader, not across pixels. */
const METER_SIZE = 1;

/** Seconds for metered exposure to travel most of the way to a new scene's level. */
const METER_ADAPT_SECONDS = 0.9;

/** Kernel stages the diagnostics overlay can present directly, in the order they run. */
export const KERNEL_STAGES: readonly string[] = [COMPOSITE_KEY, MOTION_KEY, ACCUMULATE_KEY];

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
    /** The scene's colour scheme, one entry per material branch. */
    palette: ScenePalette;
    /**
     * The compositor's resolved parameters. Declared and bound in `core/composite-grade.ts` and
     * resolved through the same path as a plugin's, so grading is not a hard-coded feature mapping.
     */
    grade: Readonly<Record<string, number>>;
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
    let meterSlot: 0 | 1 = 0;

    device.registerShader(MOTION_SUM_SHADER);
    device.registerShader(PERSISTENCE_SHADER);
    device.registerShader(GRADE_SHADER);
    device.registerShader(METER_SHADER);

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
        writtenThisFrame: Set<ResourceId>,
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
        const bound = new Set<string>();
        for (const [sampler, resource] of Object.entries(pass.inputs ?? {})) {
            // A resource read through a feedback edge resolves to the previous frame's slot.
            // A resource already produced this frame is read as it stands now, even when this node
            // also declares a feedback edge onto it.
            //
            // The test was purely "does this node read this resource through a feedback edge", which
            // is ambiguous the moment a plugin has more than one pass: the particle simulator writes
            // its state and then bins that state in a second pass, and because `state` is also its
            // feedback port the binning pass was handed the previous frame's slot. Contact then
            // resolved against positions two frames old — further out of date, at these speeds, than
            // one whole contact diameter — so bodies were being pushed apart from where their
            // neighbours used to be.
            const isPrevious = !writtenThisFrame.has(resource)
                && Object.values(node.previous).includes(resource);
            const texture = resolveTexture(plan, resource, isPrevious);
            if (texture) {
                device.bindTexture(program, sampler, texture, unit);
                bound.add(sampler);
                unit += 1;
            }
        }

        // Anything the shader declares and this pass did not supply. An unbound sampler reads unit
        // zero, which holds whichever texture was bound there last — in practice the pass's first
        // input — so an unconnected optional port silently aliased a required one.
        device.bindEmptySamplers(program, bound, unit);

        // Live bound parameters override the pass's static defaults. Applied here so every plugin gets
        // its bindings for free and none can silently render at fixed values.
        //
        // The frame's geometry and its timebase are the kernel's to state, so they are written after
        // the plugin's own uniforms rather than before. Written first, a plugin's static value won:
        // two simulators declared `uDelta: 1 / 60` as a pass uniform and neither declared a matching
        // parameter to displace it, so both integrated a fixed sixtieth of a second per *frame* —
        // running fast on a high-refresh display, and continuing to evolve while the track was
        // paused, because the kernel's frozen zero never reached the shader.
        device.setUniforms(program, {
            ...mergeUniforms(pass.uniforms, parameters),
            uResolution: [target?.width ?? plan.width, target?.height ?? plan.height],
            // Supplied centrally so any shader integrating across frames — feedback decay, warp
            // strength — can correct for the frame it actually got instead of assuming sixty a
            // second. A frozen clock passes zero and those shaders hold.
            uDelta: Math.max(0, deltaSeconds),
        });

        if (pass.kind === 'geometry') {
            device.drawGeometry(program, pass.geometry, pass.primitive, pass.vertexCount);
        } else {
            device.drawFullscreen();
        }

        if (outputResource) {
            writtenThisFrame.add(outputResource);
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

            // Which plugins are not running this frame, decided before any of them run.
            //
            // A disabled plugin is skipped entirely, so its contribution disappears while everything
            // downstream keeps running against whatever remains. Ladder rungs 5 to 7 drop whole
            // plugins rather than reducing resolution.
            const skipped = new Set<string>();
            for (const node of graph.order) {
                if (!byInstance.has(node.instanceId)) {
                    skipped.add(node.instanceId);
                    continue;
                }
                if (frame.controls && isPluginDisabled(frame.controls, node.instanceId)) {
                    skipped.add(node.instanceId);
                    continue;
                }
                if (frame.profile && isSuppressedByQuality(
                    node.definition.capabilities,
                    node.definition.character.dominance,
                    node.definition.cost.gpu,
                    frame.profile,
                )) {
                    stats.suppressedPlugins += 1;
                    skipped.add(node.instanceId);
                }
            }

            // Then whatever those leave stranded. Suppressing a particle renderer used to leave its
            // simulator running into a buffer nobody reads: a full simulation pass every frame
            // producing no pixels, since a particle buffer is never a colour texture.
            /** Resources produced so far this frame, so a later pass reads them as they now stand. */
            const writtenThisFrame = new Set<ResourceId>();

            const dead = unreachableInstances(
                graph.order,
                skipped,
                (type) => type === 'color-texture' || isMotionSource(type),
            );

            for (const node of graph.order) {
                const active = byInstance.get(node.instanceId);
                if (!active || dead.has(node.instanceId)) {
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
                    frame.features.continuous.transient,
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
                    executePass(pass, node, plan, stats, renderedParameters, deltaSeconds, writtenThisFrame);
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
                    frame.features.continuous.transient,
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
                    executePass(pass, active.node, plan, stats, renderedParameters, deltaSeconds, writtenThisFrame);
                }
            }

            // Inspecting an intermediate resource replaces the composed output, which is how a field,
            // mask, or depth texture is examined directly.
            const inspected = frame.controls?.inspectResource;

            if (inspected && plan.writeKeys[inspected]) {
                presentSingle(device, plan, inspected, presentShaderId, stats);
            } else {
                if (frame.clearAccumulation) {
                    // Actually cleared, not merely re-primed.
                    //
                    // Setting the primed flag alone only forces the accumulation pass to run, and on
                    // a seek the clock is frozen: survival over a zero delta is exactly 1 and the
                    // black floor is exactly 0, so that pass copied the whole pre-seek image forward
                    // with about one percent of the new composite mixed in. That is precisely the
                    // outcome this call exists to prevent — the previous passage dragged across the
                    // new one.
                    for (const key of ACCUMULATE_KEYS) {
                        const target = device.acquireTarget(key, plan.width, plan.height);
                        device.beginPass(target, 'none', true);
                    }
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

                // The kernel's own stages are inspectable by name, alongside plugin resources.
                //
                // Without this the composition is a black box between the layers and the canvas, and
                // every question about where a layer's brightness or detail goes had to be answered
                // by comparing the two ends and inferring the middle. That is how the accumulation
                // went unexamined while it was removing eight ninths of the particle layer's spatial
                // detail. Presented ungraded, so what is shown is what the stage holds.
                if (inspected === COMPOSITE_KEY || inspected === MOTION_KEY) {
                    presentKernelStage(device, inspected, plan, presentShaderId, stats);
                } else if (inspected === ACCUMULATE_KEY) {
                    presentKernelStage(device, ACCUMULATE_KEYS[accumulationSlot], plan, presentShaderId, stats);
                } else {
                    const meterWrite = advanceAccumulationSlot(meterSlot, true);
                    advanceMeter(
                        device,
                        ACCUMULATE_KEYS[accumulationSlot],
                        plan,
                        deltaSeconds,
                        { write: meterWrite, read: meterSlot },
                        stats,
                    );
                    meterSlot = meterWrite;

                    presentTarget(device, ACCUMULATE_KEYS[accumulationSlot], plan, frame.grade, meterSlot, stats);
                }
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
            device.registerShader(METER_SHADER);
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
/** Draws one of the kernel's own targets straight to the canvas, ungraded. */
function presentKernelStage(
    device: Device,
    key: string,
    plan: RenderPlan,
    presentShaderId: string,
    stats: RuntimeStats,
): void {
    const program = device.useProgram(presentShaderId);
    if (!program) {
        stats.skippedPasses += 1;
        return;
    }

    const target = device.acquireTarget(key, plan.width, plan.height);

    device.beginPass(null, 'none', true);
    device.bindTexture(program, 'uSource', target.texture, 0);
    device.setUniforms(program, {
        uOpacity: 1,
        uResolution: [device.canvas.width, device.canvas.height],
        uChromatic: 0,
    });
    device.drawFullscreen();
    stats.passesExecuted += 1;
}

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

        // One entry of the scene's scheme per branch, so simultaneously presented branches are
        // chromatically distinct by construction rather than by spacing a hue offset and hoping.
        const entry = frame.palette.entries[index % frame.palette.entries.length];

        device.beginPass(target, index === 0 ? 'none' : step.blendMode, index === 0);
        device.bindTexture(program, 'uSource', source.texture, 0);
        device.setUniforms(program, {
            uOpacity: step.opacity,
            uResolution: [plan.width, plan.height],
            uShadow: entry.shadow,
            uMid: entry.mid,
            uHighlight: entry.highlight,
            uTint: frame.grade.tint,
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
        // Complement of survival at rest, overridden by a transient so a hit arrives on screen
        // instead of seeping in at a fiftieth of its brightness.
        uInjection: injectionFor(survival, frame.persistence.transientPunch),
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
/**
 * Reduces the presented image to one texel of average luminance, smoothed against its own last value.
 *
 * Ping-ponged like the accumulation, because the smoothing reads the previous frame's meter.
 */
function advanceMeter(
    device: Device,
    sourceKey: string,
    plan: RenderPlan,
    deltaSeconds: number,
    slots: { write: 0 | 1; read: 0 | 1 },
    stats: RuntimeStats,
): void {
    const program = device.useProgram(METER_SHADER_ID);
    if (!program) {
        stats.skippedPasses += 1;
        return;
    }

    const source = device.acquireTarget(sourceKey, plan.width, plan.height);
    const history = device.acquireTarget(METER_KEYS[slots.read], METER_SIZE, METER_SIZE);
    const target = device.acquireTarget(METER_KEYS[slots.write], METER_SIZE, METER_SIZE);

    device.beginPass(target, 'none', true);
    device.bindTexture(program, 'uSource', source.texture, 0);
    device.bindTexture(program, 'uHistory', history.texture, 1);
    device.setUniforms(program, {
        uResolution: [METER_SIZE, METER_SIZE],
        uDelta: Math.max(0, deltaSeconds),
        uAdaptSeconds: METER_ADAPT_SECONDS,
    });
    device.drawFullscreen();
    stats.passesExecuted += 1;
}

function presentTarget(
    device: Device,
    key: string,
    plan: RenderPlan,
    grade: Readonly<Record<string, number>>,
    meterSlot: 0 | 1,
    stats: RuntimeStats,
): void {
    const program = device.useProgram(GRADE_SHADER_ID);
    if (!program) {
        stats.skippedPasses += 1;
        return;
    }

    const target = device.acquireTarget(key, plan.width, plan.height);
    const meter = device.acquireTarget(METER_KEYS[meterSlot], METER_SIZE, METER_SIZE);

    device.beginPass(null, 'none', true);
    device.bindTexture(program, 'uSource', target.texture, 0);
    device.bindTexture(program, 'uMeter', meter.texture, 1);
    // Bound and modulated like a plugin's parameters, so exposure lifts on a hit and saturation
    // follows intensity rather than sitting at whatever constant was typed here.
    device.setUniforms(program, {
        uResolution: [device.canvas.width, device.canvas.height],
        uExposure: grade.exposure,
        uContrast: grade.contrast,
        uSaturation: grade.saturation,
    });
    device.drawFullscreen();
    stats.passesExecuted += 1;
}
