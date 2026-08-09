/**
 * Plugin registration and the hand-wired first scene.
 *
 * Registration is a plain function call against the registry — no kernel file changes as the catalog
 * grows. The scene here is fixed; the scheduler that assembles scenes from grammar arrives in M2.
 */

import { createPluginRegistry, type PluginRegistry, type VisualPluginDefinition } from '../core/plugin';
import type { GraphNode, RenderGraphEdge } from '../core/graph';
import { createSignalTraceSource, SIGNAL_TRACE_MODES } from './sources/signal-trace';
import { createFeedbackFlowTransform, FEEDBACK_FLOW_MODES } from './transformers/feedback-flow';
import { createFieldAdvectTransform } from './transformers/field-feedback';
import { createToneMapper } from './postprocess/tone-mapper';
import {
    createAlbumArtDisplacement,
    createAlbumArtEdges,
    createAlbumArtPalette,
    createAlbumArtSource,
    createImageLuminanceField,
} from './sources/album-art';
import {
    createMaskBoundaryField,
    createMaskContainmentField,
    createMaskEffectStencil,
    createMaskSignedDistanceField,
} from './fields/mask-fields';
import {
    createParametricCurveSource,
    createProceduralPalette,
    createProceduralTextureSource,
    createSdfShapeSource,
    PARAMETRIC_CURVE_MODES,
    PROCEDURAL_TEXTURE_MODES,
    SDF_SHAPE_MODES,
} from './sources/procedural';
import {
    createSpectrumGeometrySource,
    createTransientGlyphSource,
    GLYPH_MODES,
    SPECTRUM_MODES,
} from './sources/spectrum';
import {
    createAudioImpulseField,
    createProceduralVectorField,
    IMPULSE_FIELD_MODES,
    VECTOR_FIELD_MODES,
} from './fields/procedural-fields';
import {
    createParticleEmitter,
    createParticleCollider,
    createParticleForceField,
    createParticleRenderer,
    createParticleSimulator,
    EMITTER_MODES,
    COLLIDER_MODES,
    FORCE_MODES,
    PARTICLE_RENDER_MODES,
} from './simulators/particles';
import {
    createReactionDiffusionSimulator,
    createReactionDiffusionView,
    createWaveFieldSimulator,
    createWaveFieldView,
} from './simulators/continuous';
import { CASCADE_MODES, createImpactCascadeSimulator } from './simulators/impact-cascade';
import {
    COORDINATE_WARP_MODES,
    createCoordinateWarpTransform,
    createDomainWarpTransform,
    createEdgeContourTransform,
    createShockwaveTransform,
    createSymmetryTransform,
    createTilingTransform,
    DOMAIN_WARP_MODES,
    EDGE_CONTOUR_MODES,
    SHOCKWAVE_MODES,
    SYMMETRY_MODES,
    TILING_MODES,
} from './transformers/transforms';
import {
    COLOR_TRANSFORM_MODES,
    createColorTransform,
    createFlowFieldCompositor,
    createGlowAndScatter,
    createLayerMixer,
    createMaskRouter,
    createPaletteMapper,
    GLOW_MODES,
    LAYER_MIXER_MODES,
    MASK_ROUTER_MODES,
} from './compositors/composition';
import { SCENE_HISTORY_MODES, createSceneHistoryWarp } from './transformers/scene-history';
import { createSceneStateCombine } from './compositors/scene-state';

/** Signal-derived and procedural plugins, available whether or not any asset is loaded. */
export function m1Definitions(): VisualPluginDefinition[] {
    return [
        ...SIGNAL_TRACE_MODES.map(createSignalTraceSource),
        ...FEEDBACK_FLOW_MODES.map(createFeedbackFlowTransform),
        createToneMapper(),
    ];
}

/**
 * Asset-derivation plugins. Registered unconditionally; their `requiredAssets` rules are what keep them
 * inactive until an asset is actually loaded, so artwork and masks stay optional.
 */
export function assetDefinitions(): VisualPluginDefinition[] {
    return [
        createAlbumArtSource(),
        createAlbumArtPalette(),
        createAlbumArtEdges(),
        createAlbumArtDisplacement(),
        createImageLuminanceField(),
        createMaskSignedDistanceField(),
        createMaskContainmentField(),
        createMaskEffectStencil(),
        createMaskBoundaryField(),
    ];
}

/** Procedural and spectrum sources (spec section 19.1, 19.2). */
export function sourceDefinitions(): VisualPluginDefinition[] {
    return [
        createProceduralPalette(),
        ...PROCEDURAL_TEXTURE_MODES.map(createProceduralTextureSource),
        ...PARAMETRIC_CURVE_MODES.map(createParametricCurveSource),
        ...SDF_SHAPE_MODES.map(createSdfShapeSource),
        ...SPECTRUM_MODES.map(createSpectrumGeometrySource),
        ...GLYPH_MODES.map(createTransientGlyphSource),
    ];
}

/** Procedural and audio-driven fields (spec section 19.4). */
export function fieldDefinitions(): VisualPluginDefinition[] {
    return [
        ...VECTOR_FIELD_MODES.map(createProceduralVectorField),
        ...IMPULSE_FIELD_MODES.map(createAudioImpulseField),
    ];
}

/** Particle, continuous, and impact simulation (spec sections 19.5, 19.6, 19.7). */
export function simulatorDefinitions(): VisualPluginDefinition[] {
    return [
        createParticleSimulator(),
        ...EMITTER_MODES.map(createParticleEmitter),
        ...FORCE_MODES.map(createParticleForceField),
        ...COLLIDER_MODES.map(createParticleCollider),
        ...PARTICLE_RENDER_MODES.map(createParticleRenderer),
        createReactionDiffusionSimulator(),
        createReactionDiffusionView(),
        createWaveFieldSimulator(),
        createWaveFieldView(),
        ...CASCADE_MODES.map(createImpactCascadeSimulator),
    ];
}

/** Coordinate and image transformers (spec section 19.8). */
export function transformerDefinitions(): VisualPluginDefinition[] {
    return [
        ...SYMMETRY_MODES.map(createSymmetryTransform),
        ...COORDINATE_WARP_MODES.map(createCoordinateWarpTransform),
        ...DOMAIN_WARP_MODES.map(createDomainWarpTransform),
        ...TILING_MODES.map(createTilingTransform),
        ...EDGE_CONTOUR_MODES.map(createEdgeContourTransform),
        ...SHOCKWAVE_MODES.map(createShockwaveTransform),
        // The drag, which the kernel used to own (ADR-0012) and which no longer carries its own
        // combine (ADR-0013).
        createFieldAdvectTransform(),
    ];
}

/** Compositors and colour (spec section 19.9). */
export function compositorDefinitions(): VisualPluginDefinition[] {
    return [
        createFlowFieldCompositor(),
        ...LAYER_MIXER_MODES.map(createLayerMixer),
        ...MASK_ROUTER_MODES.map(createMaskRouter),
        createPaletteMapper(),
        ...COLOR_TRANSFORM_MODES.map(createColorTransform),
        ...GLOW_MODES.map(createGlowAndScatter),
    ];
}

/** Builder-owned nodes, registered so captures and the Lab editor resolve the graph exactly. */
export function derivedStateDefinitions(): VisualPluginDefinition[] {
    return [
        ...SCENE_HISTORY_MODES.map(createSceneHistoryWarp),
        createSceneStateCombine(),
    ];
}

export function allDefinitions(): VisualPluginDefinition[] {
    return [
        ...m1Definitions(),
        ...assetDefinitions(),
        ...sourceDefinitions(),
        ...fieldDefinitions(),
        ...simulatorDefinitions(),
        ...transformerDefinitions(),
        ...compositorDefinitions(),
        ...derivedStateDefinitions(),
    ];
}

export function createM1Registry(): PluginRegistry {
    return createPluginRegistry(allDefinitions());
}

export interface SceneDefinition {
    nodes: GraphNode[];
    edges: RenderGraphEdge[];
    present: { instanceId: string; port: string };
}

/**
 * Trace through tone mapping into the canonical scene-state pair.
 *
 * The renderer assembles scenes through the scheduler rather than using this. It is kept as a fixed
 * reference scene: a hand-checked graph that must keep compiling, so a change to the plugin contract or
 * the graph rules fails a test rather than silently producing an unrenderable scene.
 */
export function firstLightScene(registry: PluginRegistry): SceneDefinition {
    const trace = required(registry, 'SignalTraceSource:circular');
    const toneMapper = required(registry, 'ToneMapper');
    const history = required(registry, 'SceneHistoryWarp:spiral');
    const state = required(registry, 'SceneStateCombine');

    return {
        nodes: [
            { instanceId: 'trace', definition: trace },
            { instanceId: 'tone', definition: toneMapper },
            { instanceId: 'history', definition: history },
            { instanceId: 'state', definition: state },
        ],
        edges: [
            { from: { instanceId: 'trace', port: 'color' }, to: { instanceId: 'tone', port: 'source' } },
            { from: { instanceId: 'tone', port: 'color' }, to: { instanceId: 'state', port: 'source' } },
            {
                from: { instanceId: 'state', port: 'color' },
                to: { instanceId: 'history', port: 'source' },
                feedback: true,
            },
            { from: { instanceId: 'history', port: 'color' }, to: { instanceId: 'state', port: 'history' } },
        ],
        present: { instanceId: 'state', port: 'color' },
    };
}

function required(registry: PluginRegistry, id: string): VisualPluginDefinition {
    const definition = registry.get(id);
    if (!definition) {
        throw new Error(`plugin ${id} is not registered`);
    }

    return definition;
}
