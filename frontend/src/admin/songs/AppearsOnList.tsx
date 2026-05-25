import { ExternalLink, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { nextReleaseTrack, sortedReleaseTracks } from '../admin-helpers';
import { useCatalog, useReleasesContainingSong } from '../catalog-store';
import { useNotifications } from '../notifications';
import type { DraftRecording, DraftSong } from '../admin-types';
import { EmptyState } from '../shared/EmptyState';
import { ReleasePicker } from '../shared/ReleasePicker';
import { useBusy } from '../shared/useBusy';

interface Props {
    song: DraftSong;
    isSavedSong: boolean;
    onNavigateRelease: (releaseId: string) => void;
}

function defaultRecording(song: DraftSong, jobs: Record<string, { status?: string }>): DraftRecording | undefined {
    if (song.recordings.length === 0) return undefined;
    const ranked = song.recordings.map((r) => {
        const jobId = r.encodeJobIds?.[r.encodeJobIds.length - 1];
        const job = jobId ? jobs[jobId] : undefined;
        return { r, ok: job?.status === 'succeeded' };
    });
    const succeeded = ranked.filter((entry) => entry.ok);
    if (succeeded.length > 0) return succeeded[succeeded.length - 1].r;
    return song.recordings[song.recordings.length - 1];
}

export function AppearsOnList({ song, isSavedSong, onNavigateRelease }: Props) {
    const { jobs, saveRelease } = useCatalog();
    const { notify } = useNotifications();
    const { run } = useBusy();
    const containingReleases = useReleasesContainingSong(song.songId);
    const [pickerOpen, setPickerOpen] = useState(false);

    const excludeIds = useMemo(() => new Set(containingReleases.map((release) => release.releaseId)), [containingReleases]);

    const catalogState = useCatalog();

    async function pickRelease(releaseObj: { releaseId: string }) {
        await run('Adding song to release', async () => {
            const release = catalogState.releases[releaseObj.releaseId];
            if (!release) return;
            if (release.tracks.some((track) => track.songId === song.songId)) {
                notify('That release already contains this song.');
                setPickerOpen(false);
                return;
            }
            const recording = defaultRecording(song, jobs);
            if (!recording) {
                notify('Add at least one recording before placing this song on a release.', 'error');
                setPickerOpen(false);
                return;
            }
            const next = nextReleaseTrack(release, song, recording);
            const updated = { ...release, tracks: [...release.tracks, next], updatedAt: new Date().toISOString() };
            await saveRelease(updated, { isNew: false });
            notify(`Added to ${release.title}`);
            setPickerOpen(false);
        });
    }

    return (
        <section className="admin-section">
            <header className="admin-section__header">
                <div>
                    <p className="admin-kicker">Appears on</p>
                    <h3>{containingReleases.length} release{containingReleases.length === 1 ? '' : 's'}</h3>
                </div>
                <button
                    type="button"
                    className="admin-button"
                    onClick={() => setPickerOpen(true)}
                    disabled={!isSavedSong || song.recordings.length === 0}
                    title={!isSavedSong ? 'Save the song first' : song.recordings.length === 0 ? 'Add a recording first' : undefined}
                >
                    <Plus aria-hidden="true" /> Add to release
                </button>
            </header>

            {containingReleases.length === 0 ? (
                <EmptyState
                    icon={ExternalLink}
                    title="Not on any release yet"
                    body="Add this song to one or more releases. Songs can appear on multiple releases."
                />
            ) : (
                <ul className="admin-appears-on">
                    {containingReleases.map((release) => {
                        const tracks = sortedReleaseTracks(release).filter((track) => track.songId === song.songId);
                        return (
                            <li key={release.releaseId}>
                                <button
                                    type="button"
                                    className="admin-appears-on__row"
                                    onClick={() => onNavigateRelease(release.releaseId)}
                                >
                                    <strong>{release.title || release.releaseId}</strong>
                                    <span>{release.releaseKind} · {release.releaseDate ?? 'no date'}</span>
                                    <span>{tracks.map((track) => `#${track.trackNumber}`).join(', ')}</span>
                                    <ExternalLink aria-hidden="true" />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            {pickerOpen ? (
                <ReleasePicker
                    excludeReleaseIds={excludeIds}
                    onClose={() => setPickerOpen(false)}
                    onPick={(release) => void pickRelease(release)}
                />
            ) : null}
        </section>
    );
}
