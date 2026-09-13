#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
COMPOSE_FILE="$REPO_ROOT/infra/demo/compose.yml"
BUILD_FILE="$REPO_ROOT/infra/demo/compose.build.yml"
ENV_FILE=${READYWORK_DEMO_ENV_FILE:-"$REPO_ROOT/infra/demo/.env"}
PROJECT_NAME=supplysentry-demo

random_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

ensure_env() {
  if [ -f "$ENV_FILE" ]; then return; fi
  mkdir -p "$(dirname -- "$ENV_FILE")"
  umask 077
  session_secret=$(random_hex)
  callback_token=$(random_hex)
  internal_token=$(random_hex)
  temporal_password=$(random_hex)
  {
    printf 'READYWORK_SESSION_SECRET=%s\n' "$session_secret"
    printf 'READYWORK_INTERNAL_CALLBACK_TOKEN=%s\n' "$callback_token"
    printf 'READYWORK_INTERNAL_TOKEN=%s\n' "$internal_token"
    printf 'READYWORK_TEMPORAL_DB_PASSWORD=%s\n' "$temporal_password"
    printf 'READYWORK_DEMO_BIND_ADDRESS=127.0.0.1\n'
    printf 'READYWORK_DEMO_PORT=3002\n'
  } > "$ENV_FILE"
  printf 'Created isolated demo configuration: %s\n' "$ENV_FILE"
}

compose() {
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_build() {
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$BUILD_FILE" "$@"
}

env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

command=${1:-help}
case "$command" in
  up)
    ensure_env
    if [ "${2:-}" = "--build" ]; then
      compose_build up -d --build --wait
    elif [ -n "${2:-}" ]; then
      printf 'Unknown up option: %s\n' "$2" >&2
      exit 2
    else
      compose pull
      compose up -d --wait
    fi
    demo_port=${READYWORK_DEMO_PORT:-$(env_value READYWORK_DEMO_PORT)}
    demo_port=${demo_port:-3002}
    curl --fail --silent --show-error "http://127.0.0.1:$demo_port/" >/dev/null
    printf 'SupplySentry public demo is ready: http://127.0.0.1:%s/\n' "$demo_port"
    printf 'Logs: ./scripts/demo/demo.sh logs\nStop: ./scripts/demo/demo.sh down\n'
    ;;
  down)
    ensure_env
    compose down
    ;;
  logs)
    ensure_env
    compose logs -f
    ;;
  status)
    ensure_env
    compose ps
    ;;
  verify)
    ensure_env
    callback_token=$(env_value READYWORK_INTERNAL_CALLBACK_TOKEN)
    [ -n "$callback_token" ] || { printf 'Missing internal callback token\n' >&2; exit 1; }
    demo_port=${READYWORK_DEMO_PORT:-$(env_value READYWORK_DEMO_PORT)}
    demo_port=${demo_port:-3002}
    READYWORK_INTERNAL_CALLBACK_TOKEN="$callback_token" \
      node "$SCRIPT_DIR/verify-public-demo.mjs" "http://127.0.0.1:$demo_port/"
    ;;
  reset)
    ensure_env
    callback_token=$(env_value READYWORK_INTERNAL_CALLBACK_TOKEN)
    [ -n "$callback_token" ] || { printf 'Missing internal callback token\n' >&2; exit 1; }
    compose exec -T control-api node -e "fetch('http://127.0.0.1:4174/internal/demo/reset',{method:'POST',headers:{'x-readywork-internal-token':process.env.READYWORK_INTERNAL_CALLBACK_TOKEN}}).then(async r=>{const text=await r.text();console.log(text);if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
    ;;
  purge)
    ensure_env
    printf 'Type purge to delete only the SupplySentry demo volumes: ' >&2
    IFS= read -r confirmation
    [ "$confirmation" = "purge" ] || { printf 'Purge cancelled.\n' >&2; exit 1; }
    compose down --volumes
    ;;
  help|-h|--help)
    printf 'Usage: ./scripts/demo/demo.sh up [--build] | down | logs | status | verify | reset | purge\n'
    ;;
  *)
    printf 'Unknown command: %s\n' "$command" >&2
    exit 2
    ;;
esac
