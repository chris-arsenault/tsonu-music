import React from 'react';
import { ExternalLink, Music, Play, Heart, Mail, Shield, Scroll } from 'lucide-react';

const TsonuWebsite = () => {
  const streamingServices = [
    { name: 'Spotify', url: '#spotify-link', color: 'bg-green-600 hover:bg-green-700' },
    { name: 'Apple Music', url: '#apple-music-link', color: 'bg-gray-700 hover:bg-gray-800' },
    { name: 'YouTube Music', url: '#youtube-music-link', color: 'bg-red-600 hover:bg-red-700' },
    { name: 'Amazon Music', url: '#amazon-music-link', color: 'bg-blue-600 hover:bg-blue-700' },
    { name: 'Bandcamp', url: '#bandcamp-link', color: 'bg-teal-600 hover:bg-teal-700' },
    { name: 'SoundCloud', url: '#soundcloud-link', color: 'bg-orange-600 hover:bg-orange-700' }
  ];

  return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-green-900 text-amber-50">
        {/* Decorative background pattern */}
        <div className="fixed inset-0 opacity-5">
          <div className="absolute inset-0" style={{
            backgroundImage: `radial-gradient(circle at 25% 25%, #d4af37 1px, transparent 1px),
                           radial-gradient(circle at 75% 75%, #d4af37 1px, transparent 1px)`,
            backgroundSize: '100px 100px'
          }}></div>
        </div>

        {/* Navigation */}
        <nav className="fixed top-0 w-full bg-slate-900/90 backdrop-blur-md z-50 border-b border-amber-600/30">
          <div className="max-w-6xl mx-auto px-4 py-4">
            <div className="flex justify-between items-center">
              <div className="flex items-center space-x-3">
                <img
                    src="/android-chrome-512x512.png"
                    alt="Tsonu Logo"
                    className="w-10 h-10 rounded-full object-cover"
                />

                <h1 className="text-2xl font-bold tracking-wider text-amber-400">TSONU</h1>
              </div>
              <div className="hidden md:flex space-x-8">
                <a href="#home" className="hover:text-amber-400 transition-colors duration-300 text-amber-200">Home</a>
                <a href="#music" className="hover:text-amber-400 transition-colors duration-300 text-amber-200">Music</a>
                <a href="#about" className="hover:text-amber-400 transition-colors duration-300 text-amber-200">About</a>
                <a href="#contact" className="hover:text-amber-400 transition-colors duration-300 text-amber-200">Contact</a>
              </div>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section id="home" className="pt-20 pb-12 px-4 relative">
          {/* Decorative elements */}
          <div className="absolute top-32 left-10 opacity-20">
            <Shield className="w-16 h-16 text-amber-500 transform rotate-12" />
          </div>
          <div className="absolute top-40 right-16 opacity-20">
            <Scroll className="w-12 h-12 text-green-600 transform -rotate-12" />
          </div>

          <div className="max-w-6xl mx-auto text-center relative z-10">
            {/* Main logo area */}
            <div className="mb-8">
              <div className="mb-6">
                <img
                    src="/tsonu-combined.png"
                    alt="Tsonu Logo"
                    className="w-128 h-96 mx-auto drop-shadow-2xl object-contain"
                />
              </div>
              <div className="w-32 h-1 bg-gradient-to-r from-green-600 to-green-700 mx-auto mb-6"></div>
              <p className="text-xl md:text-2xl text-amber-200 mb-8 font-serif italic">
                Mystical soundscapes from ancient realms
              </p>
            </div>

            {/* Album Cover */}
            <div className="relative mb-12 max-w-md mx-auto">
              <div className="aspect-square bg-gradient-to-br from-slate-800 via-green-900 to-slate-900 rounded-lg shadow-2xl flex items-center justify-center border-4 border-amber-600/50 relative overflow-hidden">
                {/* Ornate corner decorations */}
                <div className="absolute top-2 left-2 w-4 h-4 border-l-2 border-t-2 border-amber-500"></div>
                <div className="absolute top-2 right-2 w-4 h-4 border-r-2 border-t-2 border-amber-500"></div>
                <div className="absolute bottom-2 left-2 w-4 h-4 border-l-2 border-b-2 border-amber-500"></div>
                <div className="absolute bottom-2 right-2 w-4 h-4 border-r-2 border-b-2 border-amber-500"></div>

                <div className="text-center z-10">
                  <Music className="w-16 h-16 mx-auto mb-4 text-amber-500" />
                  <h3 className="text-2xl font-bold mb-2 text-amber-400 font-serif">So We Sleep</h3>
                  <p className="text-green-400 font-serif italic">Debut Album</p>
                </div>

                {/* Subtle pattern overlay */}
                <div className="absolute inset-0 opacity-10 bg-gradient-to-br from-amber-500 to-transparent"></div>
              </div>
              <div className="absolute -inset-6 bg-gradient-to-r from-amber-600/20 via-green-600/20 to-amber-600/20 rounded-lg blur-xl -z-10"></div>
            </div>

            {/* Call to Action */}
            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
              <button className="flex items-center gap-2 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-700 hover:to-amber-800 px-8 py-3 rounded-full font-bold transition-all transform hover:scale-105 shadow-lg border border-amber-500">
                <Play className="w-5 h-5" />
                Listen Now
              </button>
              <button className="flex items-center gap-2 border-2 border-green-600 hover:bg-green-600/20 px-8 py-3 rounded-full font-bold transition-all text-green-400 hover:text-green-300">
                <Heart className="w-5 h-5" />
                Follow
              </button>
            </div>
          </div>
        </section>

        {/* Music Section */}
        <section id="music" className="py-16 px-4 bg-slate-900/50 relative">
          {/* Decorative border */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-amber-600 to-transparent"></div>

          <div className="max-w-6xl mx-auto">
            <h2 className="text-4xl font-bold text-center mb-12 text-amber-400 font-serif">Sacred Melodies</h2>

            {/* Album Info */}
            <div className="bg-slate-800/50 rounded-xl p-8 mb-12 backdrop-blur-sm border-2 border-amber-600/30 relative overflow-hidden">
              {/* Decorative corner elements */}
              <div className="absolute top-4 left-4 w-8 h-8 border-l-2 border-t-2 border-amber-500 rounded-tl-lg"></div>
              <div className="absolute top-4 right-4 w-8 h-8 border-r-2 border-t-2 border-amber-500 rounded-tr-lg"></div>
              <div className="absolute bottom-4 left-4 w-8 h-8 border-l-2 border-b-2 border-amber-500 rounded-bl-lg"></div>
              <div className="absolute bottom-4 right-4 w-8 h-8 border-r-2 border-b-2 border-amber-500 rounded-br-lg"></div>

              <div className="flex flex-col md:flex-row items-center gap-8 relative z-10">
                <div className="w-48 h-48 bg-gradient-to-br from-slate-700 via-green-800 to-slate-800 rounded-lg flex items-center justify-center border-2 border-amber-600/50 shadow-xl">
                  <Music className="w-12 h-12 text-amber-500" />
                </div>
                <div className="flex-1 text-center md:text-left">
                  <h3 className="text-3xl font-bold mb-2 text-amber-400 font-serif">So We Sleep</h3>
                  <p className="text-green-400 mb-4 font-serif italic">Debut Album • 2025</p>
                  <p className="text-amber-100 leading-relaxed mb-6 font-serif">
                    A symphonic journey through landscapes of rest and reflection.
                    "So We Sleep" weaves orchestral grandeur with intimate electronic textures,
                    creating anthemic pieces that celebrate both the triumph of great adventures
                    and the profound peace found in quietude. Each track tells a story of
                    slumber earned, dreams awakened, and the gentle surrender to restoration.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <span className="px-4 py-2 bg-green-700/40 rounded-full text-sm border border-green-600/50 text-green-300">Orchestral</span>
                    <span className="px-4 py-2 bg-amber-700/40 rounded-full text-sm border border-amber-600/50 text-amber-300">Downtempo</span>
                    <span className="px-4 py-2 bg-slate-700/40 rounded-full text-sm border border-slate-600/50 text-slate-300">Electronic</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Streaming Services */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {streamingServices.map((service, index) => (
                  <a
                      key={index}
                      href={service.url}
                      className={`${service.color} transition-all transform hover:scale-105 rounded-lg p-6 text-center group relative overflow-hidden border border-amber-600/30`}
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <ExternalLink className="w-6 h-6 mx-auto mb-2 relative z-10" />
                    <span className="font-bold relative z-10">{service.name}</span>
                  </a>
              ))}
            </div>
          </div>
        </section>

        {/* About Section */}
        <section id="about" className="py-16 px-4 relative">
          <div className="max-w-4xl mx-auto text-center">
            <h2 className="text-4xl font-bold mb-8 text-amber-400 font-serif">The Chronicles</h2>
            <div className="bg-slate-800/30 rounded-xl p-8 backdrop-blur-sm border-2 border-green-600/30 relative">
              {/* Ornate decorative elements */}
              <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-2 w-4 h-4 bg-amber-600 rotate-45"></div>

              <p className="text-lg text-amber-100 leading-relaxed mb-6 font-serif">
                Tsonu is a solo artist crafting symphonic landscapes that transport listeners
                to expansive worlds of wonder and emotion. Drawing from the rich tradition of
                orchestral storytelling, each composition weaves together sweeping melodies,
                intricate harmonies, and atmospheric textures that evoke epic journeys and
                intimate moments alike.
              </p>
              <p className="text-lg text-amber-100 leading-relaxed font-serif">
                With "So We Sleep," Tsonu explores the delicate balance between grandeur and
                tranquility, creating anthemic pieces that soar alongside gentle, contemplative
                interludes. These are musical narratives that speak to the adventurer's spirit
                while offering solace to the weary soul, blending orchestral majesty with
                modern electronic sensibilities.
              </p>
            </div>
          </div>
        </section>

        {/* Contact Section */}
        <section id="contact" className="py-16 px-4 bg-slate-900/50 relative">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-green-600 to-transparent"></div>

          <div className="max-w-4xl mx-auto text-center">
            <h2 className="text-4xl font-bold mb-8 text-amber-400 font-serif">Send Word</h2>
            <div className="bg-slate-800/30 rounded-xl p-8 backdrop-blur-sm border-2 border-amber-600/30">
              <p className="text-lg text-amber-200 mb-6 font-serif">
                For collaborations, bookings, or to share tales of your own journeys
              </p>
              <a
                  href="mailto:contact@tsonu.com"
                  className="inline-flex items-center gap-2 bg-gradient-to-r from-green-700 to-green-800 hover:from-green-800 hover:to-green-900 px-8 py-3 rounded-full font-bold transition-all transform hover:scale-105 border border-green-600"
              >
                <Mail className="w-5 h-5" />
                contact@tsonu.com
              </a>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="py-8 px-4 border-t border-amber-600/30 bg-slate-900">
          <div className="max-w-6xl mx-auto text-center">
            <div className="w-16 h-px bg-gradient-to-r from-transparent via-amber-600 to-transparent mx-auto mb-4"></div>
            <p className="text-green-400 mb-4 font-serif">© 2025 Tsonu. All melodies blessed and protected.</p>
            <div className="flex justify-center space-x-6">
              <a href="#instagram" className="text-amber-400 hover:text-amber-300 transition-colors">Instagram</a>
              <a href="#twitter" className="text-amber-400 hover:text-amber-300 transition-colors">Twitter</a>
              <a href="#facebook" className="text-amber-400 hover:text-amber-300 transition-colors">Facebook</a>
            </div>
          </div>
        </footer>
      </div>
  );
};

export default TsonuWebsite;