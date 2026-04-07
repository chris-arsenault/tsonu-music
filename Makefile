.PHONY: ci lint typecheck build terraform-fmt-check

ci: lint typecheck terraform-fmt-check

lint:
	cd frontend && pnpm exec eslint .

typecheck:
	cd frontend && pnpm exec tsc --noEmit

build:
	cd frontend && pnpm run build

terraform-fmt-check:
	terraform fmt -check -recursive infrastructure/terraform/
