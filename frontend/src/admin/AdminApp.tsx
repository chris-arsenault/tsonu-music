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
    Trash2,
    Upload,
} from 'lucide-react';
import type { CatalogArtwork, ReleaseKind, ReleaseStatus, StableId, Visibility } from '../catalog/media-catalog';
import { getArtworkUrl } from '../catalog/catalog-client';
import { getRuntimeConfig } from '../runtime-config';
import { useAuth } from '../use-auth';
import { handleInternalLink, navigateTo, useCurrentRoute } from '../music/routes';
import {
    AdminApiError,
    createEncodeJob,
    createDraftRelease,
    createDraftSong,
    deleteDraftRelease,
    deleteDraftSong,
    getDraftRelease,
    getDraftSong,
    getJob,
    getRumSummary,
    listDraftReleases,
    listDraftSongs,
    listJobs,
    publishRelease,
    requestArtworkUploadUrl,
    requestUploadUrl,
    updateDraftRelease,
    updateDraftSong,
    uploadArtworkFile,
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
type ArtworkChoice = {
    value: string;
    label: string;
    artwork: CatalogArtwork;
};

const ADMIN_ROUTES = ['releases', 'songs', 'encoding', 'publish', 'stats'] as const;
const RELEASE_KINDS: ReleaseKind[] = ['album', 'ep', 'single', 'demo', 'preview', 'collection', 'prerelease'];
const RELEASE_STATUSES: ReleaseStatus[] = ['official', 'demo', 'promo', 'prerelease', 'bootleg'];
const VERSION_TYPES: DraftRecording['versionType'][] = ['studio_master', 'album_master', 'single_master', 'demo', 'preview', 'live', 'alternate', 'remaster'];

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

function uniqueStableId(
    prefix: 'song' | 'release',
    value: string,
    existingIds: Set<string>,
): StableId {
    const base = stableId(prefix, value);
    let candidate = base;
    let index = 2;
    while (existingIds.has(candidate)) {
        candidate = `${base}_${index}` as StableId;
        index += 1;
    }
    return candidate;
}

function temporaryDraftId(prefix: 'song' | 'release'): StableId {
    return stableId(prefix, `draft ${Date.now().toString(36)}`);
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

function artworkChoiceValue(kind: 'release' | 'song', id: StableId, artwork: CatalogArtwork): string {
    return `${kind}:${id}:${artwork.assetId}:${artwork.sources[0]?.path ?? ''}`;
}

function addArtworkChoice(
    choices: Map<string, ArtworkChoice>,
    kind: 'release' | 'song',
    id: StableId,
    title: string,
    artwork: CatalogArtwork | undefined,
): void {
    if (!artwork) {
        return;
    }

    const value = artworkChoiceValue(kind, id, artwork);
    if (!choices.has(value)) {
        choices.set(value, {
            value,
            label: `${kind === 'release' ? 'Release' : 'Song'}: ${title || titleFromId(id, kind)}`,
            artwork,
        });
    }
}

function latestJobId(recording: DraftRecording | undefined): StableId | undefined {
    return recording?.encodeJobIds?.[recording.encodeJobIds.length - 1];
}

function latestJob(recording: DraftRecording | undefined, jobDetails: Record<string, EncodeJob>): EncodeJob | undefined {
    const jobId = latestJobId(recording);
    return jobId ? jobDetails[jobId] : undefined;
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

function readArtworkDimensions(file: File): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const image = new Image();

        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            if (!image.naturalWidth || !image.naturalHeight) {
                reject(new Error('Artwork file has no readable dimensions.'));
                return;
            }
            resolve({ width: image.naturalWidth, height: image.naturalHeight });
        };
        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Artwork file is not a readable image.'));
        };
        image.src = objectUrl;
    });
}

function useObjectUrl(file: File | undefined): string | undefined {
    const [url, setUrl] = useState<string>();

    useEffect(() => {
        if (!file) {
            setUrl(undefined);
            return undefined;
        }

        const nextUrl = URL.createObjectURL(file);
        setUrl(nextUrl);
        return () => URL.revokeObjectURL(nextUrl);
    }, [file]);

    return url;
}

function formatPercent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function formatCount(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
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
        if (error.status === 409) {
            return 'A draft with that title already exists. Open it from the draft list, or change the title before saving a new draft.';
        }

        return error.code
            ? `${error.code}: ${error.message}`
            : `${error.status}: ${error.message}`;
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
    const [savedSongId, setSavedSongId] = useState<string>();
    const [songCache, setSongCache] = useState<Record<string, DraftSong>>({});
    const [release, setRelease] = useState<DraftRelease>();
    const [savedReleaseId, setSavedReleaseId] = useState<string>();
    const [releaseCache, setReleaseCache] = useState<Record<string, DraftRelease>>({});
    const [songIdInput, setSongIdInput] = useState(() => temporaryDraftId('song'));
    const [releaseIdInput, setReleaseIdInput] = useState(() => temporaryDraftId('release'));
    const [selectedRecordingId, setSelectedRecordingId] = useState<string>();
    const [selectedReleaseTrackId, setSelectedReleaseTrackId] = useState<string>();
    const [releaseArtworkFile, setReleaseArtworkFile] = useState<File>();
    const [songArtworkFile, setSongArtworkFile] = useState<File>();
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
    const songIds = useMemo(() => new Set(songObjects.map((object) => songIdFromKey(object.key))), [songObjects]);
    const releaseIds = useMemo(() => new Set(releaseObjects.map((object) => releaseIdFromKey(object.key))), [releaseObjects]);
    const artworkChoices = useMemo(() => {
        const choices = new Map<string, ArtworkChoice>();
        for (const draft of Object.values(releaseCache)) {
            addArtworkChoice(choices, 'release', draft.releaseId, draft.title, draft.artwork);
        }
        for (const draft of Object.values(songCache)) {
            addArtworkChoice(choices, 'song', draft.songId, draft.title, draft.artwork);
        }
        if (release) {
            addArtworkChoice(choices, 'release', release.releaseId, release.title, release.artwork);
        }
        if (song) {
            addArtworkChoice(choices, 'song', song.songId, song.title, song.artwork);
        }
        return [...choices.values()].sort((left, right) => left.label.localeCompare(right.label));
    }, [release, releaseCache, song, songCache]);
    const currentRecordingJob = latestJob(selectedRecording, jobDetails);
    const releaseArtworkSrc = release?.artwork ? getArtworkUrl(runtimeConfig.mediaBaseUrl, release.artwork) : undefined;
    const songArtworkSrc = song?.artwork ? getArtworkUrl(runtimeConfig.mediaBaseUrl, song.artwork) : undefined;
    const releaseArtworkPreviewSrc = useObjectUrl(releaseArtworkFile) ?? releaseArtworkSrc;
    const songArtworkPreviewSrc = useObjectUrl(songArtworkFile) ?? songArtworkSrc;
    const releaseSaved = Boolean(release && savedReleaseId === release.releaseId);
    const songSaved = Boolean(song && savedSongId === song.songId);
    const releaseTitleReady = Boolean(release?.title.trim());
    const songTitleReady = Boolean(song?.title.trim());
    const canSaveRelease = Boolean(release && releaseTitleReady);
    const canSaveSong = Boolean(song && songTitleReady);
    const canUploadReleaseArtwork = Boolean(releaseArtworkFile && releaseSaved);
    const canUploadSongArtwork = Boolean(songArtworkFile && songSaved);
    const canUploadMaster = Boolean(songSaved && selectedRecording && masterFile);
    const canStartEncode = Boolean(songSaved && selectedRecording?.sourceMaster);
    const releaseArtworkStatus = !release
        ? 'Create or open a release first'
        : !releaseSaved
            ? 'Save this release before uploading artwork'
            : releaseArtworkFile
                ? releaseArtworkFile.name
                : release.artwork?.sources[0]?.path ?? 'No artwork uploaded';
    const songArtworkStatus = !song
        ? 'Create or open a song first'
        : !songSaved
            ? 'Save this song before uploading artwork'
            : songArtworkFile
                ? songArtworkFile.name
                : song.artwork?.sources[0]?.path ?? 'Uses release artwork when empty';
    const masterFileStatus = !song
        ? 'Open a song'
        : !songSaved
            ? 'Save this song'
            : !selectedRecording
                ? 'Choose a recording'
                : masterFile
                    ? masterFile.name
                    : selectedRecording.sourceMaster?.key ?? 'Choose WAV, AIFF, or FLAC';
    const latestEncodingStatus = currentRecordingJob
        ? `${currentRecordingJob.status}: ${currentRecordingJob.jobId}`
        : latestJobId(selectedRecording) ?? 'No encoding run';
    const publishChecks = [
        { label: 'Release date', ok: Boolean(release?.releaseDate) },
        { label: 'Artwork', ok: Boolean(release?.artwork) },
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

    function cacheRelease(nextRelease: DraftRelease): void {
        setReleaseCache((current) => ({ ...current, [nextRelease.releaseId]: nextRelease }));
    }

    function removeDraftSongFromLists(songId: string): void {
        setSongList((current) => current ? {
            ...current,
            objects: current.objects.filter((object) => songIdFromKey(object.key) !== songId),
        } : current);
        setSongCache((current) => {
            const next = { ...current };
            delete next[songId];
            return next;
        });
    }

    function removeDraftReleaseFromLists(releaseId: string): void {
        setReleaseList((current) => current ? {
            ...current,
            objects: current.objects.filter((object) => releaseIdFromKey(object.key) !== releaseId),
        } : current);
        setReleaseCache((current) => {
            const next = { ...current };
            delete next[releaseId];
            return next;
        });
    }

    function newSongFromInput(): DraftSong {
        return newDraftSong(normalizeId('song', songIdInput));
    }

    function newReleaseFromInput(): DraftRelease {
        return newDraftRelease(normalizeId('release', releaseIdInput));
    }

    function ensureSongDraft(): void {
        setSong((current) => {
            if (current) {
                return current;
            }

            const next = newSongFromInput();
            cacheSong(next);
            return next;
        });
    }

    function ensureReleaseDraft(): void {
        setRelease((current) => current ?? newReleaseFromInput());
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
        setReleaseTagsText(nextRelease.tags?.join(', ') ?? '');
        setLinksText(formatLinks(nextRelease.links));
        setReleaseCreditsText(nextRelease.credits ? JSON.stringify(nextRelease.credits, null, 2) : '');
    }

    function prepareSongDraftForSave(draft: DraftSong): DraftSong {
        return {
            ...draft,
            description: optionalText(draft.description),
            lyrics: optionalText(draft.lyrics),
            credits: parseOptionalJson(songCreditsText),
            tags: parseTags(songTagsText),
            updatedAt: new Date().toISOString(),
        };
    }

    function prepareSongForSave(): DraftSong {
        if (!song) {
            throw new Error('No draft song is loaded.');
        }

        return prepareSongDraftForSave(song);
    }

    function prepareReleaseDraftForSave(draft: DraftRelease): DraftRelease {
        return {
            ...draft,
            subtitle: optionalText(draft.subtitle),
            releaseDate: optionalText(draft.releaseDate),
            description: optionalText(draft.description),
            copyright: optionalText(draft.copyright),
            credits: parseOptionalJson(releaseCreditsText),
            links: parseLinks(linksText),
            tags: parseTags(releaseTagsText),
            tracks: sortedReleaseTracks(draft),
            updatedAt: new Date().toISOString(),
        };
    }

    function prepareReleaseForSave(): DraftRelease {
        if (!release) {
            throw new Error('No draft release is loaded.');
        }

        return prepareReleaseDraftForSave(release);
    }

    function updateSongField<K extends keyof DraftSong>(key: K, value: DraftSong[K]): void {
        setSong((current) => {
            const next: DraftSong = {
                ...(current ?? newSongFromInput()),
                [key]: value,
            };
            if (key === 'title') {
                const nextSlug = slugify(String(value));
                next.slug = nextSlug;
                if (!songSaved && next.recordings.length === 0) {
                    next.songId = uniqueStableId('song', nextSlug, songIds);
                    setSongIdInput(next.songId);
                }
            }
            cacheSong(next);
            return next;
        });
    }

    function updateReleaseField<K extends keyof DraftRelease>(key: K, value: DraftRelease[K]): void {
        setRelease((current) => {
            const next: DraftRelease = {
                ...(current ?? newReleaseFromInput()),
                [key]: value,
            };
            if (key === 'title') {
                const nextSlug = slugify(String(value));
                next.slug = nextSlug;
                if (!releaseSaved && next.tracks.length === 0) {
                    next.releaseId = uniqueStableId('release', nextSlug, releaseIds);
                    setReleaseIdInput(next.releaseId);
                }
            }
            return next;
        });
    }

    function updateSongTagsText(value: string): void {
        ensureSongDraft();
        setSongTagsText(value);
    }

    function updateSongCreditsText(value: string): void {
        ensureSongDraft();
        setSongCreditsText(value);
    }

    function updateReleaseTagsText(value: string): void {
        ensureReleaseDraft();
        setReleaseTagsText(value);
    }

    function updateLinksText(value: string): void {
        ensureReleaseDraft();
        setLinksText(value);
    }

    function updateReleaseCreditsText(value: string): void {
        ensureReleaseDraft();
        setReleaseCreditsText(value);
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

    function updateSelectedRecordingField<K extends keyof DraftRecording>(key: K, value: DraftRecording[K]): void {
        const recordingId = selectedRecording?.recordingId;
        if (!recordingId) {
            return;
        }

        setSong((current) => {
            if (!current) {
                return current;
            }
            const nextRecordings = current.recordings.map((recording) => {
                if (recording.recordingId !== recordingId) {
                    return recording;
                }
                const nextRecording = { ...recording, [key]: value };
                if (key === 'title') {
                    nextRecording.slug = slugify(String(value));
                }
                return nextRecording;
            });
            const next = {
                ...current,
                recordings: nextRecordings,
            };
            cacheSong(next);
            return next;
        });

        if (key === 'recordingId') {
            setSelectedRecordingId(value as string);
        }
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

    function updateSelectedReleaseTrackField<K extends keyof DraftReleaseTrack>(key: K, value: DraftReleaseTrack[K]): void {
        const trackId = selectedReleaseTrack?.trackId;
        if (!trackId) {
            return;
        }

        setRelease((current) => current ? {
            ...current,
            tracks: current.tracks.map((track) => {
                if (track.trackId !== trackId) {
                    return track;
                }
                const nextTrack = { ...track, [key]: value };
                if (key === 'title') {
                    nextTrack.slug = slugify(String(value));
                }
                return nextTrack;
            }),
        } : current);

        if (key === 'trackId') {
            setSelectedReleaseTrackId(value as string);
        }
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
        await refreshDraftCaches(songs, releases);
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

    async function refreshDraftCaches(songs: ObjectList, releases: ObjectList): Promise<void> {
        const listedSongIds = new Set(songs.objects.map((object) => songIdFromKey(object.key)));
        const listedReleaseIds = new Set(releases.objects.map((object) => releaseIdFromKey(object.key)));
        const [loadedSongs, loadedReleases] = await Promise.all([
            Promise.all([...listedSongIds].map(async (songId) => {
                try {
                    return await getDraftSong(songId);
                } catch {
                    return undefined;
                }
            })),
            Promise.all([...listedReleaseIds].map(async (releaseId) => {
                try {
                    return await getDraftRelease(releaseId);
                } catch {
                    return undefined;
                }
            })),
        ]);

        setSongCache((current) => {
            const next: Record<string, DraftSong> = {};
            for (const [songId, draft] of Object.entries(current)) {
                if (listedSongIds.has(songId)) {
                    next[songId] = draft;
                }
            }
            for (const draft of loadedSongs) {
                if (draft) {
                    next[draft.songId] = draft;
                }
            }
            return next;
        });

        setReleaseCache((current) => {
            const next: Record<string, DraftRelease> = {};
            for (const [releaseId, draft] of Object.entries(current)) {
                if (listedReleaseIds.has(releaseId)) {
                    next[releaseId] = draft;
                }
            }
            for (const draft of loadedReleases) {
                if (draft) {
                    next[draft.releaseId] = draft;
                }
            }
            return next;
        });
    }

    async function loadSong(songId: string): Promise<DraftSong> {
        const result = await getDraftSong(songId);
        setSong(result);
        setSavedSongId(result.songId);
        setSongArtworkFile(undefined);
        syncSongForms(result);
        await refreshKnownJobs(result);
        return result;
    }

    async function loadRelease(releaseId: string): Promise<void> {
        const result = await getDraftRelease(releaseId);
        setRelease(result);
        setSavedReleaseId(result.releaseId);
        setReleaseArtworkFile(undefined);
        setPublishResult(undefined);
        cacheRelease(result);
        syncReleaseForms(result);
        const songIds = Array.from(new Set(result.tracks.map((track) => track.songId)));
        for (const trackSongId of songIds) {
            try {
                const loaded = await getDraftSong(trackSongId);
                cacheSong(loaded);
                await refreshKnownJobs(loaded);
            } catch {
                // Publish validation will surface missing songs with the specific track context.
            }
        }
    }

    async function createSong(): Promise<void> {
        const nextSong = {
            ...newDraftSong(temporaryDraftId('song')),
            slug: '',
            title: '',
            updatedAt: undefined,
        };
        setSong(nextSong);
        setSavedSongId(undefined);
        setSongArtworkFile(undefined);
        syncSongForms(nextSong);
        setSelectedRecordingId(undefined);
        setNotice('Started a new unsaved song.');
        navigateTo('/admin/songs');
    }

    async function createRelease(): Promise<void> {
        const nextRelease = {
            ...newDraftRelease(temporaryDraftId('release')),
            slug: '',
            title: '',
            releaseDate: '',
            updatedAt: undefined,
        };
        setRelease(nextRelease);
        setSavedReleaseId(undefined);
        setReleaseArtworkFile(undefined);
        syncReleaseForms(nextRelease);
        setSelectedReleaseTrackId(undefined);
        setPublishResult(undefined);
        setNotice('Started a new unsaved release.');
        navigateTo('/admin/releases');
    }

    async function saveSong(): Promise<void> {
        if (!songTitleReady) {
            throw new Error('Add a song title before saving.');
        }
        const nextSong = prepareSongForSave();
        if (songSaved) {
            await updateDraftSong(nextSong);
        } else {
            await createDraftSong(nextSong);
        }
        setSong(nextSong);
        setSavedSongId(nextSong.songId);
        cacheSong(nextSong);
        await refreshLists();
        setNotice(`Saved ${nextSong.title}`);
    }

    async function saveRelease(): Promise<void> {
        if (!releaseTitleReady) {
            throw new Error('Add a release title before saving.');
        }
        const nextRelease = prepareReleaseForSave();
        if (releaseSaved) {
            await updateDraftRelease(nextRelease);
        } else {
            await createDraftRelease(nextRelease);
        }
        setRelease(nextRelease);
        setSavedReleaseId(nextRelease.releaseId);
        cacheRelease(nextRelease);
        await refreshLists();
        setNotice(`Saved ${nextRelease.title}`);
    }

    async function deleteCurrentSong(): Promise<void> {
        if (!song) {
            return;
        }

        if (!songSaved) {
            setSong(undefined);
            setSongArtworkFile(undefined);
            setSelectedRecordingId(undefined);
            setSavedSongId(undefined);
            setNotice('Discarded unsaved song.');
            return;
        }

        if (!window.confirm(`Delete draft song "${song.title}"?`)) {
            return;
        }

        const deletedSongId = song.songId;
        const deletedTitle = song.title;
        await deleteDraftSong(deletedSongId);
        removeDraftSongFromLists(deletedSongId);
        setSong(undefined);
        setSavedSongId(undefined);
        setSongArtworkFile(undefined);
        setSelectedRecordingId(undefined);
        await refreshLists();
        setNotice(`Deleted ${deletedTitle}`);
    }

    async function deleteCurrentRelease(): Promise<void> {
        if (!release) {
            return;
        }

        if (!releaseSaved) {
            setRelease(undefined);
            setReleaseArtworkFile(undefined);
            setSelectedReleaseTrackId(undefined);
            setSavedReleaseId(undefined);
            setPublishResult(undefined);
            setNotice('Discarded unsaved release.');
            return;
        }

        if (!window.confirm(`Delete draft release "${release.title}"?`)) {
            return;
        }

        const deletedReleaseId = release.releaseId;
        const deletedTitle = release.title;
        await deleteDraftRelease(deletedReleaseId);
        removeDraftReleaseFromLists(deletedReleaseId);
        setRelease(undefined);
        setSavedReleaseId(undefined);
        setReleaseArtworkFile(undefined);
        setSelectedReleaseTrackId(undefined);
        setPublishResult(undefined);
        await refreshLists();
        setNotice(`Deleted ${deletedTitle}`);
    }

    function clearReleaseArtwork(): void {
        updateReleaseField('artwork', undefined);
        setReleaseArtworkFile(undefined);
    }

    function clearSongArtwork(): void {
        updateSongField('artwork', undefined);
        setSongArtworkFile(undefined);
    }

    function reuseArtworkForRelease(choiceValue: string): void {
        const choice = artworkChoices.find((candidate) => candidate.value === choiceValue);
        if (!choice) {
            return;
        }
        updateReleaseField('artwork', choice.artwork);
        setReleaseArtworkFile(undefined);
    }

    function reuseArtworkForSong(choiceValue: string): void {
        const choice = artworkChoices.find((candidate) => candidate.value === choiceValue);
        if (!choice) {
            return;
        }
        updateSongField('artwork', choice.artwork);
        setSongArtworkFile(undefined);
    }

    function removeSelectedRecording(): void {
        if (!song || !selectedRecording) {
            return;
        }
        const nextRecordings = song.recordings.filter(
            (recording) => recording.recordingId !== selectedRecording.recordingId,
        );
        const nextSong = {
            ...song,
            recordings: nextRecordings,
        };
        setSong(nextSong);
        cacheSong(nextSong);
        setSelectedRecordingId(nextRecordings[0]?.recordingId);
    }

    function removeSelectedReleaseTrack(): void {
        if (!release || !selectedReleaseTrack) {
            return;
        }
        const nextTracks = release.tracks.filter(
            (track) => track.trackId !== selectedReleaseTrack.trackId,
        );
        setRelease({
            ...release,
            tracks: nextTracks,
        });
        setSelectedReleaseTrackId(nextTracks[0]?.trackId);
    }

    async function uploadReleaseArtwork(): Promise<void> {
        if (!releaseArtworkFile) {
            throw new Error('Choose release artwork before uploading.');
        }
        if (!release || !releaseSaved) {
            throw new Error('Save the release before uploading artwork.');
        }

        const baseRelease = release;
        const dimensions = await readArtworkDimensions(releaseArtworkFile);
        const upload = await requestArtworkUploadUrl({
            ownerType: 'release',
            ownerId: baseRelease.releaseId,
            filename: releaseArtworkFile.name,
            contentType: releaseArtworkFile.type || undefined,
            width: dimensions.width,
            height: dimensions.height,
            altText: `${baseRelease.title} cover art`,
        });
        await uploadArtworkFile(upload, releaseArtworkFile);

        const nextRelease = prepareReleaseDraftForSave({
            ...baseRelease,
            artwork: upload.artwork,
        });
        await updateDraftRelease(nextRelease);
        setRelease(nextRelease);
        setSavedReleaseId(nextRelease.releaseId);
        cacheRelease(nextRelease);
        setReleaseArtworkFile(undefined);
        setNotice(`Uploaded artwork for ${nextRelease.title}`);
    }

    async function uploadSongArtwork(): Promise<void> {
        if (!songArtworkFile) {
            throw new Error('Choose song artwork before uploading.');
        }
        if (!song || !songSaved) {
            throw new Error('Save the song before uploading artwork.');
        }

        const baseSong = song;
        const dimensions = await readArtworkDimensions(songArtworkFile);
        const upload = await requestArtworkUploadUrl({
            ownerType: 'song',
            ownerId: baseSong.songId,
            filename: songArtworkFile.name,
            contentType: songArtworkFile.type || undefined,
            width: dimensions.width,
            height: dimensions.height,
            altText: `${baseSong.title} artwork`,
        });
        await uploadArtworkFile(upload, songArtworkFile);

        const nextSong = prepareSongDraftForSave({
            ...baseSong,
            artwork: upload.artwork,
        });
        await updateDraftSong(nextSong);
        setSong(nextSong);
        setSavedSongId(nextSong.songId);
        cacheSong(nextSong);
        setSongArtworkFile(undefined);
        setNotice(`Uploaded artwork for ${nextSong.title}`);
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
        if (!song || !songSaved || !selectedRecording || !masterFile) {
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
        await updateDraftSong(nextSong);
        setSong(nextSong);
        setSavedSongId(nextSong.songId);
        cacheSong(nextSong);
        setMasterFile(undefined);
        setNotice(`Uploaded ${masterFile.name}`);
    }

    async function startEncode(): Promise<void> {
        if (!song || !songSaved || !selectedRecording) {
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
        await updateDraftSong(nextSong);
        setSong(nextSong);
        setSavedSongId(nextSong.songId);
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
            cacheSong(loaded);
            await refreshKnownJobs(loaded);
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
        setSavedReleaseId(nextRelease.releaseId);
        cacheRelease(nextRelease);
        setNotice(`Published ${result.manifestPath}`);
    }

    function draftObjectLabel(kind: 'song' | 'release', id: string): string {
        if (kind === 'song') {
            return songCache[id]?.title || (song?.songId === id ? song.title : '') || titleFromId(id, 'song');
        }

        return releaseCache[id]?.title || (release?.releaseId === id && release.title ? release.title : '') || titleFromId(id, 'release');
    }

    function draftObjectStatus(kind: 'song' | 'release', id: string): string {
        if (kind === 'song' && song?.songId === id) {
            return songSaved ? 'Open' : 'Unsaved';
        }
        if (kind === 'release' && release?.releaseId === id) {
            return releaseSaved ? 'Open' : 'Unsaved';
        }
        return 'Draft';
    }

    function renderDraftBrowser(kind: 'song' | 'release') {
        const objects = kind === 'song' ? songObjects : releaseObjects;
        const activeId = kind === 'song' ? song?.songId : release?.releaseId;
        const title = kind === 'song' ? 'Songs' : 'Releases';
        const createLabel = kind === 'song' ? 'New Song' : 'New Release';
        const createAction = kind === 'song' ? createSong : createRelease;

        return (
            <section className="admin-panel admin-panel--browser">
                <div className="admin-panel__header">
                    <div>
                        <p className="admin-kicker">Draft Library</p>
                        <h2>{title}</h2>
                    </div>
                    <div className="admin-button-row">
                        <button className="admin-button" type="button" onClick={() => void withBusy(`Starting ${kind}`, createAction)}>
                            <Plus /> {createLabel}
                        </button>
                        <button className="admin-icon-button" type="button" title={`Refresh ${title.toLowerCase()}`} onClick={() => void withBusy('Refreshing drafts', refreshLists)}>
                            <RefreshCw />
                        </button>
                    </div>
                </div>

                <div className="admin-object-list admin-object-list--library">
                    {objects.length === 0 ? (
                        <div className="admin-empty-state">No draft {title.toLowerCase()} yet.</div>
                    ) : objects.map((object) => {
                        const id = kind === 'song' ? songIdFromKey(object.key) : releaseIdFromKey(object.key);
                        return (
                            <button
                                key={object.key}
                                className={activeId === id ? 'is-active' : undefined}
                                type="button"
                                onClick={() => void withBusy(`Opening ${draftObjectLabel(kind, id)}`, async () => {
                                    if (kind === 'song') {
                                        await loadSong(id);
                                        navigateTo('/admin/songs');
                                    } else {
                                        await loadRelease(id);
                                        navigateTo('/admin/releases');
                                    }
                                })}
                            >
                                <strong>{draftObjectLabel(kind, id)}</strong>
                                <span>{draftObjectStatus(kind, id)}</span>
                                <small>{id}</small>
                            </button>
                        );
                    })}
                </div>
            </section>
        );
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

            <section className="admin-band admin-context-band">
                {adminRoute !== 'encoding' ? (
                    <div className="admin-context-card">
                        <span>Release</span>
                        <strong>{release?.title || 'None selected'}</strong>
                        <small>{release ? (releaseSaved ? 'Saved draft' : 'Unsaved draft') : 'Choose from Releases'}</small>
                    </div>
                ) : null}
                <div className="admin-context-card">
                    <span>Song</span>
                    <strong>{song?.title || 'None selected'}</strong>
                    <small>{song ? (songSaved ? 'Saved draft' : 'Unsaved draft') : 'Choose from Songs'}</small>
                </div>
                {adminRoute === 'encoding' ? (
                    <div className="admin-context-card">
                        <span>Recording</span>
                        <strong>{selectedRecording?.title || 'None selected'}</strong>
                        <small>{selectedRecording?.versionType ?? 'Choose from Recordings'}</small>
                    </div>
                ) : null}
                <div className="admin-context-actions">
                    {adminRoute !== 'encoding' ? (
                        <button className="admin-button" type="button" onClick={() => void withBusy('Starting release', createRelease)}>
                            <Plus /> New Release
                        </button>
                    ) : null}
                    <button className="admin-button" type="button" onClick={() => void withBusy('Starting song', createSong)}>
                        <Plus /> New Song
                    </button>
                    {adminRoute === 'encoding' ? (
                        <button className="admin-button" type="button" disabled={!song} onClick={() => void withBusy('Adding recording', addRecording)}>
                            <Plus /> Recording
                        </button>
                    ) : null}
                    <button className="admin-icon-button" type="button" title="Refresh drafts" onClick={() => void withBusy('Refreshing drafts', refreshLists)}>
                        <RefreshCw />
                    </button>
                </div>
            </section>

            <main className="admin-grid">
                {adminRoute === 'releases' ? (
                    <>
                        {renderDraftBrowser('release')}

                        <section className="admin-panel admin-panel--editor">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Release Metadata</p>
                                    <h2>{release?.title || 'New Release'}</h2>
                                </div>
                                <div className="admin-button-row">
                                    <button className="admin-button admin-button--danger" disabled={!release} onClick={() => void withBusy('Deleting release', deleteCurrentRelease)}>
                                        <Trash2 /> {releaseSaved ? 'Delete' : 'Discard'}
                                    </button>
                                    <button className="admin-button admin-button--primary" disabled={!canSaveRelease} onClick={() => void withBusy('Saving release', saveRelease)}>
                                        <Save /> Save Release
                                    </button>
                                </div>
                            </div>

                            <div className="admin-form-grid">
                                <div className="admin-field">
                                    <label>Title</label>
                                    <input value={release?.title ?? ''} onChange={(event) => updateReleaseField('title', event.currentTarget.value)} />
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
                                    <label>Subtitle</label>
                                    <input value={release?.subtitle ?? ''} onChange={(event) => updateReleaseField('subtitle', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field admin-field--wide">
                                    <label>Description</label>
                                    <textarea rows={4} value={release?.description ?? ''} onChange={(event) => updateReleaseField('description', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field">
                                    <label>Tags</label>
                                    <input value={releaseTagsText} onChange={(event) => updateReleaseTagsText(event.currentTarget.value)} />
                                </div>
                                <div className="admin-field">
                                    <label>Copyright</label>
                                    <input value={release?.copyright ?? ''} onChange={(event) => updateReleaseField('copyright', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field admin-field--wide">
                                    <label>Links</label>
                                    <textarea rows={3} value={linksText} onChange={(event) => updateLinksText(event.currentTarget.value)} />
                                </div>
                            </div>

                            <div className="admin-subgrid">
                                <div className="admin-artwork-upload">
                                    <div className="admin-artwork-upload__preview">
                                        {releaseArtworkPreviewSrc
                                            ? <img src={releaseArtworkPreviewSrc} alt={release?.artwork?.altText ?? 'Release artwork'} />
                                            : <ListMusic aria-hidden="true" />}
                                    </div>
                                    <div className="admin-artwork-upload__body">
                                        <span>Release Artwork</span>
                                        <strong>{release?.title ? `Attached to ${release.title}` : 'No release selected'}</strong>
                                        <small>{releaseArtworkStatus}</small>
                                        <div className="admin-field">
                                            <label>Upload Image</label>
                                            <input
                                                type="file"
                                                accept="image/jpeg,image/png,image/webp,image/avif"
                                                disabled={!releaseSaved}
                                                onChange={(event) => {
                                                    setReleaseArtworkFile(event.currentTarget.files?.[0]);
                                                }}
                                            />
                                        </div>
                                        <div className="admin-field">
                                            <label>Reuse Existing Image</label>
                                            <select
                                                value=""
                                                disabled={!release || artworkChoices.length === 0}
                                                onChange={(event) => reuseArtworkForRelease(event.currentTarget.value)}
                                            >
                                                <option value="">Choose artwork</option>
                                                {artworkChoices.map((choice) => (
                                                    <option key={choice.value} value={choice.value}>{choice.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="admin-button-row">
                                            <button className="admin-button" disabled={!canUploadReleaseArtwork} onClick={() => void withBusy('Uploading release artwork', uploadReleaseArtwork)}>
                                                <Upload /> Upload
                                            </button>
                                            <button className="admin-button admin-button--danger" disabled={!release || (!release.artwork && !releaseArtworkFile)} onClick={clearReleaseArtwork}>
                                                <Trash2 /> Clear
                                            </button>
                                        </div>
                                    </div>
                                </div>
                                <div className="admin-field">
                                    <label>Credits JSON</label>
                                    <textarea rows={8} value={releaseCreditsText} onChange={(event) => updateReleaseCreditsText(event.currentTarget.value)} />
                                </div>
                            </div>
                        </section>

                        <section className="admin-panel">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Release Tracks</p>
                                    <h2>{releaseTracks.length} Tracks</h2>
                                </div>
                                <div className="admin-button-row">
                                    <button className="admin-button admin-button--danger" disabled={!selectedReleaseTrack} onClick={removeSelectedReleaseTrack}>
                                        <Trash2 /> Remove Track
                                    </button>
                                    <button className="admin-button" disabled={!release || !song || !selectedRecording} onClick={() => void withBusy('Adding to release', addSelectedSongToRelease)}>
                                        <Plus /> Add Loaded Song
                                    </button>
                                </div>
                            </div>

                            <div className="admin-track-list">
                                {releaseTracks.map((track) => {
                                    const sourceSong = songCache[track.songId];
                                    return (
                                        <button
                                            key={track.trackId}
                                            className={`admin-track-row ${selectedReleaseTrack?.trackId === track.trackId ? 'admin-track-row--active' : ''}`}
                                            onClick={() => setSelectedReleaseTrackId(track.trackId)}
                                        >
                                            <span>{track.discNumber}.{track.trackNumber}</span>
                                            <strong>{track.title}</strong>
                                            <span>{sourceSong?.title ?? 'Song'}</span>
                                        </button>
                                    );
                                })}
                            </div>

                            {selectedReleaseTrack ? (
                                <div className="admin-form-grid admin-form-grid--compact">
                                    <div className="admin-field">
                                        <label>Track Title</label>
                                        <input value={selectedReleaseTrack.title} onChange={(event) => updateSelectedReleaseTrackField('title', event.currentTarget.value)} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Disc</label>
                                        <input type="number" value={selectedReleaseTrack.discNumber} onChange={(event) => updateSelectedReleaseTrackField('discNumber', Number(event.currentTarget.value))} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Track</label>
                                        <input type="number" value={selectedReleaseTrack.trackNumber} onChange={(event) => updateSelectedReleaseTrackField('trackNumber', Number(event.currentTarget.value))} />
                                    </div>
                                </div>
                            ) : null}
                        </section>
                    </>
                ) : null}

                {adminRoute === 'songs' ? (
                    <>
                        {renderDraftBrowser('song')}

                        <section className="admin-panel">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Song</p>
                                    <h2>{song?.title || 'New Song'}</h2>
                                </div>
                                <div className="admin-button-row">
                                    <button className="admin-button admin-button--danger" disabled={!song} onClick={() => void withBusy('Deleting song', deleteCurrentSong)}>
                                        <Trash2 /> {songSaved ? 'Delete' : 'Discard'}
                                    </button>
                                    <button className="admin-button admin-button--primary" disabled={!canSaveSong} onClick={() => void withBusy('Saving song', saveSong)}>
                                        <Save /> Save Song
                                    </button>
                                </div>
                            </div>

                            <div className="admin-form-grid">
                                <div className="admin-field">
                                    <label>Title</label>
                                    <input value={song?.title ?? ''} onChange={(event) => updateSongField('title', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field">
                                    <label>Artist</label>
                                    <input value={song?.artistName ?? ''} onChange={(event) => updateSongField('artistName', event.currentTarget.value)} />
                                </div>
                                <div className="admin-field">
                                    <label>Tags</label>
                                    <input value={songTagsText} onChange={(event) => updateSongTagsText(event.currentTarget.value)} />
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
                                    <textarea rows={5} value={songCreditsText} onChange={(event) => updateSongCreditsText(event.currentTarget.value)} />
                                </div>
                            </div>

                            <div className="admin-subgrid">
                                <div className="admin-artwork-upload">
                                    <div className="admin-artwork-upload__preview">
                                        {songArtworkPreviewSrc
                                            ? <img src={songArtworkPreviewSrc} alt={song?.artwork?.altText ?? 'Song artwork'} />
                                            : <ListMusic aria-hidden="true" />}
                                    </div>
                                    <div className="admin-artwork-upload__body">
                                        <span>Song Artwork</span>
                                        <strong>{song?.title ? `Attached to ${song.title}` : 'No song selected'}</strong>
                                        <small>{songArtworkStatus}</small>
                                        <div className="admin-field">
                                            <label>Upload Image</label>
                                            <input
                                                type="file"
                                                accept="image/jpeg,image/png,image/webp,image/avif"
                                                disabled={!songSaved}
                                                onChange={(event) => {
                                                    setSongArtworkFile(event.currentTarget.files?.[0]);
                                                }}
                                            />
                                        </div>
                                        <div className="admin-field">
                                            <label>Reuse Existing Image</label>
                                            <select
                                                value=""
                                                disabled={!song || artworkChoices.length === 0}
                                                onChange={(event) => reuseArtworkForSong(event.currentTarget.value)}
                                            >
                                                <option value="">Choose artwork</option>
                                                {artworkChoices.map((choice) => (
                                                    <option key={choice.value} value={choice.value}>{choice.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="admin-button-row">
                                            <button className="admin-button" disabled={!canUploadSongArtwork} onClick={() => void withBusy('Uploading song artwork', uploadSongArtwork)}>
                                                <Upload /> Upload
                                            </button>
                                            <button className="admin-button admin-button--danger" disabled={!song || (!song.artwork && !songArtworkFile)} onClick={clearSongArtwork}>
                                                <Trash2 /> Clear
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </section>

                        <section className="admin-panel">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Recordings</p>
                                    <h2>{recordings.length} Versions</h2>
                                </div>
                                <div className="admin-button-row">
                                    <button className="admin-button admin-button--danger" disabled={!selectedRecording} onClick={removeSelectedRecording}>
                                        <Trash2 /> Remove
                                    </button>
                                    <button className="admin-button" disabled={!song} onClick={() => void withBusy('Adding recording', addRecording)}>
                                        <Plus /> Recording
                                    </button>
                                </div>
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
                                        <label>Title</label>
                                        <input value={selectedRecording.title} onChange={(event) => updateSelectedRecordingField('title', event.currentTarget.value)} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Version</label>
                                        <input value={selectedRecording.versionTitle ?? ''} onChange={(event) => updateSelectedRecordingField('versionTitle', event.currentTarget.value)} />
                                    </div>
                                    <div className="admin-field">
                                        <label>Version Type</label>
                                        <select value={selectedRecording.versionType} onChange={(event) => updateSelectedRecordingField('versionType', event.currentTarget.value as DraftRecording['versionType'])}>
                                            {VERSION_TYPES.map((versionType) => <option key={versionType} value={versionType}>{versionType}</option>)}
                                        </select>
                                    </div>
                                    <label className="admin-check">
                                        <input type="checkbox" checked={selectedRecording.explicit} onChange={(event) => updateSelectedRecordingField('explicit', event.currentTarget.checked)} />
                                        Explicit
                                    </label>
                                    <div className="admin-field">
                                        <label>ISRC</label>
                                        <input value={selectedRecording.isrc ?? ''} onChange={(event) => updateSelectedRecordingField('isrc', event.currentTarget.value)} />
                                    </div>
                                </div>
                            ) : null}
                        </section>
                    </>
                ) : null}

                {adminRoute === 'encoding' ? (
                    <>
                        {renderDraftBrowser('song')}

                        <section className="admin-panel">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Source Master</p>
                                    <h2>{song?.title ?? 'Select A Song'}</h2>
                                </div>
                                <FileAudio />
                            </div>

                            <div className="admin-source-master">
                                <div>
                                    <span>Song</span>
                                    <strong>{song?.title ?? 'None selected'}</strong>
                                </div>
                                <div>
                                    <span>Recording</span>
                                    <strong>{selectedRecording?.title ?? 'None selected'}</strong>
                                </div>
                                <div>
                                    <span>Master</span>
                                    <strong>{masterFileStatus}</strong>
                                </div>
                                <div>
                                    <span>Latest Encoding Run</span>
                                    <strong className={jobClass(currentRecordingJob?.status)}>{latestEncodingStatus}</strong>
                                </div>
                            </div>

                            <div className="admin-track-list admin-track-list--compact">
                                {recordings.length === 0 ? (
                                    <div className="admin-empty-state">No recordings for this song.</div>
                                ) : recordings.map((recording) => {
                                    const job = latestJob(recording, jobDetails);
                                    return (
                                        <button
                                            key={recording.recordingId}
                                            className={`admin-track-row ${selectedRecording?.recordingId === recording.recordingId ? 'admin-track-row--active' : ''}`}
                                            type="button"
                                            onClick={() => setSelectedRecordingId(recording.recordingId)}
                                        >
                                            <span><Disc3 aria-hidden="true" /></span>
                                            <strong>{recording.title}</strong>
                                            <span>{recording.versionType}</span>
                                            <span className={jobClass(job?.status)}>{job?.status ?? 'not encoded'}</span>
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="admin-form-grid admin-form-grid--compact">
                                <div className="admin-field admin-field--wide">
                                    <label>Lossless Master</label>
                                    <input
                                        type="file"
                                        accept=".wav,.wave,.aif,.aiff,.flac,audio/wav,audio/wave,audio/x-wav,audio/aiff,audio/x-aiff,audio/flac"
                                        disabled={!songSaved || !selectedRecording}
                                        onChange={(event) => setMasterFile(event.currentTarget.files?.[0])}
                                    />
                                </div>
                                <div className="admin-button-row admin-field--wide">
                                    <button className="admin-button" disabled={!canUploadMaster} onClick={() => void withBusy('Uploading master', uploadMaster)}>
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
                                    <button className="admin-button admin-button--primary" disabled={!canStartEncode} onClick={() => void withBusy('Starting encode', startEncode)}>
                                        <CloudUpload /> Start Encode
                                    </button>
                                    <button className="admin-button" disabled={!song} onClick={() => void withBusy('Refreshing jobs', () => refreshKnownJobs())}>
                                        <RefreshCw /> Refresh Jobs
                                    </button>
                                </div>
                            </div>
                        </section>

                        <section className="admin-panel">
                            <div className="admin-panel__header">
                                <div>
                                    <p className="admin-kicker">Encoding Runs</p>
                                    <h2>Recent Jobs</h2>
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
                                    <div><span>Visits</span><strong>{formatCount(rumSummary.visits)}</strong></div>
                                    <div><span>Page Views</span><strong>{formatCount(rumSummary.pageViews)}</strong></div>
                                    <div><span>Bounce</span><strong>{formatPercent(rumSummary.bounceRate)}</strong></div>
                                    <div><span>Playback Sessions</span><strong>{formatCount(rumSummary.uniquePlaybackSessions)}</strong></div>
                                    <div><span>Starts</span><strong>{formatCount(rumSummary.playStarts)}</strong></div>
                                    <div><span>Completes</span><strong>{formatPercent(rumSummary.playCompletionRate)}</strong></div>
                                    <div><span>Player Errors</span><strong>{formatCount(rumSummary.playerErrors)}</strong></div>
                                    <div><span>RUM JS Errors</span><strong>{formatCount(rumSummary.standard.jsErrors)}</strong></div>
                                    <div><span>Backend Plays</span><strong>{formatCount(rumSummary.backendPlayEvents.tenSecondPlays)}</strong></div>
                                    <div><span>Backend 25%</span><strong>{formatCount(rumSummary.backendPlayEvents.twentyFivePercentPlays)}</strong></div>
                                    <div><span>Backend Complete</span><strong>{formatPercent(rumSummary.backendPlayEvents.playCompletionRate)}</strong></div>
                                </div>

                                <div className="admin-rum-grid">
                                    <div>
                                        <h3>Backend Top Songs</h3>
                                        {rumSummary.backendPlayEvents.songs.slice(0, 8).map((song) => (
                                            <div className="admin-stat-row" key={`${song.songId}/${song.recordingId}`}>
                                                <span>{song.title ?? song.songId}</span>
                                                <strong>{formatCount(song.tenSecondPlays)}</strong>
                                            </div>
                                        ))}
                                    </div>
                                    <div>
                                        <h3>Backend Play Events</h3>
                                        {rumSummary.backendPlayEvents.events.map((event) => (
                                            <div className="admin-stat-row" key={event.eventType}>
                                                <span>{event.eventType}</span>
                                                <strong>{formatCount(event.count)}</strong>
                                            </div>
                                        ))}
                                    </div>
                                    <div>
                                        <h3>Traffic Sources</h3>
                                        {rumSummary.referrers.slice(0, 8).map((referrer) => (
                                            <div className="admin-stat-row" key={referrer.value}>
                                                <span>{referrer.value}</span>
                                                <strong>{formatCount(referrer.count)}</strong>
                                            </div>
                                        ))}
                                    </div>
                                    <div>
                                        <h3>Top Pages</h3>
                                        {rumSummary.pages.slice(0, 8).map((page) => (
                                            <div className="admin-stat-row" key={page.pagePath}>
                                                <span>{page.pagePath}</span>
                                                <strong>{formatCount(page.views)} / {formatPercent(page.bounceRate)}</strong>
                                            </div>
                                        ))}
                                    </div>
                                    <div>
                                        <h3>Player Events</h3>
                                        {rumSummary.events.map((event) => (
                                            <div className="admin-stat-row" key={event.eventType}>
                                                <span>{event.eventType}</span>
                                                <strong>{formatCount(event.count)}</strong>
                                            </div>
                                        ))}
                                    </div>
                                    <div>
                                        <h3>Top Tracks</h3>
                                        {rumSummary.tracks.slice(0, 8).map((track) => (
                                            <div className="admin-stat-row" key={`${track.releaseId}/${track.trackId}`}>
                                                <span>{track.trackId}</span>
                                                <strong>{formatCount(track.playStarts)}</strong>
                                            </div>
                                        ))}
                                    </div>
                                    <div>
                                        <h3>RUM Standard</h3>
                                        <div className="admin-stat-row">
                                            <span>page_view_event</span>
                                            <strong>{formatCount(rumSummary.standard.pageViews)}</strong>
                                        </div>
                                        <div className="admin-stat-row">
                                            <span>performance_navigation_event</span>
                                            <strong>{formatCount(rumSummary.standard.navigationEvents)}</strong>
                                        </div>
                                        <div className="admin-stat-row">
                                            <span>http_event</span>
                                            <strong>{formatCount(rumSummary.standard.httpEvents)}</strong>
                                        </div>
                                    </div>
                                    <div>
                                        <h3>Browsers</h3>
                                        {rumSummary.browsers.slice(0, 8).map((browser) => (
                                            <div className="admin-stat-row" key={browser.value}>
                                                <span>{browser.value}</span>
                                                <strong>{formatCount(browser.count)}</strong>
                                            </div>
                                        ))}
                                    </div>
                                    <div>
                                        <h3>Devices</h3>
                                        {rumSummary.devices.slice(0, 8).map((device) => (
                                            <div className="admin-stat-row" key={device.value}>
                                                <span>{device.value}</span>
                                                <strong>{formatCount(device.count)}</strong>
                                            </div>
                                        ))}
                                    </div>
                                    <div>
                                        <h3>Countries</h3>
                                        {rumSummary.countries.slice(0, 8).map((country) => (
                                            <div className="admin-stat-row" key={country.value}>
                                                <span>{country.value}</span>
                                                <strong>{formatCount(country.count)}</strong>
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

            </main>
        </div>
    );
}
