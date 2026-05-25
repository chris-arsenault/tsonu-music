import { Disc3, Plus, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { useCatalog } from '../catalog-store';
import { releaseIdFromKey } from '../admin-helpers';
import type { DraftRelease } from '../admin-types';
import { EmptyState } from '../shared/EmptyState';
import { ListLoadingSkeleton } from '../shared/LoadingState';
import { StatusPill } from '../shared/StatusPill';
import type { PublishState } from '../shared/StatusPill';
import { useArrowKeyList } from '../shared/useArrowKeyList';
import { useSearchParam } from '../shared/useSearchParam';

interface Props {
    selectedReleaseId: string | undefined;
    onSelect: (id: string) => void;
    onCreate: () => void;
    onRefresh: () => void;
}

type Filter = 'all' | PublishState;
type Sort = 'date' | 'edited' | 'title';

export function ReleaseList({ selectedReleaseId, onSelect, onCreate, onRefresh }: Props) {
    const { releases, releaseList, listsLoaded, listsLoading } = useCatalog();
    const [filter, setFilterRaw] = useSearchParam('state', 'all');
    const [sort, setSortRaw] = useSearchParam('sort', 'date');
    const [search, setSearchRaw] = useSearchParam('q', '');
    const setFilter = (next: Filter) => setFilterRaw(next);
    const setSort = (next: Sort) => setSortRaw(next);
    const setSearch = (next: string) => setSearchRaw(next);

    const rows = useMemo(() => {
        const knownIds = new Set<string>(Object.keys(releases));
        for (const object of releaseList?.objects ?? []) {
            knownIds.add(releaseIdFromKey(object.key));
        }
        const list: DraftRelease[] = [];
        for (const id of knownIds) {
            const release = releases[id];
            if (release) list.push(release);
        }

        let filtered = list;
        if (filter !== 'all') {
            filtered = filtered.filter((release) => release.publishState === filter as PublishState);
        }
        if (search.trim()) {
            const needle = search.trim().toLowerCase();
            filtered = filtered.filter((release) =>
                release.title.toLowerCase().includes(needle) ||
                release.releaseId.toLowerCase().includes(needle) ||
                release.artistName.toLowerCase().includes(needle),
            );
        }

        filtered = [...filtered].sort((a, b) => {
            if (sort === 'title') return a.title.localeCompare(b.title);
            if (sort === 'edited') return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
            return (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '');
        });
        return filtered;
    }, [releases, releaseList, filter, sort, search]);

    const ids = rows.map((release) => release.releaseId);
    const onListKeyDown = useArrowKeyList({ ids, activeId: selectedReleaseId, onSelect });

    return (
        <div className="admin-list" onKeyDown={onListKeyDown}>
            <div className="admin-list__header">
                <div className="admin-list__title">
                    <p className="admin-kicker">Library</p>
                    <h2>Releases</h2>
                </div>
                <div className="admin-button-row">
                    <button type="button" className="admin-button admin-button--primary" onClick={onCreate}>
                        <Plus aria-hidden="true" /> New
                    </button>
                    <button type="button" className="admin-icon-button" title="Refresh" onClick={onRefresh}>
                        <RefreshCw aria-hidden="true" />
                    </button>
                </div>
            </div>

            <div className="admin-list__controls">
                <input
                    type="search"
                    placeholder="Search releases"
                    value={search}
                    onChange={(event) => setSearch(event.currentTarget.value)}
                    className="admin-list__search"
                />
                <select value={filter} onChange={(event) => setFilter(event.currentTarget.value as Filter)}>
                    <option value="all">All states</option>
                    <option value="draft">Draft</option>
                    <option value="ready">Ready</option>
                    <option value="published">Published</option>
                    <option value="withdrawn">Withdrawn</option>
                </select>
                <select value={sort} onChange={(event) => setSort(event.currentTarget.value as Sort)}>
                    <option value="date">Release date</option>
                    <option value="edited">Recently edited</option>
                    <option value="title">Title (A–Z)</option>
                </select>
            </div>

            {!listsLoaded && listsLoading ? (
                <ListLoadingSkeleton rows={6} />
            ) : rows.length === 0 ? (
                <EmptyState
                    icon={Disc3}
                    title="No releases yet"
                    body="Create your first release to start grouping songs."
                    action={
                        <button type="button" className="admin-button admin-button--primary" onClick={onCreate}>
                            <Plus aria-hidden="true" /> New release
                        </button>
                    }
                />
            ) : (
                <ul className="admin-list__items">
                    {rows.map((release) => {
                        const active = release.releaseId === selectedReleaseId;
                        return (
                            <li key={release.releaseId}>
                                <button
                                    type="button"
                                    className={`admin-list__item ${active ? 'is-active' : ''}`}
                                    onClick={() => onSelect(release.releaseId)}
                                >
                                    <div className="admin-list__item-body">
                                        <strong>{release.title || release.releaseId}</strong>
                                        <span>{release.releaseKind} · {release.releaseDate ?? 'no date'} · {release.tracks.length} track{release.tracks.length === 1 ? '' : 's'}</span>
                                    </div>
                                    <StatusPill kind="publish" value={release.publishState} />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
