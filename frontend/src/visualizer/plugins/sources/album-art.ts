/**
 * Album-art sources and derivations (spec sections 19.3, 13).
 *
 * Artwork existing must not require it to appear. `AlbumArtSource` shows it; the derivations extract
 * palette, edges, and displacement from it without any of the image itself reaching the screen. A scene
 * can use one, several, or none.
 */

import type { VisualPluginDefinition, VisualPluginInstance } from '../../core/plugin';
import type { RenderPass } from '../../core/passes';
import { QUAD_VERTEX_SHADER } from '../../host/device';

const ART_SHADER = 'album-art';
const PALETTE_SHADER = 'album-art-palette';
const EDGES_SHADER = 'album-art-edges';
const DISPLACEMENT_SHADER = 'album-art-displacement';
// Its own id: two plugins sharing one meant whichever registered first silently won.
const LUMINANCE_SHADER = 'image-luminance-field';

const ART_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uArt;
uniform vec2 uResolution;
uniform float uOpacity;
uniform float uZoom;
uniform vec2 uFocal;

void main() {
    // Zoom about the focal point rather than the centre, so a subject stays framed.
    vec2 uv = (vUv - uFocal) / max(uZoom, 0.01) + uFocal;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        fragColor = vec4(0.0);
        return;
    }

    fragColor = texture(uArt, uv) * uOpacity;
}`;

/**
 * Reduces the artwork to a small palette strip by averaging coarse blocks and sorting nothing: the
 * strip is sampled by position, so a consumer gets a spatially coherent set of the image's own colours.
 */
const PALETTE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uArt;
uniform vec2 uResolution;
uniform float uSaturationFloor;

void main() {
    // One row of swatches; each x band averages a vertical slice of the artwork.
    float band = floor(vUv.x * 8.0) / 8.0;
    vec3 total = vec3(0.0);
    float weight = 0.0;

    for (int sy = 0; sy < 8; sy += 1) {
        for (int sx = 0; sx < 4; sx += 1) {
            vec2 uv = vec2(band + float(sx) / 32.0, (float(sy) + 0.5) / 8.0);
            vec3 sampled = texture(uArt, uv).rgb;

            float high = max(max(sampled.r, sampled.g), sampled.b);
            float low = min(min(sampled.r, sampled.g), sampled.b);
            float saturation = high > 0.0 ? (high - low) / high : 0.0;

            // Weighting by saturation keeps a washed-out average from swallowing the real colour.
            float w = uSaturationFloor + saturation;
            total += sampled * w;
            weight += w;
        }
    }

    fragColor = vec4(weight > 0.0 ? total / weight : vec3(0.0), 1.0);
}`;

const EDGES_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uArt;
uniform vec2 uResolution;
uniform float uStrength;
uniform float uThreshold;

float luminance(vec2 uv) {
    vec3 c = texture(uArt, clamp(uv, 0.0, 1.0)).rgb;
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
    vec2 texel = 1.0 / uResolution;

    // Sobel: recognizable edge geometry without the image itself being shown.
    float tl = luminance(vUv + texel * vec2(-1.0, -1.0));
    float tc = luminance(vUv + texel * vec2(0.0, -1.0));
    float tr = luminance(vUv + texel * vec2(1.0, -1.0));
    float ml = luminance(vUv + texel * vec2(-1.0, 0.0));
    float mr = luminance(vUv + texel * vec2(1.0, 0.0));
    float bl = luminance(vUv + texel * vec2(-1.0, 1.0));
    float bc = luminance(vUv + texel * vec2(0.0, 1.0));
    float br = luminance(vUv + texel * vec2(1.0, 1.0));

    float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
    float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
    float magnitude = length(vec2(gx, gy)) * uStrength;
    float edge = smoothstep(uThreshold, uThreshold + 0.25, magnitude);

    fragColor = vec4(vec3(edge), edge);
}`;

const DISPLACEMENT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uArt;
uniform vec2 uResolution;
uniform float uScale;

void main() {
    vec2 texel = 1.0 / uResolution;

    float left = dot(texture(uArt, clamp(vUv - vec2(texel.x, 0.0), 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
    float right = dot(texture(uArt, clamp(vUv + vec2(texel.x, 0.0), 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
    float down = dot(texture(uArt, clamp(vUv - vec2(0.0, texel.y), 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
    float up = dot(texture(uArt, clamp(vUv + vec2(0.0, texel.y), 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));

    // Luminance gradient as a vector field: bright regions push, dark regions pull.
    vec2 displacement = vec2(right - left, up - down) * uScale;
    float scalar = dot(texture(uArt, vUv).rgb, vec3(0.299, 0.587, 0.114));

    fragColor = vec4(displacement, scalar, 1.0);
}`;

/**
 * Luminance as a mask.
 *
 * `ImageLuminanceField` declares a `mask-texture` output but reused the displacement fragment above,
 * whose red channel is the horizontal luminance gradient — the actual luminance sits in blue. Every
 * mask consumer reads red, so wiring this into a signed distance field gave `step(0.5, ~0)`: a mask
 * identically zero, no boundary anywhere, and a constant distance field. Only the shader *id*
 * differed from `AlbumArtDisplacement`, so the two plugins were the same pass under two names.
 */
const LUMINANCE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uArt;
uniform vec2 uResolution;
uniform float uScale;

void main() {
    float luminance = dot(texture(uArt, vUv).rgb, vec3(0.299, 0.587, 0.114));
    float masked = clamp(luminance * uScale, 0.0, 1.0);

    fragColor = vec4(vec3(masked), 1.0);
}`;

interface DerivationConfig {
    shaderId: string;
    fragment: string;
    sampler: string;
    outputPort: string;
    uniforms: Record<string, number>;
}

function derivation(config: DerivationConfig) {
    return (context: Parameters<VisualPluginDefinition['create']>[0]): VisualPluginInstance => ({
        initialize() {
            context.registerShader({
                id: config.shaderId,
                vertex: QUAD_VERTEX_SHADER,
                fragment: config.fragment,
            });
        },
        activate() {
            // Derivations are recomputed from the artwork, so there is nothing to seed.
        },
        update() {
            // Nothing to advance; the artwork does not change within a track.
        },
        render(render): RenderPass[] {
            const art = render.inputs.art;
            if (!art) {
                return [];
            }

            return [{
                kind: 'fullscreen',
                shader: config.shaderId,
                inputs: { [config.sampler]: art },
                output: render.outputs[config.outputPort],
                // Artwork is a texture the plugin transforms, not a frame it generates, and the
                // replacement leaves nothing of the target for a clear to remove (ADR-0014).
                blend: 'none',
                clear: false,
                uniforms: config.uniforms,
            }];
        },
        deactivate() {
            // Nothing retained.
        },
        destroy() {
            // Nothing retained.
        },
    });
}

/** Displays or injects the artwork directly. */
export function createAlbumArtSource(): VisualPluginDefinition {
    return {
        id: 'AlbumArtSource',
        version: 1,
        category: 'source',
        inputs: [{ name: 'art', type: 'color-texture', required: true, fromAsset: true }],
        outputs: [{ name: 'color', type: 'color-texture', required: false }],
        capabilities: ['album-art'],
        cost: { gpu: 1, cpu: 0, memory: 2, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.5, motionEnergy: 0.1, geometricOrder: 0.5,
            // The one plugin here that puts the image itself on screen.
            recognizability: 1, persistence: 0.6, brightness: 0.6, dominance: 'either',
        },
        activationRules: { activationWeight: 1, requiredAssets: ['album-art'], minimumDuration: 10 },
        parameters: { opacity: 1, zoom: 1 },
        defaultBindings: [
            {
                feature: 'rms',
                role: 'intensity',
                parameter: 'opacity',
                outputRange: [0.55, 1],
                attack: 0.15,
                release: 0.6,
                curve: 'smooth',
            },
        {
            feature: 'bass',
            parameter: 'zoom',
            outputRange: [1, 1.12],
            attack: 0.12,
            release: 0.5,
            curve: 'smooth',
        }],
        deactivationPolicy: 'fade',
        create(context) {
            const instance = derivation({
                shaderId: ART_SHADER,
                fragment: ART_FRAGMENT,
                sampler: 'uArt',
                outputPort: 'color',
                uniforms: { uOpacity: 1, uZoom: 1 },
            })(context);

            return {
                ...instance,
                render(render) {
                    const art = render.inputs.art;
                    if (!art) {
                        return [];
                    }

                    return [{
                        kind: 'fullscreen',
                        shader: ART_SHADER,
                        inputs: { uArt: art },
                        output: render.outputs.color,
                        blend: 'none',
                        clear: false,
                        uniforms: { uOpacity: 1, uZoom: 1, uFocal: [0.5, 0.5] },
                    }];
                },
            };
        },
    };
}

/** Extracts a track-derived palette. Supporting only: it puts nothing on screen itself. */
export function createAlbumArtPalette(): VisualPluginDefinition {
    return {
        id: 'AlbumArtPalette',
        version: 1,
        category: 'source',
        inputs: [{ name: 'art', type: 'color-texture', required: true, fromAsset: true }],
        outputs: [{ name: 'palette', type: 'palette', required: false }],
        capabilities: ['album-art', 'palette'],
        cost: { gpu: 1, cpu: 0, memory: 1, renderPasses: 1, qualityScalable: false, dominant: false },
        character: {
            visualDensity: 0, motionEnergy: 0, geometricOrder: 0.5,
            recognizability: 0.3, persistence: 1, brightness: 0.5, dominance: 'supporting',
        },
        activationRules: { activationWeight: 3, requiredAssets: ['album-art'] },
        parameters: { saturationFloor: 0.15 },
        deactivationPolicy: 'immediate',
        create: derivation({
            shaderId: PALETTE_SHADER,
            fragment: PALETTE_FRAGMENT,
            sampler: 'uArt',
            outputPort: 'palette',
            uniforms: { uSaturationFloor: 0.15 },
        }),
    };
}

/** Produces recognizable edge geometry or a mask from the artwork. */
export function createAlbumArtEdges(): VisualPluginDefinition {
    return {
        id: 'AlbumArtEdges',
        version: 1,
        category: 'source',
        inputs: [{ name: 'art', type: 'color-texture', required: true, fromAsset: true }],
        outputs: [{ name: 'edges', type: 'mask-texture', required: false }],
        capabilities: ['album-art', 'edge-geometry'],
        cost: { gpu: 2, cpu: 0, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0.4, motionEnergy: 0.2, geometricOrder: 0.6,
            recognizability: 0.7, persistence: 0.8, brightness: 0.5, dominance: 'supporting',
        },
        activationRules: { activationWeight: 2, requiredAssets: ['album-art'] },
        parameters: { strength: 1.5, threshold: 0.12 },
        defaultBindings: [
            {
                feature: 'highMidExcite',
                role: 'detail',
                parameter: 'threshold',
                outputRange: [0.2, 0.05],
                attack: 0.05,
                release: 0.4,
                curve: 'sqrt',
            },
        {
            feature: 'treble',
            parameter: 'strength',
            outputRange: [0.8, 2.4],
            attack: 0.05,
            release: 0.35,
            curve: 'sqrt',
        }],
        deactivationPolicy: 'fade',
        create: derivation({
            shaderId: EDGES_SHADER,
            fragment: EDGES_FRAGMENT,
            sampler: 'uArt',
            outputPort: 'edges',
            uniforms: { uStrength: 1.5, uThreshold: 0.12 },
        }),
    };
}

/** Produces scalar and vector displacement from artwork luminance. */
export function createAlbumArtDisplacement(): VisualPluginDefinition {
    return {
        id: 'AlbumArtDisplacement',
        version: 1,
        category: 'field',
        inputs: [{ name: 'art', type: 'color-texture', required: true, fromAsset: true }],
        outputs: [{ name: 'displacement', type: 'vector-field', required: false }],
        capabilities: ['album-art', 'displacement'],
        cost: { gpu: 1, cpu: 0, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0, motionEnergy: 0.4, geometricOrder: 0.3,
            recognizability: 0.5, persistence: 0.9, brightness: 0, dominance: 'supporting',
        },
        activationRules: { activationWeight: 1.5, requiredAssets: ['album-art'] },
        parameters: { scale: 1 },
        defaultBindings: [
            {
                feature: 'bass',
                role: 'large-scale-force',
                parameter: 'scale',
                outputRange: [0.5, 2.2],
                attack: 0.1,
                release: 0.5,
                curve: 'smooth',
            },
        ],
        deactivationPolicy: 'fade',
        create: derivation({
            shaderId: DISPLACEMENT_SHADER,
            fragment: DISPLACEMENT_FRAGMENT,
            sampler: 'uArt',
            outputPort: 'displacement',
            uniforms: { uScale: 1 },
        }),
    };
}

/** Uses image brightness as a density, force, or displacement field. Works on any image, not only art. */
export function createImageLuminanceField(): VisualPluginDefinition {
    return {
        id: 'ImageLuminanceField',
        version: 1,
        category: 'field',
        inputs: [{ name: 'art', type: 'color-texture', required: true, fromAsset: true }],
        outputs: [{ name: 'luminance', type: 'mask-texture', required: false }],
        capabilities: ['luminance-field'],
        cost: { gpu: 1, cpu: 0, memory: 1, renderPasses: 1, qualityScalable: true, dominant: false },
        character: {
            visualDensity: 0, motionEnergy: 0.1, geometricOrder: 0.4,
            recognizability: 0.4, persistence: 1, brightness: 0, dominance: 'supporting',
        },
        activationRules: { activationWeight: 1 },
        parameters: { scale: 1 },
        defaultBindings: [
            {
                feature: 'lowMid',
                role: 'deformation',
                parameter: 'scale',
                outputRange: [0.6, 1.8],
                attack: 0.3,
                release: 1,
                curve: 'smooth',
            },
        ],
        deactivationPolicy: 'immediate',
        create: derivation({
            shaderId: LUMINANCE_SHADER,
            fragment: LUMINANCE_FRAGMENT,
            sampler: 'uArt',
            outputPort: 'luminance',
            uniforms: { uScale: 1 },
        }),
    };
}
