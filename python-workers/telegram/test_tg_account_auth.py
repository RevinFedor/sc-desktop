"""Auth doubles only. No Telegram, real credentials, or user session files."""
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from tg_account_auth import (AccountAuthError, inspect_session, inventory, interactive_login,
                             public_profile, reserve_session, hidden_input, visible_input)

PhoneCodeInvalidError = type("PhoneCodeInvalidError", (Exception,), {})
PhoneCodeExpiredError = type("PhoneCodeExpiredError", (Exception,), {})
SessionPasswordNeededError = type("SessionPasswordNeededError", (Exception,), {})
PasswordHashInvalidError = type("PasswordHashInvalidError", (Exception,), {})
PHONE, CODE, PASSWORD, HASH = "+19999990001", "secret-code", "secret-password", "secret-hash"


class Client:
    def __init__(self, *, authorized=False, account=300, signin=None, connect_error=None, stall=False):
        self.authorized, self.account, self.signins = authorized, account, list(signin or [])
        self.connect_error, self.stall = connect_error, stall
        self.calls = []
        self.session = SimpleNamespace(_conn=None)

    async def connect(self):
        self.calls.append("connect")
        if self.stall: await asyncio.Event().wait()
        if self.connect_error: raise self.connect_error

    async def disconnect(self): self.calls.append("disconnect")
    async def is_user_authorized(self): return self.authorized
    async def get_me(self):
        self.calls.append("get_me")
        return SimpleNamespace(id=self.account, first_name="Менеджер", last_name="FlowTab", username="fixture_support", phone=PHONE) if self.authorized else None

    async def send_code_request(self, _phone):
        self.calls.append("send_code")
        return SimpleNamespace(phone_code_hash=HASH)

    async def sign_in(self, **kwargs):
        self.calls.append("password" if "password" in kwargs else "code")
        if self.signins:
            result = self.signins.pop(0)
            if result: raise result
        self.authorized = True


class AuthTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sc-account-auth-fixture-")
        self.root = Path(self.tmp.name)
        self.meta, self.messages = {}, []
        self.old = self.root / "old"
        self.new = self.root / "new"
        self.old.mkdir(); self.new.mkdir()
        for name in ("first", "second"):
            (self.old / (name + ".session")).write_bytes(("existing:" + name).encode())
        self.settings = self.root / "settings.json"
        self.settings.write_text('{"telegram":{"session":"first"},"unrelated":true}')

    def tearDown(self): self.tmp.cleanup()
    def read(self, path): return self.meta.get(str(path))
    def write(self, path, me): self.meta[str(path)] = {**(self.meta.get(str(path)) or {}), **me}
    def reader(self, values):
        values = iter(values)
        def read(_prompt):
            value = next(values)
            if isinstance(value, BaseException): raise value
            return value
        return read

    async def login(self, client, values=(PHONE, CODE), **kwargs):
        reader = self.reader(values)
        return await interactive_login(directory=self.new, directories=[self.old, self.new], factory=lambda _path: client,
            read_meta=self.read, write_meta=self.write, label="Менеджер FlowTab", input_reader=reader, secret_reader=reader,
            confirm=lambda _prompt: True, say=self.messages.append, **kwargs)

    def unchanged(self):
        self.assertEqual((self.old / "first.session").read_bytes(), b"existing:first")
        self.assertEqual((self.old / "second.session").read_bytes(), b"existing:second")
        self.assertEqual(json.loads(self.settings.read_text())["telegram"]["session"], "first")
        self.assertTrue(json.loads(self.settings.read_text())["unrelated"])

    async def test_new_third_account_phone_code_getme_and_alias_without_touching_old_or_active(self):
        client = Client()
        result = await self.login(client)
        self.assertTrue(result["authorized"]); self.assertFalse(result["reused"])
        self.assertEqual(result["account_id"], 300); self.assertFalse(result["active_changed"])
        self.assertEqual(self.read(self.new / (result["session_name"] + ".session"))["label"], "Менеджер FlowTab")
        self.assertEqual(client.calls.count("send_code"), 1); self.assertIn("get_me", client.calls)
        self.unchanged()

    async def test_optional_2fa_flow(self):
        client = Client(signin=[SessionPasswordNeededError(), None])
        result = await self.login(client, (PHONE, CODE, PASSWORD))
        self.assertTrue(result["authorized"]); self.assertEqual(client.calls.count("password"), 1)
        self.unchanged()

    async def test_default_login_echoes_phone_and_code_but_masks_2fa(self):
        client = Client(signin=[SessionPasswordNeededError(), None])
        with patch("tg_account_auth.sys.stdin.isatty", return_value=True), \
             patch("tg_account_auth.sys.stderr.isatty", return_value=True), \
             patch("builtins.input", side_effect=[PHONE, CODE]) as visible, \
             patch("tg_account_auth.getpass.getpass", return_value=PASSWORD) as hidden:
            result = await interactive_login(directory=self.new, directories=[self.old, self.new],
                factory=lambda _path: client, read_meta=self.read, write_meta=self.write,
                confirm=lambda _prompt: True, say=self.messages.append)
        self.assertTrue(result["authorized"])
        self.assertEqual(visible.call_count, 2)
        self.assertTrue(visible.call_args_list[0].args[0].startswith("Телефон"))
        self.assertEqual(visible.call_args_list[1].args[0], "Telegram-код: ")
        hidden.assert_called_once_with("2FA-пароль (ввод скрыт): ")
        self.unchanged()

    async def test_invalid_code_then_valid_same_code_request(self):
        client = Client(signin=[PhoneCodeInvalidError(PHONE + CODE), None])
        await self.login(client, (PHONE, "invalid", CODE))
        self.assertEqual(client.calls.count("send_code"), 1)
        self.assertEqual(client.calls.count("code"), 2)

    async def test_invalid_password_then_valid_same_attempt(self):
        client = Client(signin=[SessionPasswordNeededError(), PasswordHashInvalidError(PASSWORD), None])
        await self.login(client, (PHONE, CODE, "wrong", PASSWORD))
        self.assertEqual(client.calls.count("send_code"), 1)
        self.assertEqual(client.calls.count("password"), 2)

    async def test_expired_code_no_automatic_resend_new_session_removed(self):
        with self.assertRaises(AccountAuthError) as error:
            await self.login(Client(signin=[PhoneCodeExpiredError()]))
        self.assertEqual(error.exception.code, "code_expired")
        self.assertEqual(list(self.new.glob("*.session")), [])
        self.unchanged()

    async def test_cancel_while_waiting_code_cleans_only_owned_unauthed_session(self):
        with self.assertRaises(AccountAuthError) as error:
            await self.login(Client(), (PHONE, KeyboardInterrupt()))
        self.assertEqual(error.exception.code, "login_cancelled")
        self.assertEqual(list(self.new.glob("*.session")), [])
        self.unchanged()

    async def test_network_failure_never_leaks_secret_exception_or_claims_missing(self):
        with self.assertRaises(AccountAuthError) as error:
            await self.login(Client(connect_error=OSError(PHONE + CODE + PASSWORD)))
        self.assertEqual(error.exception.code, "login_network_error")
        self.assertNotIn(PHONE, str(error.exception)); self.assertNotIn(PASSWORD, str(error.exception))
        self.unchanged()

    async def test_network_deadline_is_bounded_and_not_absence(self):
        with self.assertRaises(AccountAuthError) as error:
            await self.login(Client(stall=True), timeout=0.01)
        self.assertEqual(error.exception.code, "login_network_timeout")
        self.unchanged()

    async def test_lost_signin_ack_keeps_original_session_and_reports_unknown_no_retry(self):
        client = Client(signin=[ConnectionError(PHONE + CODE + HASH)])
        with self.assertRaises(AccountAuthError) as error:
            await self.login(client)
        self.assertEqual(error.exception.outcome, "unknown")
        self.assertTrue(error.exception.session_name)
        self.assertEqual(len(list(self.new.glob("*.session"))), 1)
        self.assertEqual(client.calls.count("send_code"), 1); self.assertEqual(client.calls.count("code"), 1)
        self.unchanged()

    async def test_existing_authorized_account_reused_after_live_getme_without_another_code(self):
        old = self.old / "first.session"
        self.write(old, {"phone": PHONE, "id": 300})
        client = Client(authorized=True)
        result = await self.login(client, (PHONE,))
        self.assertTrue(result["reused"]); self.assertEqual(result["session_name"], "first")
        self.assertNotIn("send_code", client.calls); self.assertIn("get_me", client.calls)
        self.assertEqual(list(self.new.glob("*.session")), [])
        self.unchanged()

    async def test_existing_unknown_network_account_not_replaced_or_given_new_code(self):
        self.write(self.old / "first.session", {"phone": PHONE, "id": 300})
        client = Client(connect_error=OSError(PHONE))
        with self.assertRaises(AccountAuthError) as error: await self.login(client, (PHONE,))
        self.assertEqual(error.exception.outcome, "unknown")
        self.assertNotIn("send_code", client.calls); self.assertEqual(list(self.new.glob("*.session")), [])
        self.unchanged()

    async def test_wrong_expected_account_never_gets_requested_alias_or_overwrites_old(self):
        with self.assertRaises(AccountAuthError) as error:
            await self.login(Client(), expected_account_id=999)
        self.assertEqual(error.exception.code, "account_id_mismatch")
        self.assertTrue(error.exception.session_name)
        self.assertFalse(any(me.get("label") for me in self.meta.values()))
        self.unchanged()

    async def test_following_account_uses_new_uuid_and_does_not_overwrite_third(self):
        a = await self.login(Client(account=300))
        b = await self.login(Client(account=400))
        self.assertNotEqual(a["session_name"], b["session_name"])
        self.assertEqual(len(list(self.new.glob("*.session"))), 2)
        self.unchanged()

    async def test_stdout_and_public_result_do_not_contain_phone_code_password_or_hash(self):
        result = await self.login(Client(signin=[SessionPasswordNeededError(), None]), (PHONE, CODE, PASSWORD))
        public = json.dumps(result, ensure_ascii=False) + " ".join(self.messages)
        for secret in (PHONE, CODE, PASSWORD, HASH): self.assertNotIn(secret, public)

    async def test_inventory_network_timeout_unknown_not_false_and_cached_is_advisory(self):
        path = self.old / "first.session"
        self.write(path, {"id": 300, "phone": PHONE, "label": "Менеджер FlowTab"})
        row = await inspect_session(path, lambda _path: Client(stall=True), self.read, self.write, timeout=0.01, redact=True)
        self.assertIsNone(row["authorized"]); self.assertEqual(row["authorization_state"], "unknown")
        self.assertEqual(row["error_code"], "session_inventory_timeout"); self.assertIsNone(row["me"])
        self.assertNotIn(PHONE, json.dumps(row)); self.assertEqual(row["me_cached"]["id"], 300)

    async def test_inventory_proves_live_and_unauthorized_separately(self):
        a = await inspect_session(self.old / "first.session", lambda _path: Client(authorized=True), self.read, self.write, redact=True)
        b = await inspect_session(self.old / "second.session", lambda _path: Client(), self.read, self.write, redact=True)
        self.assertTrue(a["authorized"]); self.assertTrue(a["verified_at"]); self.assertEqual(a["me"]["id"], 300)
        self.assertIs(b["authorized"], False); self.assertEqual(b["authorization_state"], "unauthorized")

    async def test_inventory_overall_ceiling_preserves_all_unknown_rows(self):
        events = []
        await inventory(list(self.old.glob("*.session")), lambda _path: Client(stall=True), self.read, self.write,
                        events.append, total_timeout=0.01, redact=True)
        self.assertEqual(len([e for e in events if e["type"] == "session"]), 2)
        self.assertTrue(events[-1]["enumeration_complete"]); self.assertFalse(events[-1]["verification_complete"])
        self.assertEqual(events[-1]["unknown_count"], 2)

    async def test_changed_live_identity_does_not_inherit_stale_label(self):
        path = self.old / "first.session"
        self.write(path, {"id": 300, "label": "support"})
        row = await inspect_session(path, lambda _path: Client(authorized=True, account=400), self.read, self.write)
        self.assertIsNone(row["label"]); self.assertEqual(row["me"]["id"], 400)

    def test_no_tty_never_reads_a_secret(self):
        with patch("tg_account_auth.sys.stdin.isatty", return_value=False), patch("tg_account_auth.getpass.getpass") as reader:
            with self.assertRaises(AccountAuthError): hidden_input("phone")
        reader.assert_not_called()

    def test_no_tty_never_reads_visible_input(self):
        with patch("tg_account_auth.sys.stdin.isatty", return_value=False), patch("builtins.input") as reader:
            with self.assertRaises(AccountAuthError): visible_input("phone")
        reader.assert_not_called()

    def test_new_session_filename_contains_no_phone_and_reservation_never_overwrites(self):
        path = reserve_session(self.new)
        self.assertRegex(path.name, r"^session_[0-9a-f]{32}\.session$")
        self.assertNotIn(PHONE, path.name)
        self.unchanged()

    def test_phone_redaction(self):
        self.assertNotIn("phone", public_profile({"id": 300, "phone": PHONE}))


if __name__ == "__main__": unittest.main()
