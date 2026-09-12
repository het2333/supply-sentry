"""Authenticated, profile-scoped Weixin QR onboarding for Readywork.

The pinned Hermes dashboard does not yet expose the ``qr_login`` flow over HTTP.
This sidecar reuses Hermes' native iLink implementation, keeps the returned token
in server memory, and writes it through Hermes' own messaging configuration API.
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote, urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse


PROFILE_PATTERN = re.compile(r"^rw-[a-f0-9]{24}$")
PAIRING_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,160}$")
DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com"
GATEWAY_CONNECT_TIMEOUT_SECONDS = 30.0


class WeixinBackend(Protocol):
    async def fetch_qr(self, profile: str) -> tuple[str, str]: ...

    async def poll_qr(self, qrcode: str, base_url: str) -> dict[str, Any]: ...

    async def persist_account(self, profile: str, credentials: dict[str, str]) -> None: ...

    async def configure_and_restart(self, profile: str, credentials: dict[str, str]) -> dict[str, Any]: ...


@dataclass
class _Session:
    profile: str
    qrcode: str
    qr_payload: str
    expires_at_ts: float
    expires_at: str
    base_url: str = DEFAULT_ILINK_BASE_URL
    status: str = "waiting"
    refresh_count: int = 0
    credentials: dict[str, str] | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _utc_iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def _valid_profile(profile: str) -> str:
    normalized = str(profile or "").strip()
    if not PROFILE_PATTERN.fullmatch(normalized):
        raise ValueError("Invalid Readywork profile")
    return normalized


def _safe_ilink_base_url(value: Any) -> str:
    raw = str(value or "").strip()
    parsed = urlparse(raw)
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not (hostname == "weixin.qq.com" or hostname.endswith(".weixin.qq.com")):
        return DEFAULT_ILINK_BASE_URL
    return f"https://{parsed.netloc}"


def _gateway_lifecycle_action(status: dict[str, Any]) -> str:
    if status.get("gateway_running") is True:
        return "restart"
    return "start"


def _gateway_lifecycle_plan(status: dict[str, Any], profile: str) -> dict[str, str | None]:
    multiplex = status.get("gateway_mode") == "multiplex"
    return {
        "action": _gateway_lifecycle_action(status),
        "profile": None if multiplex else profile,
        "platform_key": f"{profile}:weixin" if multiplex else "weixin",
    }


class WeixinOnboardingManager:
    def __init__(
        self,
        backend: WeixinBackend,
        *,
        ttl_seconds: int = 480,
        max_refreshes: int = 3,
        clock=time.time,
    ) -> None:
        self._backend = backend
        self._ttl_seconds = ttl_seconds
        self._max_refreshes = max_refreshes
        self._clock = clock
        self._sessions: dict[str, _Session] = {}
        self._lock = asyncio.Lock()

    async def start(self, profile: str) -> dict[str, Any]:
        profile = _valid_profile(profile)
        qrcode, qr_payload = await self._backend.fetch_qr(profile)
        if not qrcode or not qr_payload:
            raise RuntimeError("Weixin QR service returned an incomplete response")
        expires_at_ts = self._clock() + self._ttl_seconds
        record = _Session(
            profile=profile,
            qrcode=qrcode,
            qr_payload=qr_payload,
            expires_at_ts=expires_at_ts,
            expires_at=_utc_iso(expires_at_ts),
        )
        pairing_id = secrets.token_urlsafe(18)
        async with self._lock:
            for existing_id, existing in list(self._sessions.items()):
                if existing.profile == profile:
                    existing.status = "cancelled"
                    existing.credentials = None
                    existing.qrcode = ""
                    self._sessions.pop(existing_id, None)
            self._sessions[pairing_id] = record
        return self._payload(pairing_id, record)

    async def status(self, profile: str, pairing_id: str) -> dict[str, Any]:
        record = await self._record(profile, pairing_id)
        async with record.lock:
            if record.status in {"ready", "applying"}:
                return self._payload(pairing_id, record)
            if record.status in {"cancelled", "error"}:
                raise KeyError(pairing_id)
            if self._clock() >= record.expires_at_ts:
                await self._refresh(pairing_id, record)

            try:
                response = await self._backend.poll_qr(record.qrcode, record.base_url)
            except TimeoutError:
                await self._ensure_active(pairing_id, record)
                record.status = "waiting"
                return self._payload(pairing_id, record)
            await self._ensure_active(pairing_id, record)
            status = str(response.get("status") or "wait").strip().lower()
            if status == "wait":
                record.status = "waiting"
            elif status == "scaned":
                record.status = "scanned"
            elif status == "scaned_but_redirect":
                record.status = "scanned"
                redirect_host = str(response.get("redirect_host") or "").strip()
                if redirect_host:
                    record.base_url = _safe_ilink_base_url(f"https://{redirect_host}")
            elif status == "expired":
                await self._refresh(pairing_id, record)
            elif status == "confirmed":
                credentials = {
                    "account_id": str(response.get("ilink_bot_id") or "").strip(),
                    "token": str(response.get("bot_token") or "").strip(),
                    "base_url": _safe_ilink_base_url(response.get("baseurl") or record.base_url),
                    "user_id": str(response.get("ilink_user_id") or "").strip(),
                }
                if not credentials["account_id"] or not credentials["token"]:
                    record.status = "error"
                    raise RuntimeError("Weixin confirmed without complete credentials")
                record.credentials = credentials
                record.qrcode = ""
                record.status = "ready"
            else:
                raise RuntimeError("Weixin QR service returned an unknown status")
            return self._payload(pairing_id, record)

    async def apply(self, profile: str, pairing_id: str) -> dict[str, Any]:
        record = await self._record(profile, pairing_id)
        async with record.lock:
            if record.status != "ready" or not record.credentials:
                raise RuntimeError("Weixin setup is not ready")
            credentials = dict(record.credentials)
            record.status = "applying"
        try:
            await self._backend.persist_account(record.profile, credentials)
            result = await self._backend.configure_and_restart(record.profile, credentials)
            if result.get("restart_started") is not True:
                raise RuntimeError("Weixin gateway restart failed")
            if result.get("gateway_connected") is not True:
                raise RuntimeError("Weixin gateway did not connect")
        except Exception:
            async with record.lock:
                if record.status == "applying":
                    record.status = "ready"
            raise
        async with record.lock:
            record.credentials = None
            record.status = "cancelled"
        async with self._lock:
            if self._sessions.get(pairing_id) is record:
                self._sessions.pop(pairing_id, None)
        return {
            "ok": True,
            "platform": "weixin",
            "needs_restart": False,
        }

    async def cancel(self, profile: str, pairing_id: str) -> dict[str, Any]:
        record = await self._record(profile, pairing_id)
        async with self._lock:
            if self._sessions.get(pairing_id) is not record:
                raise KeyError(pairing_id)
            if record.status == "applying":
                raise RuntimeError("Weixin setup is being applied")
            record.credentials = None
            record.qrcode = ""
            record.status = "cancelled"
            self._sessions.pop(pairing_id, None)
        return {"ok": True}

    async def _record(self, profile: str, pairing_id: str) -> _Session:
        profile = _valid_profile(profile)
        if not PAIRING_PATTERN.fullmatch(str(pairing_id or "")):
            raise KeyError(pairing_id)
        async with self._lock:
            record = self._sessions.get(pairing_id)
        if record is None:
            raise KeyError(pairing_id)
        if not hmac.compare_digest(record.profile, profile):
            raise PermissionError("Pairing belongs to another profile")
        return record

    async def _ensure_active(self, pairing_id: str, record: _Session) -> None:
        async with self._lock:
            if self._sessions.get(pairing_id) is not record or record.status == "cancelled":
                raise KeyError(pairing_id)

    async def _refresh(self, pairing_id: str, record: _Session) -> None:
        if record.refresh_count >= self._max_refreshes:
            record.qrcode = ""
            record.status = "expired"
            raise TimeoutError("Weixin QR setup expired")
        qrcode, qr_payload = await self._backend.fetch_qr(record.profile)
        await self._ensure_active(pairing_id, record)
        if not qrcode or not qr_payload:
            record.status = "error"
            raise RuntimeError("Weixin QR refresh returned an incomplete response")
        record.qrcode = qrcode
        record.qr_payload = qr_payload
        record.base_url = DEFAULT_ILINK_BASE_URL
        record.refresh_count += 1
        record.status = "waiting"
        record.expires_at_ts = self._clock() + self._ttl_seconds
        record.expires_at = _utc_iso(record.expires_at_ts)

    @staticmethod
    def _payload(pairing_id: str, record: _Session) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "pairing_id": pairing_id,
            "status": record.status,
            "qr_payload": record.qr_payload,
            "expires_at": record.expires_at,
        }
        if record.status == "ready":
            payload["account_name"] = "微信账号"
        return payload


class HermesWeixinBackend:
    def __init__(self) -> None:
        self._hermes_home = Path(os.getenv("HERMES_HOME", "/opt/data")).resolve()
        self._dashboard_url = os.getenv("HERMES_DASHBOARD_INTERNAL_URL", "http://127.0.0.1:9120").rstrip("/")
        self._dashboard_token = os.getenv("HERMES_DASHBOARD_SESSION_TOKEN", "")

    def _profile_home(self, profile: str) -> Path:
        profile = _valid_profile(profile)
        path = (self._hermes_home / "profiles" / profile).resolve()
        if path.parent != (self._hermes_home / "profiles").resolve() or not path.is_dir():
            raise ValueError("Readywork profile does not exist")
        return path

    async def fetch_qr(self, profile: str) -> tuple[str, str]:
        self._profile_home(profile)
        from gateway.platforms import weixin

        async with weixin._new_session() as session:
            return await weixin._fetch_qr(session, "3")

    async def poll_qr(self, qrcode: str, base_url: str) -> dict[str, Any]:
        from gateway.platforms import weixin

        async with weixin._new_session() as session:
            return await weixin._api_get(
                session,
                base_url=_safe_ilink_base_url(base_url),
                endpoint=f"{weixin.EP_GET_QR_STATUS}?qrcode={quote(qrcode, safe='')}",
                timeout_ms=10_000,
            )

    async def persist_account(self, profile: str, credentials: dict[str, str]) -> None:
        from gateway.platforms.weixin import save_weixin_account

        profile_home = self._profile_home(profile)
        await asyncio.to_thread(save_weixin_account, str(profile_home), **credentials)

    async def configure_and_restart(self, profile: str, credentials: dict[str, str]) -> dict[str, Any]:
        import aiohttp

        self._profile_home(profile)
        if not self._dashboard_token:
            raise RuntimeError("Hermes dashboard token is not configured")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Hermes-Session-Token": self._dashboard_token,
        }
        env = {
            "WEIXIN_ACCOUNT_ID": credentials["account_id"],
            "WEIXIN_TOKEN": credentials["token"],
            "WEIXIN_BASE_URL": credentials["base_url"],
        }
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.put(
                f"{self._dashboard_url}/api/messaging/platforms/weixin",
                params={"profile": profile},
                json={"enabled": True, "env": env, "clear_env": []},
            ) as response:
                await response.read()
                if response.status >= 400:
                    raise RuntimeError("Hermes rejected Weixin configuration")
            async with session.get(f"{self._dashboard_url}/api/status") as response:
                status = await response.json(content_type=None)
                if response.status >= 400 or not isinstance(status, dict):
                    raise RuntimeError("Hermes gateway status is unavailable")
            if status.get("gateway_mode") != "multiplex":
                async with session.get(
                    f"{self._dashboard_url}/api/status",
                    params={"profile": profile},
                ) as response:
                    status = await response.json(content_type=None)
                    if response.status >= 400 or not isinstance(status, dict):
                        raise RuntimeError("Hermes profile gateway status is unavailable")
            lifecycle_plan = _gateway_lifecycle_plan(status, profile)
            lifecycle_action = str(lifecycle_plan["action"])
            lifecycle_profile = lifecycle_plan["profile"]
            lifecycle_params = {"profile": lifecycle_profile} if lifecycle_profile else None
            async with session.post(
                f"{self._dashboard_url}/api/gateway/{lifecycle_action}",
                params=lifecycle_params,
            ) as response:
                await response.read()
                lifecycle_started = response.status < 400
            if not lifecycle_started:
                return {"restart_started": False, "gateway_connected": False}

            deadline = time.monotonic() + GATEWAY_CONNECT_TIMEOUT_SECONDS
            while time.monotonic() < deadline:
                await asyncio.sleep(1)
                async with session.get(
                    f"{self._dashboard_url}/api/status",
                    params=lifecycle_params,
                ) as response:
                    if response.status >= 400:
                        continue
                    status = await response.json(content_type=None)
                gateway_platforms = status.get("gateway_platforms") if isinstance(status, dict) else None
                platform_key = str(lifecycle_plan["platform_key"])
                weixin_status = gateway_platforms.get(platform_key) if isinstance(gateway_platforms, dict) else None
                if (
                    isinstance(status, dict)
                    and status.get("gateway_running") is True
                    and isinstance(weixin_status, dict)
                    and weixin_status.get("state") == "connected"
                ):
                    return {
                        "restart_started": True,
                        "gateway_connected": True,
                        "lifecycle_action": lifecycle_action,
                    }
            return {
                "restart_started": True,
                "gateway_connected": False,
                "lifecycle_action": lifecycle_action,
            }


def create_app(manager: WeixinOnboardingManager | None = None) -> FastAPI:
    app = FastAPI(title="Readywork Hermes Weixin Onboarding", docs_url=None, redoc_url=None, openapi_url=None)
    active_manager = manager or WeixinOnboardingManager(HermesWeixinBackend())
    expected_token = os.getenv("HERMES_DASHBOARD_SESSION_TOKEN", "")

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        if request.url.path == "/health":
            return await call_next(request)
        supplied = request.headers.get("X-Hermes-Session-Token", "")
        if not expected_token or not hmac.compare_digest(supplied, expected_token):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)

    def map_error(error: Exception) -> HTTPException:
        if isinstance(error, ValueError):
            return HTTPException(400, "微信接入参数无效")
        if isinstance(error, PermissionError):
            return HTTPException(404, "微信接入会话不存在")
        if isinstance(error, KeyError):
            return HTTPException(404, "微信接入会话不存在")
        if isinstance(error, TimeoutError):
            return HTTPException(410, "微信二维码已过期，请重新生成")
        return HTTPException(502, "微信接入服务暂时不可用")

    @app.get("/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    @app.post("/api/messaging/weixin/onboarding/start")
    async def start(profile: str) -> dict[str, Any]:
        try:
            return await active_manager.start(profile)
        except Exception as error:
            raise map_error(error) from error

    @app.get("/api/messaging/weixin/onboarding/{pairing_id}")
    async def status(pairing_id: str, profile: str) -> dict[str, Any]:
        try:
            return await active_manager.status(profile, pairing_id)
        except Exception as error:
            raise map_error(error) from error

    @app.post("/api/messaging/weixin/onboarding/{pairing_id}/apply")
    async def apply(pairing_id: str, profile: str) -> dict[str, Any]:
        try:
            return await active_manager.apply(profile, pairing_id)
        except Exception as error:
            raise map_error(error) from error

    @app.delete("/api/messaging/weixin/onboarding/{pairing_id}")
    async def cancel(pairing_id: str, profile: str) -> dict[str, Any]:
        try:
            return await active_manager.cancel(profile, pairing_id)
        except Exception as error:
            raise map_error(error) from error

    return app


app = create_app()


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=9121)
    arguments = parser.parse_args()
    uvicorn.run(app, host=arguments.host, port=arguments.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
