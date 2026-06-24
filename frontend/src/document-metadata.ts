import { useEffect } from 'react';

const DEFAULT_DESCRIPTION = 'Home of Tsonu — downtempo, orchestral electronica, music for dreamers.';

export interface DocumentMetadata {
    title: string;
    description?: string;
}

function setDescription(description: string): void {
    if (typeof document === 'undefined') {
        return;
    }

    let element = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!element) {
        element = document.createElement('meta');
        element.name = 'description';
        document.head.appendChild(element);
    }

    element.content = description;
}

export function setDocumentMetadata({ title, description = DEFAULT_DESCRIPTION }: DocumentMetadata): void {
    if (typeof document === 'undefined') {
        return;
    }

    document.title = title;
    setDescription(description);
}

export function useDocumentMetadata(metadata: DocumentMetadata): void {
    useEffect(() => {
        setDocumentMetadata(metadata);
    }, [metadata.description, metadata.title]);
}
