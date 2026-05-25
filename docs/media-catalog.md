# Media Catalog Metadata

Catalog records are runtime database data and are not committed to this
repository. The repo owns migrations, TypeScript types, API implementation, and
infrastructure that read and write those records.

## RDS Layout

Shared Ahara RDS stores catalog metadata in:

```text
music_draft_albums
music_draft_releases
music_draft_songs
music_encode_jobs
music_published_albums
music_published_releases
music_published_release_tracks
music_published_songs
music_published_tracks
```

Draft song and release edits are written through normal admin REST endpoints:
`POST` creates drafts, `PUT` updates drafts, and `DELETE` removes drafts. Encode
status is mirrored into `music_encode_jobs`. Publishing copies generated media
into immutable public S3 prefixes, writes the public release/song/track snapshot
tables, marks the draft release published, and invalidates the frontend catalog
routes.

## S3 Layout

Generated media objects in `tsonu-music-media`:

```text
albums/{albumSlug}/tracks/{trackSlug}/{jobId}/hls/master.m3u8
albums/{albumSlug}/tracks/{trackSlug}/{jobId}/hls/{quality}/index.m3u8
albums/{albumSlug}/tracks/{trackSlug}/{jobId}/hls/{quality}/segment_00000.ts
albums/{albumSlug}/tracks/{trackSlug}/{jobId}/lossless.flac
```

Source masters live separately in `tsonu-music-masters`:

```text
masters/{albumId}/{trackId}/source.{wav|aiff|flac}
```

Public catalog API responses must not include source bucket names, source keys,
S3 version IDs, or upload ETags. Those fields are draft/admin-only.

## Write Discipline

- Use stable IDs for songs, releases, recordings, tracks, assets, and jobs.
- Write draft metadata through the admin API's JSON REST endpoints; do not use
  HTTP conditional request headers for draft writes.
- Publish by writing fresh immutable media paths and public RDS snapshots.
- Keep generated media paths versioned or content-addressed so public playback
  paths do not need replacement.
- The publish API copies generated draft encode objects into the public
  `albums/{albumSlug}/tracks/{trackSlug}/{jobId}/` prefix, updates RDS
  publication rows, then invalidates `/music`, `/albums/{albumSlug}`, and the
  album's track deep links.
- Treat `schemas/media-catalog/*.schema.json` as the public contract and
  `frontend/src/catalog/media-catalog.ts` as the frontend TypeScript mirror.

## Validation

Run:

```bash
make schema-validate
```

The validator checks the schema set for parseability, required identifiers, and
local `$ref` integrity. Runtime metadata instances are validated by the admin
and publish flows that create them, not by committed example data.
