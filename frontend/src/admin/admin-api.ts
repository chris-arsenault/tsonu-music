import { getIdToken } from '../auth';
import { getRuntimeConfig } from '../runtime-config';
import type {
    ArtworkUploadUrlRequest,
    ArtworkUploadUrlResponse,
    DraftRelease,
    DraftSong,
    EncodeJob,
    EncodeJobCreateResponse,
    ObjectList,
    PublishResponse,
    RumSummary,
    UploadUrlRequest,
    UploadUrlResponse,
    WriteResult,
} from './admin-types';

interface ApiJsonResult<T> {
    data: T;
    eTag?: string;
    versionId?: string;
}

interface ApiErrorBody {
    error?: {
        code?: string;
        message?: string;
    };
}

export class AdminApiError extends Error {
    readonly status: number;
    readonly code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = 'AdminApiError';
        this.status = status;
        this.code = code;
    }
}

function adminApiBaseUrl(): string {
    return getRuntimeConfig().adminApiBaseUrl.replace(/\/+$/, '');
}

function adminUrl(path: string): string {
    return `${adminApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

async function readError(response: Response): Promise<AdminApiError> {
    const text = await response.text();
    let parsed: ApiErrorBody | undefined;
    try {
        parsed = text ? JSON.parse(text) as ApiErrorBody : undefined;
    } catch {
        parsed = undefined;
    }

    const code = parsed?.error?.code;
    const message = parsed?.error?.message
        ?? (response.statusText || `Request failed with status ${response.status}`);
    return new AdminApiError(message, response.status, code);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<ApiJsonResult<T>> {
    const headers = new Headers(init.headers);
    const token = await getIdToken();

    if (!token) {
        throw new AdminApiError('Not authenticated.', 401, 'not_authenticated');
    }

    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${token}`);

    const response = await fetch(adminUrl(path), {
        ...init,
        headers,
        cache: 'no-store',
    });

    if (!response.ok) {
        throw await readError(response);
    }

    const text = await response.text();
    return {
        data: text ? JSON.parse(text) as T : undefined as T,
        eTag: response.headers.get('etag') ?? undefined,
        versionId: response.headers.get('x-s3-version-id') ?? undefined,
    };
}

function jsonInit(method: string, body: unknown, headers?: HeadersInit): RequestInit {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Content-Type', 'application/json');
    return {
        method,
        headers: requestHeaders,
        body: JSON.stringify(body),
    };
}

export async function listDraftSongs(): Promise<ObjectList> {
    return (await requestJson<ObjectList>('/admin/songs')).data;
}

export async function getDraftSong(songId: string): Promise<ApiJsonResult<DraftSong>> {
    return requestJson<DraftSong>(`/admin/songs/${encodeURIComponent(songId)}`);
}

export async function putDraftSong(song: DraftSong, eTag?: string): Promise<WriteResult> {
    const headers = eTag ? { 'If-Match': eTag } : { 'If-None-Match': '*' };
    return (await requestJson<WriteResult>(
        `/admin/songs/${encodeURIComponent(song.songId)}`,
        jsonInit('PUT', song, headers),
    )).data;
}

export async function deleteDraftSong(songId: string, eTag: string): Promise<WriteResult> {
    return (await requestJson<WriteResult>(
        `/admin/songs/${encodeURIComponent(songId)}`,
        {
            method: 'DELETE',
            headers: { 'If-Match': eTag },
        },
    )).data;
}

export async function listDraftReleases(): Promise<ObjectList> {
    return (await requestJson<ObjectList>('/admin/releases')).data;
}

export async function getDraftRelease(releaseId: string): Promise<ApiJsonResult<DraftRelease>> {
    return requestJson<DraftRelease>(`/admin/releases/${encodeURIComponent(releaseId)}`);
}

export async function putDraftRelease(release: DraftRelease, eTag?: string): Promise<WriteResult> {
    const headers = eTag ? { 'If-Match': eTag } : { 'If-None-Match': '*' };
    return (await requestJson<WriteResult>(
        `/admin/releases/${encodeURIComponent(release.releaseId)}`,
        jsonInit('PUT', release, headers),
    )).data;
}

export async function deleteDraftRelease(releaseId: string, eTag: string): Promise<WriteResult> {
    return (await requestJson<WriteResult>(
        `/admin/releases/${encodeURIComponent(releaseId)}`,
        {
            method: 'DELETE',
            headers: { 'If-Match': eTag },
        },
    )).data;
}

export async function listJobs(): Promise<ObjectList> {
    return (await requestJson<ObjectList>('/admin/jobs')).data;
}

export async function getJob(jobId: string): Promise<EncodeJob> {
    return (await requestJson<EncodeJob>(`/admin/jobs/${encodeURIComponent(jobId)}`)).data;
}

export async function requestUploadUrl(request: UploadUrlRequest): Promise<UploadUrlResponse> {
    return (await requestJson<UploadUrlResponse>('/admin/upload-url', jsonInit('POST', request))).data;
}

export async function requestArtworkUploadUrl(request: ArtworkUploadUrlRequest): Promise<ArtworkUploadUrlResponse> {
    return (await requestJson<ArtworkUploadUrlResponse>('/admin/artwork-upload-url', jsonInit('POST', request))).data;
}

export async function uploadMasterFile(upload: UploadUrlResponse, file: File): Promise<void> {
    const response = await fetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body: file,
    });

    if (!response.ok) {
        throw new AdminApiError(`Master upload failed: ${response.status} ${response.statusText}`, response.status);
    }
}

export async function uploadArtworkFile(upload: ArtworkUploadUrlResponse, file: File): Promise<void> {
    const response = await fetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body: file,
    });

    if (!response.ok) {
        throw new AdminApiError(`Artwork upload failed: ${response.status} ${response.statusText}`, response.status);
    }
}

export async function createEncodeJob(request: {
    songId: string;
    recordingId: string;
    includeLossless?: boolean;
    requestedBy?: string;
}): Promise<EncodeJobCreateResponse> {
    return (await requestJson<EncodeJobCreateResponse>('/admin/encode-jobs', jsonInit('POST', request))).data;
}

export async function publishRelease(releaseId: string, request: {
    visibility?: 'public' | 'unlisted';
    trackJobIds?: Record<string, string>;
    publishedAt?: string;
}): Promise<PublishResponse> {
    return (await requestJson<PublishResponse>(
        `/admin/publish/${encodeURIComponent(releaseId)}`,
        jsonInit('POST', request),
    )).data;
}

export async function getRumSummary(hours: number): Promise<RumSummary> {
    return (await requestJson<RumSummary>(`/admin/rum/summary?hours=${encodeURIComponent(hours)}`)).data;
}
