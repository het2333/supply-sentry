#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_dir="$(cd "$script_dir/../.." && pwd)"
output_dir="${1:-$workspace_dir/artifacts/releases}"
release_id="${2:-$(date -u +%Y%m%dT%H%M%SZ)}"

# Prevent macOS extended attributes from becoming AppleDouble files on Linux.
export COPYFILE_DISABLE=1

if [[ ! "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Invalid release id" >&2
  exit 2
fi

db_path="$workspace_dir/data/readywork.sqlite"
if [[ ! -f "$db_path" ]]; then
  echo "Missing business database: $db_path" >&2
  exit 3
fi

mkdir -p "$output_dir"
staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/readywork-preview.XXXXXX")"
cleanup() {
  if [[ -d "$staging_dir" ]]; then
    find "$staging_dir" -depth -delete
  fi
}
trap cleanup EXIT

payload_dir="$staging_dir/readywork-$release_id"
mkdir -p "$payload_dir/app" "$payload_dir/data" "$payload_dir/hermes/plugin-data/readywork-bridge"

tar -C "$workspace_dir" -cf - \
  --exclude='.DS_Store' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='__pycache__' \
  --exclude='*.log' \
  --exclude='*.pid' \
  --exclude='*.lock' \
  --exclude='*.sqlite-wal' \
  --exclude='*.sqlite-shm' \
  .dockerignore package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json apps packages infra scripts \
  | tar -C "$payload_dir/app" -xf -

sqlite3 "$db_path" ".backup '$payload_dir/data/readywork.sqlite'"
integrity="$(sqlite3 "$payload_dir/data/readywork.sqlite" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
  echo "SQLite integrity failed: $integrity" >&2
  exit 4
fi

ledger_source="$workspace_dir/data/hermes/plugin-data/readywork-bridge/delivery-ledger.sqlite"
if [[ -f "$ledger_source" ]]; then
  sqlite3 "$ledger_source" ".backup '$payload_dir/hermes/plugin-data/readywork-bridge/delivery-ledger.sqlite'"
fi

printf '%s\n' "$release_id" > "$payload_dir/RELEASE_ID"
printf 'ok\n' > "$payload_dir/SQLITE_INTEGRITY"

archive_name="readywork-$release_id.tar.gz"
manifest_name="readywork-$release_id.SHA256SUMS"
tar -C "$staging_dir" -czf "$output_dir/$archive_name" "readywork-$release_id"
(
  cd "$output_dir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$archive_name" > "$manifest_name"
  else
    shasum -a 256 "$archive_name" > "$manifest_name"
  fi
)

echo "Bundle: $output_dir/$archive_name"
echo "Manifest: $output_dir/$manifest_name"
echo "SQLite integrity: ok"
