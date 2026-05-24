# Streaming Player

The first-party listener loads `catalog.json` from `window.__APP_CONFIG__.app.mediaBaseUrl`,
then loads the selected album manifest from that catalog entry's `manifestPath`.

Playback uses:

- `hls.js` when Media Source Extensions are available.
- Native HLS by assigning the `.m3u8` URL to the audio element when the browser
  supports `application/vnd.apple.mpegurl`.

The player resolves all manifest `path` values against the media CDN base URL.
Absolute `url` values in manifests are respected.

## Analytics

The player records:

- `album_view` once per album per page session.
- `track_impression` once per track per page session.
- `play_start` on real audio play events.
- `play_pause` on user-visible pauses, suppressing transient source switches.
- `play_seek` when the custom timeline changes position.
- `play_progress_25`, `play_progress_50`, and `play_progress_75` once per
  track and playback session.
- `play_complete` when a track ends.
- `quality_changed` when the selected HLS rendition changes.
- `play_error` on HLS or audio element failures.

External platform links remain secondary actions outside the player.
