import io
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from PIL import Image
from telethon import TelegramClient, errors, functions, types
from telethon.sessions import MemorySession

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tg_send_saved_ndjson as worker


class FakeClient:
    def __init__(self, *, premium=False, fail_group=None, missing_readback=False):
        self.premium = premium
        self.fail_group = fail_group
        self.missing_readback = missing_readback
        self.calls = []
        self.messages = {}
        self.next_id = 100
        self.group_count = 0

    async def get_me(self):
        return SimpleNamespace(id=123, username="fixture", premium=self.premium)

    async def __call__(self, request):
        if isinstance(request, functions.help.GetConfigRequest):
            return SimpleNamespace(caption_length_max=1024, message_length_max=4096)
        if isinstance(request, functions.help.GetAppConfigRequest):
            return SimpleNamespace(config=types.JsonObject([
                types.JsonObjectValue("caption_length_limit_premium", types.JsonNumber(4096)),
            ]))
        raise AssertionError(type(request))

    async def send_message(self, target, text, **kwargs):
        self.calls.append(("text", target, text, kwargs))
        return SimpleNamespace(id=99, date=None)

    async def send_file(self, target, paths, **kwargs):
        self.calls.append(("file", target, paths, kwargs))
        is_album = isinstance(paths, list)
        self.group_count += 1
        if self.fail_group == self.group_count:
            raise TimeoutError("Telegram ACK lost")
        messages = []
        for i, path in enumerate(paths if is_album else [paths]):
            document = kwargs["force_document"]
            self.next_id += 1
            msg = SimpleNamespace(
                id=self.next_id, date=None,
                grouped_id=987654321098765432 + self.group_count if is_album else None,
                message=kwargs.get("caption", [""] * 50)[i],
                document=SimpleNamespace() if document else None,
                photo=SimpleNamespace() if not document else None,
                file=SimpleNamespace(name=Path(path).name if document else None,
                                     size=Path(path).stat().st_size, mime_type="image/png"),
            )
            self.messages[msg.id] = msg
            messages.append(msg)
        return messages if is_album else messages[0]

    async def get_messages(self, target, ids):
        assert target == "me"
        return [None if self.missing_readback else self.messages.get(mid) for mid in ids]

    async def disconnect(self):
        pass


class SendSavedTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.paths = []
        for i in range(50):
            p = self.root / f"{i:02d}.png"
            p.write_bytes(b"fixture-original" + bytes([i]))
            self.paths.append(str(p))
        self.session = self.root / "fixture.session"
        self.session.touch()

    async def run_send(self, client=None, **kwargs):
        client = client or FakeClient()
        events = []
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(worker, "emit", side_effect=events.append))
            stack.enter_context(mock.patch.object(worker, "_resolve_session_path", return_value=self.session))
            stack.enter_context(mock.patch.object(worker, "telegram_credentials", return_value=(1, "fixture")))
            stack.enter_context(mock.patch.object(worker, "TelegramClient", return_value=client))
            stack.enter_context(mock.patch.object(worker, "connect_authorized", mock.AsyncMock(return_value=(True, None, None))))
            code = await worker.send_saved(**kwargs)
        return code, events, client

    async def test_originals_order_caption_and_readback(self):
        caption = "Полная подпись\n**без Markdown** 🛰"
        code, events, client = await self.run_send(album={"mode": "document", "paths": self.paths[:13], "caption": caption})
        self.assertEqual(code, 0)
        self.assertEqual([len(c[2]) for c in client.calls], [10, 3])
        self.assertEqual([p for c in client.calls for p in c[2]], self.paths[:13])
        for call in client.calls:
            self.assertEqual(call[1], "me")
            self.assertIs(call[3]["force_document"], True)
            self.assertIsNone(call[3]["parse_mode"])
            self.assertEqual(call[3]["caption"], [caption] + [""] * (len(call[2]) - 1))
        albums = [e for e in events if e["type"] == "album_verified"]
        self.assertEqual(len(albums), 2)
        self.assertNotEqual(albums[0]["grouped_id"], albums[1]["grouped_id"])
        for album in albums:
            self.assertIsInstance(album["grouped_id"], str)
            self.assertEqual(album["caption"], caption)
            for row in album["messages"]:
                self.assertEqual(row["bytes"], row["local_bytes"])
                self.assertEqual(row["name"], Path(row["path"]).name)
        self.assertEqual(events[-1]["sent"], 13)

    async def test_photo_mode_is_explicit_and_does_not_force_documents(self):
        code, _, client = await self.run_send(album={"mode": "photo", "paths": self.paths[:2]})
        self.assertEqual(code, 0)
        self.assertIs(client.calls[0][3]["force_document"], False)

    def test_all_group_sizes_and_boundaries_preserve_order(self):
        for count in range(2, 51):
            groups = worker.album_groups(self.paths[:count])
            self.assertEqual([p for group in groups for p in group], self.paths[:count])
            self.assertTrue(all(2 <= len(group) <= 10 for group in groups))
        self.assertEqual(list(map(len, worker.album_groups(self.paths[:11]))), [9, 2])
        self.assertEqual(list(map(len, worker.album_groups(self.paths[:21]))), [10, 9, 2])

    async def test_caption_boundaries_and_premium_are_checked_before_text(self):
        for premium, limit in [(False, 1024), (True, 4096)]:
            with self.subTest(premium=premium):
                code, events, client = await self.run_send(FakeClient(premium=premium), text="must not send",
                    album={"mode": "document", "paths": self.paths[:2], "caption": "🛰" * (limit + 1)})
                self.assertEqual(code, 2)
                self.assertEqual(client.calls, [])
                self.assertEqual(events[-1]["code"], "caption_too_long")
                self.assertEqual(events[-1]["limits"]["caption_max_chars"], limit)
                code, events, _ = await self.run_send(FakeClient(premium=premium),
                    album={"mode": "document", "paths": self.paths[:2], "caption": "🛰" * limit})
                self.assertEqual(code, 0)
                self.assertEqual(len(next(e for e in events if e["type"] == "album_verified")["caption"]), limit)

    async def test_invalid_album_or_missing_file_sends_nothing(self):
        invalid = [
            {"paths": self.paths[:2]},
            {"mode": "auto", "paths": self.paths[:2]},
            {"mode": "document", "paths": self.paths[:1]},
            {"mode": "document", "paths": self.paths + [self.paths[0]]},
            {"mode": "document", "paths": self.paths[:1] + ["/missing/file.png"]},
        ]
        for album in invalid:
            code, _, client = await self.run_send(text="must not send", album=album)
            self.assertEqual(code, 2)
            self.assertEqual(client.calls, [])
        code, _, client = await self.run_send(images=self.paths[:1], album={"mode": "document", "paths": self.paths[:2]})
        self.assertEqual(code, 2)
        self.assertEqual(client.calls, [])

    async def test_legacy_text_photo_and_file_are_still_separate(self):
        code, events, client = await self.run_send(text="legacy", images=self.paths[:1], files=self.paths[1:2])
        self.assertEqual(code, 0)
        self.assertEqual([c[0] for c in client.calls], ["text", "file", "file"])
        self.assertEqual(client.calls[1][2], self.paths[0])
        self.assertEqual(client.calls[2][2], self.paths[1])
        self.assertIs(client.calls[1][3]["force_document"], False)
        self.assertIs(client.calls[2][3]["force_document"], True)
        self.assertEqual(events[-1]["sent"], 3)

    async def test_lost_ack_preserves_first_album_and_never_retries(self):
        code, events, client = await self.run_send(FakeClient(fail_group=2),
            album={"mode": "document", "paths": self.paths[:21]})
        self.assertEqual(code, 1)
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(len([e for e in events if e["type"] == "sent"]), 10)
        self.assertEqual(events[-1]["code"], "delivery_unknown")
        self.assertIs(events[-1]["delivery_uncertain"], True)
        self.assertEqual(events[-1]["album_index"], 2)
        self.assertFalse(any(e["type"] == "done" for e in events))

    async def test_failed_readback_preserves_ack_and_stops_following_groups(self):
        code, events, client = await self.run_send(FakeClient(missing_readback=True),
            album={"mode": "document", "paths": self.paths[:13]})
        self.assertEqual(code, 1)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(events[-1]["code"], "delivery_verification_failed")
        self.assertEqual(events[-1]["sent"], 10)

    async def test_flood_wait_is_reported_without_retry(self):
        client = FakeClient()
        client.send_file = mock.AsyncMock(side_effect=errors.FloodWaitError(None, 37))
        code, events, _ = await self.run_send(client, album={"mode": "document", "paths": self.paths[:2]})
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["code"], "telegram_flood_wait")
        self.assertEqual(events[-1]["retry_after_seconds"], 37)
        self.assertEqual(client.send_file.await_count, 1)

    async def test_real_telethon_original_upload_bytes_and_photo_conversion(self):
        # Exercise installed Telethon media preparation with no network calls.
        p = self.root / "rgba.png"
        Image.new("RGBA", (32, 24), (50, 100, 200, 120)).save(p)
        original = p.read_bytes()
        client = TelegramClient(MemorySession(), 1, "fixture")
        uploads = []

        async def capture_upload(file, **_kwargs):
            raw = Path(file).read_bytes() if isinstance(file, str) else file.getvalue()
            uploads.append(raw)
            return types.InputFile(1, 1, "rgba.png", "")

        client.upload_file = capture_upload
        _, document, _ = await client._file_to_media(str(p), force_document=True)
        self.assertIsInstance(document, types.InputMediaUploadedDocument)
        self.assertEqual(uploads[-1], original)
        self.assertEqual(document.mime_type, "image/png")
        _, photo, _ = await client._file_to_media(str(p), force_document=False)
        self.assertIsInstance(photo, types.InputMediaUploadedPhoto)
        self.assertNotEqual(uploads[-1], original)
        self.assertEqual(Image.open(io.BytesIO(uploads[-1])).format, "JPEG")
        self.assertEqual(p.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
