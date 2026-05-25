import { Music2, Plus, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { useCatalog, useSongsGroupedByRelease, useUnreleasedSongs } from '../catalog-store';
import { latestJob, songIdFromKey } from '../admin-helpers';
import type { DraftSong } from '../admin-types';
import { EmptyState } from '../shared/EmptyState';
import { ListLoadingSkeleton } from '../shared/LoadingState';
import { useArrowKeyList } from '../shared/useArrowKeyList';
import { useSearchParam } from '../shared/useSearchParam';

type Group = 'release' | 'alphabetical' | 'edited' | 'unreleased';

interface Props {
    selectedSongId: string | undefined;
    onSelect: (id: string) => void;
    onCreate: () => void;
    onRefresh: () => void;
}

interface ListGroup {
    key: string;
    label: string | undefined;
    songs: DraftSong[];
}

export function SongList({ selectedSongId, onSelect, onCreate, onRefresh }: Props) {
    const { songs, songList, jobs, listsLoaded, listsLoading } = useCatalog();
    const [group, setGroupRaw] = useSearchParam('groupBy', 'release');
    const [search, setSearchRaw] = useSearchParam('q', '');
    const setGroup = (next: Group) => setGroupRaw(next);
    const setSearch = (next: string) => setSearchRaw(next);

    const allSongs = useMemo(() => {
        const known = new Set<string>(Object.keys(songs));
        for (const object of songList?.objects ?? []) {
            known.add(songIdFromKey(object.key));
        }
        const list: DraftSong[] = [];
        for (const id of known) {
            const song = songs[id];
            if (song) list.push(song);
        }
        return list;
    }, [songs, songList]);

    const groupedByRelease = useSongsGroupedByRelease();
    const unreleased = useUnreleasedSongs();

    const groups: ListGroup[] = useMemo(() => {
        const filterSong = (song: DraftSong) => {
            if (!search.trim()) return true;
            const needle = search.trim().toLowerCase();
            return (
                song.title.toLowerCase().includes(needle) ||
                song.songId.toLowerCase().includes(needle) ||
                (song.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
            );
        };

        const groupKey = group as Group;
        if (groupKey === 'release') {
            return groupedByRelease
                .map((entry) => ({
                    key: entry.release?.releaseId ?? 'unreleased',
                    label: entry.release?.title ?? 'Not on any release',
                    songs: entry.songs.filter(filterSong),
                }))
                .filter((entry) => entry.songs.length > 0);
        }
        if (groupKey === 'unreleased') {
            return [{ key: 'unreleased', label: 'Unreleased', songs: unreleased.filter(filterSong) }];
        }
        if (groupKey === 'alphabetical') {
            const sorted = [...allSongs].filter(filterSong).sort((a, b) => a.title.localeCompare(b.title));
            return [{ key: 'all', label: undefined, songs: sorted }];
        }
        const sorted = [...allSongs].filter(filterSong).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
        return [{ key: 'all', label: undefined, songs: sorted }];
    }, [group, search, allSongs, groupedByRelease, unreleased]);

    const empty = groups.every((g) => g.songs.length === 0);
    const flatIds = groups.flatMap((g) => g.songs.map((song) => song.songId));
    const onListKeyDown = useArrowKeyList({ ids: flatIds, activeId: selectedSongId, onSelect });

    return (
        <div className="admin-list" onKeyDown={onListKeyDown}>
            <div className="admin-list__header">
                <div className="admin-list__title">
                    <p className="admin-kicker">Library</p>
                    <h2>Songs</h2>
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
                    placeholder="Search songs"
                    className="admin-list__search"
                    value={search}
                    onChange={(event) => setSearch(event.currentTarget.value)}
                />
                <select value={group} onChange={(event) => setGroup(event.currentTarget.value as Group)}>
                    <option value="release">Group by release</option>
                    <option value="alphabetical">Alphabetical</option>
                    <option value="edited">Recently edited</option>
                    <option value="unreleased">Unreleased only</option>
                </select>
            </div>

            {!listsLoaded && listsLoading ? (
                <ListLoadingSkeleton rows={6} />
            ) : empty ? (
                <EmptyState
                    icon={Music2}
                    title="No songs match"
                    body={search.trim() ? 'Try a different search term.' : 'Create your first song to begin uploading recordings.'}
                    action={
                        <button type="button" className="admin-button admin-button--primary" onClick={onCreate}>
                            <Plus aria-hidden="true" /> New song
                        </button>
                    }
                />
            ) : (
                <div className="admin-list__groups">
                    {groups.map((entry) => (
                        <div key={entry.key} className="admin-list__group">
                            {entry.label ? <h3>{entry.label}</h3> : null}
                            <ul className="admin-list__items">
                                {entry.songs.map((song) => {
                                    const active = song.songId === selectedSongId;
                                    const recordingCount = song.recordings.length;
                                    const encodedCount = song.recordings.filter((recording) => {
                                        const job = latestJob(recording, jobs);
                                        return job?.status === 'succeeded';
                                    }).length;
                                    return (
                                        <li key={song.songId}>
                                            <button
                                                type="button"
                                                className={`admin-list__item ${active ? 'is-active' : ''}`}
                                                onClick={() => onSelect(song.songId)}
                                            >
                                                <div className="admin-list__item-body">
                                                    <strong>{song.title || song.songId}</strong>
                                                    <span>
                                                        {recordingCount === 0
                                                            ? 'No recordings'
                                                            : `${recordingCount} recording${recordingCount === 1 ? '' : 's'} · ${encodedCount} encoded`}
                                                    </span>
                                                </div>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
