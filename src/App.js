import React from 'react';
import {FaTwitter, FaInstagram, FaSoundcloud, FaBandcamp, FaSpotify, FaYoutube, FaEnvelope} from 'react-icons/fa';

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


            {/* Navigation */}
            <nav className="nav">
                <ul className="nav__list">
                    <li className="nav__item"><a href="#home"><img src={logoSmall} class="nav__logo" alt="Tsonu emblem" /></a></li>
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
                        <iframe
                            title="Placeholder streaming widget"
                            width="100%"
                            height="166"
                            scrolling="no"
                            frameBorder="no"
                            allow="autoplay"
                            src="https://w.soundcloud.com/player/?url=&amp;color=%231b1b1b&amp;auto_play=false&amp;hide_related=false&amp;show_comments=true&amp;show_user=true&amp;show_reposts=false&amp;show_teaser=true"
                        ></iframe>
                    </div>
                    <div className="streaming-links">
                        <a href="#" className="streaming-links__item" aria-label="Spotify">
                            <FaSpotify />
                            <span>Spotify</span>
                        </a>
                        <a href="#" className="streaming-links__item" aria-label="Bandcamp">
                            <FaBandcamp />
                            <span>Bandcamp</span>
                        </a>
                        <a href="#" className="streaming-links__item" aria-label="SoundCloud">
                            <FaSoundcloud />
                            <span>SoundCloud</span>
                        </a>
                        <a href="#" className="streaming-links__item" aria-label="YouTube">
                            <FaYoutube />
                            <span>YouTube</span>
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

            {/* Footer */}
            <footer className="footer">
                <img src={logoSmall} alt="Tsonu emblem" className="footer__logo" />
                <p>&copy; {new Date().getFullYear()} Tsonu &nbsp;•&nbsp; All rights reserved.</p>
            </footer>
        </div>
    );
}

export default App;