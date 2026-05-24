import type {
    CatalogAlbumSummary,
    CatalogArtwork,
    PublishedAlbumManifest,
    PublishedCatalog,
} from './media-catalog';

const ABSOLUTE_URL_PATTERN = /^https?:\/\//i;

export function resolveMediaUrl(mediaBaseUrl: string, pathOrUrl: string): string {
    if (ABSOLUTE_URL_PATTERN.test(pathOrUrl)) {
        return pathOrUrl;
    }

    const baseUrl = mediaBaseUrl.endsWith('/') ? mediaBaseUrl : `${mediaBaseUrl}/`;
    return new URL(pathOrUrl.replace(/^\/+/, ''), baseUrl).toString();
}

export function getArtworkUrl(mediaBaseUrl: string, artwork: CatalogArtwork): string | undefined {
    const source = [...artwork.sources].sort((left, right) => right.width - left.width)[0];
    if (!source) {
        return undefined;
    }

    return resolveMediaUrl(mediaBaseUrl, source.url ?? source.path);
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(url, {
        headers: {
            Accept: 'application/json',
        },
        signal,
    });

    if (!response.ok) {
        throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertCatalog(value: unknown): asserts value is PublishedCatalog {
    if (!isRecord(value) || value.entityType !== 'catalog' || !Array.isArray(value.albums)) {
        throw new Error('Catalog manifest is not a published catalog.');
    }
}

function assertAlbumManifest(value: unknown): asserts value is PublishedAlbumManifest {
    if (!isRecord(value) || value.entityType !== 'album' || !Array.isArray(value.tracks)) {
        throw new Error('Album manifest is not a published album.');
    }
}

export async function fetchPublishedCatalog(
    mediaBaseUrl: string,
    signal: AbortSignal,
): Promise<PublishedCatalog> {
    const catalog = await fetchJson<PublishedCatalog>(resolveMediaUrl(mediaBaseUrl, 'catalog.json'), signal);
    assertCatalog(catalog);
    return catalog;
}

export async function fetchAlbumManifest(
    mediaBaseUrl: string,
    album: CatalogAlbumSummary,
    signal: AbortSignal,
): Promise<PublishedAlbumManifest> {
    const manifest = await fetchJson<PublishedAlbumManifest>(
        resolveMediaUrl(mediaBaseUrl, album.manifestPath),
        signal,
    );
    assertAlbumManifest(manifest);
    return manifest;
}
