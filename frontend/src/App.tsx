import { useEffect } from 'react';
import {
    FaTwitter,
    FaInstagram,
    FaSoundcloud,
    FaBandcamp,
    FaSpotify,
    FaYoutube,
    FaEnvelope,
    FaAmazon,
    FaApple,
} from 'react-icons/fa';
import { CalendarDays, Disc3, ListMusic, Play } from 'lucide-react';

import InstagramIframe from './InstagramIframe';
import { AuthProvider } from './auth-context';
import { AdminRoute } from './admin/AdminRoute';
import { CatalogPage, ReleasePage, SongPage, TrackPage } from './music/CatalogPages';
import { MusicPlayerProvider, formatTime, useMusicPlayer } from './music/MusicPlayerContext';
import StickyPlayer from './music/StickyPlayer';
import { getTrackTitleLabel, TrackTitle } from './music/TrackTitle';
import { getArtworkUrl } from './catalog/catalog-client';
import type { CatalogReleaseSummary } from './catalog/media-catalog';
import { recordSitePageView } from './player-analytics';
import {
    decodePathPart,
    handleInternalLink,
    releasePath,
    useCurrentRoute,
} from './music/routes';

import logoLarge from './assets/tsonu-combined.png';
import logoSmall from './assets/tsonu-small-knight.png';
import albumCover from './assets/so-we-sleep-front-no-text.jpg';

const LAUNCH_ALBUM_SLUG = 'so-we-sleep';

function renderPublicRoute(route: string) {
    const pathname = route.split(/[?#]/)[0] || '/';
    const parts = pathname
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(Boolean);

    if (parts[0] === 'music') {
        return <CatalogPage />;
    }

    if ((parts[0] === 'releases' || parts[0] === 'albums') && parts[1]) {
        const slug = decodePathPart(parts[1]) ?? '';
        if (slug === LAUNCH_ALBUM_SLUG) {
            return <SoWeSleepLaunchPage />;
        }
        return <ReleasePage slug={slug} />;
    }

    if (parts[0] === 'songs' && parts[1]) {
        return <SongPage slug={decodePathPart(parts[1]) ?? ''} />;
    }

    if (parts[0] === 'tracks' && parts[1] && parts[2]) {
        return (
            <TrackPage
                releaseSlug={decodePathPart(parts[1]) ?? ''}
                trackSlug={decodePathPart(parts[2]) ?? ''}
            />
        );
    }

    if (parts[0] === 'privacy') {
        return <PrivacyPage />;
    }

    return <HomePage />;
}

/* -----------------------------------------------------------------
 * General home page — artist portal
 * ----------------------------------------------------------------- */
function HomePage() {
    const player = useMusicPlayer();
    const releases = player.catalog?.releases ?? [];
    const featuredRelease = releases[0];
    const otherReleases = releases.slice(1, 7);

    return (
        <div className="home">
            <section className="home-hero grain">
                <img src={logoSmall} alt="Tsonu emblem" className="home-hero__mark" />
                <span className="home-hero__wordmark">Tsonu</span>
                <h1 className="home-hero__tagline">
                    Music for <em>dreamers</em>, adventurers, and anyone who falls asleep with one earbud in.
                </h1>
                <p className="home-hero__lede">
                    Downtempo, orchestral electronica from the edge of sleep —
                    written between half-remembered dreams and old RPG soundtracks.
                </p>
            </section>

            <section className="featured" aria-labelledby="featured-heading">
                <div className="featured__inner">
                    <a
                        className="featured__art"
                        href={releasePath(LAUNCH_ALBUM_SLUG)}
                        onClick={(event) => handleInternalLink(event, releasePath(LAUNCH_ALBUM_SLUG))}
                        aria-label="Open So We Sleep"
                    >
                        <img src={albumCover} alt="So We Sleep cover art" />
                    </a>
                    <div className="featured__copy">
                        <p className="eyebrow">Latest release</p>
                        <h2 id="featured-heading" className="featured__title">So We Sleep</h2>
                        <p className="featured__meta">
                            <span>Debut album</span><span className="dot" />
                            <span>September 2025</span><span className="dot" />
                            <span>10 tracks</span>
                        </p>
                        <p>
                            A debut album of orchestral downtempo built around dreams, fantasy,
                            and the strange landscapes that arrive when the world gets quiet.
                        </p>
                        <div className="featured__actions">
                            <button
                                type="button"
                                className="button--primary"
                                onClick={() => featuredRelease ? player.playRelease(featuredRelease.releaseId) : undefined}
                                disabled={!featuredRelease}
                            >
                                <Play aria-hidden="true" /> Play Album
                            </button>
                            <a
                                href={releasePath(LAUNCH_ALBUM_SLUG)}
                                onClick={(event) => handleInternalLink(event, releasePath(LAUNCH_ALBUM_SLUG))}
                            >
                                Release Page
                            </a>
                        </div>
                    </div>
                </div>
            </section>

            <CatalogRibbon featured={featuredRelease} others={otherReleases} />

            <section className="bio">
                <div className="bio__inner">
                    <p className="eyebrow">About</p>
                    <div className="bio__body">
                        <p>
                            Tsonu is a one-person project for late-night music — orchestral electronica
                            stitched together from FL Studio sketches, Ableton sessions, and Dorico scores.
                        </p>
                        <p>
                            Influenced by Final Fantasy soundtracks, downtempo records,
                            and a long-running habit of lucid dreaming. Most tracks start as something
                            half-remembered the next morning.
                        </p>
                    </div>
                </div>
            </section>

            <section id="connect" className="connect-strip">
                <div className="connect-strip__inner">
                    <h2 className="connect-strip__heading">Stay in touch</h2>
                    <div className="connect-strip__links">
                        <a href="https://x.com/Tsonu_Music" aria-label="X / Twitter">
                            <FaTwitter /> X
                        </a>
                        <a href="https://www.instagram.com/tsonu.music/" aria-label="Instagram">
                            <FaInstagram /> Instagram
                        </a>
                        <a href="https://tsonu.bandcamp.com" aria-label="Bandcamp">
                            <FaBandcamp /> Bandcamp
                        </a>
                        <a href="https://soundcloud.com/tsonu" aria-label="SoundCloud">
                            <FaSoundcloud /> SoundCloud
                        </a>
                        <a href="mailto:contact@tsonu.com" aria-label="Email">
                            <FaEnvelope /> Email
                        </a>
                    </div>
                </div>
            </section>
        </div>
    );
}

function CatalogRibbon({
    featured,
    others,
}: {
    featured: CatalogReleaseSummary | undefined;
    others: CatalogReleaseSummary[];
}) {
    const { mediaBaseUrl } = useMusicPlayer();
    const items = [featured, ...others].filter((release): release is CatalogReleaseSummary => Boolean(release));

    if (items.length === 0) {
        return null;
    }

    return (
        <section className="ribbon" aria-label="Catalog">
            <div className="ribbon__inner">
                <div className="ribbon__head">
                    <h2>Catalog</h2>
                    <a href="/music" onClick={(event) => handleInternalLink(event, '/music')}>
                        Browse all
                    </a>
                </div>
                <div className="ribbon__grid">
                    {items.map((release) => {
                        const src = getArtworkUrl(mediaBaseUrl, release.artwork);
                        return (
                            <a
                                key={release.releaseId}
                                className="ribbon-card"
                                href={releasePath(release.slug)}
                                onClick={(event) => handleInternalLink(event, releasePath(release.slug))}
                            >
                                <div className="ribbon-card__art">
                                    {src
                                        ? <img src={src} alt={release.artwork.altText} />
                                        : <img src={albumCover} alt={release.artwork.altText} />}
                                </div>
                                <div className="ribbon-card__body">
                                    <span className="ribbon-card__kind">{release.releaseKind}</span>
                                    <h3 className="ribbon-card__title">{release.title}</h3>
                                    <span className="ribbon-card__meta">
                                        {release.trackCount} tracks · {formatTime(release.totalDurationSeconds)}
                                    </span>
                                </div>
                            </a>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}

/* -----------------------------------------------------------------
 * So We Sleep — launch / campaign page
 * ----------------------------------------------------------------- */
function SoWeSleepLaunchPage() {
    const player = useMusicPlayer();
    const featuredRelease = player.catalog?.releases.find((release) => release.slug === LAUNCH_ALBUM_SLUG);
    const trackCount = featuredRelease?.trackCount ?? 10;
    const totalDuration = featuredRelease?.totalDurationSeconds ?? 0;

    return (
        <div className="launch">
            <section className="launch-hero">
                <div className="launch-hero__art">
                    <img src={albumCover} alt="So We Sleep cover art" />
                </div>
                <div className="launch-hero__veil" />
                <div className="launch-hero__inner">
                    <p className="launch-hero__eyebrow">Debut Album · Out Now</p>
                    <h1 className="launch-hero__title">So We Sleep</h1>
                    <p className="launch-hero__subtitle">
                        Orchestral downtempo built from dreams, fantasy soundtracks, and
                        ten years of half-finished FL Studio projects.
                    </p>
                    <div className="launch-hero__meta">
                        <span><CalendarDays aria-hidden="true" /> September 2025</span>
                        <span><Disc3 aria-hidden="true" /> {trackCount} tracks</span>
                        {totalDuration > 0 ? <span><ListMusic aria-hidden="true" /> {formatTime(totalDuration)}</span> : null}
                    </div>
                    <div className="launch-hero__actions">
                        <button
                            type="button"
                            className="button--primary"
                            onClick={() => featuredRelease ? player.playRelease(featuredRelease.releaseId) : undefined}
                            disabled={!featuredRelease}
                        >
                            <Play aria-hidden="true" /> Play Album
                        </button>
                        <a href="#stream" onClick={(event) => {
                            event.preventDefault();
                            document.getElementById('stream')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}>
                            Stream Elsewhere ↓
                        </a>
                    </div>
                </div>
            </section>

            <article className="chapter chapter--soft">
                <div className="chapter__inner">
                    <header className="chapter__label">
                        <span className="chapter__number">No. 01</span>
                        <h2 className="chapter__heading">A letter from Tsonu</h2>
                    </header>
                    <div className="chapter__body">
                        <p>
                            My first album, <em>So We Sleep</em>, is an exploration of the kind of music I like
                            to listen to — downtempo, orchestral electronica, Final Fantasy soundtracks, all thrown
                            in a blender with a dash of inexperience and memories of high school band. This album
                            represents my creative journey over the past few years from sketching on beepbox.co
                            (<em>Adventure Between the Verdant Fields</em>) to a ten year old FL Studio project
                            (<em>The Sun Arrived at Midnight</em>) to learning Ableton (<em>Parallax Expedition</em>)
                            and Dorico (orchestral edit of <em>Reign of the Simmered</em>).
                        </p>
                        <p>
                            I've been a fan of dreams for most of my adult life, after having taught myself to lucid
                            dream in my teens. I dream of spaceships, wizards, and epic battles — along with the
                            occasional forgetting to turn my homework in. This album is the adventures I have while
                            dreaming; the same fantasy as books, or the RPGs that inspired some of these tracks.
                        </p>
                        <p>
                            No journey would be complete without the friends we meet (or keep) along the way, so a big
                            shout out to <a href="https://www.tonereverie.com">Tony</a> for providing feedback on the
                            album, coaching me through mixing it, and providing the final mastering.
                        </p>
                        <p>Hope y'all enjoy listening to it as much as I did making it.</p>
                        <span className="chapter__sig">— Tsonu</span>
                    </div>
                </div>
            </article>

            <article className="chapter" id="tracks">
                <div className="chapter__inner">
                    <header className="chapter__label">
                        <span className="chapter__number">No. 02</span>
                        <h2 className="chapter__heading">The album</h2>
                    </header>
                    <div className="chapter__body">
                        <LaunchTracklist />
                    </div>
                </div>
            </article>

            <article className="chapter chapter--soft" id="stream">
                <div className="chapter__inner">
                    <header className="chapter__label">
                        <span className="chapter__number">No. 03</span>
                        <h2 className="chapter__heading">Stream elsewhere</h2>
                    </header>
                    <div className="chapter__body">
                        <p style={{ margin: '0 0 1.5rem', maxWidth: '52ch' }}>
                            Prefer your own player? <em>So We Sleep</em> is available everywhere you listen.
                        </p>
                        <div className="streaming-links">
                            <a href="https://open.spotify.com/album/6yC28QGn2Zv8Lr1TIAHYPD" className="streaming-links__item" aria-label="Spotify">
                                <FaSpotify /><span>Spotify</span>
                            </a>
                            <a href="https://music.apple.com/us/album/so-we-sleep/1836883166" className="streaming-links__item" aria-label="Apple Music">
                                <FaApple /><span>Apple Music</span>
                            </a>
                            <a href="https://music.youtube.com/playlist?list=OLAK5uy_l6Sv8O1P37iK9Qjz621dYc909fE34aoms" className="streaming-links__item" aria-label="YouTube Music">
                                <FaYoutube /><span>YouTube Music</span>
                            </a>
                            <a href="https://tsonu.bandcamp.com/album/so-we-sleep" className="streaming-links__item" aria-label="Bandcamp">
                                <FaBandcamp /><span>Bandcamp</span>
                            </a>
                            <a href="https://music.amazon.com/albums/B0FPBB5QCR" className="streaming-links__item" aria-label="Amazon Music">
                                <FaAmazon /><span>Amazon Music</span>
                            </a>
                        </div>
                    </div>
                </div>
            </article>

            <article className="chapter" id="grow">
                <div className="chapter__inner">
                    <header className="chapter__label">
                        <span className="chapter__number">No. 04</span>
                        <h2 className="chapter__heading">From the wild</h2>
                    </header>
                    <div className="chapter__body">
                        <p style={{ margin: '0 0 1.5rem', maxWidth: '52ch' }}>
                            A signal boost goes a long way for an independent artist — share the album, or just say hi.
                        </p>
                        <div className="embeds-grid">
                            <div>
                                <blockquote className="twitter-tweet">
                                    <p lang="en" dir="ltr">
                                        Debut album, So We Sleep, out now! Good music for adventuring:{' '}
                                        <a href="https://t.co/q4rq1MbV86">https://t.co/q4rq1MbV86</a>
                                    </p>
                                    &mdash; Tsonu (@Tsonu_Music){' '}
                                    <a href="https://twitter.com/Tsonu_Music/status/1964408798619267289?ref_src=twsrc%5Etfw">
                                        September 6, 2025
                                    </a>
                                </blockquote>
                                <script async src="https://platform.twitter.com/widgets.js" charSet="utf-8"></script>
                            </div>
                            <div>
                                <InstagramIframe url="https://www.instagram.com/p/DORbp-jkorj/" height={760} />
                            </div>
                        </div>
                    </div>
                </div>
            </article>
        </div>
    );
}

function LaunchTracklist() {
    const player = useMusicPlayer();
    const release = player.releaseManifest?.slug === LAUNCH_ALBUM_SLUG ? player.releaseManifest : undefined;

    if (!release) {
        return (
            <p className="mono" style={{ color: 'var(--muted)', fontSize: '0.82rem', letterSpacing: '0.12em' }}>
                Loading tracklist…
            </p>
        );
    }

    return (
        <ol className="catalog-track-list">
            {release.tracks.map((track) => {
                const isActive = player.selectedTrack?.trackId === track.trackId;
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
                            href={`/tracks/${encodeURIComponent(release.slug)}/${encodeURIComponent(track.slug)}`}
                            onClick={(event) => handleInternalLink(event, `/tracks/${encodeURIComponent(release.slug)}/${encodeURIComponent(track.slug)}`)}
                            className={isActive ? 'is-active' : undefined}
                        >
                            <span>{String(track.trackNumber).padStart(2, '0')}</span>
                            <strong><TrackTitle track={track} /></strong>
                            <span>{formatTime(track.durationSeconds)}</span>
                        </a>
                    </li>
                );
            })}
        </ol>
    );
}

function PrivacyPage() {
    return (
        <main className="privacy-page">
            <section className="privacy-page__hero">
                <p className="eyebrow">Privacy</p>
                <h1>Site analytics without ad tracking</h1>
                <p>
                    Tsonu uses first-party analytics to understand song popularity, visits,
                    referrers, playback quality, and site errors. Analytics data is for
                    internal operation of this music site. It is not sold, shared for ad
                    targeting, or used for cross-site profiling.
                </p>
            </section>

            <section className="privacy-page__content" aria-label="Analytics details">
                <div>
                    <h2>What is collected</h2>
                    <p>
                        The public site records page views, song and release interactions,
                        playback events, referrer origin or host, UTM campaign fields when
                        present, browser/device metadata, approximate country, and client-side
                        errors or performance events.
                    </p>
                </div>
                <div>
                    <h2>What is not collected</h2>
                    <p>
                        The site does not use Google Analytics, ad pixels, retargeting tags,
                        or cross-site advertising profiles. Public analytics do not use
                        persistent visitor cookies. Full referrer URLs are not stored.
                    </p>
                </div>
                <div>
                    <h2>How it is used</h2>
                    <p>
                        Analytics are used to see which songs and releases are being played,
                        which pages are visited, where visitors are referred from, and whether
                        playback or site code is failing.
                    </p>
                </div>
                <div>
                    <h2>Processor and opt out</h2>
                    <p>
                        Browser telemetry is processed by AWS CloudWatch RUM. If your browser
                        sends Global Privacy Control or Do Not Track, this site does not start
                        RUM analytics. Song playback still sends first-party backend play counts
                        for aggregate popularity and reliability stats. Browser or network
                        blockers may also block RUM requests without affecting playback.
                    </p>
                </div>
            </section>
        </main>
    );
}

/* -----------------------------------------------------------------
 * Public shell
 * ----------------------------------------------------------------- */
function PublicApp() {
    const route = useCurrentRoute();

    useEffect(() => {
        recordSitePageView(route);
    }, [route]);

    return (
        <MusicPlayerProvider fallbackArtworkSrc={albumCover}>
            <div className="App App--with-bottom-player">
                <nav className="nav" aria-label="Primary">
                    <ul className="nav__list">
                        <li className="nav__item">
                            <a href="/" onClick={(event) => handleInternalLink(event, '/')} aria-label="Tsonu — home">
                                <img src={logoSmall} className="nav__logo" alt="" />
                            </a>
                        </li>
                        <li className="nav__item">
                            <a href={releasePath(LAUNCH_ALBUM_SLUG)} onClick={(event) => handleInternalLink(event, releasePath(LAUNCH_ALBUM_SLUG))}>
                                So We Sleep
                            </a>
                        </li>
                        <li className="nav__item">
                            <a href="/music" onClick={(event) => handleInternalLink(event, '/music')}>
                                Catalog
                            </a>
                        </li>
                        <li className="nav__item">
                            <a href="/#connect" onClick={(event) => handleInternalLink(event, '/#connect')}>
                                Connect
                            </a>
                        </li>
                        <li className="nav__item">
                            <a href="/admin" onClick={(event) => handleInternalLink(event, '/admin')}>
                                Admin
                            </a>
                        </li>
                    </ul>
                </nav>

                {renderPublicRoute(route)}

                <footer className="footer">
                    <img src={logoLarge} alt="Tsonu" className="footer__logo" />
                    <p>&copy; {new Date().getFullYear()} Tsonu · All rights reserved</p>
                    <a href="/privacy" onClick={(event) => handleInternalLink(event, '/privacy')}>
                        Privacy
                    </a>
                </footer>
                <StickyPlayer />
            </div>
        </MusicPlayerProvider>
    );
}

function AppContent() {
    const route = useCurrentRoute();
    const pathname = route.split(/[?#]/)[0] || '/';

    if (pathname.startsWith('/admin')) {
        return <AdminRoute />;
    }

    return <PublicApp />;
}

function App() {
    return <AuthProvider><AppContent /></AuthProvider>;
}

export default App;
