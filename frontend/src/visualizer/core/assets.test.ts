import { describe, expect, test } from 'vitest';
import {
    albumArtAssetFrom,
    albumArtIn,
    availableAssetIds,
    maskAssetFrom,
    masksIn,
    parseMaskManifest,
    type MaskManifestEntry,
    type VisualAsset,
} from './assets';

const entry: MaskManifestEntry = {
    id: 'inkblot',
    file: 'inkblot.png',
    interpretation: 'luminance',
};

describe('mask assets', () => {
    test('resolves a manifest entry to a same-origin asset', () => {
        const asset = maskAssetFrom(entry);

        expect(asset.kind).toBe('mask');
        expect(asset.id).toBe('mask:inkblot');
        expect(asset.src).toBe('/masks/inkblot.png');
        expect(asset.interpretation).toBe('luminance');
    });

    test('carries the optional spatial flags through', () => {
        const asset = maskAssetFrom({ ...entry, invert: true, mirror: true, tile: false });

        expect(asset.invert).toBe(true);
        expect(asset.mirror).toBe(true);
        expect(asset.tile).toBe(false);
    });

    test('honours a different base path', () => {
        expect(maskAssetFrom(entry, '/custom/').src).toBe('/custom/inkblot.png');
    });
});

describe('manifest parsing', () => {
    test('reads a well-formed manifest', () => {
        const manifest = parseMaskManifest({ version: 1, masks: [entry] });

        expect(manifest.version).toBe(1);
        expect(manifest.masks).toHaveLength(1);
    });

    test('drops malformed entries rather than failing the whole load', () => {
        const manifest = parseMaskManifest({
            version: 1,
            masks: [
                entry,
                { id: '', file: 'x.png', interpretation: 'luminance' },
                { id: 'no-file', interpretation: 'luminance' },
                { id: 'bad-interpretation', file: 'y.png', interpretation: 'rainbow' },
                null,
                'nonsense',
            ],
        });

        // One good mask is better than none because a sibling entry was wrong.
        expect(manifest.masks.map((mask) => mask.id)).toEqual(['inkblot']);
    });

    test('accepts every valid interpretation', () => {
        const manifest = parseMaskManifest({
            version: 1,
            masks: [
                { id: 'a', file: 'a.png', interpretation: 'alpha' },
                { id: 'b', file: 'b.png', interpretation: 'luminance' },
                { id: 'c', file: 'c.png', interpretation: 'threshold' },
            ],
        });

        expect(manifest.masks).toHaveLength(3);
    });

    test('a missing or malformed manifest yields an empty one', () => {
        expect(parseMaskManifest(null).masks).toEqual([]);
        expect(parseMaskManifest(undefined).masks).toEqual([]);
        expect(parseMaskManifest('nonsense').masks).toEqual([]);
        expect(parseMaskManifest({}).masks).toEqual([]);
        expect(parseMaskManifest({ masks: 'not-an-array' }).masks).toEqual([]);
    });

    test('a missing version defaults rather than throwing', () => {
        expect(parseMaskManifest({ masks: [entry] }).version).toBe(0);
    });
});

describe('asset availability', () => {
    const art = albumArtAssetFrom('https://media.tsonu.com/artwork.jpg');
    const mask = maskAssetFrom(entry);

    test('exposes both specific ids and kind-level ids', () => {
        const ids = availableAssetIds([art, mask]);

        expect(ids).toContain('album-art:current');
        expect(ids).toContain('mask:inkblot');
        // Kind-level, so a plugin can require "some mask" rather than one specific file.
        expect(ids).toContain('mask');
        expect(ids).toContain('album-art');
    });

    test('an empty asset set makes every asset-requiring plugin ineligible', () => {
        expect(availableAssetIds([])).toEqual([]);
    });

    test('a mask-only set does not advertise album art', () => {
        const ids = availableAssetIds([mask]);

        expect(ids).toContain('mask');
        expect(ids).not.toContain('album-art');
    });

    test('a kind is advertised once regardless of how many assets share it', () => {
        const second = maskAssetFrom({ ...entry, id: 'logo', file: 'logo.png' });
        const ids = availableAssetIds([mask, second]);

        expect(ids.filter((id) => id === 'mask')).toHaveLength(1);
    });

    test('finds masks and artwork within a mixed set', () => {
        const assets: VisualAsset[] = [art, mask];

        expect(masksIn(assets)).toHaveLength(1);
        expect(albumArtIn(assets)?.id).toBe('album-art:current');
        expect(albumArtIn([mask])).toBeUndefined();
        expect(masksIn([art])).toEqual([]);
    });
});
