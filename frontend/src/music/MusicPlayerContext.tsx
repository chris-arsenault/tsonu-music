import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import {
    fetchPublishedCatalog,
    fetchReleaseManifest,
    fetchReleaseManifestBySlug,
    getArtworkUrl,
    resolveMediaUrl,
} from '../catalog/catalog-client';
import type {
    CatalogArtwork,
    CatalogReleaseSummary,
    PlaybackFormat,
    PlaybackQuality,
    PublishedCatalog,
    PublishedReleaseManifest,
    PublishedReleaseTrack,
    StableId,
} from '../catalog/media-catalog';
import {
    getPlaybackSessionId,
    recordPlayComplete,
    recordPlayError,
    recordPlayPause,
    recordPlayProgress,
    recordPlaySeek,
    recordPlayStart,
    recordPlayTenSeconds,
    recordQualityChanged,
    recordReleaseView,
    recordTrackImpression,
    type PlayerEventContext,
} from '../player-analytics';
import { getRuntimeConfig } from '../runtime-config';

type LoadState = 'loading' | 'ready' | 'error';
export type QualitySelection = 'auto' | PlaybackQuality;
type HlsInstance = InstanceType<typeof import('hls.js/light').default>;

interface PlaybackSource {
    assetId: StableId;
    quality: QualitySelection;
    url: string;
}

interface PendingPlaybackRestore {
    positionSeconds: number;
    shouldPlay: boolean;
    skipPlayStart: boolean;
}

export interface MusicPlayerContextValue {
    mediaBaseUrl: string;
    catalogApiBaseUrl: string;
    catalog?: PublishedCatalog;
    selectedReleaseSummary?: CatalogReleaseSummary;
    releaseManifest?: PublishedReleaseManifest;
    selectedTrack?: PublishedReleaseTrack;
    selectedQuality: QualitySelection;
    hlsFormats: PlaybackFormat[];
    loadState: LoadState;
    loadError?: string;
    playbackError?: string;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    artworkSrc: string;
    artworkAltText: string;
    canGoBack: boolean;
    canGoForward: boolean;
    playRelease: (releaseId: StableId) => void;
    playTrack: (releaseId: StableId, trackId: StableId) => void;
    selectRelease: (releaseId: StableId) => void;
    selectTrack: (trackId: StableId) => void;
    selectTrackOffset: (offset: number) => void;
    setQuality: (value: string) => void;
    seek: (value: string) => void;
    togglePlay: () => void;
}

interface MusicPlayerProviderProps {
    children: ReactNode;
    fallbackArtworkSrc: string;
}

const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';
const TEN_SECOND_PLAY_MILESTONE = 10;
const PROGRESS_MILESTONES = [25, 50, 75] as const;
const MusicPlayerContext = createContext<MusicPlayerContextValue | undefined>(undefined);

export function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return '0:00';
    }

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

export function formatQualityLabel(format: PlaybackFormat): string {
    if (format.bitrateKbps) {
        return `${format.bitrateKbps} kbps AAC`;
    }

    return format.quality;
}

function isHlsRendition(format: PlaybackFormat): boolean {
    return format.kind === 'hls-rendition' && format.mimeType === HLS_MIME_TYPE;
}

function isPlaybackQuality(value: string): value is PlaybackQuality {
    return value === 'aac-192' || value === 'aac-320' || value === 'flac-lossless';
}

function getHlsFormats(track: PublishedReleaseTrack | undefined): PlaybackFormat[] {
    return track?.playback.formats.filter(isHlsRendition) ?? [];
}

function getPlaybackSource(
    mediaBaseUrl: string,
    track: PublishedReleaseTrack,
    selectedQuality: QualitySelection,
): PlaybackSource {
    const selectedFormat = selectedQuality === 'auto'
        ? undefined
        : track.playback.formats.find((format) => isHlsRendition(format) && format.quality === selectedQuality);

    if (selectedFormat) {
        return {
            assetId: selectedFormat.assetId,
            quality: selectedFormat.quality,
            url: resolveMediaUrl(mediaBaseUrl, selectedFormat.url ?? selectedFormat.path),
        };
    }

    return {
        assetId: track.playback.hls.assetId,
        quality: 'auto',
        url: resolveMediaUrl(mediaBaseUrl, track.playback.hls.url ?? track.playback.hls.path),
    };
}

function getMediaDuration(audio: HTMLAudioElement, fallbackDurationSeconds: number): number {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
        return audio.duration;
    }

    return fallbackDurationSeconds;
}

function findReleaseSummary(
    catalog: PublishedCatalog | undefined,
    releaseId: StableId | undefined,
): CatalogReleaseSummary | undefined {
    return catalog?.releases.find((release) => release.releaseId === releaseId);
}

function initialRouteTarget(catalog: PublishedCatalog): {
    releaseId?: StableId;
    releaseSlug?: string;
    trackSlug?: string;
} {
    if (typeof window === 'undefined') {
        return {};
    }

    const parts = window.location.pathname
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(Boolean);

    if (parts[0] === 'releases' && parts[1]) {
        const releaseSlug = decodeURIComponent(parts[1]);
        return {
            releaseSlug,
            releaseId: catalog.releases.find((release) => release.slug === releaseSlug)?.releaseId,
        };
    }

    if (parts[0] === 'tracks' && parts[1] && parts[2]) {
        const releaseSlug = decodeURIComponent(parts[1]);
        return {
            releaseSlug,
            releaseId: catalog.releases.find((release) => release.slug === releaseSlug)?.releaseId,
            trackSlug: decodeURIComponent(parts[2]),
        };
    }

    return {};
}

export function MusicPlayerProvider({ children, fallbackArtworkSrc }: MusicPlayerProviderProps) {
    const runtimeConfig = useMemo(() => getRuntimeConfig(), []);
    const mediaBaseUrl = runtimeConfig.mediaBaseUrl;
    const catalogApiBaseUrl = runtimeConfig.adminApiBaseUrl;
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const pendingRestoreRef = useRef<PendingPlaybackRestore | null>(null);
    const pendingRouteTrackSlugRef = useRef<string | undefined>(undefined);
    const progressMilestonesRef = useRef<Set<string>>(new Set());
    const suppressPauseUntilRef = useRef(0);
    const skipNextPlayStartRef = useRef(false);
    const initialRouteAppliedRef = useRef(false);

    const [catalog, setCatalog] = useState<PublishedCatalog>();
    const [selectedReleaseId, setSelectedReleaseId] = useState<StableId>();
    const [selectedReleaseSlug, setSelectedReleaseSlug] = useState<string>();
    const [releaseManifest, setReleaseManifest] = useState<PublishedReleaseManifest>();
    const [selectedTrackId, setSelectedTrackId] = useState<StableId>();
    const [selectedQuality, setSelectedQuality] = useState<QualitySelection>('auto');
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [loadError, setLoadError] = useState<string>();
    const [playbackError, setPlaybackError] = useState<string>();
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    const selectedReleaseSummary = useMemo(
        () => (
            findReleaseSummary(catalog, selectedReleaseId) ??
            catalog?.releases.find((release) => release.slug === selectedReleaseSlug)
        ),
        [catalog, selectedReleaseId, selectedReleaseSlug],
    );
    const selectedTrack = useMemo(
        () => releaseManifest?.tracks.find((track) => track.trackId === selectedTrackId),
        [releaseManifest, selectedTrackId],
    );
    const hlsFormats = useMemo(() => getHlsFormats(selectedTrack), [selectedTrack]);
    const selectedSource = useMemo(
        () => selectedTrack ? getPlaybackSource(mediaBaseUrl, selectedTrack, selectedQuality) : undefined,
        [mediaBaseUrl, selectedQuality, selectedTrack],
    );
    const selectedArtwork: CatalogArtwork | undefined = selectedTrack?.artwork ?? releaseManifest?.artwork;
    const artworkSrc = selectedArtwork ? getArtworkUrl(mediaBaseUrl, selectedArtwork) ?? fallbackArtworkSrc : fallbackArtworkSrc;
    const artworkAltText = selectedArtwork?.altText ?? 'Cover art';

    useEffect(() => {
        const controller = new AbortController();
        setLoadState('loading');
        setLoadError(undefined);

        fetchPublishedCatalog(catalogApiBaseUrl, controller.signal)
            .then((publishedCatalog) => {
                const target = initialRouteTarget(publishedCatalog);
                if (publishedCatalog.releases.length === 0 && !target.releaseSlug) {
                    throw new Error('Published catalog has no releases.');
                }

                initialRouteAppliedRef.current = true;
                pendingRouteTrackSlugRef.current = target.trackSlug;
                setCatalog(publishedCatalog);
                setSelectedReleaseSlug(target.releaseSlug);
                setSelectedReleaseId(target.releaseId ?? publishedCatalog.releases[0]?.releaseId);
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }

                setLoadState('error');
                setLoadError(error instanceof Error ? error.message : String(error));
            });

        return () => controller.abort();
    }, [catalogApiBaseUrl]);

    useEffect(() => {
        if (!catalog || selectedReleaseId || initialRouteAppliedRef.current) {
            return;
        }

        setSelectedReleaseId(catalog.releases[0]?.releaseId);
    }, [catalog, selectedReleaseId]);

    useEffect(() => {
        const releaseSlug = selectedReleaseSlug;
        if (!selectedReleaseSummary && !releaseSlug) {
            return undefined;
        }

        const controller = new AbortController();
        setLoadState('loading');
        setLoadError(undefined);
        setPlaybackError(undefined);

        const request = selectedReleaseSummary
            ? fetchReleaseManifest(catalogApiBaseUrl, selectedReleaseSummary, controller.signal)
            : fetchReleaseManifestBySlug(catalogApiBaseUrl, releaseSlug, controller.signal);

        request
            .then((manifest) => {
                if (manifest.tracks.length === 0) {
                    throw new Error(`${manifest.title} has no published tracks.`);
                }

                const routeTrackSlug = pendingRouteTrackSlugRef.current;
                pendingRouteTrackSlugRef.current = undefined;
                const routeTrackId = routeTrackSlug
                    ? manifest.tracks.find((track) => track.slug === routeTrackSlug)?.trackId
                    : undefined;

                setReleaseManifest(manifest);
                setSelectedReleaseId(manifest.releaseId);
                setSelectedReleaseSlug(manifest.slug);
                setSelectedTrackId((currentTrackId) => (
                    routeTrackId ??
                    (manifest.tracks.some((track) => track.trackId === currentTrackId)
                        ? currentTrackId
                        : manifest.tracks[0].trackId)
                ));
                setSelectedQuality('auto');
                setDuration(manifest.tracks[0].durationSeconds);
                setCurrentTime(0);
                setLoadState('ready');
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }

                setLoadState('error');
                setLoadError(error instanceof Error ? error.message : String(error));
            });

        return () => controller.abort();
    }, [catalogApiBaseUrl, selectedReleaseSlug, selectedReleaseSummary]);

    useEffect(() => {
        if (!releaseManifest) {
            return;
        }

        recordReleaseView({
            releaseId: releaseManifest.releaseId,
            assetId: releaseManifest.artwork.assetId,
            positionSeconds: 0,
        });
        releaseManifest.tracks.forEach((track) => {
            recordTrackImpression({
                releaseId: releaseManifest.releaseId,
                songId: track.songId,
                recordingId: track.recordingId,
                trackId: track.trackId,
                assetId: track.playback.hls.assetId,
                positionSeconds: 0,
                durationSeconds: track.durationSeconds,
            });
        });
    }, [releaseManifest]);

    useEffect(() => {
        setCurrentTime(0);
        setDuration(selectedTrack?.durationSeconds ?? 0);
        setPlaybackError(undefined);
    }, [selectedTrack]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || !selectedSource || !releaseManifest || !selectedTrack) {
            return undefined;
        }

        let hls: HlsInstance | undefined;
        let removedNativeListener: (() => void) | undefined;
        let disposed = false;

        suppressPauseUntilRef.current = Date.now() + 500;

        const restorePlayback = () => {
            const pendingRestore = pendingRestoreRef.current;
            pendingRestoreRef.current = null;

            if (!pendingRestore || disposed) {
                return;
            }

            const nextPosition = Math.min(
                pendingRestore.positionSeconds,
                Math.max(selectedTrack.durationSeconds - 0.25, 0),
            );

            if (Number.isFinite(nextPosition) && nextPosition > 0) {
                audio.currentTime = nextPosition;
                setCurrentTime(nextPosition);
            }

            if (pendingRestore.shouldPlay) {
                skipNextPlayStartRef.current = pendingRestore.skipPlayStart;
                void audio.play().catch((error: unknown) => {
                    const context = createEventContext(nextPosition, selectedSource);
                    if (context) {
                        recordPlayError(context, error);
                    }
                    setPlaybackError('Playback could not start.');
                });
            }
        };

        const recordSourceError = (error: unknown) => {
            const context = createEventContext(audio.currentTime, selectedSource);
            if (context) {
                recordPlayError(context, error);
            }
            setPlaybackError('Playback failed.');
        };

        const attachHls = async () => {
            const { default: Hls } = await import('hls.js/light');
            if (disposed) {
                return;
            }

            if (!Hls.isSupported()) {
                recordSourceError(new Error('HLS playback is not supported in this browser.'));
                return;
            }

            hls = new Hls({
                enableWorker: true,
            });
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (!data.fatal) {
                    return;
                }

                recordSourceError(new Error(`HLS ${data.type}: ${data.details}`));
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    hls?.startLoad();
                    return;
                }

                if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    hls?.recoverMediaError();
                    return;
                }

                hls?.destroy();
            });
            hls.on(Hls.Events.MANIFEST_PARSED, restorePlayback);
            hls.loadSource(selectedSource.url);
            hls.attachMedia(audio);
        };

        if (audio.canPlayType(HLS_MIME_TYPE)) {
            const handleLoadedMetadata = () => restorePlayback();
            audio.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true });
            removedNativeListener = () => audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.src = selectedSource.url;
            audio.load();
        } else {
            void attachHls().catch((error: unknown) => {
                recordSourceError(error);
            });
        }

        return () => {
            disposed = true;
            removedNativeListener?.();
            hls?.destroy();
        };
    }, [releaseManifest, selectedSource, selectedTrack]);

    function createEventContext(
        positionSeconds = audioRef.current?.currentTime ?? currentTime,
        source: PlaybackSource | undefined = selectedSource,
    ): PlayerEventContext | undefined {
        if (!releaseManifest || !selectedTrack || !source) {
            return undefined;
        }

        return {
            releaseId: releaseManifest.releaseId,
            songId: selectedTrack.songId,
            recordingId: selectedTrack.recordingId,
            trackId: selectedTrack.trackId,
            assetId: source.assetId,
            quality: source.quality,
            positionSeconds,
            durationSeconds: duration || selectedTrack.durationSeconds,
        };
    }

    function recordPlaybackError(error: unknown, message = 'Playback failed.'): void {
        const context = createEventContext();
        if (context) {
            recordPlayError(context, error);
        }
        setPlaybackError(message);
    }

    function queueTrackChange(trackId: StableId, shouldPlay: boolean): void {
        pendingRestoreRef.current = {
            positionSeconds: 0,
            shouldPlay,
            skipPlayStart: false,
        };
        suppressPauseUntilRef.current = Date.now() + 500;
        setSelectedTrackId(trackId);
        setSelectedQuality('auto');
        setCurrentTime(0);
    }

    function selectRelease(releaseId: StableId): void {
        if (releaseId === selectedReleaseId) {
            return;
        }

        const audio = audioRef.current;
        pendingRestoreRef.current = {
            positionSeconds: 0,
            shouldPlay: Boolean(audio && !audio.paused),
            skipPlayStart: false,
        };
        suppressPauseUntilRef.current = Date.now() + 500;
        setSelectedReleaseId(releaseId);
        setSelectedReleaseSlug(findReleaseSummary(catalog, releaseId)?.slug);
        setReleaseManifest(undefined);
        setSelectedTrackId(undefined);
        setSelectedQuality('auto');
        setCurrentTime(0);
    }

    function selectTrack(trackId: StableId): void {
        if (trackId === selectedTrackId) {
            return;
        }

        const audio = audioRef.current;
        queueTrackChange(trackId, Boolean(audio && !audio.paused));
    }

    function playRelease(releaseId: StableId): void {
        if (releaseId !== selectedReleaseId) {
            pendingRestoreRef.current = {
                positionSeconds: 0,
                shouldPlay: true,
                skipPlayStart: false,
            };
            suppressPauseUntilRef.current = Date.now() + 500;
            setSelectedReleaseId(releaseId);
            setSelectedReleaseSlug(findReleaseSummary(catalog, releaseId)?.slug);
            setReleaseManifest(undefined);
            setSelectedTrackId(undefined);
            setSelectedQuality('auto');
            setCurrentTime(0);
            return;
        }

        if (!releaseManifest) {
            pendingRestoreRef.current = {
                positionSeconds: 0,
                shouldPlay: true,
                skipPlayStart: false,
            };
            return;
        }

        const firstTrack = releaseManifest?.tracks[0];
        if (firstTrack) {
            playTrack(releaseId, firstTrack.trackId);
        }
    }

    function playTrack(releaseId: StableId, trackId: StableId): void {
        const audio = audioRef.current;
        if (releaseId !== selectedReleaseId) {
            pendingRestoreRef.current = {
                positionSeconds: 0,
                shouldPlay: true,
                skipPlayStart: false,
            };
            suppressPauseUntilRef.current = Date.now() + 500;
            setSelectedReleaseId(releaseId);
            setSelectedReleaseSlug(findReleaseSummary(catalog, releaseId)?.slug);
            setReleaseManifest(undefined);
            setSelectedTrackId(trackId);
            setSelectedQuality('auto');
            setCurrentTime(0);
            return;
        }

        if (trackId !== selectedTrackId) {
            queueTrackChange(trackId, true);
            return;
        }

        if (audio?.paused) {
            void audio.play().catch((error: unknown) => {
                recordPlaybackError(error, 'Playback could not start.');
            });
        }
    }

    function selectTrackOffset(offset: number): void {
        if (!releaseManifest || !selectedTrack) {
            return;
        }

        const currentIndex = releaseManifest.tracks.findIndex((track) => track.trackId === selectedTrack.trackId);
        const nextTrack = releaseManifest.tracks[currentIndex + offset];
        if (nextTrack) {
            selectTrack(nextTrack.trackId);
        }
    }

    function setQuality(value: string): void {
        if (!selectedTrack) {
            return;
        }

        const nextQuality: QualitySelection = value === 'auto' || !isPlaybackQuality(value) ? 'auto' : value;
        if (nextQuality === selectedQuality) {
            return;
        }

        const audio = audioRef.current;
        const nextSource = getPlaybackSource(mediaBaseUrl, selectedTrack, nextQuality);
        const previousQuality = selectedQuality;
        const positionSeconds = audio?.currentTime ?? currentTime;
        const context = createEventContext(positionSeconds, nextSource);

        if (context) {
            recordQualityChanged(context, previousQuality, nextQuality);
        }

        pendingRestoreRef.current = {
            positionSeconds,
            shouldPlay: Boolean(audio && !audio.paused),
            skipPlayStart: true,
        };
        suppressPauseUntilRef.current = Date.now() + 500;
        setSelectedQuality(nextQuality);
    }

    function togglePlay(): void {
        const audio = audioRef.current;
        if (!audio) {
            return;
        }

        setPlaybackError(undefined);
        if (audio.paused) {
            void audio.play().catch((error: unknown) => {
                recordPlaybackError(error, 'Playback could not start.');
            });
            return;
        }

        audio.pause();
    }

    function seek(nextValue: string): void {
        const audio = audioRef.current;
        if (!audio) {
            return;
        }

        const nextTime = Number(nextValue);
        if (!Number.isFinite(nextTime)) {
            return;
        }

        const previousTime = audio.currentTime;
        audio.currentTime = nextTime;
        setCurrentTime(nextTime);

        if (Math.abs(previousTime - nextTime) >= 1) {
            const context = createEventContext(nextTime);
            if (context) {
                recordPlaySeek(context, previousTime, nextTime);
            }
        }
    }

    function handlePlay(): void {
        setIsPlaying(true);
        if (skipNextPlayStartRef.current) {
            skipNextPlayStartRef.current = false;
            return;
        }

        const context = createEventContext();
        if (context) {
            recordPlayStart(context);
        }
    }

    function handlePause(): void {
        setIsPlaying(false);
        if (Date.now() < suppressPauseUntilRef.current || audioRef.current?.ended) {
            return;
        }

        const context = createEventContext();
        if (context) {
            recordPlayPause(context);
        }
    }

    function handleLoadedMetadata(): void {
        const audio = audioRef.current;
        if (!audio || !selectedTrack) {
            return;
        }

        setDuration(getMediaDuration(audio, selectedTrack.durationSeconds));
    }

    function handleTimeUpdate(): void {
        const audio = audioRef.current;
        if (!audio || !selectedTrack) {
            return;
        }

        const nextTime = audio.currentTime;
        const nextDuration = getMediaDuration(audio, selectedTrack.durationSeconds);
        setCurrentTime(nextTime);
        setDuration(nextDuration);

        if (nextDuration <= 0) {
            return;
        }

        const playbackSessionId = getPlaybackSessionId();
        const tenSecondKey = `${playbackSessionId}:${selectedTrack.trackId}:10s`;
        if (nextTime >= TEN_SECOND_PLAY_MILESTONE && !progressMilestonesRef.current.has(tenSecondKey)) {
            progressMilestonesRef.current.add(tenSecondKey);
            const context = createEventContext(nextTime);
            if (context) {
                recordPlayTenSeconds(context);
            }
        }

        const percentComplete = (nextTime / nextDuration) * 100;

        PROGRESS_MILESTONES.forEach((milestone) => {
            const milestoneKey = `${playbackSessionId}:${selectedTrack.trackId}:${milestone}`;
            if (percentComplete < milestone || progressMilestonesRef.current.has(milestoneKey)) {
                return;
            }

            progressMilestonesRef.current.add(milestoneKey);
            const context = createEventContext(nextTime);
            if (context) {
                recordPlayProgress(context, milestone);
            }
        });
    }

    function handleEnded(): void {
        setIsPlaying(false);
        const context = createEventContext(duration || (selectedTrack?.durationSeconds ?? currentTime));
        if (context) {
            recordPlayComplete(context);
        }

        if (!releaseManifest || !selectedTrack) {
            return;
        }

        const currentIndex = releaseManifest.tracks.findIndex((track) => track.trackId === selectedTrack.trackId);
        const nextTrack = releaseManifest.tracks[currentIndex + 1];
        if (nextTrack) {
            pendingRestoreRef.current = {
                positionSeconds: 0,
                shouldPlay: true,
                skipPlayStart: false,
            };
            setSelectedTrackId(nextTrack.trackId);
            setSelectedQuality('auto');
        }
    }

    const currentTrackIndex = releaseManifest && selectedTrack
        ? releaseManifest.tracks.findIndex((track) => track.trackId === selectedTrack.trackId)
        : -1;
    const canGoBack = currentTrackIndex > 0;
    const canGoForward = Boolean(releaseManifest && currentTrackIndex >= 0 && currentTrackIndex < releaseManifest.tracks.length - 1);

    const value: MusicPlayerContextValue = {
        mediaBaseUrl,
        catalogApiBaseUrl,
        catalog,
        selectedReleaseSummary,
        releaseManifest,
        selectedTrack,
        selectedQuality,
        hlsFormats,
        loadState,
        loadError,
        playbackError,
        isPlaying,
        currentTime,
        duration,
        artworkSrc,
        artworkAltText,
        canGoBack,
        canGoForward,
        playRelease,
        playTrack,
        selectRelease,
        selectTrack,
        selectTrackOffset,
        setQuality,
        seek,
        togglePlay,
    };

    return (
        <MusicPlayerContext.Provider value={value}>
            <audio
                ref={audioRef}
                crossOrigin="anonymous"
                preload="metadata"
                onEnded={handleEnded}
                onError={() => recordPlaybackError(new Error('The audio element reported a playback error.'))}
                onLoadedMetadata={handleLoadedMetadata}
                onPause={handlePause}
                onPlay={handlePlay}
                onTimeUpdate={handleTimeUpdate}
            />
            {children}
        </MusicPlayerContext.Provider>
    );
}

export function useMusicPlayer(): MusicPlayerContextValue {
    const value = useContext(MusicPlayerContext);
    if (!value) {
        throw new Error('useMusicPlayer must be used inside MusicPlayerProvider');
    }

    return value;
}
