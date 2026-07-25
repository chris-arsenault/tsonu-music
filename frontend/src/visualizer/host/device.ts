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

export interface Program {
    program: WebGLProgram;
    uniforms: Map<string, WebGLUniformLocation>;
    attributes: Map<string, number>;
}

/** Highest pixel ratio the visualizer renders at. Full retina is not worth the fill cost. */
const MAX_PIXEL_RATIO = 1.5;

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
    hasShader(id: string): boolean;
    /** Compilation problems collected at registration, for the diagnostics overlay. */
    shaderErrors(): { id: string; message: string }[];

    uploadGeometry(upload: GeometryUpload): void;

    acquireTarget(key: string, width: number, height: number): RenderTarget;
    releaseUnused(liveKeys: ReadonlySet<string>): void;

    beginPass(target: RenderTarget | null, blend: BlendMode, clear: boolean): void;
    useProgram(id: string): Program | undefined;
    setUniforms(program: Program, uniforms: Readonly<Record<string, UniformValue>>): void;
    bindTexture(program: Program, sampler: string, texture: WebGLTexture, unit: number): void;

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

    const capabilities: DeviceCapabilities = {
        floatRenderTargets: floatExtension !== null,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
        maxPixelRatio: Math.min(MAX_PIXEL_RATIO, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1),
    };

    const programs = new Map<string, Program>();
    const errors: { id: string; message: string }[] = [];
    const targets = new Map<string, RenderTarget>();
    const geometries = new Map<string, { buffer: WebGLBuffer; vao: WebGLVertexArrayObject; stride: number }>();

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

            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                errors.push({ id: source.id, message: gl.getProgramInfoLog(program) ?? 'unknown link error' });
                gl.deleteProgram(program);
                return;
            }

            const uniforms = new Map<string, WebGLUniformLocation>();
            const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
            for (let index = 0; index < uniformCount; index += 1) {
                const info = gl.getActiveUniform(program, index);
                const location = info && gl.getUniformLocation(program, info.name);
                if (info && location) {
                    uniforms.set(info.name, location);
                }
            }

            const attributes = new Map<string, number>();
            const attributeCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
            for (let index = 0; index < attributeCount; index += 1) {
                const info = gl.getActiveAttrib(program, index);
                if (info) {
                    attributes.set(info.name, gl.getAttribLocation(program, info.name));
                }
            }

            programs.set(source.id, { program, uniforms, attributes });
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
                const location = program.uniforms.get(name);
                if (!location) {
                    continue;
                }

                if (typeof value === 'number') {
                    gl.uniform1f(location, value);
                } else if (typeof value === 'boolean') {
                    gl.uniform1i(location, value ? 1 : 0);
                } else if (value.length === 2) {
                    gl.uniform2fv(location, value as number[]);
                } else if (value.length === 3) {
                    gl.uniform3fv(location, value as number[]);
                } else if (value.length === 4) {
                    gl.uniform4fv(location, value as number[]);
                } else if (value.length === 9) {
                    gl.uniformMatrix3fv(location, false, value as number[]);
                } else if (value.length === 16) {
                    gl.uniformMatrix4fv(location, false, value as number[]);
                } else {
                    gl.uniform1fv(location, value as number[]);
                }
            }
        },

        bindTexture(program, sampler, texture, unit) {
            const location = program.uniforms.get(sampler);
            if (!location) {
                return;
            }

            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniform1i(location, unit);
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

            for (const entry of geometries.values()) {
                gl.deleteBuffer(entry.buffer);
                gl.deleteVertexArray(entry.vao);
            }
            geometries.clear();

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
