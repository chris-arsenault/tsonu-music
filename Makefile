.PHONY: ci lint lint-frontend lint-rust lint-rust-lines fmt-rust typecheck test test-frontend test-rust test-encode-fixture schema-validate manifest-validate migrate build build-frontend build-backend build-rust build-ffmpeg-layer terraform-fmt-check deploy

ci: lint fmt-rust typecheck test schema-validate terraform-fmt-check

lint: lint-frontend lint-rust

lint-frontend:
	cd frontend && pnpm exec eslint .

lint-rust: lint-rust-lines
	cd backend && cargo clippy --release --workspace --all-targets -- -D warnings -W clippy::cognitive_complexity

lint-rust-lines:
	scripts/check-rust-file-lines.sh

fmt-rust:
	cd backend && cargo fmt --check

typecheck:
	cd frontend && pnpm exec tsc --noEmit

test: test-frontend test-rust

test-frontend:
	cd frontend && pnpm exec vitest run

test-rust:
	cd backend && cargo test --lib

test-encode-fixture:
	cd backend && cargo test -p encoder local_fixture_transcodes_short_wav_to_hls_and_lossless -- --ignored --nocapture

schema-validate:
	node scripts/validate-media-catalog-schemas.mjs

manifest-validate: schema-validate

migrate:
	db-migrate

build: build-frontend build-backend

build-frontend:
	cd frontend && pnpm run build

build-backend: build-rust build-ffmpeg-layer

build-rust:
	cd backend && cargo lambda build --release

build-ffmpeg-layer:
	scripts/build-ffmpeg-layer.sh

terraform-fmt-check:
	terraform fmt -check -recursive infrastructure/terraform/

deploy:
	scripts/deploy.sh
