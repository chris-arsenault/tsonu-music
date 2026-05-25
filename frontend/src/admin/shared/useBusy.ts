import { useCallback, useState } from 'react';
import { errorMessage } from '../admin-helpers';
import { useNotifications } from '../notifications';

export interface BusyController {
    busy: string | undefined;
    run: <T>(label: string, action: () => Promise<T>) => Promise<T | undefined>;
}

export function useBusy(): BusyController {
    const [busy, setBusy] = useState<string>();
    const { notifyError } = useNotifications();

    const run = useCallback(async <T,>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
        setBusy(label);
        try {
            return await action();
        } catch (caught) {
            notifyError(errorMessage(caught));
            return undefined;
        } finally {
            setBusy(undefined);
        }
    }, [notifyError]);

    return { busy, run };
}
