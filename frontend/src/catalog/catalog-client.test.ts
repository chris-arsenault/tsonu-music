import { afterEach, describe, expect, test, vi } from 'vitest';
import {
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
            manifestPath: 'albums/so-we-sleep.json',
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
        expect(resolveMediaUrl('https://media.tsonu.com', 'catalog.json'))
            .toBe('https://media.tsonu.com/catalog.json');
        expect(resolveMediaUrl('https://media.tsonu.com/base/', '/albums/a.json'))
            .toBe('https://media.tsonu.com/base/albums/a.json');
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

    test('fetches catalog and album manifests with basic shape validation', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url.endsWith('/catalog.json')) {
                return jsonResponse(catalogResponse);
            }

            if (url.endsWith('/albums/so-we-sleep.json')) {
                return jsonResponse(albumResponse);
            }

            return jsonResponse({ error: 'not found' }, 404);
        });
        vi.stubGlobal('fetch', fetchMock);

        const catalog = await fetchPublishedCatalog('https://media.tsonu.com', new AbortController().signal);
        const album = await fetchAlbumManifest(
            'https://media.tsonu.com',
            catalog.albums[0] as CatalogAlbumSummary,
            new AbortController().signal,
        );

        expect(catalog.albums[0].manifestPath).toBe('albums/so-we-sleep.json');
        expect(album.entityType).toBe('album');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://media.tsonu.com/catalog.json',
            expect.objectContaining({
                headers: {
                    Accept: 'application/json',
                },
            }),
        );
    });

    test('rejects malformed published manifests before rendering them', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ entityType: 'draftAlbum' })));

        await expect(fetchPublishedCatalog('https://media.tsonu.com', new AbortController().signal))
            .rejects
            .toThrow('published catalog');
    });
});
