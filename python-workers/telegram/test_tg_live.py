import unittest
import hashlib
import asyncio
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent))

import tg_live_ndjson
from tg_live_ndjson import parse_membership_target, parse_message_url, telegram_error_payload


class TelegramLiveUrlTests(unittest.TestCase):
    def test_private_chat_and_forum_urls(self):
        plain = parse_message_url("https://t.me/c/2719624138/5299")
        self.assertEqual(plain["chat"], "2719624138")
        self.assertEqual(plain["message_id"], 5299)
        self.assertIsNone(plain["topic_id"])

        forum = parse_message_url("https://t.me/c/1769090887/22875/45751?single")
        self.assertEqual(forum["chat_key"], "c:1769090887")
        self.assertEqual(forum["topic_id"], 22875)
        self.assertEqual(forum["message_id"], 45751)

    def test_public_url(self):
        parsed = parse_message_url("https://t.me/neuraldeepchat/123")
        self.assertEqual(parsed["chat"], "neuraldeepchat")
        self.assertEqual(parsed["chat_key"], "u:neuraldeepchat")
        self.assertEqual(parsed["message_id"], 123)

    def test_rejects_non_message_urls(self):
        self.assertIsNone(parse_message_url("https://example.com/c/1/2"))
        self.assertIsNone(parse_message_url("https://t.me/neuraldeepchat"))

    def test_membership_targets_distinguish_public_and_invite_links(self):
        self.assertEqual(
            parse_membership_target("@PhuketRentals")["username"],
            "PhuketRentals",
        )
        self.assertEqual(
            parse_membership_target("t.me/s/PhuketRentals/123")["username"],
            "PhuketRentals",
        )
        self.assertEqual(
            parse_membership_target("https://t.me/+AbCdEf_123")["invite_hash"],
            "AbCdEf_123",
        )
        self.assertEqual(
            parse_membership_target("https://t.me/joinchat/XyZ-987")["invite_hash"],
            "XyZ-987",
        )
        with self.assertRaisesRegex(ValueError, "do not contain an invite hash"):
            parse_membership_target("https://t.me/c/123456/789")

    def test_flood_wait_has_machine_code_and_retry_seconds(self):
        failure = telegram_error_payload(
            tg_live_ndjson.errors.FloodWaitError(request=None, capture=47)
        )
        self.assertEqual(failure["code"], "telegram_flood_wait")
        self.assertEqual(failure["retry_after_seconds"], 47)
        self.assertIn("47", failure["message"])


class TelegramLiveReplyPeerTests(unittest.IsolatedAsyncioTestCase):
    def message(self, ident, reply=None, peer_id=111):
        return tg_live_ndjson.types.Message(
            id=ident, peer_id=tg_live_ndjson.types.PeerChannel(peer_id),
            message=f"fixture message {ident}",
            date=datetime(2026, 10, 7, tzinfo=timezone.utc), reply_to=reply,
        )

    async def test_cross_peer_ancestor_is_not_fetched_as_current_peer_id(self):
        hit = self.message(100, tg_live_ndjson.types.MessageReplyHeader(reply_to_msg_id=99, reply_to_peer_id=tg_live_ndjson.types.PeerChannel(222)))
        client = SimpleNamespace(get_messages=mock.AsyncMock())
        ancestors = await tg_live_ndjson.ancestor_chain(client, SimpleNamespace(id=111), hit, 10)
        self.assertEqual(ancestors, [])
        client.get_messages.assert_not_awaited()

    async def test_context_root_and_formatter_preserve_external_reference_without_false_local_lookup(self):
        hit = self.message(100, tg_live_ndjson.types.MessageReplyHeader(reply_to_msg_id=99, reply_to_top_id=99, reply_to_peer_id=tg_live_ndjson.types.PeerChannel(222), quote_text="remote quote", quote_offset=4))
        entity = SimpleNamespace(id=111, title="fixture", username="fixture_chat", forum=False)
        class Client:
            def __init__(self): self.ids = []; self.reply_roots = []
            async def get_me(self): return SimpleNamespace(id=123)
            async def get_messages(self, requested_entity, ids):
                self.ids.append((requested_entity.id, ids))
                if requested_entity.id != 111 or ids != 100:
                    raise AssertionError("foreign #99 must not be looked up in current chat")
                return hit
            async def iter_messages(self, requested_entity, reply_to, limit):
                self.reply_roots.append((requested_entity.id, reply_to))
                if False: yield None
        client = Client()
        with mock.patch.object(tg_live_ndjson, "resolve_entity", new=mock.AsyncMock(return_value=entity)), mock.patch.object(tg_live_ndjson, "emit"):
            result = await tg_live_ndjson.run_context(client, {"chat": "111", "message_id": 100, "before": 0, "after": 0, "max_depth": 10, "max_replies": 10})
        self.assertEqual(client.ids, [(111, 100)])
        self.assertEqual(client.reply_roots, [(111, 100)])
        self.assertEqual(result["ancestors"], [])
        self.assertEqual(result["root"]["message_id"], 100)
        self.assertIsNone(result["hit"]["reply_to_message_id"])
        self.assertEqual(result["hit"]["telegram_reply"]["scope"], "external_peer")
        self.assertEqual(result["hit"]["external_reply"]["peer"], {"id": 222, "kind": "channel"})
        self.assertEqual(result["hit"]["external_reply"]["message_id"], 99)

    async def test_local_explicit_and_implicit_replies_still_resolve_and_cycles_are_bounded(self):
        for explicit_peer in (None, tg_live_ndjson.types.PeerChannel(111)):
            hit = self.message(100, tg_live_ndjson.types.MessageReplyHeader(reply_to_msg_id=99, reply_to_peer_id=explicit_peer))
            parent = self.message(99, tg_live_ndjson.types.MessageReplyHeader(reply_to_msg_id=100))
            client = SimpleNamespace(get_messages=mock.AsyncMock(return_value=parent))
            ancestors = await tg_live_ndjson.ancestor_chain(client, SimpleNamespace(id=111), hit, 10)
            self.assertEqual([row.id for row in ancestors], [99])
            client.get_messages.assert_awaited_once()

    async def test_topic_anchor_remains_local_root_metadata_not_an_actual_reply(self):
        hit = self.message(100, tg_live_ndjson.types.MessageReplyHeader(reply_to_msg_id=77, reply_to_top_id=77, forum_topic=True))
        self.assertEqual(tg_live_ndjson.reply_fields(hit), (None, 77, True))
        client = SimpleNamespace(get_messages=mock.AsyncMock())
        self.assertEqual(await tg_live_ndjson.ancestor_chain(client, SimpleNamespace(id=111), hit, 10), [])
        client.get_messages.assert_not_awaited()


class TelegramSelectedOriginalTests(unittest.IsolatedAsyncioTestCase):
    def message(self, text, ident=96879, entities=None):
        return tg_live_ndjson.types.Message(
            id=ident, peer_id=tg_live_ndjson.types.PeerChannel(111),
            from_id=tg_live_ndjson.types.PeerUser(42), message=text,
            date=datetime(2026, 10, 8, tzinfo=timezone.utc),
            edit_date=datetime(2026, 10, 9, tzinfo=timezone.utc), entities=entities,
        )

    def client(self):
        return SimpleNamespace(
            get_me=mock.AsyncMock(return_value=SimpleNamespace(id=123)),
            get_entity=mock.AsyncMock(return_value=tg_live_ndjson.types.User(
                id=42, first_name="Author", username="author",
            )),
        )

    async def test_complete_native_counts_and_hashes_for_short_unicode_and_long_text(self):
        entity = SimpleNamespace(id=111, title="fixture", username=None)
        samples = ["", "short\ntext", "Привет 👩🏽‍💻 e\u0301\r\n", "я" * 8000,
                   "😀я" * 5001 + "end"]
        for text in samples:
            with self.subTest(chars=len(text)):
                client = self.client()
                message = self.message(text)
                preview = await tg_live_ndjson.MessageFormatter(client, entity, 8000).format(message)
                original = await tg_live_ndjson.selected_message_original(client, message, preview)
                native = original["native"]
                self.assertEqual(preview["text"], text[:8000])
                self.assertEqual(preview["text_total_chars"], len(text))
                self.assertEqual(preview["text_returned_chars"], min(8000, len(text)))
                self.assertEqual(preview["text_truncated"], len(text) > 8000)
                self.assertEqual(native["text"], text)
                self.assertEqual(native["total_chars"], len(text))
                self.assertEqual(native["returned_chars"], len(text))
                self.assertEqual(native["utf16_units"], len(text.encode("utf-16-le")) // 2)
                self.assertEqual(native["utf8_bytes"], len(text.encode("utf-8")))
                self.assertEqual(native["sha256"], hashlib.sha256(text.encode()).hexdigest())
                self.assertEqual(preview["text_sha256"], native["sha256"])
                self.assertFalse(native["truncated"])
                self.assertEqual(original["account_id"], 123)
                self.assertEqual(original["marked_peer_id"], -1000000000111)
                self.assertEqual(original["sender"]["id"], 42)
                self.assertTrue(original["current_version_only"])
                self.assertFalse(original["historical_version_restored"])
                self.assertEqual(original["edit_date"], message.edit_date.isoformat())

    async def test_native_text_and_markdown_entities_are_distinct_representations(self):
        text = "😀 резюме"
        entities = [tg_live_ndjson.types.MessageEntityTextUrl(
            offset=3, length=6, url="https://example.test/cv",
        )]
        client = self.client()
        formatted = await tg_live_ndjson.MessageFormatter(
            client, SimpleNamespace(id=111, title="fixture", username=None), 100,
        ).format(self.message(text, entities=entities))
        original = await tg_live_ndjson.selected_message_original(
            client, self.message(text, entities=entities), formatted,
        )
        self.assertEqual(original["native"]["text"], text)
        self.assertEqual(original["markdown"]["text"], "😀 [резюме](https://example.test/cv)")
        self.assertNotEqual(original["native"]["sha256"], original["markdown"]["sha256"])
        self.assertEqual(original["entity_offset_unit"], "utf16_code_units")
        self.assertEqual(original["entities"][0]["offset"], 3)
        self.assertEqual(original["entities"][0]["url"], "https://example.test/cv")

    async def test_context_exports_only_the_selected_hit_with_bounded_neighbors(self):
        hit = self.message("a" * 9001)
        neighbor = self.message("b" * 9002, ident=96878)
        client = self.client()
        client.get_messages = mock.AsyncMock(side_effect=[hit, [neighbor]])
        entity = SimpleNamespace(id=111, title="fixture", username=None)
        with mock.patch.object(tg_live_ndjson, "resolve_entity", new=mock.AsyncMock(return_value=entity)), mock.patch.object(tg_live_ndjson, "emit"):
            result = await tg_live_ndjson.run_context(client, {
                "chat": "111", "message_id": 96879, "before": 1, "after": 0,
                "max_depth": 0, "max_replies": 0, "caption_chars": 8000,
            })
        self.assertEqual(result["selected_original"]["native"]["text"], hit.message)
        self.assertEqual(len(result["hit"]["text"]), 8000)
        self.assertEqual(len(result["neighbors"]["before"][0]["text"]), 8000)
        self.assertTrue(result["hit"]["text_truncated"])
        self.assertTrue(result["neighbors"]["before"][0]["text_truncated"])
        self.assertNotIn("selected_original", result["neighbors"]["before"][0])
        self.assertFalse(result["media_downloaded"])
        client.get_me.assert_awaited_once()
        self.assertEqual(client.get_messages.await_count, 2)

    async def test_unverified_account_is_explicit_without_breaking_existing_context(self):
        client = self.client()
        message = self.message("text")
        formatted = await tg_live_ndjson.MessageFormatter(
            client, SimpleNamespace(id=111, title="fixture", username=None), 100,
        ).format(message)
        for failure in [None, RuntimeError("temporary account lookup failure")]:
            client.get_me.return_value = None
            client.get_me.side_effect = failure
            original = await tg_live_ndjson.selected_message_original(client, message, formatted)
            self.assertIsNone(original["account_id"])
            self.assertEqual(original["account_verification"]["status"], "unavailable")
            self.assertEqual(original["native"]["text"], "text")

    async def test_account_lookup_deadline_preserves_the_context_result(self):
        client = self.client()
        client.get_me = mock.AsyncMock(side_effect=asyncio.Event().wait)
        client.get_messages = mock.AsyncMock(return_value=self.message("readable"))
        entity = SimpleNamespace(id=111, title="fixture", username=None)
        with mock.patch.object(tg_live_ndjson, "SELECTED_ORIGINAL_ACCOUNT_TIMEOUT_SECONDS", 0.01), mock.patch.object(tg_live_ndjson, "resolve_entity", new=mock.AsyncMock(return_value=entity)), mock.patch.object(tg_live_ndjson, "emit"):
            result = await asyncio.wait_for(tg_live_ndjson.run_context(client, {
                "chat": "111", "message_id": 96879, "before": 0, "after": 0,
                "max_depth": 0, "max_replies": 0,
            }), timeout=1)
        self.assertEqual(result["hit"]["text"], "readable")
        self.assertEqual(result["selected_original"]["account_verification"]["status"], "unavailable")
        self.assertEqual(result["selected_original"]["account_verification"]["error_code"], "TimeoutError")

    async def test_entity_int64_survives_the_actual_javascript_json_parse_boundary(self):
        document_id = 5368324170671202286
        message = self.message("😀", entities=[tg_live_ndjson.types.MessageEntityCustomEmoji(
            offset=0, length=2, document_id=document_id,
        )])
        client = self.client()
        formatted = await tg_live_ndjson.MessageFormatter(
            client, SimpleNamespace(id=111, title="fixture", username=None), 100,
        ).format(message)
        original = await tg_live_ndjson.selected_message_original(client, message, formatted)
        parsed = subprocess.run([
            "node", "-e", "process.stdout.write(JSON.stringify(JSON.parse(require('node:fs').readFileSync(0,'utf8'))))",
        ], input=json.dumps(original, ensure_ascii=False), capture_output=True, text=True, check=True)
        wire = json.loads(parsed.stdout)
        self.assertEqual(wire["entities"][0]["document_id"], str(document_id))
        self.assertEqual(wire["entities"][0]["offset"], 0)
        self.assertEqual(wire["entities"][0]["length"], 2)
        self.assertEqual(wire["native"]["text"], "😀")


class TelegramMembershipTests(unittest.IsolatedAsyncioTestCase):
    async def test_public_search_returns_only_public_chats_with_membership_state(self):
        class FakeChannel:
            def __init__(self, ident, username, left):
                self.id = ident
                self.title = username
                self.username = username
                self.left = left
                self.megagroup = True
                self.participants_count = ident * 10

        class FakePeerChannel:
            def __init__(self, ident):
                self.channel_id = ident

        joined = FakeChannel(1, "joined_chat", False)
        global_chat = FakeChannel(2, "global_chat", True)
        private_chat = FakeChannel(3, None, True)

        class Client:
            async def __call__(self, _request):
                return SimpleNamespace(
                    my_results=[FakePeerChannel(1)],
                    results=[FakePeerChannel(2), FakePeerChannel(3)],
                    chats=[joined, global_chat, private_chat],
                )

        with mock.patch.object(tg_live_ndjson.types, "Channel", FakeChannel), \
                mock.patch.object(tg_live_ndjson.types, "PeerChannel", FakePeerChannel), \
                mock.patch.object(tg_live_ndjson, "emit"):
            result = await tg_live_ndjson.run_public_search(Client(), {
                "query": "chat",
                "limit": 10,
            })
        self.assertEqual([row["username"] for row in result["chats"]], [
            "joined_chat", "global_chat",
        ])
        self.assertTrue(result["chats"][0]["already_member"])
        self.assertFalse(result["chats"][1]["already_member"])

    async def test_join_already_member_is_success_without_join_request(self):
        class FakeChannel:
            def __init__(self):
                self.id = 123
                self.title = "Fixture"
                self.username = "fixture_chat"
                self.left = False
                self.megagroup = True

        entity = FakeChannel()

        class Client:
            async def get_entity(self, value):
                return entity

            async def __call__(self, _request):
                raise AssertionError("JoinChannelRequest must not run for a member")

        async def describe(_client, _entity, **_kwargs):
            return {
                "id": 123,
                "title": "Fixture",
                "username": "fixture_chat",
                "type": "supergroup",
                "source_kind": "group",
                "participants_count": 10,
                "has_discussion": False,
                "linked_discussion_id": None,
                "public": True,
                "member": True,
                "url": "https://t.me/fixture_chat",
            }

        events = []
        with mock.patch.object(tg_live_ndjson.types, "Channel", FakeChannel), \
                mock.patch.object(tg_live_ndjson, "membership_chat_ref", side_effect=describe), \
                mock.patch.object(tg_live_ndjson, "emit", side_effect=events.append):
            result = await tg_live_ndjson.run_join(Client(), {
                "target": "@fixture_chat",
                "confirm": True,
            })

        self.assertEqual(result["status"], "already_member")
        self.assertTrue(result["already_member"])
        self.assertTrue(result["ready_for_fetch"])
        self.assertTrue(any(event.get("type") == "entity" for event in events))

    async def test_join_emits_commit_boundary_before_mutating_request(self):
        class FakeChannel:
            def __init__(self):
                self.id = 124
                self.title = "Join fixture"
                self.username = "join_fixture"
                self.left = True
                self.megagroup = True

        entity = FakeChannel()

        class Client:
            def __init__(self):
                self.join_calls = 0

            async def get_entity(self, _value):
                return entity

            async def __call__(self, request):
                self.join_calls += 1
                self.stage_at_call = events[-1].get("stage")
                entity.left = False
                return SimpleNamespace(chats=[entity])

        async def describe(_client, _entity, **_kwargs):
            return {
                "id": 124, "title": "Join fixture", "username": "join_fixture",
                "type": "supergroup", "source_kind": "group",
                "participants_count": 12, "has_discussion": False,
                "linked_discussion_id": None, "public": True, "member": True,
                "url": "https://t.me/join_fixture",
            }

        events = []
        client = Client()
        with mock.patch.object(tg_live_ndjson.types, "Channel", FakeChannel), \
                mock.patch.object(tg_live_ndjson, "membership_chat_ref", side_effect=describe), \
                mock.patch.object(tg_live_ndjson, "emit", side_effect=events.append):
            result = await tg_live_ndjson.run_join(client, {
                "target": "@join_fixture",
                "confirm": True,
            })
        self.assertEqual(client.join_calls, 1)
        self.assertEqual(client.stage_at_call, "updating_membership")
        self.assertEqual(result["status"], "joined")

    async def test_leave_already_left_is_idempotent(self):
        class FakeChannel:
            def __init__(self):
                self.id = 456
                self.title = "Left fixture"
                self.username = "left_fixture"
                self.left = True
                self.megagroup = False

        entity = FakeChannel()

        class Client:
            async def get_entity(self, _value):
                return entity

            async def __call__(self, _request):
                raise AssertionError("LeaveChannelRequest must not run when already left")

        async def describe(_client, _entity, **_kwargs):
            return {
                "id": 456,
                "title": "Left fixture",
                "username": "left_fixture",
                "type": "channel",
                "source_kind": "channel",
                "participants_count": None,
                "has_discussion": None,
                "linked_discussion_id": None,
                "public": True,
                "member": False,
                "url": "https://t.me/left_fixture",
            }

        with mock.patch.object(tg_live_ndjson.types, "Channel", FakeChannel), \
                mock.patch.object(tg_live_ndjson, "membership_chat_ref", side_effect=describe), \
                mock.patch.object(tg_live_ndjson, "emit"):
            result = await tg_live_ndjson.run_leave(Client(), {
                "target": "@left_fixture",
                "confirm": True,
            })
        self.assertEqual(result["status"], "already_left")
        self.assertTrue(result["already_left"])
        self.assertFalse(result["ready_for_fetch"])


class TelegramLiveTranscriptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_transcribes_exactly_one_selected_voice_without_saving_chat(self):
        with tempfile.TemporaryDirectory() as temp:
            media_path = Path(temp) / "voice.oga"
            media_path.write_bytes(b"OggSfixture")
            transcript_path = Path(temp) / "voice__soniox.txt"
            entity = SimpleNamespace(id=3451593250, title="Fixture", username=None, forum=False)
            message = SimpleNamespace(id=37314)

            class Client:
                async def get_messages(self, _entity, ids):
                    self.requested_id = ids
                    return message

            class Formatter:
                def __init__(self, *_args, **_kwargs):
                    pass

                async def format(self, _message):
                    return {
                        "message_id": 37314,
                        "type": "voice",
                        "text": "",
                        "sender": {"name": "Fedor"},
                        "media": [{
                            "kind": "voice",
                            "content_type": "audio/ogg",
                            "bytes": len(b"OggSfixture"),
                        }],
                    }

            async def materialize(*_args, **_kwargs):
                return {
                    "kind": "voice",
                    "content_type": "audio/ogg",
                    "bytes": len(b"OggSfixture"),
                    "file_path": str(media_path),
                    "content_kind": "audio",
                    "cached": False,
                }

            seen = {}

            def transcribe(path, **kwargs):
                seen.update({"path": path, **kwargs})
                kwargs["progress_callback"](stage="processing", status="processing", attempt=1)
                return "Проверенная речь", None, {
                    "model": "stt-async-v5",
                    "token_count": 2,
                }

            def write_transcript(path, text, *, engine):
                self.assertEqual(path, str(media_path))
                self.assertEqual(text, "Проверенная речь")
                self.assertEqual(engine, "soniox")
                transcript_path.write_text(text, encoding="utf-8")
                return str(transcript_path)

            events = []
            client = Client()
            with mock.patch.object(tg_live_ndjson, "resolve_entity", return_value=entity), \
                    mock.patch.object(tg_live_ndjson, "MessageFormatter", Formatter), \
                    mock.patch.object(tg_live_ndjson, "materialize_message_attachment", side_effect=materialize), \
                    mock.patch.object(tg_live_ndjson, "transcribe_soniox_file", side_effect=transcribe), \
                    mock.patch.object(tg_live_ndjson, "write_attachment_transcript", side_effect=write_transcript), \
                    mock.patch.object(tg_live_ndjson, "emit", side_effect=events.append):
                result = await tg_live_ndjson.run_transcribe(client, {
                    "chat": "3451593250",
                    "message_id": 37314,
                    "language_hints": ["ru", "en"],
                    "context": "Таиланд",
                    "max_bytes": 100000,
                    "max_text_chars": 200000,
                })

            self.assertEqual(client.requested_id, 37314)
            self.assertEqual(seen["path"], str(media_path))
            self.assertEqual(seen["context_text"], "Таиланд")
            self.assertEqual(result["operation"], "transcribe")
            self.assertEqual(result["transcription"]["text"], "Проверенная речь")
            self.assertEqual(result["transcript_path"], str(transcript_path))
            self.assertTrue(any(event.get("stage") == "transcribing_soniox" for event in events))


if __name__ == "__main__":
    unittest.main()
