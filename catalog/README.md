# Media Catalog Manifests

The first catalog implementation uses JSON manifests in S3 instead of a database.
Draft/admin state stays private, and the player reads only published snapshots.

## S3 Layout

Draft objects in `tsonu-music-media`:

```text
draft/albums/{albumId}.json
draft/jobs/{jobId}.json
```

Published objects in `tsonu-music-media`:

```text
catalog.json
albums/{albumSlug}.json
albums/{albumSlug}/tracks/{trackSlug}/{jobId}/hls/master.m3u8
albums/{albumSlug}/tracks/{trackSlug}/{jobId}/hls/{quality}/index.m3u8
albums/{albumSlug}/tracks/{trackSlug}/{jobId}/hls/{quality}/segment_00000.ts
albums/{albumSlug}/tracks/{trackSlug}/{jobId}/lossless.flac
```

Source masters live separately in `tsonu-music-masters`:

```text
masters/{albumId}/{trackId}/source.{wav|aiff|flac}
```

Published manifests must not include source bucket names, source keys, S3 version
IDs, or upload ETags. Those fields are draft/admin-only.

## Write Discipline

- Use stable IDs for albums, releases, tracks, assets, and jobs.
- Write draft objects with S3 conditional requests using the previous ETag.
- Publish by writing fresh immutable media paths and public JSON snapshots.
- Keep generated media paths versioned or content-addressed so only manifest JSON
  needs CloudFront invalidation.
- The publish API copies generated draft encode objects into the public
  `albums/{albumSlug}/tracks/{trackSlug}/{jobId}/` prefix, writes
  `albums/{albumSlug}.json` and `catalog.json`, then invalidates only those two
  JSON paths.
- Treat `catalog/schemas/*.schema.json` as the public contract and
  `frontend/src/catalog/media-catalog.ts` as the frontend TypeScript mirror.

## Validation

Run:

```bash
make manifest-validate
```

The validator checks schema/example parseability and cross-file invariants that
matter operationally, including catalog-to-album references, sorted track order,
asset ID uniqueness, draft source-master paths, and prevention of private S3
fields in published manifests.
