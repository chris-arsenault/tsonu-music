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

function resolveApiUrl(apiBaseUrl: string, path: string): string {
    const baseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
    return new URL(path.replace(/^\/+/, ''), baseUrl).toString();
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
        throw new Error('Catalog response is not a published catalog.');
    }
}

function assertAlbumManifest(value: unknown): asserts value is PublishedAlbumManifest {
    if (!isRecord(value) || value.entityType !== 'album' || !Array.isArray(value.tracks)) {
        throw new Error('Album response is not a published album.');
    }
}

export async function fetchPublishedCatalog(
    apiBaseUrl: string,
    signal: AbortSignal,
): Promise<PublishedCatalog> {
    const catalog = await fetchJson<PublishedCatalog>(resolveApiUrl(apiBaseUrl, '/catalog'), signal);
    assertCatalog(catalog);
    return catalog;
}

export async function fetchAlbumManifest(
    apiBaseUrl: string,
    album: CatalogAlbumSummary,
    signal: AbortSignal,
): Promise<PublishedAlbumManifest> {
    return fetchAlbumManifestPath(apiBaseUrl, album.manifestPath, signal);
}

export async function fetchAlbumManifestBySlug(
    apiBaseUrl: string,
    albumSlug: string,
    signal: AbortSignal,
): Promise<PublishedAlbumManifest> {
    return fetchAlbumManifestPath(
        apiBaseUrl,
        `/catalog/albums/${encodeURIComponent(albumSlug)}`,
        signal,
    );
}

async function fetchAlbumManifestPath(
    apiBaseUrl: string,
    manifestPath: string,
    signal: AbortSignal,
): Promise<PublishedAlbumManifest> {
    const manifest = await fetchJson<PublishedAlbumManifest>(
        resolveApiUrl(apiBaseUrl, manifestPath),
        signal,
    );
    assertAlbumManifest(manifest);
    return manifest;
}
