import { useCallback } from 'react';

interface Options<T> {
    ids: T[];
    activeId: T | undefined;
    onSelect: (id: T) => void;
}

/**
 * Returns an `onKeyDown` handler that turns the parent into an arrow-navigable list.
 * Items must be rendered in `ids` order. Up/Down move the selection, Home/End jump
 * to the ends. The handler ignores keys when the target is an input/textarea/select.
 */
export function useArrowKeyList<T>({ ids, activeId, onSelect }: Options<T>) {
    return useCallback(
        (event: React.KeyboardEvent<HTMLElement>) => {
            const target = event.target as HTMLElement;
            const tag = target.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable) {
                return;
            }
            if (ids.length === 0) return;
            const currentIndex = activeId !== undefined ? ids.indexOf(activeId) : -1;

            let nextIndex: number | undefined;
            if (event.key === 'ArrowDown') {
                nextIndex = currentIndex < 0 ? 0 : Math.min(ids.length - 1, currentIndex + 1);
            } else if (event.key === 'ArrowUp') {
                nextIndex = currentIndex < 0 ? ids.length - 1 : Math.max(0, currentIndex - 1);
            } else if (event.key === 'Home') {
                nextIndex = 0;
            } else if (event.key === 'End') {
                nextIndex = ids.length - 1;
            }

            if (nextIndex !== undefined) {
                event.preventDefault();
                onSelect(ids[nextIndex]);
            }
        },
        [ids, activeId, onSelect],
    );
}
