/**
 * The shipped mask library.
 *
 * Asserts that what is in `public/masks/` actually parses through the loader and activates the
 * mask-driven plugins. Without this, a typo in the manifest would ship as masks silently never loading,
 * which looks identical to having no masks at all.
 */

import { describe, expect, test } from 'vitest';
import manifestJson from '../../public/masks/manifest.json';
import {
    availableAssetIds,
    maskAssetFrom,
    parseMaskManifest,
} from './core/assets';
import { assetResourceId, wireScene, type AssetResource } from './core/wiring';
import { compileGraph } from './core/graph';
import { eligiblePlugins, ineligibleReason } from './core/scheduler';
import { allDefinitions } from './plugins/registry';
import { ORGANIC_FLOW_THEME } from './plugins/themes';

const manifest = parseMaskManifest(manifestJson);
const CATALOG = allDefinitions();

describe('shipped mask manifest', () => {
    test('parses without dropping any entry', () => {
        // parseMaskManifest silently drops malformed entries, so a mismatch means one is wrong.
        expect(manifest.masks).toHaveLength(manifestJson.masks.length);
    });

    test('is not empty', () => {
        expect(manifest.masks.length).toBeGreaterThan(0);
    });

    test('every id is unique', () => {
        const ids = manifest.masks.map((mask) => mask.id);

        expect(new Set(ids).size).toBe(ids.length);
    });

    test('every entry resolves to a same-origin asset under /masks/', () => {
        for (const entry of manifest.masks) {
            const asset = maskAssetFrom(entry);

            expect(asset.id, entry.id).toBe(`mask:${entry.id}`);
            expect(asset.src, entry.id).toBe(`/masks/${entry.file}`);
            expect(asset.src.endsWith('.png'), entry.id).toBe(true);
        }
    });

    test('every file name matches its id, so a mask is findable from either', () => {
        for (const entry of manifest.masks) {
            expect(entry.file, entry.id).toBe(`${entry.id}.png`);
        }
    });

    test('interpretation is luminance throughout, matching the processed output', () => {
        // process_mask writes single-channel grayscale with the shape bright, so luminance is correct
        // and `alpha` would read an opaque channel.
        for (const entry of manifest.masks) {
            expect(entry.interpretation, entry.id).toBe('luminance');
        }
    });

    test('symmetric masks are marked mirrorable and repeating masks tileable', () => {
        const mirrored = manifest.masks.filter((mask) => mask.mirror);
        const tiled = manifest.masks.filter((mask) => mask.tile);

        expect(mirrored.length).toBeGreaterThan(0);
        expect(tiled.length).toBeGreaterThan(0);

        // A tag set is what lets a theme prefer organic over geometric material.
        for (const entry of manifest.masks) {
            expect((entry.tags ?? []).length, entry.id).toBeGreaterThan(0);
        }
    });

    test('the band-identity masks are present', () => {
        // These decompose the Tsonu emblem; losing one would quietly change the library's character.
        const ids = manifest.masks.map((mask) => mask.id);

        for (const id of ['tree-of-life-full', 'knight-helm', 'rune-ring', 'keyboard-octaves']) {
            expect(ids, id).toContain(id);
        }
    });
});

describe('the library activates mask-driven plugins', () => {
    const assets = manifest.masks.map((entry) => maskAssetFrom(entry));
    const assetIds = availableAssetIds(assets);

    const context = {
        available: CATALOG,
        theme: ORGANIC_FLOW_THEME,
        assets: assetIds,
        capabilities: ['float-textures', 'webgl2'],
        history: {},
        playbackTime: 100,
        allowHighCost: true,
        allowDominant: true,
    };

    test('advertises a kind-level mask id, so a plugin can require "some mask"', () => {
        expect(assetIds).toContain('mask');
        expect(assetIds).toContain('mask:tree-of-life-full');
    });

    test('every mask-requiring plugin becomes eligible', () => {
        const maskPlugins = CATALOG.filter((definition) =>
            (definition.activationRules.requiredAssets ?? []).includes('mask'));

        expect(maskPlugins.length).toBeGreaterThan(0);
        for (const definition of maskPlugins) {
            expect(ineligibleReason(definition, context), definition.id).toBeUndefined();
        }
    });

    test('those plugins are ineligible when the library is empty', () => {
        // The contrast is the point: masks are optional, and an empty library is a valid state.
        const maskPlugins = CATALOG.filter((definition) =>
            (definition.activationRules.requiredAssets ?? []).includes('mask'));

        for (const definition of maskPlugins) {
            expect(ineligibleReason(definition, { ...context, assets: [] }), definition.id)
                .toMatch(/missing asset/);
        }
    });

    test('a mask-driven scene wires and compiles against a shipped mask', () => {
        const resources: AssetResource[] = [
            { resource: assetResourceId(assets[0].id), type: 'mask-texture' },
        ];
        const wired = wireScene(
            [
                'ProceduralTextureSource:cellular',
                'MaskSignedDistanceField',
                'MaskContainmentField',
                'MaskEffectStencil',
                'ToneMapper',
            ].map((id) => CATALOG.find((entry) => entry.id === id)!),
            resources,
        );

        expect(wired.unsatisfied).toEqual([]);
        expect(wired.assetBindings.length).toBeGreaterThan(0);

        const compiled = compileGraph(wired.nodes, wired.edges, wired.present, wired.assetBindings);
        expect(compiled.ok, compiled.ok ? '' : compiled.errors.join('; ')).toBe(true);
    });

    test('signal plugins stay eligible regardless of the library', () => {
        const eligible = eligiblePlugins(context).map((definition) => definition.id);

        expect(eligible).toContain('ToneMapper');
        expect(eligible).toContain('SignalTraceSource:circular');
    });
});
