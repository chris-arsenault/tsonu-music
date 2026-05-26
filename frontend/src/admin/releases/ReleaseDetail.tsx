import { Disc3, Rocket, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ReleaseKind, ReleaseStatus } from '../../catalog/media-catalog';
import { getArtworkUrl } from '../../catalog/catalog-client';
import { getRuntimeConfig } from '../../runtime-config';
import {
    RELEASE_KINDS,
    RELEASE_STATUSES,
    collectArtworkChoices,
    formatLinks,
    optionalText,
    parseLinks,
    parseOptionalJson,
    parseTags,
    normalizeReleaseTrackSlugs,
    readArtworkDimensions,
    releaseIdFromKey,
    sanitizeFilename,
    slugify,
    uniqueStableId,
} from '../admin-helpers';
import { requestArtworkUploadUrl, uploadArtworkFile } from '../admin-api';
import { useCatalog } from '../catalog-store';
import { useNotifications } from '../notifications';
import type { DraftRelease } from '../admin-types';
import { ArtworkPicker } from '../shared/ArtworkPicker';
import { EmptyState } from '../shared/EmptyState';
import { RowActionMenu } from '../shared/RowActionMenu';
import { StatusPill } from '../shared/StatusPill';
import { StickyDetailHeader } from '../shared/StickyDetailHeader';
import { useBusy } from '../shared/useBusy';
import { PublishDrawer } from './PublishDrawer';
import { ReleaseTracklist } from './ReleaseTracklist';

interface Props {
    selectedReleaseId: string | undefined;
    newDraft: DraftRelease | undefined;
    onSavedNewRelease: (release: DraftRelease) => void;
    onDiscardNew: () => void;
    onDeleted: () => void;
    onStartNew: () => void;
}

export function ReleaseDetail({
    selectedReleaseId,
    newDraft,
    onSavedNewRelease,
    onDiscardNew,
    onDeleted,
    onStartNew,
}: Props) {
    const { releases, songs, releaseList, saveRelease, removeRelease } = useCatalog();
    const { notify } = useNotifications();
    const { busy, run } = useBusy();

    const storedRelease = selectedReleaseId ? releases[selectedReleaseId] : undefined;
    const initial = newDraft ?? storedRelease;
    const [draft, setDraft] = useState<DraftRelease | undefined>(initial);
    const [linksText, setLinksText] = useState(() => formatLinks(initial?.links));
    const [tagsText, setTagsText] = useState(() => initial?.tags?.join(', ') ?? '');
    const [creditsText, setCreditsText] = useState(() => initial?.credits ? JSON.stringify(initial.credits, null, 2) : '');
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [publishOpen, setPublishOpen] = useState(false);

    const isNew = Boolean(newDraft) || (draft ? !releases[draft.releaseId] : false);
    const runtimeConfig = useMemo(() => getRuntimeConfig(), []);

    const knownReleaseIds = useMemo(() => {
        const ids = new Set<string>(Object.keys(releases));
        for (const object of releaseList?.objects ?? []) {
            ids.add(releaseIdFromKey(object.key));
        }
        return ids;
    }, [releases, releaseList]);

    const artworkChoices = useMemo(() => (
        collectArtworkChoices(Object.values(releases), Object.values(songs))
    ), [releases, songs]);

    // Sync local form state only when the user navigates to a different release,
    // not on every store update (which would wipe in-progress text edits when
    // a child component triggers an unrelated save).
    useEffect(() => {
        if (newDraft) {
            setDraft(newDraft);
            setLinksText(formatLinks(newDraft.links));
            setTagsText(newDraft.tags?.join(', ') ?? '');
            setCreditsText(newDraft.credits ? JSON.stringify(newDraft.credits, null, 2) : '');
            return;
        }
        if (selectedReleaseId) {
            const current = releases[selectedReleaseId];
            if (current) {
                setDraft(current);
                setLinksText(formatLinks(current.links));
                setTagsText(current.tags?.join(', ') ?? '');
                setCreditsText(current.credits ? JSON.stringify(current.credits, null, 2) : '');
            }
        } else {
            setDraft(undefined);
        }
    }, [newDraft, selectedReleaseId]);

    // Mirror only backend-owned release state from store. Replacing tracks/artwork
    // here would wipe in-progress edits whenever an unrelated catalog save
    // updates the shared store.
    useEffect(() => {
        if (newDraft) return;
        if (!selectedReleaseId) return;
        const fromStore = releases[selectedReleaseId];
        if (!fromStore) return;
        setDraft((current) => {
            if (!current) return fromStore;
            if (current.releaseId !== fromStore.releaseId) return fromStore;
            return {
                ...current,
                publishState: fromStore.publishState,
                updatedAt: fromStore.updatedAt ?? current.updatedAt,
            };
        });
    }, [releases, selectedReleaseId, newDraft]);

    function updateField<K extends keyof DraftRelease>(key: K, value: DraftRelease[K]) {
        setDraft((current) => {
            if (!current) return current;
            const next: DraftRelease = { ...current, [key]: value };
            if (key === 'title') {
                const nextSlug = slugify(String(value));
                next.slug = nextSlug;
                if (isNew && next.tracks.length === 0) {
                    next.releaseId = uniqueStableId('release', nextSlug, knownReleaseIds);
                }
            }
            return next;
        });
    }

    async function save() {
        if (!draft) return;
        if (!draft.title.trim()) {
            notify('Add a release title before saving.', 'error');
            return;
        }
        await run('Saving release', async () => {
            const payload = normalizeReleaseTrackSlugs({
                ...draft,
                subtitle: optionalText(draft.subtitle),
                releaseDate: optionalText(draft.releaseDate),
                description: optionalText(draft.description),
                copyright: optionalText(draft.copyright),
                credits: parseOptionalJson(creditsText),
                links: parseLinks(linksText),
                tags: parseTags(tagsText),
                updatedAt: new Date().toISOString(),
            });
            await saveRelease(payload, { isNew });
            setDraft(payload);
            if (isNew) onSavedNewRelease(payload);
            notify(`Saved ${payload.title}`);
        });
    }

    async function destroy() {
        if (!draft) return;
        if (isNew) {
            onDiscardNew();
            notify('Discarded unsaved release.');
            return;
        }
        const id = draft.releaseId;
        const title = draft.title;
        await run('Deleting release', async () => {
            await removeRelease(id);
            onDeleted();
            notify(`Deleted ${title}`);
        });
    }

    async function uploadArtwork(file: File) {
        if (!draft || isNew) return;
        await run('Uploading release artwork', async () => {
            const dimensions = await readArtworkDimensions(file);
            const upload = await requestArtworkUploadUrl({
                ownerType: 'release',
                ownerId: draft.releaseId,
                filename: sanitizeFilename(file.name),
                contentType: file.type || undefined,
                width: dimensions.width,
                height: dimensions.height,
                altText: `${draft.title} cover art`,
            });
            await uploadArtworkFile(upload, file);
            const next: DraftRelease = { ...draft, artwork: upload.artwork, updatedAt: new Date().toISOString() };
            await saveRelease(next, { isNew: false });
            setDraft(next);
            notify(`Uploaded artwork for ${next.title}`);
        });
    }

    if (!draft) {
        return (
            <EmptyState
                icon={Disc3}
                title="No release selected"
                body="Pick a release from the list, or start a new one."
                action={
                    <button type="button" className="admin-button admin-button--primary" onClick={onStartNew}>
                        New release
                    </button>
                }
            />
        );
    }

    const artworkSrc = draft.artwork ? getArtworkUrl(runtimeConfig.mediaBaseUrl, draft.artwork) : undefined;

    return (
        <div className="admin-detail">
            <StickyDetailHeader
                kicker={isNew ? 'New release' : 'Editing release'}
                title={
                    <input
                        className="admin-detail-header__title-input"
                        value={draft.title}
                        placeholder="Untitled release"
                        onChange={(event) => updateField('title', event.currentTarget.value)}
                    />
                }
                subline={
                    <>
                        <StatusPill kind="publish" value={draft.publishState} />
                        <span className="admin-muted">{draft.releaseId}</span>
                    </>
                }
                actions={
                    <>
                        <button
                            type="button"
                            className="admin-button"
                            onClick={() => setPublishOpen(true)}
                            disabled={isNew}
                            title={isNew ? 'Save the release first' : 'Open publish drawer'}
                        >
                            <Rocket aria-hidden="true" /> Publish
                        </button>
                        <button
                            type="button"
                            className="admin-button admin-button--primary"
                            disabled={!draft.title.trim() || Boolean(busy)}
                            onClick={() => void save()}
                        >
                            <Save aria-hidden="true" /> {busy === 'Saving release' ? 'Saving…' : 'Save'}
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
                                    label: 'Delete release',
                                    tone: 'danger',
                                    icon: <Trash2 aria-hidden="true" />,
                                    onSelect: () => void destroy(),
                                    confirm: {
                                        prompt: `Delete release "${draft.title}"?`,
                                        confirmLabel: 'Delete',
                                    },
                                },
                        ]} />
                    </>
                }
            />

            <section className="admin-section">
                <header className="admin-section__header">
                    <div>
                        <p className="admin-kicker">Cover &amp; identity</p>
                        <h3>Release metadata</h3>
                    </div>
                </header>

                <ArtworkPicker
                    label="Cover art"
                    src={artworkSrc}
                    artwork={draft.artwork}
                    altText={`${draft.title} cover art`}
                    artworkChoices={artworkChoices}
                    canUpload={!isNew}
                    uploadHint={isNew ? 'Save the release before uploading artwork.' : (draft.artwork?.sources[0]?.path ?? 'No artwork uploaded')}
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
                        <label>Release date</label>
                        <input type="date" value={draft.releaseDate ?? ''} onChange={(event) => updateField('releaseDate', event.currentTarget.value)} />
                    </div>
                    <div className="admin-field">
                        <label>Kind</label>
                        <select value={draft.releaseKind} onChange={(event) => updateField('releaseKind', event.currentTarget.value as ReleaseKind)}>
                            {RELEASE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                        </select>
                    </div>
                    <div className="admin-field">
                        <label>Status</label>
                        <select value={draft.releaseStatus} onChange={(event) => updateField('releaseStatus', event.currentTarget.value as ReleaseStatus)}>
                            {RELEASE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                        </select>
                    </div>
                    <div className="admin-field admin-field--wide">
                        <label>Subtitle</label>
                        <input value={draft.subtitle ?? ''} onChange={(event) => updateField('subtitle', event.currentTarget.value)} />
                    </div>
                </div>
            </section>

            <ReleaseTracklist release={draft} onChange={(next) => setDraft(next)} />

            <section className="admin-section">
                <button
                    type="button"
                    className="admin-section__collapse"
                    onClick={() => setDetailsOpen((open) => !open)}
                    aria-expanded={detailsOpen}
                >
                    <span>{detailsOpen ? '▾' : '▸'} Details &amp; notes</span>
                </button>
                {detailsOpen ? (
                    <div className="admin-form-grid">
                        <div className="admin-field admin-field--wide">
                            <label>Description</label>
                            <textarea rows={4} value={draft.description ?? ''} onChange={(event) => updateField('description', event.currentTarget.value)} />
                        </div>
                        <div className="admin-field">
                            <label>Tags</label>
                            <input value={tagsText} onChange={(event) => setTagsText(event.currentTarget.value)} placeholder="comma, separated" />
                        </div>
                        <div className="admin-field">
                            <label>Copyright</label>
                            <input value={draft.copyright ?? ''} onChange={(event) => updateField('copyright', event.currentTarget.value)} />
                        </div>
                        <div className="admin-field admin-field--wide">
                            <label>External links</label>
                            <textarea rows={3} value={linksText} onChange={(event) => setLinksText(event.currentTarget.value)} placeholder="Label | URL (one per line)" />
                        </div>
                        <div className="admin-field admin-field--wide">
                            <label>Credits JSON</label>
                            <textarea rows={6} value={creditsText} onChange={(event) => setCreditsText(event.currentTarget.value)} />
                        </div>
                    </div>
                ) : null}
            </section>

            {publishOpen ? (
                <PublishDrawer release={draft} onClose={() => setPublishOpen(false)} />
            ) : null}
        </div>
    );
}
