import { AlertCircle, LoaderCircle, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import type { CSSProperties } from 'react';
import {
    formatQualityLabel,
    formatTime,
    useMusicPlayer,
} from './MusicPlayerContext';
import { handleInternalLink, releasePath, trackPath } from './routes';

export default function StickyPlayer() {
    const player = useMusicPlayer();
    const resolvedDuration = player.duration || player.selectedTrack?.durationSeconds || 0;
    const seekMax = Math.max(resolvedDuration, 0);
    const progress = seekMax > 0 ? Math.min(100, (player.currentTime / seekMax) * 100) : 0;
    const progressStyle = { '--progress': `${progress}%` } as CSSProperties;

    if (player.loadState === 'error') {
        return (
            <aside className="bottom-player bottom-player--status" role="alert">
                <AlertCircle aria-hidden="true" />
                <span>{player.loadError ?? 'The streaming catalog is unavailable.'}</span>
            </aside>
        );
    }

    if (player.loadState === 'loading' || !player.releaseManifest || !player.selectedTrack) {
        return (
            <aside className="bottom-player bottom-player--status" aria-busy="true">
                <LoaderCircle className="bottom-player__spinner" aria-hidden="true" />
                <span>Loading catalog</span>
            </aside>
        );
    }

    return (
        <aside className="bottom-player" aria-label="Music player">
            <div className="bottom-player__layout">
                <a
                    className="bottom-player__artwork"
                    href={releasePath(player.releaseManifest.slug)}
                    onClick={(event) => handleInternalLink(event, releasePath(player.releaseManifest!.slug))}
                    aria-label={`Open ${player.releaseManifest.title}`}
                >
                    <img src={player.artworkSrc} alt={player.artworkAltText} />
                </a>

                <div className="bottom-player__now-playing">
                    <a
                        href={trackPath(player.releaseManifest.slug, player.selectedTrack.slug)}
                        onClick={(event) => handleInternalLink(event, trackPath(player.releaseManifest!.slug, player.selectedTrack!.slug))}
                        className="bottom-player__track"
                    >
                        {player.selectedTrack.title}
                    </a>
                    <a
                        href={releasePath(player.releaseManifest.slug)}
                        onClick={(event) => handleInternalLink(event, releasePath(player.releaseManifest!.slug))}
                        className="bottom-player__album"
                    >
                        {player.releaseManifest.artistName} — {player.releaseManifest.title}
                    </a>
                    {player.playbackError ? <span className="bottom-player__error">{player.playbackError}</span> : null}
                </div>

                <div className="bottom-player__controls">
                    <button
                        type="button"
                        className="bottom-player__icon-button"
                        disabled={!player.canGoBack}
                        onClick={() => player.selectTrackOffset(-1)}
                        aria-label="Previous track"
                        title="Previous track"
                    >
                        <SkipBack aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        className={`bottom-player__play-button${player.isPlaying ? ' is-playing' : ''}`}
                        onClick={player.togglePlay}
                        aria-label={player.isPlaying ? 'Pause' : 'Play'}
                        title={player.isPlaying ? 'Pause' : 'Play'}
                    >
                        {player.isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                    </button>
                    <button
                        type="button"
                        className="bottom-player__icon-button"
                        disabled={!player.canGoForward}
                        onClick={() => player.selectTrackOffset(1)}
                        aria-label="Next track"
                        title="Next track"
                    >
                        <SkipForward aria-hidden="true" />
                    </button>
                </div>

                <div className="bottom-player__timeline" style={progressStyle}>
                    <span className={player.isPlaying ? 'is-current' : undefined}>{formatTime(player.currentTime)}</span>
                    <input
                        type="range"
                        min="0"
                        max={seekMax}
                        step="0.1"
                        value={Math.min(player.currentTime, seekMax)}
                        onChange={(event) => player.seek(event.currentTarget.value)}
                        style={progressStyle}
                        aria-label="Playback position"
                    />
                    <span>{formatTime(seekMax)}</span>
                </div>

                <label className="bottom-player__quality">
                    <span>Quality</span>
                    <select value={player.selectedQuality} onChange={(event) => player.setQuality(event.currentTarget.value)}>
                        <option value="auto">Auto</option>
                        {player.hlsFormats.map((format) => (
                            <option key={format.assetId} value={format.quality}>
                                {formatQualityLabel(format)}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
        </aside>
    );
}
