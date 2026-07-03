import { describe, expect, test } from 'vitest';
import { formatAiAssistedPercent } from './AiAssistedBadge';
import { releaseTrackNoteItems, songNoteItems } from './TrackNotes';

describe('track notes', () => {
    test('builds song overview and narrative notes from song data', () => {
        expect(songNoteItems({
            schemaVersion: 1,
            entityType: 'song',
            songId: 'song_opening_dream',
            slug: 'opening-dream',
            title: 'Opening Dream',
            artistName: 'Tsonu',
            description: 'A short overview.',
            narrative: 'A dream-world narrative.',
            placements: [],
        })).toEqual([
            { key: 'description', label: 'Overview', text: 'A short overview.' },
            { key: 'narrative', label: 'Narrative', text: 'A dream-world narrative.' },
        ]);
    });

    test('builds track notes from song and recording context', () => {
        expect(releaseTrackNoteItems({
            trackId: 'track_so_we_sleep_01',
            songId: 'song_opening_dream',
            recordingId: 'recording_opening_dream_album',
            discNumber: 1,
            trackNumber: 1,
            slug: 'opening-dream',
            title: 'Opening Dream',
            songTitle: 'Opening Dream',
            recordingTitle: 'Opening Dream Album Master',
            durationSeconds: 181,
            explicit: false,
            songDescription: 'A short overview.',
            songNarrative: 'A dream-world narrative.',
            productionNote: 'Piano sketch, orchestration pass, hand edit.',
            playback: {
                hls: {
                    assetId: 'file_opening_dream_hls',
                    path: 'recordings/opening/master.m3u8',
                    mimeType: 'application/vnd.apple.mpegurl',
                },
                formats: [],
            },
        })).toEqual([
            { key: 'description', label: 'Overview', text: 'A short overview.' },
            { key: 'narrative', label: 'Narrative', text: 'A dream-world narrative.' },
            { key: 'production', label: 'Production', text: 'Piano sketch, orchestration pass, hand edit.' },
        ]);
    });
});

describe('AI-assisted percent label', () => {
    test('formats only valid integer estimates', () => {
        expect(formatAiAssistedPercent(35)).toBe('35% est.');
        expect(formatAiAssistedPercent(undefined)).toBeUndefined();
        expect(formatAiAssistedPercent(101)).toBeUndefined();
        expect(formatAiAssistedPercent(12.5)).toBeUndefined();
    });
});
