# Encode Trigger Path

Step 8 wires the management trigger path without adding a queue service:

```text
POST /admin/encode-jobs
```

Request:

```json
{
  "songId": "song_so-we-sleep-01",
  "recordingId": "recording_so-we-sleep_01",
  "includeLossless": false
}
```

The admin API reads the draft song record from RDS, validates that the recording
has a canonical source master under:

```text
masters/{recordingId}/source.{wav|aif|aiff|flac}
```

It then creates a queued job row in `music_encode_jobs` and invokes
`tsonu-music-encoder` directly with `InvocationType = Event`. The encoder is
invoked once per track and updates job state in the same RDS row.

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
the final job status back to `music_encode_jobs`.

Successful jobs include measured duration, source codec, sample rate, channel
count, loudness metadata, and file size/SHA-256 integrity fields for the compact
asset list. Failed jobs are marked `failed` with a stable error code after the
failure is observed so async Lambda retries do not leave jobs stuck in
`queued` or `running`.

Publishing uses:

```text
POST /admin/publish/{releaseId}
```

The draft release must be `ready` or already `published`, and every track must
resolve to a succeeded encode job. By default publishing uses the latest
recording file metadata on each draft track. Publishing replaces the public
release, song, and release-track snapshot rows, marks the draft release
`published`, and creates a CloudFront invalidation for the frontend catalog,
release, song, and catalog API routes backed by those rows.
