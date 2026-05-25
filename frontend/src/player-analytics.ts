import type { AwsRumConfig } from 'aws-rum-web';
import type { PlaybackQuality, StableId } from './catalog/media-catalog';
import { getRuntimeConfig, type AppRuntimeConfig } from './runtime-config';

export const playerEventNames = [
    'release_view',
    'track_impression',
    'play_start',
    'play_pause',
    'play_seek',
    'play_progress_25',
    'play_progress_50',
    'play_progress_75',
    'play_complete',
    'quality_changed',
    'play_error',
] as const;

export type PlayerEventName = (typeof playerEventNames)[number];
type BackendPlayEventName = 'play_start' | 'play_10s' | 'play_25' | 'play_complete';

export interface PlayerEventContext {
    releaseId: StableId;
    songId?: StableId;
    recordingId?: StableId;
    trackId?: StableId;
    assetId?: StableId;
    quality?: PlaybackQuality | string;
    positionSeconds?: number;
    durationSeconds?: number;
}

type PlayerEventExtra = Record<string, string | number | boolean | null>;

type PlayerEventPayload = PlayerEventExtra & {
    eventVersion: number;
    releaseId: StableId;
    songId: StableId | null;
    recordingId: StableId | null;
    trackId: StableId | null;
    assetId: StableId | null;
    selectedQuality: string | null;
    positionSeconds: number;
    sessionPositionSeconds: number;
    durationSeconds: number | null;
    siteSessionId: string;
    playbackSessionId: string;
    pagePath: string;
    occurredAt: string;
};

type AwsRumClient = InstanceType<typeof import('aws-rum-web').AwsRum> & {
    recordPageView?: (page: { pageId: string }) => void;
};

type NavigatorPrivacySignals = Navigator & {
    globalPrivacyControl?: boolean;
    msDoNotTrack?: string | null;
};

const SITE_SESSION_STORAGE_KEY = 'tsonu.analytics.siteSessionId';
const PLAYBACK_SESSION_STORAGE_KEY = 'tsonu.player.playbackSessionId';
const VISIT_RECORDED_STORAGE_KEY = 'tsonu.analytics.visitRecorded';

let rumClient: AwsRumClient | undefined;
let rumInitializationPromise: Promise<AwsRumClient | undefined> | undefined;
let siteSessionId: string | undefined;
let playbackSessionId: string | undefined;
let previousPagePath: string | undefined;
const recordedOnceKeys = new Set<string>();
const backendPlayKeys = new Set<string>();

function clampSampleRate(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 1;
    }

    return Math.max(0, Math.min(1, value));
}

function normalizeSeconds(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return 0;
    }

    return Math.round(value * 1000) / 1000;
}

function nullableSeconds(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return null;
    }

    return normalizeSeconds(value);
}

function getPagePath(): string {
    if (typeof window === 'undefined') {
        return '';
    }

    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function getPageTitle(): string | null {
    if (typeof document === 'undefined') {
        return null;
    }

    return document.title || null;
}

function createSessionId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function getStoredSessionId(storageKey: string): string {
    if (typeof window === 'undefined') {
        return createSessionId();
    }

    try {
        const storedSessionId = window.sessionStorage.getItem(storageKey);
        if (storedSessionId) {
            return storedSessionId;
        }

        const createdSessionId = createSessionId();
        window.sessionStorage.setItem(storageKey, createdSessionId);
        return createdSessionId;
    } catch {
        return createSessionId();
    }
}

export function getSiteSessionId(): string {
    if (!siteSessionId) {
        siteSessionId = getStoredSessionId(SITE_SESSION_STORAGE_KEY);
    }

    return siteSessionId;
}

export function getPlaybackSessionId(): string {
    if (!playbackSessionId) {
        playbackSessionId = getStoredSessionId(PLAYBACK_SESSION_STORAGE_KEY);
    }

    return playbackSessionId;
}

function hasRumCredentials(config: AppRuntimeConfig): boolean {
    return Boolean(
        config.rum.enabled &&
        config.rum.applicationId &&
        config.rum.applicationRegion &&
        config.rum.identityPoolId &&
        config.rum.guestRoleArn,
    );
}

export function hasPrivacyOptOutSignal(): boolean {
    if (typeof navigator === 'undefined') {
        return false;
    }

    const privacyNavigator = navigator as NavigatorPrivacySignals;
    return Boolean(
        privacyNavigator.globalPrivacyControl === true ||
        privacyNavigator.doNotTrack === '1' ||
        privacyNavigator.msDoNotTrack === '1',
    );
}

/**
 * Probe the AWS RUM dataplane with a cheap HEAD request before we instantiate
 * the SDK. If the request is rejected by the browser (content blocker, Safari
 * ITP, network policy, etc.), `fetch` throws a TypeError and we skip RUM
 * entirely for the rest of the session — no client construction, no event
 * queue, no failed beacons spamming the console. A 4xx response means the
 * endpoint is reachable and CORS works; that's all we need to know.
 */
async function isRumDataplaneReachable(endpoint: string): Promise<boolean> {
    if (typeof fetch === 'undefined' || typeof AbortController === 'undefined') {
        return true;
    }

    let probeUrl: string;
    try {
        const origin = new URL(endpoint).origin;
        probeUrl = `${origin}/`;
    } catch {
        return true;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
        await fetch(probeUrl, {
            method: 'HEAD',
            mode: 'cors',
            cache: 'no-store',
            credentials: 'omit',
            signal: controller.signal,
        });
        // Reaching here means the network roundtrip completed and the CORS
        // check passed. The actual HTTP status doesn't matter — AWS RUM will
        // 4xx an unauthenticated HEAD anyway.
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

export function initializeRum(config: AppRuntimeConfig = getRuntimeConfig()): Promise<AwsRumClient | undefined> {
    if (rumClient) {
        return Promise.resolve(rumClient);
    }

    if (rumInitializationPromise) {
        return rumInitializationPromise;
    }

    if (!hasRumCredentials(config) || hasPrivacyOptOutSignal()) {
        rumInitializationPromise = Promise.resolve(undefined);
        return rumInitializationPromise;
    }

    rumInitializationPromise = (async () => {
        const reachable = await isRumDataplaneReachable(config.rum.endpoint);
        if (!reachable) {
            // Browser is going to block RUM beacons. Don't load the SDK at all;
            // every recordEvent() call will short-circuit on a null client.
            return undefined;
        }

        try {
            const { AwsRum } = await import('aws-rum-web');
            const rumConfig: AwsRumConfig = {
                allowCookies: config.rum.allowCookies ?? false,
                disableAutoPageView: true,
                enableXRay: false,
                endpoint: config.rum.endpoint,
                guestRoleArn: config.rum.guestRoleArn,
                identityPoolId: config.rum.identityPoolId,
                sessionSampleRate: clampSampleRate(config.rum.sessionSampleRate),
                telemetries: config.rum.telemetries as AwsRumConfig['telemetries'],
            };

            rumClient = new AwsRum(
                config.rum.applicationId!,
                config.rum.applicationVersion ?? '0.1.0',
                config.rum.applicationRegion!,
                rumConfig,
            );

            rumClient.addSessionAttributes({
                siteSessionId: getSiteSessionId(),
                playbackSessionId: getPlaybackSessionId(),
            });

            return rumClient;
        } catch (error) {
            console.warn('CloudWatch RUM initialization failed.', error);
            rumClient = undefined;
            return undefined;
        }
    })();

    return rumInitializationPromise;
}

function getReferrerInfo(): { referrerOrigin: string | null; referrerHost: string | null } {
    if (typeof document === 'undefined' || !document.referrer) {
        return { referrerOrigin: null, referrerHost: null };
    }

    try {
        const referrerUrl = new URL(document.referrer);
        return {
            referrerOrigin: referrerUrl.origin || null,
            referrerHost: referrerUrl.hostname || null,
        };
    } catch {
        return {
            referrerOrigin: null,
            referrerHost: null,
        };
    }
}

function resolveApiUrl(path: string): string {
    const { adminApiBaseUrl } = getRuntimeConfig();
    const baseUrl = adminApiBaseUrl.endsWith('/') ? adminApiBaseUrl : `${adminApiBaseUrl}/`;
    return new URL(path.replace(/^\/+/, ''), baseUrl).toString();
}

function getSearchParam(name: string): string | null {
    if (typeof window === 'undefined') {
        return null;
    }

    return new URLSearchParams(window.location.search).get(name);
}

function shouldRecordVisit(previousPath: string | undefined): boolean {
    if (typeof window === 'undefined') {
        return false;
    }

    try {
        if (window.sessionStorage.getItem(VISIT_RECORDED_STORAGE_KEY) === getSiteSessionId()) {
            return false;
        }

        window.sessionStorage.setItem(VISIT_RECORDED_STORAGE_KEY, getSiteSessionId());
        return true;
    } catch {
        return previousPath === undefined;
    }
}

function buildSitePayload(pagePath: string, previousPath: string | undefined) {
    const config = getRuntimeConfig();
    const { referrerOrigin, referrerHost } = getReferrerInfo();

    return {
        eventVersion: config.rum.playbackEventVersion ?? 1,
        siteSessionId: getSiteSessionId(),
        pagePath,
        previousPagePath: previousPath ?? null,
        referrerOrigin,
        referrerHost,
        pageTitle: getPageTitle(),
        utmSource: getSearchParam('utm_source'),
        utmMedium: getSearchParam('utm_medium'),
        utmCampaign: getSearchParam('utm_campaign'),
        occurredAt: new Date().toISOString(),
    };
}

export function recordSitePageView(pagePath: string = getPagePath()): void {
    const normalizedPagePath = pagePath || '/';
    const previousPath = previousPagePath;
    if (normalizedPagePath === previousPath) {
        return;
    }

    const sitePayload = buildSitePayload(normalizedPagePath, previousPath);
    const recordVisit = shouldRecordVisit(previousPath);
    previousPagePath = normalizedPagePath;

    void initializeRum().then((client) => {
        if (!client) {
            return;
        }

        if (recordVisit) {
            client.recordEvent('site_visit', {
                ...sitePayload,
                landingPagePath: normalizedPagePath,
            });
        }

        client.recordPageView?.({ pageId: normalizedPagePath });
        client.recordEvent('page_view', sitePayload);
    });
}

function buildPayload(context: PlayerEventContext, extra: PlayerEventExtra = {}): PlayerEventPayload {
    const config = getRuntimeConfig();
    const positionSeconds = normalizeSeconds(context.positionSeconds);

    return {
        ...extra,
        eventVersion: config.rum.playbackEventVersion ?? 1,
        releaseId: context.releaseId,
        songId: context.songId ?? null,
        recordingId: context.recordingId ?? null,
        trackId: context.trackId ?? null,
        assetId: context.assetId ?? null,
        selectedQuality: context.quality ?? null,
        positionSeconds,
        sessionPositionSeconds: positionSeconds,
        durationSeconds: nullableSeconds(context.durationSeconds),
        siteSessionId: getSiteSessionId(),
        playbackSessionId: getPlaybackSessionId(),
        pagePath: getPagePath(),
        occurredAt: new Date().toISOString(),
    };
}

function recordOnce(key: string, eventName: PlayerEventName, context: PlayerEventContext, extra?: PlayerEventExtra): void {
    if (recordedOnceKeys.has(key)) {
        return;
    }

    recordedOnceKeys.add(key);
    recordPlayerEvent(eventName, context, extra);
}

export function recordPlayerEvent(
    eventName: PlayerEventName,
    context: PlayerEventContext,
    extra?: PlayerEventExtra,
): void {
    const payload = buildPayload(context, extra);
    if (rumClient) {
        rumClient.recordEvent(eventName, payload);
        return;
    }

    void initializeRum().then((client) => {
        client?.recordEvent(eventName, payload);
    });
}

function backendPlayKey(eventType: BackendPlayEventName, context: PlayerEventContext): string {
    return [
        getSiteSessionId(),
        eventType,
        context.releaseId,
        context.trackId ?? 'track_unknown',
        context.songId ?? 'song_unknown',
        context.recordingId ?? 'recording_unknown',
    ].join(':');
}

function recordBackendPlayEvent(eventType: BackendPlayEventName, context: PlayerEventContext): void {
    if (!context.songId || !context.recordingId || !context.trackId) {
        return;
    }

    const key = backendPlayKey(eventType, context);
    if (backendPlayKeys.has(key)) {
        return;
    }
    backendPlayKeys.add(key);

    const { referrerOrigin, referrerHost } = getReferrerInfo();
    const positionSeconds = normalizeSeconds(context.positionSeconds);
    const body = JSON.stringify({
        eventType,
        releaseId: context.releaseId,
        trackId: context.trackId,
        songId: context.songId,
        recordingId: context.recordingId,
        assetId: context.assetId ?? null,
        selectedQuality: context.quality ?? null,
        positionSeconds,
        durationSeconds: nullableSeconds(context.durationSeconds),
        siteSessionId: getSiteSessionId(),
        playbackSessionId: getPlaybackSessionId(),
        pagePath: getPagePath(),
        referrerOrigin,
        referrerHost,
        occurredAt: new Date().toISOString(),
    });

    void fetch(resolveApiUrl('/analytics/play'), {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body,
        keepalive: true,
    }).catch((error: unknown) => {
        console.warn('Backend play analytics failed.', error);
    });
}

export function recordReleaseView(context: PlayerEventContext): void {
    recordOnce(`release_view:${context.releaseId}`, 'release_view', context);
}

export function recordTrackImpression(context: PlayerEventContext): void {
    recordOnce(
        `track_impression:${context.releaseId}:${context.trackId ?? context.recordingId ?? context.assetId ?? 'unknown'}`,
        'track_impression',
        context,
    );
}

export function recordPlayStart(context: PlayerEventContext): void {
    recordBackendPlayEvent('play_start', context);
    recordPlayerEvent('play_start', context);
}

export function recordPlayPause(context: PlayerEventContext): void {
    recordPlayerEvent('play_pause', context);
}

export function recordPlaySeek(
    context: PlayerEventContext,
    seekFromSeconds: number,
    seekToSeconds: number,
): void {
    recordPlayerEvent('play_seek', context, {
        seekFromSeconds: normalizeSeconds(seekFromSeconds),
        seekToSeconds: normalizeSeconds(seekToSeconds),
    });
}

export function recordPlayProgress(context: PlayerEventContext, milestonePercent: 25 | 50 | 75): void {
    if (milestonePercent === 25) {
        recordBackendPlayEvent('play_25', context);
    }
    recordPlayerEvent(`play_progress_${milestonePercent}` as PlayerEventName, context, {
        milestonePercent,
    });
}

export function recordPlayTenSeconds(context: PlayerEventContext): void {
    recordBackendPlayEvent('play_10s', context);
}

export function recordPlayComplete(context: PlayerEventContext): void {
    recordBackendPlayEvent('play_complete', context);
    recordPlayerEvent('play_complete', context);
}

export function recordQualityChanged(
    context: PlayerEventContext,
    previousQuality: PlaybackQuality | string | null,
    selectedQuality: PlaybackQuality | string,
): void {
    recordPlayerEvent(
        'quality_changed',
        {
            ...context,
            quality: selectedQuality,
        },
        {
            previousQuality,
            selectedQuality,
        },
    );
}

export function recordPlayError(context: PlayerEventContext, error: unknown): void {
    const errorObject = error instanceof Error ? error : undefined;

    recordPlayerEvent('play_error', context, {
        errorName: errorObject?.name ?? null,
        errorMessage: errorObject?.message ?? String(error),
    });
}
