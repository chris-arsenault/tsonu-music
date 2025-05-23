import React from 'react';
import { ExternalLink, Music, Play, Heart, Mail } from 'lucide-react';

const TsonuWebsite = () => {
  const streamingServices = [
    { name: 'Spotify', url: '#spotify-link', color: 'bg-green-500' },
    { name: 'Apple Music', url: '#apple-music-link', color: 'bg-gray-800' },
    { name: 'YouTube Music', url: '#youtube-music-link', color: 'bg-red-500' },
    { name: 'Amazon Music', url: '#amazon-music-link', color: 'bg-blue-500' },
    { name: 'Bandcamp', url: '#bandcamp-link', color: 'bg-teal-500' },
    { name: 'SoundCloud', url: '#soundcloud-link', color: 'bg-orange-500' }
  ];

  return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 text-white">
        {/* Navigation */}
        <nav className="fixed top-0 w-full bg-black/20 backdrop-blur-md z-50 border-b border-white/10">
          <div className="max-w-6xl mx-auto px-4 py-4">
            <div className="flex justify-between items-center">
              <h1 className="text-2xl font-bold tracking-wider">TSONU</h1>
              <div className="hidden md:flex space-x-8">
                <a href="#home" className="hover:text-purple-300 transition-colors">Home</a>
                <a href="#music" className="hover:text-purple-300 transition-colors">Music</a>
                <a href="#about" className="hover:text-purple-300 transition-colors">About</a>
                <a href="#contact" className="hover:text-purple-300 transition-colors">Contact</a>
              </div>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section id="home" className="pt-20 pb-12 px-4">
          <div className="max-w-6xl mx-auto text-center">
            <div className="mb-8">
              <h1 className="text-6xl md:text-8xl font-bold mb-4 bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                TSONU
              </h1>
              <p className="text-xl md:text-2xl text-gray-300 mb-8">
                Atmospheric soundscapes for the modern soul
              </p>
            </div>

            {/* Album Cover Placeholder */}
            <div className="relative mb-12 max-w-md mx-auto">
              <div className="aspect-square bg-gradient-to-br from-purple-800 to-indigo-900 rounded-lg shadow-2xl flex items-center justify-center border border-white/20">
                <div className="text-center">
                  <Music className="w-16 h-16 mx-auto mb-4 text-purple-300" />
                  <h3 className="text-2xl font-semibold mb-2">So We Sleep</h3>
                  <p className="text-gray-400">Debut Album</p>
                </div>
              </div>
              <div className="absolute -inset-4 bg-gradient-to-r from-purple-600 to-pink-600 rounded-lg blur opacity-20 -z-10"></div>
            </div>

            {/* Call to Action */}
            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
              <button className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 px-8 py-3 rounded-full font-semibold transition-all transform hover:scale-105">
                <Play className="w-5 h-5" />
                Listen Now
              </button>
              <button className="flex items-center gap-2 border border-white/30 hover:bg-white/10 px-8 py-3 rounded-full font-semibold transition-all">
                <Heart className="w-5 h-5" />
                Follow
              </button>
            </div>
          </div>
        </section>

        {/* Music Section */}
        <section id="music" className="py-16 px-4 bg-black/20">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-4xl font-bold text-center mb-12">Stream Our Music</h2>

            {/* Album Info */}
            <div className="bg-white/5 rounded-xl p-8 mb-12 backdrop-blur-sm border border-white/10">
              <div className="flex flex-col md:flex-row items-center gap-8">
                <div className="w-48 h-48 bg-gradient-to-br from-purple-800 to-indigo-900 rounded-lg flex items-center justify-center">
                  <Music className="w-12 h-12 text-purple-300" />
                </div>
                <div className="flex-1 text-center md:text-left">
                  <h3 className="text-3xl font-bold mb-2">So We Sleep</h3>
                  <p className="text-gray-400 mb-4">Debut Album • 2024</p>
                  <p className="text-gray-300 leading-relaxed mb-6">
                    An introspective journey through ambient soundscapes and ethereal melodies.
                    "So We Sleep" explores themes of rest, dreams, and the quiet moments between
                    consciousness and slumber.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <span className="px-3 py-1 bg-purple-600/30 rounded-full text-sm">Ambient</span>
                    <span className="px-3 py-1 bg-purple-600/30 rounded-full text-sm">Electronic</span>
                    <span className="px-3 py-1 bg-purple-600/30 rounded-full text-sm">Experimental</span>
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
                      className={`${service.color} hover:opacity-80 transition-all transform hover:scale-105 rounded-lg p-6 text-center group relative overflow-hidden`}
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <ExternalLink className="w-6 h-6 mx-auto mb-2" />
                    <span className="font-semibold">{service.name}</span>
                  </a>
              ))}
            </div>
          </div>
        </section>

        {/* About Section */}
        <section id="about" className="py-16 px-4">
          <div className="max-w-4xl mx-auto text-center">
            <h2 className="text-4xl font-bold mb-8">About Tsonu</h2>
            <div className="bg-white/5 rounded-xl p-8 backdrop-blur-sm border border-white/10">
              <p className="text-lg text-gray-300 leading-relaxed mb-6">
                Tsonu crafts immersive sonic experiences that blur the boundaries between
                consciousness and dream. Drawing inspiration from the quiet hours of night
                and the liminal spaces between sleep and waking, our music invites listeners
                into a world of contemplative beauty.
              </p>
              <p className="text-lg text-gray-300 leading-relaxed">
                With "So We Sleep," we explore the vulnerable moments of rest and the
                profound peace found in surrender. Each track is a meditation on the
                necessity of sleep, both as physical restoration and spiritual renewal.
              </p>
            </div>
          </div>
        </section>

        {/* Contact Section */}
        <section id="contact" className="py-16 px-4 bg-black/20">
          <div className="max-w-4xl mx-auto text-center">
            <h2 className="text-4xl font-bold mb-8">Get In Touch</h2>
            <div className="bg-white/5 rounded-xl p-8 backdrop-blur-sm border border-white/10">
              <p className="text-lg text-gray-300 mb-6">
                For booking inquiries, press, or just to say hello
              </p>
              <a
                  href="mailto:contact@tsonu.com"
                  className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-700 px-8 py-3 rounded-full font-semibold transition-all transform hover:scale-105"
              >
                <Mail className="w-5 h-5" />
                contact@tsonu.music
              </a>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="py-8 px-4 border-t border-white/10">
          <div className="max-w-6xl mx-auto text-center">
            <p className="text-gray-400 mb-4">© 2024 Tsonu. All rights reserved.</p>
            <div className="flex justify-center space-x-6">
              <a href="#instagram" className="text-gray-400 hover:text-white transition-colors">Instagram</a>
              <a href="#twitter" className="text-gray-400 hover:text-white transition-colors">Twitter</a>
              <a href="#facebook" className="text-gray-400 hover:text-white transition-colors">Facebook</a>
            </div>
          </div>
        </footer>
      </div>
  );
};

export default TsonuWebsite;