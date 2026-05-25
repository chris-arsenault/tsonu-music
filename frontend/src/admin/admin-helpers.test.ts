import { describe, expect, test } from 'vitest';
import {
    formatBytes,
    formatLinks,
    nextReleaseTrack,
    parseLinks,
    parseTags,
    sanitizeFilename,
    slugify,
    sortedReleaseTracks,
    stableId,
    titleFromId,
    uniqueStableId,
} from './admin-helpers';
import type { DraftRecording, DraftRelease, DraftSong } from './admin-types';

function makeRelease(overrides: Partial<DraftRelease> = {}): DraftRelease {
    return {
        schemaVersion: 1,
        entityType: 'draftRelease',
        releaseId: stableId('release', 'sample'),
        slug: 'sample',
        title: 'Sample',
        artistName: 'Tsonu',
        releaseKind: 'album',
        releaseStatus: 'official',
        publishState: 'draft',
        releaseDate: '2026-01-01',
        tracks: [],
        ...overrides,
    };
}

function makeSong(overrides: Partial<DraftSong> = {}): DraftSong {
    return {
        schemaVersion: 1,
        entityType: 'draftSong',
        songId: stableId('song', 'sample-song'),
        slug: 'sample-song',
        title: 'Sample Song',
        artistName: 'Tsonu',
        recordings: [],
        ...overrides,
    };
}

function makeRecording(overrides: Partial<DraftRecording> = {}): DraftRecording {
    return {
        recordingId: stableId('recording', 'sample-recording'),
        slug: 'sample-recording',
        title: 'Sample Recording',
        versionType: 'studio_master',
        explicit: false,
        encodeJobIds: [],
        ...overrides,
    };
}

describe('slugify', () => {
    test('lowercases and replaces punctuation', () => {
        expect(slugify("Strangers' Echoes")).toBe('strangers-echoes');
    });

    test('falls back to "untitled" for empty input', () => {
        expect(slugify('   !!! ')).toBe('untitled');
    });
});

describe('titleFromId', () => {
    test('strips prefix and title-cases parts', () => {
        expect(titleFromId('release_echoes_of_static', 'release')).toBe('Echoes Of Static');
    });
});

describe('uniqueStableId', () => {
    test('returns base when not taken', () => {
        expect(uniqueStableId('song', 'Foo Bar', new Set())).toBe('song_foo_bar');
    });

    test('appends suffix when colliding', () => {
        const ids = new Set(['song_foo_bar', 'song_foo_bar_2']);
        expect(uniqueStableId('song', 'Foo Bar', ids)).toBe('song_foo_bar_3');
    });
});

describe('parseTags / parseLinks', () => {
    test('parseTags splits, trims, and returns undefined for empty', () => {
        expect(parseTags(' alpha, beta , , gamma ')).toEqual(['alpha', 'beta', 'gamma']);
        expect(parseTags('  ')).toBeUndefined();
    });

    test('parseLinks reads "label | url" lines and round-trips formatLinks', () => {
        const text = 'Bandcamp | https://bandcamp.example\nSpotify | https://spotify.example';
        const parsed = parseLinks(text);
        expect(parsed).toEqual([
            { label: 'Bandcamp', url: 'https://bandcamp.example' },
            { label: 'Spotify', url: 'https://spotify.example' },
        ]);
        expect(formatLinks(parsed)).toBe(text);
    });

    test('parseLinks tolerates pipe characters inside the URL', () => {
        const parsed = parseLinks('Wiki | https://example.com/path|fragment');
        expect(parsed).toEqual([{ label: 'Wiki', url: 'https://example.com/path|fragment' }]);
    });
});

describe('sanitizeFilename', () => {
    test('replaces spaces and disallowed characters with underscores', () => {
        expect(sanitizeFilename('My Demo (Final).wav')).toBe('My_Demo_Final.wav');
    });

    test('collapses runs of replacement chars', () => {
        expect(sanitizeFilename('a    b   c.wav')).toBe('a_b_c.wav');
    });

    test('strips leading and trailing underscores', () => {
        expect(sanitizeFilename(' .wav ')).toBe('.wav');
        expect(sanitizeFilename(' track ')).toBe('track');
    });

    test('strips directory components', () => {
        expect(sanitizeFilename('C:\\Users\\Me\\My Track.wav')).toBe('My_Track.wav');
        expect(sanitizeFilename('/tmp/uploads/foo bar.flac')).toBe('foo_bar.flac');
    });

    test('preserves dashes, dots, and existing underscores', () => {
        expect(sanitizeFilename('halcyon-v2_remaster.flac')).toBe('halcyon-v2_remaster.flac');
    });

    test('falls back to "file" when nothing survives', () => {
        expect(sanitizeFilename('   ')).toBe('file');
        expect(sanitizeFilename('___')).toBe('file');
        expect(sanitizeFilename('!!!')).toBe('file');
    });

    test('keeps unicode-stripped filenames usable', () => {
        // smart quotes and ellipsis collapse to underscores, then the underscore
        // immediately before the extension dot is dropped for tidiness.
        expect(sanitizeFilename('it’s a “test”….wav')).toBe('it_s_a_test.wav');
    });
});

describe('formatBytes', () => {
    test('shows whole bytes and KB/MB/GB', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(900)).toBe('900 B');
        expect(formatBytes(2048)).toBe('2.0 KB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    });
});

describe('nextReleaseTrack + sortedReleaseTracks', () => {
    test('numbers added tracks consecutively', () => {
        let release = makeRelease();
        const song = makeSong();
        const recordingA = makeRecording({ recordingId: stableId('recording', 'a'), title: 'A' });
        const recordingB = makeRecording({ recordingId: stableId('recording', 'b'), title: 'B' });

        const firstTrack = nextReleaseTrack(release, song, recordingA);
        release = { ...release, tracks: [...release.tracks, firstTrack] };
        const secondTrack = nextReleaseTrack(release, song, recordingB);
        release = { ...release, tracks: [...release.tracks, secondTrack] };

        const sorted = sortedReleaseTracks(release);
        expect(sorted.map((track) => track.trackNumber)).toEqual([1, 2]);
        expect(sorted[0].recordingId).toBe(recordingA.recordingId);
        expect(sorted[1].recordingId).toBe(recordingB.recordingId);
    });

    test('sortedReleaseTracks orders by disc then track', () => {
        const release = makeRelease({
            tracks: [
                { trackId: stableId('track', 'c'), songId: stableId('song', 's'), recordingId: stableId('recording', 'r'), discNumber: 2, trackNumber: 1, slug: 'c', title: 'c' },
                { trackId: stableId('track', 'a'), songId: stableId('song', 's'), recordingId: stableId('recording', 'r'), discNumber: 1, trackNumber: 2, slug: 'a', title: 'a' },
                { trackId: stableId('track', 'b'), songId: stableId('song', 's'), recordingId: stableId('recording', 'r'), discNumber: 1, trackNumber: 1, slug: 'b', title: 'b' },
            ],
        });
        const sorted = sortedReleaseTracks(release).map((track) => track.title);
        expect(sorted).toEqual(['b', 'a', 'c']);
    });
});
