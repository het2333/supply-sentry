import asyncio
import unittest

import weixin_onboarding_service
from weixin_onboarding_service import WeixinOnboardingManager


class FakeBackend:
    def __init__(self):
        self.qr_count = 0
        self.poll_result = {"status": "wait"}
        self.persisted = []
        self.configured = []

    async def fetch_qr(self, profile):
        self.qr_count += 1
        return f"qr-secret-{self.qr_count}", f"https://weixin.example/qr/{self.qr_count}"

    async def poll_qr(self, qrcode, base_url):
        return dict(self.poll_result)

    async def persist_account(self, profile, credentials):
        self.persisted.append((profile, dict(credentials)))

    async def configure_and_restart(self, profile, credentials):
        self.configured.append((profile, dict(credentials)))
        return {"restart_started": True, "gateway_connected": True}


class WeixinOnboardingManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.backend = FakeBackend()
        self.manager = WeixinOnboardingManager(self.backend, ttl_seconds=480, max_refreshes=3)
        self.profile = "rw-0123456789abcdef01234567"

    async def test_scanned_credentials_stay_server_side_and_apply_automatically_configures_hermes(self):
        started = await self.manager.start(self.profile)
        self.assertEqual(started["status"], "waiting")
        self.assertEqual(started["qr_payload"], "https://weixin.example/qr/1")
        self.assertNotIn("qr-secret", repr(started))

        self.backend.poll_result = {
            "status": "confirmed",
            "ilink_bot_id": "bot-account-secret",
            "bot_token": "bot-token-secret",
            "baseurl": "https://ilinkai.weixin.qq.com",
            "ilink_user_id": "user-secret",
        }
        ready = await self.manager.status(self.profile, started["pairing_id"])
        self.assertEqual(ready, {
            "pairing_id": started["pairing_id"],
            "status": "ready",
            "qr_payload": "https://weixin.example/qr/1",
            "expires_at": started["expires_at"],
            "account_name": "微信账号",
        })
        self.assertNotIn("bot-token-secret", repr(ready))
        self.assertEqual(len(self.backend.persisted), 0)

        applied = await self.manager.apply(self.profile, started["pairing_id"])
        self.assertEqual(applied["ok"], True)
        self.assertEqual(applied["needs_restart"], False)
        self.assertEqual(len(self.backend.persisted), 1)
        self.assertEqual(len(self.backend.configured), 1)
        self.assertEqual(self.backend.configured[0][1]["token"], "bot-token-secret")
        with self.assertRaises(KeyError):
            await self.manager.status(self.profile, started["pairing_id"])

    async def test_one_live_session_per_profile_and_expired_qr_refresh(self):
        first = await self.manager.start(self.profile)
        second = await self.manager.start(self.profile)
        with self.assertRaises(KeyError):
            await self.manager.status(self.profile, first["pairing_id"])

        self.backend.poll_result = {"status": "expired"}
        refreshed = await self.manager.status(self.profile, second["pairing_id"])
        self.assertEqual(refreshed["status"], "waiting")
        self.assertEqual(refreshed["qr_payload"], "https://weixin.example/qr/3")

    async def test_profile_and_pairing_are_bound_and_cancellable(self):
        started = await self.manager.start(self.profile)
        with self.assertRaises(PermissionError):
            await self.manager.status("rw-aaaaaaaaaaaaaaaaaaaaaaaa", started["pairing_id"])
        self.assertEqual(await self.manager.cancel(self.profile, started["pairing_id"]), {"ok": True})
        with self.assertRaises(KeyError):
            await self.manager.status(self.profile, started["pairing_id"])

    async def test_ilink_long_poll_timeout_means_still_waiting_not_expired(self):
        started = await self.manager.start(self.profile)

        async def timeout_poll(qrcode, base_url):
            raise TimeoutError("iLink long poll timed out")

        self.backend.poll_qr = timeout_poll
        status = await self.manager.status(self.profile, started["pairing_id"])

        self.assertEqual(status["status"], "waiting")
        self.assertEqual(status["pairing_id"], started["pairing_id"])

    async def test_cancel_during_long_poll_prevents_late_credential_persistence(self):
        started = await self.manager.start(self.profile)
        poll_started = asyncio.Event()
        finish_poll = asyncio.Event()

        async def delayed_confirmation(qrcode, base_url):
            poll_started.set()
            await finish_poll.wait()
            return {
                "status": "confirmed",
                "ilink_bot_id": "late-account",
                "bot_token": "late-token",
                "baseurl": "https://ilinkai.weixin.qq.com",
                "ilink_user_id": "late-user",
            }

        self.backend.poll_qr = delayed_confirmation
        status_task = asyncio.create_task(self.manager.status(self.profile, started["pairing_id"]))
        await poll_started.wait()
        cancel_task = asyncio.create_task(self.manager.cancel(self.profile, started["pairing_id"]))
        await asyncio.sleep(0)
        finish_poll.set()

        self.assertEqual(await cancel_task, {"ok": True})
        with self.assertRaises(KeyError):
            await status_task
        self.assertEqual(self.backend.persisted, [])

    async def test_new_start_invalidates_an_older_ready_session(self):
        first = await self.manager.start(self.profile)
        self.backend.poll_result = {
            "status": "confirmed",
            "ilink_bot_id": "first-account",
            "bot_token": "first-token",
            "baseurl": "https://ilinkai.weixin.qq.com",
            "ilink_user_id": "first-user",
        }
        self.assertEqual((await self.manager.status(self.profile, first["pairing_id"]))["status"], "ready")

        second = await self.manager.start(self.profile)

        self.assertNotEqual(second["pairing_id"], first["pairing_id"])
        with self.assertRaises(KeyError):
            await self.manager.status(self.profile, first["pairing_id"])

    async def test_apply_never_reports_success_when_gateway_restart_fails(self):
        started = await self.manager.start(self.profile)
        self.backend.poll_result = {
            "status": "confirmed",
            "ilink_bot_id": "account",
            "bot_token": "token",
            "baseurl": "https://ilinkai.weixin.qq.com",
            "ilink_user_id": "user",
        }
        await self.manager.status(self.profile, started["pairing_id"])

        async def failed_restart(profile, credentials):
            self.backend.configured.append((profile, dict(credentials)))
            return {"restart_started": False}

        self.backend.configure_and_restart = failed_restart
        with self.assertRaisesRegex(RuntimeError, "restart"):
            await self.manager.apply(self.profile, started["pairing_id"])
        self.assertEqual((await self.manager.status(self.profile, started["pairing_id"]))["status"], "ready")

    async def test_apply_never_reports_success_before_gateway_is_connected(self):
        started = await self.manager.start(self.profile)
        self.backend.poll_result = {
            "status": "confirmed",
            "ilink_bot_id": "account",
            "bot_token": "token",
            "baseurl": "https://ilinkai.weixin.qq.com",
            "ilink_user_id": "user",
        }
        await self.manager.status(self.profile, started["pairing_id"])

        async def accepted_but_not_connected(profile, credentials):
            self.backend.configured.append((profile, dict(credentials)))
            return {"restart_started": True, "gateway_connected": False}

        self.backend.configure_and_restart = accepted_but_not_connected
        with self.assertRaisesRegex(RuntimeError, "connect"):
            await self.manager.apply(self.profile, started["pairing_id"])
        self.assertEqual((await self.manager.status(self.profile, started["pairing_id"]))["status"], "ready")


class HermesWeixinBackendTests(unittest.TestCase):
    def test_stopped_gateway_uses_start_instead_of_restart(self):
        selector = getattr(weixin_onboarding_service, "_gateway_lifecycle_action", lambda _status: "restart")

        self.assertEqual(selector({"gateway_running": False, "gateway_state": "stopped"}), "start")

    def test_multiplex_gateway_targets_owner_and_profile_qualified_platform(self):
        planner = getattr(weixin_onboarding_service, "_gateway_lifecycle_plan", lambda _status, profile: {})
        profile = "rw-0123456789abcdef01234567"

        self.assertEqual(planner({"gateway_mode": "multiplex", "gateway_running": True}, profile), {
            "action": "restart",
            "profile": None,
            "platform_key": f"{profile}:weixin",
        })


if __name__ == "__main__":
    unittest.main()
