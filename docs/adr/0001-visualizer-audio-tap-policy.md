# 0001 — Visualizer audio tap is opt-in, parallel, and gated off the native-HLS path

- Status: Accepted
- Date: 2026-07-25
- Amended by: [ADR-0006](./0006-hls-js-visualizer-playback-policy.md), which moves Chromium and
  Firefox to `hls.js` only after explicit visualizer activation.

## Context

Audio-reactive visuals require PCM access to the playing stream, which means routing the
player's `<audio>` element through `AudioContext.createMediaElementSource`. That call has two
properties that constrain the design.

First, it is irreversible: once an element is tapped, its output is permanently routed through
the Web Audio graph for the element's lifetime, and the element is mounted once at the public app
root and never remounted across navigation (`frontend/src/music/MusicPlayerContext.tsx`). A
broken or suspended graph therefore produces silence during apparently normal playback.

Second, the player has two playback paths. Native HLS is the initial path wherever
`audio.canPlayType('application/vnd.apple.mpegurl')` returns a non-empty string; otherwise
`hls.js` drives Media Source Extensions. ADR-0006 additionally allows an explicit visualizer
activation to move Chromium and Firefox from native playback to `hls.js`. Analysis of a
natively-decoded HLS stream through a media-element source is unreliable, commonly yielding
all-zero data, and tapping Web Audio on iOS can disturb route handling for AirPlay and lock-screen
controls.

Album artwork and mask textures are unaffected. `crossOrigin="anonymous"` is already set on the
element, S3 CORS rules cover all four hostnames plus `localhost:3000`, and the media distribution
forwards the CORS request headers.

## Decision

The tap is created lazily on first visualizer activation, never at page load; the visualizer
reports itself unavailable whenever the native-HLS branch is taken; and the analyser hangs off a
parallel branch terminating in nothing, with `source → gain(1.0) → destination` carrying audio
unconditionally. A watchdog treats an exactly-zero RMS across roughly sixty consecutive frames
during unpaused playback as dead analysis and drops to the non-reactive fallback tier.

## Alternatives considered

- **Force `hls.js` on Safari so the visualizer works everywhere** — wins uniform analysis, but
  trades a native, battery-efficient, AirPlay-correct audio path for an MSE one purely to enable
  decoration. Rejected: playback quality outranks visual coverage.
- **Tap at page load and keep it warm** — simpler lifecycle with no lazy-init branch, but every
  visitor's audio is permanently rerouted whether or not they ever use the feature. Rejected as an
  unacceptable default given irreversibility.
- **Probe analysis on the real element and disable on failure** — cannot work, because probing
  requires the very tap the probe is meant to justify. A throwaway hidden element with its own
  context could probe safely and remains the backlog route for evaluating future Safari support
  without risking the real player.
- **Insert the analyser in series in the audio path** — marginally simpler wiring, but any
  analysis fault then sits between the source and the speakers. Rejected.

## Consequences

Visitors who remain on native HLS get no audio-reactive visuals. ADR-0006 switches opted-in
Chromium and Firefox listeners to the MSE path; Safari remains native.

No visitor who leaves the feature off ever enters the Web Audio graph, so the default
configuration cannot regress playback. Because the analyser is a dead-end branch, no shader,
plugin, or analysis failure can reach the output path, which is what allows the render side to
fail loudly without risking silence.
