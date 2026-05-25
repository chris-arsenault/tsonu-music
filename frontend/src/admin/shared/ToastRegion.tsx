import { X } from 'lucide-react';
import { useNotifications } from '../notifications';

export function ToastRegion() {
    const { toasts, dismiss } = useNotifications();
    return (
        <div
            className="admin-toast-region"
            role="region"
            aria-label="Notifications"
            aria-live="polite"
            aria-relevant="additions"
        >
            {toasts.map((toast) => (
                <div
                    key={toast.id}
                    className={`admin-toast admin-toast--${toast.tone}`}
                    role={toast.tone === 'error' ? 'alert' : 'status'}
                >
                    <span>{toast.message}</span>
                    <button type="button" className="admin-toast__close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
                        <X aria-hidden="true" />
                    </button>
                </div>
            ))}
        </div>
    );
}
