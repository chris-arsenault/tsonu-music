/**
 * Render pass descriptors.
 *
 * A plugin's `render` returns plain-data descriptions of the GPU work it wants, and the runtime
 * executes them. Plugins never touch the WebGL context.
 *
 * This is what lets pass structure be unit-tested without a GL context, and lets the performance
 * controller rewrite scale and pass count without any plugin cooperating.
 */

export type BlendMode =
    | 'none'
    | 'normal'
    | 'add'
    | 'screen'
    | 'multiply'
    | 'difference'
    | 'lighten'
    | 'darken';

export type UniformValue = number | boolean | readonly number[];

/** Identifies a shader program registered by a plugin at initialization. */
export type ShaderId = string;

/** Identifies a vertex buffer a plugin owns and rewrites in `update`. */
export type GeometryId = string;

/** Identifies a texture in the graph: a plugin output, a feedback read, or an asset. */
import type { PortType } from './plugin';

export type ResourceId = string;

export type Primitive =
    | 'points'
    | 'lines'
    | 'line-strip'
    | 'triangles'
    | 'triangle-strip';

interface PassCommon {
    shader: ShaderId;
    /** Sampler uniform name to the resource bound to it. */
    inputs?: Readonly<Record<string, ResourceId>>;
    uniforms?: Readonly<Record<string, UniformValue>>;
    /** Where the pass draws. Omitted means the graph's output for this plugin. */
    output?: ResourceId;
    blend?: BlendMode;
    /** Clears the target before drawing. Feedback passes leave this off. */
    clear?: boolean;
    /**
     * Scales the target's resolution relative to the render size. The performance controller lowers
     * this rather than asking plugins to change anything.
     */
    scale?: number;
}

export interface FullscreenPass extends PassCommon {
    kind: 'fullscreen';
}

export interface GeometryPass extends PassCommon {
    kind: 'geometry';
    geometry: GeometryId;
    primitive: Primitive;
    vertexCount: number;
}

export type RenderPass = FullscreenPass | GeometryPass;

/** Vertex data a plugin uploads. `attributes` names must match the shader's inputs. */
export interface GeometryUpload {
    id: GeometryId;
    data: Float32Array;
    /** Component count per attribute, in buffer order. */
    attributes: readonly { name: string; components: number }[];
}

export interface ShaderSource {
    id: ShaderId;
    vertex: string;
    fragment: string;
}

/** Total draw calls a pass list issues, used by the performance controller's cost accounting. */
export function countPasses(passes: readonly RenderPass[]): number {
    return passes.length;
}

/** Every resource a pass list reads. Used to validate that a plugin only reads what it declared. */
export function passInputs(passes: readonly RenderPass[]): ResourceId[] {
    const inputs = new Set<ResourceId>();

    for (const pass of passes) {
        for (const resource of Object.values(pass.inputs ?? {})) {
            inputs.add(resource);
        }
    }

    return [...inputs];
}

/** Every resource a pass list writes. */
export function passOutputs(passes: readonly RenderPass[]): ResourceId[] {
    const outputs = new Set<ResourceId>();

    for (const pass of passes) {
        if (pass.output !== undefined) {
            outputs.add(pass.output);
        }
    }

    return [...outputs];
}

export function isGeometryPass(pass: RenderPass): pass is GeometryPass {
    return pass.kind === 'geometry';
}

/** Clamped so a plugin cannot ask for more resolution than the render size. */
export function resolvePassScale(pass: RenderPass, qualityScale: number): number {
    const requested = pass.scale ?? 1;
    const scale = requested * qualityScale;

    return scale <= 0 ? 0 : scale > 1 ? 1 : scale;
}

/**
 * What a plugin's declared capabilities let the quality profile switch off.
 *
 * The performance ladder gives things up in a specific order (spec section 21.2), and most of those rungs
 * are about which plugins keep running rather than about resolution. Expressed against capabilities so
 * the ladder needs no list of plugin ids.
 */
export interface QualityGate {
    secondaryPostProcess: boolean;
    expensiveSupporting: boolean;
    expensivePrimary: boolean;
}

export function isSuppressedByQuality(
    capabilities: readonly string[],
    dominance: 'supporting' | 'primary' | 'either',
    gpuCost: number,
    gate: QualityGate,
): boolean {
    // Optional glow and secondary post-processing is the first whole plugin the ladder drops.
    if (!gate.secondaryPostProcess && capabilities.includes('secondary-postprocess')) {
        return true;
    }

    // Then the most expensive supporting plugin, then the most expensive optional primary. Supporting
    // and primary is the plugin's declared character, not its cost flag: an expensive primary defines the
    // scene and must outlive an expensive support act.
    if (!gate.expensiveSupporting && gpuCost >= 2 && dominance === 'supporting') {
        return true;
    }

    if (!gate.expensivePrimary && gpuCost >= 3) {
        return true;
    }

    return false;
}

/** The minimum a node needs to know about itself to be checked for reachability. */
interface ReachableNode {
    instanceId: string;
    outputs: Record<string, ResourceId>;
    inputs: Record<string, ResourceId>;
    definition: { outputs: readonly { name: string; type: PortType }[] };
}

/**
 * Instances whose work no longer reaches the screen once `skipped` are not run.
 *
 * The scene builder already prunes plugins that contribute to nothing, but quality suppression and
 * the diagnostics controls remove plugins *after* assembly, one node at a time, leaving whatever fed
 * them running into a buffer nobody reads. A particle simulator is the clearest case: its output is a
 * particle buffer, never a colour texture, so with its renderer suppressed it produces no pixels at
 * all while still costing a full simulation pass every frame — and the scene silently loses the
 * element it was built around.
 *
 * A node survives if it still writes something terminal — a colour texture or a motion field that the
 * kernel sums — or if anything still running reads one of its outputs.
 */
export function unreachableInstances(
    order: readonly ReachableNode[],
    skipped: ReadonlySet<string>,
    isTerminalType: (type: PortType) => boolean,
): Set<string> {
    const dead = new Set(skipped);

    // Repeated to a fixed point, because dropping one node can strand the node that fed it.
    for (let pass = 0; pass < order.length; pass += 1) {
        let changed = false;

        for (const node of order) {
            if (dead.has(node.instanceId)) {
                continue;
            }

            const terminal = node.definition.outputs.some((port) =>
                isTerminalType(port.type) && node.outputs[port.name] !== undefined);
            if (terminal) {
                continue;
            }

            const written = new Set(Object.values(node.outputs));
            const readByLive = order.some((other) =>
                !dead.has(other.instanceId)
                && other.instanceId !== node.instanceId
                && Object.values(other.inputs).some((resource) => written.has(resource)));

            if (!readByLive) {
                dead.add(node.instanceId);
                changed = true;
            }
        }

        if (!changed) {
            break;
        }
    }

    return dead;
}
