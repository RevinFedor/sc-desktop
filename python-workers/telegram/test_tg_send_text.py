import asyncio
import datetime
import json
import multiprocessing
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from telethon import errors, functions, types, utils
from telegram_text_outbox import TextOutbox, SendError, payload_hash, digest
from tg_send_text_ndjson import run_request, normalize_request

ACCOUNT = 1033012338
PEER = 2585706


def request(**changes):
    return {"operation": "send", "session": "session_fixture", "target": "@fixture",
            "expected_account_id": str(ACCOUNT), "expected_peer_id": str(PEER),
            "request_id": "fixture-message-1", "text": "привет https://Example.org/AbC ID_X \"Quote\"", "confirm": True, **changes}


class Crash(BaseException):
    pass


class FakeClient:
    def __init__(self):
        self.account = types.User(ACCOUNT, first_name="owner", username="owner")
        self.entity = types.User(PEER, access_hash=123, first_name="fixture", username="fixture")
        self.sent = []
        self.messages = {}
        self.fail_send = None
        self.fail_read = False
        self.gate = None
        self.entered = asyncio.Event()
        self.limit = 4096
        self.resolve_error = False
        self.return_mapping = False
        self.wrong_reply = None

    async def get_me(self):
        return self.account

    async def get_entity(self, _target):
        if self.resolve_error:
            raise ValueError("not found")
        return self.entity

    async def iter_dialogs(self):
        if False:
            yield None

    async def get_messages(self, entity, ids=None, limit=None, min_id=None):
        if ids is not None:
            if self.fail_read:
                raise TimeoutError("readback unavailable")
            return self.messages.get(ids)
        if min_id is not None:
            return [m for m in self.messages.values() if m.id > min_id]
        return [SimpleNamespace(id=100)]

    async def __call__(self, rpc):
        if isinstance(rpc, functions.help.GetConfigRequest):
            return SimpleNamespace(message_length_max=self.limit)
        if not isinstance(rpc, functions.messages.SendMessageRequest):
            raise AssertionError(f"Unexpected RPC: {type(rpc)}")
        self.sent.append(rpc)
        self.entered.set()
        if self.gate:
            await self.gate.wait()
        mid = 101 + len(self.sent)
        # Timeout/crash may happen after Telegram actually accepted the message.
        peer = types.PeerChannel(self.entity.id) if isinstance(self.entity, types.Channel) else types.PeerUser(self.entity.id)
        reply = types.MessageReplyHeader(reply_to_msg_id=rpc.reply_to.reply_to_msg_id,
            reply_to_top_id=rpc.reply_to.top_msg_id, forum_topic=bool(rpc.reply_to.top_msg_id)) if rpc.reply_to else None
        self.messages[mid] = types.Message(id=mid, peer_id=peer, message=rpc.message, reply_to=self.wrong_reply or reply,
                                           out=True, date=datetime.datetime.now(datetime.timezone.utc))
        if self.fail_send:
            raise self.fail_send
        if self.return_mapping:
            return SimpleNamespace(updates=[types.UpdateMessageID(mid, rpc.random_id)])
        return types.UpdateShortSentMessage(mid, 1, 1, datetime.datetime.now(datetime.timezone.utc), out=True)

    async def disconnect(self):
        pass


def reserve_in_process(root, data, queue):
    box = TextOutbox(root)
    try:
        row = box.reserve(normalize_request(data))
        queue.put(row["random_id"])
    finally:
        box.close()


class SendTextTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.client = FakeClient()
        self.connections = 0

    async def call(self, data):
        async def factory(_session):
            self.connections += 1
            return self.client
        return await run_request(data, root=self.root, client_factory=factory)

    def forum_request(self, **changes):
        self.client.entity = types.Channel(3741596629, title="Fixture forum", photo=types.ChatPhotoEmpty(),
            date=datetime.datetime.now(datetime.timezone.utc), megagroup=True, forum=True)
        peer = types.PeerChannel(self.client.entity.id)
        self.client.messages[646] = types.Message(id=646, peer_id=peer, message="Fixture question",
            reply_to=types.MessageReplyHeader(reply_to_msg_id=403, reply_to_top_id=403, forum_topic=True))
        return request(expected_peer_id=str(utils.get_peer_id(peer)), reply_to_message_id=646, topic_id=403, **changes)

    async def test_forum_reply_is_verified_and_repeat_does_not_send(self):
        data = self.forum_request()
        out = await self.call(data)
        self.assertTrue(out["delivered"])
        self.assertEqual(out["reply_to_message_id"], 646)
        self.assertEqual(out["topic_id"], 403)
        self.assertEqual(self.client.sent[0].reply_to.reply_to_msg_id, 646)
        self.assertEqual(self.client.sent[0].reply_to.top_msg_id, 403)
        self.assertEqual(await self.call(data), out)
        self.assertEqual(len(self.client.sent), 1)

    async def test_forum_topic_root_can_be_reply_parent(self):
        data = self.forum_request()
        data["reply_to_message_id"] = 403
        self.client.messages[403] = types.MessageService(id=403, peer_id=types.PeerChannel(3741596629),
            date=datetime.datetime.now(datetime.timezone.utc), action=types.MessageActionTopicCreate("Fixture", 0))
        self.assertTrue((await self.call(data))["delivered"])

    async def test_wrong_parent_peer_or_topic_never_dispatches(self):
        for index, mutation in enumerate(("missing", "peer", "topic", "no-topic")):
            data = self.forum_request(request_id="reply-check-" + str(index))
            if mutation == "missing": self.client.messages.pop(646)
            elif mutation == "peer": self.client.messages[646].peer_id = types.PeerChannel(999)
            elif mutation == "topic": data["topic_id"] = 404
            else: data.pop("topic_id")
            out = await self.call(data)
            self.assertFalse(out["delivered"])
            self.assertEqual(out["state"], "rejected")
        self.assertEqual(self.client.sent, [])

    async def test_readback_reply_mismatch_stays_unknown_and_status_never_resends(self):
        for index, header in enumerate((types.MessageReplyHeader(reply_to_msg_id=647, reply_to_top_id=403, forum_topic=True),
                                      types.MessageReplyHeader(reply_to_msg_id=646, reply_to_top_id=404, forum_topic=True))):
            data = self.forum_request(request_id="readback-reply-" + str(index), text="reply " + str(index))
            self.client.wrong_reply = header
            out = await self.call(data)
            self.assertFalse(out["delivered"])
            self.assertEqual(out["code"], "readback_mismatch")
            count = len(self.client.sent)
            await self.call({"operation": "status", "request_id": data["request_id"]})
            self.assertEqual(len(self.client.sent), count)

    async def test_reply_payload_conflict_and_unknown_fingerprint_include_context(self):
        data = self.forum_request()
        self.client.fail_send = TimeoutError("Lost ACK")
        self.assertEqual((await self.call(data))["state"], "unknown")
        for mutation in ({"reply_to_message_id": 647}, {"topic_id": 404}):
            with self.assertRaises(SendError) as ctx: await self.call({**data, **mutation})
            self.assertEqual(ctx.exception.code, "idempotency_conflict")
        with self.assertRaises(SendError) as ctx: await self.call({**data, "request_id": "new-key"})
        self.assertEqual(ctx.exception.code, "unresolved_previous_send")
        self.client.fail_send = None
        await self.call({"operation": "status", "request_id": data["request_id"]})
        self.assertEqual(len(self.client.sent), 1)

    async def test_reply_concurrency_has_one_rpc(self):
        data = self.forum_request()
        self.client.gate = asyncio.Event()
        first = asyncio.create_task(self.call(data))
        await self.client.entered.wait()
        self.assertEqual((await self.call(data))["state"], "in_progress")
        self.client.gate.set()
        self.assertTrue((await first)["delivered"])
        self.assertEqual(len(self.client.sent), 1)

    async def test_ordinary_hash_remains_identical_and_invalid_reply_rejected_before_connect(self):
        plain = normalize_request(request())
        expected = digest(json.dumps({key: plain[key] for key in (
            "session", "target", "expected_account_id", "expected_peer_id", "text")}, ensure_ascii=False, sort_keys=True))
        self.assertEqual(payload_hash(plain), expected)
        for value in (True, 0, -1, "646", 2147483648, None):
            with self.assertRaises(SendError): await self.call(request(reply_to_message_id=value))
        with self.assertRaises(SendError): await self.call(request(topic_id=403))
        self.assertEqual(self.connections, 0)

    async def test_success_one_raw_rpc_exact_plain_text_and_verified_id(self):
        out = await self.call(request())
        self.assertTrue(out["delivered"])
        self.assertEqual(out["state"], "delivered")
        self.assertEqual(out["peer_id"], str(PEER))
        self.assertEqual(out["message_id"], 102)
        self.assertIsNotNone(out["verified_at"])
        self.assertEqual(len(self.client.sent), 1)
        sent = self.client.sent[0]
        self.assertEqual(sent.message, request()["text"])
        self.assertEqual(sent.entities, [])
        self.assertTrue(sent.no_webpage)
        self.assertFalse(sent.clear_draft)
        self.assertIsNone(sent.schedule_date)
        self.assertIsNone(sent.allow_paid_stars)
        self.assertNotIn(request()["text"], json.dumps(out, ensure_ascii=False))
        db_bytes = (self.root / "telegram-outbox/receipts.sqlite3").read_bytes()
        self.assertNotIn(request()["text"].encode(), db_bytes)

    async def test_resolve_reads_identity_without_send_or_outbox(self):
        out = await self.call({"operation": "resolve", "session": "session_fixture", "target": "https://t.me/Fixture"})
        self.assertEqual(out["account"]["id"], str(ACCOUNT))
        self.assertEqual(out["recipient"]["peer_id"], str(PEER))
        self.assertFalse(out["delivered"])
        self.assertEqual(self.client.sent, [])
        self.assertFalse((self.root / "telegram-outbox").exists())

    async def test_invalid_or_ambiguous_targets_and_session_are_rejected_before_connection(self):
        for target in ("Миша", ["@fixture", "@other"], "@fixture,@other", "https://t.me/+invite", "https://t.me/fixture/123", "", "https://evil.test/fixture"):
            with self.subTest(target=target), self.assertRaises(SendError):
                await self.call(request(target=target))
        for params in ({"session": "../session"}, {"session": ""}, {"confirm": False}, {"recipients": ["@a"]}, {"files": ["/a"]}):
            with self.assertRaises(SendError):
                await self.call(request(**params))
        self.assertEqual(self.connections, 0)
        self.assertEqual(self.client.sent, [])

    async def test_wrong_account_or_changed_username_never_send(self):
        out = await self.call(request(expected_account_id="999"))
        self.assertEqual(out["code"], "account_mismatch")
        self.assertEqual(out["state"], "rejected")
        self.client.entity = types.User(999, first_name="somebody else")
        out = await self.call(request(request_id="other"))
        self.assertEqual(out["code"], "recipient_mismatch")
        self.assertEqual(self.client.sent, [])

    async def test_numeric_peer_type_is_not_guessed_across_user_and_channel(self):
        out = await self.call(request(target="-1000002585706", expected_peer_id="-1000002585706"))
        self.assertEqual(out["code"], "recipient_not_found")
        self.assertEqual(self.client.sent, [])

    async def test_recipient_not_found_is_explicit(self):
        self.client.resolve_error = True
        out = await self.call(request())
        self.assertEqual(out["code"], "recipient_not_found")
        self.assertEqual(self.client.sent, [])

    async def test_long_text_never_splits_and_live_limit_is_respected(self):
        with self.assertRaises(SendError) as ctx:
            await self.call(request(text="🛰" * 4097))
        self.assertEqual(ctx.exception.code, "text_too_long")
        self.assertEqual(self.connections, 0)
        self.client.limit = 100
        out = await self.call(request(text="x" * 101))
        self.assertEqual(out["code"], "text_too_long")
        self.assertEqual(self.client.sent, [])
        self.client.limit = 4096
        out = await self.call(request(request_id="boundary", text="🛰" * 4096))
        self.assertTrue(out["delivered"])
        self.assertEqual(len(self.client.sent), 1)

    async def test_repeat_and_restart_return_receipt_without_connection_or_resend(self):
        first = await self.call(request())
        for _ in range(3):
            repeated = await self.call(request())  # new SQLite connection each call
            self.assertEqual(first, repeated)
        status = await self.call({"operation": "status", "request_id": request()["request_id"]})
        self.assertEqual(first, status)
        self.assertEqual(self.connections, 1)
        self.assertEqual(len(self.client.sent), 1)

    async def test_payload_conflicts_cannot_retarget_or_change_text(self):
        await self.call(request())
        for mutation in ({"text": "new"}, {"target": "@other"}, {"expected_peer_id": "999"}, {"session": "other"}):
            with self.assertRaises(SendError) as ctx:
                await self.call(request(**mutation))
            self.assertEqual(ctx.exception.code, "idempotency_conflict")
        self.assertEqual(len(self.client.sent), 1)

    async def test_concurrent_duplicate_and_new_key_share_one_attempt(self):
        self.client.gate = asyncio.Event()
        first = asyncio.create_task(self.call(request()))
        await self.client.entered.wait()
        duplicate = await self.call(request())
        self.assertEqual(duplicate["state"], "in_progress")
        self.assertFalse(duplicate["delivered"])
        with self.assertRaises(SendError) as ctx:
            await self.call(request(request_id="new-key"))
        self.assertEqual(ctx.exception.code, "unresolved_previous_send")
        self.client.gate.set()
        self.assertTrue((await first)["delivered"])
        self.assertEqual(len(self.client.sent), 1)

    async def test_lost_ack_stays_unknown_even_with_matching_history_and_blocks_new_key(self):
        self.client.fail_send = TimeoutError("lost ACK")
        out = await self.call(request())
        self.assertEqual(out["state"], "unknown")
        self.client.fail_send = None
        repeat = await self.call(request())
        self.assertEqual(repeat["state"], "unknown")
        self.assertEqual(repeat["candidate_message_ids"], [102])
        self.assertFalse(repeat["delivered"])
        with self.assertRaises(SendError) as ctx:
            await self.call(request(request_id="blind-new-id"))
        self.assertEqual(ctx.exception.code, "unresolved_previous_send")
        self.assertEqual(len(self.client.sent), 1)

    async def test_crash_after_dispatch_is_not_replayed(self):
        self.client.fail_send = Crash()
        with self.assertRaises(Crash):
            await self.call(request())
        self.client.fail_send = None
        out = await self.call(request())
        self.assertEqual(out["state"], "unknown")
        self.assertEqual(len(self.client.sent), 1)

    async def test_ack_id_survives_failed_readback_and_recovers_without_send(self):
        self.client.fail_read = True
        self.client.return_mapping = True
        first = await self.call(request())
        self.assertEqual(first["state"], "unknown")
        self.assertEqual(first["message_id"], 102)
        self.client.fail_read = False
        recovered = await self.call({"operation": "status", "request_id": request()["request_id"]})
        self.assertTrue(recovered["delivered"])
        self.assertEqual(len(self.client.sent), 1)

    async def test_readback_wrong_peer_cannot_be_delivered(self):
        self.client.fail_read = True
        await self.call(request())
        self.client.fail_read = False
        self.client.messages[102].peer_id = types.PeerUser(999)
        out = await self.call({"operation": "status", "request_id": request()["request_id"]})
        self.assertFalse(out["delivered"])
        self.assertEqual(out["code"], "readback_mismatch")
        self.assertEqual(len(self.client.sent), 1)

    async def test_flood_wait_and_write_forbidden_are_final_no_retries(self):
        for i, error in enumerate((errors.FloodWaitError(None, 42), errors.ChatWriteForbiddenError(None), errors.PeerFloodError(None))):
            self.client.fail_send = error
            req = request(request_id=f"reject-{i}")
            result = await self.call(req)
            self.assertEqual(result["state"], "rejected")
            self.assertFalse(result["delivered"])
            self.assertEqual(await self.call(req), result)
            if i == 0:
                self.assertEqual(result["retry_after_seconds"], 42)
            if i == 1:
                self.assertEqual(result["code"], "write_forbidden")
        self.assertEqual(len(self.client.sent), 3)

    async def test_status_prepared_cannot_send(self):
        box = TextOutbox(self.root)
        box.reserve(normalize_request(request()))
        box.close()
        out = await self.call({"operation": "status", "request_id": request()["request_id"]})
        self.assertEqual(out["state"], "prepared")
        self.assertEqual(self.connections, 0)
        self.assertEqual(self.client.sent, [])

    def test_concurrent_processes_reserve_same_random_id_durably(self):
        ctx = multiprocessing.get_context("spawn")
        queue = ctx.Queue()
        children = [ctx.Process(target=reserve_in_process, args=(str(self.root), request(), queue)) for _ in range(3)]
        for child in children:
            child.start()
        values = [queue.get(timeout=15) for _ in children]
        for child in children:
            child.join(timeout=15)
            self.assertEqual(child.exitcode, 0)
        self.assertEqual(len(set(values)), 1)
        queue.close()


if __name__ == "__main__":
    unittest.main()
