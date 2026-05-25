import { useEffect, useState } from 'react';
import { useCatalog } from '../catalog-store';
import { useNotifications } from '../notifications';
import { newDraftSong, slugify, stableId, temporaryDraftId } from '../admin-helpers';
import type { DraftSong } from '../admin-types';
import { ListDetailLayout } from '../shared/ListDetailLayout';
import { useBusy } from '../shared/useBusy';
import { useSearchParam } from '../shared/useSearchParam';
import { SongList } from '../songs/SongList';
import { SongDetail } from '../songs/SongDetail';

interface Props {
    selectedSongId: string | undefined;
    onSelectionChange: (id: string | undefined) => void;
    onNavigateRelease: (releaseId: string) => void;
}

export function SongsPage({ selectedSongId, onSelectionChange, onNavigateRelease }: Props) {
    const { loadSong, refreshLists, songs } = useCatalog();
    const { notify } = useNotifications();
    const { run } = useBusy();
    const [newDraft, setNewDraft] = useState<DraftSong>();
    const [prefill, setPrefill] = useSearchParam('prefill', '');

    useEffect(() => {
        if (!selectedSongId) return;
        if (songs[selectedSongId]) return;
        void run('Opening song', () => loadSong(selectedSongId));
    }, [selectedSongId, songs, loadSong, run]);

    // Auto-create a draft seeded with the title from ?prefill=
    useEffect(() => {
        if (!prefill || newDraft || selectedSongId) return;
        const seededTitle = prefill;
        const draft: DraftSong = {
            ...newDraftSong(stableId('song', seededTitle)),
            slug: slugify(seededTitle),
            title: seededTitle,
            updatedAt: undefined,
        };
        setNewDraft(draft);
        setPrefill('');
        notify(`Started a new song titled "${seededTitle}". Save it, then return to the release.`);
    }, [prefill, newDraft, selectedSongId, setPrefill, notify]);

    function startNew() {
        const draft: DraftSong = {
            ...newDraftSong(temporaryDraftId('song')),
            slug: '',
            title: '',
            updatedAt: undefined,
        };
        setNewDraft(draft);
        onSelectionChange(undefined);
        notify('Started a new unsaved song.');
    }

    return (
        <ListDetailLayout
            list={
                <SongList
                    selectedSongId={selectedSongId}
                    onSelect={(id) => {
                        setNewDraft(undefined);
                        onSelectionChange(id);
                    }}
                    onCreate={startNew}
                    onRefresh={() => void run('Refreshing', refreshLists)}
                />
            }
            detail={
                <SongDetail
                    key={newDraft ? `new:${newDraft.songId}` : selectedSongId ?? 'empty'}
                    selectedSongId={selectedSongId}
                    newDraft={newDraft}
                    onSavedNewSong={(song) => {
                        setNewDraft(undefined);
                        onSelectionChange(song.songId);
                    }}
                    onDiscardNew={() => {
                        setNewDraft(undefined);
                        onSelectionChange(undefined);
                    }}
                    onDeleted={() => onSelectionChange(undefined)}
                    onStartNew={startNew}
                    onNavigateRelease={onNavigateRelease}
                />
            }
        />
    );
}
