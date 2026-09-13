#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
DEPLOY_DIR=${SUPPLYSENTRY_DEMO_DEPLOY_DIR:-/opt/supplysentry-demo}
IMAGE=${SUPPLYSENTRY_DEMO_IMAGE:-ghcr.io/het2333/supply-sentry-demo:latest}
PUBLIC_ORIGIN=${SUPPLYSENTRY_PUBLIC_ORIGIN:-http://47.102.116.148:3002}

if [[ "$DEPLOY_DIR" != "/opt/supplysentry-demo" ]]; then
  printf 'Refusing deployment: SupplySentry public demo must be isolated at /opt/supplysentry-demo.\n' >&2
  printf 'The production directory /opt/readywork/shared is forbidden.\n' >&2
  exit 2
fi

for command_name in docker openssl install; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  }
done
docker compose version >/dev/null

sudo install -d -m 0755 "$DEPLOY_DIR"
sudo install -m 0644 "$REPO_ROOT/infra/demo/compose.yml" "$DEPLOY_DIR/compose.yml"
sudo install -m 0644 "$REPO_ROOT/scripts/demo/verify-public-demo.mjs" "$DEPLOY_DIR/verify-public-demo.mjs"

ENV_FILE="$DEPLOY_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  temporary_env=$(mktemp)
  trap 'test -n "${temporary_env:-}" && test -f "$temporary_env" && unlink "$temporary_env"' EXIT
  umask 077
  {
    printf 'READYWORK_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'READYWORK_INTERNAL_CALLBACK_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'READYWORK_INTERNAL_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'READYWORK_TEMPORAL_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'READYWORK_DEMO_BIND_ADDRESS=0.0.0.0\n'
    printf 'READYWORK_DEMO_PORT=3002\n'
    printf 'READYWORK_DEMO_ALLOWED_ORIGINS=http://127.0.0.1:3002,http://localhost:3002,%s\n' "$PUBLIC_ORIGIN"
  } > "$temporary_env"
  sudo install -m 0600 "$temporary_env" "$ENV_FILE"
  unlink "$temporary_env"
  temporary_env=''
fi

sudo grep -qx 'READYWORK_DEMO_BIND_ADDRESS=0.0.0.0' "$ENV_FILE" || {
  printf 'Refusing deployment: %s must bind the approved public demo to 0.0.0.0.\n' "$ENV_FILE" >&2
  exit 2
}
sudo grep -qx 'READYWORK_DEMO_PORT=3002' "$ENV_FILE" || {
  printf 'Refusing deployment: %s must use port 3002.\n' "$ENV_FILE" >&2
  exit 2
}

compose=(docker compose --project-name supplysentry-demo --env-file "$ENV_FILE" -f "$DEPLOY_DIR/compose.yml")
sudo env READYWORK_DEMO_IMAGE="$IMAGE" "${compose[@]}" pull
sudo env READYWORK_DEMO_IMAGE="$IMAGE" "${compose[@]}" up -d --wait

sudo env READYWORK_DEMO_IMAGE="$IMAGE" "${compose[@]}" exec -T control-api \
  node /app/scripts/demo/verify-public-demo.mjs http://console:3001

printf 'SupplySentry public demo deployed and verified: %s\n' "$PUBLIC_ORIGIN"
