/**
 * Asset loading and texture upload.
 *
 * Masks come from the frontend bundle (same origin, ADR-0005); album art comes from the media CDN,
 * which sets CORS and is loaded with `crossOrigin` so the texture is not tainted.
 *
 * A failed asset is dropped rather than propagated: a missing mask makes mask plugins ineligible, which
 * is exactly the behaviour that keeps assets optional.
 */

import {
    MASK_MANIFEST_PATH,
    maskAssetFrom,
    parseMaskManifest,
    type MaskAsset,
} from '../core/assets';

export interface LoadedTexture {
    assetId: string;
    image: HTMLImageElement;
}

/** Loads the mask manifest. Returns an empty list when it is absent or unreadable. */
export async function loadMaskAssets(path = MASK_MANIFEST_PATH): Promise<MaskAsset[]> {
    try {
        const response = await fetch(path, { cache: 'force-cache' });
        if (!response.ok) {
            return [];
        }

        const manifest = parseMaskManifest(await response.json());
        return manifest.masks.map((entry) => maskAssetFrom(entry));
    } catch {
        // No manifest shipped, or it is malformed. Mask plugins simply stay inactive.
        return [];
    }
}

/**
 * Loads an image for texture upload.
 *
 * `crossOrigin` is set for cross-origin sources so the resulting texture is usable; without it the
 * canvas would be tainted and every derivation reading it would fail silently.
 */
export function loadImage(src: string, sameOrigin: boolean): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();

        if (!sameOrigin) {
            image.crossOrigin = 'anonymous';
        }

        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`could not load ${src}`));
        image.src = src;
    });
}

export function isSameOrigin(src: string): boolean {
    if (src.startsWith('/') || src.startsWith('./')) {
        return true;
    }

    try {
        return new URL(src, window.location.href).origin === window.location.origin;
    } catch {
        return false;
    }
}

/** Loads several assets, keeping whichever succeed. */
export async function loadTextures(
    sources: readonly { assetId: string; src: string }[],
): Promise<LoadedTexture[]> {
    const results = await Promise.allSettled(
        sources.map(async (source) => ({
            assetId: source.assetId,
            image: await loadImage(source.src, isSameOrigin(source.src)),
        })),
    );

    return results
        .filter((result): result is PromiseFulfilledResult<LoadedTexture> => result.status === 'fulfilled')
        .map((result) => result.value);
}
