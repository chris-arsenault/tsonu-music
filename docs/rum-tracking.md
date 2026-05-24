# CloudWatch RUM Tracking

Step 11 adds CloudWatch RUM as the player analytics collector.

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

## Player Events

The frontend records these custom event types through `recordPlayerEvent`:

- `album_view`
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

- `albumId`
- `releaseId`
- `trackId`
- `assetId`
- `selectedQuality`
- `positionSeconds`
- `sessionPositionSeconds`
- `durationSeconds`
- `playbackSessionId`
- `pagePath`
- `occurredAt`
- `eventVersion`

`album_view` and `track_impression` are deduplicated per page session so React
StrictMode and remounts do not double-count impressions. Player controls should
call the exported helpers from `frontend/src/player-analytics.ts` when the
first-party player replaces the Bandcamp iframe.
