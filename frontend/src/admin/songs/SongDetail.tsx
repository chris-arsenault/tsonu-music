import { Music2, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getArtworkUrl } from '../../catalog/catalog-client';
import { getRuntimeConfig } from '../../runtime-config';
import { requestArtworkUploadUrl, uploadArtworkFile } from '../admin-api';
import {
    collectArtworkChoices,
    draftSongRecordingsError,
    optionalText,
    parseOptionalJson,
    parseTags,
    prepareDraftSongForSave,
    readArtworkDimensions,
    sanitizeFilename,
    slugify,
    songIdFromKey,
    uniqueStableId,
} from '../admin-helpers';
import { useCatalog } from '../catalog-store';
import { useNotifications } from '../notifications';
import type { DraftSong } from '../admin-types';
import { ArtworkPicker } from '../shared/ArtworkPicker';
import { EmptyState } from '../shared/EmptyState';
import { RowActionMenu } from '../shared/RowActionMenu';
import { StickyDetailHeader } from '../shared/StickyDetailHeader';
import { useBusy } from '../shared/useBusy';
import { AppearsOnList } from './AppearsOnList';
import { RecordingsTable } from './RecordingsTable';

type Tab = 'metadata' | 'recordings' | 'appears';

interface Props {
    selectedSongId: string | undefined;
    newDraft: DraftSong | undefined;
    onSavedNewSong: (song: DraftSong) => void;
    onDiscardNew: () => void;
    onDeleted: () => void;
    onStartNew: () => void;
    onNavigateRelease: (releaseId: string) => void;
}

export function SongDetail({
    selectedSongId,
    newDraft,
    onSavedNewSong,
    onDiscardNew,
    onDeleted,
    onStartNew,
    onNavigateRelease,
}: Props) {
    const { songs, releases, songList, saveSong, removeSong } = useCatalog();
    const { notify } = useNotifications();
    const { busy, run } = useBusy();
    const storedSong = selectedSongId ? songs[selectedSongId] : undefined;
    const initial = newDraft ?? storedSong;
    const [draft, setDraft] = useState<DraftSong | undefined>(initial);
    const [tagsText, setTagsText] = useState(() => initial?.tags?.join(', ') ?? '');
    const [creditsText, setCreditsText] = useState(() => initial?.credits ? JSON.stringify(initial.credits, null, 2) : '');
    const [tab, setTab] = useState<Tab>('metadata');

    const isNew = Boolean(newDraft) || (draft ? !songs[draft.songId] : false);
    const runtimeConfig = useMemo(() => getRuntimeConfig(), []);

    const knownSongIds = useMemo(() => {
        const ids = new Set<string>(Object.keys(songs));
        for (const object of songList?.objects ?? []) {
            ids.add(songIdFromKey(object.key));
        }
        return ids;
    }, [songs, songList]);

    const artworkChoices = useMemo(() => (
        collectArtworkChoices(Object.values(releases), Object.values(songs))
    ), [releases, songs]);

    // Sync local form state only when the user navigates to a different song,
    // not on every store update (which would wipe in-progress text edits when
    // a child component triggers an unrelated save).
    useEffect(() => {
        if (newDraft) {
            setDraft(newDraft);
            setTagsText(newDraft.tags?.join(', ') ?? '');
            setCreditsText(newDraft.credits ? JSON.stringify(newDraft.credits, null, 2) : '');
            return;
        }
        if (selectedSongId) {
            const current = songs[selectedSongId];
            if (current) {
                setDraft(current);
                setTagsText(current.tags?.join(', ') ?? '');
                setCreditsText(current.credits ? JSON.stringify(current.credits, null, 2) : '');
            }
        } else {
            setDraft(undefined);
        }
        // Intentionally omit `songs` / `storedSong` from deps so that
        // child-triggered store mutations don't reset typed form state.
    }, [newDraft, selectedSongId]);

    // Mirror only backend-authored recording artifacts from store. Replacing the
    // whole recording list here would wipe in-progress local edits whenever a
    // child action saves the song or an encode poll refreshes catalog state.
    useEffect(() => {
        if (newDraft) return;
        if (!selectedSongId) return;
        const fromStore = songs[selectedSongId];
        if (!fromStore) return;
        setDraft((current) => {
            if (!current) return fromStore;
            if (current.songId !== fromStore.songId) return fromStore;
            const serverRecordings = new Map(fromStore.recordings.map((recording) => [recording.recordingId, recording]));
            const currentIds = new Set(current.recordings.map((recording) => recording.recordingId));
            const mergedRecordings = current.recordings.map((recording) => {
                const fromServer = serverRecordings.get(recording.recordingId);
                if (!fromServer) return recording;
                return {
                    ...recording,
                    sourceMaster: fromServer.sourceMaster ?? recording.sourceMaster,
                    encodeJobIds: fromServer.encodeJobIds ?? recording.encodeJobIds,
                    files: fromServer.files ?? recording.files,
                    durationSeconds: fromServer.durationSeconds ?? recording.durationSeconds,
                };
            });
            for (const recording of fromStore.recordings) {
                if (!currentIds.has(recording.recordingId)) {
                    mergedRecordings.push(recording);
                }
            }
            return {
                ...current,
                recordings: mergedRecordings,
                updatedAt: fromStore.updatedAt ?? current.updatedAt,
            };
        });
    }, [songs, selectedSongId, newDraft]);

    function updateField<K extends keyof DraftSong>(key: K, value: DraftSong[K]) {
        setDraft((current) => {
            if (!current) return current;
            const next: DraftSong = { ...current, [key]: value };
            if (key === 'title') {
                const nextSlug = slugify(String(value));
                next.slug = nextSlug;
                if (isNew && next.recordings.length === 0) {
                    next.songId = uniqueStableId('song', nextSlug, knownSongIds);
                }
            }
            return next;
        });
    }

    async function save() {
        if (!draft) return;
        if (!draft.title.trim()) {
            notify('Add a song title before saving.', 'error');
            return;
        }
        const recordingError = draftSongRecordingsError(draft);
        if (recordingError) {
            notify(recordingError, 'error');
            return;
        }
        await run('Saving song', async () => {
            const preparedDraft = prepareDraftSongForSave(draft);
            const payload: DraftSong = {
                ...preparedDraft,
                description: optionalText(preparedDraft.description),
                lyrics: optionalText(preparedDraft.lyrics),
                credits: parseOptionalJson(creditsText),
                tags: parseTags(tagsText),
                updatedAt: new Date().toISOString(),
            };
            await saveSong(payload, { isNew });
            setDraft(payload);
            if (isNew) onSavedNewSong(payload);
            notify(`Saved ${payload.title}`);
        });
    }

    async function destroy() {
        if (!draft) return;
        if (isNew) {
            onDiscardNew();
            notify('Discarded unsaved song.');
            return;
        }
        const id = draft.songId;
        const title = draft.title;
        await run('Deleting song', async () => {
            await removeSong(id);
            onDeleted();
            notify(`Deleted ${title}`);
        });
    }

    async function uploadArtwork(file: File) {
        if (!draft || isNew) return;
        await run('Uploading song artwork', async () => {
            const dimensions = await readArtworkDimensions(file);
            const upload = await requestArtworkUploadUrl({
                ownerType: 'song',
                ownerId: draft.songId,
                filename: sanitizeFilename(file.name),
                contentType: file.type || undefined,
                width: dimensions.width,
                height: dimensions.height,
                altText: `${draft.title} artwork`,
            });
            await uploadArtworkFile(upload, file);
            const next: DraftSong = { ...draft, artwork: upload.artwork, updatedAt: new Date().toISOString() };
            await saveSong(next, { isNew: false });
            setDraft(next);
            notify(`Uploaded artwork for ${next.title}`);
        });
    }

    if (!draft) {
        return (
            <EmptyState
                icon={Music2}
                title="No song selected"
                body="Pick a song from the list, or start a new one."
                action={
                    <button type="button" className="admin-button admin-button--primary" onClick={onStartNew}>
                        New song
                    </button>
                }
            />
        );
    }

    const artworkSrc = draft.artwork ? getArtworkUrl(runtimeConfig.mediaBaseUrl, draft.artwork) : undefined;

    return (
        <div className="admin-detail">
            <StickyDetailHeader
                kicker={isNew ? 'New song' : 'Editing song'}
                title={
                    <input
                        className="admin-detail-header__title-input"
                        value={draft.title}
                        placeholder="Untitled song"
                        onChange={(event) => updateField('title', event.currentTarget.value)}
                    />
                }
                subline={<span className="admin-muted">{draft.songId}</span>}
                actions={
                    <>
                        <button
                            type="button"
                            className="admin-button admin-button--primary"
                            disabled={!draft.title.trim() || Boolean(busy)}
                            onClick={() => void save()}
                        >
                            <Save aria-hidden="true" /> {busy === 'Saving song' ? 'Saving…' : 'Save'}
                        </button>
                        <RowActionMenu items={[
                            isNew
                                ? {
                                    label: 'Discard',
                                    tone: 'danger',
                                    icon: <Trash2 aria-hidden="true" />,
                                    onSelect: () => void destroy(),
                                }
                                : {
                                    label: 'Delete song',
                                    tone: 'danger',
                                    icon: <Trash2 aria-hidden="true" />,
                                    onSelect: () => void destroy(),
                                    confirm: {
                                        prompt: `Delete song "${draft.title}"?`,
                                        confirmLabel: 'Delete',
                                    },
                                },
                        ]} />
                    </>
                }
            />

            <nav className="admin-detail-tabs" aria-label="Song sections">
                <button type="button" className={tab === 'metadata' ? 'is-active' : ''} onClick={() => setTab('metadata')}>Metadata</button>
                <button type="button" className={tab === 'recordings' ? 'is-active' : ''} onClick={() => setTab('recordings')}>
                    Recordings ({draft.recordings.length})
                </button>
                <button type="button" className={tab === 'appears' ? 'is-active' : ''} onClick={() => setTab('appears')}>Appears on</button>
            </nav>

            {tab === 'metadata' ? (
                <section className="admin-section">
                    <ArtworkPicker
                        label="Song artwork"
                        src={artworkSrc}
                        artwork={draft.artwork}
                        altText={`${draft.title} artwork`}
                        artworkChoices={artworkChoices}
                        canUpload={!isNew}
                        uploadHint={isNew ? 'Save the song before uploading artwork.' : (draft.artwork?.sources[0]?.path ?? 'Falls back to release artwork when empty.')}
                        onUpload={uploadArtwork}
                        onReuse={(choiceValue) => {
                            const choice = artworkChoices.find((c) => c.value === choiceValue);
                            if (choice) updateField('artwork', choice.artwork);
                        }}
                        onClear={() => updateField('artwork', undefined)}
                    />
                    <div className="admin-form-grid">
                        <div className="admin-field">
                            <label>Artist</label>
                            <input value={draft.artistName} onChange={(event) => updateField('artistName', event.currentTarget.value)} />
                        </div>
                        <div className="admin-field">
                            <label>Tags</label>
                            <input value={tagsText} onChange={(event) => setTagsText(event.currentTarget.value)} placeholder="comma, separated" />
                        </div>
                        <div className="admin-field admin-field--wide">
                            <label>Description</label>
                            <textarea rows={3} value={draft.description ?? ''} onChange={(event) => updateField('description', event.currentTarget.value)} />
                        </div>
                        <div className="admin-field admin-field--wide">
                            <label>Lyrics</label>
                            <textarea rows={6} value={draft.lyrics ?? ''} onChange={(event) => updateField('lyrics', event.currentTarget.value)} />
                        </div>
                        <div className="admin-field admin-field--wide">
                            <label>Credits JSON</label>
                            <textarea rows={5} value={creditsText} onChange={(event) => setCreditsText(event.currentTarget.value)} />
                        </div>
                    </div>
                </section>
            ) : null}

            {tab === 'recordings' ? (
                <RecordingsTable song={draft} isSavedSong={!isNew} onChange={(next) => setDraft(next)} />
            ) : null}

            {tab === 'appears' ? (
                <AppearsOnList song={draft} isSavedSong={!isNew} onNavigateRelease={onNavigateRelease} />
            ) : null}
        </div>
    );
}
