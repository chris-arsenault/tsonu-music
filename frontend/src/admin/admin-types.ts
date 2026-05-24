import type { ExternalLink, ReleaseType, StableId, Visibility } from '../catalog/media-catalog';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface DraftSourceMaster {
    bucket: string;
    key: string;
    format?: string;
    versionId?: string;
    etag?: string;
    bitDepth?: number;
}

export interface DraftTrack {
    trackId: StableId;
    discNumber: number;
    trackNumber: number;
    slug: string;
    title: string;
    durationSeconds: number;
    explicit: boolean;
    isrc?: string;
    description?: string;
    credits?: JsonValue;
    sourceMaster?: DraftSourceMaster;
    encodeJobIds?: StableId[];
}

export interface DraftAlbum {
    schemaVersion: 1;
    entityType: 'draftAlbum';
    albumId: StableId;
    releaseId: StableId;
    slug: string;
    title: string;
    subtitle?: string;
    artistName: string;
    releaseType: ReleaseType;
    releaseDate?: string;
    publishState: 'draft' | 'ready' | 'published';
    description?: string;
    copyright?: string;
    artwork?: JsonValue;
    credits?: JsonValue;
    links?: ExternalLink[];
    tags?: string[];
    tracks: DraftTrack[];
    updatedAt?: string;
}

export interface ObjectSummary {
    key: string;
    eTag?: string;
    sizeBytes: number;
}

export interface ObjectList {
    bucket: string;
    prefix: string;
    objects: ObjectSummary[];
}

export interface S3WriteResult {
    bucket: string;
    key: string;
    eTag?: string;
    versionId?: string;
}

export interface TrackWriteResponse {
    albumId: StableId;
    trackId: StableId;
    created: boolean;
    write: S3WriteResult;
}

export interface UploadUrlRequest {
    albumId: StableId;
    trackId: StableId;
    filename: string;
    contentType?: string;
    expiresInSeconds?: number;
}

export interface UploadUrlResponse {
    bucket: string;
    key: string;
    url: string;
    method: 'PUT';
    headers: {
        'Content-Type': string;
    };
    expiresInSeconds: number;
    sourceMaster: DraftSourceMaster;
}

export type EncodeStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface EncodeJob {
    schemaVersion: 1;
    entityType: 'encodeJob';
    jobId: StableId;
    albumId: StableId;
    trackId: StableId;
    status: EncodeStatus;
    requestedAt: string;
    startedAt?: string;
    finishedAt?: string;
    input: {
        bucket: string;
        key: string;
        versionId?: string;
        etag?: string;
    };
    output: {
        bucket: string;
        prefix: string;
        assets: Array<{
            assetId: StableId;
            path: string;
            mimeType: string;
            fileSizeBytes?: number;
            checksumSha256?: string;
        }>;
    };
    ffmpeg?: {
        version?: string;
        args?: string[];
    };
    metadata?: {
        durationSeconds: number;
        codecName: string;
        sampleRateHz: number;
        channels: number;
    };
    error?: {
        code?: string;
        message: string;
        details?: string;
    };
}

export interface EncodeJobCreateResponse {
    job: EncodeJob;
    jobKey: string;
    encoderFunctionName: string;
    invocationStatusCode: number;
}

export interface PublishResponse {
    albumId: StableId;
    releaseId: StableId;
    manifestPath: string;
    visibility: Visibility;
    jobIds: StableId[];
    copiedObjectCount: number;
    copiedKeys: string[];
    albumWrite: S3WriteResult;
    catalogWrite: S3WriteResult;
    draftWrite: S3WriteResult;
    invalidation: {
        distributionId: string;
        invalidationId?: string;
        paths: string[];
    };
}

export interface RumSummary {
    logGroupName: string;
    queryId: string;
    windowHours: number;
    startTime: string;
    endTime: string;
    resultLimit: number;
    truncated: boolean;
    totalEvents: number;
    uniquePlaybackSessions: number;
    playStarts: number;
    playCompletes: number;
    playCompletionRate: number;
    playerErrors: number;
    progress25: number;
    progress50: number;
    progress75: number;
    events: Array<{
        eventType: string;
        count: number;
    }>;
    albums: Array<{
        albumId: StableId;
        totalEvents: number;
        playStarts: number;
        playCompletes: number;
        playerErrors: number;
    }>;
    tracks: Array<{
        albumId: StableId;
        trackId: StableId;
        totalEvents: number;
        playStarts: number;
        playCompletes: number;
        playerErrors: number;
    }>;
    recentErrors: Array<{
        timestamp?: string;
        albumId?: StableId;
        trackId?: StableId;
        errorName?: string;
        errorMessage?: string;
    }>;
}
