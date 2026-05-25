# Testing

`make ci` runs the normal repository checks:

- frontend lint, typecheck, and Vitest unit tests
- Rust clippy, formatting, and library tests
- JSON manifest validation
- Terraform formatting check

The first-party player has unit coverage for catalog manifest loading and RUM
event payload emission. Backend tests cover manifest publication, media upload
validation, RUM summary aggregation, and encode job event construction.

## Local Encode Fixture

`make test-encode-fixture` runs the ignored encoder fixture test. It requires
`ffmpeg` and `ffprobe` on `PATH`, generates a one-second WAV fixture locally,
then verifies ffprobe metadata, HLS rendition generation, master playlist
generation, and FLAC output.

This target is intentionally separate from `make ci` because developer and CI
machines may not have system ffmpeg installed outside the Lambda layer build.
