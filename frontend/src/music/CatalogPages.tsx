import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CalendarDays, Disc3, ExternalLink, ListMusic, LoaderCircle, Play } from 'lucide-react';
import { fetchReleaseManifest, fetchReleaseManifestBySlug, fetchSongManifestBySlug, getArtworkUrl } from '../catalog/catalog-client';
import type {
    CatalogArtwork,
    CatalogReleaseSummary,
    PublishedReleaseManifest,
    PublishedReleaseTrack,
    PublishedSongManifest,
} from '../catalog/media-catalog';
import {
    formatTime,
    useMusicPlayer,
} from './MusicPlayerContext';
import { getTrackTitleLabel, TrackTitle } from './TrackTitle';
import { handleInternalLink, releasePath, songPath, trackPath } from './routes';

interface ReleasePageProps {
    slug: string;
}

interface SongPageProps {
    slug: string;
}

interface TrackPageProps {
    releaseSlug: string;
    trackSlug: string;
}

interface ReleaseLoadState {
    release?: PublishedReleaseManifest;
    error?: string;
    loading: boolean;
}

interface SongLoadState {
    song?: PublishedSongManifest;
    error?: string;
    loading: boolean;
}

function formatReleaseKind(value: string): string {
    return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function releaseDescription(release: PublishedReleaseManifest | CatalogReleaseSummary): string {
    if ('description' in release && release.description) {
        return release.description;
    }

    return `${formatReleaseKind(release.releaseKind)} by Tsonu.`;
}

function useReleaseBySlug(slug: string | undefined): ReleaseLoadState {
    const { catalog, catalogApiBaseUrl } = useMusicPlayer();
    const summary = useMemo(
        () => catalog?.releases.find((release) => release.slug === slug),
        [catalog, slug],
    );
    const [state, setState] = useState<ReleaseLoadState>({ loading: false });

    useEffect(() => {
        if (!catalog) {
            setState({ loading: true });
            return undefined;
        }

        if (!slug) {
            setState({ loading: false, error: 'Release not found.' });
            return undefined;
        }

        const controller = new AbortController();
        setState({ loading: true });
        const request = summary
            ? fetchReleaseManifest(catalogApiBaseUrl, summary, controller.signal)
            : fetchReleaseManifestBySlug(catalogApiBaseUrl, slug, controller.signal);
        request
            .then((release) => setState({ release, loading: false }))
            .catch((error: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }
                setState({
                    loading: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            });

        return () => controller.abort();
    }, [catalog, catalogApiBaseUrl, slug, summary]);

    return state;
}

function useSongBySlug(slug: string | undefined): SongLoadState {
    const { catalogApiBaseUrl } = useMusicPlayer();
    const [state, setState] = useState<SongLoadState>({ loading: false });

    useEffect(() => {
        if (!slug) {
            setState({ loading: false, error: 'Song not found.' });
            return undefined;
        }

        const controller = new AbortController();
        setState({ loading: true });
        fetchSongManifestBySlug(catalogApiBaseUrl, slug, controller.signal)
            .then((song) => setState({ song, loading: false }))
            .catch((error: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }
                setState({
                    loading: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            });

        return () => controller.abort();
    }, [catalogApiBaseUrl, slug]);

    return state;
}

function PageStatus({ error }: { error?: string }) {
    return (
        <main className="music-page music-page--status">
            {error ? <AlertCircle aria-hidden="true" /> : <LoaderCircle className="music-page__spinner" aria-hidden="true" />}
            <p>{error ?? 'Loading catalog'}</p>
        </main>
    );
}

function ArtworkImage({ artwork, className }: { artwork: CatalogArtwork | undefined; className: string }) {
    const { mediaBaseUrl } = useMusicPlayer();
    const src = artwork ? getArtworkUrl(mediaBaseUrl, artwork) : undefined;
    return src && artwork ? <img className={className} src={src} alt={artwork.altText} /> : <ListMusic className={className} aria-hidden="true" />;
}

function ReleaseArtwork({ release, className }: { release: PublishedReleaseManifest | CatalogReleaseSummary; className: string }) {
    return <ArtworkImage artwork={release.artwork} className={className} />;
}

function TrackRows({ release, activeTrack }: { release: PublishedReleaseManifest; activeTrack?: PublishedReleaseTrack }) {
    const player = useMusicPlayer();

    return (
        <ol className="catalog-track-list">
            {release.tracks.map((track) => {
                const title = getTrackTitleLabel(track);
                return (
                    <li key={track.trackId}>
                        <button
                            type="button"
                            className="catalog-track-list__play"
                            onClick={() => player.playTrack(release.releaseId, track.trackId)}
                            aria-label={`Play ${title}`}
                            title={`Play ${title}`}
                        >
                            <Play aria-hidden="true" />
                        </button>
                        <a
                            href={trackPath(release.slug, track.slug)}
                            onClick={(event) => handleInternalLink(event, trackPath(release.slug, track.slug))}
                            className={activeTrack?.trackId === track.trackId ? 'is-active' : undefined}
                        >
                            <span>{track.trackNumber}</span>
                            <strong><TrackTitle track={track} /></strong>
                            <span>{formatTime(track.durationSeconds)}</span>
                        </a>
                    </li>
                );
            })}
        </ol>
    );
}

export function CatalogPage() {
    const player = useMusicPlayer();

    if (player.loadState === 'error') {
        return <PageStatus error={player.loadError} />;
    }

    if (!player.catalog) {
        return <PageStatus />;
    }

    return (
        <main className="music-page">
            <header className="catalog-header">
                <p className="section-eyebrow">Catalog</p>
                <h1>Tsonu Music</h1>
                <p>Releases, previews, demos, and non-platform music in one first-party catalog.</p>
            </header>

            <section className="catalog-grid" aria-label="Releases">
                {player.catalog.releases.map((release) => (
                    <article className="catalog-album-card" key={release.releaseId}>
                        <a
                            href={releasePath(release.slug)}
                            onClick={(event) => handleInternalLink(event, releasePath(release.slug))}
                            className="catalog-album-card__art"
                        >
                            <ReleaseArtwork release={release} className="catalog-album-card__image" />
                        </a>
                        <div className="catalog-album-card__body">
                            <p>{formatReleaseKind(release.releaseKind)} - {release.releaseDate}</p>
                            <h2>
                                <a href={releasePath(release.slug)} onClick={(event) => handleInternalLink(event, releasePath(release.slug))}>
                                    {release.title}
                                </a>
                            </h2>
                            <span>{release.trackCount} tracks - {formatTime(release.totalDurationSeconds)}</span>
                            <button type="button" onClick={() => player.playRelease(release.releaseId)}>
                                <Play aria-hidden="true" /> Play
                            </button>
                        </div>
                    </article>
                ))}
            </section>
        </main>
    );
}

export function ReleasePage({ slug }: ReleasePageProps) {
    const player = useMusicPlayer();
    const state = useReleaseBySlug(slug);

    if (state.error) {
        return <PageStatus error={state.error} />;
    }

    if (state.loading || !state.release) {
        return <PageStatus />;
    }

    const release = state.release;

    return (
        <main className="music-page">
            <section className="album-page-hero">
                <ReleaseArtwork release={release} className="album-page-hero__art" />
                <div className="album-page-hero__copy">
                    <p className="section-eyebrow">{formatReleaseKind(release.releaseKind)}</p>
                    <h1>{release.title}</h1>
                    {release.subtitle ? <p className="album-page-hero__subtitle">{release.subtitle}</p> : null}
                    <p>{releaseDescription(release)}</p>
                    <div className="album-page-hero__meta">
                        <span><CalendarDays aria-hidden="true" /> {release.releaseDate}</span>
                        <span><Disc3 aria-hidden="true" /> {release.tracks.length} tracks</span>
                    </div>
                    <div className="album-page-hero__actions">
                        <button type="button" onClick={() => player.playRelease(release.releaseId)}>
                            <Play aria-hidden="true" /> Play Release
                        </button>
                        {release.links?.map((link) => (
                            <a key={link.url} href={link.url}>
                                <ExternalLink aria-hidden="true" /> {link.label}
                            </a>
                        ))}
                    </div>
                </div>
            </section>

            <section className="album-page-tracks" aria-label={`${release.title} tracks`}>
                <TrackRows release={release} activeTrack={player.selectedTrack} />
            </section>
        </main>
    );
}

export function TrackPage({ releaseSlug, trackSlug }: TrackPageProps) {
    const player = useMusicPlayer();
    const state = useReleaseBySlug(releaseSlug);

    if (state.error) {
        return <PageStatus error={state.error} />;
    }

    if (state.loading || !state.release) {
        return <PageStatus />;
    }

    const release = state.release;
    const track = release.tracks.find((candidate) => candidate.slug === trackSlug);

    if (!track) {
        return <PageStatus error="Track not found." />;
    }

    return (
        <main className="music-page">
            <section className="track-page-hero">
                <ArtworkImage artwork={track.artwork ?? release.artwork} className="track-page-hero__art" />
                <div className="track-page-hero__copy">
                    <p className="section-eyebrow">{release.title}</p>
                    <h1>{track.title}</h1>
                    {track.description ? <p>{track.description}</p> : <p>{releaseDescription(release)}</p>}
                    <div className="album-page-hero__meta">
                        <span>{formatTime(track.durationSeconds)}</span>
                        <span>Track {track.trackNumber}</span>
                    </div>
                    <div className="album-page-hero__actions">
                        <button type="button" onClick={() => player.playTrack(release.releaseId, track.trackId)}>
                            <Play aria-hidden="true" /> Play Track
                        </button>
                        <a href={releasePath(release.slug)} onClick={(event) => handleInternalLink(event, releasePath(release.slug))}>
                            <Disc3 aria-hidden="true" /> Release
                        </a>
                    </div>
                </div>
            </section>

            <section className="album-page-tracks" aria-label={`${release.title} tracks`}>
                <TrackRows release={release} activeTrack={track} />
            </section>
        </main>
    );
}

export function SongPage({ slug }: SongPageProps) {
    const player = useMusicPlayer();
    const state = useSongBySlug(slug);

    if (state.error) {
        return <PageStatus error={state.error} />;
    }

    if (state.loading || !state.song) {
        return <PageStatus />;
    }

    const song = state.song;
    const fallbackReleaseArtwork = song.placements[0]?.releaseArtwork ?? player.catalog?.releases.find((release) => release.releaseId === song.placements[0]?.releaseId)?.artwork;

    return (
        <main className="music-page">
            <section className="track-page-hero">
                <ArtworkImage artwork={song.artwork ?? fallbackReleaseArtwork} className="track-page-hero__art" />
                <div className="track-page-hero__copy">
                    <p className="section-eyebrow">Song</p>
                    <h1>{song.title}</h1>
                    {song.description ? <p>{song.description}</p> : null}
                </div>
            </section>
            <section className="album-page-tracks" aria-label={`${song.title} placements`}>
                <ol className="catalog-track-list">
                    {song.placements.map((placement) => (
                        <li key={`${placement.releaseId}/${placement.trackId}`}>
                            <span className="catalog-track-list__play"><Disc3 aria-hidden="true" /></span>
                            <a
                                href={trackPath(placement.releaseSlug, placement.trackSlug)}
                                onClick={(event) => handleInternalLink(event, trackPath(placement.releaseSlug, placement.trackSlug))}
                            >
                                <span>{placement.trackNumber}</span>
                                <strong>{placement.releaseTitle}</strong>
                                <span>{formatReleaseKind(placement.releaseKind)}</span>
                            </a>
                        </li>
                    ))}
                </ol>
            </section>
            <p>
                <a href={songPath(song.slug)} onClick={(event) => handleInternalLink(event, songPath(song.slug))}>
                    {song.artistName}
                </a>
            </p>
        </main>
    );
}
