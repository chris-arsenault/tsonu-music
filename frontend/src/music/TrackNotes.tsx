import { useEffect, useState } from 'react';
import type { PublishedReleaseTrack, PublishedSongManifest } from '../catalog/media-catalog';

export interface TrackNoteItem {
    key: string;
    label: string;
    text: string;
}

function cleanText(value: string | undefined): string | undefined {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : undefined;
}

function noteItem(key: string, label: string, text: string | undefined): TrackNoteItem | undefined {
    const cleaned = cleanText(text);
    return cleaned ? { key, label, text: cleaned } : undefined;
}

function compactNotes(items: Array<TrackNoteItem | undefined>): TrackNoteItem[] {
    const seen = new Set<string>();
    const notes: TrackNoteItem[] = [];

    for (const item of items) {
        if (!item || seen.has(item.text)) {
            continue;
        }
        seen.add(item.text);
        notes.push(item);
    }

    return notes;
}

export function songNoteItems(song: PublishedSongManifest): TrackNoteItem[] {
    return compactNotes([
        noteItem('description', 'Overview', song.description),
        noteItem('narrative', 'Narrative', song.narrative),
    ]);
}

export function releaseTrackNoteItems(track: PublishedReleaseTrack): TrackNoteItem[] {
    return compactNotes([
        noteItem('description', 'Overview', track.description ?? track.songDescription),
        noteItem('narrative', 'Narrative', track.songNarrative),
        noteItem('production', 'Production', track.productionNote),
    ]);
}

export function NotesCallout({ items }: { items: TrackNoteItem[] }) {
    const [selectedKey, setSelectedKey] = useState(items[0]?.key);
    const selected = items.find((item) => item.key === selectedKey) ?? items[0];

    useEffect(() => {
        if (!items.some((item) => item.key === selectedKey)) {
            setSelectedKey(items[0]?.key);
        }
    }, [items, selectedKey]);

    if (!selected) {
        return null;
    }

    return (
        <div className="catalog-note-callout">
            {items.length > 1 ? (
                <div className="catalog-note-callout__tabs" aria-label="Song notes">
                    {items.map((item) => (
                        <button
                            key={item.key}
                            type="button"
                            className={item.key === selected.key ? 'is-active' : undefined}
                            aria-pressed={item.key === selected.key}
                            onClick={() => setSelectedKey(item.key)}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            ) : null}
            <p>{selected.text}</p>
        </div>
    );
}

export function TrackNotesList({ items }: { items: TrackNoteItem[] }) {
    if (items.length === 0) {
        return null;
    }

    return (
        <div className="track-notes-list">
            {items.map((item) => (
                <section key={item.key}>
                    <h3>{item.label}</h3>
                    <p>{item.text}</p>
                </section>
            ))}
        </div>
    );
}
