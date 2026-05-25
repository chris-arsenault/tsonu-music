import { CloudUpload, FileAudio, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { createEncodeJob, requestUploadUrl, uploadMasterFile } from '../admin-api';
import { latestJobId, optionalText, sanitizeFilename, slugify, formatRelativeTime } from '../admin-helpers';
import { useCatalog } from '../catalog-store';
import { useNotifications } from '../notifications';
import type { DraftRecording, DraftSong, EncodeJob } from '../admin-types';
import { ConfirmPopover } from '../shared/ConfirmPopover';
import { StatusPill } from '../shared/StatusPill';
import { useBusy } from '../shared/useBusy';
import { useJobPolling } from '../shared/useJobPolling';
import { VERSION_TYPES } from '../admin-helpers';

interface Props {
    song: DraftSong;
    recording: DraftRecording;
    isSavedSong: boolean;
    onChange: (recording: DraftRecording) => void;
    onRemove: () => void;
}

export function RecordingEditor({ song, recording, isSavedSong, onChange, onRemove }: Props) {
    const { jobs, loadJob, saveSong, upsertSong } = useCatalog();
    const { notify } = useNotifications();
    const { busy, run } = useBusy();
    const [masterFile, setMasterFile] = useState<File>();
    const [includeLossless, setIncludeLossless] = useState(true);
    const [requestedBy, setRequestedBy] = useState('admin-ui');

    const jobId = latestJobId(recording);
    const latestJob: EncodeJob | undefined = jobId ? jobs[jobId] : undefined;

    useJobPolling(jobId);

    async function uploadMaster() {
        if (!masterFile || !isSavedSong) return;
        await run('Uploading master', async () => {
            const upload = await requestUploadUrl({
                recordingId: recording.recordingId,
                filename: sanitizeFilename(masterFile.name),
                contentType: masterFile.type || undefined,
            });
            await uploadMasterFile(upload, masterFile);
            const next: DraftRecording = { ...recording, sourceMaster: upload.sourceMaster };
            const nextSong: DraftSong = {
                ...song,
                recordings: song.recordings.map((r) => r.recordingId === next.recordingId ? next : r),
                updatedAt: new Date().toISOString(),
            };
            await saveSong(nextSong, { isNew: false });
            onChange(next);
            setMasterFile(undefined);
            notify(`Uploaded ${masterFile.name}`);
        });
    }

    async function startEncode() {
        if (!isSavedSong || !recording.sourceMaster?.bucket || !recording.sourceMaster.key) return;
        await run('Starting encode', async () => {
            const response = await createEncodeJob({
                songId: song.songId,
                recordingId: recording.recordingId,
                includeLossless,
                requestedBy: optionalText(requestedBy),
            });
            const next: DraftRecording = {
                ...recording,
                encodeJobIds: [...(recording.encodeJobIds ?? []), response.job.jobId],
            };
            const nextSong: DraftSong = {
                ...song,
                recordings: song.recordings.map((r) => r.recordingId === next.recordingId ? next : r),
                updatedAt: new Date().toISOString(),
            };
            await saveSong(nextSong, { isNew: false });
            upsertSong(nextSong);
            onChange(next);
            notify(`Queued ${response.job.jobId}`);
        });
    }

    return (
        <div className="admin-recording-editor">
            <div className="admin-form-grid admin-form-grid--compact">
                <div className="admin-field">
                    <label>Title</label>
                    <input
                        value={recording.title}
                        onChange={(event) => onChange({
                            ...recording,
                            title: event.currentTarget.value,
                            slug: slugify(event.currentTarget.value),
                        })}
                    />
                </div>
                <div className="admin-field">
                    <label>Version label</label>
                    <input
                        value={recording.versionTitle ?? ''}
                        onChange={(event) => onChange({ ...recording, versionTitle: event.currentTarget.value })}
                    />
                </div>
                <div className="admin-field">
                    <label>Version type</label>
                    <select
                        value={recording.versionType}
                        onChange={(event) => onChange({ ...recording, versionType: event.currentTarget.value as DraftRecording['versionType'] })}
                    >
                        {VERSION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                    </select>
                </div>
                <div className="admin-field">
                    <label>ISRC</label>
                    <input
                        value={recording.isrc ?? ''}
                        onChange={(event) => onChange({ ...recording, isrc: event.currentTarget.value })}
                    />
                </div>
                <label className="admin-check">
                    <input
                        type="checkbox"
                        checked={recording.explicit}
                        onChange={(event) => onChange({ ...recording, explicit: event.currentTarget.checked })}
                    />
                    Explicit
                </label>
            </div>

            <div className="admin-source-master">
                <div>
                    <span>Source master</span>
                    <strong>{recording.sourceMaster?.key ?? (masterFile?.name ?? 'No master uploaded')}</strong>
                </div>
                <div>
                    <span>Latest encode</span>
                    <strong>
                        <StatusPill kind="encode" value={(latestJob?.status ?? 'missing')} />
                        {latestJob?.finishedAt ? <span className="admin-muted"> · {formatRelativeTime(latestJob.finishedAt)}</span> : null}
                    </strong>
                </div>
            </div>

            <div className="admin-form-grid admin-form-grid--compact">
                <div className="admin-field admin-field--wide">
                    <label>Upload lossless master (WAV, AIFF, FLAC)</label>
                    <input
                        type="file"
                        accept=".wav,.wave,.aif,.aiff,.flac,audio/wav,audio/wave,audio/x-wav,audio/aiff,audio/x-aiff,audio/flac"
                        disabled={!isSavedSong}
                        onChange={(event) => setMasterFile(event.currentTarget.files?.[0])}
                    />
                </div>
                <div className="admin-button-row admin-field--wide">
                    <button
                        type="button"
                        className="admin-button"
                        disabled={!isSavedSong || !masterFile || Boolean(busy)}
                        onClick={() => void uploadMaster()}
                    >
                        <Upload aria-hidden="true" /> Upload master
                    </button>
                    <button
                        type="button"
                        className="admin-button admin-button--primary"
                        disabled={!isSavedSong || !recording.sourceMaster?.key || Boolean(busy)}
                        onClick={() => void startEncode()}
                    >
                        <CloudUpload aria-hidden="true" /> Start encode
                    </button>
                    {jobId ? (
                        <button
                            type="button"
                            className="admin-icon-button"
                            title="Refresh job status"
                            onClick={() => void run('Refreshing job', () => loadJob(jobId))}
                        >
                            <RefreshCw aria-hidden="true" />
                        </button>
                    ) : null}
                </div>
                <label className="admin-check">
                    <input
                        type="checkbox"
                        checked={includeLossless}
                        onChange={(event) => setIncludeLossless(event.currentTarget.checked)}
                    />
                    Include FLAC download in encode
                </label>
                <div className="admin-field">
                    <label>Requested by</label>
                    <input value={requestedBy} onChange={(event) => setRequestedBy(event.currentTarget.value)} />
                </div>
            </div>

            {latestJob ? (
                <div className="admin-job-detail">
                    <div className="admin-job-detail__head">
                        <FileAudio aria-hidden="true" />
                        <strong>{latestJob.jobId}</strong>
                        <StatusPill kind="encode" value={latestJob.status} />
                    </div>
                    {latestJob.error ? (
                        <pre className="admin-job-detail__error">{latestJob.error.message}{latestJob.error.details ? `\n${latestJob.error.details}` : ''}</pre>
                    ) : null}
                    {latestJob.metadata ? (
                        <p className="admin-muted">
                            {latestJob.metadata.codecName} · {latestJob.metadata.sampleRateHz} Hz · {latestJob.metadata.channels}ch · {Math.round(latestJob.metadata.durationSeconds)}s
                        </p>
                    ) : null}
                </div>
            ) : null}

            <div className="admin-recording-editor__footer">
                <ConfirmPopover
                    label={`Remove recording "${recording.title}"?`}
                    confirmLabel="Remove"
                    tone="danger"
                    onConfirm={onRemove}
                >
                    {(open) => (
                        <button type="button" className="admin-button admin-button--danger" onClick={open}>
                            <Trash2 aria-hidden="true" /> Remove recording
                        </button>
                    )}
                </ConfirmPopover>
            </div>
        </div>
    );
}
