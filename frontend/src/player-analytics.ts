import type { AwsRumConfig } from 'aws-rum-web';
import type { PlaybackQuality, StableId } from './catalog/media-catalog';
import { getRuntimeConfig, type AppRuntimeConfig } from './runtime-config';

export const playerEventNames = [
    'album_view',
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

export interface PlayerEventContext {
    albumId: StableId;
    releaseId: StableId;
    trackId?: StableId;
    assetId?: StableId;
    quality?: PlaybackQuality | string;
    positionSeconds?: number;
    durationSeconds?: number;
}

type PlayerEventExtra = Record<string, string | number | boolean | null>;

type PlayerEventPayload = PlayerEventExtra & {
    eventVersion: number;
    albumId: StableId;
    releaseId: StableId;
    trackId: StableId | null;
    assetId: StableId | null;
    selectedQuality: string | null;
    positionSeconds: number;
    sessionPositionSeconds: number;
    durationSeconds: number | null;
    playbackSessionId: string;
    pagePath: string;
    occurredAt: string;
};

type AwsRumClient = InstanceType<typeof import('aws-rum-web').AwsRum>;

const PLAYBACK_SESSION_STORAGE_KEY = 'tsonu.player.playbackSessionId';

let rumClient: AwsRumClient | undefined;
let rumInitializationPromise: Promise<AwsRumClient | undefined> | undefined;
let playbackSessionId: string | undefined;
const recordedOnceKeys = new Set<string>();

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

function createPlaybackSessionId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function getPlaybackSessionId(): string {
    if (playbackSessionId) {
        return playbackSessionId;
    }

    if (typeof window === 'undefined') {
        playbackSessionId = createPlaybackSessionId();
        return playbackSessionId;
    }

    try {
        const storedSessionId = window.sessionStorage.getItem(PLAYBACK_SESSION_STORAGE_KEY);
        if (storedSessionId) {
            playbackSessionId = storedSessionId;
            return playbackSessionId;
        }

        playbackSessionId = createPlaybackSessionId();
        window.sessionStorage.setItem(PLAYBACK_SESSION_STORAGE_KEY, playbackSessionId);
        return playbackSessionId;
    } catch {
        playbackSessionId = createPlaybackSessionId();
        return playbackSessionId;
    }
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

export function initializeRum(config: AppRuntimeConfig = getRuntimeConfig()): Promise<AwsRumClient | undefined> {
    if (rumClient) {
        return Promise.resolve(rumClient);
    }

    if (rumInitializationPromise) {
        return rumInitializationPromise;
    }

    if (!hasRumCredentials(config)) {
        rumInitializationPromise = Promise.resolve(undefined);
        return rumInitializationPromise;
    }

    rumInitializationPromise = import('aws-rum-web').then(({ AwsRum }) => {
        const rumConfig: AwsRumConfig = {
            allowCookies: config.rum.allowCookies ?? false,
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
            playbackSessionId: getPlaybackSessionId(),
        });

        return rumClient;
    }).catch((error: unknown) => {
        console.warn('CloudWatch RUM initialization failed.', error);
        rumClient = undefined;
        return undefined;
    });

    return rumInitializationPromise;
}

function buildPayload(context: PlayerEventContext, extra: PlayerEventExtra = {}): PlayerEventPayload {
    const config = getRuntimeConfig();
    const positionSeconds = normalizeSeconds(context.positionSeconds);

    return {
        ...extra,
        eventVersion: config.rum.playbackEventVersion ?? 1,
        albumId: context.albumId,
        releaseId: context.releaseId,
        trackId: context.trackId ?? null,
        assetId: context.assetId ?? null,
        selectedQuality: context.quality ?? null,
        positionSeconds,
        sessionPositionSeconds: positionSeconds,
        durationSeconds: nullableSeconds(context.durationSeconds),
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

export function recordAlbumView(context: PlayerEventContext): void {
    recordOnce(`album_view:${context.albumId}:${context.releaseId}`, 'album_view', context);
}

export function recordTrackImpression(context: PlayerEventContext): void {
    recordOnce(
        `track_impression:${context.albumId}:${context.releaseId}:${context.trackId ?? context.assetId ?? 'unknown'}`,
        'track_impression',
        context,
    );
}

export function recordPlayStart(context: PlayerEventContext): void {
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
    recordPlayerEvent(`play_progress_${milestonePercent}` as PlayerEventName, context, {
        milestonePercent,
    });
}

export function recordPlayComplete(context: PlayerEventContext): void {
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
