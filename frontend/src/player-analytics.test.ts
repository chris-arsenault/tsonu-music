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
    const recordPageView = vi.fn();
    const addSessionAttributes = vi.fn();
    const AwsRum = vi.fn(function AwsRumMock() {
        return {
            addSessionAttributes,
            recordPageView,
            recordEvent,
        };
    });

    vi.doMock('aws-rum-web', () => ({
        AwsRum,
    }));

    vi.stubGlobal('crypto', {
        randomUUID: () => 'session-test-1',
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    vi.stubGlobal('window', {
        __APP_CONFIG__: {
            app: {
                adminApiBaseUrl: 'https://api.music.tsonu.com',
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
        recordPageView,
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
            releaseId: 'release_so-we-sleep_2026',
            songId: 'song_so-we-sleep_01',
            recordingId: 'recording_so-we-sleep_01',
            trackId: 'track_so-we-sleep_01',
            assetId: 'asset_so-we-sleep_01_hls',
            quality: 'aac-320',
            positionSeconds: 12.34567,
            durationSeconds: 180,
        });

        await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(1));
        // Two fetches: the dataplane reachability probe (HEAD) and the
        // first-party play analytics POST.
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        expect(fetch).toHaveBeenCalledWith(
            'https://dataplane.rum.us-east-1.amazonaws.com/',
            expect.objectContaining({ method: 'HEAD', mode: 'cors' }),
        );

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
            siteSessionId: 'session-test-1',
            playbackSessionId: 'session-test-1',
        });
        expect(recordEvent).toHaveBeenCalledWith(
            'play_start',
            expect.objectContaining({
                eventVersion: 7,
                releaseId: 'release_so-we-sleep_2026',
                songId: 'song_so-we-sleep_01',
                recordingId: 'recording_so-we-sleep_01',
                trackId: 'track_so-we-sleep_01',
                assetId: 'asset_so-we-sleep_01_hls',
                selectedQuality: 'aac-320',
                positionSeconds: 12.346,
                sessionPositionSeconds: 12.346,
                durationSeconds: 180,
                siteSessionId: 'session-test-1',
                playbackSessionId: 'session-test-1',
                pagePath: '/listen?album=so-we-sleep#music',
                occurredAt: '2026-05-24T00:00:00.000Z',
            }),
        );
        expect(fetch).toHaveBeenCalledWith(
            'https://api.music.tsonu.com/analytics/play',
            expect.objectContaining({
                method: 'POST',
                keepalive: true,
                body: expect.stringContaining('"eventType":"play_start"'),
            }),
        );
    });

    test('records visit and page view events for SPA routes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-24T01:00:00Z'));
        const { analytics, recordEvent, recordPageView } = await loadAnalyticsWithRum();

        analytics.recordSitePageView('/music');
        await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(2));

        expect(recordPageView).toHaveBeenCalledWith({ pageId: '/music' });
        expect(recordEvent).toHaveBeenNthCalledWith(
            1,
            'site_visit',
            expect.objectContaining({
                landingPagePath: '/music',
                pagePath: '/music',
                previousPagePath: null,
                siteSessionId: 'session-test-1',
                occurredAt: '2026-05-24T01:00:00.000Z',
            }),
        );
        expect(recordEvent).toHaveBeenNthCalledWith(
            2,
            'page_view',
            expect.objectContaining({
                pagePath: '/music',
                previousPagePath: null,
                siteSessionId: 'session-test-1',
                occurredAt: '2026-05-24T01:00:00.000Z',
            }),
        );

        analytics.recordSitePageView('/releases/so-we-sleep');
        await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(3));
        expect(recordPageView).toHaveBeenCalledWith({ pageId: '/releases/so-we-sleep' });
        expect(recordEvent).toHaveBeenNthCalledWith(
            3,
            'page_view',
            expect.objectContaining({
                pagePath: '/releases/so-we-sleep',
                previousPagePath: '/music',
            }),
        );
    });

    test('deduplicates release and track impressions per page session', async () => {
        const { analytics, recordEvent } = await loadAnalyticsWithRum();
        const releaseContext = {
            releaseId: 'release_so-we-sleep_2026' as const,
            assetId: 'asset_so-we-sleep_cover' as const,
        };
        const trackContext = {
            ...releaseContext,
            songId: 'song_so-we-sleep_01' as const,
            recordingId: 'recording_so-we-sleep_01' as const,
            trackId: 'track_so-we-sleep_01' as const,
            assetId: 'asset_so-we-sleep_01_hls' as const,
            durationSeconds: 180,
        };

        analytics.recordReleaseView(releaseContext);
        analytics.recordReleaseView(releaseContext);
        analytics.recordTrackImpression(trackContext);
        analytics.recordTrackImpression(trackContext);

        await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(2));
        expect(recordEvent.mock.calls.map(([eventName]) => eventName)).toEqual([
            'release_view',
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
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));

        const analytics = await import('./player-analytics');
        analytics.recordPlayPause({
            releaseId: 'release_so-we-sleep_2026',
            trackId: 'track_so-we-sleep_01',
        });

        await Promise.resolve();
        expect(AwsRum).not.toHaveBeenCalled();
    });

    test('does not load the RUM client when the browser sends privacy opt out signals', async () => {
        vi.resetModules();
        const AwsRum = vi.fn();
        vi.doMock('aws-rum-web', () => ({
            AwsRum,
        }));
        vi.stubGlobal('navigator', {
            globalPrivacyControl: true,
            doNotTrack: '1',
        });
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
        vi.stubGlobal('window', {
            __APP_CONFIG__: {
                app: {
                    mediaBaseUrl: 'https://media.tsonu.com',
                    rum: {
                        enabled: true,
                        applicationId: 'rum-app-id',
                        applicationRegion: 'us-east-1',
                        identityPoolId: 'us-east-1:identity-pool',
                        guestRoleArn: 'arn:aws:iam::123456789012:role/rum',
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
        expect(analytics.hasPrivacyOptOutSignal()).toBe(true);
        analytics.recordSitePageView('/');
        analytics.recordPlayStart({
            releaseId: 'release_so-we-sleep_2026',
            songId: 'song_so-we-sleep_01',
            recordingId: 'recording_so-we-sleep_01',
            trackId: 'track_so-we-sleep_01',
        });

        await Promise.resolve();
        expect(AwsRum).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('does not load the RUM client when the browser would block the dataplane', async () => {
        vi.resetModules();
        const AwsRum = vi.fn();
        vi.doMock('aws-rum-web', () => ({
            AwsRum,
        }));
        vi.stubGlobal('crypto', {
            randomUUID: () => 'session-test-blocked',
        });
        // The dataplane probe rejects (content blocker / Safari ITP). The
        // first-party analytics POST should still go through unaffected, so
        // we mock per-URL rather than per-call-order.
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.startsWith('https://dataplane.rum.')) {
                return Promise.reject(new TypeError('Fetch API cannot load'));
            }
            return Promise.resolve({ ok: true });
        });
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('window', {
            __APP_CONFIG__: {
                app: {
                    adminApiBaseUrl: 'https://api.music.tsonu.com',
                    mediaBaseUrl: 'https://media.tsonu.com',
                    rum: {
                        enabled: true,
                        applicationId: 'rum-app-id',
                        applicationRegion: 'us-east-1',
                        endpoint: 'https://dataplane.rum.us-east-1.amazonaws.com',
                        identityPoolId: 'us-east-1:identity-pool',
                        guestRoleArn: 'arn:aws:iam::123456789012:role/rum',
                        sessionSampleRate: 1,
                        telemetries: ['errors'],
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
        analytics.recordPlayStart({
            releaseId: 'release_so-we-sleep_2026',
            songId: 'song_so-we-sleep_01',
            recordingId: 'recording_so-we-sleep_01',
            trackId: 'track_so-we-sleep_01',
        });

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        // RUM SDK never loaded — probe rejected.
        expect(AwsRum).not.toHaveBeenCalled();
        // Probe fetch was attempted with HEAD + cors.
        expect(fetchMock).toHaveBeenCalledWith(
            'https://dataplane.rum.us-east-1.amazonaws.com/',
            expect.objectContaining({ method: 'HEAD', mode: 'cors' }),
        );
        // First-party analytics POST is unaffected.
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.music.tsonu.com/analytics/play',
            expect.objectContaining({ method: 'POST' }),
        );
    });
});
