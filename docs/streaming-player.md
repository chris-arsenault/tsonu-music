# Streaming Player

The first-party listener loads published metadata from
`window.__APP_CONFIG__.app.adminApiBaseUrl`:

- `GET /catalog`
- `GET /catalog/releases/{releaseSlug}`
- `GET /catalog/songs/{songSlug}`

Playback URLs in those responses still resolve against
`window.__APP_CONFIG__.app.mediaBaseUrl`.

The public frontend has separate catalog routes:

- `/music` lists published catalog entries.
- `/releases/{releaseSlug}` renders one release.
- `/songs/{songSlug}` renders one song.
- `/tracks/{releaseSlug}/{trackSlug}` renders one track deep link.

Only `visibility = public` rows appear in `/music`. Direct release, song, and
track links can resolve `public` and `unlisted` rows so previews can be shared
without being listed in the catalog.

The audio element lives in `MusicPlayerProvider`, which is mounted once at the
public app root. Page navigation swaps catalog/detail views without remounting
the audio element, so playback continues in the bottom sticky player.

Playback uses:

- `hls.js` when Media Source Extensions are available.
- Native HLS by assigning the `.m3u8` URL to the audio element when the browser
  supports `application/vnd.apple.mpegurl`.

The player resolves all manifest `path` values against the media CDN base URL.
Absolute `url` values in manifests are respected.

OpenGraph pages use the Ahara `website` module's `og_config` mode with shared
RDS credentials from `/ahara/db/tsonu-music/*`. `/releases/{releaseSlug}` and
`/songs/{songSlug}` query the published metadata tables for per-entity title,
description, and artwork.

## Analytics

The player records:

- `release_view` once per release per page session.
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
