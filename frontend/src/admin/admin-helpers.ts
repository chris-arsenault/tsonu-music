import type { CatalogArtwork, ReleaseKind, ReleaseStatus, StableId } from '../catalog/media-catalog';
import { AdminApiError } from './admin-api';
import type {
    DraftRecording,
    RecordingFile,
    DraftRelease,
    DraftReleaseTrack,
    DraftSong,
    EncodeJob,
    JsonValue,
} from './admin-types';

export const RELEASE_KINDS: ReleaseKind[] = ['album', 'ep', 'single', 'demo', 'preview', 'collection', 'prerelease'];
export const RELEASE_STATUSES: ReleaseStatus[] = ['official', 'demo', 'promo', 'prerelease', 'bootleg'];
export const VERSION_TYPES = ['studio_master', 'album_master', 'single_master', 'demo', 'preview', 'live', 'alternate', 'remaster'] as const satisfies ReadonlyArray<Exclude<DraftRecording['versionType'], ''>>;

export function optionalText(value: string | undefined): string | undefined {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : undefined;
}

export function slugify(value: string): string {
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'untitled';
}

export function stableId(prefix: 'song' | 'recording' | 'release' | 'track' | 'asset', value: string): StableId {
    return `${prefix}_${slugify(value).replace(/-/g, '_')}` as StableId;
}

export function songIdFromKey(key: string): string {
    return key.replace(/^draft\/songs\//, '').replace(/\.json$/, '');
}

export function releaseIdFromKey(key: string): string {
    return key.replace(/^draft\/releases\//, '').replace(/\.json$/, '');
}

export function jobIdFromKey(key: string): string {
    return key.replace(/^jobs\//, '').replace(/^draft\/jobs\//, '').replace(/\.json$/, '');
}

export function titleFromId(id: string, prefix: string): string {
    return id
        .replace(new RegExp(`^${prefix}_`), '')
        .split(/[_-]+/)
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(' ') || 'Untitled';
}

export function uniqueStableId(
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

export function temporaryDraftId(prefix: 'song' | 'release'): StableId {
    return stableId(prefix, `draft ${Date.now().toString(36)}`);
}

export function newDraftSong(songId: StableId): DraftSong {
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

export function isTemporaryRecordingId(recordingId: string): boolean {
    return recordingId.startsWith('recording_pending_');
}

export function newRecording(song: DraftSong): DraftRecording {
    const number = song.recordings.length + 1;
    const seed = `${song.slug || song.songId.replace(/^song_/, '') || 'recording'}_${Date.now().toString(36)}_${number}`;
    return {
        recordingId: stableId('recording', `pending_${seed}`),
        slug: '',
        title: '',
        versionType: '',
        explicit: false,
        encodeJobIds: [],
    };
}

export function recordingMetadataError(recording: DraftRecording): string | undefined {
    const title = recording.title.trim();
    if (!title) {
        return 'Add a recording title before saving.';
    }
    if (!recording.versionType) {
        return `Choose a version type for "${title}".`;
    }
    return undefined;
}

export function draftSongRecordingsError(song: DraftSong): string | undefined {
    for (const recording of song.recordings) {
        const error = recordingMetadataError(recording);
        if (error) return error;
    }
    return undefined;
}

function recordingIdBase(song: DraftSong, recording: DraftRecording): string {
    const songSlug = slugify(song.slug || song.title || song.songId.replace(/^song_/, ''));
    const recordingSlug = slugify(recording.title);
    if (recordingSlug === songSlug || recordingSlug.startsWith(`${songSlug}-`)) {
        return recordingSlug;
    }
    return `${songSlug}_${recordingSlug}`;
}

function uniqueRecordingId(song: DraftSong, recording: DraftRecording, usedIds: Set<string>): StableId {
    const base = stableId('recording', recordingIdBase(song, recording));
    let candidate = base;
    let index = 2;
    while (usedIds.has(candidate)) {
        candidate = `${base}_${index}` as StableId;
        index += 1;
    }
    return candidate;
}

function recordingHasStorage(recording: DraftRecording): boolean {
    return Boolean(recording.sourceMaster || recording.files?.length || recording.encodeJobIds?.length);
}

export function prepareDraftSongForSave(song: DraftSong): DraftSong {
    const usedRecordingIds = new Set(
        song.recordings
            .map((recording) => recording.recordingId)
            .filter((recordingId) => !isTemporaryRecordingId(recordingId)),
    );

    return {
        ...song,
        recordings: song.recordings.map((recording) => {
            const title = recording.title.trim();
            const recordingId = isTemporaryRecordingId(recording.recordingId) && title && !recordingHasStorage(recording)
                ? uniqueRecordingId(song, recording, usedRecordingIds)
                : recording.recordingId;
            usedRecordingIds.add(recordingId);
            const recordingWithoutLegacy = { ...recording } as DraftRecording & { encodeOutput?: unknown };
            delete recordingWithoutLegacy.encodeOutput;
            return {
                ...recordingWithoutLegacy,
                recordingId,
                slug: recording.slug.trim() || (title ? slugify(title) : ''),
                title,
                versionTitle: optionalText(recording.versionTitle),
                artistName: optionalText(recording.artistName),
                description: optionalText(recording.description),
                aiAssistedComposition: recording.aiAssistedComposition || undefined,
                encodeJobIds: recording.encodeJobIds ?? [],
                files: currentRecordingFiles(recording),
            };
        }),
    };
}

export function prepareDraftSongRecordingForSave(
    song: DraftSong,
    recordingId: StableId,
): { song: DraftSong; recording: DraftRecording } {
    const targetIndex = song.recordings.findIndex((recording) => recording.recordingId === recordingId);
    if (targetIndex < 0) {
        throw new Error(`Recording not found: ${recordingId}`);
    }
    const preparedSong = prepareDraftSongForSave(song);
    const preparedRecording = preparedSong.recordings[targetIndex];
    if (!preparedRecording) {
        throw new Error(`Recording not found: ${recordingId}`);
    }
    return { song: preparedSong, recording: preparedRecording };
}

export function newDraftRelease(releaseId: StableId): DraftRelease {
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

export function recordingEncodeStatus(
    recording: DraftRecording | undefined,
    jobDetails: Record<string, EncodeJob>,
): EncodeJob['status'] | 'missing' {
    if (isRecordingEncoded(recording)) return 'succeeded';
    const job = latestJob(recording, jobDetails);
    if (!job || job.status === 'succeeded') return 'missing';
    return job.status;
}

export function recordingEncodedAt(recording: DraftRecording | undefined): string | undefined {
    return currentRecordingFiles(recording).find((file) => file.createdAt)?.createdAt;
}

export function isRecordingEncoded(recording: DraftRecording | undefined): boolean {
    if (!recording) return false;
    const files = currentRecordingFiles(recording);
    const hasFile = (kind: string, quality?: string) => files.some((file) => (
        file.kind === kind
        && canonicalRecordingFileQuality(file.quality) === quality
        && Boolean(file.fileId)
    ));
    return (
        hasFile('hls-master')
        && hasFile('hls-rendition', 'aac-192')
        && hasFile('hls-rendition', 'aac-320')
    );
}

export function currentRecordingFiles(recording: DraftRecording | undefined): RecordingFile[] {
    if (!recording) return [];
    const prefix = `recordings/${recording.recordingId}/files/`;
    return (recording.files ?? [])
        .filter((file) => file.path.startsWith(prefix))
        .map(canonicalRecordingFile);
}

function canonicalRecordingFile(file: RecordingFile): RecordingFile {
    const quality = canonicalRecordingFileQuality(file.quality);
    return quality === file.quality ? file : { ...file, quality };
}

function canonicalRecordingFileQuality(
    quality: RecordingFile['quality'] | string | undefined,
): RecordingFile['quality'] | undefined {
    if (quality === 'aac192') return 'aac-192';
    if (quality === 'aac320') return 'aac-320';
    if (quality === 'aac-192' || quality === 'aac-320' || quality === 'flac-lossless') {
        return quality;
    }
    return undefined;
}

function trackSlugForRecording(
    release: DraftRelease,
    song: DraftSong,
    recording: DraftRecording,
): string {
    const existingSlugs = new Set(release.tracks.map((track) => track.slug));
    let base = song.slug;

    if (existingSlugs.has(base)) {
        const recordingSlug = recording.slug.trim();
        const versionSlug = slugify(recording.versionTitle || recording.title || recording.recordingId);
        base = recordingSlug && recordingSlug !== song.slug ? recordingSlug : `${song.slug}-${versionSlug}`;
    }

    let candidate = base;
    let index = 2;
    while (existingSlugs.has(candidate)) {
        candidate = `${base}-${index}`;
        index += 1;
    }
    return candidate;
}

function trackTitleForRecording(
    release: DraftRelease,
    song: DraftSong,
    recording: DraftRecording,
): string {
    const duplicateSong = release.tracks.some((track) => track.songId === song.songId);
    if (duplicateSong && recording.versionTitle) {
        return `${song.title} (${recording.versionTitle})`;
    }
    if (duplicateSong && recording.title && recording.title !== song.title) {
        return recording.title;
    }
    return song.title;
}

export function nextReleaseTrack(release: DraftRelease, song: DraftSong, recording: DraftRecording): DraftReleaseTrack {
    const nextNumber = Math.max(0, ...release.tracks.map((track) => track.trackNumber || 0)) + 1;
    const slug = trackSlugForRecording(release, song, recording);
    const base = `${release.slug}_${String(nextNumber).padStart(2, '0')}_${slug}`;
    return {
        trackId: stableId('track', base),
        songId: song.songId,
        recordingId: recording.recordingId,
        discNumber: 1,
        trackNumber: nextNumber,
        slug,
        title: trackTitleForRecording(release, song, recording),
        explicit: recording.explicit,
        isrc: recording.isrc,
    };
}

export function normalizeReleaseTrackSlugs(release: DraftRelease): DraftRelease {
    const used = new Set<string>();
    let changed = false;
    const tracks = release.tracks.map((track) => {
        const base = slugify(track.slug || track.title || track.trackId);
        const slug = uniqueReleaseTrackSlug(base, track, used);
        used.add(slug);
        if (slug === track.slug) return track;
        changed = true;
        return { ...track, slug };
    });
    return changed ? { ...release, tracks } : release;
}

export function regenerateReleaseTrackIds(release: DraftRelease): DraftRelease {
    const withTitleSlugs = normalizeReleaseTrackSlugs({
        ...release,
        tracks: release.tracks.map((track) => ({
            ...track,
            slug: slugify(track.title),
        })),
    });
    return {
        ...withTitleSlugs,
        tracks: withTitleSlugs.tracks.map((track) => ({
            ...track,
            trackId: stableId('track', `${release.slug}_${String(track.trackNumber).padStart(2, '0')}_${track.slug}`),
        })),
    };
}

function uniqueReleaseTrackSlug(
    base: string,
    track: DraftReleaseTrack,
    used: Set<string>,
): string {
    if (!used.has(base)) return base;
    const disambiguated = disambiguatedReleaseTrackSlug(base, track);
    let candidate = disambiguated;
    let index = 2;
    while (used.has(candidate)) {
        candidate = `${disambiguated}-${index}`;
        index += 1;
    }
    return candidate;
}

function disambiguatedReleaseTrackSlug(base: string, track: DraftReleaseTrack): string {
    const recordingSlug = slugify(track.recordingId.replace(/^recording_/, '').replace(/_/g, '-'));
    if (recordingSlug && recordingSlug !== base) return recordingSlug;
    return `${base}-${track.trackNumber || 2}`;
}

export function sortedReleaseTracks(release: DraftRelease | undefined): DraftReleaseTrack[] {
    return [...(release?.tracks ?? [])].sort((left, right) => (
        left.discNumber - right.discNumber || left.trackNumber - right.trackNumber || left.title.localeCompare(right.title)
    ));
}

export function latestJobId(recording: DraftRecording | undefined): StableId | undefined {
    return recording?.encodeJobIds?.[recording.encodeJobIds.length - 1];
}

export function latestJob(recording: DraftRecording | undefined, jobDetails: Record<string, EncodeJob>): EncodeJob | undefined {
    const jobId = latestJobId(recording);
    return jobId ? jobDetails[jobId] : undefined;
}

export function formatLinks(links: DraftRelease['links']): string {
    return links?.map((link) => `${link.label} | ${link.url}`).join('\n') ?? '';
}

export function parseLinks(value: string): DraftRelease['links'] {
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

export function parseTags(value: string): string[] | undefined {
    const tags = value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
    return tags.length > 0 ? tags : undefined;
}

export function parseOptionalJson(value: string): JsonValue | undefined {
    const trimmed = value.trim();
    return trimmed ? JSON.parse(trimmed) as JsonValue : undefined;
}

/**
 * Backend validation requires upload filenames to match /^[A-Za-z0-9._-]+$/.
 * Strip path components, replace any disallowed character (including spaces)
 * with an underscore, collapse consecutive underscores, and trim them from
 * the edges. Falls back to "file" if the result is empty.
 */
export function sanitizeFilename(name: string): string {
    const base = name.split(/[/\\]/).pop() ?? name;
    const cleaned = base
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/_+\./g, '.')
        .replace(/^_+|_+$/g, '');
    return cleaned || 'file';
}

export function readArtworkDimensions(file: File): Promise<{ width: number; height: number }> {
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

export function formatPercent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

export function formatCount(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
}

export function formatBytes(bytes: number | undefined): string {
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

export function formatRelativeTime(iso: string | undefined): string {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const diffMs = Date.now() - date.getTime();
    const diffSec = Math.round(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 48) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    return date.toLocaleDateString();
}

export function errorMessage(error: unknown): string {
    if (error instanceof AdminApiError) {
        if (error.status === 409) {
            return 'A catalog record with that slug already exists. Check for duplicate release, song, or track slugs before saving or publishing.';
        }

        return error.code
            ? `${error.code}: ${error.message}`
            : `${error.status}: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}

export type ArtworkChoice = {
    value: string;
    label: string;
    artwork: CatalogArtwork;
};

export function artworkChoiceValue(kind: 'release' | 'song', id: StableId, artwork: CatalogArtwork): string {
    return `${kind}:${id}:${artwork.assetId}:${artwork.sources[0]?.path ?? ''}`;
}

export function collectArtworkChoices(
    releases: DraftRelease[],
    songs: DraftSong[],
): ArtworkChoice[] {
    const choices = new Map<string, ArtworkChoice>();
    for (const draft of releases) {
        if (!draft.artwork) continue;
        const value = artworkChoiceValue('release', draft.releaseId, draft.artwork);
        if (!choices.has(value)) {
            choices.set(value, {
                value,
                label: `Release: ${draft.title || titleFromId(draft.releaseId, 'release')}`,
                artwork: draft.artwork,
            });
        }
    }
    for (const draft of songs) {
        if (!draft.artwork) continue;
        const value = artworkChoiceValue('song', draft.songId, draft.artwork);
        if (!choices.has(value)) {
            choices.set(value, {
                value,
                label: `Song: ${draft.title || titleFromId(draft.songId, 'song')}`,
                artwork: draft.artwork,
            });
        }
    }
    return [...choices.values()].sort((left, right) => left.label.localeCompare(right.label));
}
