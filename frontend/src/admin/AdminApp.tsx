import { useEffect, useMemo, useState } from 'react';
import {
    Activity,
    BarChart3,
    CloudUpload,
    Disc3,
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
    Upload,
} from 'lucide-react';
import type { ReleaseKind, ReleaseStatus, StableId, Visibility } from '../catalog/media-catalog';
import { getRuntimeConfig } from '../runtime-config';
import { useAuth } from '../use-auth';
import { handleInternalLink, useCurrentRoute } from '../music/routes';
import {
    AdminApiError,
    createEncodeJob,
    getDraftRelease,
    getDraftSong,
    getJob,
    getRumSummary,
    listDraftReleases,
    listDraftSongs,
    listJobs,
    publishRelease,
    putDraftRelease,
    putDraftSong,
    requestUploadUrl,
    uploadMasterFile,
} from './admin-api';
import type {
    DraftRecording,
    DraftRelease,
    DraftReleaseTrack,
    DraftSong,
    EncodeJob,
    JsonValue,
    ObjectList,
    PublishResponse,
    RumSummary,
} from './admin-types';
import './AdminApp.css';

type BusyState = string | undefined;
type AdminSection = typeof ADMIN_ROUTES[number];

interface ArtworkForm {
    assetId: string;
    altText: string;
    path: string;
    url: string;
    width: number;
    height: number;
    mimeType: string;
}

const ADMIN_ROUTES = ['releases', 'songs', 'encoding', 'publish', 'stats'] as const;
const RELEASE_KINDS: ReleaseKind[] = ['album', 'ep', 'single', 'demo', 'preview', 'collection', 'prerelease'];
const RELEASE_STATUSES: ReleaseStatus[] = ['official', 'demo', 'promo', 'prerelease', 'bootleg'];
const PUBLISH_STATES: DraftRelease['publishState'][] = ['draft', 'ready', 'published', 'withdrawn'];
const VERSION_TYPES: DraftRecording['versionType'][] = ['studio_master', 'album_master', 'single_master', 'demo', 'preview', 'live', 'alternate', 'remaster'];
const DEFAULT_ARTWORK_WIDTH = 3000;
const DEFAULT_ARTWORK_HEIGHT = 3000;

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

function stableId(prefix: 'song' | 'recording' | 'release' | 'track' | 'asset', value: string): StableId {
    return `${prefix}_${slugify(value).replace(/-/g, '_')}` as StableId;
}

function normalizeId(prefix: 'song' | 'release', value: string): StableId {
    const trimmed = value.trim();
    return (trimmed.startsWith(`${prefix}_`) ? trimmed : stableId(prefix, trimmed)) as StableId;
}

function songIdFromKey(key: string): string {
    return key.replace(/^draft\/songs\//, '').replace(/\.json$/, '');
}

function releaseIdFromKey(key: string): string {
    return key.replace(/^draft\/releases\//, '').replace(/\.json$/, '');
}

function jobIdFromKey(key: string): string {
    return key.replace(/^jobs\//, '').replace(/^draft\/jobs\//, '').replace(/\.json$/, '');
}

function adminSectionFromRoute(route: string): AdminSection {
    const pathname = route.split(/[?#]/)[0] || '/admin';
    const section = pathname.replace(/^\/admin\/?/, '').split('/')[0];
    return ADMIN_ROUTES.includes(section as AdminSection) ? section as AdminSection : 'releases';
}

function titleFromId(id: string, prefix: string): string {
    return id
        .replace(new RegExp(`^${prefix}_`), '')
        .split(/[_-]+/)
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(' ') || 'Untitled';
}

function newDraftSong(songId: StableId): DraftSong {
    const suffix = songId.replace(/^song_/, '');
    return {
        schemaVersion: 1,
        entityType: 'draftSong',
        songId,
        slug: suffix.replace(/_/g, '-'),
        title: titleFromId(songId, 'song'),
        artistName: 'Tsonu',
        recordings: [],
        updatedAt: new Date().toISOString(),
    };
}

function newRecording(song: DraftSong): DraftRecording {
    const number = song.recordings.length + 1;
    const base = `${song.slug}_${number === 1 ? 'demo' : `version_${number}`}`;
    return {
        recordingId: stableId('recording', base),
        slug: slugify(base),
        title: `${song.title} ${number === 1 ? 'Demo' : `Version ${number}`}`,
        versionTitle: number === 1 ? 'Demo' : `Version ${number}`,
        versionType: number === 1 ? 'demo' : 'alternate',
        explicit: false,
        encodeJobIds: [],
    };
}

function newDraftRelease(releaseId: StableId): DraftRelease {
    const suffix = releaseId.replace(/^release_/, '');
    return {
        schemaVersion: 1,
        entityType: 'draftRelease',
        releaseId,
        slug: suffix.replace(/_/g, '-'),
        title: titleFromId(releaseId, 'release'),
        artistName: 'Tsonu',
        releaseKind: 'demo',
        releaseStatus: 'demo',
        publishState: 'draft',
        releaseDate: new Date().toISOString().slice(0, 10),
        tracks: [],
        updatedAt: new Date().toISOString(),
    };
}

function nextReleaseTrack(release: DraftRelease, song: DraftSong, recording: DraftRecording): DraftReleaseTrack {
    const nextNumber = Math.max(0, ...release.tracks.map((track) => track.trackNumber || 0)) + 1;
    const base = `${release.slug}_${String(nextNumber).padStart(2, '0')}_${song.slug}`;
    return {
        trackId: stableId('track', base),
        songId: song.songId,
        recordingId: recording.recordingId,
        discNumber: 1,
        trackNumber: nextNumber,
        slug: song.slug,
        title: song.title,
        explicit: recording.explicit,
        isrc: recording.isrc,
    };
}

function sortedReleaseTracks(release: DraftRelease | undefined): DraftReleaseTrack[] {
    return [...(release?.tracks ?? [])].sort((left, right) => (
        left.discNumber - right.discNumber || left.trackNumber - right.trackNumber || left.title.localeCompare(right.title)
    ));
}

function latestJobId(recording: DraftRecording | undefined): StableId | undefined {
    return recording?.encodeJobIds?.[recording.encodeJobIds.length - 1];
}

function latestJob(recording: DraftRecording | undefined, jobDetails: Record<string, EncodeJob>): EncodeJob | undefined {
    const jobId = latestJobId(recording);
    return jobId ? jobDetails[jobId] : undefined;
}

function artworkFormFromValue(value: JsonValue | undefined, release: DraftRelease | undefined): ArtworkForm {
    const source = isRecord(value) && Array.isArray(value.sources) && isRecord(value.sources[0])
        ? value.sources[0]
        : undefined;

    return {
        assetId: isRecord(value) && typeof value.assetId === 'string'
            ? value.assetId
            : release ? stableId('asset', `${release.slug}_cover`) : 'asset_cover',
        altText: isRecord(value) && typeof value.altText === 'string'
            ? value.altText
            : release ? `${release.title} cover art` : 'Cover art',
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

function formatLinks(links: DraftRelease['links']): string {
    return links?.map((link) => `${link.label} | ${link.url}`).join('\n') ?? '';
}

function parseLinks(value: string): DraftRelease['links'] {
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

export default function AdminApp() {
    const { signOut } = useAuth();
    const route = useCurrentRoute();
    const runtimeConfig = useMemo(() => getRuntimeConfig(), []);
    const [songList, setSongList] = useState<ObjectList>();
    const [releaseList, setReleaseList] = useState<ObjectList>();
    const [jobList, setJobList] = useState<ObjectList>();
    const [song, setSong] = useState<DraftSong>();
    const [songETag, setSongETag] = useState<string>();
    const [songCache, setSongCache] = useState<Record<string, DraftSong>>({});
    const [release, setRelease] = useState<DraftRelease>();
    const [releaseETag, setReleaseETag] = useState<string>();
    const [songIdInput, setSongIdInput] = useState('song_untitled');
    const [releaseIdInput, setReleaseIdInput] = useState('release_demos');
    const [selectedRecordingId, setSelectedRecordingId] = useState<string>();
    const [selectedReleaseTrackId, setSelectedReleaseTrackId] = useState<string>();
    const [artworkForm, setArtworkForm] = useState<ArtworkForm>(() => artworkFormFromValue(undefined, undefined));
    const [releaseTagsText, setReleaseTagsText] = useState('');
    const [songTagsText, setSongTagsText] = useState('');
    const [linksText, setLinksText] = useState('');
    const [releaseCreditsText, setReleaseCreditsText] = useState('');
    const [songCreditsText, setSongCreditsText] = useState('');
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

    const recordings = song?.recordings ?? [];
    const selectedRecording = recordings.find((recording) => recording.recordingId === selectedRecordingId) ?? recordings[0];
    const releaseTracks = useMemo(() => sortedReleaseTracks(release), [release]);
    const selectedReleaseTrack = releaseTracks.find((track) => track.trackId === selectedReleaseTrackId) ?? releaseTracks[0];
    const adminRoute = adminSectionFromRoute(route);
    const songObjects = songList?.objects ?? [];
    const releaseObjects = releaseList?.objects ?? [];
    const jobObjects = jobList?.objects ?? [];
    const currentRecordingJob = latestJob(selectedRecording, jobDetails);
    const publishChecks = [
        { label: 'Release date', ok: Boolean(release?.releaseDate) },
        { label: 'Artwork', ok: Boolean(release?.artwork) },
        { label: 'Ready state', ok: release?.publishState === 'ready' || release?.publishState === 'published' },
        { label: 'Tracks', ok: releaseTracks.length > 0 },
        {
            label: 'Successful encodes',
            ok: releaseTracks.length > 0 && releaseTracks.every((track) => {
                const sourceSong = songCache[track.songId];
                const recording = sourceSong?.recordings.find((candidate) => candidate.recordingId === track.recordingId);
                return latestJob(recording, jobDetails)?.status === 'succeeded';
            }),
        },
    ];
    const canPublish = publishChecks.every((check) => check.ok);

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

    function cacheSong(nextSong: DraftSong): void {
        setSongCache((current) => ({ ...current, [nextSong.songId]: nextSong }));
    }

    function syncSongForms(nextSong: DraftSong): void {
        setSongIdInput(nextSong.songId);
        setSelectedRecordingId(nextSong.recordings[0]?.recordingId);
        setSongTagsText(nextSong.tags?.join(', ') ?? '');
        setSongCreditsText(nextSong.credits ? JSON.stringify(nextSong.credits, null, 2) : '');
        cacheSong(nextSong);
    }

    function syncReleaseForms(nextRelease: DraftRelease): void {
        setReleaseIdInput(nextRelease.releaseId);
        setSelectedReleaseTrackId(nextRelease.tracks[0]?.trackId);
        setArtworkForm(artworkFormFromValue(nextRelease.artwork, nextRelease));
        setReleaseTagsText(nextRelease.tags?.join(', ') ?? '');
        setLinksText(formatLinks(nextRelease.links));
        setReleaseCreditsText(nextRelease.credits ? JSON.stringify(nextRelease.credits, null, 2) : '');
    }

    function prepareSongForSave(): DraftSong {
        if (!song) {
            throw new Error('No draft song is loaded.');
        }

        return {
            ...song,
            description: optionalText(song.description),
            lyrics: optionalText(song.lyrics),
            credits: parseOptionalJson(songCreditsText),
            tags: parseTags(songTagsText),
            updatedAt: new Date().toISOString(),
        };
    }

    function prepareReleaseForSave(): DraftRelease {
        if (!release) {
            throw new Error('No draft release is loaded.');
        }

        return {
            ...release,
            subtitle: optionalText(release.subtitle),
            releaseDate: optionalText(release.releaseDate),
            description: optionalText(release.description),
            copyright: optionalText(release.copyright),
            artwork: artworkValueFromForm(artworkForm),
            credits: parseOptionalJson(releaseCreditsText),
            links: parseLinks(linksText),
            tags: parseTags(releaseTagsText),
            tracks: sortedReleaseTracks(release),
            updatedAt: new Date().toISOString(),
        };
    }

    function updateSongField<K extends keyof DraftSong>(key: K, value: DraftSong[K]): void {
        setSong((current) => current ? { ...current, [key]: value } : current);
    }

    function updateReleaseField<K extends keyof DraftRelease>(key: K, value: DraftRelease[K]): void {
        setRelease((current) => current ? { ...current, [key]: value } : current);
    }

    function updateRecording(recording: DraftRecording): void {
        setSong((current) => {
            if (!current) {
                return current;
            }
            const next = {
                ...current,
                recordings: current.recordings.some((existing) => existing.recordingId === recording.recordingId)
                    ? current.recordings.map((existing) => existing.recordingId === recording.recordingId ? recording : existing)
                    : [...current.recordings, recording],
            };
            cacheSong(next);
            return next;
        });
        setSelectedRecordingId(recording.recordingId);
    }

    function updateReleaseTrack(track: DraftReleaseTrack): void {
        setRelease((current) => {
            if (!current) {
                return current;
            }
            return {
                ...current,
                tracks: current.tracks.some((existing) => existing.trackId === track.trackId)
                    ? current.tracks.map((existing) => existing.trackId === track.trackId ? track : existing)
                    : [...current.tracks, track],
            };
        });
        setSelectedReleaseTrackId(track.trackId);
    }

    async function refreshLists(): Promise<void> {
        const [songs, releases, jobs] = await Promise.all([
            listDraftSongs(),
            listDraftReleases(),
            listJobs(),
        ]);
        setSongList(songs);
        setReleaseList(releases);
        setJobList(jobs);
    }

    async function refreshRum(): Promise<void> {
        setRumSummary(await getRumSummary(rumHours));
    }

    async function refreshKnownJobs(targetSong = song): Promise<void> {
        const jobIds = Array.from(new Set(
            (targetSong?.recordings ?? []).flatMap((recording) => recording.encodeJobIds ?? []),
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

    async function loadSong(songId: string): Promise<DraftSong> {
        const result = await getDraftSong(songId);
        setSong(result.data);
        setSongETag(result.eTag);
        syncSongForms(result.data);
        await refreshKnownJobs(result.data);
        return result.data;
    }

    async function loadRelease(releaseId: string): Promise<void> {
        const result = await getDraftRelease(releaseId);
        setRelease(result.data);
        setReleaseETag(result.eTag);
        setPublishResult(undefined);
        syncReleaseForms(result.data);
        const songIds = Array.from(new Set(result.data.tracks.map((track) => track.songId)));
        for (const trackSongId of songIds) {
            try {
                const loaded = await getDraftSong(trackSongId);
                cacheSong(loaded.data);
                await refreshKnownJobs(loaded.data);
            } catch {
                // Publish validation will surface missing songs with the specific track context.
            }
        }
    }

    async function createSong(): Promise<void> {
        const nextSong = newDraftSong(normalizeId('song', songIdInput));
        const write = await putDraftSong(nextSong);
        setSong(nextSong);
        setSongETag(write.eTag);
        syncSongForms(nextSong);
        await refreshLists();
        setNotice(`Created ${write.key}`);
    }

    async function createRelease(): Promise<void> {
        const nextRelease = newDraftRelease(normalizeId('release', releaseIdInput));
        const write = await putDraftRelease(nextRelease);
        setRelease(nextRelease);
        setReleaseETag(write.eTag);
        syncReleaseForms(nextRelease);
        await refreshLists();
        setNotice(`Created ${write.key}`);
    }

    async function saveSong(): Promise<void> {
        const nextSong = prepareSongForSave();
        const write = await putDraftSong(nextSong, songETag);
        setSong(nextSong);
        setSongETag(write.eTag);
        cacheSong(nextSong);
        setNotice(`Saved ${write.key}`);
    }

    async function saveRelease(): Promise<void> {
        const nextRelease = prepareReleaseForSave();
        const write = await putDraftRelease(nextRelease, releaseETag);
        setRelease(nextRelease);
        setReleaseETag(write.eTag);
        setNotice(`Saved ${write.key}`);
    }

    async function addRecording(): Promise<void> {
        if (!song) {
            throw new Error('Load or create a song before adding recordings.');
        }
        updateRecording(newRecording(song));
    }

    async function addSelectedSongToRelease(): Promise<void> {
        if (!release || !song || !selectedRecording) {
            throw new Error('Load a release, song, and recording before adding a release track.');
        }
        updateReleaseTrack(nextReleaseTrack(release, song, selectedRecording));
    }

    async function uploadMaster(): Promise<void> {
        if (!song || !songETag || !selectedRecording || !masterFile) {
            throw new Error('Select a recording and a source master file.');
        }

        const upload = await requestUploadUrl({
            recordingId: selectedRecording.recordingId,
            filename: masterFile.name,
            contentType: masterFile.type || undefined,
        });
        await uploadMasterFile(upload, masterFile);

        const nextRecording = {
            ...selectedRecording,
            sourceMaster: upload.sourceMaster,
        };
        updateRecording(nextRecording);
        const nextSong = {
            ...song,
            recordings: song.recordings.map((recording) => recording.recordingId === nextRecording.recordingId ? nextRecording : recording),
        };
        const write = await putDraftSong(nextSong, songETag);
        setSong(nextSong);
        setSongETag(write.eTag);
        cacheSong(nextSong);
        setMasterFile(undefined);
        setNotice(`Uploaded ${masterFile.name}`);
    }

    async function startEncode(): Promise<void> {
        if (!song || !songETag || !selectedRecording) {
            throw new Error('Select a recording before starting an encode.');
        }
        if (!selectedRecording.sourceMaster?.bucket || !selectedRecording.sourceMaster.key) {
            throw new Error('Upload a source master before starting an encode.');
        }

        const response = await createEncodeJob({
            songId: song.songId,
            recordingId: selectedRecording.recordingId,
            includeLossless,
            requestedBy: optionalText(requestedBy),
        });
        const nextRecording = {
            ...selectedRecording,
            encodeJobIds: [...(selectedRecording.encodeJobIds ?? []), response.job.jobId],
        };
        const nextSong = {
            ...song,
            recordings: song.recordings.map((recording) => recording.recordingId === nextRecording.recordingId ? nextRecording : recording),
        };
        const write = await putDraftSong(nextSong, songETag);
        setSong(nextSong);
        setSongETag(write.eTag);
        cacheSong(nextSong);
        setSelectedRecordingId(nextRecording.recordingId);
        setJobDetails((current) => ({ ...current, [response.job.jobId]: response.job }));
        setSelectedJob(response.job);
        await refreshLists();
        setNotice(`Queued ${response.job.jobId}`);
    }

    async function inspectJob(jobId: string): Promise<void> {
        const job = await getJob(jobId);
        setJobDetails((current) => ({ ...current, [job.jobId]: job }));
        setSelectedJob(job);
    }

    async function ensureReleaseSongsLoaded(): Promise<void> {
        if (!release) {
            return;
        }

        const missingSongIds = Array.from(new Set(release.tracks.map((track) => track.songId)))
            .filter((songId) => !songCache[songId]);
        for (const songId of missingSongIds) {
            const loaded = await getDraftSong(songId);
            cacheSong(loaded.data);
            await refreshKnownJobs(loaded.data);
        }
    }

    async function publishCurrentRelease(): Promise<void> {
        if (!release) {
            throw new Error('Load a release before publishing.');
        }
        await ensureReleaseSongsLoaded();
        if (!canPublish) {
            throw new Error('Resolve publish checks before publishing.');
        }

        const trackJobIds = Object.fromEntries(
            releaseTracks
                .map((track) => {
                    const sourceSong = songCache[track.songId];
                    const recording = sourceSong?.recordings.find((candidate) => candidate.recordingId === track.recordingId);
                    return [track.trackId, latestJobId(recording)];
                })
                .filter((entry): entry is [StableId, StableId] => Boolean(entry[1])),
        );
        const result = await publishRelease(release.releaseId, {
            visibility: publishVisibility,
            trackJobIds,
            publishedAt: optionalText(publishedAt),
        });
        setPublishResult(result);
        const nextRelease = {
            ...release,
            publishState: 'published' as const,
        };
        setRelease(nextRelease);
        setReleaseETag(result.draftWrite.eTag);
        setNotice(`Published ${result.manifestPath}`);
    }

    useEffect(() => {
        void withBusy('Loading admin data', async () => {
            await Promise.all([refreshLists(), refreshRum()]);
        });
    }, []);

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
                <a href="/admin/releases" onClick={(event) => handleInternalLink(event, '/admin/releases')} className={adminRoute === 'releases' ? 'active' : undefined}>
                    <ListMusic aria-hidden="true" /> Releases
                </a>
                <a href="/admin/songs" onClick={(event) => handleInternalLink(event, '/admin/songs')} className={adminRoute === 'songs' ? 'active' : undefined}>
                    <Music2 aria-hidden="true" /> Songs
                </a>
                <a href="/admin/encoding" onClick={(event) => handleInternalLink(event, '/admin/encoding')} className={adminRoute === 'encoding' ? 'active' : undefined}>
                    <FileAudio aria-hidden="true" /> Encoding
                </a>
                <a href="/admin/publish" onClick={(event) => handleInternalLink(event, '/admin/publish')} className={adminRoute === 'publish' ? 'active' : undefined}>
                    <Rocket aria-hidden="true" /> Publish
                </a>
                <a href="/admin/stats" onClick={(event) => handleInternalLink(event, '/admin/stats')} className={adminRoute === 'stats' ? 'active' : undefined}>
                    <BarChart3 aria-hidden="true" /> Stats
                </a>
            </nav>

            {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
            {notice ? <div className="admin-alert admin-alert--notice">{notice}</div> : null}

            <section className="admin-band admin-toolbar-band">
                <div className="admin-field admin-field--grow">
                    <label htmlFor="song-id">Song ID</label>
                    <input id="song-id" value={songIdInput} onChange={(event) => setSongIdInput(event.currentTarget.value)} />
                </div>
                <button className="admin-button" onClick={() => void withBusy('Loading song', () => loadSong(songIdInput))}>
                    <Search /> Load Song
                </button>
                <button className="admin-button" onClick={() => void withBusy('Creating song', createSong)}>
                    <Plus /> Song
                </button>
                <div className="admin-field admin-field--grow">
                    <label htmlFor="release-id">Release ID</label>
                    <input id="release-id" value={releaseIdInput} onChange={(event) => setReleaseIdInput(event.currentTarget.value)} />
                </div>
                <button className="admin-button" onClick={() => void withBusy('Loading release', () => loadRelease(releaseIdInput))}>
                    <Search /> Load Release
                </button>
                <button className="admin-button" onClick={() => void withBusy('Creating release', createRelease)}>
                    <Plus /> Release
                </button>
                <button className="admin-icon-button" title="Refresh lists" onClick={() => void withBusy('Refreshing lists', refreshLists)}>
                    <RefreshCw />
                </button>
            </section>

            <main className="admin-grid">
                {adminRoute === 'releases' ? (
                    <>
                        <section className="admin-panel admin-panel--album">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Release Metadata</p>
                                    <h2>{release?.title ?? 'No Release Loaded'}</h2>
                                </div>
                                <button className="admin-button admin-button--primary" disabled={!release} onClick={() => void withBusy('Saving release', saveRelease)}>
                                    <Save /> Save Release
                                </button>
                            </div>

                            <div className="admin-form-grid">
                                <div className="admin-field">
                                    <label>Title</label>
                                    <input value={release?.title ?? ''} onChange={(event) => updateReleaseField('title', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field">
                                    <label>Slug</label>
                                    <input value={release?.slug ?? ''} onChange={(event) => updateReleaseField('slug', slugify(event.currentTarget.value))} />
                                </div>
                                <div className="admin-field">
                                    <label>Artist</label>
                                    <input value={release?.artistName ?? ''} onChange={(event) => updateReleaseField('artistName', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field">
                                    <label>Kind</label>
                                    <select value={release?.releaseKind ?? 'demo'} onChange={(event) => updateReleaseField('releaseKind', event.currentTarget.value as ReleaseKind)}>
                                        {RELEASE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                                    </select>
                                </div>
                                <div className="admin-field">
                                    <label>Status</label>
                                    <select value={release?.releaseStatus ?? 'demo'} onChange={(event) => updateReleaseField('releaseStatus', event.currentTarget.value as ReleaseStatus)}>
                                        {RELEASE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                                    </select>
                                </div>
                                <div className="admin-field">
                                    <label>Release Date</label>
                                    <input type="date" value={release?.releaseDate ?? ''} onChange={(event) => updateReleaseField('releaseDate', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field">
                                    <label>Publish State</label>
                                    <select value={release?.publishState ?? 'draft'} onChange={(event) => updateReleaseField('publishState', event.currentTarget.value as DraftRelease['publishState'])}>
                                        {PUBLISH_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
                                    </select>
                                </div>
                                <div className="admin-field">
                                    <label>Subtitle</label>
                                    <input value={release?.subtitle ?? ''} onChange={(event) => updateReleaseField('subtitle', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field admin-field--wide">
                                    <label>Description</label>
                                    <textarea rows={4} value={release?.description ?? ''} onChange={(event) => updateReleaseField('description', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field">
                                    <label>Tags</label>
                                    <input value={releaseTagsText} onChange={(event) => setReleaseTagsText(event.currentTarget.value)} />
                                </div>
                                <div className="admin-field">
                                    <label>Copyright</label>
                                    <input value={release?.copyright ?? ''} onChange={(event) => updateReleaseField('copyright', event.currentTarget.value)} />
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
                                        <input value={artworkForm.assetId} onChange={(event) => setArtworkForm((current) => ({ ...current, assetId: event.currentTarget.value }))} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Artwork Path</label>
                                        <input value={artworkForm.path} onChange={(event) => setArtworkForm((current) => ({ ...current, path: event.currentTarget.value }))} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Artwork URL</label>
                                        <input value={artworkForm.url} onChange={(event) => setArtworkForm((current) => ({ ...current, url: event.currentTarget.value }))} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Alt Text</label>
                                        <input value={artworkForm.altText} onChange={(event) => setArtworkForm((current) => ({ ...current, altText: event.currentTarget.value }))} />
                                    </div>
                                </div>
                                <div className="admin-field">
                                    <label>Credits JSON</label>
                                    <textarea rows={8} value={releaseCreditsText} onChange={(event) => setReleaseCreditsText(event.currentTarget.value)} />
                                </div>
                            </div>
                        </section>

                        <section className="admin-panel">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Release Tracks</p>
                                    <h2>{releaseTracks.length} Tracks</h2>
                                </div>
                                <button className="admin-button" disabled={!release || !song || !selectedRecording} onClick={() => void withBusy('Adding to release', addSelectedSongToRelease)}>
                                    <Plus /> Add Loaded Song
                                </button>
                            </div>

                            <div className="admin-track-list">
                                {releaseTracks.map((track) => (
                                    <button
                                        key={track.trackId}
                                        className={`admin-track-row ${selectedReleaseTrack?.trackId === track.trackId ? 'admin-track-row--active' : ''}`}
                                        onClick={() => setSelectedReleaseTrackId(track.trackId)}
                                    >
                                        <span>{track.discNumber}.{track.trackNumber}</span>
                                        <strong>{track.title}</strong>
                                        <span>{track.songId}</span>
                                    </button>
                                ))}
                            </div>

                            {selectedReleaseTrack ? (
                                <div className="admin-form-grid admin-form-grid--compact">
                                    <div className="admin-field">
                                        <label>Track Title</label>
                                        <input value={selectedReleaseTrack.title} onChange={(event) => updateReleaseTrack({ ...selectedReleaseTrack, title: event.currentTarget.value })} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Slug</label>
                                        <input value={selectedReleaseTrack.slug} onChange={(event) => updateReleaseTrack({ ...selectedReleaseTrack, slug: slugify(event.currentTarget.value) })} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Disc</label>
                                        <input type="number" value={selectedReleaseTrack.discNumber} onChange={(event) => updateReleaseTrack({ ...selectedReleaseTrack, discNumber: Number(event.currentTarget.value) })} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Track</label>
                                        <input type="number" value={selectedReleaseTrack.trackNumber} onChange={(event) => updateReleaseTrack({ ...selectedReleaseTrack, trackNumber: Number(event.currentTarget.value) })} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Song ID</label>
                                        <input value={selectedReleaseTrack.songId} onChange={(event) => updateReleaseTrack({ ...selectedReleaseTrack, songId: event.currentTarget.value as StableId })} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Recording ID</label>
                                        <input value={selectedReleaseTrack.recordingId} onChange={(event) => updateReleaseTrack({ ...selectedReleaseTrack, recordingId: event.currentTarget.value as StableId })} />
                                    </div>
                                </div>
                            ) : null}
                        </section>
                    </>
                ) : null}

                {adminRoute === 'songs' ? (
                    <>
                        <section className="admin-panel">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Song</p>
                                    <h2>{song?.title ?? 'No Song Loaded'}</h2>
                                </div>
                                <button className="admin-button admin-button--primary" disabled={!song} onClick={() => void withBusy('Saving song', saveSong)}>
                                    <Save /> Save Song
                                </button>
                            </div>

                            <div className="admin-form-grid">
                                <div className="admin-field">
                                    <label>Title</label>
                                    <input value={song?.title ?? ''} onChange={(event) => updateSongField('title', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field">
                                    <label>Slug</label>
                                    <input value={song?.slug ?? ''} onChange={(event) => updateSongField('slug', slugify(event.currentTarget.value))} />
                                </div>
                                <div className="admin-field">
                                    <label>Artist</label>
                                    <input value={song?.artistName ?? ''} onChange={(event) => updateSongField('artistName', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field">
                                    <label>Tags</label>
                                    <input value={songTagsText} onChange={(event) => setSongTagsText(event.currentTarget.value)} />
                                </div>
                                <div className="admin-field admin-field--wide">
                                    <label>Description</label>
                                    <textarea rows={3} value={song?.description ?? ''} onChange={(event) => updateSongField('description', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field admin-field--wide">
                                    <label>Lyrics</label>
                                    <textarea rows={5} value={song?.lyrics ?? ''} onChange={(event) => updateSongField('lyrics', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field admin-field--wide">
                                    <label>Credits JSON</label>
                                    <textarea rows={5} value={songCreditsText} onChange={(event) => setSongCreditsText(event.currentTarget.value)} />
                                </div>
                            </div>
                        </section>

                        <section className="admin-panel">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Recordings</p>
                                    <h2>{recordings.length} Versions</h2>
                                </div>
                                <button className="admin-button" disabled={!song} onClick={() => void withBusy('Adding recording', addRecording)}>
                                    <Plus /> Recording
                                </button>
                            </div>

                            <div className="admin-track-list">
                                {recordings.map((recording) => {
                                    const job = latestJob(recording, jobDetails);
                                    return (
                                        <button
                                            key={recording.recordingId}
                                            className={`admin-track-row ${selectedRecording?.recordingId === recording.recordingId ? 'admin-track-row--active' : ''}`}
                                            onClick={() => setSelectedRecordingId(recording.recordingId)}
                                        >
                                            <span><Disc3 aria-hidden="true" /></span>
                                            <strong>{recording.title}</strong>
                                            <span>{recording.versionType}</span>
                                            <span className={jobClass(job?.status)}>{job?.status ?? 'no job'}</span>
                                        </button>
                                    );
                                })}
                            </div>

                            {selectedRecording ? (
                                <div className="admin-form-grid admin-form-grid--compact">
                                    <div className="admin-field">
                                        <label>Recording ID</label>
                                        <input value={selectedRecording.recordingId} onChange={(event) => updateRecording({ ...selectedRecording, recordingId: event.currentTarget.value as StableId })} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Title</label>
                                        <input value={selectedRecording.title} onChange={(event) => updateRecording({ ...selectedRecording, title: event.currentTarget.value })} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Slug</label>
                                        <input value={selectedRecording.slug} onChange={(event) => updateRecording({ ...selectedRecording, slug: slugify(event.currentTarget.value) })} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Version</label>
                                        <input value={selectedRecording.versionTitle ?? ''} onChange={(event) => updateRecording({ ...selectedRecording, versionTitle: event.currentTarget.value })} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Version Type</label>
                                        <select value={selectedRecording.versionType} onChange={(event) => updateRecording({ ...selectedRecording, versionType: event.currentTarget.value as DraftRecording['versionType'] })}>
                                            {VERSION_TYPES.map((versionType) => <option key={versionType} value={versionType}>{versionType}</option>)}
                                        </select>
                                    </div>
                                    <div className="admin-field">
                                        <label>Duration Seconds</label>
                                        <input type="number" value={selectedRecording.durationSeconds ?? 0} onChange={(event) => updateRecording({ ...selectedRecording, durationSeconds: Number(event.currentTarget.value) })} />
                                    </div>
                                    <label className="admin-check">
                                        <input type="checkbox" checked={selectedRecording.explicit} onChange={(event) => updateRecording({ ...selectedRecording, explicit: event.currentTarget.checked })} />
                                        Explicit
                                    </label>
                                    <div className="admin-field">
                                        <label>ISRC</label>
                                        <input value={selectedRecording.isrc ?? ''} onChange={(event) => updateRecording({ ...selectedRecording, isrc: event.currentTarget.value })} />
                                    </div>
                                </div>
                            ) : null}
                        </section>
                    </>
                ) : null}

                {adminRoute === 'encoding' ? (
                    <>
                        <section className="admin-panel">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Masters And Encoding</p>
                                    <h2>{selectedRecording?.title ?? 'Select A Recording'}</h2>
                                </div>
                                <FileAudio />
                            </div>

                            <div className="admin-source-master">
                                <div>
                                    <span>Source Master</span>
                                    <strong>{selectedRecording?.sourceMaster?.key ?? 'none'}</strong>
                                </div>
                                <div>
                                    <span>Latest Job</span>
                                    <strong>{latestJobId(selectedRecording) ?? 'none'}</strong>
                                </div>
                                <div>
                                    <span>Status</span>
                                    <strong className={jobClass(currentRecordingJob?.status)}>{currentRecordingJob?.status ?? 'no job'}</strong>
                                </div>
                            </div>

                            <div className="admin-form-grid admin-form-grid--compact">
                                <div className="admin-field admin-field--wide">
                                    <label>Lossless Master</label>
                                    <input type="file" accept=".wav,.aif,.aiff,.flac,audio/wav,audio/flac" onChange={(event) => setMasterFile(event.currentTarget.files?.[0])} />
                                </div>
                                <div className="admin-button-row admin-field--wide">
                                    <button className="admin-button" disabled={!selectedRecording || !masterFile} onClick={() => void withBusy('Uploading master', uploadMaster)}>
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
                                    <button className="admin-button admin-button--primary" disabled={!selectedRecording?.sourceMaster} onClick={() => void withBusy('Starting encode', startEncode)}>
                                        <CloudUpload /> Start Encode
                                    </button>
                                    <button className="admin-button" disabled={!song} onClick={() => void withBusy('Refreshing jobs', () => refreshKnownJobs())}>
                                        <RefreshCw /> Status
                                    </button>
                                </div>
                            </div>
                        </section>

                        <section className="admin-panel">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Encode Status</p>
                                    <h2>Jobs</h2>
                                </div>
                                <button className="admin-icon-button" title="Refresh jobs" onClick={() => void withBusy('Refreshing jobs', refreshLists)}>
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
                    </>
                ) : null}

                {adminRoute === 'publish' ? (
                    <>
                        <section className="admin-panel admin-panel--preview">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Publish Preview</p>
                                    <h2>{release?.title ?? 'No Release'}</h2>
                                </div>
                                <Rocket />
                            </div>

                            <div className="admin-checklist">
                                {publishChecks.map((check) => (
                                    <span key={check.label} className={check.ok ? 'is-ok' : 'is-missing'}>{check.label}</span>
                                ))}
                            </div>

                            <div className="admin-preview-tracklist">
                                {releaseTracks.map((track) => {
                                    const sourceSong = songCache[track.songId];
                                    const recording = sourceSong?.recordings.find((candidate) => candidate.recordingId === track.recordingId);
                                    const job = latestJob(recording, jobDetails);
                                    return (
                                        <button key={track.trackId}>
                                            <span>{track.trackNumber}</span>
                                            <strong>{track.title}</strong>
                                            <span className={jobClass(job?.status)}>{job?.status ?? 'missing job'}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </section>

                        <section className="admin-panel">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Publish Metadata</p>
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
                                    <button className="admin-button admin-button--primary" disabled={!release || !canPublish} onClick={() => void withBusy('Publishing release', publishCurrentRelease)}>
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
                    </>
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
                                            <div className="admin-stat-row" key={`${track.releaseId}/${track.trackId}`}>
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
                                                <span>{item.trackId ?? item.songId ?? item.releaseId ?? 'unknown'}</span>
                                                <p>{item.errorMessage}</p>
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </>
                        ) : null}
                    </section>
                ) : null}

                {adminRoute === 'songs' || adminRoute === 'releases' ? (
                    <section className="admin-panel">
                        <div className="admin-panel__header">
                            <div>
                                <p className="admin-kicker">Draft Objects</p>
                                <h2>{adminRoute === 'songs' ? 'Songs' : 'Releases'}</h2>
                            </div>
                            <RefreshCw />
                        </div>
                        <div className="admin-object-list">
                            {(adminRoute === 'songs' ? songObjects : releaseObjects).map((object) => {
                                const id = adminRoute === 'songs' ? songIdFromKey(object.key) : releaseIdFromKey(object.key);
                                return (
                                    <button key={object.key} onClick={() => void withBusy(`Loading ${id}`, async () => {
                                        if (adminRoute === 'songs') {
                                            await loadSong(id);
                                        } else {
                                            await loadRelease(id);
                                        }
                                    })}>
                                        <strong>{id}</strong>
                                        <span>{object.eTag ?? 'no etag'}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                ) : null}
            </main>
        </div>
    );
}
