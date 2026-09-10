# Agent Guide

Marketing site and first-party streaming surface for the band **Tsonu**. The
public React app renders catalog, release, song, and track pages with a bottom
sticky HLS player. The admin surface manages songs, recordings, release
containers, source-master uploads, encode jobs, publishing, and CloudWatch RUM
playback stats.

## URLs

One CloudFront distribution serves four hostnames:

- **`music.tsonu.com`** — primary URL
- `tsonu.com` — apex alias
- `www.tsonu.com` — www alias
- `music.ahara.io` — platform alias

DNS records for the three `tsonu.com` hostnames live in the `tsonu.com.` Route53 zone; `music.ahara.io` lives in the `ahara.io.` zone. Both zones are in the same AWS account and both Route53 records are managed by the `website` module.

## Architecture

- **Frontend**: React 19 + Vite, TypeScript, in `frontend/`.
- **Admin/API**: Rust Lambdas behind Ahara `alb-api`, with Cognito-protected admin routes and public `/catalog` playback routes.
- **Metadata**: shared Ahara RDS. Migrations live in `db/migrations`; runtime catalog rows are not committed to this repo.
- **Media**: private source-master and generated-media S3 buckets. Public HLS, artwork, and lossless assets are served through CloudFront.
- **Analytics**: CloudWatch RUM custom player events and an admin dashboard for player stats.
- **Visualizer**: WebGL2 music visualizer in [`frontend/src/visualizer/`](./frontend/src/visualizer), loaded as a dynamic chunk on activation. See [`docs/visualizer.md`](./docs/visualizer.md).

## Documentation

[`docs/README.md`](./docs/README.md) indexes the reference docs.
[`docs/adr/`](./docs/adr) holds architecture decisions and is the only home for trade-offs.
[`docs/backlog.md`](./docs/backlog.md) holds planned-but-not-built work.

## Build and deploy

- **Local dev**: `cd frontend && pnpm install && pnpm dev` → http://localhost:3000
- **Visualizer Lab**: `cd frontend && pnpm dev:visualizer` → http://127.0.0.1:26010
- **Local build**: `cd frontend && pnpm run build` -> `frontend/build/`
- **Backend tests**: `cd backend && cargo test --lib`
- **Migrations**: `db-migrate` applies `db/migrations` through the shared Ahara migration role.
- **Deploy**: CI only. Push to `main` triggers the shared platform workflow (`.github/workflows/ci.yml`) which builds, runs migrations, then runs `terraform apply`.
- **Pre-commit check**: `make ci` runs lint, typecheck, tests, schema validation, and Terraform fmt.

## Stack declaration

`platform.yml` declares TypeScript, Rust, Terraform, and `migrations:
db/migrations`. The shared workflow auto-detects the frontend at `frontend/`
and Rust Lambda artifacts under `backend/`.

## Key decisions

- **`music.tsonu.com` is the canonical URL** but all four hostnames resolve to the same S3 content. The band's historical `tsonu.com` presence is preserved.
- **`frontend/build/`** is the Vite output dir (not the default `dist/`) — preserved from the legacy Create React App layout to minimize churn in downstream paths.
- **RDS is the catalog source of truth**. Do not commit runtime release, song, recording, track, or job JSON data into this repo.
- **Vitest is enabled** for frontend catalog and analytics behavior.
- **Tailwind is loaded via CDN** (`https://cdn.tailwindcss.com`) in `frontend/index.html`, not bundled. This predates the Vite migration and hasn't been untangled.

## Critical rules

- **Playback outranks visualization.** Nothing in the visualizer may degrade audio. The analyser
  is a parallel dead-end branch; the audio path is `source → gain → destination` unconditionally.
  See [ADR-0001](./docs/adr/0001-visualizer-audio-tap-policy.md) and
  [ADR-0004](./docs/adr/0004-visualizer-playback-supremacy.md).
- **`createMediaElementSource` is irreversible.** The player's audio element is mounted once for
  the page's lifetime. Tap it lazily on first activation, once, and never on the native-HLS path.
- **Visualizer decision logic goes in `core/`** as pure modules over plain data, unit-tested in the
  Node environment. `host/` gathers state and applies decisions; it makes none. See
  [ADR-0003](./docs/adr/0003-visualizer-pure-core-thin-shell.md).
- **Visual time comes from the playback clock**, never from `requestAnimationFrame`, track time
  alone, or a precomputed BPM.
- **The Vite build publishes one stylesheet, named `assets/index-<hash>.css`** (`cssCodeSplit:
  false`), because the `website` module globs `assets/index-*.css` to fill the OG Lambda's
  `ENTRY_CSS`. A second entry stylesheet makes that glob ambiguous; a differently named one makes it
  empty, and an empty `ENTRY_CSS` ships an unstyled site with no build or apply error.
- **Every scene reaches the screen through `compileGraph`.** An authored graph may skip the scene
  grammar; it may not skip port typing, required inputs, or cycle declaration. The graph editor is
  mounted only by the checked-in Visualizer Lab; the public player must not import or expose it. See
  [ADR-0010](./docs/adr/0010-visualizer-authored-scene-graphs.md) and
  [ADR-0011](./docs/adr/0011-visualizer-graph-editor-canvas.md).
- **Nothing in the visualizer may average by default.** `smoothing-lint.test.ts` counts the
  operations that destroy structure and its per-kind ceilings may only fall. A plugin that feeds its
  own output back may not read material through a filter at all. See
  [ADR-0019](./docs/adr/0019-visualizer-structure-preserving-recirculation.md).
- **Do not commit runtime catalog data.** RDS is the source of truth for releases, songs,
  recordings, tracks, and jobs.

## Working on the visualizer

Four things this subsystem has taught expensively. They are here because each one cost weeks and
none of them is visible from the code.

- **Measure the middle of a chain, not its ends.** Every wrong conclusion in this subsystem's
  history came from inferring a middle stage from its two ends.
- **Measure the consumer as well as the producer.** One pass fixed a producer emitting four channels
  in the bottom one percent of their range and stopped there; the consumers were still authored
  against a distribution nothing had, and the median binding traversed a fifth of its range for
  another month.
- **Check the arithmetic of a fix, not only its shape.** A convex accumulator was the right idea
  about washout applied where it forbade the thing the subsystem exists to do, and it survived two
  ADRs because every reading of it was about what it prevented rather than about what its steady
  state actually was.
- **A property with no check degrades to zero.** Loop gain, terminal count and operand independence
  are computed numbers that fail a build, and they hold. Structure had no check and was destroyed by
  round after round of individually defensible changes. Before relying on a property, ask what
  fails when it stops being true.

Brightness and coverage cannot tell a picture from a wash — a vivid scene and a featureless grey one
score the same on both. `frontend/harness/` measures structure, read against the same scene rendered
with its memory blanked.
