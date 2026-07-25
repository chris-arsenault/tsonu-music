/**
 * Visual asset model (spec section 12).
 *
 * Album art and masks are synthesis material, not a style. Art can drive palette, edges, displacement,
 * particles, or nothing at all; a mask can drive containment, collision, stencilling, or distortion
 * without implying any particle system. Neither is required for a scene to work.
 */

export interface AlbumArtAsset {
    id: string;
    kind: 'album-art';
    src: string;

    focalPoint?: [number, number];
    preserveAspect?: boolean;

    paletteWeight?: number;
    recognizability?: number;
}

export type MaskInterpretation = 'alpha' | 'luminance' | 'threshold';

export interface MaskAsset {
    id: string;
    kind: 'mask';
    src: string;

    interpretation: MaskInterpretation;
    invert?: boolean;
    mirror?: boolean;
    tile?: boolean;
}

export interface DepthImageAsset {
    id: string;
    kind: 'depth-image';
    imageSrc: string;
    depthSrc: string;
}

export interface ParallaxModelAsset {
    id: string;
    kind: 'parallax-model';
    src: string;
    defaultCameraRig?: 'drift' | 'orbit' | 'push-pull';
}

export type VisualAsset =
    | AlbumArtAsset
    | MaskAsset
    | DepthImageAsset
    | ParallaxModelAsset;

/** Manifest shape for `public/masks/manifest.json`. */
export interface MaskManifest {
    version: number;
    masks: MaskManifestEntry[];
}

export interface MaskManifestEntry {
    id: string;
    file: string;
    interpretation: MaskInterpretation;
    invert?: boolean;
    mirror?: boolean;
    tile?: boolean;
    /** Free-form tags a theme may prefer, such as `organic` or `geometric`. */
    tags?: string[];
}

export const MASK_MANIFEST_PATH = '/masks/manifest.json';

/**
 * Turns a manifest entry into an asset, resolving its file against the mask directory.
 *
 * Masks are same-origin (ADR-0005), so unlike album art they raise no cross-origin tainting question
 * when uploaded as a texture.
 */
export function maskAssetFrom(entry: MaskManifestEntry, basePath = '/masks/'): MaskAsset {
    return {
        id: `mask:${entry.id}`,
        kind: 'mask',
        src: `${basePath}${entry.file}`,
        interpretation: entry.interpretation,
        invert: entry.invert,
        mirror: entry.mirror,
        tile: entry.tile,
    };
}

export function albumArtAssetFrom(src: string, id = 'album-art:current'): AlbumArtAsset {
    return { id, kind: 'album-art', src, preserveAspect: true, paletteWeight: 1 };
}

/** Validates a fetched manifest. A malformed entry is dropped rather than failing the whole load. */
export function parseMaskManifest(raw: unknown): MaskManifest {
    if (typeof raw !== 'object' || raw === null) {
        return { version: 0, masks: [] };
    }

    const candidate = raw as Partial<MaskManifest>;
    const masks = Array.isArray(candidate.masks) ? candidate.masks : [];

    return {
        version: typeof candidate.version === 'number' ? candidate.version : 0,
        masks: masks.filter(isMaskEntry),
    };
}

function isMaskEntry(value: unknown): value is MaskManifestEntry {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const entry = value as Partial<MaskManifestEntry>;
    const interpretations: MaskInterpretation[] = ['alpha', 'luminance', 'threshold'];

    return typeof entry.id === 'string'
        && entry.id.length > 0
        && typeof entry.file === 'string'
        && entry.file.length > 0
        && typeof entry.interpretation === 'string'
        && interpretations.includes(entry.interpretation as MaskInterpretation);
}

/**
 * Asset ids available to the scheduler, for plugins declaring `requiredAssets`.
 *
 * A plugin needing a mask stays inactive when none is loaded, which is what keeps masks optional
 * rather than making them a permanent visual style.
 */
export function availableAssetIds(assets: readonly VisualAsset[]): string[] {
    const ids = assets.map((asset) => asset.id);
    const kinds = new Set(assets.map((asset) => asset.kind));

    // Kind-level ids let a plugin require "some mask" rather than one specific mask.
    for (const kind of kinds) {
        ids.push(kind);
    }

    return ids;
}

export function masksIn(assets: readonly VisualAsset[]): MaskAsset[] {
    return assets.filter((asset): asset is MaskAsset => asset.kind === 'mask');
}

export function albumArtIn(assets: readonly VisualAsset[]): AlbumArtAsset | undefined {
    return assets.find((asset): asset is AlbumArtAsset => asset.kind === 'album-art');
}
