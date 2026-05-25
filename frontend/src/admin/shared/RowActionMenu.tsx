import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface RowActionItem {
    label: string;
    onSelect: () => void;
    tone?: 'default' | 'danger';
    icon?: ReactNode;
    disabled?: boolean;
    /** When set, clicking the item shows an inline confirm step inside the menu. */
    confirm?: {
        prompt: string;
        confirmLabel: string;
        cancelLabel?: string;
    };
}

interface Props {
    items: RowActionItem[];
    label?: string;
}

export function RowActionMenu({ items, label = 'Actions' }: Props) {
    const [open, setOpen] = useState(false);
    const [confirmingIndex, setConfirmingIndex] = useState<number>();
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handleClick = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setOpen(false);
                setConfirmingIndex(undefined);
            }
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false);
                setConfirmingIndex(undefined);
            }
        };
        window.addEventListener('mousedown', handleClick);
        window.addEventListener('keydown', handleKey);
        return () => {
            window.removeEventListener('mousedown', handleClick);
            window.removeEventListener('keydown', handleKey);
        };
    }, [open]);

    const confirmingItem = confirmingIndex !== undefined ? items[confirmingIndex] : undefined;

    return (
        <div className="admin-row-menu" ref={menuRef}>
            <button
                type="button"
                className="admin-icon-button"
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={(event) => {
                    event.stopPropagation();
                    setOpen((value) => !value);
                    setConfirmingIndex(undefined);
                }}
            >
                <MoreHorizontal aria-hidden="true" />
            </button>
            {open ? (
                <div className="admin-row-menu__list" role="menu">
                    {confirmingItem?.confirm ? (
                        <div className={`admin-row-menu__confirm ${confirmingItem.tone === 'danger' ? 'is-danger' : ''}`}>
                            <p>{confirmingItem.confirm.prompt}</p>
                            <div className="admin-row-menu__confirm-actions">
                                <button
                                    type="button"
                                    className="admin-button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setConfirmingIndex(undefined);
                                    }}
                                >
                                    {confirmingItem.confirm.cancelLabel ?? 'Cancel'}
                                </button>
                                <button
                                    type="button"
                                    className={confirmingItem.tone === 'danger' ? 'admin-button admin-button--danger' : 'admin-button admin-button--primary'}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setOpen(false);
                                        setConfirmingIndex(undefined);
                                        confirmingItem.onSelect();
                                    }}
                                >
                                    {confirmingItem.confirm.confirmLabel}
                                </button>
                            </div>
                        </div>
                    ) : (
                        items.map((item, index) => (
                            <button
                                key={`${item.label}-${index}`}
                                type="button"
                                role="menuitem"
                                disabled={item.disabled}
                                className={item.tone === 'danger' ? 'admin-row-menu__item is-danger' : 'admin-row-menu__item'}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    if (item.confirm) {
                                        setConfirmingIndex(index);
                                        return;
                                    }
                                    setOpen(false);
                                    item.onSelect();
                                }}
                            >
                                {item.icon ? <span className="admin-row-menu__icon">{item.icon}</span> : null}
                                <span>{item.label}</span>
                            </button>
                        ))
                    )}
                </div>
            ) : null}
        </div>
    );
}
