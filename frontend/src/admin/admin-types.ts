import type { CatalogArtwork, ExternalLink, ReleaseKind, ReleaseStatus, StableId, Visibility } from '../catalog/media-catalog';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface DraftSourceMaster {
    bucket: string;
    key: string;
    format?: 'wav' | 'aiff' | 'flac';
    uploadedAt?: string;
    versionId?: string;
    etag?: string;
    sampleRateHz?: number;
    bitDepth?: number;
    channels?: number;
}

export type RecordingFileKind = 'hls-master' | 'hls-rendition' | 'download' | 'metadata';
export type RecordingFileQuality = 'aac-192' | 'aac-320' | 'flac-lossless';

export interface RecordingFile {
    fileId: StableId;
    kind: RecordingFileKind;
    quality?: RecordingFileQuality;
    path: string;
    mimeType: string;
    bitrateKbps?: number;
    sampleRateHz?: number;
    channels?: number;
    fileSizeBytes?: number;
    checksumSha256?: string;
    createdAt?: string;
}

export interface DraftRecording {
    recordingId: StableId;
    slug: string;
    title: string;
    versionTitle?: string;
    versionType: '' | 'studio_master' | 'album_master' | 'single_master' | 'demo' | 'preview' | 'live' | 'alternate' | 'remaster';
    artistName?: string;
    durationSeconds?: number;
    explicit: boolean;
    isrc?: string;
    description?: string;
    sourceMaster?: DraftSourceMaster;
    encodeJobIds?: StableId[];
    files?: RecordingFile[];
}

export interface DraftSong {
    schemaVersion: 1;
    entityType: 'draftSong';
    songId: StableId;
    slug: string;
    title: string;
    artistName: string;
    description?: string;
    lyrics?: string;
    credits?: JsonValue;
    tags?: string[];
    artwork?: CatalogArtwork;
    updatedAt?: string;
    recordings: DraftRecording[];
}

export interface DraftReleaseTrack {
    trackId: StableId;
    songId: StableId;
    recordingId: StableId;
    discNumber: number;
    trackNumber: number;
    slug: string;
    title: string;
    explicit?: boolean;
    isrc?: string;
    description?: string;
    credits?: JsonValue;
}

export interface DraftRelease {
    schemaVersion: 1;
    entityType: 'draftRelease';
    releaseId: StableId;
    slug: string;
    title: string;
    subtitle?: string;
    artistName: string;
    releaseKind: ReleaseKind;
    releaseStatus: ReleaseStatus;
    releaseDate?: string;
    publishState: 'draft' | 'ready' | 'published' | 'withdrawn';
    description?: string;
    copyright?: string;
    artwork?: CatalogArtwork;
    credits?: JsonValue;
    links?: ExternalLink[];
    tags?: string[];
    tracks: DraftReleaseTrack[];
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

export interface WriteResult {
    bucket: string;
    key: string;
    eTag?: string;
    versionId?: string;
}

export interface UploadUrlRequest {
    recordingId: StableId;
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

export interface ArtworkUploadUrlRequest {
    ownerType: 'release' | 'song';
    ownerId: StableId;
    filename: string;
    contentType?: string;
    width: number;
    height: number;
    altText: string;
    expiresInSeconds?: number;
}

export interface ArtworkUploadUrlResponse {
    bucket: string;
    key: string;
    url: string;
    method: 'PUT';
    headers: {
        'Content-Type': string;
    };
    expiresInSeconds: number;
    artwork: CatalogArtwork;
}

export type EncodeStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface EncodeJob {
    schemaVersion: 1;
    entityType: 'encodeJob';
    jobId: StableId;
    songId: StableId;
    recordingId: StableId;
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
    releaseId: StableId;
    manifestPath: string;
    visibility: Visibility;
    fileIds: StableId[];
    releaseWrite: WriteResult;
    draftWrite: WriteResult;
    invalidation: {
        distributionId: string;
        invalidationId?: string;
        paths: string[];
    };
}

export interface MaintenanceReport {
    generatedAt: string;
    staleDraftRecordings: StaleDraftRecording[];
    orphanReleaseTracks: OrphanReleaseTrack[];
    staleEncodeJobs: StaleEncodeJob[];
    stalePublishedSongs: StalePublishedSong[];
    totals: {
        staleDraftRecordings: number;
        orphanReleaseTracks: number;
        staleEncodeJobs: number;
        stalePublishedSongs: number;
    };
}

export interface StaleDraftRecording {
    songId: StableId;
    songTitle: string;
    recordingId: StableId;
    recordingTitle: string;
    reason: string;
}

export interface OrphanReleaseTrack {
    releaseId: StableId;
    releaseTitle: string;
    trackId: StableId;
    trackTitle: string;
    songId: StableId;
    recordingId: StableId;
    reason: string;
}

export interface StaleEncodeJob {
    jobId: StableId;
    songId: StableId;
    recordingId: StableId;
    status: EncodeStatus;
    requestedAt?: string;
    finishedAt?: string;
    reason: string;
}

export interface StalePublishedSong {
    songId: StableId;
    slug: string;
    title: string;
    reason: string;
}

export interface MaintenanceCleanupRequest {
    draftRecordings?: Array<Pick<StaleDraftRecording, 'songId' | 'recordingId'>>;
    releaseTracks?: Array<Pick<OrphanReleaseTrack, 'releaseId' | 'trackId'>>;
    encodeJobIds?: StableId[];
    publishedSongIds?: StableId[];
}

export interface MaintenanceCleanupResponse {
    deleted: {
        draftRecordings: number;
        releaseTracks: number;
        encodeJobs: number;
        publishedSongs: number;
    };
    report: MaintenanceReport;
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
    visits: number;
    pageViews: number;
    bounces: number;
    bounceRate: number;
    standard: {
        pageViews: number;
        navigationEvents: number;
        jsErrors: number;
        httpEvents: number;
    };
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
    releases: Array<{
        releaseId: StableId;
        totalEvents: number;
        playStarts: number;
        playCompletes: number;
        playerErrors: number;
    }>;
    tracks: Array<{
        releaseId: StableId;
        trackId: StableId;
        songId?: StableId;
        recordingId?: StableId;
        totalEvents: number;
        playStarts: number;
        playCompletes: number;
        playerErrors: number;
    }>;
    pages: Array<{
        pagePath: string;
        views: number;
        bounces: number;
        bounceRate: number;
    }>;
    referrers: Array<{
        value: string;
        count: number;
    }>;
    browsers: Array<{
        value: string;
        count: number;
    }>;
    devices: Array<{
        value: string;
        count: number;
    }>;
    countries: Array<{
        value: string;
        count: number;
    }>;
    backendPlayEvents: {
        totalEvents: number;
        uniqueSiteSessions: number;
        playStarts: number;
        tenSecondPlays: number;
        twentyFivePercentPlays: number;
        playCompletes: number;
        playCompletionRate: number;
        events: Array<{
            eventType: string;
            count: number;
        }>;
        songs: Array<{
            songId: StableId;
            recordingId: StableId;
            title?: string;
            totalEvents: number;
            playStarts: number;
            tenSecondPlays: number;
            twentyFivePercentPlays: number;
            playCompletes: number;
        }>;
        releases: Array<{
            releaseId: StableId;
            trackId: StableId;
            songId: StableId;
            recordingId: StableId;
            title?: string;
            totalEvents: number;
            playStarts: number;
            tenSecondPlays: number;
            twentyFivePercentPlays: number;
            playCompletes: number;
        }>;
    };
    recentErrors: Array<{
        timestamp?: string;
        releaseId?: StableId;
        songId?: StableId;
        recordingId?: StableId;
        trackId?: StableId;
        errorName?: string;
        errorMessage?: string;
    }>;
}
