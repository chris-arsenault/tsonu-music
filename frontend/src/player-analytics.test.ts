import { afterEach, describe, expect, test, vi } from 'vitest';

type SessionStorageStub = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
};

function createSessionStorage(): SessionStorageStub {
    const values = new Map<string, string>();

    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
            values.set(key, value);
        },
    };
}

async function loadAnalyticsWithRum() {
    vi.resetModules();

    const recordEvent = vi.fn();
    const addSessionAttributes = vi.fn();
    const AwsRum = vi.fn(function AwsRumMock() {
        return {
            addSessionAttributes,
            recordEvent,
        };
    });

    vi.doMock('aws-rum-web', () => ({
        AwsRum,
    }));

    vi.stubGlobal('crypto', {
        randomUUID: () => 'session-test-1',
    });
    vi.stubGlobal('window', {
        __APP_CONFIG__: {
            app: {
                mediaBaseUrl: 'https://media.tsonu.com',
                rum: {
                    enabled: true,
                    applicationId: 'rum-app-id',
                    applicationRegion: 'us-east-1',
                    applicationVersion: 'test-version',
                    endpoint: 'https://dataplane.rum.us-east-1.amazonaws.com',
                    identityPoolId: 'us-east-1:identity-pool',
                    guestRoleArn: 'arn:aws:iam::123456789012:role/rum',
                    sessionSampleRate: 2,
                    allowCookies: false,
                    telemetries: ['errors', 'performance', 'http'],
                    playbackEventVersion: 7,
                },
            },
        },
        location: {
            pathname: '/listen',
            search: '?album=so-we-sleep',
            hash: '#music',
        },
        sessionStorage: createSessionStorage(),
    });

    const analytics = await import('./player-analytics');
    return {
        analytics,
        AwsRum,
        addSessionAttributes,
        recordEvent,
    };
}

afterEach(() => {
    vi.doUnmock('aws-rum-web');
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe('player analytics', () => {
    test('records custom playback events with normalized RUM payloads', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-24T00:00:00Z'));
        const { analytics, AwsRum, addSessionAttributes, recordEvent } = await loadAnalyticsWithRum();

        analytics.recordPlayStart({
            albumId: 'album_so-we-sleep',
            releaseId: 'release_so-we-sleep_2026',
            trackId: 'track_so-we-sleep_01',
            assetId: 'asset_so-we-sleep_01_hls',
            quality: 'aac-320',
            positionSeconds: 12.34567,
            durationSeconds: 180,
        });

        await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(1));

        expect(AwsRum).toHaveBeenCalledWith(
            'rum-app-id',
            'test-version',
            'us-east-1',
            expect.objectContaining({
                allowCookies: false,
                endpoint: 'https://dataplane.rum.us-east-1.amazonaws.com',
                guestRoleArn: 'arn:aws:iam::123456789012:role/rum',
                identityPoolId: 'us-east-1:identity-pool',
                sessionSampleRate: 1,
            }),
        );
        expect(addSessionAttributes).toHaveBeenCalledWith({
            playbackSessionId: 'session-test-1',
        });
        expect(recordEvent).toHaveBeenCalledWith(
            'play_start',
            expect.objectContaining({
                eventVersion: 7,
                albumId: 'album_so-we-sleep',
                releaseId: 'release_so-we-sleep_2026',
                trackId: 'track_so-we-sleep_01',
                assetId: 'asset_so-we-sleep_01_hls',
                selectedQuality: 'aac-320',
                positionSeconds: 12.346,
                sessionPositionSeconds: 12.346,
                durationSeconds: 180,
                playbackSessionId: 'session-test-1',
                pagePath: '/listen?album=so-we-sleep#music',
                occurredAt: '2026-05-24T00:00:00.000Z',
            }),
        );
    });

    test('deduplicates album and track impressions per page session', async () => {
        const { analytics, recordEvent } = await loadAnalyticsWithRum();
        const albumContext = {
            albumId: 'album_so-we-sleep' as const,
            releaseId: 'release_so-we-sleep_2026' as const,
            assetId: 'asset_so-we-sleep_cover' as const,
        };
        const trackContext = {
            ...albumContext,
            trackId: 'track_so-we-sleep_01' as const,
            assetId: 'asset_so-we-sleep_01_hls' as const,
            durationSeconds: 180,
        };

        analytics.recordAlbumView(albumContext);
        analytics.recordAlbumView(albumContext);
        analytics.recordTrackImpression(trackContext);
        analytics.recordTrackImpression(trackContext);

        await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(2));
        expect(recordEvent.mock.calls.map(([eventName]) => eventName)).toEqual([
            'album_view',
            'track_impression',
        ]);
    });

    test('does not load the RUM client when runtime config disables it', async () => {
        vi.resetModules();
        const AwsRum = vi.fn();
        vi.doMock('aws-rum-web', () => ({
            AwsRum,
        }));
        vi.stubGlobal('window', {
            __APP_CONFIG__: {
                app: {
                    mediaBaseUrl: 'https://media.tsonu.com',
                    rum: {
                        enabled: false,
                    },
                },
            },
            location: {
                pathname: '/',
                search: '',
                hash: '',
            },
            sessionStorage: createSessionStorage(),
        });

        const analytics = await import('./player-analytics');
        analytics.recordPlayPause({
            albumId: 'album_so-we-sleep',
            releaseId: 'release_so-we-sleep_2026',
            trackId: 'track_so-we-sleep_01',
        });

        await Promise.resolve();
        expect(AwsRum).not.toHaveBeenCalled();
    });
});
