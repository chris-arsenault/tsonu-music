# Encode Trigger Path

Step 8 wires the management trigger path without adding a queue service:

```text
POST /admin/encode-jobs
```

Request:

```json
{
  "albumId": "album_so-we-sleep",
  "trackId": "track_so-we-sleep_01",
  "includeLossless": false
}
```

The admin API reads the draft album manifest, validates that the track has a
canonical source master under:

```text
masters/{albumId}/{trackId}/source.{wav|aif|aiff|flac}
```

It then writes a queued job object to:

```text
draft/jobs/{jobId}.json
```

and invokes `tsonu-music-encoder` directly with `InvocationType = Event`. The
encoder is invoked once per track and writes job state back to the same S3 job
object.

Generated assets are planned under a draft-only prefix until publishing exists:

```text
draft/encodes/{jobId}/hls/master.m3u8
draft/encodes/{jobId}/hls/192k/index.m3u8
draft/encodes/{jobId}/hls/320k/index.m3u8
draft/encodes/{jobId}/metadata.json
draft/encodes/{jobId}/lossless.flac
```

The encoder downloads the source master to `/tmp`, runs `ffprobe` plus an
`ffmpeg` loudness pass, generates 192k and 320k AAC HLS renditions, optionally
generates a FLAC copy, uploads all playlists/segments/metadata to S3, and writes
the final job status back to `draft/jobs/{jobId}.json`.

Successful jobs include measured duration, source codec, sample rate, channel
count, loudness metadata, and file size/SHA-256 integrity fields for the compact
asset list. Failed jobs are marked `failed` with a stable error code after the
failure is observed so async Lambda retries do not leave jobs stuck in
`queued` or `running`.

Publishing uses:

```text
POST /admin/publish/{albumId}
```

The draft album must be `ready` or already `published`, and every track must
resolve to a succeeded encode job. By default publishing uses the latest
`encodeJobIds` entry on each draft track; the request body can override specific
tracks with `trackJobIds`. The API copies every object under each
`draft/encodes/{jobId}/` prefix into an immutable public prefix:

```text
albums/{albumSlug}/tracks/{trackSlug}/{jobId}/...
```

It then writes `albums/{albumSlug}.json`, updates `catalog.json`, marks the
draft album `published`, and creates a CloudFront invalidation for only the two
manifest JSON paths.
