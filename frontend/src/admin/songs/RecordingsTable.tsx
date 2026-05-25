import { ChevronDown, ChevronRight, Disc3, Plus } from 'lucide-react';
import { useState } from 'react';
import { latestJob, newRecording } from '../admin-helpers';
import { useCatalog } from '../catalog-store';
import type { DraftRecording, DraftSong } from '../admin-types';
import { EmptyState } from '../shared/EmptyState';
import { StatusPill } from '../shared/StatusPill';
import { RecordingEditor } from './RecordingEditor';

interface Props {
    song: DraftSong;
    isSavedSong: boolean;
    onChange: (song: DraftSong) => void;
}

export function RecordingsTable({ song, isSavedSong, onChange }: Props) {
    const { jobs } = useCatalog();
    const [expandedId, setExpandedId] = useState<string>();

    function addRecording() {
        const rec = newRecording(song);
        onChange({ ...song, recordings: [...song.recordings, rec] });
        setExpandedId(rec.recordingId);
    }

    function updateRecording(updated: DraftRecording) {
        onChange({
            ...song,
            recordings: song.recordings.map((r) => r.recordingId === updated.recordingId ? updated : r),
        });
    }

    function removeRecording(recordingId: string) {
        onChange({
            ...song,
            recordings: song.recordings.filter((r) => r.recordingId !== recordingId),
        });
        if (expandedId === recordingId) setExpandedId(undefined);
    }

    if (song.recordings.length === 0) {
        return (
            <section className="admin-section">
                <header className="admin-section__header">
                    <div>
                        <p className="admin-kicker">Recordings</p>
                        <h3>No recordings yet</h3>
                    </div>
                    <button type="button" className="admin-button admin-button--primary" onClick={addRecording}>
                        <Plus aria-hidden="true" /> Add recording
                    </button>
                </header>
                <EmptyState
                    icon={Disc3}
                    title="Start with a recording"
                    body="A recording holds a source master (WAV / AIFF / FLAC) and the encode job that produced its streamable assets."
                />
            </section>
        );
    }

    return (
        <section className="admin-section">
            <header className="admin-section__header">
                <div>
                    <p className="admin-kicker">Recordings</p>
                    <h3>{song.recordings.length} version{song.recordings.length === 1 ? '' : 's'}</h3>
                </div>
                <button type="button" className="admin-button" onClick={addRecording}>
                    <Plus aria-hidden="true" /> Add recording
                </button>
            </header>

            <div className="admin-recordings">
                {song.recordings.map((recording) => {
                    const job = latestJob(recording, jobs);
                    const expanded = expandedId === recording.recordingId;
                    return (
                        <div key={recording.recordingId} className={`admin-recording ${expanded ? 'is-expanded' : ''}`}>
                            <button
                                type="button"
                                className="admin-recording__row"
                                onClick={() => setExpandedId(expanded ? undefined : recording.recordingId)}
                                aria-expanded={expanded}
                            >
                                <span className="admin-recording__chevron">
                                    {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                                </span>
                                <div className="admin-recording__title">
                                    <strong>{recording.title}</strong>
                                    {recording.versionTitle ? <small className="admin-muted">{recording.versionTitle}</small> : null}
                                </div>
                                <StatusPill kind="version" value={recording.versionType} />
                                <span className="admin-recording__master">
                                    {recording.sourceMaster?.key ? '✓ master' : '— no master'}
                                </span>
                                <StatusPill kind="encode" value={(job?.status ?? 'missing')} />
                            </button>
                            {expanded ? (
                                <div className="admin-recording__body">
                                    <RecordingEditor
                                        song={song}
                                        recording={recording}
                                        isSavedSong={isSavedSong}
                                        onChange={updateRecording}
                                        onRemove={() => removeRecording(recording.recordingId)}
                                    />
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
