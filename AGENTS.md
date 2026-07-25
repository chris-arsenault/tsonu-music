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
- **The Vite build publishes one stylesheet** (`cssCodeSplit: false`), because the `website` module
  is configured with a single `ENTRY_CSS`. Do not add a second entry stylesheet.
- **Do not commit runtime catalog data.** RDS is the source of truth for releases, songs,
  recordings, tracks, and jobs.
