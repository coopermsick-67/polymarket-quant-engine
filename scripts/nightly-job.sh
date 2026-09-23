#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
data_dir="${PQE_DATA_DIR:-data}"
pnpm run backfill -- --data-dir "$data_dir"
pnpm run report -- --data-dir "$data_dir"
