# Claude Guide

Marketing site for the band **Tsonu**. Single-page React app, built with Vite, deployed to CloudFront via the platform `website` module.

## URLs

One CloudFront distribution serves four hostnames:

- **`music.tsonu.com`** — primary URL
- `tsonu.com` — apex alias
- `www.tsonu.com` — www alias
- `music.ahara.io` — platform alias

DNS records for the three `tsonu.com` hostnames live in the `tsonu.com.` Route53 zone; `music.ahara.io` lives in the `ahara.io.` zone. Both zones are in the same AWS account and both Route53 records are managed by the `website` module.

## Architecture

- **Frontend**: React 19 + Vite, TypeScript, in `frontend/`. No backend, no database, no authentication.
- **Infrastructure**: `infrastructure/terraform/main.tf` calls the `ahara-tf-patterns` `website` module (S3 + CloudFront + ACM + WAF + KMS + Route53).
- **Analytics**: Google Analytics 4 loaded lazily by `frontend/src/CookieBanner.tsx` only after user consent.

## Build and deploy

- **Local dev**: `cd frontend && pnpm install && pnpm dev` → http://localhost:3000
- **Local build**: `cd frontend && pnpm run build` → `frontend/build/`
- **Deploy**: CI only. Push to `main` triggers the shared platform workflow (`.github/workflows/ci.yml`) which builds, then runs `terraform apply` to deploy.
- **Pre-commit check**: `make ci` runs lint + typecheck + terraform fmt.

## Stack declaration

`platform.yml` declares `stack: [typescript, terraform]`. The shared workflow auto-detects the frontend at `frontend/` (shallowest `package.json` outside `node_modules`). No migrations, no Rust, no TrueNAS.

## Key decisions

- **`music.tsonu.com` is the canonical URL** but all four hostnames resolve to the same S3 content. The band's historical `tsonu.com` presence is preserved.
- **`frontend/build/`** is the Vite output dir (not the default `dist/`) — preserved from the legacy Create React App layout to minimize churn in downstream paths.
- **No vitest setup** — the app has no tests yet. Adding vitest is a follow-up when there's something to test.
- **Tailwind is loaded via CDN** (`https://cdn.tailwindcss.com`) in `frontend/index.html`, not bundled. This predates the Vite migration and hasn't been untangled.
