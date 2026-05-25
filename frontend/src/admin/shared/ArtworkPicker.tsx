import { ImageIcon, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import type { CatalogArtwork } from '../../catalog/media-catalog';
import type { ArtworkChoice } from '../admin-helpers';
import { useObjectUrl } from './useObjectUrl';

interface Props {
    label: string;
    src: string | undefined;
    artwork: CatalogArtwork | undefined;
    altText: string;
    artworkChoices: ArtworkChoice[];
    canUpload: boolean;
    uploadHint: string;
    onUpload: (file: File) => void | Promise<void>;
    onReuse: (choiceValue: string) => void;
    onClear: () => void;
}

export function ArtworkPicker({
    label,
    src,
    artwork,
    altText,
    artworkChoices,
    canUpload,
    uploadHint,
    onUpload,
    onReuse,
    onClear,
}: Props) {
    const [pendingFile, setPendingFile] = useState<File>();
    const previewUrl = useObjectUrl(pendingFile) ?? src;

    return (
        <div className="admin-artwork-upload">
            <div className="admin-artwork-upload__preview">
                {previewUrl
                    ? <img src={previewUrl} alt={artwork?.altText ?? altText} />
                    : <ImageIcon aria-hidden="true" />}
            </div>
            <div className="admin-artwork-upload__body">
                <span>{label}</span>
                <small>{uploadHint}</small>
                <div className="admin-field">
                    <label>Upload image</label>
                    <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/avif"
                        disabled={!canUpload}
                        onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            setPendingFile(file);
                        }}
                    />
                </div>
                <div className="admin-field">
                    <label>Reuse existing image</label>
                    <select
                        value=""
                        disabled={artworkChoices.length === 0}
                        onChange={(event) => {
                            const value = event.currentTarget.value;
                            if (value) onReuse(value);
                        }}
                    >
                        <option value="">Choose artwork</option>
                        {artworkChoices.map((choice) => (
                            <option key={choice.value} value={choice.value}>{choice.label}</option>
                        ))}
                    </select>
                </div>
                <div className="admin-button-row">
                    <button
                        type="button"
                        className="admin-button"
                        disabled={!canUpload || !pendingFile}
                        onClick={async () => {
                            if (!pendingFile) return;
                            await onUpload(pendingFile);
                            setPendingFile(undefined);
                        }}
                    >
                        <Upload aria-hidden="true" /> Upload
                    </button>
                    <button
                        type="button"
                        className="admin-button admin-button--danger"
                        disabled={!artwork && !pendingFile}
                        onClick={() => {
                            setPendingFile(undefined);
                            onClear();
                        }}
                    >
                        <Trash2 aria-hidden="true" /> Clear
                    </button>
                </div>
            </div>
        </div>
    );
}
