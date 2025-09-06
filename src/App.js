import React from 'react';
import {
    FaTwitter,
    FaInstagram,
    FaSoundcloud,
    FaBandcamp,
    FaSpotify,
    FaYoutube,
    FaEnvelope,
    FaAmazon, FaApple
} from 'react-icons/fa';

import InstagramIframe from "./InstagramIframe";
import CookieBanner from './CookieBanner';

// Import assets.  When this project is compiled all assets under
// src/assets will be bundled automatically.
import logoLarge from './assets/tsonu-combined.png';
import logoSmall from './assets/tsonu-small-knight.png';
import albumCover from './assets/so-we-sleep-front-no-text.jpg';

/**
 * Root component for the Tsonu website.
 *
 * The site is organised into distinct sections: a hero banner with
 * branding, an about blurb, an album description, a music player and
 * streaming links, and a connect section with social media links.
 * Navigation anchors allow visitors to jump between sections on a
 * single page.  Colour choices and typography are inspired by the
 * supplied artwork.  A dark background with green and gold accents
 * keeps the mood intimate without feeling sterile.
 */
function App() {
    return (
        <div className="App">
            <CookieBanner measurementId="G-PZ5LZZL2YE" />


            {/* Navigation */}
            <nav className="nav">
                <ul className="nav__list">
                    <li className="nav__item"><a href="#home"><img src={logoSmall} className="nav__logo" alt="Tsonu emblem" /></a></li>
                    <li className="nav__item"><a href="#album">Album</a></li>
                    <li className="nav__item"><a href="#music">Music</a></li>
                    <li className="nav__item"><a href="#connect">Connect</a></li>
                </ul>
            </nav>


            <div id="album-art">
                <img src={albumCover} alt="So We Sleep Cover Art" className="album-img" />
            </div>

            {/* Hero Section */}
            <header className="hero" id="home">
                <img src={logoLarge} alt="Tsonu logo" className="hero__logo" />
                {/*<h1 className="hero__title">So&nbsp;We&nbsp;Sleep</h1>*/}
                {/*<p className="hero__subtitle">Down‑tempo and orchestral electronica for dreamers</p>*/}
                {/* Primary call to action.  Change href to your preferred streaming link. */}
                {/*<a href="#music" className="btn btn--primary">Listen now</a>*/}
            </header>

            {/* Album Section */}
            <section id="album" className="section section--album">
                <div className="section__inner">
                    <h2>So We Sleep</h2>
                    <p>
                        My first album, <b>So We Sleep</b>, is an exploration of the kind of music I like to listen to.
                        Downtempo, Orchestral Electronica, Final Fantasy Soundtracks, all thrown in a blender with
                        a dash of inexperience and memories of high school band.  This album represents my creative
                        journey over the past few years from sketching on beepbox.co (Adventure Between the Verdant Fields)
                        to a 10 year old FL Studio Project (The Sun Arrived at Midnight) to learning Ableton (Parallax Expedition)
                        and Dorico (Orchestral edit of Reign of the Simmered).
                    </p>
                    <p>
                        I've been a fan of dreams for most of my adult life, after having taught myself to lucid dream
                        in my teens.  I dream of spaceships, wizards, and epic battles along with the occasional forgetting
                        to turn my homework in. This album is the adventures I have while dreaming, the same
                        fantasy as books or the RPGs that inspired some of these tracks.
                    </p>
                    <p>
                        No journey would be complete with out the friends we meet (or keep) along the way, so big should out
                        to <a href="https://www.tonereverie.com">Tony</a> for providing feedback on the album, coaching me
                        through mixing it, and providing the final mastering.
                    </p>
                    <p>
                        Hope y'all enjoy listening to it as much as I did making it!
                    </p>
                    <p>&nbsp;&nbsp;--Tsonu</p>
                </div>
            </section>

            {/* Music / Player Section */}
            <section id="music" className="section section--music">
                <div className="section__inner">
                    <h2>Listen</h2>
                    {/* Replace the iframe source with an actual SoundCloud or Spotify embed when available. */}
                    <div className="player">
                        <iframe title="bcplayer" width="100%" height="400px" src="https://bandcamp.com/EmbeddedPlayer/album=2450012966/size=large/bgcol=333333/linkcol=2ebd35/artwork=small/transparent=true/" seamless><a href="https://tsonu.bandcamp.com/album/so-we-sleep">So We Sleep by Tsonu</a></iframe>
                    </div>
                    <div className="streaming-links">
                        <a href="https://open.spotify.com/album/6yC28QGn2Zv8Lr1TIAHYPD" className="streaming-links__item" aria-label="Spotify">
                            <FaSpotify />
                            <span>Spotify</span>
                        </a>
                        <a href="https://music.apple.com/us/album/so-we-sleep/1836883166" className="streaming-links__item" aria-label="Spotify">
                            <FaApple />
                            <span>Apple</span>
                        </a>
                        <a href="https://music.youtube.com/playlist?list=OLAK5uy_l6Sv8O1P37iK9Qjz621dYc909fE34aoms" className="streaming-links__item" aria-label="YouTube">
                            <FaYoutube />
                            <span>YouTube</span>
                        </a>
                        <a href="https://tsonu.bandcamp.com/album/so-we-sleep" className="streaming-links__item" aria-label="Bandcamp">
                            <FaBandcamp />
                            <span>Bandcamp</span>
                        </a>
                        <a href="https://music.amazon.com/albums/B0FPBB5QCR" className="streaming-links__item" aria-label="SoundCloud">
                            <FaAmazon />
                            <span>Amazon</span>
                        </a>
                    </div>
                </div>
            </section>

            {/* Connect / Social Section */}
            <section id="connect" className="section section--connect">
                <div className="section__inner">
                    <h2>Connect</h2>
                    {/*<p>*/}
                    {/*    Stay up to date with Tsonu’s latest releases and behind‑the‑scenes*/}
                    {/*    stories.  Follow along on your favourite social platforms and*/}
                    {/*    become part of the journey.*/}
                    {/*</p>*/}
                    <div className="social-links">
                        <a href="https://x.com/Tsonu_Music" className="social-links__item" aria-label="X (Twitter)">
                            <FaTwitter />
                            <span>X / Twitter</span>
                        </a>
                        <a href="https://www.instagram.com/tsonu.music/" className="social-links__item" aria-label="Instagram">
                            <FaInstagram />
                            <span>Instagram</span>
                        </a>
                        <a href="https://tsonu.bandcamp.com" className="social-links__item" aria-label="Bandcamp">
                            <FaBandcamp />
                            <span>Bandcamp</span>
                        </a>
                        <a href="mailto:contact@tsonu.com" className="social-links__item" aria-label="Bandcamp">
                            <FaEnvelope />
                            <span>Email</span>
                        </a>
                    </div>

                    <div className="social-links">
                        <a href="https://soundcloud.com/tsonu" className="social-links__item" aria-label="SoundCloud">
                            <FaSoundcloud />
                            <span>SoundCloud - Betas & Other Projects</span>
                        </a>
                    </div>


                </div>
            </section>
            <section id="grow" className="section section--grow">

                <div className="section__inner">
                    <h2>Help Me Grow</h2>
                    <div>
                        <blockquote className="twitter-tweet"><p lang="en" dir="ltr">Debut album, So We Sleep, out now!
                            Good music for adventuring:<a href="https://t.co/q4rq1MbV86">https://t.co/q4rq1MbV86</a>
                        </p>&mdash; Tsonu (@Tsonu_Music) <a
                            href="https://twitter.com/Tsonu_Music/status/1964408798619267289?ref_src=twsrc%5Etfw">September
                            6, 2025</a></blockquote>
                        <script async src="https://platform.twitter.com/widgets.js" charSet="utf-8"></script>
                    </div>
                    <div>

                        <InstagramIframe url="https://www.instagram.com/p/DORbp-jkorj/" height="800"/>
                    </div>
                </div>
            </section>

            {/* Footer */}
            <footer className="footer">
                <img src={logoSmall} alt="Tsonu emblem" className="footer__logo"/>
                <p>&copy; {new Date().getFullYear()} Tsonu &nbsp;•&nbsp; All rights reserved.</p>
            </footer>
        </div>
    );
}

export default App;