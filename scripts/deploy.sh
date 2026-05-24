#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT_DIR}/infrastructure/terraform"

STATE_BUCKET="${STATE_BUCKET:-tfstate-559098897826}"
STATE_REGION="${STATE_REGION:-us-east-1}"

# Build frontend
echo "Building frontend..."
cd "${ROOT_DIR}/frontend"
pnpm install --frozen-lockfile
pnpm run build
cd "${ROOT_DIR}"

# Build backend Lambda artifacts referenced by Terraform.
echo "Building backend Lambdas..."
cd "${ROOT_DIR}/backend"
cargo lambda build --release
cd "${ROOT_DIR}"

echo "Building ffmpeg Lambda layer..."
"${ROOT_DIR}/scripts/build-ffmpeg-layer.sh"

# Deploy infrastructure
echo "Deploying infrastructure..."
terraform -chdir="${TF_DIR}" init -reconfigure \
  -backend-config="bucket=${STATE_BUCKET}" \
  -backend-config="region=${STATE_REGION}" \
  -backend-config="use_lockfile=true"

terraform -chdir="${TF_DIR}" apply -auto-approve

echo ""
echo "=== Deploy complete ==="
