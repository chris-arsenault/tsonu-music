# tsonu-music

Marketing site and first-party streaming surface for the band **Tsonu**. The
public React app serves album and track pages with a sticky HLS player, while
the admin surface manages catalog metadata, master uploads, encoding, publishing,
and playback analytics.

## URLs

One CloudFront distribution serves four hostnames:

- **`music.tsonu.com`** — primary
- `tsonu.com`
- `www.tsonu.com`
- `music.ahara.io`

## Architecture

- **Frontend**: React 19 + Vite + TypeScript, in [`frontend/`](./frontend).
- **Admin/API**: Rust Lambdas behind the shared Ahara ALB and Cognito app. Public playback catalog routes are exposed at `/catalog`.
- **Metadata**: shared Ahara RDS via migrations in [`db/migrations/`](./db/migrations). Runtime catalog data is not committed to this repo.
- **Media**: private S3 buckets for source masters and generated HLS/lossless assets, served through CloudFront where public.
- **Analytics**: CloudWatch RUM custom player events plus the admin stats dashboard.
- **Infrastructure**: Terraform in [`infrastructure/terraform/`](./infrastructure/terraform) using Ahara `website`, `alb-api`, `cognito-app`, and platform context patterns.

## Local development

```bash
cd frontend
pnpm install
pnpm dev          # http://localhost:3000
```

Backend and migration work follows the shared Ahara environment:

```bash
db-migrate        # applies db/migrations through the platform DB migration role
cd backend
cargo test --lib
```

## Pre-commit checks

```bash
make ci           # lint/typecheck/tests/schema validation/terraform fmt
```

## Deploy

Deploys are CI-only. Pushing to `main` triggers the shared platform workflow at
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml), which runs checks,
builds the frontend and Lambdas, applies `db/migrations`, and then applies
Terraform.

## License

MIT — see [LICENSE](./LICENSE).
