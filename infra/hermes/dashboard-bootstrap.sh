#!/bin/sh
set -eu

python /opt/readywork/dashboard_loopback_proxy.py \
  --listen-host 0.0.0.0 \
  --listen-port 9119 \
  --upstream-host 127.0.0.1 \
  --upstream-port 9120 &
proxy_pid=$!

python /opt/readywork/weixin_onboarding_service.py \
  --host 0.0.0.0 \
  --port 9121 &
weixin_onboarding_pid=$!

cleanup() {
  kill "$proxy_pid" 2>/dev/null || true
  kill "$weixin_onboarding_pid" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

hermes dashboard --host 127.0.0.1 --port 9120 --no-open --skip-build
