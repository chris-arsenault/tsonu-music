import { getIdToken } from '../auth';
import { getRuntimeConfig } from '../runtime-config';
import type {
    ArtworkUploadUrlRequest,
    ArtworkUploadUrlResponse,
    DraftRelease,
    DraftSong,
    EncodeJob,
    EncodeJobCreateResponse,
    MaintenanceCleanupRequest,
    MaintenanceCleanupResponse,
    MaintenanceReport,
    ObjectList,
    PublishResponse,
    RumSummary,
    UploadUrlRequest,
    UploadUrlResponse,
    WriteResult,
} from './admin-types';

interface ApiErrorBody {
    error?: {
        code?: string;
        message?: string;
    };
    message?: string;
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
        ?? parsed?.message
        ?? (response.statusText || `Request failed with status ${response.status}`);
    return new AdminApiError(message, response.status, code);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    return text.trim() ? JSON.parse(text) as T : undefined as T;
}

async function requestEmpty(path: string, init: RequestInit): Promise<void> {
    const response = await requestJson<void>(path, init);
    if (response !== undefined) {
        throw new AdminApiError('Expected an empty response.', 502, 'unexpected_response_body');
    }
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
    return requestJson<ObjectList>('/admin/songs');
}

export async function getDraftSong(songId: string): Promise<DraftSong> {
    return requestJson<DraftSong>(`/admin/songs/${encodeURIComponent(songId)}`);
}

export async function createDraftSong(song: DraftSong): Promise<WriteResult> {
    return requestJson<WriteResult>(
        '/admin/songs',
        jsonInit('POST', song),
    );
}

export async function updateDraftSong(song: DraftSong): Promise<WriteResult> {
    return requestJson<WriteResult>(
        `/admin/songs/${encodeURIComponent(song.songId)}`,
        jsonInit('PUT', song),
    );
}

export async function deleteDraftSong(songId: string): Promise<void> {
    await requestEmpty(`/admin/songs/${encodeURIComponent(songId)}`, { method: 'DELETE' });
}

export async function listDraftReleases(): Promise<ObjectList> {
    return requestJson<ObjectList>('/admin/releases');
}

export async function getDraftRelease(releaseId: string): Promise<DraftRelease> {
    return requestJson<DraftRelease>(`/admin/releases/${encodeURIComponent(releaseId)}`);
}

export async function createDraftRelease(release: DraftRelease): Promise<WriteResult> {
    return requestJson<WriteResult>(
        '/admin/releases',
        jsonInit('POST', release),
    );
}

export async function updateDraftRelease(release: DraftRelease): Promise<WriteResult> {
    return requestJson<WriteResult>(
        `/admin/releases/${encodeURIComponent(release.releaseId)}`,
        jsonInit('PUT', release),
    );
}

export async function deleteDraftRelease(releaseId: string): Promise<void> {
    await requestEmpty(`/admin/releases/${encodeURIComponent(releaseId)}`, { method: 'DELETE' });
}

export async function listJobs(): Promise<ObjectList> {
    return requestJson<ObjectList>('/admin/jobs');
}

export async function getJob(jobId: string): Promise<EncodeJob> {
    return requestJson<EncodeJob>(`/admin/jobs/${encodeURIComponent(jobId)}`);
}

export async function requestUploadUrl(request: UploadUrlRequest): Promise<UploadUrlResponse> {
    return requestJson<UploadUrlResponse>('/admin/upload-url', jsonInit('POST', request));
}

export async function requestArtworkUploadUrl(request: ArtworkUploadUrlRequest): Promise<ArtworkUploadUrlResponse> {
    return requestJson<ArtworkUploadUrlResponse>('/admin/artwork-upload-url', jsonInit('POST', request));
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
    return requestJson<EncodeJobCreateResponse>('/admin/encode-jobs', jsonInit('POST', request));
}

export async function publishRelease(releaseId: string, request: {
    visibility?: 'public' | 'unlisted';
    publishedAt?: string;
}): Promise<PublishResponse> {
    return requestJson<PublishResponse>(
        `/admin/publish/${encodeURIComponent(releaseId)}`,
        jsonInit('POST', request),
    );
}

export async function getMaintenanceReport(): Promise<MaintenanceReport> {
    return requestJson<MaintenanceReport>('/admin/maintenance/stale');
}

export async function cleanupMaintenance(request: MaintenanceCleanupRequest): Promise<MaintenanceCleanupResponse> {
    return requestJson<MaintenanceCleanupResponse>(
        '/admin/maintenance/stale',
        jsonInit('POST', request),
    );
}

export async function getRumSummary(hours: number): Promise<RumSummary> {
    return requestJson<RumSummary>(`/admin/rum/summary?hours=${encodeURIComponent(hours)}`);
}
