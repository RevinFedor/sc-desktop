import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from test_tg_voice_checkpoint import load_fetch_fixture
with tempfile.TemporaryDirectory(prefix="sc-policy-import-fixture-") as import_root:
    fetch = load_fetch_fixture(Path(import_root))
from tg_voice_policy import VoicePolicy, MediaStorageError


class VoicePolicyTest(unittest.TestCase):
    def message(self, duration, path, identifier=10):
        async def download_media(**kwargs):
            self.downloads += 1
            return str(path)
        doc = SimpleNamespace(id=991, attributes=[])
        return SimpleNamespace(id=identifier, media=SimpleNamespace(document=doc),
                               file=SimpleNamespace(duration=duration, size=10),
                               peer_id=SimpleNamespace(channel_id=333), download_media=download_media)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / "voice.ogg"
        self.downloads, self.stt = 0, 0
        self.events = []
        self.old_policy = fetch._VOICE_POLICY
        self.old_skip = fetch._SKIP_VOICE
        fetch._SKIP_VOICE = {}
        fetch._VOICE_POLICY = VoicePolicy(kinds=["voice", "audio"], max_seconds=1200,
                                         cache_dir=str(self.root / "media"), state_dir=str(self.root / "state"),
                                         reuse_existing=True, min_free_bytes=1)

    def tearDown(self):
        fetch._VOICE_POLICY, fetch._SKIP_VOICE = self.old_policy, self.old_skip
        self.temp.cleanup()

    def run_media(self, duration, kind="voice"):
        self.path.write_bytes(b"fixture")
        def soniox(source, **kwargs):
            self.stt += 1
            kwargs["checkpoint"].save({"state": "completed", "text": "own speech", "engine": "soniox"})
            return "own speech", None, {}
        with patch.object(fetch, "emit", self.events.append), \
             patch.object(fetch, "_probe_audio", return_value=(True, duration)), \
             patch.object(fetch, "_make_gemini_client", side_effect=AssertionError("Soniox must not require Gemini")), \
             patch("soniox_utils.transcribe_file", side_effect=soniox):
            asyncio.run(fetch.process_media(self.message(duration, self.path), kind,
                                           transcribe_engine="soniox", process_voice=True))

    def test_1200_is_inclusive_before_download_and_soniox_needs_no_gemini(self):
        self.run_media(1200)
        self.assertEqual((self.downloads, self.stt), (1, 1))
        self.assertTrue(any(event["type"] == "transcript" for event in self.events))

    def test_1201_and_video_do_not_download_or_call_stt(self):
        self.run_media(1201)
        self.run_media(5, "video")
        self.assertEqual((self.downloads, self.stt), (0, 0))
        self.assertEqual([event["reason_code"] for event in self.events], ["duration_limit", "type_not_allowed"])

    def test_unknown_invalid_duration_is_honestly_skipped(self):
        for duration in (None, 0, -1, float("nan"), float("inf"), True):
            self.run_media(duration)
        self.assertEqual((self.downloads, self.stt), (0, 0))
        self.assertTrue(all(event["reason_code"] == "unknown_duration" for event in self.events))

    def test_audio_and_complete_cache_reuse_avoid_duplicate_paid_calls(self):
        self.run_media(30, "audio")
        self.run_media(30, "audio")
        self.assertEqual((self.downloads, self.stt), (1, 1))
        self.assertTrue(any(event.get("reused") for event in self.events))

    def test_database_existing_transcript_reused_across_engine(self):
        fetch._SKIP_VOICE = {"10": "assemblyai"}
        self.run_media(10)
        self.assertEqual((self.downloads, self.stt), (0, 0))

    def test_unmounted_external_directory_never_falls_back_to_tmp(self):
        fetch._VOICE_POLICY.cache_dir = "/Volumes/missing-night-volume/owned-cache"
        with patch("pathlib.Path.is_mount", return_value=False):
            with self.assertRaises(MediaStorageError):
                self.run_media(20)
        self.assertEqual((self.downloads, self.stt), (0, 0))

    def test_defaults_preserve_video_and_unknown_unbounded_flow(self):
        policy = VoicePolicy()
        self.assertEqual(policy.decision(self.message(None, self.path), "video"), (None, None))

if __name__ == "__main__":
    unittest.main()
