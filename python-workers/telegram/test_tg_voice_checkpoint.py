"""Isolated Soniox checkpoint/voice-policy regressions; no provider/auth data."""
import asyncio
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
SHARED = HERE.parent / "shared"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(SHARED))

import soniox_utils
from tg_voice_policy import (VoiceCache, VoicePolicy, MediaStorageError, UnknownMediaDelivery,
                            checked_directory, verify_media_directory_fence)


def load_fetch_fixture(root):
    """Load real worker with fake credentials/home/session resolution only."""
    credentials = ModuleType("credentials")
    credentials.telegram_credentials = lambda: (123, "fixture-api-hash")
    session_path = ModuleType("tg_session_path")
    session_path.resolve_session_path = lambda *_args, **_kwargs: root / "fixture.session"
    session_path.connect_authorized = mock.AsyncMock(return_value=(True, None, None))
    spec = importlib.util.spec_from_file_location("_tg_voice_checkpoint_fetch_fixture", HERE / "tg_fetch_json.py")
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, {"credentials": credentials, "tg_session_path": session_path}), \
            mock.patch.object(Path, "home", return_value=root), \
            mock.patch.dict(os.environ, {"SC_DESKTOP_DIR": str(root)}):
        spec.loader.exec_module(module)
    return module


class SonioxCheckpointTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sc-voice-checkpoint-fixture-")
        self.root = Path(self.temp.name)
        self.source = self.root / "voice.oga"
        self.source.write_bytes(b"OggSfixture")
        self.identity = {"peer": ["channel", 333], "message_id": 10, "document_id": "991", "size": 11}
        self.cache = VoiceCache(self.root / "state" / "attempt.json", self.root / "media" / "voice", self.identity, "soniox")
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def fake_http(self, url, **kwargs):
        self.calls.append((url, kwargs.get("method", "GET")))
        if kwargs.get("method") == "DELETE":
            return {}
        if url.endswith("/v1/transcriptions"):
            return {"id": "tr-fixture"}
        if url.endswith("/transcript"):
            return {"tokens": [{"text": " привет"}, {"text": ", мир"}]}
        return {"status": "completed"}

    def transcribe(self, **kwargs):
        return soniox_utils.transcribe_file(self.source, api_key="fixture-key", checkpoint=self.cache, sleep=lambda _seconds: None, **kwargs)

    def test_upload_ack_loss_keeps_unknown_attempt_and_never_uploads_or_creates_again(self):
        with mock.patch.object(soniox_utils, "upload_file", side_effect=ConnectionError("upload ACK lost")) as upload, \
                mock.patch.object(soniox_utils, "http_json", side_effect=self.fake_http):
            with self.assertRaises(RuntimeError) as first:
                self.transcribe()
            self.assertEqual(first.exception.code, "media_delivery_unknown")
            self.assertEqual(self.cache.load()["state"], "uploading")
            with self.assertRaises(RuntimeError) as resumed:
                self.transcribe()
            self.assertEqual(getattr(resumed.exception, "code", None), "media_delivery_unknown")
            self.assertEqual(upload.call_count, 1)
        self.assertEqual(self.calls, [])

    def test_create_ack_loss_preserves_known_file_and_never_posts_another_paid_job(self):
        def lose_create(url, **kwargs):
            self.calls.append((url, kwargs.get("method", "GET")))
            if kwargs.get("method") == "POST":
                raise ConnectionError("create ACK lost")
            return {}
        with mock.patch.object(soniox_utils, "upload_file", return_value="file-fixture") as upload, \
                mock.patch.object(soniox_utils, "http_json", side_effect=lose_create):
            with self.assertRaises(RuntimeError) as first:
                self.transcribe()
            self.assertEqual(first.exception.code, "media_delivery_unknown")
            state = self.cache.load()
            self.assertEqual(state["state"], "creating")
            self.assertEqual(state["file_id"], "file-fixture")
            with self.assertRaises(RuntimeError) as resumed:
                self.transcribe()
            self.assertEqual(getattr(resumed.exception, "code", None), "media_delivery_unknown")
            self.assertEqual(upload.call_count, 1)
        self.assertEqual([method for _, method in self.calls], ["POST"])

    def test_known_transcription_id_resumes_get_without_upload_or_create_post(self):
        self.cache.save({"state": "processing", "file_id": "file-fixture", "transcription_id": "tr-fixture"})
        with mock.patch.object(soniox_utils, "upload_file", side_effect=AssertionError("must not upload")), \
                mock.patch.object(soniox_utils, "prepare_upload_file", side_effect=AssertionError("must not read media")), \
                mock.patch.object(soniox_utils, "http_json", side_effect=self.fake_http):
            text, error, details = self.transcribe()
        self.assertEqual(text, "привет, мир")
        self.assertIsNone(error)
        self.assertEqual(details["model"], "stt-async-v5")
        self.assertEqual(self.cache.load()["state"], "completed")
        self.assertEqual([method for _, method in self.calls], ["GET", "GET", "DELETE", "DELETE"])

    def test_known_uploaded_file_creates_once_but_does_not_upload_a_second_file(self):
        self.cache.save({"state": "uploaded", "file_id": "file-fixture"})
        with mock.patch.object(soniox_utils, "upload_file", side_effect=AssertionError("already uploaded")), \
                mock.patch.object(soniox_utils, "http_json", side_effect=self.fake_http):
            self.assertIsNone(self.transcribe()[1])
        self.assertEqual([method for _, method in self.calls].count("POST"), 1)

    def test_completed_result_reuse_does_not_require_credentials_or_any_provider_call(self):
        self.cache.save({"state": "completed", "text": "cached speech", "details": {"model": "stt-async-v5"}})
        with mock.patch.object(soniox_utils, "get_soniox_key", side_effect=AssertionError("completed cache must not read credentials")), \
                mock.patch.object(soniox_utils, "upload_file", side_effect=AssertionError("completed cache must not upload")), \
                mock.patch.object(soniox_utils, "http_json", side_effect=AssertionError("completed cache must not contact provider")):
            text, error, details = soniox_utils.transcribe_file(None, checkpoint=self.cache)
        self.assertEqual(text, "cached speech")
        self.assertIsNone(error)
        self.assertEqual(details["model"], "stt-async-v5")

    def test_cancelled_poll_retains_provider_ids_and_resumes_the_same_job(self):
        self.cache.save({"state": "processing", "file_id": "file-fixture", "transcription_id": "tr-fixture"})
        with mock.patch.object(soniox_utils, "http_json", side_effect=self.fake_http):
            with self.assertRaisesRegex(RuntimeError, "cancel fixture"):
                soniox_utils.transcribe_file(None, api_key="fixture-key", checkpoint=self.cache,
                                            sleep=lambda _seconds: (_ for _ in ()).throw(RuntimeError("cancel fixture")))
            self.assertEqual(self.calls, [], "unknown/cancelled attempts must not delete provider state")
            self.assertEqual(self.cache.load()["transcription_id"], "tr-fixture")
            self.assertIsNone(self.transcribe()[1])
        self.assertNotIn("POST", [method for _, method in self.calls])

    def test_completed_checkpoint_write_failure_keeps_known_ids_without_provider_deletion(self):
        self.cache.save({"state": "processing", "file_id": "file-fixture", "transcription_id": "tr-fixture"})
        original_save = self.cache.save
        def no_space(value):
            if value.get("state") == "completed":
                raise OSError("no space for durable transcript")
            original_save(value)
        with mock.patch.object(self.cache, "save", side_effect=no_space), \
                mock.patch.object(soniox_utils, "http_json", side_effect=self.fake_http):
            with self.assertRaisesRegex(OSError, "no space"):
                self.transcribe()
        self.assertNotIn("DELETE", [method for _, method in self.calls])
        self.assertEqual(self.cache.load()["state"], "processing")

    def test_no_speech_is_completed_reusable_result_not_fabricated_transcript(self):
        def empty_transcript(url, **kwargs):
            return {"tokens": []} if url.endswith("/transcript") else self.fake_http(url, **kwargs)
        with mock.patch.object(soniox_utils, "upload_file", return_value="file-fixture"), \
                mock.patch.object(soniox_utils, "http_json", side_effect=empty_transcript):
            text, error, details = self.transcribe()
        self.assertEqual(text, "")
        self.assertIsNone(error)
        self.assertEqual(details["result_status"], "no_speech")
        self.assertEqual(self.cache.load()["result_status"], "no_speech")

    def test_unknown_checkpoint_rejected_without_credentials_lookup(self):
        self.cache.save({"state": "creating", "file_id": "known-file"})
        with mock.patch.object(soniox_utils, "get_soniox_key", side_effect=AssertionError("unknown state checked first")):
            with self.assertRaises(RuntimeError) as error:
                soniox_utils.transcribe_file(None, checkpoint=self.cache)
        self.assertEqual(error.exception.code, "media_delivery_unknown")

    def test_old_no_checkpoint_upload_error_keeps_original_exception_contract(self):
        with mock.patch.object(soniox_utils, "upload_file", side_effect=ConnectionError("legacy upload error")):
            with self.assertRaises(ConnectionError):
                soniox_utils.transcribe_file(self.source, api_key="fixture-key", sleep=lambda _seconds: None)


class FetchVoiceCheckpointPolicyTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sc-fetch-voice-fixture-")
        self.root = Path(self.temp.name)
        self.fetch = load_fetch_fixture(self.root)
        self.events = []
        self.fetch.emit = self.events.append
        self.fetch._SKIP_VOICE = {}
        self.fetch._VOICE_POLICY = VoicePolicy(kinds=["voice", "audio"], max_seconds=1200,
            state_dir=str(self.root / "state"), cache_dir=str(self.root / "media"), reuse_existing=True, min_free_bytes=1)
        self.downloads = 0

    def tearDown(self):
        self.temp.cleanup()

    def message(self, duration=10):
        async def download_media(**_kwargs):
            self.downloads += 1
            raise AssertionError("no download expected")
        return SimpleNamespace(id=10, peer_id=SimpleNamespace(channel_id=333),
            file=SimpleNamespace(duration=duration, size=11),
            media=SimpleNamespace(document=SimpleNamespace(id=991, attributes=[])), download_media=download_media)

    def downloadable_message(self, duration=10):
        message = self.message(duration)
        async def download_media(**kwargs):
            self.downloads += 1
            path = Path(kwargs["file"] + ".oga")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"OggSfixture")
            return str(path)
        message.download_media = download_media
        return message

    async def test_pre_download_type_and_duration_predicate_skips_paid_work(self):
        with mock.patch.object(soniox_utils, "transcribe_file", side_effect=AssertionError("must not transcribe")):
            for duration, kind in [(1201, "voice"), (10, "video"), (None, "voice")]:
                await self.fetch.process_media(self.message(duration), kind, transcribe_engine="soniox", process_voice=True)
        self.assertEqual(self.downloads, 0)
        self.assertEqual([event["reason_code"] for event in self.events], ["duration_limit", "type_not_allowed", "unknown_duration"])

    async def test_completed_any_engine_cache_reuse_avoids_download_credentials_and_redo(self):
        message = self.message()
        cache = self.fetch._VOICE_POLICY.cache(message, "soniox")
        cache.save({"state": "completed", "text": "prior speech", "engine": "assemblyai"})
        with mock.patch.object(soniox_utils, "get_soniox_key", side_effect=AssertionError("must not read credentials")), \
                mock.patch.object(soniox_utils, "transcribe_file", side_effect=AssertionError("must not redo")):
            await self.fetch.process_media(message, "voice", transcribe_engine="soniox", process_voice=True)
        self.assertEqual(self.downloads, 0)
        self.assertEqual(self.events[-1]["type"], "transcript")
        self.assertEqual(self.events[-1]["engine"], "assemblyai")
        self.assertTrue(self.events[-1]["reused"])

    async def test_unknown_upload_attempt_stops_before_second_download_or_stt(self):
        message = self.message()
        self.fetch._VOICE_POLICY.cache(message, "soniox").save({"state": "uploading"})
        with self.assertRaisesRegex(RuntimeError, "unknown"):
            await self.fetch.process_media(message, "voice", transcribe_engine="soniox", process_voice=True)
        self.assertEqual(self.downloads, 0)
        self.assertEqual(self.events[-1]["code"], "media_delivery_unknown")

    async def test_unmounted_or_low_space_cache_never_downloads_to_a_fallback(self):
        for low_space in (False, True):
            self.fetch._VOICE_POLICY.cache_dir = "/Volumes/fixture-night-volume/owned-media"
            with mock.patch.object(Path, "is_mount", return_value=low_space), \
                    mock.patch("tg_voice_policy.shutil.disk_usage", return_value=SimpleNamespace(free=0)):
                with self.assertRaises(MediaStorageError):
                    await self.fetch.process_media(self.message(), "voice", transcribe_engine="soniox", process_voice=True)
        self.assertEqual(self.downloads, 0)

    async def test_completed_reuse_works_without_selected_external_media_volume(self):
        message = self.message()
        self.fetch._VOICE_POLICY.cache(message, "soniox").save({"state": "completed", "text": "already saved"})
        self.fetch._VOICE_POLICY.cache_dir = "/Volumes/unplugged-night-fixture/media"
        with mock.patch.object(Path, "is_mount", return_value=False), \
                mock.patch.object(soniox_utils, "transcribe_file", side_effect=AssertionError("must reuse")):
            await self.fetch.process_media(message, "voice", transcribe_engine="soniox", process_voice=True)
        self.assertEqual(self.downloads, 0)
        self.assertTrue(self.events[-1]["reused"])

    async def test_known_provider_resumes_without_download_volume_probe_or_post(self):
        message = self.message()
        self.fetch._VOICE_POLICY.cache(message, "soniox").save({"state": "processing", "file_id": "known", "transcription_id": "tr-fixture"})
        self.fetch._VOICE_POLICY.cache_dir = "/Volumes/unplugged-night-fixture/media"
        calls = []
        def fake_http(url, **kwargs):
            calls.append(kwargs.get("method", "GET"))
            return {"tokens": [{"text": "resumed"}]} if url.endswith("/transcript") else {"status": "completed"}
        original = soniox_utils.transcribe_file
        def immediate(*args, **kwargs):
            return original(*args, api_key="fixture-key", sleep=lambda _seconds: None, **kwargs)
        with mock.patch.object(Path, "is_mount", return_value=False), \
                mock.patch.object(self.fetch, "_probe_audio", side_effect=AssertionError("must not probe")), \
                mock.patch.object(soniox_utils, "upload_file", side_effect=AssertionError("must not upload")), \
                mock.patch.object(soniox_utils, "http_json", side_effect=fake_http), \
                mock.patch.object(soniox_utils, "transcribe_file", side_effect=immediate):
            await self.fetch.process_media(message, "voice", transcribe_engine="soniox", process_voice=True)
        self.assertEqual(self.downloads, 0)
        self.assertNotIn("POST", calls)
        self.assertEqual(self.events[-1]["text"], "resumed")
        self.assertEqual(self.fetch._SPEECH_STATS["resumed_provider_jobs"], 1)

    async def test_probe_duration_over_cap_never_submits_provider(self):
        with mock.patch.object(self.fetch, "_probe_audio", return_value=(True, 1200.1)), \
                mock.patch.object(soniox_utils, "transcribe_file", side_effect=AssertionError("must not submit")):
            await self.fetch.process_media(self.downloadable_message(1200), "voice", transcribe_engine="soniox", process_voice=True)
        self.assertEqual(self.downloads, 1)
        self.assertEqual(self.fetch._SPEECH_STATS["skipped_duration"], 1)
        self.assertEqual(self.events[-1]["reason"], "duration_limit_after_probe")

    async def test_first_upload_and_create_ack_loss_are_fatal_to_fetch_immediately(self):
        for create_loss in (False, True):
            message = self.downloadable_message()
            message.id += int(create_loss)
            def provider_http(*_args, **_kwargs):
                raise ConnectionError("fixture lost create ACK")
            with mock.patch.object(self.fetch, "_probe_audio", return_value=(True, 10)), \
                    mock.patch.object(soniox_utils, "get_soniox_key", return_value="fixture-key"), \
                    mock.patch.object(soniox_utils, "upload_file", side_effect=None if create_loss else ConnectionError("fixture lost upload ACK"), return_value="file-fixture"), \
                    mock.patch.object(soniox_utils, "http_json", side_effect=provider_http):
                with self.assertRaises(RuntimeError) as first:
                    await self.fetch.process_media(message, "voice", transcribe_engine="soniox", process_voice=True)
            self.assertEqual(first.exception.code, "media_delivery_unknown")
            self.assertEqual(self.events[-1]["code"], "media_delivery_unknown")
            self.assertFalse(any(event["type"] == "transcript" for event in self.events))
            self.assertEqual(self.fetch._VOICE_POLICY.cache(message, "soniox").load()["state"], "creating" if create_loss else "uploading")

    async def test_non_soniox_optional_checkpoint_blocks_unknown_sdk_retry(self):
        message = self.downloadable_message()
        client = SimpleNamespace(transcribe_audio=mock.Mock(side_effect=ConnectionError("SDK ACK loss")))
        with mock.patch.object(self.fetch, "_probe_audio", return_value=(True, 10)), \
                mock.patch.object(self.fetch, "_make_gemini_client", return_value=client):
            with self.assertRaises(UnknownMediaDelivery):
                await self.fetch.process_media(message, "voice", transcribe_engine="assemblyai", process_voice=True)
            with self.assertRaises(UnknownMediaDelivery):
                await self.fetch.process_media(message, "voice", transcribe_engine="assemblyai", process_voice=True)
        self.assertEqual(client.transcribe_audio.call_count, 1)
        self.assertEqual(self.downloads, 1)

    async def test_old_unbounded_no_checkpoint_non_soniox_success_stays_available(self):
        self.fetch._VOICE_POLICY = VoicePolicy()
        client = SimpleNamespace(transcribe_audio=mock.Mock(return_value=("legacy result", None)))
        message = self.downloadable_message(1800)
        async def local_download(**_kwargs):
            self.downloads += 1
            path = self.root / "legacy.oga"
            path.write_bytes(b"OggSfixture")
            return str(path)
        message.download_media = local_download
        with mock.patch.object(self.fetch, "_probe_audio", return_value=(True, 1800)), \
                mock.patch.object(self.fetch, "_make_gemini_client", return_value=client):
            await self.fetch.process_media(message, "video", transcribe_engine="assemblyai", process_voice=True)
        self.assertEqual(self.events[-1]["text"], "legacy result")

    async def test_empty_result_emits_no_speech_not_empty_success_transcript(self):
        with mock.patch.object(self.fetch, "_probe_audio", return_value=(True, 10)), \
                mock.patch.object(soniox_utils, "transcribe_file", return_value=("", None, {})):
            await self.fetch.process_media(self.downloadable_message(), "voice", transcribe_engine="soniox", process_voice=True)
        self.assertEqual(self.events[-1]["reason_code"], "no_speech")
        self.assertEqual(self.fetch._SPEECH_STATS["no_speech"], 1)


class MediaDirectoryFenceTest(unittest.TestCase):
    def test_external_symlink_escape_is_rejected_before_mkdir_or_disk_io(self):
        real_resolve = Path.resolve
        def escaping(path, *_args, **_kwargs):
            return Path("/tmp/system-disk-cache") if str(path).endswith("/owned") else real_resolve(path)
        with mock.patch.object(Path, "is_mount", return_value=True), \
                mock.patch.object(Path, "resolve", escaping), \
                mock.patch.object(Path, "mkdir", side_effect=AssertionError("must not create fallback")):
            with self.assertRaises(MediaStorageError):
                checked_directory("/Volumes/fixture-external/owned")

    def test_mount_inode_change_is_rejected_before_download(self):
        with mock.patch("tg_voice_policy.media_directory_fence", return_value=(Path("/Volumes/fixture/owned"), ("/Volumes/fixture", 2, 999))):
            with self.assertRaises(MediaStorageError):
                verify_media_directory_fence("/Volumes/fixture/owned", ("/Volumes/fixture", 2, 100))


if __name__ == "__main__":
    unittest.main()
