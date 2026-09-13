#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "DeepSeek evaluation unavailable: DEEPSEEK_API_KEY is not set" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/../.." && pwd)"
cd "$repository_root"

pnpm eval:supplier-replies -- \
  --runner deepseek \
  --concurrency 1 \
  --report-dir reports/evaluations/deepseek-local
