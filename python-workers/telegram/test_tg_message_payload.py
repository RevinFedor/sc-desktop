import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from tg_message_payload import (
    attachment_metadata,
    forward_metadata,
    is_text_attachment,
    item_raw_meta,
    read_text_attachment,
    reply_metadata,
)


class User:
    def __init__(self, user_id, first_name, username=None):
        self.id = user_id
        self.first_name = first_name
        self.last_name = None
        self.username = username


class TelegramMessagePayloadTest(unittest.TestCase):
    def forwarded_document(self):
        sender = User(42, "Алиса", "alice")
        raw_forward = SimpleNamespace(
            date=datetime(2026, 8, 19, 1, 0, tzinfo=timezone.utc),
            from_id=SimpleNamespace(user_id=42),
            from_name=None,
            channel_post=None,
            post_author=None,
            saved_from_peer=None,
            saved_from_msg_id=None,
            imported=False,
        )
        return SimpleNamespace(
            media=SimpleNamespace(spoiler=False),
            file=SimpleNamespace(
                name="заметки.md", mime_type="", size=5496,
                width=None, height=None, duration=None,
            ),
            photo=None,
            document=object(),
            grouped_id=None,
            fwd_from=raw_forward,
            forward=SimpleNamespace(
                sender=sender,
                chat=None,
                date=raw_forward.date,
            ),
        )

    def test_forwarded_attachment_keeps_file_and_origin_metadata(self):
        message = self.forwarded_document()
        media = attachment_metadata(message, "document")
        forward = forward_metadata(message)

        self.assertEqual(media["file_name"], "заметки.md")
        self.assertEqual(media["bytes"], 5496)
        self.assertTrue(is_text_attachment(media))
        self.assertEqual(forward["source"]["name"], "Алиса")
        self.assertEqual(forward["source"]["username"], "alice")
        self.assertEqual(forward["from_peer"], {"id": 42, "kind": "user"})
        self.assertEqual(
            item_raw_meta({"media": [media], "forward": forward})["media"][0]["file_name"],
            "заметки.md",
        )

    def test_text_attachment_decoder_handles_utf8_and_reports_no_truncation(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "forwarded.md"
            path.write_text("# Заголовок\n\nСодержимое файла", encoding="utf-8")
            text, truncated = read_text_attachment(path)

        self.assertEqual(text, "# Заголовок\n\nСодержимое файла")
        self.assertFalse(truncated)

    def reply_message(self, header, peer=None):
        from telethon import types
        return types.Message(
            id=100, peer_id=peer or types.PeerChannel(111),
            message="quoted response", date=datetime(2026, 10, 7, tzinfo=timezone.utc),
            reply_to=header,
        )

    def test_actual_telethon_cross_peer_header_never_becomes_local_parent(self):
        from telethon import types
        header = types.MessageReplyHeader(
            reply_to_msg_id=99, reply_to_peer_id=types.PeerChannel(222),
            quote_text="Exact URL https://Example.org/AbC", quote_offset=7,
        )
        payload = reply_metadata(self.reply_message(header))
        self.assertIsNone(payload["parent_external_id"])
        self.assertEqual(payload["telegram_reply"]["scope"], "external_peer")
        self.assertEqual(payload["external_reply"]["peer"], {"id": 222, "kind": "channel"})
        self.assertEqual(payload["external_reply"]["message_id"], 99)
        self.assertEqual(payload["external_reply"]["quote_text"], "Exact URL https://Example.org/AbC")
        self.assertEqual(payload["external_reply"]["quote_offset_unit"], "utf16_code_units")
        persisted = item_raw_meta({"media": [{"kind": "photo"}], "forward": {"from_name": "original"}, **payload})
        self.assertEqual(persisted["external_reply"], payload["external_reply"])
        self.assertEqual(persisted["forward"], {"from_name": "original"})
        self.assertEqual(persisted["media"], [{"kind": "photo"}])

    def test_same_peer_explicit_and_implicit_headers_preserve_ordinary_replies(self):
        from telethon import types
        for target in (None, types.PeerChannel(111)):
            packet = reply_metadata(self.reply_message(types.MessageReplyHeader(reply_to_msg_id=99, reply_to_peer_id=target)))
            self.assertEqual(packet["parent_external_id"], "99")
            self.assertEqual(packet["telegram_reply"]["scope"], "same_peer")
            self.assertIsNone(packet["external_reply"])
        self.assertEqual(reply_metadata(self.reply_message(None))["telegram_reply"]["scope"], "none")

    def test_peer_kind_participates_in_comparison_and_missing_identity_stays_unknown(self):
        from telethon import types
        packet = reply_metadata(self.reply_message(types.MessageReplyHeader(reply_to_msg_id=99, reply_to_peer_id=types.PeerUser(111))))
        self.assertEqual(packet["telegram_reply"]["scope"], "external_peer")
        self.assertIsNone(packet["parent_external_id"])
        unknown = reply_metadata(SimpleNamespace(reply_to=types.MessageReplyHeader(reply_to_msg_id=99, reply_to_peer_id=types.PeerChannel(222))))
        self.assertEqual(unknown["telegram_reply"]["scope"], "unknown")
        self.assertIsNone(unknown["parent_external_id"])
        self.assertEqual(reply_metadata(None)["telegram_reply"]["scope"], "unavailable")

    def test_topic_anchor_is_not_reply_and_new_metadata_clears_an_old_external_reference(self):
        from telethon import types
        packet = reply_metadata(self.reply_message(types.MessageReplyHeader(reply_to_msg_id=77, reply_to_top_id=77, forum_topic=True)))
        self.assertEqual(packet["telegram_reply"]["scope"], "topic_anchor")
        self.assertIsNone(packet["parent_external_id"])
        raw = item_raw_meta(packet)
        self.assertIn("external_reply", raw)
        self.assertIsNone(raw["external_reply"])


if __name__ == "__main__":
    unittest.main()
