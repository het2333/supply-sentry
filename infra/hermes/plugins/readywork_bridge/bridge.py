"""Durable, stdlib-only bridge primitives shared by the Hermes plugin.

The module intentionally has no Hermes imports so its durability and security
contracts can be tested without booting the agent.
"""

from __future__ import annotations

import base64
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import time
from typing import Any, Callable
from urllib import request as urllib_request
import uuid


BRIDGE_VERSION = "readywork.hermes.bridge.v1"
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024
MAX_SPOOL_BYTES = 512 * 1024 * 1024


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _iso_timestamp(value: Any) -> str:
    if isinstance(value, datetime):
        current = value
    else:
        current = datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _platform_name(source: Any) -> str:
    platform = getattr(source, "platform", "")
    return str(getattr(platform, "value", platform) or "").strip().lower()


def _safe_raw(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return "[truncated]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:20_000]
    if isinstance(value, (list, tuple)):
        return [_safe_raw(item, depth + 1) for item in value[:100]]
    if isinstance(value, dict):
        return {
            str(key)[:160]: _safe_raw(item, depth + 1)
            for key, item in list(value.items())[:100]
            if str(key).lower() not in {"token", "password", "secret", "authorization"}
        }
    return str(value)[:2_000]


class SpoolStore:
    def __init__(
        self,
        root: Path,
        *,
        max_attachment_bytes: int = MAX_ATTACHMENT_BYTES,
        max_total_attachment_bytes: int = MAX_ATTACHMENTS_BYTES,
        max_spool_bytes: int = MAX_SPOOL_BYTES,
    ):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_attachment_bytes = max_attachment_bytes
        self.max_total_attachment_bytes = max_total_attachment_bytes
        self.max_spool_bytes = max_spool_bytes

    def spool_event(self, event: Any, profile: str) -> Path:
        source = getattr(event, "source", None)
        platform = _platform_name(source)
        if not platform:
            raise ValueError("event source platform is required")
        if not profile or not profile.startswith("rw-"):
            raise ValueError("Readywork profile is required")
        attachments, total = self._freeze_attachment_descriptors(event, profile)
        fallback_material = {
            "profile": profile,
            "platform": platform,
            "chat": str(getattr(source, "chat_id", "") or ""),
            "sender": str(getattr(source, "user_id", "") or ""),
            "timestamp": _iso_timestamp(getattr(event, "timestamp", None)),
            "text": str(getattr(event, "text", "") or ""),
            "attachments": [{"sha256": row["sha256"], "sizeBytes": row["sizeBytes"]} for row in attachments],
        }
        provider_message_id = str(getattr(event, "message_id", "") or "").strip()
        if not provider_message_id:
            provider_message_id = "fallback-" + hashlib.sha256(
                _stable_json(fallback_material).encode("utf-8")
            ).hexdigest()
        identity = hashlib.sha256(
            f"{profile}\n{platform}\n{provider_message_id}".encode("utf-8")
        ).hexdigest()
        final_path = self.root / f"{identity}.json"
        if final_path.exists():
            return final_path
        if self._current_size() + total > self.max_spool_bytes:
            raise RuntimeError("Readywork bridge spool capacity exceeded")

        attachment_dir = self.root / f"{identity}.attachments"
        temp_attachment_dir = self.root / f".{identity}.{uuid.uuid4().hex}.attachments.tmp"
        temp_attachment_dir.mkdir(mode=0o700)
        try:
            for index, descriptor in enumerate(attachments):
                destination = temp_attachment_dir / descriptor["storedName"]
                content = descriptor.pop("_content")
                with destination.open("xb") as target_file:
                    target_file.write(content)
                    target_file.flush()
                    os.fsync(target_file.fileno())
                os.chmod(destination, 0o600)
            os.replace(temp_attachment_dir, attachment_dir)

            payload = {
                "requestId": f"spool-{identity}",
                "profile": profile,
                "event": {
                    "platform": platform,
                    "messageId": provider_message_id,
                    "conversationId": str(getattr(source, "chat_id", "") or ""),
                    "inReplyTo": str(getattr(event, "reply_to_message_id", "") or "") or None,
                    "references": [],
                    "sender": {
                        "address": str(getattr(source, "user_id", "") or getattr(event, "user_id", "") or "unknown"),
                        "displayName": str(getattr(source, "user_name", "") or getattr(event, "user_name", "") or "") or None,
                    },
                    "recipients": [{"address": str(getattr(source, "chat_id", "") or "readywork")}],
                    "subject": None,
                    "text": str(getattr(event, "text", "") or ""),
                    "occurredAt": _iso_timestamp(getattr(event, "timestamp", None)),
                    "threadId": str(getattr(source, "thread_id", "") or "") or None,
                    "raw": _safe_raw(getattr(event, "raw_message", None)),
                },
                "attachments": attachments,
            }
            temp_json = self.root / f".{identity}.{uuid.uuid4().hex}.json.tmp"
            with temp_json.open("x", encoding="utf-8") as output:
                json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temp_json, 0o600)
            os.replace(temp_json, final_path)
            return final_path
        except Exception:
            shutil.rmtree(temp_attachment_dir, ignore_errors=True)
            if not final_path.exists():
                shutil.rmtree(attachment_dir, ignore_errors=True)
            raise

    def _freeze_attachment_descriptors(self, event: Any, profile: str) -> tuple[list[dict[str, Any]], int]:
        media_urls = list(getattr(event, "media_urls", None) or [])
        media_types = list(getattr(event, "media_types", None) or [])
        if len(media_urls) > 20:
            raise ValueError("attachment count exceeds limit")
        descriptors: list[dict[str, Any]] = []
        total = 0
        hermes_home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))).resolve()
        allowed_roots = (
            (hermes_home / "cache").resolve(),
            (hermes_home / "profiles" / profile / "cache").resolve(),
        )
        for index, raw_path in enumerate(media_urls):
            source_path = Path(str(raw_path))
            if source_path.is_symlink():
                raise ValueError("symbolic link attachments are forbidden")
            if not source_path.is_absolute():
                raise ValueError("attachment path must be an existing absolute file")
            try:
                resolved_path = source_path.resolve(strict=True)
            except OSError as error:
                raise ValueError("attachment path must be an existing absolute file") from error
            if not any(resolved_path == root or root in resolved_path.parents for root in allowed_roots):
                raise ValueError("attachment path is outside the Hermes media root")
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            try:
                descriptor_fd = os.open(resolved_path, flags)
            except OSError as error:
                raise ValueError("attachment path cannot be opened safely") from error
            try:
                before = os.fstat(descriptor_fd)
                if not stat.S_ISREG(before.st_mode):
                    raise ValueError("attachment path must be a regular file")
                if before.st_size > self.max_attachment_bytes:
                    raise ValueError("attachment size exceeds limit")
                chunks: list[bytes] = []
                consumed = 0
                while True:
                    chunk = os.read(descriptor_fd, min(1024 * 1024, self.max_attachment_bytes + 1 - consumed))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    consumed += len(chunk)
                    if consumed > self.max_attachment_bytes:
                        raise ValueError("attachment size exceeds limit")
                after = os.fstat(descriptor_fd)
                if (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size):
                    raise ValueError("attachment changed while being read")
                content = b"".join(chunks)
            finally:
                os.close(descriptor_fd)
            if len(content) > self.max_attachment_bytes:
                raise ValueError("attachment size exceeds limit")
            total += len(content)
            if total > self.max_total_attachment_bytes:
                raise ValueError("attachment total size exceeds limit")
            digest = hashlib.sha256(content).hexdigest()
            content_type = (
                str(media_types[index]).strip()
                if index < len(media_types) and media_types[index]
                else mimetypes.guess_type(source_path.name)[0] or "application/octet-stream"
            )
            descriptors.append({
                "id": f"attachment-{index + 1}-{digest[:16]}",
                "name": resolved_path.name[:500],
                "contentType": content_type[:200],
                "sizeBytes": len(content),
                "sha256": digest,
                "storedName": f"{index + 1:02d}-{digest}",
                "_content": content,
            })
        return descriptors, total

    def _current_size(self) -> int:
        total = 0
        for path in self.root.rglob("*"):
            if path.is_file() and not path.is_symlink():
                try:
                    total += path.stat().st_size
                except OSError:
                    pass
        return total


class SpoolForwarder:
    def __init__(self, readywork_url: str, secret: str):
        self.readywork_url = readywork_url.rstrip("/")
        self.secret = secret

    def deliver_once(
        self,
        item: Path,
        sender: Callable[[str, bytes, dict[str, str]], dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        item = Path(item)
        payload = json.loads(item.read_text(encoding="utf-8"))
        attachment_dir = item.parent / f"{item.stem}.attachments"
        for attachment in payload.get("attachments", []):
            stored_name = str(attachment.pop("storedName", ""))
            frozen = attachment_dir / stored_name
            if not stored_name or frozen.parent != attachment_dir or not frozen.is_file() or frozen.is_symlink():
                raise RuntimeError("spooled attachment is unavailable")
            content = frozen.read_bytes()
            if hashlib.sha256(content).hexdigest() != attachment.get("sha256"):
                raise RuntimeError("spooled attachment fingerprint changed")
            attachment["contentBase64"] = base64.b64encode(content).decode("ascii")
        body = _stable_json(payload).encode("utf-8")
        timestamp = str(int(time.time() * 1000))
        nonce = uuid.uuid4().hex
        path = "/api/integrations/hermes/v1/inbound"
        signing_input = b"\n".join([
            b"POST",
            path.encode("ascii"),
            timestamp.encode("ascii"),
            nonce.encode("ascii"),
            body,
        ])
        headers = {
            "Content-Type": "application/json",
            "X-Readywork-Bridge-Version": BRIDGE_VERSION,
            "X-Readywork-Timestamp": timestamp,
            "X-Readywork-Nonce": nonce,
            "X-Readywork-Signature": hmac.new(
                self.secret.encode("utf-8"), signing_input, hashlib.sha256
            ).hexdigest(),
        }
        send = sender or self._send
        result = send(f"{self.readywork_url}{path}", body, headers)
        if result.get("persisted") is not True:
            raise RuntimeError("Readywork did not confirm durable persistence")
        item.unlink()
        shutil.rmtree(attachment_dir, ignore_errors=True)
        return result

    @staticmethod
    def _send(url: str, body: bytes, headers: dict[str, str]) -> dict[str, Any]:
        request = urllib_request.Request(url, data=body, headers=headers, method="POST")
        with urllib_request.urlopen(request, timeout=15) as response:
            if response.status >= 300:
                raise RuntimeError(f"Readywork HTTP {response.status}")
            parsed = json.loads(response.read().decode("utf-8"))
            if not isinstance(parsed, dict):
                raise RuntimeError("Readywork returned an invalid response")
            return parsed


class DeliveryLedger:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute(
                """CREATE TABLE IF NOT EXISTS deliveries (
                    delivery_id TEXT PRIMARY KEY,
                    request_fingerprint TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('dispatching','completed')),
                    result_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )"""
            )
            db.commit()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path, timeout=10)

    def reserve(self, payload: dict[str, Any]) -> dict[str, Any]:
        delivery_id = str(payload.get("deliveryId") or "").strip()
        if not delivery_id or len(delivery_id) > 200:
            raise ValueError("deliveryId is required")
        fingerprint = hashlib.sha256(_stable_json(payload).encode("utf-8")).hexdigest()
        now = _iso_timestamp(datetime.now(timezone.utc))
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute(
                    "SELECT request_fingerprint,state,result_json FROM deliveries WHERE delivery_id=?",
                    (delivery_id,),
                ).fetchone()
                if row:
                    if row[0] != fingerprint:
                        raise ValueError("deliveryId was reused with a different payload")
                    db.commit()
                    if row[1] == "completed":
                        return {"state": "completed", "result": json.loads(row[2])}
                    return {
                        "state": "unknown_after_dispatch",
                        "result": {
                            "kind": "unknown_after_dispatch",
                            "error": "Hermes Bridge 在外部投递开始后中断，禁止自动重发",
                        },
                    }
                db.execute(
                    """INSERT INTO deliveries
                       (delivery_id,request_fingerprint,state,result_json,created_at,updated_at)
                       VALUES (?,?,'dispatching',NULL,?,?)""",
                    (delivery_id, fingerprint, now, now),
                )
                db.commit()
                return {"state": "reserved", "fingerprint": fingerprint}
            except Exception:
                db.rollback()
                raise

    def complete(self, delivery_id: str, result: dict[str, Any]) -> None:
        with closing(self._connect()) as db:
            db.execute(
                "UPDATE deliveries SET state='completed',result_json=?,updated_at=? WHERE delivery_id=? AND state='dispatching'",
                (_stable_json(result), _iso_timestamp(datetime.now(timezone.utc)), delivery_id),
            )
            db.commit()


def resolve_profile_adapter(gateway_runner: Any, profile: str, platform: str) -> Any | None:
    if not profile or not platform or platform == "readywork_bridge" or gateway_runner is None:
        return None
    profile_adapters = getattr(gateway_runner, "_profile_adapters", {}) or {}
    adapter_map = profile_adapters.get(profile)
    if not isinstance(adapter_map, dict):
        return None
    for key, value in adapter_map.items():
        if str(getattr(key, "value", key)) == platform:
            return value
    return None


async def dispatch_with_adapter(adapter: Any, payload: dict[str, Any]) -> dict[str, Any]:
    attachment_root = str(payload.get("_attachmentRoot") or "")
    successful_ids: list[str] = []

    def record_success(result: Any) -> dict[str, Any] | None:
        message_id = str(getattr(result, "message_id", "") or "").strip()
        if not message_id:
            return {
                "kind": "unknown_after_dispatch",
                "error": "Hermes 官方适配器报告成功但未返回消息标识",
            }
        successful_ids.append(message_id)
        for continuation in getattr(result, "continuation_message_ids", ()) or ():
            normalized = str(continuation or "").strip()
            if normalized:
                successful_ids.append(normalized)
        return None

    def failure_response(result: Any) -> dict[str, Any]:
        error = str(getattr(result, "error", "") or "Hermes 官方适配器拒绝投递")[:1000]
        if successful_ids:
            return {
                "kind": "unknown_after_dispatch",
                "error": f"部分内容已投递，后续附件失败：{error}",
            }
        return {
            "kind": "retryable_before_dispatch" if bool(getattr(result, "retryable", False)) else "failed_before_dispatch",
            "error": error,
            "retryable": bool(getattr(result, "retryable", False)),
            "retryAfter": getattr(result, "retry_after", None),
            "errorKind": getattr(result, "error_kind", None),
        }

    try:
        target = str(payload.get("target") or "")
        reply_to = payload.get("replyTo") or None
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else None
        text = str(payload.get("text") or "")
        attachments = payload.get("attachments") if isinstance(payload.get("attachments"), list) else []
        if not text and not attachments:
            return {
                "kind": "failed_before_dispatch",
                "error": "投递内容不能为空",
            }

        if text:
            result = await adapter.send(
                chat_id=target,
                content=text,
                reply_to=reply_to,
                metadata=metadata,
            )
            if not bool(getattr(result, "success", False)):
                return failure_response(result)
            invalid = record_success(result)
            if invalid:
                return invalid

        for attachment in attachments:
            if not isinstance(attachment, dict) or not attachment.get("path"):
                if successful_ids:
                    return {
                        "kind": "unknown_after_dispatch",
                        "error": "部分内容已投递，但附件描述无效",
                    }
                return {"kind": "failed_before_dispatch", "error": "附件描述无效"}
            result = await adapter.send_document(
                chat_id=target,
                file_path=str(attachment["path"]),
                file_name=str(attachment.get("name") or "") or None,
                reply_to=reply_to,
                metadata=metadata,
            )
            if not bool(getattr(result, "success", False)):
                return failure_response(result)
            invalid = record_success(result)
            if invalid:
                return invalid

        primary = successful_ids[0]
        return {
            "kind": "accepted",
            "providerMessageId": primary,
            "acceptedAt": _iso_timestamp(datetime.now(timezone.utc)),
            "continuationMessageIds": successful_ids[1:],
        }
    except Exception:
        return {
            "kind": "unknown_after_dispatch",
            "error": "Hermes 官方适配器调用异常，外部投递结果未知",
        }
    finally:
        if attachment_root:
            shutil.rmtree(Path(attachment_root), ignore_errors=True)
