import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    createDraftRelease,
    createDraftSong,
    deleteDraftRelease,
    deleteDraftSong,
    getDraftRelease,
    getDraftSong,
    getJob,
    listDraftReleases,
    listDraftSongs,
    listJobs,
    updateDraftRelease,
    updateDraftSong,
} from './admin-api';
import type {
    DraftRelease,
    DraftSong,
    EncodeJob,
    ObjectList,
} from './admin-types';
import { jobIdFromKey, releaseIdFromKey, songIdFromKey } from './admin-helpers';
import {
    publishReadinessFor,
    releasesContainingSong,
    songsGroupedByRelease,
    unreleasedSongs,
    type PublishReadiness,
    type ReleaseGroup,
} from './catalog-selectors';

export interface CatalogState {
    songs: Record<string, DraftSong>;
    releases: Record<string, DraftRelease>;
    jobs: Record<string, EncodeJob>;
    songList: ObjectList | undefined;
    releaseList: ObjectList | undefined;
    jobList: ObjectList | undefined;
    listsLoading: boolean;
    listsLoaded: boolean;
}

export interface CatalogActions {
    refreshLists: () => Promise<void>;
    refreshJobs: () => Promise<void>;
    loadSong: (id: string) => Promise<DraftSong>;
    loadRelease: (id: string) => Promise<DraftRelease>;
    loadJob: (id: string) => Promise<EncodeJob>;
    saveSong: (song: DraftSong, opts?: { isNew?: boolean }) => Promise<DraftSong>;
    saveRelease: (release: DraftRelease, opts?: { isNew?: boolean }) => Promise<DraftRelease>;
    removeSong: (id: string) => Promise<void>;
    removeRelease: (id: string) => Promise<void>;
    upsertSong: (song: DraftSong) => void;
    upsertRelease: (release: DraftRelease) => void;
    upsertJob: (job: EncodeJob) => void;
}

interface CatalogContextValue extends CatalogState, CatalogActions {}

const CatalogContext = createContext<CatalogContextValue | undefined>(undefined);

export function CatalogProvider({ children }: { children: ReactNode }) {
    const [songs, setSongs] = useState<Record<string, DraftSong>>({});
    const [releases, setReleases] = useState<Record<string, DraftRelease>>({});
    const [jobs, setJobs] = useState<Record<string, EncodeJob>>({});
    const [songList, setSongList] = useState<ObjectList>();
    const [releaseList, setReleaseList] = useState<ObjectList>();
    const [jobList, setJobList] = useState<ObjectList>();
    const [listsLoading, setListsLoading] = useState(false);
    const [listsLoaded, setListsLoaded] = useState(false);
    const inFlightSong = useRef<Map<string, Promise<DraftSong>>>(new Map());
    const inFlightRelease = useRef<Map<string, Promise<DraftRelease>>>(new Map());

    const upsertSong = useCallback((song: DraftSong) => {
        setSongs((current) => ({ ...current, [song.songId]: song }));
    }, []);

    const upsertRelease = useCallback((release: DraftRelease) => {
        setReleases((current) => ({ ...current, [release.releaseId]: release }));
    }, []);

    const upsertJob = useCallback((job: EncodeJob) => {
        setJobs((current) => ({ ...current, [job.jobId]: job }));
    }, []);

    const refreshLists = useCallback(async () => {
        setListsLoading(true);
        try {
            const [songsList, releasesList, jobsList] = await Promise.all([
                listDraftSongs(),
                listDraftReleases(),
                listJobs(),
            ]);
            setSongList(songsList);
            setReleaseList(releasesList);
            setJobList(jobsList);

            const listedSongIds = new Set(songsList.objects.map((object) => songIdFromKey(object.key)));
            const listedReleaseIds = new Set(releasesList.objects.map((object) => releaseIdFromKey(object.key)));

            const [loadedSongs, loadedReleases] = await Promise.all([
                Promise.all([...listedSongIds].map(async (id) => {
                    try { return await getDraftSong(id); } catch { return undefined; }
                })),
                Promise.all([...listedReleaseIds].map(async (id) => {
                    try { return await getDraftRelease(id); } catch { return undefined; }
                })),
            ]);

            setSongs((current) => {
                const next: Record<string, DraftSong> = {};
                for (const [id, song] of Object.entries(current)) {
                    if (listedSongIds.has(id)) next[id] = song;
                }
                for (const song of loadedSongs) {
                    if (song) next[song.songId] = song;
                }
                return next;
            });
            setReleases((current) => {
                const next: Record<string, DraftRelease> = {};
                for (const [id, release] of Object.entries(current)) {
                    if (listedReleaseIds.has(id)) next[id] = release;
                }
                for (const release of loadedReleases) {
                    if (release) next[release.releaseId] = release;
                }
                return next;
            });

            // Publish-readiness reads recording.files directly, so we no
            // longer bulk-load encode jobs here. Individual jobs are
            // loaded on demand by useJobPolling (for live status) and the
            // Activity feed (for the operational view).
            setListsLoaded(true);
        } finally {
            setListsLoading(false);
        }
    }, []);

    const refreshJobs = useCallback(async () => {
        const next = await listJobs();
        setJobList(next);
    }, []);

    const loadSong = useCallback(async (id: string): Promise<DraftSong> => {
        const existing = inFlightSong.current.get(id);
        if (existing) return existing;
        const promise = (async () => {
            try {
                const song = await getDraftSong(id);
                upsertSong(song);
                return song;
            } finally {
                inFlightSong.current.delete(id);
            }
        })();
        inFlightSong.current.set(id, promise);
        return promise;
    }, [upsertSong]);

    const loadRelease = useCallback(async (id: string): Promise<DraftRelease> => {
        const existing = inFlightRelease.current.get(id);
        if (existing) return existing;
        const promise = (async () => {
            try {
                const release = await getDraftRelease(id);
                upsertRelease(release);
                return release;
            } finally {
                inFlightRelease.current.delete(id);
            }
        })();
        inFlightRelease.current.set(id, promise);
        return promise;
    }, [upsertRelease]);

    const loadJob = useCallback(async (id: string): Promise<EncodeJob> => {
        const job = await getJob(id);
        upsertJob(job);
        return job;
    }, [upsertJob]);

    const saveSong = useCallback(async (song: DraftSong, opts?: { isNew?: boolean }): Promise<DraftSong> => {
        if (opts?.isNew) {
            await createDraftSong(song);
        } else {
            await updateDraftSong(song);
        }
        // Optimistic update first so subsequent renders have the value...
        upsertSong(song);
        // ...then re-pull from the server to capture any normalization (updatedAt, etc.)
        try {
            const canonical = await getDraftSong(song.songId);
            upsertSong(canonical);
            return canonical;
        } catch {
            return song;
        }
    }, [upsertSong]);

    const saveRelease = useCallback(async (release: DraftRelease, opts?: { isNew?: boolean }): Promise<DraftRelease> => {
        if (opts?.isNew) {
            await createDraftRelease(release);
        } else {
            await updateDraftRelease(release);
        }
        upsertRelease(release);
        try {
            const canonical = await getDraftRelease(release.releaseId);
            upsertRelease(canonical);
            return canonical;
        } catch {
            return release;
        }
    }, [upsertRelease]);

    const removeSong = useCallback(async (id: string) => {
        await deleteDraftSong(id);
        setSongs((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });
        setSongList((current) => current ? {
            ...current,
            objects: current.objects.filter((object) => songIdFromKey(object.key) !== id),
        } : current);
    }, []);

    const removeRelease = useCallback(async (id: string) => {
        await deleteDraftRelease(id);
        setReleases((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });
        setReleaseList((current) => current ? {
            ...current,
            objects: current.objects.filter((object) => releaseIdFromKey(object.key) !== id),
        } : current);
    }, []);

    const value = useMemo<CatalogContextValue>(() => ({
        songs,
        releases,
        jobs,
        songList,
        releaseList,
        jobList,
        listsLoading,
        listsLoaded,
        refreshLists,
        refreshJobs,
        loadSong,
        loadRelease,
        loadJob,
        saveSong,
        saveRelease,
        removeSong,
        removeRelease,
        upsertSong,
        upsertRelease,
        upsertJob,
    }), [
        songs, releases, jobs, songList, releaseList, jobList, listsLoading, listsLoaded,
        refreshLists, refreshJobs, loadSong, loadRelease, loadJob,
        saveSong, saveRelease, removeSong, removeRelease,
        upsertSong, upsertRelease, upsertJob,
    ]);

    return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogContextValue {
    const value = useContext(CatalogContext);
    if (!value) {
        throw new Error('useCatalog must be used inside a CatalogProvider');
    }
    return value;
}

export function useCatalogBootstrap() {
    const { refreshLists, listsLoaded, listsLoading } = useCatalog();
    useEffect(() => {
        if (!listsLoaded && !listsLoading) {
            void refreshLists();
        }
    }, [listsLoaded, listsLoading, refreshLists]);
}

// ---- selectors ----

export function useReleasesContainingSong(songId: string | undefined): DraftRelease[] {
    const { releases } = useCatalog();
    return useMemo(() => {
        if (!songId) return [];
        return releasesContainingSong(releases, songId);
    }, [releases, songId]);
}

export function useSongsGroupedByRelease(): ReleaseGroup[] {
    const { songs, releases } = useCatalog();
    return useMemo(() => songsGroupedByRelease(songs, releases), [songs, releases]);
}

export function useUnreleasedSongs(): DraftSong[] {
    const { songs, releases } = useCatalog();
    return useMemo(() => unreleasedSongs(songs, releases), [songs, releases]);
}

export function useLatestJobForRecording(songId: string | undefined, recordingId: string | undefined): EncodeJob | undefined {
    const { songs, jobs } = useCatalog();
    return useMemo(() => {
        if (!songId || !recordingId) return undefined;
        const song = songs[songId];
        const recording = song?.recordings.find((r) => r.recordingId === recordingId);
        const latest = recording?.encodeJobIds?.[recording.encodeJobIds.length - 1];
        return latest ? jobs[latest] : undefined;
    }, [songs, jobs, songId, recordingId]);
}

export type { PublishCheck } from './catalog-selectors';

export function usePublishReadiness(releaseId: string | undefined): PublishReadiness {
    const { releases, songs, jobs } = useCatalog();
    return useMemo(() => {
        const release = releaseId ? releases[releaseId] : undefined;
        return publishReadinessFor(release, songs, jobs);
    }, [releaseId, releases, songs, jobs]);
}

export interface SortedJob {
    job: EncodeJob | undefined;
    jobId: string;
    sizeBytes: number;
    key: string;
}

export function useEncodeJobFeed(): SortedJob[] {
    const { jobList, jobs } = useCatalog();
    return useMemo(() => {
        const objects = jobList?.objects ?? [];
        return objects.map((object) => {
            const id = jobIdFromKey(object.key);
            return {
                key: object.key,
                jobId: id,
                sizeBytes: object.sizeBytes,
                job: jobs[id],
            };
        });
    }, [jobList, jobs]);
}
