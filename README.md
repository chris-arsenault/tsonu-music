# tsonu-music

Marketing site for the band **Tsonu**. Single-page React app announcing the debut album *So We Sleep* with streaming and social links.

## URLs

One CloudFront distribution serves four hostnames:

- **`music.tsonu.com`** — primary
- `tsonu.com`
- `www.tsonu.com`
- `music.ahara.io`

## Architecture

- **Frontend**: React 19 + Vite + TypeScript, in [`frontend/`](./frontend)
- **Infrastructure**: Terraform in [`infrastructure/terraform/`](./infrastructure/terraform) using the [`website`](https://github.com/chris-arsenault/ahara-tf-patterns/tree/main/modules/website) module from `ahara-tf-patterns` (S3 + CloudFront + ACM + WAF + KMS + Route53)
- **No backend, no database, no auth.** Analytics is Google Analytics 4 loaded lazily after user consent.

## Local development

```bash
cd frontend
pnpm install
pnpm dev          # http://localhost:3000
```

## Pre-commit checks

```bash
make ci           # runs eslint + tsc --noEmit + terraform fmt -check
```

## Deploy

Deploys are CI-only. Pushing to `main` triggers the shared platform workflow at [`.github/workflows/ci.yml`](./.github/workflows/ci.yml), which runs lint/typecheck, builds the frontend, and applies Terraform.

## License

MIT — see [LICENSE](./LICENSE).
