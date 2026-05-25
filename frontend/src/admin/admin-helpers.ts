import type { CatalogArtwork, ReleaseKind, ReleaseStatus, StableId } from '../catalog/media-catalog';
import { AdminApiError } from './admin-api';
import type {
    DraftRecording,
    DraftRelease,
    DraftReleaseTrack,
    DraftSong,
    EncodeJob,
    JsonValue,
} from './admin-types';

export const RELEASE_KINDS: ReleaseKind[] = ['album', 'ep', 'single', 'demo', 'preview', 'collection', 'prerelease'];
export const RELEASE_STATUSES: ReleaseStatus[] = ['official', 'demo', 'promo', 'prerelease', 'bootleg'];
export const VERSION_TYPES: DraftRecording['versionType'][] = ['studio_master', 'album_master', 'single_master', 'demo', 'preview', 'live', 'alternate', 'remaster'];

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

export function newRecording(song: DraftSong): DraftRecording {
    const number = song.recordings.length + 1;
    const base = `${song.slug || 'recording'}_${number === 1 ? 'demo' : `version_${number}`}`;
    return {
        recordingId: stableId('recording', base),
        slug: slugify(base),
        title: `${song.title || 'Recording'} ${number === 1 ? 'Demo' : `Version ${number}`}`,
        versionTitle: number === 1 ? 'Demo' : `Version ${number}`,
        versionType: number === 1 ? 'demo' : 'alternate',
        explicit: false,
        encodeJobIds: [],
    };
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

export function nextReleaseTrack(release: DraftRelease, song: DraftSong, recording: DraftRecording): DraftReleaseTrack {
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
            return 'A draft with that title already exists. Open it from the draft list, or change the title before saving a new draft.';
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
