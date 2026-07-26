/**
 * WebGL2 device (ADR-0002).
 *
 * Owns the context, the program cache, the framebuffer pool, geometry buffers, and the fullscreen
 * quad. Nothing here decides anything: it executes pass descriptors handed to it.
 *
 * Shaders compile once at registration and geometry buffers are reused, because per-frame compilation
 * or allocation is what turns a visualizer into a stutter machine.
 */

import { blendFactors } from '../core/layers';
import type { BlendMode, GeometryUpload, Primitive, ShaderSource, UniformValue } from '../core/passes';

export interface DeviceCapabilities {
    floatRenderTargets: boolean;
    /** True when link status can be polled without blocking on the driver. */
    parallelShaderCompile: boolean;
    maxTextureSize: number;
    maxRenderbufferSize: number;
    /** Highest device pixel ratio the device will render at, capped to stay off full retina. */
    maxPixelRatio: number;
}

export interface RenderTarget {
    framebuffer: WebGLFramebuffer;
    texture: WebGLTexture;
    width: number;
    height: number;
}

/**
 * A uniform's location together with the type the shader declared it as.
 *
 * The type is kept because the setter has to dispatch on what the *shader* says, not on what the
 * JavaScript value happens to be. A boolean handed to a `float` uniform through `uniform1i` is
 * `GL_INVALID_OPERATION`: the driver rejects the call, the uniform silently keeps its default, and
 * the only symptom is a feature that quietly does nothing.
 */
export interface UniformSlot {
    location: WebGLUniformLocation;
    /** The GLSL type enum from `getActiveUniform`. */
    type: number;
    size: number;
}

export interface Program {
    program: WebGLProgram;
    uniforms: Map<string, UniformSlot>;
    attributes: Map<string, number>;
}

/** Highest pixel ratio the visualizer renders at. Full retina is not worth the fill cost. */
export const MAX_PIXEL_RATIO = 1.5;

export class DeviceLostError extends Error {
    constructor() {
        super('WebGL context lost');
        this.name = 'DeviceLostError';
    }
}

export interface Device {
    readonly gl: WebGL2RenderingContext;
    readonly capabilities: DeviceCapabilities;
    readonly canvas: HTMLCanvasElement;

    registerShader(source: ShaderSource): void;
    /** Promotes programs the driver has finished linking. Call once per frame. */
    advanceCompilation(): void;
    /** Programs linked but not yet ready, for the diagnostics overlay. */
    pendingShaderCount(): number;
    hasShader(id: string): boolean;
    /** Compilation problems collected at registration, for the diagnostics overlay. */
    shaderErrors(): { id: string; message: string }[];

    uploadGeometry(upload: GeometryUpload): void;

    acquireTarget(key: string, width: number, height: number): RenderTarget;
    releaseUnused(liveKeys: ReadonlySet<string>): void;
    /** Uploads a loaded image as a texture the graph can bind to a plugin input. */
    uploadAssetTexture(key: string, image: HTMLImageElement): void;
    assetTexture(key: string): WebGLTexture | undefined;

    beginPass(target: RenderTarget | null, blend: BlendMode, clear: boolean): void;
    useProgram(id: string): Program | undefined;
    setUniforms(program: Program, uniforms: Readonly<Record<string, UniformValue>>): void;
    bindTexture(program: Program, sampler: string, texture: WebGLTexture, unit: number): void;
    /**
     * Points every sampler the program declares but nothing supplied at a one-by-one zero texture.
     *
     * An unbound sampler is not undefined behaviour — it reads texture unit 0, which is whichever
     * texture was bound there last. In practice that is the pass's first input, so an optional port
     * left unconnected silently aliased a required one: the reaction-diffusion simulator's `seed`
     * sampler read chemical A, primed to 1.0, making its `seed > 0.7` test true across the whole
     * field and flooring chemical B at the impulse floor everywhere, every frame. Gray-Scott cannot
     * form spots or stripes when B is replenished globally, so the plugin produced flat mush whenever
     * no mask was supplied — which is always, before the mask manifest resolves, and permanently if
     * that fetch fails.
     */
    bindEmptySamplers(program: Program, bound: ReadonlySet<string>, startUnit: number): void;
    /**
     * The most recent completed readback of a target, and queues another.
     *
     * Returns data that is a frame or two old, which is the price of not stalling. `readPixels`
     * straight to client memory blocks until the GPU has finished everything queued ahead of it —
     * tens of milliseconds at the wrong moment — so the read goes into a pixel buffer object, a fence
     * is placed after it, and the result is collected on a later frame once the fence has passed.
     *
     * This exists so simulation can run on the CPU against fields the GPU produced. A force field or
     * a mask boundary is a texture, and a particle solver that has to answer "what is pushing this
     * body" and "is there a surface here" cannot see one. Staleness is not a problem for either: a
     * field is smooth over the distance a body travels in two frames.
     */
    readTarget(key: string, width: number, height: number): Float32Array | undefined;

    drawFullscreen(): void;
    drawGeometry(program: Program, geometryId: string, primitive: Primitive, vertexCount: number): void;

    isLost(): boolean;
    /** Discards all GPU objects. Plugin and asset metadata is retained by the caller. */
    invalidate(): void;
    dispose(): void;
}

const QUAD_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

export function createDevice(canvas: HTMLCanvasElement): Device | undefined {
    const gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
    });

    if (!gl) {
        return undefined;
    }

    const floatExtension = gl.getExtension('EXT_color_buffer_float');
    // Lets link status be polled instead of blocking. Without it, a program linked mid-playback stalls
    // the main thread at the first status check — which is exactly when a mutation swaps a plugin in.
    const parallelCompile = gl.getExtension('KHR_parallel_shader_compile') as
        { COMPLETION_STATUS_KHR: number } | null;

    const capabilities: DeviceCapabilities = {
        floatRenderTargets: floatExtension !== null,
        parallelShaderCompile: parallelCompile !== null,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
        maxPixelRatio: Math.min(MAX_PIXEL_RATIO, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1),
    };

    const programs = new Map<string, Program>();
    /** Linked but not yet validated. Checked without blocking until the driver reports completion. */
    const pending = new Map<string, { program: WebGLProgram; source: ShaderSource }>();
    const errors: { id: string; message: string }[] = [];
    const targets = new Map<string, RenderTarget>();
    const assetTextures = new Map<string, WebGLTexture>();
    const geometries = new Map<string, { buffer: WebGLBuffer; vao: WebGLVertexArrayObject; stride: number }>();
    /** In-flight and completed target readbacks, keyed by target. See `readTarget`. */
    const readbacks = new Map<string, {
        buffer: WebGLBuffer | null;
        sync: WebGLSync | null;
        data: Float32Array;
        ready: boolean;
        width: number;
        height: number;
    }>();

    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const quadVao = gl.createVertexArray();
    gl.bindVertexArray(quadVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    let lost = false;
    canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        lost = true;
    });

    // Without this the loss is permanent. `lost` was set and never cleared, and `registerShader`
    // returns early while it is set, so the renderer's recovery path re-registered nothing and the
    // canvas stayed a black rectangle for the rest of the session — after a driver reset that
    // resolves itself in a second. Preventing the default on the loss event is what makes the browser
    // send this at all.
    canvas.addEventListener('webglcontextrestored', () => {
        lost = false;
        // Every GL object from the old context is gone; the caches must not hand out stale handles.
        programs.clear();
        pending.clear();
        targets.clear();
        assetTextures.clear();
        geometries.clear();
        // The fences and pixel buffers belonged to the dead context too, and a sync object from it
        // never signals.
        readbacks.clear();
        empty = null;
    });

    /** One-by-one transparent black, shared by every sampler nothing supplied. See bindEmptySamplers. */
    let empty: WebGLTexture | null = null;
    function emptyTexture(): WebGLTexture {
        if (empty) {
            return empty;
        }

        empty = gl!.createTexture();
        gl!.bindTexture(gl!.TEXTURE_2D, empty);
        gl!.texImage2D(
            gl!.TEXTURE_2D, 0, gl!.RGBA, 1, 1, 0, gl!.RGBA, gl!.UNSIGNED_BYTE,
            new Uint8Array([0, 0, 0, 0]),
        );
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST);
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);

        return empty;
    }

    function compile(type: number, source: string, id: string): WebGLShader | undefined {
        const shader = gl!.createShader(type);
        if (!shader) {
            return undefined;
        }

        gl!.shaderSource(shader, source);
        gl!.compileShader(shader);

        if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
            errors.push({ id, message: gl!.getShaderInfoLog(shader) ?? 'unknown shader error' });
            gl!.deleteShader(shader);
            return undefined;
        }

        return shader;
    }

    /**
     * Validates a linked program and records its uniform and attribute locations.
     *
     * Reading `LINK_STATUS` is the blocking call, so this runs only once the driver has finished — or, on
     * a device without the extension, at most once per frame.
     */
    function finalizeProgram(id: string, program: WebGLProgram, source: ShaderSource): void {
        if (!gl!.getProgramParameter(program, gl!.LINK_STATUS)) {
            errors.push({ id: source.id, message: gl!.getProgramInfoLog(program) ?? 'unknown link error' });
            gl!.deleteProgram(program);
            return;
        }

        const uniforms = new Map<string, UniformSlot>();
        const uniformCount = gl!.getProgramParameter(program, gl!.ACTIVE_UNIFORMS) as number;
        for (let index = 0; index < uniformCount; index += 1) {
            const info = gl!.getActiveUniform(program, index);
            const location = info && gl!.getUniformLocation(program, info.name);
            if (info && location) {
                uniforms.set(info.name, { location, type: info.type, size: info.size });
            }
        }

        const attributes = new Map<string, number>();
        const attributeCount = gl!.getProgramParameter(program, gl!.ACTIVE_ATTRIBUTES) as number;
        for (let index = 0; index < attributeCount; index += 1) {
            const info = gl!.getActiveAttrib(program, index);
            if (info) {
                attributes.set(info.name, gl!.getAttribLocation(program, info.name));
            }
        }

        programs.set(id, { program, uniforms, attributes });
    }

    const device: Device = {
        gl,
        capabilities,
        canvas,

        registerShader(source) {
            if (programs.has(source.id) || lost) {
                return;
            }

            const vertex = compile(gl.VERTEX_SHADER, source.vertex || QUAD_VERTEX_SHADER, source.id);
            const fragment = compile(gl.FRAGMENT_SHADER, source.fragment, source.id);
            if (!vertex || !fragment) {
                return;
            }

            const program = gl.createProgram();
            if (!program) {
                return;
            }

            gl.attachShader(program, vertex);
            gl.attachShader(program, fragment);
            gl.linkProgram(program);
            gl.deleteShader(vertex);
            gl.deleteShader(fragment);

            // Deferred rather than checked here: reading LINK_STATUS blocks until the driver finishes.
            // The pass that wants this program is skipped for the frames it takes to become ready.
            pending.set(source.id, { program, source });
        },

        /**
         * Promotes any program the driver has finished linking.
         *
         * Called once per frame. With `KHR_parallel_shader_compile` the completion check is free; without
         * it, the status read blocks — so at most one program is promoted per frame to bound the stall.
         */
        advanceCompilation() {
            if (pending.size === 0) {
                return;
            }

            let promotedThisFrame = 0;

            for (const [id, entry] of [...pending]) {
                if (!capabilities.parallelShaderCompile) {
                    if (promotedThisFrame >= 1) {
                        break;
                    }
                } else if (!gl.getProgramParameter(entry.program, parallelCompile!.COMPLETION_STATUS_KHR)) {
                    continue;
                }

                pending.delete(id);
                promotedThisFrame += 1;
                finalizeProgram(id, entry.program, entry.source);
            }
        },

        pendingShaderCount() {
            return pending.size;
        },

        hasShader(id) {
            return programs.has(id);
        },

        shaderErrors() {
            return [...errors];
        },

        uploadGeometry(upload) {
            if (lost) {
                return;
            }

            const stride = upload.attributes.reduce((total, attribute) => total + attribute.components, 0);
            let entry = geometries.get(upload.id);

            if (!entry) {
                const buffer = gl.createBuffer();
                const vao = gl.createVertexArray();
                if (!buffer || !vao) {
                    return;
                }

                entry = { buffer, vao, stride };
                geometries.set(upload.id, entry);

                gl.bindVertexArray(vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

                let offset = 0;
                upload.attributes.forEach((attribute, index) => {
                    gl.enableVertexAttribArray(index);
                    gl.vertexAttribPointer(
                        index,
                        attribute.components,
                        gl.FLOAT,
                        false,
                        stride * 4,
                        offset * 4,
                    );
                    offset += attribute.components;
                });

                gl.bindVertexArray(null);
            }

            gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
            // DYNAMIC_DRAW: geometry plugins rewrite this every frame.
            gl.bufferData(gl.ARRAY_BUFFER, upload.data, gl.DYNAMIC_DRAW);
        },

        acquireTarget(key, width, height) {
            const clampedWidth = Math.max(1, Math.min(width, capabilities.maxTextureSize));
            const clampedHeight = Math.max(1, Math.min(height, capabilities.maxTextureSize));
            const existing = targets.get(key);

            if (existing && existing.width === clampedWidth && existing.height === clampedHeight) {
                return existing;
            }

            if (existing) {
                gl.deleteFramebuffer(existing.framebuffer);
                gl.deleteTexture(existing.texture);
            }

            const texture = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, texture);
            // Half-float keeps feedback and simulator state from banding without the bandwidth of
            // full float. Falls back to 8-bit where float targets are unavailable.
            const internalFormat = capabilities.floatRenderTargets ? gl.RGBA16F : gl.RGBA8;
            const type = capabilities.floatRenderTargets ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, clampedWidth, clampedHeight, 0, gl.RGBA, type, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

            const framebuffer = gl.createFramebuffer()!;
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            const target: RenderTarget = { framebuffer, texture, width: clampedWidth, height: clampedHeight };
            targets.set(key, target);

            return target;
        },

        uploadAssetTexture(key, image) {
            if (lost) {
                return;
            }

            const existing = assetTextures.get(key);
            const texture = existing ?? gl.createTexture();
            if (!texture) {
                return;
            }

            gl.bindTexture(gl.TEXTURE_2D, texture);
            // Flipped, because image origin is top-left while GL's is bottom-left.
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

            assetTextures.set(key, texture);
        },

        assetTexture(key) {
            return assetTextures.get(key);
        },

        releaseUnused(liveKeys) {
            for (const [key, target] of targets) {
                if (liveKeys.has(key)) {
                    continue;
                }

                gl.deleteFramebuffer(target.framebuffer);
                gl.deleteTexture(target.texture);
                targets.delete(key);
            }
        },

        beginPass(target, blend, clear) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
            gl.viewport(0, 0, target?.width ?? canvas.width, target?.height ?? canvas.height);

            const factors = blendFactors(blend);
            if (factors.enabled) {
                gl.enable(gl.BLEND);
                gl.blendFunc(glFactor(gl, factors.sourceFactor), glFactor(gl, factors.destinationFactor));
                gl.blendEquation(glEquation(gl, factors.equation));
            } else {
                gl.disable(gl.BLEND);
            }

            if (clear) {
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
        },

        useProgram(id) {
            const entry = programs.get(id);
            if (!entry) {
                return undefined;
            }

            gl.useProgram(entry.program);
            return entry;
        },

        setUniforms(program, uniforms) {
            for (const [name, value] of Object.entries(uniforms)) {
                const slot = program.uniforms.get(name);
                if (!slot) {
                    continue;
                }

                const location = slot.location;

                // Scalars dispatch on the declared type rather than on the JavaScript one. A shader
                // may express a flag as `bool` or as `float` and a caller should not have to know
                // which: passing the wrong one is rejected outright and leaves the uniform unset.
                if (typeof value === 'number' || typeof value === 'boolean') {
                    const scalar = typeof value === 'boolean' ? (value ? 1 : 0) : value;

                    if (slot.type === gl.BOOL || slot.type === gl.INT) {
                        gl.uniform1i(location, Math.round(scalar));
                    } else if (slot.type === gl.FLOAT) {
                        gl.uniform1f(location, scalar);
                    }
                    // Anything else — a sampler or a vector — means the caller and the shader disagree
                    // about what this name is. `shader-contract.test.ts` rejects that statically.

                    continue;
                }

                // Arrays dispatch on the declared type too, for the same reason scalars do. Guessing
                // from the JavaScript length cannot tell a `float[9]` from a `mat3` or a `vec4[4]`
                // from a `mat4`, and it guessed the matrix in both cases — an immediate
                // GL_INVALID_OPERATION that leaves the uniform at whatever it held. Nothing in the
                // catalog passes such an array today, which is exactly why it would be missed.
                const values = value as number[];
                switch (slot.type) {
                    case gl.FLOAT_VEC2:
                        gl.uniform2fv(location, values);
                        break;
                    case gl.FLOAT_VEC3:
                        gl.uniform3fv(location, values);
                        break;
                    case gl.FLOAT_VEC4:
                        gl.uniform4fv(location, values);
                        break;
                    case gl.FLOAT_MAT3:
                        gl.uniformMatrix3fv(location, false, values);
                        break;
                    case gl.FLOAT_MAT4:
                        gl.uniformMatrix4fv(location, false, values);
                        break;
                    case gl.FLOAT:
                        gl.uniform1fv(location, values);
                        break;
                    case gl.INT:
                    case gl.BOOL:
                        gl.uniform1iv(location, values.map(Math.round));
                        break;
                    default:
                        // A sampler, or a type this device does not upload. The static contract check
                        // is where a disagreement of that kind is caught.
                        break;
                }
            }
        },

        bindTexture(program, sampler, texture, unit) {
            const location = program.uniforms.get(sampler)?.location;
            if (!location) {
                return;
            }

            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniform1i(location, unit);
        },

        readTarget(key, width, height) {
            const target = targets.get(key);
            if (!target) {
                return undefined;
            }

            let read = readbacks.get(key);
            if (!read || read.width !== width || read.height !== height) {
                if (read?.buffer) {
                    gl.deleteBuffer(read.buffer);
                }
                read = {
                    buffer: gl.createBuffer(),
                    sync: null,
                    data: new Float32Array(width * height * 4),
                    ready: false,
                    width,
                    height,
                };
                readbacks.set(key, read);
            }

            // Collect the previous request if the GPU has reached the fence. Never waited on: a
            // timeout of zero asks whether it is done, and if it is not the caller keeps last
            // frame's data for another frame.
            if (read.sync) {
                const state = gl.clientWaitSync(read.sync, 0, 0);
                if (state === gl.ALREADY_SIGNALED || state === gl.CONDITION_SATISFIED) {
                    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, read.buffer);
                    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, read.data);
                    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                    gl.deleteSync(read.sync);
                    read.sync = null;
                    read.ready = true;
                }
            }

            if (!read.sync && read.buffer) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, read.buffer);
                gl.bufferData(gl.PIXEL_PACK_BUFFER, read.data.byteLength, gl.STREAM_READ);
                gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, 0);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                read.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            }

            return read.ready ? read.data : undefined;
        },

        bindEmptySamplers(program, bound, startUnit) {
            let unit = startUnit;

            for (const [name, slot] of program.uniforms) {
                if (slot.type !== gl.SAMPLER_2D || bound.has(name)) {
                    continue;
                }

                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, emptyTexture());
                gl.uniform1i(slot.location, unit);
                unit += 1;
            }
        },

        drawFullscreen() {
            gl.bindVertexArray(quadVao);
            // One oversized triangle covers the viewport with fewer vertices than a quad.
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.bindVertexArray(null);
        },

        drawGeometry(_program, geometryId, primitive, vertexCount) {
            const entry = geometries.get(geometryId);
            if (!entry || vertexCount <= 0) {
                return;
            }

            gl.bindVertexArray(entry.vao);
            gl.drawArrays(glPrimitive(gl, primitive), 0, vertexCount);
            gl.bindVertexArray(null);
        },

        isLost() {
            return lost || gl.isContextLost();
        },

        invalidate() {
            for (const target of targets.values()) {
                gl.deleteFramebuffer(target.framebuffer);
                gl.deleteTexture(target.texture);
            }
            targets.clear();

            for (const read of readbacks.values()) {
                if (read.buffer) {
                    gl.deleteBuffer(read.buffer);
                }
                if (read.sync) {
                    gl.deleteSync(read.sync);
                }
            }
            readbacks.clear();

            for (const entry of geometries.values()) {
                gl.deleteBuffer(entry.buffer);
                gl.deleteVertexArray(entry.vao);
            }
            geometries.clear();

            for (const entry of pending.values()) {
                gl.deleteProgram(entry.program);
            }
            pending.clear();

            for (const texture of assetTextures.values()) {
                gl.deleteTexture(texture);
            }
            assetTextures.clear();

            for (const entry of programs.values()) {
                gl.deleteProgram(entry.program);
            }
            programs.clear();
            errors.length = 0;
        },

        dispose() {
            device.invalidate();
            gl.deleteBuffer(quadBuffer);
            gl.deleteVertexArray(quadVao);
        },
    };

    return device;
}

function glFactor(gl: WebGL2RenderingContext, factor: string): number {
    switch (factor) {
        case 'one': return gl.ONE;
        case 'zero': return gl.ZERO;
        case 'src-alpha': return gl.SRC_ALPHA;
        case 'one-minus-src-alpha': return gl.ONE_MINUS_SRC_ALPHA;
        case 'dst-color': return gl.DST_COLOR;
        case 'src-color': return gl.SRC_COLOR;
        case 'one-minus-src-color': return gl.ONE_MINUS_SRC_COLOR;
        case 'one-minus-dst-color': return gl.ONE_MINUS_DST_COLOR;
        default: return gl.ONE;
    }
}

function glEquation(gl: WebGL2RenderingContext, equation: string): number {
    switch (equation) {
        case 'subtract': return gl.FUNC_SUBTRACT;
        case 'reverse-subtract': return gl.FUNC_REVERSE_SUBTRACT;
        case 'min': return gl.MIN;
        case 'max': return gl.MAX;
        default: return gl.FUNC_ADD;
    }
}

function glPrimitive(gl: WebGL2RenderingContext, primitive: Primitive): number {
    switch (primitive) {
        case 'points': return gl.POINTS;
        case 'lines': return gl.LINES;
        case 'line-strip': return gl.LINE_STRIP;
        case 'triangle-strip': return gl.TRIANGLE_STRIP;
        default: return gl.TRIANGLES;
    }
}

export { QUAD_VERTEX_SHADER };
