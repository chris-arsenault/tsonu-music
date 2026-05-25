import { Disc3, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { StableId } from '../../catalog/media-catalog';
import { useCatalog } from '../catalog-store';
import type { DraftRelease } from '../admin-types';
import { PickerDialog } from './PickerDialog';

interface Props {
    onPick: (release: DraftRelease) => void;
    onClose: () => void;
    excludeReleaseIds?: Set<string>;
    title?: string;
}

export function ReleasePicker({ onPick, onClose, excludeReleaseIds, title = 'Add to release' }: Props) {
    const { releases } = useCatalog();
    const [query, setQuery] = useState('');
    const [selectedReleaseId, setSelectedReleaseId] = useState<StableId>();

    const filteredReleases = useMemo(() => {
        return Object.values(releases)
            .filter((release) => !excludeReleaseIds?.has(release.releaseId))
            .filter((release) => {
                if (!query.trim()) return true;
                const needle = query.trim().toLowerCase();
                return (
                    release.title.toLowerCase().includes(needle) ||
                    release.releaseId.toLowerCase().includes(needle)
                );
            })
            .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
    }, [releases, query, excludeReleaseIds]);

    const active = selectedReleaseId ? releases[selectedReleaseId] : filteredReleases[0];

    return (
        <PickerDialog title={title} onClose={onClose}>
            <div className="admin-picker__search">
                <Search aria-hidden="true" />
                <input
                    autoFocus
                    type="search"
                    placeholder="Search releases by title or id"
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                />
            </div>

            {filteredReleases.length === 0 ? (
                <div className="admin-empty-state">No matching releases.</div>
            ) : (
                <ul className="admin-picker__list">
                    {filteredReleases.map((release) => (
                        <li key={release.releaseId}>
                            <button
                                type="button"
                                className={`admin-picker__row ${active?.releaseId === release.releaseId ? 'is-active' : ''}`}
                                onClick={() => setSelectedReleaseId(release.releaseId)}
                            >
                                <Disc3 aria-hidden="true" />
                                <strong>{release.title || release.releaseId}</strong>
                                <span>{release.releaseKind} · {release.releaseDate ?? 'no date'}</span>
                                <span>{release.tracks.length} track{release.tracks.length === 1 ? '' : 's'}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <footer className="admin-picker__footer">
                <button type="button" className="admin-button" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="admin-button admin-button--primary"
                    disabled={!active}
                    onClick={() => {
                        if (active) onPick(active);
                    }}
                >
                    Add to this release
                </button>
            </footer>
        </PickerDialog>
    );
}
