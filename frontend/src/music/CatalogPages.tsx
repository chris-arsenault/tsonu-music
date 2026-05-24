import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CalendarDays, Disc3, ExternalLink, ListMusic, LoaderCircle, Play } from 'lucide-react';
import { fetchAlbumManifest, fetchAlbumManifestBySlug, getArtworkUrl } from '../catalog/catalog-client';
import type { CatalogAlbumSummary, PublishedAlbumManifest, PublishedTrack } from '../catalog/media-catalog';
import {
    formatTime,
    useMusicPlayer,
} from './MusicPlayerContext';
import { albumPath, handleInternalLink, trackPath } from './routes';

interface AlbumPageProps {
    slug: string;
}

interface TrackPageProps {
    albumSlug: string;
    trackSlug: string;
}

interface AlbumLoadState {
    album?: PublishedAlbumManifest;
    error?: string;
    loading: boolean;
}

function formatReleaseType(value: string): string {
    return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function albumDescription(album: PublishedAlbumManifest | CatalogAlbumSummary): string {
    if ('description' in album && album.description) {
        return album.description;
    }

    return `${formatReleaseType(album.releaseType)} by Tsonu.`;
}

function useAlbumBySlug(slug: string | undefined): AlbumLoadState {
    const { catalog, catalogApiBaseUrl } = useMusicPlayer();
    const summary = useMemo(
        () => catalog?.albums.find((album) => album.slug === slug),
        [catalog, slug],
    );
    const [state, setState] = useState<AlbumLoadState>({ loading: false });

    useEffect(() => {
        if (!catalog) {
            setState({ loading: true });
            return undefined;
        }

        if (!slug) {
            setState({ loading: false, error: 'Album not found.' });
            return undefined;
        }

        const controller = new AbortController();
        setState({ loading: true });
        const request = summary
            ? fetchAlbumManifest(catalogApiBaseUrl, summary, controller.signal)
            : fetchAlbumManifestBySlug(catalogApiBaseUrl, slug, controller.signal);
        request
            .then((album) => setState({ album, loading: false }))
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
    }, [catalog, catalogApiBaseUrl, summary]);

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

function AlbumArtwork({ album, className }: { album: PublishedAlbumManifest | CatalogAlbumSummary; className: string }) {
    const { mediaBaseUrl } = useMusicPlayer();
    const src = getArtworkUrl(mediaBaseUrl, album.artwork);
    return src ? <img className={className} src={src} alt={album.artwork.altText} /> : <ListMusic className={className} aria-hidden="true" />;
}

function TrackRows({ album, activeTrack }: { album: PublishedAlbumManifest; activeTrack?: PublishedTrack }) {
    const player = useMusicPlayer();

    return (
        <ol className="catalog-track-list">
            {album.tracks.map((track) => (
                <li key={track.trackId}>
                    <button
                        type="button"
                        className="catalog-track-list__play"
                        onClick={() => player.playTrack(album.albumId, track.trackId)}
                        aria-label={`Play ${track.title}`}
                        title={`Play ${track.title}`}
                    >
                        <Play aria-hidden="true" />
                    </button>
                    <a
                        href={trackPath(album.slug, track.slug)}
                        onClick={(event) => handleInternalLink(event, trackPath(album.slug, track.slug))}
                        className={activeTrack?.trackId === track.trackId ? 'is-active' : undefined}
                    >
                        <span>{track.trackNumber}</span>
                        <strong>{track.title}</strong>
                        <span>{formatTime(track.durationSeconds)}</span>
                    </a>
                </li>
            ))}
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
                <p>Albums, previews, demos, and non-platform releases in one first-party catalog.</p>
            </header>

            <section className="catalog-grid" aria-label="Albums">
                {player.catalog.albums.map((album) => (
                    <article className="catalog-album-card" key={album.albumId}>
                        <a
                            href={albumPath(album.slug)}
                            onClick={(event) => handleInternalLink(event, albumPath(album.slug))}
                            className="catalog-album-card__art"
                        >
                            <AlbumArtwork album={album} className="catalog-album-card__image" />
                        </a>
                        <div className="catalog-album-card__body">
                            <p>{formatReleaseType(album.releaseType)} - {album.releaseDate}</p>
                            <h2>
                                <a href={albumPath(album.slug)} onClick={(event) => handleInternalLink(event, albumPath(album.slug))}>
                                    {album.title}
                                </a>
                            </h2>
                            <span>{album.trackCount} tracks - {formatTime(album.totalDurationSeconds)}</span>
                            <button type="button" onClick={() => player.playAlbum(album.albumId)}>
                                <Play aria-hidden="true" /> Play
                            </button>
                        </div>
                    </article>
                ))}
            </section>
        </main>
    );
}

export function AlbumPage({ slug }: AlbumPageProps) {
    const player = useMusicPlayer();
    const state = useAlbumBySlug(slug);

    if (state.error) {
        return <PageStatus error={state.error} />;
    }

    if (state.loading || !state.album) {
        return <PageStatus />;
    }

    const album = state.album;

    return (
        <main className="music-page">
            <section className="album-page-hero">
                <AlbumArtwork album={album} className="album-page-hero__art" />
                <div className="album-page-hero__copy">
                    <p className="section-eyebrow">{formatReleaseType(album.releaseType)}</p>
                    <h1>{album.title}</h1>
                    {album.subtitle ? <p className="album-page-hero__subtitle">{album.subtitle}</p> : null}
                    <p>{albumDescription(album)}</p>
                    <div className="album-page-hero__meta">
                        <span><CalendarDays aria-hidden="true" /> {album.releaseDate}</span>
                        <span><Disc3 aria-hidden="true" /> {album.tracks.length} tracks</span>
                    </div>
                    <div className="album-page-hero__actions">
                        <button type="button" onClick={() => player.playAlbum(album.albumId)}>
                            <Play aria-hidden="true" /> Play Album
                        </button>
                        {album.links?.map((link) => (
                            <a key={link.url} href={link.url}>
                                <ExternalLink aria-hidden="true" /> {link.label}
                            </a>
                        ))}
                    </div>
                </div>
            </section>

            <section className="album-page-tracks" aria-label={`${album.title} tracks`}>
                <TrackRows album={album} activeTrack={player.selectedTrack} />
            </section>
        </main>
    );
}

export function TrackPage({ albumSlug, trackSlug }: TrackPageProps) {
    const player = useMusicPlayer();
    const state = useAlbumBySlug(albumSlug);

    if (state.error) {
        return <PageStatus error={state.error} />;
    }

    if (state.loading || !state.album) {
        return <PageStatus />;
    }

    const album = state.album;
    const track = album.tracks.find((candidate) => candidate.slug === trackSlug);

    if (!track) {
        return <PageStatus error="Track not found." />;
    }

    return (
        <main className="music-page">
            <section className="track-page-hero">
                <AlbumArtwork album={album} className="track-page-hero__art" />
                <div className="track-page-hero__copy">
                    <p className="section-eyebrow">{album.title}</p>
                    <h1>{track.title}</h1>
                    {track.description ? <p>{track.description}</p> : <p>{albumDescription(album)}</p>}
                    <div className="album-page-hero__meta">
                        <span>{formatTime(track.durationSeconds)}</span>
                        <span>Track {track.trackNumber}</span>
                    </div>
                    <div className="album-page-hero__actions">
                        <button type="button" onClick={() => player.playTrack(album.albumId, track.trackId)}>
                            <Play aria-hidden="true" /> Play Track
                        </button>
                        <a href={albumPath(album.slug)} onClick={(event) => handleInternalLink(event, albumPath(album.slug))}>
                            <Disc3 aria-hidden="true" /> Album
                        </a>
                    </div>
                </div>
            </section>

            <section className="album-page-tracks" aria-label={`${album.title} tracks`}>
                <TrackRows album={album} activeTrack={track} />
            </section>
        </main>
    );
}
