import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bridge
from bridge import DeliveryLedger, SpoolForwarder, SpoolStore, dispatch_with_adapter


class Value:
    def __init__(self, value):
        self.value = value


class Source:
    platform = Value("telegram")
    chat_id = "chat-001"
    chat_name = "采购群"
    chat_type = "group"
    user_id = "supplier-001"
    user_name = "供应商一"
    thread_id = "thread-001"
    profile = "rw-0123456789abcdef01234567"


class Event:
    text = "订单 P00088 可以按期交付。"
    source = Source()
    message_id = "provider-message-001"
    media_urls = []
    media_types = []
    reply_to_message_id = "provider-message-000"
    raw_message = {"safe": "metadata"}
    timestamp = None


class BridgeTests(unittest.TestCase):
    def test_plugin_registers_predispatch_hook_and_internal_platform(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        import readywork_bridge

        calls = {"hooks": [], "platforms": []}

        class Context:
            def register_hook(self, name, callback):
                calls["hooks"].append((name, callback))

            def register_platform(self, **kwargs):
                calls["platforms"].append(kwargs)

        readywork_bridge.register(Context())
        self.assertEqual(calls["hooks"][0][0], "pre_gateway_dispatch")
        self.assertEqual(calls["platforms"][0]["name"], "readywork_bridge")
        self.assertEqual(calls["platforms"][0]["label"], "Readywork Bridge")

    def test_spool_is_atomic_stable_and_freezes_verified_attachments(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            hermes_home = root / "hermes"
            media = hermes_home / "cache" / "documents" / "quote.pdf"
            media.parent.mkdir(parents=True)
            media.write_bytes(b"real-pdf-bytes")
            event = Event()
            event.media_urls = [str(media)]
            event.media_types = ["application/pdf"]
            store = SpoolStore(root / "spool")

            with patch.dict(os.environ, {"HERMES_HOME": str(hermes_home)}):
                item = store.spool_event(event, Source.profile)
            self.assertTrue(item.exists())
            self.assertEqual(list((root / "spool").glob("*.tmp")), [])
            payload = json.loads(item.read_text(encoding="utf-8"))
            self.assertEqual(payload["profile"], Source.profile)
            self.assertEqual(payload["event"]["platform"], "telegram")
            self.assertEqual(payload["event"]["messageId"], "provider-message-001")
            self.assertEqual(payload["event"]["sender"]["address"], "supplier-001")
            self.assertEqual(payload["attachments"][0]["sha256"], hashlib.sha256(b"real-pdf-bytes").hexdigest())
            self.assertEqual(payload["attachments"][0]["sizeBytes"], len(b"real-pdf-bytes"))
            frozen = item.parent / (item.stem + ".attachments") / payload["attachments"][0]["storedName"]
            self.assertEqual(frozen.read_bytes(), b"real-pdf-bytes")

            with patch.dict(os.environ, {"HERMES_HOME": str(hermes_home)}):
                replay = store.spool_event(event, Source.profile)
            self.assertEqual(replay, item)
            self.assertEqual(len(list((root / "spool").glob("*.json"))), 1)

    def test_spool_rejects_symlinks_and_preserves_item_when_delivery_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "secret.txt"
            target.write_text("secret", encoding="utf-8")
            link = root / "link.txt"
            link.symlink_to(target)
            event = Event()
            event.media_urls = [str(link)]
            event.media_types = ["text/plain"]
            with self.assertRaisesRegex(ValueError, "symbolic link"):
                SpoolStore(root / "spool").spool_event(event, Source.profile)

            event.media_urls = []
            event.media_types = []
            item = SpoolStore(root / "spool").spool_event(event, Source.profile)
            forwarder = SpoolForwarder("http://readywork.invalid", "x" * 32)
            with self.assertRaisesRegex(RuntimeError, "offline"):
                forwarder.deliver_once(item, lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("offline")))
            self.assertTrue(item.exists())

            result = forwarder.deliver_once(item, lambda *_args, **_kwargs: {"persisted": True})
            self.assertTrue(result["persisted"])
            self.assertFalse(item.exists())

    def test_spool_rejects_attachments_outside_the_current_hermes_media_roots(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            hermes_home = root / "hermes"
            allowed = hermes_home / "profiles" / Source.profile / "cache" / "documents"
            allowed.mkdir(parents=True)
            outside = root / "tenant-secret.env"
            outside.write_text("secret", encoding="utf-8")
            event = Event()
            event.media_urls = [str(outside)]
            event.media_types = ["text/plain"]

            with patch.dict(os.environ, {"HERMES_HOME": str(hermes_home)}):
                with self.assertRaisesRegex(ValueError, "media root"):
                    SpoolStore(root / "spool").spool_event(event, Source.profile)

                linked_parent = allowed.parent / "linked"
                linked_parent.symlink_to(root, target_is_directory=True)
                event.media_urls = [str(linked_parent / outside.name)]
                with self.assertRaisesRegex(ValueError, "media root|symbolic link"):
                    SpoolStore(root / "spool").spool_event(event, Source.profile)

    def test_delivery_ledger_prevents_replay_after_dispatching(self):
        with tempfile.TemporaryDirectory() as temp:
            ledger = DeliveryLedger(Path(temp) / "delivery.sqlite")
            body = {"deliveryId": "delivery-001", "platform": "telegram", "target": "chat-001", "text": "hello"}
            first = ledger.reserve(body)
            self.assertEqual(first["state"], "reserved")
            recovered = DeliveryLedger(Path(temp) / "delivery.sqlite").reserve(body)
            self.assertEqual(recovered["state"], "unknown_after_dispatch")
            self.assertEqual(recovered["result"]["kind"], "unknown_after_dispatch")
            with self.assertRaisesRegex(ValueError, "different payload"):
                ledger.reserve({**body, "text": "changed"})

    def test_delivery_ledger_keeps_every_reservation_under_concurrency(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "delivery.sqlite"
            ledger = DeliveryLedger(path)
            workers = 12
            barrier = threading.Barrier(workers)

            def reserve_unique(index):
                barrier.wait()
                return ledger.reserve({
                    "deliveryId": f"delivery-{index:03d}",
                    "profile": "rw-0123456789abcdef01234567",
                    "platform": "telegram",
                    "target": f"chat-{index:03d}",
                    "text": "hello",
                })

            with ThreadPoolExecutor(max_workers=workers) as pool:
                results = list(pool.map(reserve_unique, range(workers)))

            self.assertEqual([result["state"] for result in results], ["reserved"] * workers)
            with closing(sqlite3.connect(path)) as db:
                count = db.execute("SELECT COUNT(*) FROM deliveries").fetchone()[0]
            self.assertEqual(count, workers)

    def test_delivery_ledger_allows_only_one_concurrent_dispatch_for_the_same_id(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "delivery.sqlite"
            ledger = DeliveryLedger(path)
            workers = 12
            barrier = threading.Barrier(workers)
            payload = {
                "deliveryId": "delivery-shared",
                "profile": "rw-0123456789abcdef01234567",
                "platform": "telegram",
                "target": "chat-001",
                "text": "hello",
            }

            def reserve_same(_index):
                barrier.wait()
                return ledger.reserve(payload)

            with ThreadPoolExecutor(max_workers=workers) as pool:
                results = list(pool.map(reserve_same, range(workers)))

            states = [result["state"] for result in results]
            self.assertEqual(states.count("reserved"), 1)
            self.assertEqual(states.count("unknown_after_dispatch"), workers - 1)
            with closing(sqlite3.connect(path)) as db:
                count = db.execute("SELECT COUNT(*) FROM deliveries").fetchone()[0]
            self.assertEqual(count, 1)

    def test_profile_adapter_resolution_cannot_cross_tenant_boundaries(self):
        tenant_a = object()
        tenant_b = object()

        class Runner:
            adapters = {Value("telegram"): tenant_b}
            _profile_adapters = {
                "rw-aaaaaaaaaaaaaaaaaaaaaaaa": {Value("telegram"): tenant_a},
                "rw-bbbbbbbbbbbbbbbbbbbbbbbb": {Value("telegram"): tenant_b},
            }

        resolve = getattr(bridge, "resolve_profile_adapter", lambda *_args: None)
        self.assertIs(
            resolve(Runner(), "rw-aaaaaaaaaaaaaaaaaaaaaaaa", "telegram"),
            tenant_a,
        )
        self.assertIsNone(
            resolve(Runner(), "rw-cccccccccccccccccccccccc", "telegram"),
        )

    def test_dispatch_returns_real_send_result_fields(self):
        class Result:
            success = True
            message_id = "provider-777"
            error = None
            retryable = False
            retry_after = None
            continuation_message_ids = ("provider-775", "provider-776")
            error_kind = None

        class Adapter:
            async def send(self, chat_id, content, reply_to=None, metadata=None):
                self.call = (chat_id, content, reply_to, metadata)
                return Result()

        adapter = Adapter()
        result = asyncio.run(dispatch_with_adapter(adapter, {
            "target": "chat-001",
            "text": "approved",
            "replyTo": "provider-001",
            "metadata": {"thread_id": "thread-001"},
            "attachments": [],
        }))
        self.assertEqual(result["kind"], "accepted")
        self.assertEqual(result["providerMessageId"], "provider-777")
        self.assertEqual(result["continuationMessageIds"], ["provider-775", "provider-776"])
        self.assertEqual(adapter.call, ("chat-001", "approved", "provider-001", {"thread_id": "thread-001"}))

    def test_dispatch_sends_text_then_documents_and_merges_provider_ids(self):
        class Result:
            def __init__(self, message_id, continuations=()):
                self.success = True
                self.message_id = message_id
                self.error = None
                self.retryable = False
                self.retry_after = None
                self.continuation_message_ids = continuations
                self.error_kind = None

        class Adapter:
            def __init__(self):
                self.calls = []

            async def send(self, **kwargs):
                self.calls.append(("text", kwargs))
                return Result("text-001", ("text-002",))

            async def send_document(self, **kwargs):
                self.calls.append(("document", kwargs))
                return Result("file-001", ("file-002",))

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "frozen"
            root.mkdir()
            document = root / "quote.pdf"
            document.write_bytes(b"pdf")
            adapter = Adapter()
            result = asyncio.run(dispatch_with_adapter(adapter, {
                "target": "chat-001",
                "text": "approved",
                "replyTo": "provider-001",
                "metadata": {"thread_id": "thread-001"},
                "attachments": [{"path": str(document), "name": "报价.pdf"}],
                "_attachmentRoot": str(root),
            }))

            self.assertEqual([call[0] for call in adapter.calls], ["text", "document"])
            self.assertEqual(adapter.calls[1][1]["file_name"], "报价.pdf")
            self.assertEqual(adapter.calls[1][1]["reply_to"], "provider-001")
            self.assertEqual(result["kind"], "accepted")
            self.assertEqual(result["providerMessageId"], "text-001")
            self.assertEqual(
                result["continuationMessageIds"],
                ["text-002", "file-001", "file-002"],
            )
            self.assertFalse(root.exists())

    def test_dispatch_marks_attachment_failure_after_text_as_unknown(self):
        class Result:
            continuation_message_ids = ()
            retry_after = None
            error_kind = None

            def __init__(self, success, message_id="", error=None, retryable=False):
                self.success = success
                self.message_id = message_id
                self.error = error
                self.retryable = retryable

        class Adapter:
            async def send(self, **_kwargs):
                return Result(True, "text-001")

            async def send_document(self, **_kwargs):
                return Result(False, error="upload rejected", retryable=True)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "frozen"
            root.mkdir()
            document = root / "quote.pdf"
            document.write_bytes(b"pdf")
            result = asyncio.run(dispatch_with_adapter(Adapter(), {
                "target": "chat-001",
                "text": "approved",
                "attachments": [{"path": str(document), "name": "quote.pdf"}],
                "_attachmentRoot": str(root),
            }))

            self.assertEqual(result["kind"], "unknown_after_dispatch")
            self.assertIn("部分内容已投递", result["error"])
            self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
