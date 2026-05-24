import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import {
    fetchAlbumManifest,
    fetchPublishedCatalog,
    getArtworkUrl,
    resolveMediaUrl,
} from './catalog/catalog-client';
import type {
    CatalogAlbumSummary,
    PlaybackFormat,
    PlaybackQuality,
    PublishedAlbumManifest,
    PublishedCatalog,
    PublishedTrack,
    StableId,
} from './catalog/media-catalog';
import {
    getPlaybackSessionId,
    recordAlbumView,
    recordPlayComplete,
    recordPlayError,
    recordPlayPause,
    recordPlayProgress,
    recordPlaySeek,
    recordPlayStart,
    recordQualityChanged,
    recordTrackImpression,
    type PlayerEventContext,
} from './player-analytics';
import { getRuntimeConfig } from './runtime-config';

type LoadState = 'loading' | 'ready' | 'error';
type QualitySelection = 'auto' | PlaybackQuality;
type HlsInstance = InstanceType<typeof import('hls.js/light').default>;

interface StreamingPlayerProps {
    fallbackArtworkSrc: string;
}

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

const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';
const PROGRESS_MILESTONES = [25, 50, 75] as const;

function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return '0:00';
    }

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function isHlsRendition(format: PlaybackFormat): boolean {
    return format.kind === 'hls-rendition' && format.mimeType === HLS_MIME_TYPE;
}

function isPlaybackQuality(value: string): value is PlaybackQuality {
    return value === 'aac-192' || value === 'aac-320' || value === 'flac-lossless';
}

function formatQualityLabel(format: PlaybackFormat): string {
    if (format.bitrateKbps) {
        return `${format.bitrateKbps} kbps AAC`;
    }

    return format.quality;
}

function getHlsFormats(track: PublishedTrack | undefined): PlaybackFormat[] {
    return track?.playback.formats.filter(isHlsRendition) ?? [];
}

function getPlaybackSource(
    mediaBaseUrl: string,
    track: PublishedTrack,
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

function findAlbumSummary(
    catalog: PublishedCatalog | undefined,
    albumId: StableId | undefined,
): CatalogAlbumSummary | undefined {
    return catalog?.albums.find((album) => album.albumId === albumId);
}

export default function StreamingPlayer({ fallbackArtworkSrc }: StreamingPlayerProps) {
    const mediaBaseUrl = useMemo(() => getRuntimeConfig().mediaBaseUrl, []);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const pendingRestoreRef = useRef<PendingPlaybackRestore | null>(null);
    const progressMilestonesRef = useRef<Set<string>>(new Set());
    const suppressPauseUntilRef = useRef(0);
    const skipNextPlayStartRef = useRef(false);

    const [catalog, setCatalog] = useState<PublishedCatalog>();
    const [selectedAlbumId, setSelectedAlbumId] = useState<StableId>();
    const [albumManifest, setAlbumManifest] = useState<PublishedAlbumManifest>();
    const [selectedTrackId, setSelectedTrackId] = useState<StableId>();
    const [selectedQuality, setSelectedQuality] = useState<QualitySelection>('auto');
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [loadError, setLoadError] = useState<string>();
    const [playbackError, setPlaybackError] = useState<string>();
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [artworkSrc, setArtworkSrc] = useState(fallbackArtworkSrc);

    const selectedAlbumSummary = useMemo(
        () => findAlbumSummary(catalog, selectedAlbumId),
        [catalog, selectedAlbumId],
    );
    const selectedTrack = useMemo(
        () => albumManifest?.tracks.find((track) => track.trackId === selectedTrackId),
        [albumManifest, selectedTrackId],
    );
    const hlsFormats = useMemo(() => getHlsFormats(selectedTrack), [selectedTrack]);
    const selectedSource = useMemo(
        () => selectedTrack ? getPlaybackSource(mediaBaseUrl, selectedTrack, selectedQuality) : undefined,
        [mediaBaseUrl, selectedQuality, selectedTrack],
    );

    useEffect(() => {
        const controller = new AbortController();
        setLoadState('loading');
        setLoadError(undefined);

        fetchPublishedCatalog(mediaBaseUrl, controller.signal)
            .then((publishedCatalog) => {
                if (publishedCatalog.albums.length === 0) {
                    throw new Error('Published catalog has no albums.');
                }

                setCatalog(publishedCatalog);
                setSelectedAlbumId((currentAlbumId) => currentAlbumId ?? publishedCatalog.albums[0].albumId);
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }

                setLoadState('error');
                setLoadError(error instanceof Error ? error.message : String(error));
            });

        return () => controller.abort();
    }, [mediaBaseUrl]);

    useEffect(() => {
        if (!selectedAlbumSummary) {
            return undefined;
        }

        const controller = new AbortController();
        setLoadState('loading');
        setLoadError(undefined);
        setPlaybackError(undefined);

        fetchAlbumManifest(mediaBaseUrl, selectedAlbumSummary, controller.signal)
            .then((manifest) => {
                if (manifest.tracks.length === 0) {
                    throw new Error(`${manifest.title} has no published tracks.`);
                }

                setAlbumManifest(manifest);
                setSelectedTrackId((currentTrackId) => (
                    manifest.tracks.some((track) => track.trackId === currentTrackId)
                        ? currentTrackId
                        : manifest.tracks[0].trackId
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
    }, [mediaBaseUrl, selectedAlbumSummary]);

    useEffect(() => {
        if (!albumManifest) {
            return;
        }

        setArtworkSrc(getArtworkUrl(mediaBaseUrl, albumManifest.artwork) ?? fallbackArtworkSrc);
        recordAlbumView({
            albumId: albumManifest.albumId,
            releaseId: albumManifest.releaseId,
            assetId: albumManifest.artwork.assetId,
            positionSeconds: 0,
        });
        albumManifest.tracks.forEach((track) => {
            recordTrackImpression({
                albumId: albumManifest.albumId,
                releaseId: albumManifest.releaseId,
                trackId: track.trackId,
                assetId: track.playback.hls.assetId,
                positionSeconds: 0,
                durationSeconds: track.durationSeconds,
            });
        });
    }, [albumManifest, fallbackArtworkSrc, mediaBaseUrl]);

    useEffect(() => {
        setCurrentTime(0);
        setDuration(selectedTrack?.durationSeconds ?? 0);
        setPlaybackError(undefined);
    }, [selectedTrack]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || !selectedSource || !albumManifest || !selectedTrack) {
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
    }, [albumManifest, selectedSource, selectedTrack]);

    function createEventContext(
        positionSeconds = audioRef.current?.currentTime ?? currentTime,
        source: PlaybackSource | undefined = selectedSource,
    ): PlayerEventContext | undefined {
        if (!albumManifest || !selectedTrack || !source) {
            return undefined;
        }

        return {
            albumId: albumManifest.albumId,
            releaseId: albumManifest.releaseId,
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

    function selectAlbum(albumId: StableId): void {
        if (albumId === selectedAlbumId) {
            return;
        }

        const audio = audioRef.current;
        pendingRestoreRef.current = {
            positionSeconds: 0,
            shouldPlay: Boolean(audio && !audio.paused),
            skipPlayStart: false,
        };
        suppressPauseUntilRef.current = Date.now() + 500;
        setSelectedAlbumId(albumId);
        setAlbumManifest(undefined);
        setSelectedTrackId(undefined);
        setSelectedQuality('auto');
        setCurrentTime(0);
    }

    function selectTrack(trackId: StableId): void {
        if (trackId === selectedTrackId) {
            return;
        }

        const audio = audioRef.current;
        pendingRestoreRef.current = {
            positionSeconds: 0,
            shouldPlay: Boolean(audio && !audio.paused),
            skipPlayStart: false,
        };
        suppressPauseUntilRef.current = Date.now() + 500;
        setSelectedTrackId(trackId);
        setSelectedQuality('auto');
        setCurrentTime(0);
    }

    function selectTrackOffset(offset: number): void {
        if (!albumManifest || !selectedTrack) {
            return;
        }

        const currentIndex = albumManifest.tracks.findIndex((track) => track.trackId === selectedTrack.trackId);
        const nextTrack = albumManifest.tracks[currentIndex + offset];
        if (nextTrack) {
            selectTrack(nextTrack.trackId);
        }
    }

    function handleQualityChange(value: string): void {
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

    function handleTogglePlay(): void {
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

    function handleSeek(nextValue: string): void {
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

        if (!albumManifest || !selectedTrack) {
            return;
        }

        const currentIndex = albumManifest.tracks.findIndex((track) => track.trackId === selectedTrack.trackId);
        const nextTrack = albumManifest.tracks[currentIndex + 1];
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

    const currentTrackIndex = albumManifest && selectedTrack
        ? albumManifest.tracks.findIndex((track) => track.trackId === selectedTrack.trackId)
        : -1;
    const canGoBack = currentTrackIndex > 0;
    const canGoForward = Boolean(albumManifest && currentTrackIndex >= 0 && currentTrackIndex < albumManifest.tracks.length - 1);
    const resolvedDuration = duration || selectedTrack?.durationSeconds || 0;
    const seekMax = Math.max(resolvedDuration, 0);

    if (loadState === 'error') {
        return (
            <div className="streaming-player streaming-player--status" role="alert">
                <AlertCircle aria-hidden="true" />
                <p>{loadError ?? 'The streaming catalog is unavailable.'}</p>
            </div>
        );
    }

    if (loadState === 'loading' || !catalog || !albumManifest || !selectedTrack || !selectedSource) {
        return (
            <div className="streaming-player streaming-player--status" aria-busy="true">
                <LoaderCircle className="streaming-player__spinner" aria-hidden="true" />
                <p>Loading catalog...</p>
            </div>
        );
    }

    return (
        <div className="streaming-player">
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

            <div className="streaming-player__layout">
                <div className="streaming-player__artwork-wrap">
                    <img
                        src={artworkSrc}
                        alt={albumManifest.artwork.altText}
                        className="streaming-player__artwork"
                        onError={() => setArtworkSrc(fallbackArtworkSrc)}
                    />
                </div>

                <div className="streaming-player__main">
                    <div className="streaming-player__album-row">
                        <div>
                            <p className="streaming-player__artist">{albumManifest.artistName}</p>
                            <h3>{albumManifest.title}</h3>
                            <p className="streaming-player__track-title">
                                {selectedTrack.trackNumber}. {selectedTrack.title}
                            </p>
                        </div>

                        <label className="streaming-player__quality">
                            <span>Quality</span>
                            <select
                                value={selectedQuality}
                                onChange={(event) => handleQualityChange(event.target.value)}
                            >
                                <option value="auto">Auto</option>
                                {hlsFormats.map((format) => (
                                    <option key={format.assetId} value={format.quality}>
                                        {formatQualityLabel(format)}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>

                    {catalog.albums.length > 1 && (
                        <div className="streaming-player__albums" aria-label="Albums">
                            {catalog.albums.map((album) => (
                                <button
                                    type="button"
                                    key={album.albumId}
                                    className={album.albumId === selectedAlbumSummary?.albumId ? 'is-active' : ''}
                                    onClick={() => selectAlbum(album.albumId)}
                                >
                                    {album.title}
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="streaming-player__controls">
                        <button
                            type="button"
                            className="streaming-player__icon-button"
                            disabled={!canGoBack}
                            onClick={() => selectTrackOffset(-1)}
                            aria-label="Previous track"
                            title="Previous track"
                        >
                            <SkipBack aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            className="streaming-player__play-button"
                            onClick={handleTogglePlay}
                            aria-label={isPlaying ? 'Pause' : 'Play'}
                            title={isPlaying ? 'Pause' : 'Play'}
                        >
                            {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                        </button>
                        <button
                            type="button"
                            className="streaming-player__icon-button"
                            disabled={!canGoForward}
                            onClick={() => selectTrackOffset(1)}
                            aria-label="Next track"
                            title="Next track"
                        >
                            <SkipForward aria-hidden="true" />
                        </button>
                    </div>

                    <div className="streaming-player__timeline">
                        <span>{formatTime(currentTime)}</span>
                        <input
                            type="range"
                            min="0"
                            max={seekMax}
                            step="0.1"
                            value={Math.min(currentTime, seekMax)}
                            onChange={(event) => handleSeek(event.target.value)}
                            aria-label="Playback position"
                        />
                        <span>{formatTime(seekMax)}</span>
                    </div>

                    {playbackError && (
                        <p className="streaming-player__error" role="alert">{playbackError}</p>
                    )}

                    <ol className="streaming-player__track-list">
                        {albumManifest.tracks.map((track) => (
                            <li key={track.trackId}>
                                <button
                                    type="button"
                                    className={track.trackId === selectedTrack.trackId ? 'is-active' : ''}
                                    onClick={() => selectTrack(track.trackId)}
                                    aria-current={track.trackId === selectedTrack.trackId ? 'true' : undefined}
                                >
                                    <span className="streaming-player__track-number">{track.trackNumber}</span>
                                    <span className="streaming-player__track-name">{track.title}</span>
                                    <span className="streaming-player__track-duration">
                                        {formatTime(track.durationSeconds)}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ol>
                </div>
            </div>
        </div>
    );
}
