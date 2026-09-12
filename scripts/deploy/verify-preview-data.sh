#!/usr/bin/env bash
set -euo pipefail

archive_path="${1:?archive path is required}"
manifest_path="${2:?manifest path is required}"
server_root="${3:-/opt/readywork}"
release_id="${4:?release id is required}"

if [[ ! "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Invalid release id" >&2
  exit 2
fi
if [[ ! -f "$archive_path" || ! -f "$manifest_path" ]]; then
  echo "Archive or manifest is missing" >&2
  exit 3
fi

archive_dir="$(cd "$(dirname "$archive_path")" && pwd)"
archive_name="$(basename "$archive_path")"
manifest_dir="$(cd "$(dirname "$manifest_path")" && pwd)"
manifest_name="$(basename "$manifest_path")"
if [[ "$archive_dir" != "$manifest_dir" ]]; then
  echo "Archive and manifest must be in the same directory" >&2
  exit 4
fi

(
  cd "$archive_dir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$manifest_name"
  else
    shasum -a 256 -c "$manifest_name"
  fi
)

releases_dir="$server_root/releases"
release_dir="$releases_dir/$release_id"
shared_dir="$server_root/shared"
backup_dir="$shared_dir/backups/$release_id"
if [[ -e "$release_dir" ]]; then
  echo "Release already exists: $release_dir" >&2
  exit 5
fi

mkdir -p "$releases_dir" "$shared_dir/backups"
staging_dir="$(mktemp -d "$server_root/.verify-$release_id.XXXXXX")"
cleanup() {
  if [[ -d "$staging_dir" ]]; then
    find "$staging_dir" -depth -delete
  fi
}
trap cleanup EXIT

tar -C "$staging_dir" -xzf "$archive_path"
payload_dir="$staging_dir/readywork-$release_id"
if [[ ! -f "$payload_dir/RELEASE_ID" || "$(tr -d '\r\n' < "$payload_dir/RELEASE_ID")" != "$release_id" ]]; then
  echo "Release id inside archive does not match" >&2
  exit 6
fi
if [[ ! -f "$payload_dir/app/package.json" || ! -f "$payload_dir/data/readywork.sqlite" ]]; then
  echo "Archive payload is incomplete" >&2
  exit 7
fi

integrity="$(sqlite3 "$payload_dir/data/readywork.sqlite" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
  echo "SQLite integrity failed: $integrity" >&2
  exit 8
fi

mkdir -p "$backup_dir"
if [[ -f "$shared_dir/data/readywork.sqlite" ]]; then
  sqlite3 "$shared_dir/data/readywork.sqlite" ".backup '$backup_dir/readywork.sqlite'"
fi
if [[ -d "$shared_dir/hermes" ]]; then
  tar -C "$shared_dir" -czf "$backup_dir/hermes.tar.gz" \
    --exclude='*.log' --exclude='*.pid' --exclude='*.lock' --exclude='.env' --exclude='.env.*' hermes
fi

mkdir -p "$release_dir"
cp -a "$payload_dir/." "$release_dir/"
printf 'SQLite integrity: ok\n'
printf 'Verified release: %s\n' "$release_dir"
