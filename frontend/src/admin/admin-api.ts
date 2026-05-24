import { getRuntimeConfig } from '../runtime-config';
import { getIdToken } from '../auth';
import type {
    DraftAlbum,
    DraftTrack,
    EncodeJob,
    EncodeJobCreateResponse,
    ObjectList,
    PublishResponse,
    RumSummary,
    WriteResult,
    TrackWriteResponse,
    UploadUrlRequest,
    UploadUrlResponse,
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
    const message = parsed?.error?.message ?? `${response.status} ${response.statusText}`;
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

export async function listDraftAlbums(): Promise<ObjectList> {
    return (await requestJson<ObjectList>('/admin/albums')).data;
}

export async function getDraftAlbum(albumId: string): Promise<ApiJsonResult<DraftAlbum>> {
    return requestJson<DraftAlbum>(`/admin/albums/${encodeURIComponent(albumId)}`);
}

export async function putDraftAlbum(album: DraftAlbum, eTag?: string): Promise<WriteResult> {
    const headers = eTag ? { 'If-Match': eTag } : { 'If-None-Match': '*' };
    return (await requestJson<WriteResult>(
        `/admin/albums/${encodeURIComponent(album.albumId)}`,
        jsonInit('PUT', album, headers),
    )).data;
}

export async function putDraftTrack(albumId: string, track: DraftTrack, albumETag: string): Promise<TrackWriteResponse> {
    return (await requestJson<TrackWriteResponse>(
        `/admin/albums/${encodeURIComponent(albumId)}/tracks/${encodeURIComponent(track.trackId)}`,
        jsonInit('PUT', track, { 'If-Match': albumETag }),
    )).data;
}

export async function deleteDraftTrack(albumId: string, trackId: string, albumETag: string): Promise<TrackWriteResponse> {
    return (await requestJson<TrackWriteResponse>(
        `/admin/albums/${encodeURIComponent(albumId)}/tracks/${encodeURIComponent(trackId)}`,
        {
            method: 'DELETE',
            headers: {
                'If-Match': albumETag,
            },
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

export async function createEncodeJob(request: {
    albumId: string;
    trackId: string;
    includeLossless?: boolean;
    requestedBy?: string;
}): Promise<EncodeJobCreateResponse> {
    return (await requestJson<EncodeJobCreateResponse>('/admin/encode-jobs', jsonInit('POST', request))).data;
}

export async function publishAlbum(albumId: string, request: {
    visibility?: 'public' | 'unlisted';
    trackJobIds?: Record<string, string>;
    publishedAt?: string;
}): Promise<PublishResponse> {
    return (await requestJson<PublishResponse>(
        `/admin/publish/${encodeURIComponent(albumId)}`,
        jsonInit('POST', request),
    )).data;
}

export async function getRumSummary(hours: number): Promise<RumSummary> {
    return (await requestJson<RumSummary>(`/admin/rum/summary?hours=${encodeURIComponent(hours)}`)).data;
}
