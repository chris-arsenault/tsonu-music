import { describe, expect, test } from 'vitest';
import { stableId } from './admin-helpers';
import {
    publishReadinessFor,
    releasesContainingSong,
    songsGroupedByRelease,
    unreleasedSongs,
} from './catalog-selectors';
import type {
    DraftRecording,
    DraftRelease,
    DraftSong,
} from './admin-types';
import type { CatalogArtwork, StableId } from '../catalog/media-catalog';

const artwork: CatalogArtwork = {
    assetId: stableId('asset', 'cover'),
    altText: 'art',
    sources: [{ path: 'cover.jpg', width: 800, height: 800, mimeType: 'image/jpeg' }],
};

function release(overrides: Partial<DraftRelease> & { releaseId: StableId }): DraftRelease {
    return {
        schemaVersion: 1,
        entityType: 'draftRelease',
        slug: 'r',
        title: 'R',
        artistName: 'Tsonu',
        releaseKind: 'album',
        releaseStatus: 'official',
        publishState: 'draft',
        releaseDate: '2026-01-01',
        tracks: [],
        ...overrides,
    };
}

function song(overrides: Partial<DraftSong> & { songId: StableId }): DraftSong {
    return {
        schemaVersion: 1,
        entityType: 'draftSong',
        slug: 's',
        title: 'S',
        artistName: 'Tsonu',
        recordings: [],
        ...overrides,
    };
}

function recording(id: StableId, encodeJobIds: StableId[] = []): DraftRecording {
    return {
        recordingId: id,
        slug: id,
        title: id,
        versionType: 'studio_master',
        explicit: false,
        encodeJobIds,
    };
}

describe('releasesContainingSong', () => {
    test('returns every release whose tracks reference the song id', () => {
        const songId = stableId('song', 'halcyon');
        const releases: Record<string, DraftRelease> = {
            ['release_a']: release({
                releaseId: 'release_a' as StableId,
                tracks: [{ trackId: 'track_a1' as StableId, songId, recordingId: 'rec_x' as StableId, discNumber: 1, trackNumber: 1, slug: 'a', title: 'A' }],
            }),
            ['release_b']: release({
                releaseId: 'release_b' as StableId,
                tracks: [],
            }),
            ['release_c']: release({
                releaseId: 'release_c' as StableId,
                tracks: [{ trackId: 'track_c1' as StableId, songId, recordingId: 'rec_y' as StableId, discNumber: 1, trackNumber: 1, slug: 'c', title: 'C' }],
            }),
        };
        const result = releasesContainingSong(releases, songId).map((r) => r.releaseId).sort();
        expect(result).toEqual(['release_a', 'release_c']);
    });
});

describe('songsGroupedByRelease + unreleasedSongs', () => {
    const songIdA = stableId('song', 'a');
    const songIdB = stableId('song', 'b');
    const songIdC = stableId('song', 'c');
    const songs: Record<string, DraftSong> = {
        [songIdA]: song({ songId: songIdA, title: 'Alpha' }),
        [songIdB]: song({ songId: songIdB, title: 'Bravo' }),
        [songIdC]: song({ songId: songIdC, title: 'Charlie' }),
    };
    const releases: Record<string, DraftRelease> = {
        ['release_old']: release({
            releaseId: 'release_old' as StableId,
            title: 'Old',
            releaseDate: '2024-01-01',
            tracks: [
                { trackId: 't1' as StableId, songId: songIdA, recordingId: 'rec1' as StableId, discNumber: 1, trackNumber: 1, slug: 'a', title: 'A' },
            ],
        }),
        ['release_new']: release({
            releaseId: 'release_new' as StableId,
            title: 'New',
            releaseDate: '2026-01-01',
            tracks: [
                { trackId: 't2' as StableId, songId: songIdA, recordingId: 'rec1' as StableId, discNumber: 1, trackNumber: 1, slug: 'a', title: 'A' },
                { trackId: 't3' as StableId, songId: songIdB, recordingId: 'rec2' as StableId, discNumber: 1, trackNumber: 2, slug: 'b', title: 'B' },
            ],
        }),
    };

    test('newer releases come first, song C falls into Unreleased', () => {
        const groups = songsGroupedByRelease(songs, releases);
        expect(groups.map((g) => g.release?.releaseId ?? 'unreleased')).toEqual([
            'release_new', 'release_old', 'unreleased',
        ]);
        const unreleased = groups[groups.length - 1];
        expect(unreleased.release).toBeUndefined();
        expect(unreleased.songs.map((s) => s.songId)).toEqual([songIdC]);
    });

    test('songs already on a newer release do not duplicate into Unreleased', () => {
        const allPlaced = songsGroupedByRelease(songs, releases).flatMap((g) => g.songs.map((s) => s.songId));
        expect(allPlaced.filter((id) => id === songIdA)).toHaveLength(2); // appears on both releases
    });

    test('unreleasedSongs returns alphabetical list of songs not on any release', () => {
        const list = unreleasedSongs(songs, releases).map((s) => s.title);
        expect(list).toEqual(['Charlie']);
    });
});

describe('publishReadinessFor', () => {
    const songId = stableId('song', 'halcyon');
    const recordingId = stableId('recording', 'halcyon-master');
    const fileId = 'file_halcyon_master_20260523_hls' as StableId;

    function recordingWithFiles(id: StableId): DraftRecording {
        return {
            ...recording(id),
            durationSeconds: 181,
            files: [
                {
                    fileId,
                    kind: 'hls-master',
                    path: `recordings/${id}/files/20260523/hls/master.m3u8`,
                    mimeType: 'application/vnd.apple.mpegurl',
                },
                {
                    fileId: 'file_halcyon_master_20260523_aac_192' as StableId,
                    kind: 'hls-rendition',
                    quality: 'aac-192',
                    path: `recordings/${id}/files/20260523/hls/192k/index.m3u8`,
                    mimeType: 'application/vnd.apple.mpegurl',
                },
                {
                    fileId: 'file_halcyon_master_20260523_aac_320' as StableId,
                    kind: 'hls-rendition',
                    quality: 'aac-320',
                    path: `recordings/${id}/files/20260523/hls/320k/index.m3u8`,
                    mimeType: 'application/vnd.apple.mpegurl',
                },
            ],
        };
    }

    const readySongs: Record<string, DraftSong> = {
        [songId]: song({
            songId,
            title: 'Halcyon',
            recordings: [recordingWithFiles(recordingId)],
        }),
    };
    const notEncodedSongs: Record<string, DraftSong> = {
        [songId]: song({
            songId,
            title: 'Halcyon',
            recordings: [recording(recordingId)],
        }),
    };

    test('all checks pass when every track recording has files', () => {
        const ready = release({
            releaseId: 'release_ready' as StableId,
            artwork,
            tracks: [{ trackId: 't1' as StableId, songId, recordingId, discNumber: 1, trackNumber: 1, slug: 'h', title: 'Halcyon' }],
        });
        const result = publishReadinessFor(ready, readySongs);
        expect(result.canPublish).toBe(true);
        expect(result.checks.map((c) => `${c.label}:${c.ok}`)).toEqual([
            'Release date:true',
            'Artwork:true',
            'Tracks:true',
            'Recording files:true',
        ]);
        expect(result.fileIds).toContain(fileId);
    });

    test('blocks when artwork is missing', () => {
        const noArt = release({
            releaseId: 'release_noart' as StableId,
            tracks: [{ trackId: 't1' as StableId, songId, recordingId, discNumber: 1, trackNumber: 1, slug: 'h', title: 'Halcyon' }],
        });
        const result = publishReadinessFor(noArt, readySongs);
        expect(result.canPublish).toBe(false);
        expect(result.checks.find((c) => c.label === 'Artwork')?.ok).toBe(false);
    });

    test('blocks when a track recording has no files, regardless of job-status state', () => {
        const rel = release({
            releaseId: 'release_running' as StableId,
            artwork,
            tracks: [{ trackId: 't1' as StableId, songId, recordingId, discNumber: 1, trackNumber: 1, slug: 'h', title: 'Halcyon' }],
        });
        const result = publishReadinessFor(rel, notEncodedSongs);
        expect(result.canPublish).toBe(false);
        expect(result.checks.find((c) => c.label === 'Recording files')?.ok).toBe(false);
        expect(result.fileIds).toEqual([]);
    });

    test('blocks when there are zero tracks', () => {
        const empty = release({ releaseId: 'release_empty' as StableId, artwork });
        const result = publishReadinessFor(empty, readySongs);
        expect(result.canPublish).toBe(false);
        expect(result.checks.find((c) => c.label === 'Tracks')?.ok).toBe(false);
    });
});
