import {
    DndContext,
    PointerSensor,
    KeyboardSensor,
    closestCenter,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, GripVertical, Music2, Plus, Repeat, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { navigateTo } from '../../music/routes';
import {
    nextReleaseTrack,
    normalizeReleaseTrackSlugs,
    recordingEncodeStatus,
    sortedReleaseTracks,
    stableId,
    slugify,
} from '../admin-helpers';
import { useCatalog } from '../catalog-store';
import { useNotifications } from '../notifications';
import type { DraftRecording, DraftRelease, DraftReleaseTrack, DraftSong } from '../admin-types';
import { EmptyState } from '../shared/EmptyState';
import { RowActionMenu } from '../shared/RowActionMenu';
import { SongPicker } from '../shared/SongPicker';
import { StatusPill } from '../shared/StatusPill';

interface Props {
    release: DraftRelease;
    onChange: (release: DraftRelease) => void;
}

function moveTrack(release: DraftRelease, trackId: string, direction: -1 | 1): DraftRelease {
    const tracks = sortedReleaseTracks(release);
    const index = tracks.findIndex((track) => track.trackId === trackId);
    if (index < 0) return release;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= tracks.length) return release;
    const [moved] = tracks.splice(index, 1);
    tracks.splice(targetIndex, 0, moved);
    const renumbered = tracks.map((track, i) => ({ ...track, trackNumber: i + 1 }));
    return { ...release, tracks: renumbered };
}

function reorderTracks(release: DraftRelease, fromTrackId: string, toTrackId: string): DraftRelease {
    const tracks = sortedReleaseTracks(release);
    const fromIndex = tracks.findIndex((track) => track.trackId === fromTrackId);
    const toIndex = tracks.findIndex((track) => track.trackId === toTrackId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return release;
    const [moved] = tracks.splice(fromIndex, 1);
    tracks.splice(toIndex, 0, moved);
    const renumbered = tracks.map((track, i) => ({ ...track, trackNumber: i + 1 }));
    return { ...release, tracks: renumbered };
}

function updateTrackField<K extends keyof DraftReleaseTrack>(
    release: DraftRelease,
    trackId: string,
    key: K,
    value: DraftReleaseTrack[K],
): DraftRelease {
    return {
        ...release,
        tracks: release.tracks.map((track) => track.trackId === trackId ? { ...track, [key]: value } : track),
    };
}

function swapTrackRecording(
    release: DraftRelease,
    trackId: string,
    song: DraftSong,
    recording: DraftRecording,
): DraftRelease {
    const releaseWithoutTrack = {
        ...release,
        tracks: release.tracks.filter((track) => track.trackId !== trackId),
    };
    const replacement = nextReleaseTrack(releaseWithoutTrack, song, recording);
    return {
        ...release,
        tracks: release.tracks.map((track) => track.trackId === trackId ? {
            ...track,
            songId: song.songId,
            recordingId: recording.recordingId,
            slug: replacement.slug,
            title: track.title?.trim() ? track.title : replacement.title,
            explicit: recording.explicit,
            isrc: recording.isrc,
        } : track),
    };
}

function regenerateTrackIds(release: DraftRelease): DraftRelease {
    const withTitleSlugs = normalizeReleaseTrackSlugs({
        ...release,
        tracks: release.tracks.map((track) => ({
            ...track,
            slug: slugify(track.title),
        })),
    });
    return {
        ...withTitleSlugs,
        tracks: withTitleSlugs.tracks.map((track) => ({
            ...track,
            trackId: stableId('track', `${release.slug}_${String(track.trackNumber).padStart(2, '0')}_${track.slug}`),
        })),
    };
}

interface RowProps {
    release: DraftRelease;
    track: DraftReleaseTrack;
    index: number;
    total: number;
    onChange: (release: DraftRelease) => void;
    onRequestSwap: (trackId: string) => void;
    onRemove: (trackId: string) => void;
}

function SortableTrackRow({ release, track, index, total, onChange, onRequestSwap, onRemove }: RowProps) {
    const { songs, jobs } = useCatalog();
    const song = songs[track.songId];
    const recording = song?.recordings.find((r) => r.recordingId === track.recordingId);
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: track.trackId });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
        opacity: isDragging ? 0.85 : 1,
    };

    return (
        <div ref={setNodeRef} style={style} className={`admin-tracklist__row ${isDragging ? 'is-dragging' : ''}`}>
            <button
                type="button"
                className="admin-tracklist__handle"
                aria-label="Drag to reorder"
                {...attributes}
                {...listeners}
            >
                <GripVertical aria-hidden="true" />
            </button>
            <span className="admin-tracklist__num">
                <input
                    type="number"
                    min={1}
                    value={track.trackNumber}
                    onChange={(event) => onChange(updateTrackField(release, track.trackId, 'trackNumber', Number(event.currentTarget.value) || 1))}
                />
            </span>
            <div className="admin-tracklist__title">
                <input
                    value={track.title}
                    onChange={(event) => onChange(updateTrackField(release, track.trackId, 'title', event.currentTarget.value))}
                />
                <small>{song?.title ?? track.songId}</small>
            </div>
            <div className="admin-tracklist__recording">
                {recording ? (
                    <>
                        <strong>{recording.versionTitle ?? recording.title}</strong>
                        <StatusPill kind="version" value={recording.versionType} />
                    </>
                ) : (
                    <span className="admin-muted">Unknown recording</span>
                )}
            </div>
            <div>
                <StatusPill kind="encode" value={recordingEncodeStatus(recording, jobs)} />
            </div>
            <div className="admin-tracklist__actions">
                <button
                    type="button"
                    className="admin-icon-button"
                    title="Move up"
                    disabled={index === 0}
                    onClick={() => onChange(moveTrack(release, track.trackId, -1))}
                >
                    <ChevronUp aria-hidden="true" />
                </button>
                <button
                    type="button"
                    className="admin-icon-button"
                    title="Move down"
                    disabled={index === total - 1}
                    onClick={() => onChange(moveTrack(release, track.trackId, 1))}
                >
                    <ChevronDown aria-hidden="true" />
                </button>
                <RowActionMenu items={[
                    {
                        label: 'Change recording…',
                        icon: <Repeat aria-hidden="true" />,
                        onSelect: () => onRequestSwap(track.trackId),
                    },
                    {
                        label: 'Remove from release',
                        tone: 'danger',
                        icon: <Trash2 aria-hidden="true" />,
                        onSelect: () => onRemove(track.trackId),
                        confirm: {
                            prompt: `Remove "${track.title}" from this release?`,
                            confirmLabel: 'Remove',
                        },
                    },
                ]} />
            </div>
        </div>
    );
}

export function ReleaseTracklist({ release, onChange }: Props) {
    const { notify } = useNotifications();
    const [pickerOpen, setPickerOpen] = useState(false);
    const [swapTrackId, setSwapTrackId] = useState<string>();
    const tracks = sortedReleaseTracks(release);
    const swapTrack = swapTrackId ? release.tracks.find((track) => track.trackId === swapTrackId) : undefined;

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    function addTrack(song: DraftSong, recording: DraftRecording) {
        const track = nextReleaseTrack(release, song, recording);
        onChange({ ...release, tracks: [...release.tracks, track] });
        setPickerOpen(false);
    }

    function applySwap(song: DraftSong, recording: DraftRecording) {
        if (!swapTrackId) return;
        onChange(swapTrackRecording(release, swapTrackId, song, recording));
        setSwapTrackId(undefined);
    }

    function removeTrack(trackId: string) {
        const remaining = release.tracks
            .filter((track) => track.trackId !== trackId)
            .sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber)
            .map((track, index) => ({ ...track, trackNumber: index + 1 }));
        onChange({ ...release, tracks: remaining });
    }

    function handleDragEnd(event: DragEndEvent) {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        onChange(reorderTracks(release, String(active.id), String(over.id)));
    }

    return (
        <section className="admin-section">
            <header className="admin-section__header">
                <div>
                    <p className="admin-kicker">Tracklist</p>
                    <h3>{tracks.length} track{tracks.length === 1 ? '' : 's'}</h3>
                </div>
                <button type="button" className="admin-button" onClick={() => setPickerOpen(true)}>
                    <Plus aria-hidden="true" /> Add song
                </button>
            </header>

            {tracks.length === 0 ? (
                <EmptyState
                    icon={Music2}
                    title="No tracks yet"
                    body="Search the song library and add the recordings that belong on this release."
                    action={
                        <button type="button" className="admin-button admin-button--primary" onClick={() => setPickerOpen(true)}>
                            <Plus aria-hidden="true" /> Add song
                        </button>
                    }
                />
            ) : (
                <div className="admin-tracklist">
                    <div className="admin-tracklist__head">
                        <span aria-hidden="true" />
                        <span>#</span>
                        <span>Song</span>
                        <span>Recording</span>
                        <span>Encode</span>
                        <span aria-label="Actions" />
                    </div>
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                        <SortableContext items={tracks.map((track) => track.trackId)} strategy={verticalListSortingStrategy}>
                            {tracks.map((track, index) => (
                                <SortableTrackRow
                                    key={track.trackId}
                                    release={release}
                                    track={track}
                                    index={index}
                                    total={tracks.length}
                                    onChange={onChange}
                                    onRequestSwap={setSwapTrackId}
                                    onRemove={removeTrack}
                                />
                            ))}
                        </SortableContext>
                    </DndContext>
                </div>
            )}

            {tracks.length > 0 ? (
                <div className="admin-tracklist__footer">
                    <button
                        type="button"
                        className="admin-button"
                        onClick={() => onChange(regenerateTrackIds(release))}
                        title="Regenerate trackIds from the current title/number"
                    >
                        Regenerate track IDs
                    </button>
                </div>
            ) : null}

            {pickerOpen ? (
                <SongPicker
                    title="Add a song"
                    onClose={() => setPickerOpen(false)}
                    onPick={({ song, recording }) => addTrack(song, recording)}
                    onRequestCreateSong={(query) => {
                        setPickerOpen(false);
                        const params = query.trim() ? `?prefill=${encodeURIComponent(query.trim())}` : '';
                        navigateTo(`/admin/songs${params}`);
                        notify('Create the song, then come back to add it.');
                    }}
                />
            ) : null}

            {swapTrack ? (
                <SongPicker
                    title={`Change recording for "${swapTrack.title}"`}
                    confirmLabel="Use this recording"
                    onClose={() => setSwapTrackId(undefined)}
                    onPick={({ song, recording }) => applySwap(song, recording)}
                />
            ) : null}
        </section>
    );
}
