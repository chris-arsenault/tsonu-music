import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface Props {
    title: string;
    onClose: () => void;
    children: ReactNode;
}

export function PickerDialog({ title, onClose, children }: Props) {
    const overlayRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKey);
        document.body.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('keydown', handleKey);
            document.body.style.overflow = '';
        };
    }, [onClose]);

    return (
        <div
            className="admin-picker-overlay"
            ref={overlayRef}
            onMouseDown={(event) => {
                if (event.target === overlayRef.current) onClose();
            }}
        >
            <div className="admin-picker" role="dialog" aria-modal="true" aria-label={title}>
                <header className="admin-picker__header">
                    <h2>{title}</h2>
                    <button type="button" className="admin-icon-button" onClick={onClose} aria-label="Close">
                        <X aria-hidden="true" />
                    </button>
                </header>
                <div className="admin-picker__body">{children}</div>
            </div>
        </div>
    );
}
