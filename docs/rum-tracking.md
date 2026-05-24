# CloudWatch RUM Tracking

CloudWatch RUM is the only browser analytics collector. Google Analytics is not
loaded by the app.

The public privacy position is intentionally narrow: analytics are for internal
operation of the music site, especially song popularity, visits, referrers,
playback quality, and error monitoring. Analytics data is not sold, shared for
advertising, or used for cross-site profiling.

## Infrastructure

Terraform creates:

- `aws_rum_app_monitor.player` with custom events enabled and CloudWatch Logs enabled.
- A Cognito identity pool for unauthenticated browser RUM clients.
- An unauthenticated IAM role scoped to `rum:PutRumEvents` for the app monitor.
- Frontend runtime config injected by the Ahara website module as `/config.js`.

The deployed runtime config is written to `window.__APP_CONFIG__`:

```js
window.__APP_CONFIG__ = {
  app: {
    mediaBaseUrl: "https://media.tsonu.com",
    rum: {
      enabled: true,
      applicationId: "...",
      applicationRegion: "us-east-1",
      applicationVersion: "0.1.0",
      endpoint: "https://dataplane.rum.us-east-1.amazonaws.com",
      identityPoolId: "...",
      guestRoleArn: "...",
      sessionSampleRate: 1,
      allowCookies: false,
      telemetries: ["errors", "performance", "http"],
      playbackEventVersion: 1
    }
  }
};
```

`frontend/public/config.js` is a disabled local fallback. Terraform-owned
deploys replace it with the generated `/config.js` object.

## Privacy Signals

The browser client checks privacy preference signals before loading
`aws-rum-web`. If `navigator.globalPrivacyControl`, `navigator.doNotTrack`, or
`navigator.msDoNotTrack` indicates opt out, RUM is not initialized and no
custom site/player events are sent.

Public RUM analytics uses `allowCookies: false`. The app stores session-scoped
IDs in `sessionStorage` so visits and bounces can be counted inside one tab
session without creating a persistent public visitor cookie.

## Site Events

The React shell disables RUM's automatic page view recording and records page
views explicitly on public route changes. This keeps the CloudWatch RUM page
view stream aligned with SPA navigation.

Each public route change records:

- A standard RUM page view through `recordPageView({ pageId })`.
- A custom `page_view` event with `siteSessionId`, `pagePath`,
  `previousPagePath`, `pageTitle`, referrer origin/host, UTM fields, and
  `occurredAt`.
- A custom `site_visit` event once per browser session with the landing page and
  referrer origin/host.

The admin stats screen derives visits, page views, bounces, bounce rate, traffic
sources, and top pages from these RUM events. A bounce is a session with one
public page view and no player engagement event.

## Player Events

The frontend records these custom event types through `recordPlayerEvent`:

- `release_view`
- `track_impression`
- `play_start`
- `play_pause`
- `play_seek`
- `play_progress_25`
- `play_progress_50`
- `play_progress_75`
- `play_complete`
- `quality_changed`
- `play_error`

Every payload includes:

- `releaseId`
- `songId`
- `recordingId`
- `trackId`
- `assetId`
- `selectedQuality`
- `positionSeconds`
- `sessionPositionSeconds`
- `durationSeconds`
- `siteSessionId`
- `playbackSessionId`
- `pagePath`
- `occurredAt`
- `eventVersion`

`release_view` and `track_impression` are deduplicated per page session so
React StrictMode and remounts do not double-count impressions. Player controls
call the exported helpers from `frontend/src/player-analytics.ts`.

## Backend Play Accounting

Aggregate song popularity is also measured through first-party backend play
events at `POST /analytics/play`. These events are not a browser-blocker
bypass. They are operational play-count records for the music app and are stored
in Postgres beside the catalog data.

Backend play events:

- Count song or recording plays as aggregate operational events, not visitor profiles.
- Record `play_start`, `play_10s`, `play_25`, and `play_complete`.
- Use `siteSessionId` and `playbackSessionId` only as ephemeral session-scoped
  dedupe keys.
- Are idempotent per site session, event type, release, track, song, and recording.
- Are rate limited in Postgres with a hashed source/session bucket; raw source
  IPs are not stored in the rate-limit table.
- Do not log full referrer URLs, request query strings, IP-derived identities,
  or persistent public visitor IDs.

The admin stats screen presents backend song-play aggregates beside RUM player
events and labels the source clearly so RUM and backend counts are not added
together as one metric.
