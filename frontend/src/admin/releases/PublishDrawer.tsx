import { Rocket, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { StableId, Visibility } from '../../catalog/media-catalog';
import { publishRelease } from '../admin-api';
import { optionalText, recordingEncodeStatus, sortedReleaseTracks } from '../admin-helpers';
import { useCatalog, usePublishReadiness } from '../catalog-store';
import { useNotifications } from '../notifications';
import type { DraftRelease, PublishResponse } from '../admin-types';
import { useBusy } from '../shared/useBusy';
import { StatusPill } from '../shared/StatusPill';

interface Props {
    release: DraftRelease;
    onClose: () => void;
}

export function PublishDrawer({ release, onClose }: Props) {
    const { songs, jobs, upsertRelease } = useCatalog();
    const { notify } = useNotifications();
    const { busy, run } = useBusy();
    const { checks, canPublish, trackJobIds } = usePublishReadiness(release.releaseId);
    const [visibility, setVisibility] = useState<Visibility>('public');
    const [publishedAt, setPublishedAt] = useState('');
    const [result, setResult] = useState<PublishResponse>();
    const tracks = sortedReleaseTracks(release);

    useEffect(() => {
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [onClose]);

    async function publish() {
        if (!canPublish) return;
        await run('Publishing release', async () => {
            const response = await publishRelease(release.releaseId, {
                visibility,
                trackJobIds: trackJobIds as Record<string, StableId>,
                publishedAt: optionalText(publishedAt),
            });
            setResult(response);
            upsertRelease({ ...release, publishState: 'published' });
            notify(`Published ${response.manifestPath}`);
        });
    }

    return (
        <aside className="admin-drawer" role="dialog" aria-label="Publish release">
            <header className="admin-drawer__header">
                <div>
                    <p className="admin-kicker">Publish</p>
                    <h2>{release.title || release.releaseId}</h2>
                </div>
                <button type="button" className="admin-icon-button" onClick={onClose} aria-label="Close drawer">
                    <X aria-hidden="true" />
                </button>
            </header>

            <div className="admin-drawer__body">
                <div className="admin-checklist">
                    {checks.map((check) => (
                        <span key={check.label} className={check.ok ? 'is-ok' : 'is-missing'}>{check.label}</span>
                    ))}
                </div>

                <h3 className="admin-section__title">Tracklist preview</h3>
                <div className="admin-publish-tracks">
                    {tracks.length === 0 ? (
                        <div className="admin-empty-state">No tracks on this release.</div>
                    ) : tracks.map((track) => {
                        const song = songs[track.songId];
                        const recording = song?.recordings.find((r) => r.recordingId === track.recordingId);
                        return (
                            <div key={track.trackId} className="admin-publish-tracks__row">
                                <span>{track.trackNumber}</span>
                                <strong>{track.title}</strong>
                                <StatusPill kind="encode" value={recordingEncodeStatus(recording, jobs)} />
                            </div>
                        );
                    })}
                </div>

                <div className="admin-form-grid admin-form-grid--compact">
                    <div className="admin-field">
                        <label>Visibility</label>
                        <select value={visibility} onChange={(event) => setVisibility(event.currentTarget.value as Visibility)}>
                            <option value="public">public</option>
                            <option value="unlisted">unlisted</option>
                        </select>
                    </div>
                    <div className="admin-field">
                        <label>Published at</label>
                        <input
                            type="text"
                            value={publishedAt}
                            onChange={(event) => setPublishedAt(event.currentTarget.value)}
                            placeholder="ISO timestamp (optional)"
                        />
                    </div>
                </div>

                {result ? (
                    <div className="admin-publish-result">
                        <strong>{result.manifestPath}</strong>
                        <span>{result.copiedObjectCount} object{result.copiedObjectCount === 1 ? '' : 's'} copied</span>
                        <span>{result.invalidation.invalidationId ?? 'invalidation requested'}</span>
                    </div>
                ) : null}
            </div>

            <footer className="admin-drawer__footer">
                <button type="button" className="admin-button" onClick={onClose}>Close</button>
                <button
                    type="button"
                    className="admin-button admin-button--primary"
                    disabled={!canPublish || Boolean(busy)}
                    onClick={() => void publish()}
                >
                    <Rocket aria-hidden="true" /> {busy ?? 'Publish'}
                </button>
            </footer>
        </aside>
    );
}
