import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
    label: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'danger' | 'default';
    onConfirm: () => void;
    children: (open: () => void) => ReactNode;
}

export function ConfirmPopover({
    label,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    tone = 'default',
    onConfirm,
    children,
}: Props) {
    const [open, setOpen] = useState(false);
    const popoverRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handleClick = (event: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        window.addEventListener('mousedown', handleClick);
        window.addEventListener('keydown', handleKey);
        return () => {
            window.removeEventListener('mousedown', handleClick);
            window.removeEventListener('keydown', handleKey);
        };
    }, [open]);

    return (
        <div className="admin-confirm-anchor">
            {children(() => setOpen(true))}
            {open ? (
                <div className={`admin-confirm admin-confirm--${tone}`} ref={popoverRef} role="dialog">
                    <p>{label}</p>
                    <div className="admin-confirm__row">
                        <button type="button" className="admin-button" onClick={() => setOpen(false)}>
                            {cancelLabel}
                        </button>
                        <button
                            type="button"
                            className={tone === 'danger' ? 'admin-button admin-button--danger' : 'admin-button admin-button--primary'}
                            onClick={() => {
                                setOpen(false);
                                onConfirm();
                            }}
                        >
                            {confirmLabel}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
