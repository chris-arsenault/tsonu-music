import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ToastTone = 'notice' | 'error';

export interface Toast {
    id: number;
    tone: ToastTone;
    message: string;
    createdAt: number;
    duration: number;
}

interface NotificationContextValue {
    toasts: Toast[];
    notify: (message: string, tone?: ToastTone, durationMs?: number) => void;
    notifyError: (message: string) => void;
    dismiss: (id: number) => void;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

let toastSeq = 1;

export function NotificationProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const dismiss = useCallback((id: number) => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
    }, []);

    const notify = useCallback((message: string, tone: ToastTone = 'notice', durationMs?: number) => {
        const duration = durationMs ?? (tone === 'error' ? 8000 : 4500);
        const toast: Toast = {
            id: toastSeq++,
            tone,
            message,
            createdAt: Date.now(),
            duration,
        };
        setToasts((current) => [...current, toast]);
    }, []);

    const notifyError = useCallback((message: string) => {
        notify(message, 'error');
    }, [notify]);

    useEffect(() => {
        if (toasts.length === 0) return;
        const timers = toasts.map((toast) => {
            const remaining = Math.max(0, toast.createdAt + toast.duration - Date.now());
            return window.setTimeout(() => dismiss(toast.id), remaining);
        });
        return () => {
            for (const id of timers) window.clearTimeout(id);
        };
    }, [toasts, dismiss]);

    const value = useMemo<NotificationContextValue>(() => ({
        toasts,
        notify,
        notifyError,
        dismiss,
    }), [toasts, notify, notifyError, dismiss]);

    return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications(): NotificationContextValue {
    const value = useContext(NotificationContext);
    if (!value) {
        throw new Error('useNotifications must be used inside a NotificationProvider');
    }
    return value;
}
