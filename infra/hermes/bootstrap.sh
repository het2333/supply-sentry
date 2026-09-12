#!/bin/sh
set -eu

python - <<'PY'
import os
from pathlib import Path

import yaml

home = Path(os.environ.get("HERMES_HOME", "/opt/data"))
home.mkdir(parents=True, exist_ok=True)
path = home / "config.yaml"
try:
    current = yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else {}
except Exception as exc:
    raise SystemExit(f"Hermes 配置文件无法解析: {exc}")
if not isinstance(current, dict):
    raise SystemExit("Hermes 配置根节点必须是对象")
current.setdefault("_config_version", 41)
plugins = current.setdefault("plugins", {})
if not isinstance(plugins, dict):
    raise SystemExit("Hermes plugins 配置必须是对象")
enabled = plugins.setdefault("enabled", [])
if not isinstance(enabled, list):
    raise SystemExit("Hermes plugins.enabled 必须是列表")
if "readywork-bridge" not in enabled:
    enabled.append("readywork-bridge")
temporary = path.with_suffix(".yaml.tmp")
temporary.write_text(yaml.safe_dump(current, allow_unicode=True, sort_keys=False), encoding="utf-8")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY

exec hermes gateway run
