import { ExternalLink, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
    isRecordingEncoded,
    isTemporaryRecordingId,
    nextReleaseTrack,
    recordingEncodeStatus,
    sortedReleaseTracks,
} from '../admin-helpers';
import { useCatalog, useReleasesContainingSong } from '../catalog-store';
import { useNotifications } from '../notifications';
import type { DraftRecording, DraftSong } from '../admin-types';
import { EmptyState } from '../shared/EmptyState';
import { ReleasePicker } from '../shared/ReleasePicker';
import { StatusPill } from '../shared/StatusPill';
import { useBusy } from '../shared/useBusy';

interface Props {
    song: DraftSong;
    isSavedSong: boolean;
    onNavigateRelease: (releaseId: string) => void;
}

function defaultRecording(song: DraftSong): DraftRecording | undefined {
    if (song.recordings.length === 0) return undefined;
    const savedRecordings = song.recordings.filter((recording) => !isTemporaryRecordingId(recording.recordingId));
    if (savedRecordings.length === 0) return undefined;
    const encoded = savedRecordings.filter(isRecordingEncoded);
    if (encoded.length > 0) return encoded[encoded.length - 1];
    return song.recordings[song.recordings.length - 1];
}

export function AppearsOnList({ song, isSavedSong, onNavigateRelease }: Props) {
    const { jobs, releases, saveRelease } = useCatalog();
    const { notify } = useNotifications();
    const { run } = useBusy();
    const containingReleases = useReleasesContainingSong(song.songId);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [selectedRecordingId, setSelectedRecordingId] = useState<string>();

    const selectableRecordings = useMemo(
        () => song.recordings.filter((recording) => !isTemporaryRecordingId(recording.recordingId)),
        [song.recordings],
    );
    const selectedRecording = selectableRecordings.find((recording) => recording.recordingId === selectedRecordingId)
        ?? defaultRecording({ ...song, recordings: selectableRecordings });

    useEffect(() => {
        if (selectedRecording && selectedRecording.recordingId === selectedRecordingId) return;
        setSelectedRecordingId(selectedRecording?.recordingId);
    }, [selectedRecording, selectedRecordingId]);

    async function pickRelease(releaseObj: { releaseId: string }) {
        await run('Adding song to release', async () => {
            const release = releases[releaseObj.releaseId];
            if (!release) return;
            const recording = selectedRecording;
            if (!recording) {
                notify('Save a recording before placing this song on a release.', 'error');
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
                <div className="admin-button-row">
                    <div className="admin-field">
                        <label>Version</label>
                        <select
                            value={selectedRecording?.recordingId ?? ''}
                            disabled={!isSavedSong || selectableRecordings.length === 0}
                            onChange={(event) => setSelectedRecordingId(event.currentTarget.value)}
                        >
                            {selectableRecordings.length === 0 ? <option value="">No saved recordings</option> : null}
                            {selectableRecordings.map((recording) => (
                                <option key={recording.recordingId} value={recording.recordingId}>
                                    {recording.versionTitle || recording.title || recording.recordingId}
                                </option>
                            ))}
                        </select>
                    </div>
                    {selectedRecording ? <StatusPill kind="encode" value={recordingEncodeStatus(selectedRecording, jobs)} /> : null}
                    <button
                        type="button"
                        className="admin-button"
                        onClick={() => setPickerOpen(true)}
                        disabled={!isSavedSong || !selectedRecording}
                        title={!isSavedSong ? 'Save the song first' : !selectedRecording ? 'Save a recording first' : undefined}
                    >
                        <Plus aria-hidden="true" /> Add to release
                    </button>
                </div>
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
                    onClose={() => setPickerOpen(false)}
                    onPick={(release) => void pickRelease(release)}
                />
            ) : null}
        </section>
    );
}
