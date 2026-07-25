import { describe, expect, test } from 'vitest';
import { allDefinitions, assetDefinitions, createM1Registry, m1Definitions } from './registry';
import { validateDefinition, type VisualPluginDefinition } from '../core/plugin';
import { availableAssetIds, albumArtAssetFrom, maskAssetFrom } from '../core/assets';
import { buildScene } from '../core/scene-builder';
import { profileFor } from '../core/performance';
import { GEOMETRIC_SIGNAL_THEME, ORGANIC_FLOW_THEME } from './themes';
import { eligiblePlugins, ineligibleReason, type SchedulerContext } from '../core/scheduler';

function createContext(instanceId = 'test') {
    const shaders: string[] = [];
    return {
        context: {
            instanceId,
            seed: 0.42,
            registerShader: (source: { id: string }) => shaders.push(source.id),
        },
        shaders,
    };
}

function render(definition: VisualPluginDefinition, inputs: Record<string, string | undefined>) {
    const instance = definition.create(createContext().context);
    instance.initialize();

    return instance.render({
        inputs,
        outputs: Object.fromEntries(definition.outputs.map((port) => [port.name, `out.${port.name}`])),
        previous: {},
        renderWidth: 640,
        renderHeight: 360,
    });
}

const MASK_ASSET = maskAssetFrom({ id: 'inkblot', file: 'inkblot.png', interpretation: 'luminance' });
const ART_ASSET = albumArtAssetFrom('https://media.tsonu.com/artwork.jpg');

function schedulerContext(assets: string[]): SchedulerContext {
    return {
        available: allDefinitions(),
        theme: ORGANIC_FLOW_THEME,
        assets,
        capabilities: ['float-textures', 'webgl2'],
        history: {},
        playbackTime: 100,
        allowHighCost: true,
        allowDominant: true,
    };
}

describe('asset plugin catalog', () => {
    test('every asset plugin is structurally valid', () => {
        for (const definition of assetDefinitions()) {
            expect(validateDefinition(definition), definition.id).toEqual([]);
        }
    });

    test('ids stay unique across the whole catalog', () => {
        const ids = allDefinitions().map((definition) => definition.id);

        expect(new Set(ids).size).toBe(ids.length);
    });

    test('the registry holds both signal and asset plugins', () => {
        const registry = createM1Registry();

        expect(registry.all()).toHaveLength(m1Definitions().length + assetDefinitions().length);
        expect(registry.get('AlbumArtPalette')).toBeDefined();
        expect(registry.get('MaskSignedDistanceField')).toBeDefined();
    });

    test('shaders register at initialization, never per frame', () => {
        for (const definition of assetDefinitions()) {
            const { context, shaders } = createContext();
            const instance = definition.create(context);

            expect(shaders).toHaveLength(0);
            instance.initialize();
            expect(shaders.length, definition.id).toBeGreaterThan(0);
        }
    });
});

describe('asset requirements keep assets optional', () => {
    test('mask plugins are ineligible with no mask loaded', () => {
        const context = schedulerContext([]);

        for (const id of ['MaskSignedDistanceField', 'MaskContainmentField', 'MaskEffectStencil', 'MaskBoundaryField']) {
            const definition = allDefinitions().find((entry) => entry.id === id)!;
            expect(ineligibleReason(definition, context), id).toMatch(/missing asset/);
        }
    });

    test('mask plugins become eligible once a mask exists', () => {
        const context = schedulerContext(availableAssetIds([MASK_ASSET]));

        for (const id of ['MaskSignedDistanceField', 'MaskContainmentField', 'MaskEffectStencil', 'MaskBoundaryField']) {
            const definition = allDefinitions().find((entry) => entry.id === id)!;
            expect(ineligibleReason(definition, context), id).toBeUndefined();
        }
    });

    test('artwork plugins are ineligible with no artwork loaded', () => {
        const context = schedulerContext([]);

        for (const id of ['AlbumArtSource', 'AlbumArtPalette', 'AlbumArtEdges', 'AlbumArtDisplacement']) {
            const definition = allDefinitions().find((entry) => entry.id === id)!;
            expect(ineligibleReason(definition, context), id).toMatch(/missing asset/);
        }
    });

    test('artwork plugins become eligible once artwork exists', () => {
        const context = schedulerContext(availableAssetIds([ART_ASSET]));

        for (const id of ['AlbumArtSource', 'AlbumArtPalette', 'AlbumArtEdges'] ) {
            const definition = allDefinitions().find((entry) => entry.id === id)!;
            expect(ineligibleReason(definition, context), id).toBeUndefined();
        }
    });

    test('a mask does not make artwork plugins eligible, or the reverse', () => {
        const maskOnly = schedulerContext(availableAssetIds([MASK_ASSET]));
        const artOnly = schedulerContext(availableAssetIds([ART_ASSET]));

        expect(ineligibleReason(find('AlbumArtSource'), maskOnly)).toMatch(/missing asset/);
        expect(ineligibleReason(find('MaskSignedDistanceField'), artOnly)).toMatch(/missing asset/);
    });

    test('the luminance field needs no asset of its own', () => {
        // It works on any colour texture, so it must not be gated behind artwork.
        expect(ineligibleReason(find('ImageLuminanceField'), schedulerContext([]))).toBeUndefined();
    });

    test('signal plugins never depend on an asset', () => {
        const context = schedulerContext([]);
        const eligible = eligiblePlugins(context).map((definition) => definition.id);

        expect(eligible).toContain('SignalTraceSource:circular');
        expect(eligible).toContain('ToneMapper');
    });
});

describe('mask field derivations', () => {
    test('the distance field derives from a mask texture', () => {
        const passes = render(find('MaskSignedDistanceField'), { mask: 'mask.texture' });

        expect(passes).toHaveLength(1);
        expect(passes[0].inputs).toEqual({ uMask: 'mask.texture' });
        expect(passes[0].output).toBe('out.field');
    });

    test('containment, stencil, and boundary all consume the shared field', () => {
        // One derivation serving several consumers is the point of section 13's reuse.
        expect(render(find('MaskContainmentField'), { field: 'sdf.field' })[0].inputs)
            .toEqual({ uField: 'sdf.field' });
        expect(render(find('MaskBoundaryField'), { field: 'sdf.field' })[0].inputs)
            .toEqual({ uField: 'sdf.field' });
        expect(render(find('MaskEffectStencil'), { source: 'src.color', field: 'sdf.field' })[0].inputs)
            .toEqual({ uSource: 'src.color', uField: 'sdf.field' });
    });

    test('every mask plugin emits nothing when its input is missing', () => {
        for (const id of ['MaskSignedDistanceField', 'MaskContainmentField', 'MaskEffectStencil', 'MaskBoundaryField']) {
            expect(render(find(id), {}), id).toEqual([]);
        }
    });

    test('the stencil needs both inputs, not just one', () => {
        expect(render(find('MaskEffectStencil'), { source: 'src.color' })).toEqual([]);
        expect(render(find('MaskEffectStencil'), { field: 'sdf.field' })).toEqual([]);
    });

    test('a mask drives a stencil with no simulator involved', () => {
        // Section 12.2: masks must not imply particle use.
        const stencil = find('MaskEffectStencil');

        expect(stencil.category).toBe('compositor');
        expect(stencil.capabilities).not.toContain('particles');
        expect(stencil.activationRules.requiredAssets).toEqual(['mask']);
    });

    test('the distance field outputs a distance-field type consumers can accept', () => {
        const field = find('MaskSignedDistanceField');

        expect(field.outputs[0].type).toBe('distance-field');
        // Which also satisfies a mask-texture input, per the graph's compatibility rules.
        expect(find('MaskContainmentField').inputs[0].type).toBe('distance-field');
    });
});

describe('album art derivations', () => {
    test('artwork can be shown directly', () => {
        const passes = render(find('AlbumArtSource'), { art: 'art.texture' });

        expect(passes).toHaveLength(1);
        expect(passes[0].output).toBe('out.color');
        expect(find('AlbumArtSource').character.recognizability).toBe(1);
    });

    test('palette extraction puts nothing on screen', () => {
        const palette = find('AlbumArtPalette');

        expect(palette.outputs[0].type).toBe('palette');
        expect(palette.character.dominance).toBe('supporting');
        expect(palette.character.visualDensity).toBe(0);
    });

    test('edges produce a mask rather than colour', () => {
        expect(find('AlbumArtEdges').outputs[0].type).toBe('mask-texture');
    });

    test('displacement produces a vector field', () => {
        expect(find('AlbumArtDisplacement').outputs[0].type).toBe('vector-field');
    });

    test('every derivation emits nothing without artwork', () => {
        for (const id of ['AlbumArtSource', 'AlbumArtPalette', 'AlbumArtEdges', 'AlbumArtDisplacement']) {
            expect(render(find(id), {}), id).toEqual([]);
        }
    });

    test('artwork can be used for colour, geometry, or displacement independently', () => {
        // Section 26: art must be usable for each of these, and also ignorable.
        expect(render(find('AlbumArtPalette'), { art: 'art.texture' })).toHaveLength(1);
        expect(render(find('AlbumArtEdges'), { art: 'art.texture' })).toHaveLength(1);
        expect(render(find('AlbumArtDisplacement'), { art: 'art.texture' })).toHaveLength(1);
    });
});

describe('scenes with and without assets', () => {
    const base = {
        available: allDefinitions(),
        capabilities: ['float-textures', 'webgl2'],
        history: {},
        playbackTime: 0,
    };

    test('a scene builds with no assets at all', () => {
        const result = buildScene('no-assets', GEOMETRIC_SIGNAL_THEME, { ...base, assets: [] }, profileFor(0));

        expect(result.ok, result.ok ? '' : result.failure.detail).toBe(true);
        if (!result.ok) return;

        // Nothing asset-dependent can have been selected.
        for (const definition of result.scene.plugins) {
            expect(definition.activationRules.requiredAssets ?? [], definition.id).toEqual([]);
        }
    });

    test('a scene builds with masks available', () => {
        const result = buildScene(
            'with-masks',
            ORGANIC_FLOW_THEME,
            { ...base, assets: availableAssetIds([MASK_ASSET]) },
            profileFor(0),
        );

        expect(result.ok, result.ok ? '' : result.failure.detail).toBe(true);
    });

    test('a scene builds with artwork available', () => {
        const result = buildScene(
            'with-art',
            ORGANIC_FLOW_THEME,
            { ...base, assets: availableAssetIds([ART_ASSET]) },
            profileFor(0),
        );

        expect(result.ok, result.ok ? '' : result.failure.detail).toBe(true);
    });

    test('artwork being present does not force it on screen', () => {
        // Section 26: the existence of album art must not require it to appear directly.
        const withoutDirectArt: string[] = [];

        for (const seed of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']) {
            const result = buildScene(
                seed,
                ORGANIC_FLOW_THEME,
                { ...base, assets: availableAssetIds([ART_ASSET]) },
                profileFor(0),
            );
            if (result.ok && !result.scene.plugins.some((entry) => entry.id === 'AlbumArtSource')) {
                withoutDirectArt.push(seed);
            }
        }

        expect(withoutDirectArt.length).toBeGreaterThan(0);
    });

    test('assets being present is deterministic too', () => {
        const assets = availableAssetIds([MASK_ASSET, ART_ASSET]);
        const first = buildScene('both', ORGANIC_FLOW_THEME, { ...base, assets }, profileFor(0));
        const second = buildScene('both', ORGANIC_FLOW_THEME, { ...base, assets }, profileFor(0));
        if (!first.ok || !second.ok) throw new Error('expected both builds to succeed');

        expect(first.scene.plugins.map((entry) => entry.id))
            .toEqual(second.scene.plugins.map((entry) => entry.id));
    });
});

function find(id: string): VisualPluginDefinition {
    const definition = allDefinitions().find((entry) => entry.id === id);
    if (!definition) {
        throw new Error(`plugin ${id} is not registered`);
    }

    return definition;
}
