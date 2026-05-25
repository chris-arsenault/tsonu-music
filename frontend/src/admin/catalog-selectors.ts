import type { StableId } from '../catalog/media-catalog';
import type { DraftRelease, DraftSong, EncodeJob } from './admin-types';

export interface PublishCheck {
    label: string;
    ok: boolean;
}

export interface PublishReadiness {
    checks: PublishCheck[];
    canPublish: boolean;
    trackJobIds: Record<StableId, StableId>;
}

export function releasesContainingSong(
    releases: Record<string, DraftRelease>,
    songId: string,
): DraftRelease[] {
    return Object.values(releases).filter((release) =>
        release.tracks.some((track) => track.songId === songId),
    );
}

export interface ReleaseGroup {
    release: DraftRelease | undefined;
    songs: DraftSong[];
}

export function songsGroupedByRelease(
    songs: Record<string, DraftSong>,
    releases: Record<string, DraftRelease>,
): ReleaseGroup[] {
    const songsByRelease = new Map<string, DraftSong[]>();
    const placedSongIds = new Set<string>();
    const releaseList = Object.values(releases).sort((a, b) => {
        const dateA = a.releaseDate || '';
        const dateB = b.releaseDate || '';
        return dateB.localeCompare(dateA);
    });
    for (const release of releaseList) {
        const list: DraftSong[] = [];
        for (const track of release.tracks) {
            const song = songs[track.songId];
            if (song && !list.some((existing) => existing.songId === song.songId)) {
                list.push(song);
                placedSongIds.add(song.songId);
            }
        }
        if (list.length > 0) {
            songsByRelease.set(release.releaseId, list);
        }
    }
    const groups: ReleaseGroup[] = [];
    for (const release of releaseList) {
        const list = songsByRelease.get(release.releaseId);
        if (list) {
            groups.push({ release, songs: list });
        }
    }
    const unreleased = Object.values(songs)
        .filter((song) => !placedSongIds.has(song.songId))
        .sort((a, b) => a.title.localeCompare(b.title));
    if (unreleased.length > 0) {
        groups.push({ release: undefined, songs: unreleased });
    }
    return groups;
}

export function unreleasedSongs(
    songs: Record<string, DraftSong>,
    releases: Record<string, DraftRelease>,
): DraftSong[] {
    const placed = new Set<string>();
    for (const release of Object.values(releases)) {
        for (const track of release.tracks) {
            placed.add(track.songId);
        }
    }
    return Object.values(songs)
        .filter((song) => !placed.has(song.songId))
        .sort((a, b) => a.title.localeCompare(b.title));
}

export function publishReadinessFor(
    release: DraftRelease | undefined,
    songs: Record<string, DraftSong>,
    jobs: Record<string, EncodeJob>,
): PublishReadiness {
    const checks: PublishCheck[] = [
        { label: 'Release date', ok: Boolean(release?.releaseDate) },
        { label: 'Artwork', ok: Boolean(release?.artwork) },
        { label: 'Tracks', ok: (release?.tracks.length ?? 0) > 0 },
    ];
    const trackJobIds: Record<StableId, StableId> = {};
    let allEncoded = (release?.tracks.length ?? 0) > 0;
    for (const track of release?.tracks ?? []) {
        const song = songs[track.songId];
        const recording = song?.recordings.find((r) => r.recordingId === track.recordingId);
        const latestId = recording?.encodeJobIds?.[recording.encodeJobIds.length - 1];
        const latestJob = latestId ? jobs[latestId] : undefined;
        if (latestId && latestJob?.status === 'succeeded') {
            trackJobIds[track.trackId] = latestId;
        } else {
            allEncoded = false;
        }
    }
    checks.push({ label: 'Successful encodes', ok: allEncoded });
    return {
        checks,
        canPublish: checks.every((c) => c.ok),
        trackJobIds,
    };
}
