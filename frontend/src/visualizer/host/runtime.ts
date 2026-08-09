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
import { isMotionSource } from '../core/fields';
import { presentStops, type ScenePalette } from '../core/palette';
import { liveKeys, planTargets, withRetiringNodes, type RenderPlan } from '../core/render-plan';
import type { VisualPluginInstance } from '../core/plugin';
import type { Device, RenderTarget } from './device';
import {
    GRADE_SHADER,
    GRADE_SHADER_ID,
    METER_SHADER,
    METER_SHADER_ID,
} from './composite-shaders';

/**
 * Kernel-owned targets, outside the graph because they belong to the compositor rather than to any
 * plugin. Named so `releaseUnused` can be told to keep them across scene changes.
 *
 * `kernel:accumulate` was one of these, ping-ponged, holding the image the whole subsystem's memory
 * lived in. Deleted with ADR-0013. Its guarantee — that every scene has memory — is a statement about
 * graph structure that the grammar already enforces, and since ADR-0012 took away its drag it had
 * been a stationary temporal average applied downstream of the only thing that moved: the image was
 * blurred over half a second in the direction of nowhere.
 */
const COMPOSITE_KEY = 'kernel:composite';

const METER_KEYS = ['kernel:meter#0', 'kernel:meter#1'] as const;

/** One texel. The grid of taps happens inside the shader, not across pixels. */
const METER_SIZE = 1;

/** Seconds for metered exposure to travel most of the way to a new scene's level. */
const METER_ADAPT_SECONDS = 0.9;

/**
 * Kernel stages the diagnostics overlay can present directly, in the order they run.
 *
 * `kernel:motion` was one of these. It is gone with the bus that produced it: a scene's displacement
 * now lives on the edges of the graph, where the inspector can already reach it by resource.
 */
export const KERNEL_STAGES: readonly string[] = [COMPOSITE_KEY];

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
    /** The scene's colour scheme, one entry per material branch. */
    palette: ScenePalette;
    /**
     * The compositor's resolved parameters. Declared and bound in `core/composite-grade.ts` and
     * resolved through the same path as a plugin's, so grading is not a hard-coded feature mapping.
     */
    grade: Readonly<Record<string, number>>;
    /**
     * Blanks every historical slot, for a seek or track change landing on unrelated material.
     *
     * This cleared one kernel-owned buffer. A scene's memory now lives in the ping-pong slots of
     * whichever resources something reads historically, so the same intent has to reach all of them —
     * there is no single buffer left to discard.
     */
    clearHistory?: boolean;
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
    let meterSlot: 0 | 1 = 0;

    device.registerShader(GRADE_SHADER);
    device.registerShader(METER_SHADER);
    const values = new Map<ResourceId, unknown>();

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

    /**
     * A resource as CPU-readable floats, for plugins simulating outside a shader.
     *
     * Reads the slot most recently written, so a field produced earlier this frame is the one seen.
     * The device answers with whatever readback has completed, which lags by a frame or two.
     */
    function readField(plan: RenderPlan, resource: ResourceId | undefined) {
        if (!resource) {
            return undefined;
        }

        const key = plan.readKeys[resource] ?? plan.writeKeys[resource];
        const size = plan.sizes[resource];
        if (!key || !size) {
            return undefined;
        }

        const data = device.readTarget(key, size.width, size.height);
        return data ? { width: size.width, height: size.height, data } : undefined;
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
            // The exception is for a plugin reading a resource *it* wrote earlier this frame, which
            // is the particle simulator binning the state its first pass produced. Restricted to
            // this node's own outputs: once a loop may close to any producer (ADR-0012), an upstream
            // node's resource is written before this one runs, and the unrestricted test silently
            // turned every such historical read into a forward one — the loop would compile, run,
            // and simply not be a loop.
            const ownOutput = Object.values(node.outputs).includes(resource);
            const isPrevious = Object.values(node.previous).includes(resource)
                && !(ownOutput && writtenThisFrame.has(resource));
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
            // plan's. The accumulation was one of these; the composite and the meter are what is left.
            const kernelKeys = new Set<string>([COMPOSITE_KEY, ...METER_KEYS]);
            device.releaseUnused(new Set([...liveKeys(plan), ...kernelKeys]));
            for (const target of plan.targets) {
                device.acquireTarget(target.key, target.width, target.height);
                stats.targetsAllocated += 1;
            }

            // Before anything reads a historical slot, so a seek cannot carry the previous passage
            // into the first frame of the new one.
            if (frame.clearHistory) {
                clearHistorySlots(device, plan);
            }

            // Semantic values describe this frame's authored graph. Keeping a value from a previous
            // frame after its producer is muted or quality-suppressed would leave a hidden emitter,
            // force, or collider influencing the simulator even though its node is no longer running.
            values.clear();

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
                    inputs: node.inputs,
                    parameters: renderedParameters,
                    uploadGeometry: (upload) => device.uploadGeometry(upload),
                    publishValue: (resource, value) => values.set(resource, value),
                    readValue: <T>(resource: ResourceId | undefined) =>
                        resource ? values.get(resource) as T | undefined : undefined,
                    particleScale: frame.profile?.particleScale,
                    historyDepth: frame.profile?.historyDepth,
                    impacts,
                    publishImpacts: (published) => {
                        impacts = publishImpacts(impacts, published);
                    },
                    readField: (resource) => readField(plan, resource),
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
                    inputs: active.node.inputs,
                    parameters: renderedParameters,
                    uploadGeometry: (upload) => device.uploadGeometry(upload),
                    publishValue: (resource, value) => values.set(resource, value),
                    readValue: <T>(resource: ResourceId | undefined) =>
                        resource ? values.get(resource) as T | undefined : undefined,
                    // A draining plugin keeps simulating but stops emitting new material.
                    particleScale: entry.emitting ? frame.profile?.particleScale : 0,
                    historyDepth: frame.profile?.historyDepth,
                    impacts,
                    publishImpacts: () => undefined,
                    readField: (resource) => readField(plan, resource),
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
                composite(device, plan, frame, presentShaderId, stats);

                // The kernel's own stages are inspectable by name, alongside plugin resources.
                //
                // Without this the composition is a black box between the layers and the canvas, and
                // every question about where a layer's brightness or detail goes had to be answered
                // by comparing the two ends and inferring the middle. That is how the accumulation
                // went unexamined while it was removing eight ninths of the particle layer's spatial
                // detail. Presented ungraded, so what is shown is what the stage holds.
                if (inspected === COMPOSITE_KEY) {
                    presentKernelStage(device, inspected, plan, presentShaderId, stats);
                } else {
                    // Metered from the composite rather than from an accumulation buffer, and that is
                    // the whole present path now: layers → composite → meter → grade → canvas. The
                    // grade is the only stage that compresses, and since ADR-0013 it is the only
                    // bound on the whole pipeline rather than the last of four.
                    const meterWrite = meterSlot === 0 ? 1 : 0;
                    advanceMeter(
                        device,
                        COMPOSITE_KEY,
                        plan,
                        deltaSeconds,
                        { write: meterWrite, read: meterSlot },
                        stats,
                    );
                    meterSlot = meterWrite;

                    presentTarget(device, COMPOSITE_KEY, plan, frame.grade, meterSlot, stats);
                }
            }

            stats.pendingShaders = device.pendingShaderCount();
            return stats;
        },

        reinitialize() {
            device.invalidate();
            // The kernel's shaders went with the context, so they are rebuilt here rather than
            // leaving the present path pointing at programs that no longer exist.
            device.registerShader(GRADE_SHADER);
            device.registerShader(METER_SHADER);

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
        //
        // There is only ever one branch here now, and this index is therefore always zero. Requiring
        // a scene to converge to a single unabsorbed terminal was a separate and correct repair —
        // branches that arrive at the composite unjoined have passed through nothing the scene is
        // made of — but it left this line selecting entry zero of four in every scene ever built,
        // measured 200/200 and 300/300. Three quarters of every scheme was unreachable, and the frame
        // was pulled toward a single three-stop ramp by uTint at 0.55 to 0.9. That is the reported
        // mono-hue.
        //
        // So the composite presents the scheme rather than a quarter of it: the stops of every entry
        // in order, traversed by luminance. Branch identity is not lost, it moved — the branches are
        // joined inside the graph now, and what reaches here is one image carrying all of them.
        const stops = presentStops(frame.palette);

        device.beginPass(target, index === 0 ? 'none' : step.blendMode, index === 0);
        device.bindTexture(program, 'uSource', source.texture, 0);
        device.setUniforms(program, {
            uOpacity: step.opacity,
            uResolution: [plan.width, plan.height],
            uStops: stops.flat(),
            uStopCount: stops.length,
            uTint: frame.grade.tint,
            uChromatic: 1,
        });
        device.drawFullscreen();
        stats.passesExecuted += 1;
    });
}

// `sumMotion` stood here. It summed every motion-typed resource in the graph into one kernel-owned
// field, weighted by one over the root of the contributor count, and the accumulation was gathered
// through the result. Retired with the drag it fed (ADR-0012): a kernel pass that silently consumes
// every field a scene happens to contain is a second mechanism for what the graph now does
// explicitly, and where a field reaches the picture is worth being able to see.

/**
 * Blanks every historical slot the plan allocates.
 *
 * `advanceAccumulation` stood here, dragging one kernel-owned buffer through the summed motion field
 * and screening the composite onto it. Deleted with ADR-0013, along with the buffer.
 *
 * What survives is the intent behind `clearAccumulation`: on a seek the clock is frozen, so a decay
 * over a zero delta is exactly one, and anything holding the previous passage would carry it across
 * the new one indefinitely. That used to be one texture and is now however many resources the scene
 * reads historically, so the clear follows the plan instead of a constant.
 */
function clearHistorySlots(device: Device, plan: RenderPlan): void {
    for (const entry of plan.targets) {
        if (entry.slot === undefined) {
            continue;
        }

        const target = device.acquireTarget(entry.key, entry.width, entry.height);
        device.beginPass(target, 'none', true);
    }
}

/**
 * Grades the composite onto the canvas.
 *
 * The final stage, and the only one that compresses — and since ADR-0013 the only stage that bounds
 * the pipeline at all. `ToneMapper` sits inside the graph, so it cannot be the last word: whatever it
 * rolls off can be added back by anything downstream of it.
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
