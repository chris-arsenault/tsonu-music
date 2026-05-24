import { afterEach, describe, expect, test, vi } from 'vitest';
import {
    fetchAlbumManifestBySlug,
    fetchAlbumManifest,
    fetchPublishedCatalog,
    getArtworkUrl,
    resolveMediaUrl,
} from './catalog-client';
import type { CatalogAlbumSummary, CatalogArtwork } from './media-catalog';

const catalogResponse = {
    schemaVersion: 1,
    entityType: 'catalog',
    generatedAt: '2026-05-24T00:00:00Z',
    artist: {
        name: 'Tsonu',
        slug: 'tsonu',
    },
    albums: [
        {
            albumId: 'album_so-we-sleep',
            releaseId: 'release_so-we-sleep_2026',
            slug: 'so-we-sleep',
            title: 'So We Sleep',
            releaseType: 'album',
            releaseDate: '2026-01-01',
            status: 'published',
            visibility: 'public',
            manifestPath: '/catalog/albums/so-we-sleep',
            artwork: {
                assetId: 'asset_so-we-sleep_cover',
                altText: 'So We Sleep cover art',
                sources: [],
            },
            trackCount: 1,
            totalDurationSeconds: 180,
        },
    ],
};

const albumResponse = {
    schemaVersion: 1,
    entityType: 'album',
    albumId: 'album_so-we-sleep',
    releaseId: 'release_so-we-sleep_2026',
    slug: 'so-we-sleep',
    title: 'So We Sleep',
    artistName: 'Tsonu',
    releaseType: 'album',
    releaseDate: '2026-01-01',
    status: 'published',
    visibility: 'public',
    publishedAt: '2026-05-24T00:00:00Z',
    artwork: {
        assetId: 'asset_so-we-sleep_cover',
        altText: 'So We Sleep cover art',
        sources: [],
    },
    tracks: [],
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json',
        },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('catalog client', () => {
    test('resolves CDN-relative and absolute media URLs', () => {
        expect(resolveMediaUrl('https://media.tsonu.com', 'albums/a/tracks/b/job/hls/master.m3u8'))
            .toBe('https://media.tsonu.com/albums/a/tracks/b/job/hls/master.m3u8');
        expect(resolveMediaUrl('https://media.tsonu.com/base/', '/artwork/cover.jpg'))
            .toBe('https://media.tsonu.com/base/artwork/cover.jpg');
        expect(resolveMediaUrl('https://cdn.example.com', 'https://assets.example.com/track.m3u8'))
            .toBe('https://assets.example.com/track.m3u8');
    });

    test('chooses the largest artwork source and preserves absolute URLs', () => {
        const artwork: CatalogArtwork = {
            assetId: 'asset_so-we-sleep_cover',
            altText: 'cover',
            sources: [
                {
                    path: 'artwork/cover-512.jpg',
                    width: 512,
                    height: 512,
                    mimeType: 'image/jpeg',
                },
                {
                    path: 'ignored-local-path.jpg',
                    url: 'https://images.example.com/cover-1024.jpg',
                    width: 1024,
                    height: 1024,
                    mimeType: 'image/jpeg',
                },
            ],
        };

        expect(getArtworkUrl('https://media.tsonu.com', artwork))
            .toBe('https://images.example.com/cover-1024.jpg');
    });

    test('fetches catalog and album metadata with basic shape validation', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url.endsWith('/catalog')) {
                return jsonResponse(catalogResponse);
            }

            if (url.endsWith('/catalog/albums/so-we-sleep')) {
                return jsonResponse(albumResponse);
            }

            return jsonResponse({ error: 'not found' }, 404);
        });
        vi.stubGlobal('fetch', fetchMock);

        const catalog = await fetchPublishedCatalog('https://api.music.tsonu.com', new AbortController().signal);
        const album = await fetchAlbumManifest(
            'https://api.music.tsonu.com',
            catalog.albums[0] as CatalogAlbumSummary,
            new AbortController().signal,
        );

        expect(catalog.albums[0].manifestPath).toBe('/catalog/albums/so-we-sleep');
        expect(album.entityType).toBe('album');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.music.tsonu.com/catalog',
            expect.objectContaining({
                headers: {
                    Accept: 'application/json',
                },
            }),
        );
    });

    test('fetches an album directly by slug', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            expect(url).toBe('https://api.music.tsonu.com/catalog/albums/so-we-sleep');
            return jsonResponse(albumResponse);
        });
        vi.stubGlobal('fetch', fetchMock);

        const album = await fetchAlbumManifestBySlug(
            'https://api.music.tsonu.com',
            'so-we-sleep',
            new AbortController().signal,
        );

        expect(album.slug).toBe('so-we-sleep');
    });

    test('rejects malformed published metadata before rendering it', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ entityType: 'draftAlbum' })));

        await expect(fetchPublishedCatalog('https://api.music.tsonu.com', new AbortController().signal))
            .rejects
            .toThrow('published catalog');
    });
});
