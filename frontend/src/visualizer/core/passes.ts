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
