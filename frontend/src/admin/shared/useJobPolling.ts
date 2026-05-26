import { useEffect } from 'react';
import { useCatalog } from '../catalog-store';
import type { EncodeJob } from '../admin-types';

const POLL_INTERVAL_MS = 5000;
const POLLABLE_STATUSES: Array<EncodeJob['status']> = ['queued', 'running'];

/**
 * Polls a single encode job while it's in a non-terminal state.
 * Pass `undefined` to disable polling.
 */
export function useJobPolling(jobId: string | undefined): void {
    const { jobs, loadJob, loadSong } = useCatalog();

    useEffect(() => {
        if (!jobId) return undefined;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        async function tick() {
            if (cancelled) return;
            try {
                const job = await loadJob(jobId!);
                if (cancelled) return;
                if (POLLABLE_STATUSES.includes(job.status)) {
                    timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
                } else if (job.status === 'succeeded') {
                    void loadSong(job.songId).catch(() => undefined);
                }
            } catch {
                // swallow — next interaction will re-fetch
            }
        }

        // Initial pull if missing, then start polling if non-terminal
        const cached = jobs[jobId];
        if (!cached) {
            void tick();
        } else if (POLLABLE_STATUSES.includes(cached.status)) {
            timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
        // jobs intentionally excluded — we only want to react to id changes
    }, [jobId, loadJob, loadSong]);
}

/**
 * Polls every in-flight job from a list. Useful for the Activity feed.
 */
export function useActiveJobsPolling(jobIds: string[]): void {
    const { jobs, loadJob, loadSong } = useCatalog();

    useEffect(() => {
        const active = jobIds.filter((id) => {
            const job = jobs[id];
            return job ? POLLABLE_STATUSES.includes(job.status) : true;
        });
        if (active.length === 0) return undefined;

        let cancelled = false;
        const interval = setInterval(() => {
            if (cancelled) return;
            for (const id of active) {
                void loadJob(id)
                    .then((job) => {
                        if (job.status === 'succeeded') {
                            void loadSong(job.songId).catch(() => undefined);
                        }
                    })
                    .catch(() => undefined);
            }
        }, POLL_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [jobIds, jobs, loadJob, loadSong]);
}
