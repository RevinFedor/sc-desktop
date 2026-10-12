import os
import base64
import shutil
import tempfile
import unittest
from pathlib import Path

from tg_attachment_cache import (
    attachment_content_kind,
    cache_path_for,
    extract_attachment_content,
    materialize_message_attachment,
    safe_file_name,
    write_attachment_transcript,
)


class FakeMessage:
    def __init__(self, payload):
        self.payload = payload
        self.download_calls = 0

    async def download_media(self, *, file, progress_callback):
        self.download_calls += 1
        path = Path(file)
        path.write_bytes(self.payload)
        os.utime(path, (100, 100))  # Telethon commonly preserves old message time.
        progress_callback(len(self.payload), len(self.payload))
        return str(path)


class TelegramAttachmentCacheTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_root = os.environ.get("SC_DESKTOP_DIR")
        os.environ["SC_DESKTOP_DIR"] = self.temp.name

    async def asyncTearDown(self):
        if self.previous_root is None:
            os.environ.pop("SC_DESKTOP_DIR", None)
        else:
            os.environ["SC_DESKTOP_DIR"] = self.previous_root
        self.temp.cleanup()

    def test_safe_cache_path_cannot_escape_app_root(self):
        attachment = {"file_name": "../../secret.png", "content_type": "image/png"}
        path = cache_path_for(3861500830, 3806, attachment)
        self.assertEqual(safe_file_name("../../secret.png"), "secret.png")
        self.assertTrue(str(path).startswith(str(Path(self.temp.name).resolve())))

    def test_document_images_and_pdf_signatures_are_classified_by_content(self):
        image = Path(self.temp.name) / "sent-as-document.bin"
        image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 20)
        pdf = Path(self.temp.name) / "unknown.bin"
        pdf.write_bytes(b"%PDF-1.4\n")
        self.assertEqual(attachment_content_kind({"kind": "document"}, image), "image")
        self.assertEqual(attachment_content_kind({"kind": "document"}, pdf), "pdf")

    def test_voice_and_video_are_readable_media_not_unsupported_binary(self):
        voice = Path(self.temp.name) / "voice.oga"
        voice.write_bytes(b"OggSfixture")
        video = Path(self.temp.name) / "clip.mp4"
        video.write_bytes(b"video")
        self.assertEqual(
            attachment_content_kind({"content_type": "audio/ogg"}, voice),
            "audio",
        )
        self.assertEqual(
            attachment_content_kind({"content_type": "video/mp4"}, video),
            "video",
        )
        kind, _, text, extraction = extract_attachment_content(
            voice,
            {"content_type": "audio/ogg"},
        )
        self.assertEqual(kind, "audio")
        self.assertIsNone(text)
        self.assertIn("telegram_live_transcribe", extraction["limitation"])

    def test_text_and_binary_results_never_claim_the_same_read_status(self):
        text_path = Path(self.temp.name) / "fixture.md"
        text_path.write_text("# Telegram fixture\nreal contents", encoding="utf-8")
        kind, _, text, extraction = extract_attachment_content(
            text_path,
            {"file_name": "fixture.md", "content_type": "text/markdown"},
        )
        self.assertEqual(kind, "text")
        self.assertIn("real contents", text)
        self.assertEqual(extraction["status"], "extracted")

        binary_path = Path(self.temp.name) / "fixture.zip"
        binary_path.write_bytes(b"PK\x03\x04binary")
        kind, _, text, extraction = extract_attachment_content(
            binary_path,
            {"file_name": "fixture.zip", "content_type": "application/zip"},
        )
        self.assertEqual(kind, "binary")
        self.assertIsNone(text)
        self.assertEqual(extraction["status"], "file_only")
        self.assertIn("unsupported binary", extraction["limitation"])

    def test_pdf_returns_extracted_text_when_local_reader_is_available(self):
        encoded = (
            "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoK"
            "PDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUg"
            "L1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8"
            "IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQg"
            "L1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGgg"
            "NDAxID4+CnN0cmVhbQpCVCAvRjEgMTYgVGYgNzIgNzMwIFRkIChJbmxpbmUgaW1hZ2UgdG9rZW5pemVyIHJlcHJv"
            "IGlzc3VlKSBUaiBFVApxCkJJCi9XIDUgL0ggMSAvQ1MgL0RldmljZUdyYXkgL0JQQyA4CklEChEjPjVHCkVJClEK"
            "MC41IHcKMTAwIDY1MCBtIDI2MCA2NTAgbCBTCjEwMCA2MjAgbSAyNjAgNjIwIGwgUwoxMDAgNTkwIG0gMjYwIDU5"
            "MCBsIFMKMTAwIDY1MCBtIDEwMCA1OTAgbCBTCjE4MCA2NTAgbSAxODAgNTkwIGwgUwoyNjAgNjUwIG0gMjYwIDU5"
            "MCBsIFMKQlQgL0YxIDEwIFRmIDExNSA2MzMgVGQgKE5hbWUpIFRqIEVUCkJUIC9GMSAxMCBUZiAxOTUgNjMzIFRk"
            "IChRdHkpIFRqIEVUCkJUIC9GMSAxMCBUZiAxMTUgNjAzIFRkIChXaXJlKSBUaiBFVApCVCAvRjEgMTAgVGYgMTk1"
            "IDYwMyBUZCAoMTIpIFRqIEVUCgplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAK"
            "MDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAw"
            "MDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+"
            "PgpzdGFydHhyZWYKNzYzCiUlRU9GCg=="
        )
        pdf_path = Path(self.temp.name) / "fixture.pdf"
        pdf_path.write_bytes(base64.b64decode(encoded))
        kind, _, text, extraction = extract_attachment_content(
            pdf_path,
            {"file_name": "fixture.pdf", "content_type": "application/pdf"},
        )
        self.assertEqual(kind, "pdf")
        if shutil.which("pdftotext"):
            self.assertEqual(extraction["status"], "extracted")
            self.assertIn("Inline image tokenizer repro issue", text)
        else:
            self.assertEqual(extraction["status"], "file_only")

    async def test_materialises_only_one_file_and_reuses_the_cache(self):
        payload = b"\xff\xd8\xff" + b"photo-bytes"
        message = FakeMessage(payload)
        metadata = {
            "kind": "document",
            "file_name": "screenshot.jpg",
            "content_type": "image/jpeg",
            "bytes": len(payload),
        }
        first = await materialize_message_attachment(
            message,
            chat_id=3861500830,
            message_id=3806,
            attachment=metadata,
        )
        second = await materialize_message_attachment(
            message,
            chat_id=3861500830,
            message_id=3806,
            attachment=metadata,
        )
        self.assertEqual(message.download_calls, 1)
        self.assertTrue(Path(first["file_path"]).is_file())
        self.assertEqual(first["content_kind"], "image")
        self.assertGreater(Path(first["file_path"]).stat().st_mtime, 1_000_000_000)
        self.assertTrue(second["cached"])

    async def test_transcript_is_saved_beside_selected_cached_media(self):
        payload = b"OggSvoice"
        message = FakeMessage(payload)
        media = await materialize_message_attachment(
            message,
            chat_id=3451593250,
            message_id=37314,
            attachment={
                "kind": "voice",
                "content_type": "audio/ogg",
                "bytes": len(payload),
            },
        )
        transcript_path = write_attachment_transcript(
            media["file_path"],
            "проверенный текст",
            engine="soniox",
        )
        transcript = Path(transcript_path)
        self.assertTrue(transcript.is_file())
        self.assertEqual(transcript.read_text("utf-8"), "проверенный текст\n")
        self.assertEqual(transcript.parent, Path(media["file_path"]).parent)


if __name__ == "__main__":
    unittest.main()
