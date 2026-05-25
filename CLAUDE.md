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

## Admin app layout

`frontend/src/admin/` is organized so each top-level surface owns its own folder:

- `AdminApp.tsx` — slim shell: topbar, nav, route dispatch, providers (~120 lines)
- `admin-routes.ts` — pure `parseAdminRoute` / `buildAdminPath` helpers
- `admin-api.ts`, `admin-types.ts`, `admin-helpers.ts` — transport, types, pure helpers
- `catalog-store.tsx` — React context store: songs/releases/jobs caches + actions
- `catalog-selectors.ts` — pure selector functions (releasesContainingSong, songsGroupedByRelease, publishReadinessFor)
- `notifications.tsx` — toast queue
- `pages/` — `ReleasesPage`, `SongsPage`, `ActivityPage`
- `releases/` — `ReleaseList`, `ReleaseDetail`, `ReleaseTracklist`, `PublishDrawer`
- `songs/` — `SongList`, `SongDetail`, `RecordingsTable`, `RecordingEditor`, `AppearsOnList`
- `activity/` — `EncodingJobsFeed`, `RumDashboard`
- `shared/` — `ListDetailLayout`, `StickyDetailHeader`, `StatusPill`, `EmptyState`, `ArtworkPicker`, `SongPicker`, `ReleasePicker`, `PickerDialog`, `RowActionMenu`, `ConfirmPopover`, `ToastRegion`, `ErrorBoundary`, `useBusy`, `useJobPolling`, `useSearchParam`, `useArrowKeyList`, `useObjectUrl`, `LoadingState`

Three top-level routes: `/admin/releases`, `/admin/songs`, `/admin/activity`. Legacy `/admin/publish`, `/admin/encoding`, `/admin/stats` are redirected or remapped (publish → drawer on release; encoding/stats → activity views). Selected ids and list filters live in the URL so back/forward and deep links work.

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
