import { Music2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { StableId } from '../../catalog/media-catalog';
import { useCatalog } from '../catalog-store';
import { latestJobId } from '../admin-helpers';
import type { DraftRecording, DraftSong } from '../admin-types';
import { PickerDialog } from './PickerDialog';
import { StatusPill } from './StatusPill';

interface Props {
    onPick: (selection: { song: DraftSong; recording: DraftRecording }) => void;
    onClose: () => void;
    filter?: (song: DraftSong) => boolean;
    title?: string;
    confirmLabel?: string;
    onRequestCreateSong?: (query: string) => void;
}

function pickDefaultRecording(song: DraftSong, jobs: Record<string, { status?: string }>): DraftRecording | undefined {
    if (song.recordings.length === 0) return undefined;
    const succeeded = song.recordings.filter((r) => {
        const id = latestJobId(r);
        return id ? jobs[id]?.status === 'succeeded' : false;
    });
    if (succeeded.length > 0) return succeeded[succeeded.length - 1];
    return song.recordings[song.recordings.length - 1];
}

export function SongPicker({
    onPick,
    onClose,
    filter,
    title = 'Add a song',
    confirmLabel = 'Add to release',
    onRequestCreateSong,
}: Props) {
    const { songs, jobs } = useCatalog();
    const [query, setQuery] = useState('');
    const [selectedSongId, setSelectedSongId] = useState<StableId>();
    const [selectedRecordingId, setSelectedRecordingId] = useState<StableId>();

    const filteredSongs = useMemo(() => {
        const list = Object.values(songs)
            .filter((song) => filter ? filter(song) : true)
            .filter((song) => {
                if (!query.trim()) return true;
                const needle = query.trim().toLowerCase();
                return (
                    song.title.toLowerCase().includes(needle) ||
                    song.songId.toLowerCase().includes(needle) ||
                    (song.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
                );
            })
            .sort((a, b) => a.title.localeCompare(b.title));
        return list;
    }, [songs, query, filter]);

    const activeSong = selectedSongId ? songs[selectedSongId] : filteredSongs[0];

    return (
        <PickerDialog title={title} onClose={onClose}>
            <div className="admin-picker__search">
                <Search aria-hidden="true" />
                <input
                    autoFocus
                    type="search"
                    placeholder="Search songs by title, id, or tag"
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                />
            </div>

            <div className="admin-picker__split">
                <div className="admin-picker__column">
                    <h3>Songs</h3>
                    {filteredSongs.length === 0 ? (
                        <div className="admin-picker__empty">
                            <p>No matching songs.</p>
                            {onRequestCreateSong ? (
                                <button
                                    type="button"
                                    className="admin-button admin-button--primary"
                                    onClick={() => onRequestCreateSong(query)}
                                >
                                    + Create &quot;{query.trim() || 'New song'}&quot;
                                </button>
                            ) : null}
                        </div>
                    ) : (
                        <ul className="admin-picker__list">
                            {filteredSongs.map((song) => (
                                <li key={song.songId}>
                                    <button
                                        type="button"
                                        className={`admin-picker__row ${activeSong?.songId === song.songId ? 'is-active' : ''}`}
                                        onClick={() => {
                                            setSelectedSongId(song.songId);
                                            const def = pickDefaultRecording(song, jobs);
                                            setSelectedRecordingId(def?.recordingId);
                                        }}
                                    >
                                        <Music2 aria-hidden="true" />
                                        <strong>{song.title || song.songId}</strong>
                                        <span>{song.recordings.length} recording{song.recordings.length === 1 ? '' : 's'}</span>
                                    </button>
                                </li>
                            ))}
                            {onRequestCreateSong && query.trim() ? (
                                <li>
                                    <button
                                        type="button"
                                        className="admin-picker__row admin-picker__row--create"
                                        onClick={() => onRequestCreateSong(query)}
                                    >
                                        <Music2 aria-hidden="true" />
                                        <strong>+ Create new song &quot;{query.trim()}&quot;</strong>
                                        <span>opens the Songs tab</span>
                                    </button>
                                </li>
                            ) : null}
                        </ul>
                    )}
                </div>
                <div className="admin-picker__column">
                    <h3>Recording</h3>
                    {activeSong ? (
                        activeSong.recordings.length === 0 ? (
                            <div className="admin-empty-state">No recordings on this song yet.</div>
                        ) : (
                            <ul className="admin-picker__list">
                                {activeSong.recordings.map((recording) => {
                                    const id = latestJobId(recording);
                                    const job = id ? jobs[id] : undefined;
                                    const chosen = (selectedRecordingId ?? pickDefaultRecording(activeSong, jobs)?.recordingId) === recording.recordingId;
                                    return (
                                        <li key={recording.recordingId}>
                                            <button
                                                type="button"
                                                className={`admin-picker__row ${chosen ? 'is-active' : ''}`}
                                                onClick={() => setSelectedRecordingId(recording.recordingId)}
                                            >
                                                <strong>{recording.title}</strong>
                                                <StatusPill kind="version" value={recording.versionType} />
                                                <StatusPill kind="encode" value={(job?.status ?? 'missing')} />
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )
                    ) : (
                        <div className="admin-empty-state">Choose a song to see its recordings.</div>
                    )}
                </div>
            </div>

            <footer className="admin-picker__footer">
                <button type="button" className="admin-button" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="admin-button admin-button--primary"
                    disabled={!activeSong || !(selectedRecordingId ?? (activeSong ? pickDefaultRecording(activeSong, jobs)?.recordingId : undefined))}
                    onClick={() => {
                        if (!activeSong) return;
                        const recordingId = selectedRecordingId ?? pickDefaultRecording(activeSong, jobs)?.recordingId;
                        if (!recordingId) return;
                        const recording = activeSong.recordings.find((r) => r.recordingId === recordingId);
                        if (!recording) return;
                        onPick({ song: activeSong, recording });
                    }}
                >
                    {confirmLabel}
                </button>
            </footer>
        </PickerDialog>
    );
}
