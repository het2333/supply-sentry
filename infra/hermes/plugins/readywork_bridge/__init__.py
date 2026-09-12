"""Hermes plugin entrypoint for the Readywork procurement bridge."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from .bridge import SpoolStore


logger = logging.getLogger("plugins.readywork_bridge")


def _data_root() -> Path:
    configured = os.environ.get("READYWORK_BRIDGE_DATA_DIR", "").strip()
    if configured:
        return Path(configured)
    return Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / "plugin-data" / "readywork-bridge"


def _profile_for_event(event: Any) -> str:
    source = getattr(event, "source", None)
    routed = str(getattr(source, "profile", "") or "").strip()
    if routed:
        return routed
    explicit = os.environ.get("READYWORK_PROFILE_ID", "").strip()
    if explicit:
        return explicit
    try:
        from hermes_cli.profiles import get_active_profile_name
        return str(get_active_profile_name() or "").strip()
    except Exception:
        return ""


def _pre_gateway_dispatch(*, event: Any, **_kwargs: Any) -> dict[str, str]:
    profile = _profile_for_event(event)
    try:
        SpoolStore(_data_root() / "spool").spool_event(event, profile)
        return {"action": "skip", "reason": "readywork_durable_spool"}
    except Exception:
        logger.exception("Readywork inbound spool failed; generic agent remains blocked")
        return {"action": "skip", "reason": "readywork_spool_blocked"}


def _build_adapter(config: Any):
    from .adapter import ReadyworkBridgeAdapter
    return ReadyworkBridgeAdapter(config)


def _env_enablement() -> dict[str, Any] | None:
    if not os.environ.get("READYWORK_BRIDGE_SECRET", "").strip():
        return None
    return {
        "host": os.environ.get("READYWORK_BRIDGE_HOST", "127.0.0.1"),
        "port": int(os.environ.get("READYWORK_BRIDGE_PORT", "8788")),
    }


def register(ctx: Any) -> None:
    ctx.register_hook("pre_gateway_dispatch", _pre_gateway_dispatch)
    ctx.register_platform(
        name="readywork_bridge",
        label="Readywork Bridge",
        adapter_factory=_build_adapter,
        check_fn=lambda: True,
        validate_config=lambda _config: bool(os.environ.get("READYWORK_BRIDGE_SECRET", "").strip()),
        is_connected=lambda _config: bool(os.environ.get("READYWORK_BRIDGE_SECRET", "").strip()),
        required_env=["READYWORK_BRIDGE_SECRET", "READYWORK_API_URL"],
        install_hint="Readywork internal component; no extra dependency is required.",
        env_enablement_fn=_env_enablement,
        max_message_length=2_000_000,
        pii_safe=False,
        emoji="🔒",
    )


__all__ = ["register"]
