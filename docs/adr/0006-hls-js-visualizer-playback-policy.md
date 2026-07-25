# 0006 — Chromium and Firefox switch to hls.js when the visualizer is activated

- Status: Accepted
- Date: 2026-07-25

## Context

Current Safari and Chromium browsers can report native HLS support, and the player historically
selected that path whenever `canPlayType('application/vnd.apple.mpegurl')` returned a non-empty
value. ADR-0001 correctly forbids attaching Web Audio to a native-HLS media element because
analysis can flatline while the irreversible reroute remains attached for the element's lifetime.

The result was that Chrome, Edge, Vivaldi, and Safari all selected native playback and then had no
visualizer. Firefox used `hls.js` only where native playback was absent. Browser support for HLS is
not the same as the engine actually feeding the element, so `canPlayType()` is insufficient as the
visualizer's safety gate.

## Decision

Native HLS remains the default wherever it is available. When a listener activates the visualizer
in a Chromium browser or desktop Firefox, the player preserves the current position and play state,
then reloads the source through `hls.js`. The visualizer waits while that transition is pending and
creates its tap only after the player reports that the MSE engine is active.

Firefox uses `hls.js` from the start when native HLS is absent. Safari remains on native HLS and
does not offer audio-reactive visualization. Chrome and Firefox on iOS are treated as Safari
because they use WebKit; an iPad requesting a desktop site is detected by its touch capability and
also remains native.

The player exposes its actual playback engine as plain state: `pending`, `native-hls`, `hls-js`, or
`unsupported`. Visualizer availability gates on that state rather than independently repeating
the player's capability detection. The player does not expose `hls-js` until its manifest parses.
If the chunk cannot load, MSE is unavailable, or setup fails before that point, an eligible browser
falls back to native playback when possible and the visualizer remains unavailable.

## Alternatives considered

- **Use `hls.js` for every eligible listener from page load** — makes visualization immediately
  available and simplifies engine state. It discards native playback and downloads the HLS engine
  for listeners who never open the visualizer. Rejected because playback outranks visualization.
- **Attach Web Audio directly to native HLS** — avoids a source transition. Rejected because the
  tap is irreversible and native-HLS analysis is not reliable enough to risk the only audio
  element.
- **Switch Safari to `hls.js` too** — extends visual coverage to Safari. Rejected explicitly:
  Safari keeps native playback and has no visualizer.
- **Treat Chrome and Firefox on iOS as their desktop engine families** — matches product branding
  but not the browser engine. Rejected because all iOS browsers use WebKit and must follow the
  Safari playback policy.

## Consequences

Chromium and Firefox get the audio-reactive visualizer through `hls.js` after one explicit
activation. Listeners whose browser can play HLS natively keep that native path until activation
and do not download `hls.js` for visualization.

The first activation from a native path reloads the current source. Position and playing state are
restored, but a brief buffering transition is possible. If that transition cannot complete,
playback falls back to native HLS instead of being sacrificed for the visualizer.

The visualizer now depends on player-owned engine state, which removes the previous false
assumption that native support implies native use. Once `hls.js` has been exposed to the
visualizer, the lifetime audio element may have been irreversibly tapped and cannot safely return
to native HLS; later track and quality changes therefore remain on `hls.js` for that page. Safari
remains intentionally non-reactive.
