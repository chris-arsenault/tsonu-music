# Streaming Player Infrastructure Plan

This plan replaces the embedded Bandcamp listener with a first-party streaming
surface for mastered albums and non-album material. The platform should use
Ahara integration patterns: shared ALB for HTTP backends, shared VPC, shared
Cognito for admin authentication, shared RDS for catalog metadata, and
Terraform in `infrastructure/terraform`.

## Decisions

- Use HLS for browser playback.
- Keep lossless masters in private S3 and never serve them as the default stream.
- Use shared Ahara RDS as the catalog source of truth.
- Keep runtime catalog data out of this repo; commit migrations, schemas, code,
  and docs only.
- Use the shared Ahara ALB via `ahara-tf-patterns/modules/alb-api`; do not use API Gateway.
- Use a normal zip Lambda for ffmpeg/ffprobe encoding. Audio encodes take seconds, and track-sized WAV/AIFF/FLAC files fit Lambda's runtime and storage model.
- Process one track per encoder invocation.
- Invoke encoding directly from the admin API or an S3 bucket notification; do not add Step Functions.
- Use CloudWatch RUM custom events for player intent and CloudFront logs for delivery truth.

## Implementation Steps

1. Update the Ahara project registration for `tsonu-music`.
   - In `ahara-infra`, change `project-tsonu-music.tf` from `module_bundles = ["website"]` to include `alb-api` and `cognito-app`.
   - Add the Ahara `cloudwatch-rum` policy primitive needed by this project.
   - Keep encode orchestration out of the platform layer: direct Lambda invocation and S3 bucket notifications are enough for this workload.
   - Keep the state key as `projects/tsonu-music`.

2. Add platform context to this repo's Terraform.
   - Instantiate `ahara-tf-patterns/modules/platform-context` once.
   - Pass `module.ctx.vpc`, `module.ctx.alb`, and `module.ctx.cognito` into backend/admin modules.
   - Continue using the existing `website` module for the frontend CloudFront/S3 site.

3. Add private media storage.
   - Create a versioned, encrypted `tsonu-music-masters` S3 bucket for uploaded lossless masters.
   - Create a private `tsonu-music-media` S3 bucket for generated HLS, artwork, waveform data, and optional lossless assets.
   - Block all public access on both buckets.
   - Keep bucket policies private; add the CloudFront Origin Access Control read allow in step 4 when the media distribution ARN exists.
   - Keep masters readable only by the admin and encoder Lambdas.

4. Add the media CloudFront surface.
   - Either add a dedicated `media.tsonu.com` distribution or add a media origin/behavior to the existing site distribution if the website module supports the required extension cleanly.
   - Cache immutable HLS segments and artwork aggressively.
   - Cache manifests with short TTL or explicit invalidation.
   - Use correct content types for `.m3u8`, `.aac`, `.m4s`, `.ts`, `.flac`, `.json`, and artwork.
   - Enable CloudFront logs for delivery-level analytics.

5. Define the RDS catalog schema.
   - Add `db/migrations` for draft albums, encode jobs, published albums, and published tracks.
   - Store editable draft documents in `music_draft_albums`.
   - Store encode state in `music_encode_jobs`.
   - Store published public snapshots in `music_published_albums` and `music_published_tracks`.
   - Include stable IDs for albums, tracks, releases, assets, and encode jobs.
   - Include album title, slug, release date, artwork, credits, track order, duration, explicit status, and available playback formats.
   - Use normal JSON REST endpoints for draft create, update, and delete.

6. Build the admin API behind the shared ALB.
   - Use `ahara-tf-patterns/modules/alb-api`.
   - Host it at `api.music.tsonu.com` or an Ahara platform hostname if preferred.
   - Use shared Cognito with ALB `jwt-validation` for admin routes.
   - Expose endpoints to create/edit albums, create/edit tracks, request presigned master uploads, start re-encode jobs, inspect job status, publish albums, and read the public catalog.
   - Keep playback public; only management requires auth.

7. Package ffmpeg for normal Lambda.
   - Use a Rust `provided.al2023` Lambda bootstrap for the encode handler if following Ahara's standard Lambda pattern.
   - Package static `ffmpeg` and `ffprobe` either in the Lambda artifact or a Lambda layer, staying under the zip Lambda unzipped package limit.
   - Configure timeout around 120-180 seconds and tune memory after benchmarking.
   - Start with default Lambda `/tmp` storage unless the largest real master shows it is insufficient.

8. Add the encode trigger path.
   - Trigger from an admin action or S3 upload event.
   - Invoke the encoder Lambda directly; use RDS for job state.
   - Invoke the encoder Lambda once per track.
   - Generate an HLS master playlist plus AAC renditions, initially 192 kbps and 320 kbps.
   - Optionally generate a FLAC asset for explicit lossless playback or download.
   - Write job status and errors to `music_encode_jobs`.

9. Implement the encoder Lambda.
   - Read input and output S3 keys from the event payload.
   - Download the source master or stream it into ffmpeg if that proves cleaner.
   - Run `ffprobe` to capture duration, codec, sample rate, channels, and loudness metadata.
   - Run `ffmpeg` to generate HLS outputs.
   - Upload generated playlists, segments, and metadata to the media bucket.
   - Return a compact result payload with asset keys and measured metadata.

10. Implement publishing.
    - Treat draft metadata and generated assets as non-public until publish.
    - Publish by writing immutable media paths and replacing public RDS snapshots.
    - Invalidate the frontend catalog and deep-link routes served from those snapshots.
    - Avoid invalidating HLS segments by making generated media paths content-addressed or versioned.

11. Add CloudWatch RUM.
    - Create a CloudWatch RUM app monitor in Terraform.
    - Inject the RUM client configuration through the existing frontend runtime config mechanism.
    - Record custom player events: `album_view`, `track_impression`, `play_start`, `play_pause`, `play_seek`, `play_progress_25`, `play_progress_50`, `play_progress_75`, `play_complete`, `quality_changed`, and `play_error`.
    - Include `albumId`, `trackId`, `releaseId`, `assetId`, selected quality, and session playback position in event data.

12. Replace the Bandcamp iframe with the first-party player.
    - Load `GET /catalog` and `GET /catalog/albums/{albumSlug}` from the public API.
    - Render albums and tracks from the RDS-backed public catalog responses.
    - Use an HLS-capable browser player path, with native fallback where available.
    - Track meaningful playback milestones once per track/session, not on every time update.
    - Keep external streaming links as secondary actions.

13. Add local and CI checks.
    - Add unit tests for catalog parsing and player event emission.
    - Add backend tests for RDS-backed catalog writes, revision conflict handling, and encode job event construction.
    - Add a local fixture encode test using a short WAV sample.
    - Update `Makefile` and `platform.yml` if Rust/backend code is added.

14. Add deployment documentation.
    - Update `README.md` and `CLAUDE.md` with the new architecture.
    - Document how to upload a master, start an encode, publish an album, and roll back a publication.
    - Document the Ahara cross-repo prerequisites so deploy failures are easy to diagnose.
