import { useEffect, useState } from 'react';
import { useCatalog } from '../catalog-store';
import { useNotifications } from '../notifications';
import { newDraftRelease, temporaryDraftId } from '../admin-helpers';
import type { DraftRelease } from '../admin-types';
import { ListDetailLayout } from '../shared/ListDetailLayout';
import { useBusy } from '../shared/useBusy';
import { ReleaseList } from '../releases/ReleaseList';
import { ReleaseDetail } from '../releases/ReleaseDetail';

interface Props {
    selectedReleaseId: string | undefined;
    onSelectionChange: (id: string | undefined) => void;
}

export function ReleasesPage({ selectedReleaseId, onSelectionChange }: Props) {
    const { loadRelease, refreshLists, releases } = useCatalog();
    const { notify } = useNotifications();
    const { run } = useBusy();
    const [newDraft, setNewDraft] = useState<DraftRelease>();

    useEffect(() => {
        if (!selectedReleaseId) return;
        if (releases[selectedReleaseId]) return;
        void run('Opening release', () => loadRelease(selectedReleaseId));
    }, [selectedReleaseId, releases, loadRelease, run]);

    function startNew() {
        const draft: DraftRelease = {
            ...newDraftRelease(temporaryDraftId('release')),
            slug: '',
            title: '',
            releaseDate: '',
            updatedAt: undefined,
        };
        setNewDraft(draft);
        onSelectionChange(undefined);
        notify('Started a new unsaved release.');
    }

    return (
        <ListDetailLayout
            list={
                <ReleaseList
                    selectedReleaseId={selectedReleaseId}
                    onSelect={(id) => {
                        setNewDraft(undefined);
                        onSelectionChange(id);
                    }}
                    onCreate={startNew}
                    onRefresh={() => void run('Refreshing', refreshLists)}
                />
            }
            detail={
                <ReleaseDetail
                    key={newDraft ? `new:${newDraft.releaseId}` : selectedReleaseId ?? 'empty'}
                    selectedReleaseId={selectedReleaseId}
                    newDraft={newDraft}
                    onSavedNewRelease={(release) => {
                        setNewDraft(undefined);
                        onSelectionChange(release.releaseId);
                    }}
                    onDiscardNew={() => {
                        setNewDraft(undefined);
                        onSelectionChange(undefined);
                    }}
                    onDeleted={() => onSelectionChange(undefined)}
                    onStartNew={startNew}
                />
            }
        />
    );
}
