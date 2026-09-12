"""Internal Hermes platform adapter exposing the Readywork outbound bridge."""

from __future__ import annotations

import asyncio
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
from pathlib import Path
import shutil
import threading
import time
from typing import Any, Dict, Optional
import uuid

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult

from .bridge import BRIDGE_VERSION, DeliveryLedger, SpoolForwarder, dispatch_with_adapter, resolve_profile_adapter


MAX_REQUEST_BYTES = 25 * 1024 * 1024


class ReadyworkBridgeAdapter(BasePlatformAdapter):
    supports_async_delivery = False

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform("readywork_bridge"))
        extra = config.extra or {}
        self.host = str(extra.get("host") or os.environ.get("READYWORK_BRIDGE_HOST", "127.0.0.1"))
        self.port = int(extra.get("port") or os.environ.get("READYWORK_BRIDGE_PORT", "8788"))
        self.secret = os.environ.get("READYWORK_BRIDGE_SECRET", "")
        self.readywork_url = os.environ.get("READYWORK_API_URL", "http://host.docker.internal:4173")
        root = Path(os.environ.get(
            "READYWORK_BRIDGE_DATA_DIR",
            str(Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / "plugin-data" / "readywork-bridge"),
        ))
        root.mkdir(parents=True, exist_ok=True)
        self.root = root
        self.ledger = DeliveryLedger(root / "delivery-ledger.sqlite")
        self.forwarder = SpoolForwarder(self.readywork_url, self.secret)
        self._server: ThreadingHTTPServer | None = None
        self._server_thread: threading.Thread | None = None
        self._forward_thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop = threading.Event()

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if len(self.secret) < 32:
            return False
        self._loop = asyncio.get_running_loop()
        handler = self._handler_class()
        try:
            self._server = ThreadingHTTPServer((self.host, self.port), handler)
        except OSError:
            return False
        self._server_thread = threading.Thread(
            target=self._server.serve_forever,
            name="readywork-bridge-http",
            daemon=True,
        )
        self._server_thread.start()
        self._stop.clear()
        self._forward_thread = threading.Thread(
            target=self._forward_spool,
            name="readywork-bridge-spool",
            daemon=True,
        )
        self._forward_thread.start()
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        self._stop.set()
        if self._server:
            self._server.shutdown()
            self._server.server_close()
        self._server = None
        self._running = False

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        return SendResult(success=False, error="Readywork Bridge is an internal dispatcher")

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": "Readywork Bridge", "type": "internal"}

    def _forward_spool(self) -> None:
        spool = self.root / "spool"
        spool.mkdir(parents=True, exist_ok=True)
        backoff = 1.0
        while not self._stop.is_set():
            items = sorted(spool.glob("*.json"))
            if not items:
                self._stop.wait(1.0)
                backoff = 1.0
                continue
            failed = False
            for item in items:
                if self._stop.is_set():
                    return
                try:
                    self.forwarder.deliver_once(item)
                    backoff = 1.0
                except Exception:
                    failed = True
                    break
            if failed:
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 60.0)

    def _handler_class(self):
        adapter = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "ReadyworkBridge/1"

            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def do_GET(self) -> None:
                if self.path != "/health":
                    self._json(404, {"error": "not_found"})
                    return
                pending = len(list((adapter.root / "spool").glob("*.json")))
                self._json(200, {
                    "ok": pending < 10_000,
                    "version": BRIDGE_VERSION,
                    "spoolPending": pending,
                })

            def do_POST(self) -> None:
                if self.path != "/readywork/v1/deliveries":
                    self._json(404, {"error": "not_found"})
                    return
                try:
                    length = int(self.headers.get("content-length", "0"))
                    if length <= 0 or length > MAX_REQUEST_BYTES:
                        raise ValueError("request size is invalid")
                    body = self.rfile.read(length)
                    self._verify(body)
                    payload = json.loads(body.decode("utf-8"))
                    if not isinstance(payload, dict):
                        raise ValueError("payload must be an object")
                    reservation = adapter.ledger.reserve(payload)
                    if reservation["state"] != "reserved":
                        self._json(200, reservation["result"])
                        return
                    target = adapter._target_adapter(
                        str(payload.get("profile") or ""),
                        str(payload.get("platform") or ""),
                    )
                    if target is None:
                        result = {
                            "kind": "failed_before_dispatch",
                            "error": "Hermes 目标渠道未连接",
                        }
                    elif adapter._loop is None:
                        result = {
                            "kind": "failed_before_dispatch",
                            "error": "Hermes Gateway 事件循环不可用",
                        }
                    else:
                        materialized = adapter._materialize_attachments(payload)
                        future = asyncio.run_coroutine_threadsafe(
                            dispatch_with_adapter(target, materialized),
                            adapter._loop,
                        )
                        result = future.result(timeout=120)
                    adapter.ledger.complete(str(payload["deliveryId"]), result)
                    self._json(200, result)
                except ValueError as error:
                    self._json(409, {"kind": "failed_before_dispatch", "error": str(error)[:500]})
                except TimeoutError:
                    self._json(200, {
                        "kind": "unknown_after_dispatch",
                        "error": "Hermes 官方适配器调用超时，投递结果未知",
                    })
                except Exception:
                    self._json(400, {"kind": "failed_before_dispatch", "error": "Bridge 请求无效"})

            def _verify(self, body: bytes) -> None:
                version = self.headers.get("X-Readywork-Bridge-Version", "")
                timestamp = self.headers.get("X-Readywork-Timestamp", "")
                nonce = self.headers.get("X-Readywork-Nonce", "")
                signature = self.headers.get("X-Readywork-Signature", "")
                if version != BRIDGE_VERSION or not nonce or not signature:
                    raise ValueError("bridge authentication headers are invalid")
                stamp = float(timestamp)
                stamp_ms = stamp * 1000 if stamp < 10_000_000_000 else stamp
                if abs(time.time() * 1000 - stamp_ms) > 300_000:
                    raise ValueError("bridge timestamp is stale")
                signing = b"\n".join([
                    b"POST",
                    b"/readywork/v1/deliveries",
                    timestamp.encode("ascii"),
                    nonce.encode("ascii"),
                    body,
                ])
                expected = hmac.new(adapter.secret.encode("utf-8"), signing, hashlib.sha256).hexdigest()
                if not hmac.compare_digest(expected, signature):
                    raise ValueError("bridge signature is invalid")

            def _json(self, status: int, body: dict[str, Any]) -> None:
                encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json; charset=utf-8")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        return Handler

    def _target_adapter(self, profile: str, platform: str):
        return resolve_profile_adapter(self.gateway_runner, profile, platform)

    def _materialize_attachments(self, payload: dict[str, Any]) -> dict[str, Any]:
        delivery_id = str(payload.get("deliveryId") or "")
        safe_id = hashlib.sha256(delivery_id.encode("utf-8")).hexdigest()
        destination = self.root / "outbound" / safe_id
        destination.mkdir(parents=True, exist_ok=True)
        normalized = []
        for index, item in enumerate(payload.get("attachments") or []):
            if not isinstance(item, dict):
                raise ValueError("attachment entry is invalid")
            content = base64.b64decode(str(item.get("contentBase64") or ""), validate=True)
            digest = hashlib.sha256(content).hexdigest()
            if digest != item.get("sha256") or len(content) != item.get("sizeBytes") or len(content) > 10 * 1024 * 1024:
                raise ValueError("attachment bytes do not match descriptor")
            path = destination / f"{index + 1:02d}-{digest}"
            with path.open("xb") as output:
                output.write(content)
            normalized.append({**item, "path": str(path)})
        return {**payload, "attachments": normalized, "_attachmentRoot": str(destination)}
