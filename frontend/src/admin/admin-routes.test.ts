import { describe, expect, test } from 'vitest';
import { buildAdminPath, parseAdminRoute } from './admin-routes';

describe('parseAdminRoute', () => {
    test('defaults to releases when path is bare /admin', () => {
        expect(parseAdminRoute('/admin')).toEqual({
            section: 'releases',
            selectedId: undefined,
            subview: undefined,
        });
    });

    test('extracts a selected release id', () => {
        expect(parseAdminRoute('/admin/releases/release_echoes_2026')).toEqual({
            section: 'releases',
            selectedId: 'release_echoes_2026',
            subview: undefined,
        });
    });

    test('decodes percent-encoded ids', () => {
        const id = 'release_with spaces';
        expect(parseAdminRoute(`/admin/releases/${encodeURIComponent(id)}`)).toEqual({
            section: 'releases',
            selectedId: id,
            subview: undefined,
        });
    });

    test('captures a subview after the id', () => {
        expect(parseAdminRoute('/admin/songs/song_halcyon/recordings')).toEqual({
            section: 'songs',
            selectedId: 'song_halcyon',
            subview: 'recordings',
        });
    });

    test('routes legacy /admin/encoding to activity', () => {
        expect(parseAdminRoute('/admin/encoding')).toEqual({
            section: 'activity',
            selectedId: undefined,
            subview: undefined,
        });
    });

    test('routes legacy /admin/stats to activity with stats subview', () => {
        expect(parseAdminRoute('/admin/stats')).toEqual({
            section: 'activity',
            selectedId: undefined,
            subview: 'stats',
        });
    });

    test('preserves a trailing query string', () => {
        expect(parseAdminRoute('/admin/songs?groupBy=unreleased')).toEqual({
            section: 'songs',
            selectedId: undefined,
            subview: undefined,
        });
    });

    test('unknown sections fall back to releases', () => {
        expect(parseAdminRoute('/admin/garbage')).toEqual({
            section: 'releases',
            selectedId: undefined,
            subview: undefined,
        });
    });
});

describe('buildAdminPath', () => {
    test('encodes selectedId', () => {
        expect(buildAdminPath('releases', 'release_with spaces')).toBe('/admin/releases/release_with%20spaces');
    });

    test('omits selection when undefined', () => {
        expect(buildAdminPath('releases')).toBe('/admin/releases');
    });

    test('builds activity stats subview without an id', () => {
        expect(buildAdminPath('activity', undefined, 'stats')).toBe('/admin/activity/stats');
    });

    test('round-trips with parseAdminRoute', () => {
        const original = { section: 'songs' as const, selectedId: 'song_halcyon', subview: 'recordings' };
        const path = buildAdminPath(original.section, original.selectedId, original.subview);
        expect(parseAdminRoute(path)).toEqual(original);
    });
});
