import asyncio
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from telethon import types, functions, errors
from tg_bot_contract import keyboard_original
from tg_bot_join import run_bot_join, JoinOutbox

ACCOUNT, BOT = 1033012338, 935519651
TITLE = "Клуб АйТи Красавчиков"
URL = "https://t.me/+fixture_only_join"

class Crash(BaseException):
    pass

class Fake:
    def __init__(self):
        self.account = ACCOUNT
        self.bot = types.User(BOT, access_hash=123, first_name="Boosty", username="boosty_to_bot", bot=True)
        self.group = types.Channel(3928484154, TITLE, types.ChatPhotoEmpty(), None, access_hash=42, megagroup=True, left=True)
        self.message = types.Message(273965, types.PeerUser(BOT), from_id=types.PeerUser(BOT), date=datetime.now(timezone.utc),
            message="groups", reply_markup=types.ReplyInlineMarkup([types.KeyboardButtonRow([types.KeyboardButtonUrl("АйТи Красавчики: Клуб", URL)])]))
        self.member = False
        self.calls = []
        self.failure = None
        self.apply = True
        self.payment = False
        self.block_readback = False
    async def get_me(self):
        return types.User(self.account, first_name="Owner")
    async def get_entity(self, target):
        return self.bot if target == "boosty_to_bot" or target == "@boosty_to_bot" or str(target) == str(BOT) else self.group
    async def get_input_entity(self, target):
        return types.InputPeerChannel(self.group.id, 42)
    async def get_messages(self, peer, ids):
        return [self.message] if isinstance(ids, list) else self.message
    async def __call__(self, rpc):
        self.calls.append(type(rpc).__name__)
        if isinstance(rpc, functions.messages.CheckChatInviteRequest):
            if self.block_readback:
                raise TimeoutError()
            if self.member:
                self.group.left = False
                return types.ChatInviteAlready(self.group)
            return types.ChatInvite(self.group.title, types.PhotoEmpty(0), 9, 0, megagroup=True, request_needed=True,
                subscription_pricing=types.StarsSubscriptionPricing(30, 10) if self.payment else None)
        if isinstance(rpc, (functions.messages.ImportChatInviteRequest, functions.channels.JoinChannelRequest)):
            if self.apply:
                self.member = True
            if self.failure:
                if not isinstance(self.failure, errors.InviteRequestSentError):
                    self.block_readback = True
                raise self.failure
            return SimpleNamespace(chats=[self.group])
        raise AssertionError(type(rpc).__name__)


def request(client, key="join-1", **change):
    return {"operation": "bot_join", "session": "session_4531193", "expected_account_id": str(ACCOUNT), "bot": "@boosty_to_bot",
        "expected_peer_id": str(BOT), "request_id": key, "confirm": True, "purpose": "join_itkras",
        "message_id": 273965, "row": 0, "column": 0, "expected_binding_hash": keyboard_original(client.message)["binding_hash"],
        "expected_action_label": "АйТи Красавчики: Клуб", "expected_chat_title": TITLE, **change}


def status(**change):
    return {"operation": "bot_join_status", "session": "session_4531193", "expected_account_id": str(ACCOUNT), "bot": "@boosty_to_bot", "expected_peer_id": str(BOT), "request_id": "join-1", **change}


class JoinTests(unittest.IsolatedAsyncioTestCase):
    async def test_flood_denial_waits_and_same_intent_resumes_without_unknown_replay(self):
        client = Fake(); client.failure = errors.FloodWaitError(None, capture=137); client.apply = False
        with tempfile.TemporaryDirectory() as root:
            intent = request(client)
            out = await run_bot_join(client, intent, root)
            self.assertEqual(out["state"], "prepared")
            self.assertEqual(out["code"], "telegram_flood_wait")
            self.assertGreaterEqual(out["retry_after_seconds"], 136)
            self.assertFalse(out["outcome_unknown"])
            await run_bot_join(client, intent, root)
            await run_bot_join(client, status(), root)
            self.assertEqual(client.calls.count("ImportChatInviteRequest"), 1)
            client.failure = None; client.apply = True; client.block_readback = False
            with patch("tg_bot_join.time.time", return_value=out["retry_not_before"] + 1):
                after = await run_bot_join(client, intent, root)
            self.assertTrue(after["joined"])
        self.assertEqual(client.calls.count("ImportChatInviteRequest"), 2)

    async def test_real_atk_label_and_title_remain_bound_not_generic_alias(self):
        client = Fake(); client.group.title = "АТК: Красавы"
        client.message.reply_markup.rows[0].buttons[0].text = client.group.title
        with tempfile.TemporaryDirectory() as root:
            out = await run_bot_join(client, request(client, expected_action_label=client.group.title,
                expected_chat_title=client.group.title), root)
        self.assertTrue(out["joined"])

    async def test_bound_url_join_fresh_membership_and_exact_retry_no_duplicate(self):
        client = Fake(); events = []
        with tempfile.TemporaryDirectory() as root:
            intent = request(client)
            out = await run_bot_join(client, intent, root, events.append)
            retry = await run_bot_join(client, intent, root)
        self.assertTrue(out["joined"]); self.assertTrue(out["ready_for_fetch"])
        self.assertEqual(out["chat"]["id"], 3928484154)
        self.assertEqual(retry["state"], "joined")
        self.assertEqual(client.calls.count("ImportChatInviteRequest"), 1)
        self.assertEqual(events[0]["stage"], "updating_membership")
        self.assertFalse(out["admin_approval_claimed"])

    async def test_already_member_insider_no_rejoin(self):
        client = Fake(); client.member = True
        with tempfile.TemporaryDirectory() as root:
            out = await run_bot_join(client, request(client), root)
        self.assertEqual(out["state"], "already_member")
        self.assertTrue(out["ready_for_fetch"])
        self.assertNotIn("ImportChatInviteRequest", client.calls)

    async def test_pending_request_not_member_or_fetch_and_only_readback_status(self):
        client = Fake(); client.failure = errors.InviteRequestSentError(None); client.apply = False
        with tempfile.TemporaryDirectory() as root:
            out = await run_bot_join(client, request(client), root)
            self.assertEqual(out["state"], "request_sent")
            self.assertFalse(out["joined"]); self.assertFalse(out["ready_for_fetch"])
            with self.assertRaises(Exception):
                await run_bot_join(client, request(client, "new-key"), root)
            client.member = True
            after = await run_bot_join(client, status(), root)
            self.assertTrue(after["joined"])
        self.assertEqual(client.calls.count("ImportChatInviteRequest"), 1)

    async def test_unknown_lost_ack_readback_recovery_without_repeat(self):
        client = Fake(); client.failure = TimeoutError()
        with tempfile.TemporaryDirectory() as root:
            intent = request(client)
            out = await run_bot_join(client, intent, root)
            self.assertEqual(out["state"], "unknown"); self.assertFalse(out["ready_for_fetch"])
            client.block_readback = False
            # Same private invite in a different bot page/alias/new key remains fenced.
            client.message.reply_markup.rows[0].buttons[0].url = URL.replace("/+", "/joinchat/")
            with self.assertRaises(Exception):
                await run_bot_join(client, request(client, "join-new-key"), root)
            result = await run_bot_join(client, status(), root)
            self.assertEqual(result["state"], "joined")
        self.assertEqual(client.calls.count("ImportChatInviteRequest"), 1)

    async def test_rpc_ack_without_member_is_unknown_not_fake_join_or_pending(self):
        client = Fake(); client.apply = False
        with tempfile.TemporaryDirectory() as root:
            out = await run_bot_join(client, request(client), root)
            self.assertEqual(out["state"], "unknown"); self.assertFalse(out["request_sent"])
            self.assertFalse(out["ready_for_fetch"])
        self.assertEqual(client.calls.count("ImportChatInviteRequest"), 1)

    async def test_crash_dispatching_receipt_and_status_identity_guard(self):
        client = Fake(); client.failure = Crash()
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(Crash):
                await run_bot_join(client, request(client), root)
            with self.assertRaises(Exception):
                await run_bot_join(client, status(expected_account_id="7309115053"), root)
            client.block_readback = False
            out = await run_bot_join(client, status(), root)
            self.assertTrue(out["joined"])
        self.assertEqual(client.calls.count("ImportChatInviteRequest"), 1)

    async def test_om_payment_wrong_account_message_label_or_title_never_mutate(self):
        cases = []
        om = Fake(); om.message.reply_markup.rows[0].buttons[0].text = "ОМ Красавчики"; cases.append((om, {}))
        paid = Fake(); paid.payment = True; cases.append((paid, {}))
        wrong = Fake(); wrong.account = 7309115053; cases.append((wrong, {}))
        title = Fake(); title.group.title = "ОМ"; cases.append((title, {}))
        label = Fake(); cases.append((label, {"expected_action_label": "wrong"}))
        changed = Fake(); cases.append((changed, {"expected_binding_hash": "a" * 64}))
        callback = Fake(); callback.message.reply_markup.rows[0].buttons[0] = types.KeyboardButtonCallback("АйТи Красавчики", URL.encode()); cases.append((callback, {}))
        for client, change in cases:
            with tempfile.TemporaryDirectory() as root:
                with self.assertRaises(Exception):
                    await run_bot_join(client, request(client, **change), root)
            self.assertNotIn("ImportChatInviteRequest", client.calls)

    async def test_public_url_join_and_changed_original_intent(self):
        client = Fake(); client.message.reply_markup.rows[0].buttons[0].url = "https://t.me/itkras_fixture"
        # Current public entity is refreshed by get_entity after JoinChannel.
        original_get = client.get_entity
        async def get_entity(target):
            entity = await original_get(target)
            if entity is client.group:
                entity.left = not client.member
            return entity
        client.get_entity = get_entity
        with tempfile.TemporaryDirectory() as root:
            out = await run_bot_join(client, request(client), root)
            self.assertTrue(out["joined"])
            with self.assertRaises(Exception):
                await run_bot_join(client, request(client, expected_chat_title="other"), root)
        self.assertEqual(client.calls.count("JoinChannelRequest"), 1)


if __name__ == "__main__":
    unittest.main()
