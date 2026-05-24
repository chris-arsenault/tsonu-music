import { useEffect, useMemo, useState } from 'react';
import {
    Activity,
    BarChart3,
    CloudUpload,
    Eye,
    FileAudio,
    ListMusic,
    LoaderCircle,
    LogOut,
    Music2,
    Plus,
    RefreshCw,
    Rocket,
    Save,
    Search,
    Trash2,
    Upload,
} from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import type { ReleaseType, StableId, Visibility } from '../catalog/media-catalog';
import { getRuntimeConfig } from '../runtime-config';
import { useAuth } from '../use-auth';
import {
    AdminApiError,
    createEncodeJob,
    deleteDraftTrack,
    getDraftAlbum,
    getJob,
    getRumSummary,
    listDraftAlbums,
    listJobs,
    publishAlbum,
    putDraftAlbum,
    putDraftTrack,
    requestUploadUrl,
    uploadMasterFile,
} from './admin-api';
import type {
    DraftAlbum,
    DraftTrack,
    EncodeJob,
    JsonValue,
    ObjectList,
    PublishResponse,
    RumSummary,
} from './admin-types';
import './AdminApp.css';

type BusyState = string | undefined;

interface ArtworkForm {
    assetId: string;
    altText: string;
    path: string;
    url: string;
    width: number;
    height: number;
    mimeType: string;
}

interface PublishCheck {
    label: string;
    ok: boolean;
}

const DEFAULT_ARTWORK_WIDTH = 3000;
const DEFAULT_ARTWORK_HEIGHT = 3000;
const RELEASE_TYPES: ReleaseType[] = ['album', 'ep', 'single', 'demo', 'preview', 'collection'];
const PUBLISH_STATES: DraftAlbum['publishState'][] = ['draft', 'ready', 'published'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: string | undefined): string | undefined {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : undefined;
}

function slugify(value: string): string {
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'untitled';
}

function stableId(prefix: 'album' | 'release' | 'track' | 'asset', value: string): StableId {
    return `${prefix}_${slugify(value).replace(/-/g, '_')}` as StableId;
}

function normalizeAlbumId(value: string): StableId {
    const trimmed = value.trim();
    return (trimmed.startsWith('album_') ? trimmed : stableId('album', trimmed)) as StableId;
}

function albumIdFromKey(key: string): string {
    return key.replace(/^draft\/albums\//, '').replace(/\.json$/, '');
}

function jobIdFromKey(key: string): string {
    return key.replace(/^jobs\//, '').replace(/^draft\/jobs\//, '').replace(/\.json$/, '');
}

function newDraftAlbum(albumId: StableId): DraftAlbum {
    const suffix = albumId.replace(/^album_/, '');
    const slug = suffix.replace(/_/g, '-');
    return {
        schemaVersion: 1,
        entityType: 'draftAlbum',
        albumId,
        releaseId: `release_${suffix}` as StableId,
        slug,
        title: suffix
            .split(/[_-]+/)
            .filter(Boolean)
            .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
            .join(' ') || 'Untitled Album',
        artistName: 'Tsonu',
        releaseType: 'album',
        releaseDate: new Date().toISOString().slice(0, 10),
        publishState: 'draft',
        tracks: [],
    };
}

function nextTrack(album: DraftAlbum): DraftTrack {
    const nextNumber = Math.max(0, ...album.tracks.map((track) => track.trackNumber || 0)) + 1;
    const padded = String(nextNumber).padStart(2, '0');
    const base = `${album.slug}_${padded}`;
    return {
        trackId: stableId('track', base),
        discNumber: 1,
        trackNumber: nextNumber,
        slug: `track-${padded}`,
        title: `Track ${nextNumber}`,
        durationSeconds: 0,
        explicit: false,
        encodeJobIds: [],
    };
}

function sortedTracks(album: DraftAlbum | undefined): DraftTrack[] {
    return [...(album?.tracks ?? [])].sort((left, right) => (
        left.discNumber - right.discNumber || left.trackNumber - right.trackNumber || left.title.localeCompare(right.title)
    ));
}

function replaceTrack(album: DraftAlbum, track: DraftTrack): DraftAlbum {
    const tracks = album.tracks.some((existing) => existing.trackId === track.trackId)
        ? album.tracks.map((existing) => existing.trackId === track.trackId ? track : existing)
        : [...album.tracks, track];
    return {
        ...album,
        tracks,
    };
}

function removeTrack(album: DraftAlbum, trackId: string): DraftAlbum {
    return {
        ...album,
        tracks: album.tracks.filter((track) => track.trackId !== trackId),
    };
}

function latestJobId(track: DraftTrack | undefined): StableId | undefined {
    return track?.encodeJobIds?.[track.encodeJobIds.length - 1];
}

function latestJob(track: DraftTrack | undefined, jobDetails: Record<string, EncodeJob>): EncodeJob | undefined {
    const jobId = latestJobId(track);
    return jobId ? jobDetails[jobId] : undefined;
}

function artworkFormFromValue(value: JsonValue | undefined, album: DraftAlbum | undefined): ArtworkForm {
    const source = isRecord(value) && Array.isArray(value.sources) && isRecord(value.sources[0])
        ? value.sources[0]
        : undefined;

    return {
        assetId: isRecord(value) && typeof value.assetId === 'string'
            ? value.assetId
            : album ? stableId('asset', `${album.slug}_cover`) : 'asset_cover',
        altText: isRecord(value) && typeof value.altText === 'string'
            ? value.altText
            : album ? `${album.title} cover art` : 'Cover art',
        path: source && typeof source.path === 'string' ? source.path : '',
        url: source && typeof source.url === 'string' ? source.url : '',
        width: source && typeof source.width === 'number' ? source.width : DEFAULT_ARTWORK_WIDTH,
        height: source && typeof source.height === 'number' ? source.height : DEFAULT_ARTWORK_HEIGHT,
        mimeType: source && typeof source.mimeType === 'string' ? source.mimeType : 'image/jpeg',
    };
}

function artworkValueFromForm(form: ArtworkForm): JsonValue | undefined {
    if (!optionalText(form.path) && !optionalText(form.url)) {
        return undefined;
    }

    return {
        assetId: optionalText(form.assetId) ?? 'asset_cover',
        altText: optionalText(form.altText) ?? 'Cover art',
        sources: [
            {
                path: optionalText(form.path) ?? optionalText(form.url) ?? '',
                ...(optionalText(form.url) ? { url: optionalText(form.url) } : {}),
                width: Number.isFinite(form.width) && form.width > 0 ? form.width : DEFAULT_ARTWORK_WIDTH,
                height: Number.isFinite(form.height) && form.height > 0 ? form.height : DEFAULT_ARTWORK_HEIGHT,
                mimeType: optionalText(form.mimeType) ?? 'image/jpeg',
            },
        ],
    };
}

function formatLinks(links: DraftAlbum['links']): string {
    return links?.map((link) => `${link.label} | ${link.url}`).join('\n') ?? '';
}

function parseLinks(value: string): DraftAlbum['links'] {
    const links = value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [label, ...urlParts] = line.split('|');
            return {
                label: label.trim(),
                url: urlParts.join('|').trim(),
            };
        })
        .filter((link) => link.label && link.url);

    return links.length > 0 ? links : undefined;
}

function parseTags(value: string): string[] | undefined {
    const tags = value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
    return tags.length > 0 ? tags : undefined;
}

function parseOptionalJson(value: string): JsonValue | undefined {
    const trimmed = value.trim();
    return trimmed ? JSON.parse(trimmed) as JsonValue : undefined;
}

function formatDuration(seconds: number | undefined): string {
    const value = Number.isFinite(seconds) && seconds ? seconds : 0;
    const minutes = Math.floor(value / 60);
    const remainingSeconds = Math.round(value % 60);
    return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function formatPercent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function formatBytes(bytes: number | undefined): string {
    if (!bytes || bytes < 1) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let amount = bytes;
    let unitIndex = 0;
    while (amount >= 1024 && unitIndex < units.length - 1) {
        amount /= 1024;
        unitIndex += 1;
    }
    return `${amount.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function errorMessage(error: unknown): string {
    if (error instanceof AdminApiError) {
        return `${error.status}${error.code ? ` ${error.code}` : ''}: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}

function jobClass(status: EncodeJob['status'] | undefined): string {
    return `admin-status admin-status--${status ?? 'missing'}`;
}

function publishChecks(album: DraftAlbum | undefined, jobDetails: Record<string, EncodeJob>): PublishCheck[] {
    const tracks = sortedTracks(album);
    return [
        {
            label: 'Release date',
            ok: Boolean(album?.releaseDate),
        },
        {
            label: 'Artwork',
            ok: Boolean(album?.artwork),
        },
        {
            label: 'Ready state',
            ok: album?.publishState === 'ready' || album?.publishState === 'published',
        },
        {
            label: 'Tracks',
            ok: tracks.length > 0,
        },
        {
            label: 'Source masters',
            ok: tracks.length > 0 && tracks.every((track) => Boolean(track.sourceMaster?.bucket && track.sourceMaster.key)),
        },
        {
            label: 'Successful encodes',
            ok: tracks.length > 0 && tracks.every((track) => latestJob(track, jobDetails)?.status === 'succeeded'),
        },
    ];
}

export default function AdminApp() {
    const { signOut } = useAuth();
    const location = useLocation();
    const runtimeConfig = useMemo(() => getRuntimeConfig(), []);
    const [albumList, setAlbumList] = useState<ObjectList>();
    const [jobList, setJobList] = useState<ObjectList>();
    const [album, setAlbum] = useState<DraftAlbum>();
    const [albumETag, setAlbumETag] = useState<string>();
    const [albumIdInput, setAlbumIdInput] = useState('album_so-we-sleep');
    const [selectedTrackId, setSelectedTrackId] = useState<string>();
    const [artworkForm, setArtworkForm] = useState<ArtworkForm>(() => artworkFormFromValue(undefined, undefined));
    const [tagsText, setTagsText] = useState('');
    const [linksText, setLinksText] = useState('');
    const [creditsText, setCreditsText] = useState('');
    const [masterFile, setMasterFile] = useState<File>();
    const [includeLossless, setIncludeLossless] = useState(true);
    const [requestedBy, setRequestedBy] = useState('admin-ui');
    const [publishVisibility, setPublishVisibility] = useState<Visibility>('public');
    const [publishedAt, setPublishedAt] = useState('');
    const [publishResult, setPublishResult] = useState<PublishResponse>();
    const [jobDetails, setJobDetails] = useState<Record<string, EncodeJob>>({});
    const [selectedJob, setSelectedJob] = useState<EncodeJob>();
    const [rumHours, setRumHours] = useState(24);
    const [rumSummary, setRumSummary] = useState<RumSummary>();
    const [busy, setBusy] = useState<BusyState>();
    const [notice, setNotice] = useState<string>();
    const [error, setError] = useState<string>();

    const tracks = useMemo(() => sortedTracks(album), [album]);
    const selectedTrack = useMemo(
        () => tracks.find((track) => track.trackId === selectedTrackId) ?? tracks[0],
        [selectedTrackId, tracks],
    );
    const checks = useMemo(() => publishChecks(album, jobDetails), [album, jobDetails]);
    const canPublish = checks.every((check) => check.ok);

    async function withBusy<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
        setBusy(label);
        setError(undefined);
        setNotice(undefined);
        try {
            return await action();
        } catch (caught) {
            setError(errorMessage(caught));
            return undefined;
        } finally {
            setBusy(undefined);
        }
    }

    function syncAlbumForms(nextAlbum: DraftAlbum): void {
        setAlbumIdInput(nextAlbum.albumId);
        setSelectedTrackId(nextAlbum.tracks[0]?.trackId);
        setArtworkForm(artworkFormFromValue(nextAlbum.artwork, nextAlbum));
        setTagsText(nextAlbum.tags?.join(', ') ?? '');
        setLinksText(formatLinks(nextAlbum.links));
        setCreditsText(nextAlbum.credits ? JSON.stringify(nextAlbum.credits, null, 2) : '');
    }

    function prepareAlbumForSave(): DraftAlbum {
        if (!album) {
            throw new Error('No draft album is loaded.');
        }

        return {
            ...album,
            subtitle: optionalText(album.subtitle),
            releaseDate: optionalText(album.releaseDate),
            description: optionalText(album.description),
            copyright: optionalText(album.copyright),
            artwork: artworkValueFromForm(artworkForm),
            credits: parseOptionalJson(creditsText),
            links: parseLinks(linksText),
            tags: parseTags(tagsText),
            tracks: sortedTracks(album),
        };
    }

    function updateAlbumField<K extends keyof DraftAlbum>(key: K, value: DraftAlbum[K]): void {
        setAlbum((current) => current ? { ...current, [key]: value } : current);
    }

    function updateArtworkField<K extends keyof ArtworkForm>(key: K, value: ArtworkForm[K]): void {
        setArtworkForm((current) => ({ ...current, [key]: value }));
    }

    function updateTrack(track: DraftTrack): void {
        setAlbum((current) => current ? replaceTrack(current, track) : current);
        setSelectedTrackId(track.trackId);
    }

    async function refreshAlbumList(): Promise<void> {
        const list = await listDraftAlbums();
        setAlbumList(list);
    }

    async function refreshJobList(): Promise<void> {
        const list = await listJobs();
        setJobList(list);
    }

    async function refreshRum(): Promise<void> {
        const summary = await getRumSummary(rumHours);
        setRumSummary(summary);
    }

    async function refreshKnownJobs(targetAlbum = album): Promise<void> {
        const jobIds = Array.from(new Set(
            (targetAlbum?.tracks ?? []).flatMap((track) => track.encodeJobIds ?? []),
        ));
        if (jobIds.length === 0) {
            return;
        }

        const loaded = await Promise.all(jobIds.map(async (jobId) => {
            try {
                return [jobId, await getJob(jobId)] as const;
            } catch {
                return undefined;
            }
        }));

        setJobDetails((current) => {
            const next = { ...current };
            for (const entry of loaded) {
                if (entry) {
                    next[entry[0]] = entry[1];
                }
            }
            return next;
        });
    }

    async function loadAlbum(albumId: string): Promise<void> {
        const result = await getDraftAlbum(albumId);
        setAlbum(result.data);
        setAlbumETag(result.eTag);
        setPublishResult(undefined);
        syncAlbumForms(result.data);
        await refreshKnownJobs(result.data);
    }

    async function saveAlbum(): Promise<void> {
        const nextAlbum = prepareAlbumForSave();
        const write = await putDraftAlbum(nextAlbum, albumETag);
        setAlbum(nextAlbum);
        setAlbumETag(write.eTag);
        setNotice(`Saved ${write.key}`);
    }

    async function createAlbum(): Promise<void> {
        const nextAlbum = newDraftAlbum(normalizeAlbumId(albumIdInput));
        const write = await putDraftAlbum(nextAlbum);
        setAlbum(nextAlbum);
        setAlbumETag(write.eTag);
        syncAlbumForms(nextAlbum);
        await refreshAlbumList();
        setNotice(`Created ${write.key}`);
    }

    async function addTrack(): Promise<void> {
        if (!album || !albumETag) {
            throw new Error('Load or create an album before adding tracks.');
        }
        const track = nextTrack(album);
        const response = await putDraftTrack(album.albumId, track, albumETag);
        setAlbum(replaceTrack(album, track));
        setAlbumETag(response.write.eTag);
        setSelectedTrackId(track.trackId);
        setNotice(`Added ${track.title}`);
    }

    async function saveTrack(track = selectedTrack): Promise<void> {
        if (!album || !albumETag || !track) {
            throw new Error('Load an album and select a track before saving.');
        }

        const response = await putDraftTrack(album.albumId, track, albumETag);
        setAlbum(replaceTrack(album, track));
        setAlbumETag(response.write.eTag);
        setNotice(`Saved ${track.title}`);
    }

    async function removeSelectedTrack(): Promise<void> {
        if (!album || !albumETag || !selectedTrack) {
            throw new Error('Select a track before deleting.');
        }
        if (!window.confirm(`Delete ${selectedTrack.title}?`)) {
            return;
        }

        const response = await deleteDraftTrack(album.albumId, selectedTrack.trackId, albumETag);
        const nextAlbum = removeTrack(album, selectedTrack.trackId);
        setAlbum(nextAlbum);
        setAlbumETag(response.write.eTag);
        setSelectedTrackId(nextAlbum.tracks[0]?.trackId);
        setNotice(`Deleted ${selectedTrack.title}`);
    }

    async function uploadMaster(): Promise<void> {
        if (!album || !albumETag || !selectedTrack || !masterFile) {
            throw new Error('Select a track and a source master file.');
        }

        const upload = await requestUploadUrl({
            albumId: album.albumId,
            trackId: selectedTrack.trackId,
            filename: masterFile.name,
            contentType: masterFile.type || undefined,
        });
        await uploadMasterFile(upload, masterFile);

        const nextTrackValue = {
            ...selectedTrack,
            sourceMaster: upload.sourceMaster,
        };
        await saveTrack(nextTrackValue);
        setMasterFile(undefined);
        setNotice(`Uploaded ${masterFile.name}`);
    }

    async function startEncode(): Promise<void> {
        if (!album || !selectedTrack) {
            throw new Error('Select a track before starting an encode.');
        }
        if (!selectedTrack.sourceMaster?.bucket || !selectedTrack.sourceMaster.key) {
            throw new Error('Upload a source master before starting an encode.');
        }

        const response = await createEncodeJob({
            albumId: album.albumId,
            trackId: selectedTrack.trackId,
            includeLossless,
            requestedBy: optionalText(requestedBy),
        });
        const nextTrackValue = {
            ...selectedTrack,
            encodeJobIds: [...(selectedTrack.encodeJobIds ?? []), response.job.jobId],
        };
        setJobDetails((current) => ({
            ...current,
            [response.job.jobId]: response.job,
        }));
        setSelectedJob(response.job);
        await saveTrack(nextTrackValue);
        await refreshJobList();
        setNotice(`Queued ${response.job.jobId}`);
    }

    async function inspectJob(jobId: string): Promise<void> {
        const job = await getJob(jobId);
        setJobDetails((current) => ({ ...current, [job.jobId]: job }));
        setSelectedJob(job);
    }

    async function publishCurrentAlbum(): Promise<void> {
        if (!album) {
            throw new Error('Load an album before publishing.');
        }
        if (!canPublish) {
            throw new Error('Resolve publish checks before publishing.');
        }

        const trackJobIds = Object.fromEntries(
            sortedTracks(album)
                .map((track) => [track.trackId, latestJobId(track)])
                .filter((entry): entry is [StableId, StableId] => Boolean(entry[1])),
        );
        const result = await publishAlbum(album.albumId, {
            visibility: publishVisibility,
            trackJobIds,
            publishedAt: optionalText(publishedAt),
        });
        setPublishResult(result);
        const nextAlbum = {
            ...album,
            publishState: 'published' as const,
        };
        setAlbum(nextAlbum);
        setAlbumETag(result.draftWrite.eTag);
        setNotice(`Published ${result.manifestPath}`);
    }

    useEffect(() => {
        void withBusy('Loading admin data', async () => {
            await Promise.all([
                refreshAlbumList(),
                refreshJobList(),
                refreshRum(),
            ]);
        });
    }, []);

    const albumObjects = albumList?.objects ?? [];
    const jobObjects = jobList?.objects ?? [];
    const adminRoute = location.pathname.replace(/^\/admin\/?/, '').split('/')[0] || 'albums';

    return (
        <div className="admin-shell">
            <header className="admin-topbar">
                <div>
                    <p className="admin-kicker">Catalog Operations</p>
                    <h1>Tsonu Streaming Admin</h1>
                </div>
                <div className="admin-topbar__actions">
                    <div className="admin-topbar__meta">
                        <span>{runtimeConfig.adminApiBaseUrl}</span>
                        {busy ? <span className="admin-busy"><LoaderCircle /> {busy}</span> : null}
                    </div>
                    <button className="admin-icon-button" type="button" title="Sign out" onClick={signOut}>
                        <LogOut aria-hidden="true" />
                    </button>
                </div>
            </header>

            <nav className="admin-nav" aria-label="Admin sections">
                <NavLink to="/admin/albums" className={({ isActive }) => isActive || adminRoute === 'albums' ? 'active' : undefined}>
                    <ListMusic aria-hidden="true" /> Albums
                </NavLink>
                <NavLink to="/admin/songs"><Music2 aria-hidden="true" /> Songs</NavLink>
                <NavLink to="/admin/encoding"><FileAudio aria-hidden="true" /> Encoding</NavLink>
                <NavLink to="/admin/publish"><Rocket aria-hidden="true" /> Publish</NavLink>
                <NavLink to="/admin/stats"><BarChart3 aria-hidden="true" /> Stats</NavLink>
            </nav>

            {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
            {notice ? <div className="admin-alert admin-alert--notice">{notice}</div> : null}

            <section className="admin-band admin-toolbar-band">
                <div className="admin-field admin-field--grow">
                    <label htmlFor="album-id">Album ID</label>
                    <input
                        id="album-id"
                        value={albumIdInput}
                        onChange={(event) => setAlbumIdInput(event.currentTarget.value)}
                    />
                </div>
                <button className="admin-button" onClick={() => void withBusy('Loading album', () => loadAlbum(albumIdInput))}>
                    <Search /> Load
                </button>
                <button className="admin-button" onClick={() => void withBusy('Creating album', createAlbum)}>
                    <Plus /> Create
                </button>
                <button className="admin-icon-button" title="Refresh lists" onClick={() => void withBusy('Refreshing lists', async () => {
                    await Promise.all([refreshAlbumList(), refreshJobList()]);
                })}>
                    <RefreshCw />
                </button>
            </section>

            <main className="admin-grid">
                {adminRoute === 'albums' ? (
                <section className="admin-panel admin-panel--album">
                    <div className="admin-panel__header">
                        <div>
                            <p className="admin-kicker">1. Album Metadata</p>
                            <h2>{album?.title ?? 'No Album Loaded'}</h2>
                        </div>
                        <button className="admin-button admin-button--primary" disabled={!album} onClick={() => void withBusy('Saving album', saveAlbum)}>
                            <Save /> Save Album
                        </button>
                    </div>

                    <div className="admin-form-grid">
                        <div className="admin-field">
                            <label>Title</label>
                            <input value={album?.title ?? ''} onChange={(event) => updateAlbumField('title', event.currentTarget.value)} />
                        </div>
                        <div className="admin-field">
                            <label>Slug</label>
                            <input value={album?.slug ?? ''} onChange={(event) => updateAlbumField('slug', slugify(event.currentTarget.value))} />
                        </div>
                        <div className="admin-field">
                            <label>Release ID</label>
                            <input value={album?.releaseId ?? ''} onChange={(event) => updateAlbumField('releaseId', event.currentTarget.value as StableId)} />
                        </div>
                        <div className="admin-field">
                            <label>Artist</label>
                            <input value={album?.artistName ?? ''} onChange={(event) => updateAlbumField('artistName', event.currentTarget.value)} />
                        </div>
                        <div className="admin-field">
                            <label>Release Type</label>
                            <select value={album?.releaseType ?? 'album'} onChange={(event) => updateAlbumField('releaseType', event.currentTarget.value as ReleaseType)}>
                                {RELEASE_TYPES.map((releaseType) => <option key={releaseType} value={releaseType}>{releaseType}</option>)}
                            </select>
                        </div>
                        <div className="admin-field">
                            <label>Release Date</label>
                            <input type="date" value={album?.releaseDate ?? ''} onChange={(event) => updateAlbumField('releaseDate', event.currentTarget.value)} />
                        </div>
                        <div className="admin-field">
                            <label>Publish State</label>
                            <select value={album?.publishState ?? 'draft'} onChange={(event) => updateAlbumField('publishState', event.currentTarget.value as DraftAlbum['publishState'])}>
                                {PUBLISH_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
                            </select>
                        </div>
                        <div className="admin-field">
                            <label>Subtitle</label>
                            <input value={album?.subtitle ?? ''} onChange={(event) => updateAlbumField('subtitle', event.currentTarget.value)} />
                        </div>
                        <div className="admin-field admin-field--wide">
                            <label>Description</label>
                            <textarea rows={4} value={album?.description ?? ''} onChange={(event) => updateAlbumField('description', event.currentTarget.value)} />
                        </div>
                        <div className="admin-field">
                            <label>Tags</label>
                            <input value={tagsText} onChange={(event) => setTagsText(event.currentTarget.value)} />
                        </div>
                        <div className="admin-field">
                            <label>Copyright</label>
                            <input value={album?.copyright ?? ''} onChange={(event) => updateAlbumField('copyright', event.currentTarget.value)} />
                        </div>
                        <div className="admin-field admin-field--wide">
                            <label>Links</label>
                            <textarea rows={3} value={linksText} onChange={(event) => setLinksText(event.currentTarget.value)} />
                        </div>
                    </div>

                    <div className="admin-subgrid">
                        <div className="admin-form-grid">
                            <div className="admin-field">
                                <label>Artwork Asset ID</label>
                                <input value={artworkForm.assetId} onChange={(event) => updateArtworkField('assetId', event.currentTarget.value)} />
                            </div>
                            <div className="admin-field">
                                <label>Artwork Path</label>
                                <input value={artworkForm.path} onChange={(event) => updateArtworkField('path', event.currentTarget.value)} />
                            </div>
                            <div className="admin-field">
                                <label>Artwork URL</label>
                                <input value={artworkForm.url} onChange={(event) => updateArtworkField('url', event.currentTarget.value)} />
                            </div>
                            <div className="admin-field">
                                <label>Alt Text</label>
                                <input value={artworkForm.altText} onChange={(event) => updateArtworkField('altText', event.currentTarget.value)} />
                            </div>
                            <div className="admin-field">
                                <label>Width</label>
                                <input type="number" value={artworkForm.width} onChange={(event) => updateArtworkField('width', Number(event.currentTarget.value))} />
                            </div>
                            <div className="admin-field">
                                <label>Height</label>
                                <input type="number" value={artworkForm.height} onChange={(event) => updateArtworkField('height', Number(event.currentTarget.value))} />
                            </div>
                        </div>
                        <div className="admin-field">
                            <label>Credits JSON</label>
                            <textarea rows={8} value={creditsText} onChange={(event) => setCreditsText(event.currentTarget.value)} />
                        </div>
                    </div>
                </section>
                ) : null}

                {adminRoute === 'songs' ? (
                <section className="admin-panel">
                    <div className="admin-panel__header">
                        <div>
                            <p className="admin-kicker">2. Tracks And Ordering</p>
                            <h2>{tracks.length} Tracks</h2>
                        </div>
                        <button className="admin-button" disabled={!album} onClick={() => void withBusy('Adding track', addTrack)}>
                            <Plus /> Track
                        </button>
                    </div>

                    <div className="admin-track-list">
                        {tracks.map((track) => {
                            const job = latestJob(track, jobDetails);
                            return (
                                <button
                                    key={track.trackId}
                                    className={`admin-track-row ${selectedTrack?.trackId === track.trackId ? 'admin-track-row--active' : ''}`}
                                    onClick={() => setSelectedTrackId(track.trackId)}
                                >
                                    <span>{track.discNumber}.{track.trackNumber}</span>
                                    <strong>{track.title}</strong>
                                    <span>{formatDuration(track.durationSeconds)}</span>
                                    <span className={jobClass(job?.status)}>{job?.status ?? 'no job'}</span>
                                </button>
                            );
                        })}
                    </div>

                    {selectedTrack ? (
                        <div className="admin-form-grid admin-form-grid--compact">
                            <div className="admin-field">
                                <label>Track ID</label>
                                <input value={selectedTrack.trackId} onChange={(event) => updateTrack({ ...selectedTrack, trackId: event.currentTarget.value as StableId })} />
                            </div>
                            <div className="admin-field">
                                <label>Title</label>
                                <input value={selectedTrack.title} onChange={(event) => updateTrack({ ...selectedTrack, title: event.currentTarget.value })} />
                            </div>
                            <div className="admin-field">
                                <label>Slug</label>
                                <input value={selectedTrack.slug} onChange={(event) => updateTrack({ ...selectedTrack, slug: slugify(event.currentTarget.value) })} />
                            </div>
                            <div className="admin-field">
                                <label>Disc</label>
                                <input type="number" value={selectedTrack.discNumber} onChange={(event) => updateTrack({ ...selectedTrack, discNumber: Number(event.currentTarget.value) })} />
                            </div>
                            <div className="admin-field">
                                <label>Track</label>
                                <input type="number" value={selectedTrack.trackNumber} onChange={(event) => updateTrack({ ...selectedTrack, trackNumber: Number(event.currentTarget.value) })} />
                            </div>
                            <div className="admin-field">
                                <label>Duration Seconds</label>
                                <input type="number" value={selectedTrack.durationSeconds} onChange={(event) => updateTrack({ ...selectedTrack, durationSeconds: Number(event.currentTarget.value) })} />
                            </div>
                            <div className="admin-field">
                                <label>ISRC</label>
                                <input value={selectedTrack.isrc ?? ''} onChange={(event) => updateTrack({ ...selectedTrack, isrc: event.currentTarget.value })} />
                            </div>
                            <label className="admin-check">
                                <input type="checkbox" checked={selectedTrack.explicit} onChange={(event) => updateTrack({ ...selectedTrack, explicit: event.currentTarget.checked })} />
                                Explicit
                            </label>
                            <div className="admin-field admin-field--wide">
                                <label>Description</label>
                                <textarea rows={3} value={selectedTrack.description ?? ''} onChange={(event) => updateTrack({ ...selectedTrack, description: event.currentTarget.value })} />
                            </div>
                            <div className="admin-button-row admin-field--wide">
                                <button className="admin-button admin-button--primary" onClick={() => void withBusy('Saving track', () => saveTrack())}>
                                    <Save /> Save Track
                                </button>
                                <button className="admin-button admin-button--danger" onClick={() => void withBusy('Deleting track', removeSelectedTrack)}>
                                    <Trash2 /> Delete
                                </button>
                            </div>
                        </div>
                    ) : null}
                </section>
                ) : null}

                {adminRoute === 'encoding' ? (
                <section className="admin-panel">
                    <div className="admin-panel__header">
                        <div>
                            <p className="admin-kicker">3. Masters And Encoding</p>
                            <h2>{selectedTrack?.title ?? 'Select A Track'}</h2>
                        </div>
                        <FileAudio />
                    </div>

                    <div className="admin-source-master">
                        <div>
                            <span>Source Master</span>
                            <strong>{selectedTrack?.sourceMaster?.key ?? 'none'}</strong>
                        </div>
                        <div>
                            <span>Latest Job</span>
                            <strong>{latestJobId(selectedTrack) ?? 'none'}</strong>
                        </div>
                    </div>

                    <div className="admin-form-grid admin-form-grid--compact">
                        <div className="admin-field admin-field--wide">
                            <label>Lossless Master</label>
                            <input type="file" accept=".wav,.aif,.aiff,.flac,audio/wav,audio/flac" onChange={(event) => setMasterFile(event.currentTarget.files?.[0])} />
                        </div>
                        <div className="admin-button-row admin-field--wide">
                            <button className="admin-button" disabled={!selectedTrack || !masterFile} onClick={() => void withBusy('Uploading master', uploadMaster)}>
                                <Upload /> Upload Master
                            </button>
                        </div>
                        <label className="admin-check">
                            <input type="checkbox" checked={includeLossless} onChange={(event) => setIncludeLossless(event.currentTarget.checked)} />
                            Include FLAC download
                        </label>
                        <div className="admin-field">
                            <label>Requested By</label>
                            <input value={requestedBy} onChange={(event) => setRequestedBy(event.currentTarget.value)} />
                        </div>
                        <div className="admin-button-row admin-field--wide">
                            <button className="admin-button admin-button--primary" disabled={!selectedTrack?.sourceMaster} onClick={() => void withBusy('Starting encode', startEncode)}>
                                <CloudUpload /> Start Encode
                            </button>
                            <button className="admin-button" disabled={!album} onClick={() => void withBusy('Refreshing track jobs', () => refreshKnownJobs())}>
                                <RefreshCw /> Status
                            </button>
                        </div>
                    </div>
                </section>
                ) : null}

                {adminRoute === 'encoding' ? (
                <section className="admin-panel">
                    <div className="admin-panel__header">
                        <div>
                            <p className="admin-kicker">4. Encode Status</p>
                            <h2>Jobs</h2>
                        </div>
                        <button className="admin-icon-button" title="Refresh jobs" onClick={() => void withBusy('Refreshing jobs', async () => {
                            await refreshJobList();
                            await refreshKnownJobs();
                        })}>
                            <RefreshCw />
                        </button>
                    </div>

                    <div className="admin-job-list">
                        {jobObjects.slice(0, 12).map((object) => {
                            const jobId = jobIdFromKey(object.key);
                            const job = jobDetails[jobId];
                            return (
                                <button key={object.key} className="admin-job-row" onClick={() => void withBusy('Inspecting job', () => inspectJob(jobId))}>
                                    <span className={jobClass(job?.status)}>{job?.status ?? 'load'}</span>
                                    <strong>{jobId}</strong>
                                    <span>{formatBytes(object.sizeBytes)}</span>
                                </button>
                            );
                        })}
                    </div>

                    {selectedJob ? (
                        <pre className="admin-json-preview">{JSON.stringify(selectedJob, null, 2)}</pre>
                    ) : null}
                </section>
                ) : null}

                {adminRoute === 'songs' || adminRoute === 'publish' ? (
                <section className="admin-panel admin-panel--preview">
                    <div className="admin-panel__header">
                        <div>
                            <p className="admin-kicker">5. Draft Player Preview</p>
                            <h2>{album?.title ?? 'No Draft'}</h2>
                        </div>
                        <Eye />
                    </div>

                    <div className="admin-preview-player">
                        <div className="admin-preview-artwork">
                            {artworkForm.url || artworkForm.path ? <img src={artworkForm.url || `${runtimeConfig.mediaBaseUrl}/${artworkForm.path}`} alt={artworkForm.altText} /> : <ListMusic />}
                        </div>
                        <div className="admin-preview-main">
                            <p>{album?.artistName ?? 'Tsonu'}</p>
                            <h3>{album?.title ?? 'Load an album'}</h3>
                            <div className="admin-preview-tracklist">
                                {tracks.map((track) => (
                                    <button key={track.trackId} onClick={() => setSelectedTrackId(track.trackId)} className={selectedTrack?.trackId === track.trackId ? 'is-active' : ''}>
                                        <span>{track.trackNumber}</span>
                                        <strong>{track.title}</strong>
                                        <span>{formatDuration(track.durationSeconds)}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="admin-checklist">
                        {checks.map((check) => (
                            <span key={check.label} className={check.ok ? 'is-ok' : 'is-missing'}>{check.label}</span>
                        ))}
                    </div>
                </section>
                ) : null}

                {adminRoute === 'publish' ? (
                <section className="admin-panel">
                    <div className="admin-panel__header">
                        <div>
                            <p className="admin-kicker">6. Publish Metadata</p>
                            <h2>{canPublish ? 'Ready' : 'Blocked'}</h2>
                        </div>
                        <Rocket />
                    </div>

                    <div className="admin-form-grid admin-form-grid--compact">
                        <div className="admin-field">
                            <label>Visibility</label>
                            <select value={publishVisibility} onChange={(event) => setPublishVisibility(event.currentTarget.value as Visibility)}>
                                <option value="public">public</option>
                                <option value="unlisted">unlisted</option>
                            </select>
                        </div>
                        <div className="admin-field">
                            <label>Published At</label>
                            <input value={publishedAt} onChange={(event) => setPublishedAt(event.currentTarget.value)} />
                        </div>
                        <div className="admin-button-row admin-field--wide">
                            <button className="admin-button admin-button--primary" disabled={!album || !canPublish} onClick={() => void withBusy('Publishing album', publishCurrentAlbum)}>
                                <Rocket /> Publish
                            </button>
                        </div>
                    </div>

                    {publishResult ? (
                        <div className="admin-publish-result">
                            <strong>{publishResult.manifestPath}</strong>
                            <span>{publishResult.copiedObjectCount} objects copied</span>
                            <span>{publishResult.invalidation.invalidationId ?? 'invalidation requested'}</span>
                        </div>
                    ) : null}
                </section>
                ) : null}

                {adminRoute === 'albums' ? (
                <section className="admin-panel">
                    <div className="admin-panel__header">
                        <div>
                            <p className="admin-kicker">7. Draft Albums</p>
                            <h2>Albums</h2>
                        </div>
                        <ListMusic />
                    </div>

                    <div className="admin-object-list">
                        {albumObjects.map((object) => {
                            const albumId = albumIdFromKey(object.key);
                            return (
                                <button key={object.key} onClick={() => void withBusy('Loading album', () => loadAlbum(albumId))}>
                                    <strong>{albumId}</strong>
                                    <span>{object.eTag ?? 'no etag'}</span>
                                </button>
                            );
                        })}
                    </div>
                </section>
                ) : null}

                {adminRoute === 'stats' ? (
                <section className="admin-panel admin-panel--rum">
                    <div className="admin-panel__header">
                        <div>
                            <p className="admin-kicker">RUM Dashboard</p>
                            <h2>Playback Stats</h2>
                        </div>
                        <BarChart3 />
                    </div>

                    <div className="admin-rum-controls">
                        <div className="admin-field">
                            <label>Hours</label>
                            <input type="number" min={1} max={720} value={rumHours} onChange={(event) => setRumHours(Number(event.currentTarget.value))} />
                        </div>
                        <button className="admin-button" onClick={() => void withBusy('Loading RUM stats', refreshRum)}>
                            <Activity /> Refresh Stats
                        </button>
                    </div>

                    {rumSummary ? (
                        <>
                            <div className="admin-metrics">
                                <div><span>Events</span><strong>{rumSummary.totalEvents}</strong></div>
                                <div><span>Sessions</span><strong>{rumSummary.uniquePlaybackSessions}</strong></div>
                                <div><span>Starts</span><strong>{rumSummary.playStarts}</strong></div>
                                <div><span>Completes</span><strong>{formatPercent(rumSummary.playCompletionRate)}</strong></div>
                                <div><span>Errors</span><strong>{rumSummary.playerErrors}</strong></div>
                            </div>

                            <div className="admin-rum-grid">
                                <div>
                                    <h3>Events</h3>
                                    {rumSummary.events.map((event) => (
                                        <div className="admin-stat-row" key={event.eventType}>
                                            <span>{event.eventType}</span>
                                            <strong>{event.count}</strong>
                                        </div>
                                    ))}
                                </div>
                                <div>
                                    <h3>Top Tracks</h3>
                                    {rumSummary.tracks.slice(0, 8).map((track) => (
                                        <div className="admin-stat-row" key={`${track.albumId}/${track.trackId}`}>
                                            <span>{track.trackId}</span>
                                            <strong>{track.playStarts}</strong>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {rumSummary.recentErrors.length > 0 ? (
                                <div className="admin-rum-errors">
                                    <h3>Recent Errors</h3>
                                    {rumSummary.recentErrors.map((item, index) => (
                                        <div key={`${item.timestamp}-${index}`}>
                                            <strong>{item.errorName ?? 'Error'}</strong>
                                            <span>{item.trackId ?? item.albumId ?? 'unknown'}</span>
                                            <p>{item.errorMessage}</p>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </>
                    ) : null}
                </section>
                ) : null}
            </main>
        </div>
    );
}
