# Testing

`make ci` runs the normal repository checks:

- frontend lint, typecheck, and Vitest unit tests
- Rust clippy, formatting, and library tests
- JSON manifest validation
- Terraform formatting check

The first-party player has unit coverage for catalog manifest loading and RUM
event payload emission. Backend tests cover manifest publication, media upload
validation, RUM summary aggregation, and encode job event construction.

## Visualizer

The visualizer's checks run inside `make ci` as Vitest suites. Beyond behaviour
tests, two passes read the catalog statically: `shader-contract.test.ts` holds
every shader's source to its plugin's declarations, and `smoothing-lint.test.ts`
counts the operations that destroy picture structure and fails when any kind
becomes more common. `acceptance.test.ts` asserts the specification's section 26
criteria one test per criterion.

## Visualizer Render Harness

`cd frontend && node harness/run.mjs --scenes 16 --seconds 4` renders generated
scenes against a real WebGL2 context under headless Chromium with SwiftShader,
and reports what happens to each picture over simulated seconds: change rate,
how far material travels, how far back the scene remembers, and how much
structure it keeps against the same scene rendered with its memory blanked.
`node harness/summarise.mjs run.json /tmp/frames` turns a run into a table and
writes the captured frames out as PNGs.

It needs a browser and minutes per scene, so it is a deliberate check rather
than part of `make ci`. `--fixtures` runs the combine-operator matrix instead of
generated scenes.

## Local Encode Fixture

`make test-encode-fixture` runs the ignored encoder fixture test. It requires
`ffmpeg` and `ffprobe` on `PATH`, generates a one-second WAV fixture locally,
then verifies ffprobe metadata, HLS rendition generation, master playlist
generation, and FLAC output.

This target is intentionally separate from `make ci` because developer and CI
machines may not have system ffmpeg installed outside the Lambda layer build.
