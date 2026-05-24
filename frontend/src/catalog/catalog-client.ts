import type {
    CatalogArtwork,
    CatalogReleaseSummary,
    PublishedCatalog,
    PublishedReleaseManifest,
    PublishedSongManifest,
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
    if (!isRecord(value) || value.entityType !== 'catalog' || !Array.isArray(value.releases)) {
        throw new Error('Catalog response is not a published catalog.');
    }
}

function assertReleaseManifest(value: unknown): asserts value is PublishedReleaseManifest {
    if (!isRecord(value) || value.entityType !== 'release' || !Array.isArray(value.tracks)) {
        throw new Error('Release response is not a published release.');
    }
}

function assertSongManifest(value: unknown): asserts value is PublishedSongManifest {
    if (!isRecord(value) || value.entityType !== 'song' || !Array.isArray(value.placements)) {
        throw new Error('Song response is not a published song.');
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

export async function fetchReleaseManifest(
    apiBaseUrl: string,
    release: CatalogReleaseSummary,
    signal: AbortSignal,
): Promise<PublishedReleaseManifest> {
    return fetchReleaseManifestPath(apiBaseUrl, release.manifestPath, signal);
}

export async function fetchReleaseManifestBySlug(
    apiBaseUrl: string,
    releaseSlug: string,
    signal: AbortSignal,
): Promise<PublishedReleaseManifest> {
    return fetchReleaseManifestPath(
        apiBaseUrl,
        `/catalog/releases/${encodeURIComponent(releaseSlug)}`,
        signal,
    );
}

export async function fetchSongManifestBySlug(
    apiBaseUrl: string,
    songSlug: string,
    signal: AbortSignal,
): Promise<PublishedSongManifest> {
    const manifest = await fetchJson<PublishedSongManifest>(
        resolveApiUrl(apiBaseUrl, `/catalog/songs/${encodeURIComponent(songSlug)}`),
        signal,
    );
    assertSongManifest(manifest);
    return manifest;
}

async function fetchReleaseManifestPath(
    apiBaseUrl: string,
    manifestPath: string,
    signal: AbortSignal,
): Promise<PublishedReleaseManifest> {
    const manifest = await fetchJson<PublishedReleaseManifest>(
        resolveApiUrl(apiBaseUrl, manifestPath),
        signal,
    );
    assertReleaseManifest(manifest);
    return manifest;
}
