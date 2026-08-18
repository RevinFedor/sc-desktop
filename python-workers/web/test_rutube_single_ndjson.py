from contextlib import redirect_stdout
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import rutube_single_ndjson as worker
from rutube_single_ndjson import clean_srt, extract_rutube_id, write_transcript


VIDEO_ID = "a10f2d8e8cceac4d3d8b20800c2290a5"


class RutubeSingleWorkerTests(unittest.TestCase):
    def metadata(self):
        return {
            "id": VIDEO_ID,
            "title": "Тестовое видео",
            "channel": "Автор",
            "duration_sec": 120,
            "thumbnail_url": None,
            "webpage_url": f"https://rutube.ru/video/{VIDEO_ID}/",
        }

    def test_extracts_supported_rutube_urls(self):
        urls = (
            f"https://rutube.ru/video/{VIDEO_ID}/",
            f"https://rutube.ru/video/private/{VIDEO_ID}/?p=token",
            f"https://rutube.ru/play/embed/{VIDEO_ID}",
            f"https://rutube.ru/embed/{VIDEO_ID}?t=30",
        )
        for url in urls:
            with self.subTest(url=url):
                self.assertEqual(extract_rutube_id(url), VIDEO_ID)

    def test_rejects_channel_and_foreign_urls(self):
        self.assertIsNone(extract_rutube_id("https://rutube.ru/channel/123/videos/"))
        self.assertIsNone(extract_rutube_id(f"https://youtube.com/watch?v={VIDEO_ID}"))

    def test_cleans_srt_and_deduplicates_adjacent_cues(self):
        raw = """1
00:00:01,000 --> 00:00:03,000
<b>Первая строка</b>

2
00:00:03,000 --> 00:00:05,000
Первая строка

3
00:00:05,000 --> 00:00:07,000
Вторая &amp; строка
"""
        self.assertEqual(clean_srt(raw), "Первая строка\nВторая & строка")
        timed = clean_srt(raw, with_timestamps=True)
        self.assertIn("[00:00:01] Первая строка", timed)
        self.assertIn("[00:00:05] Вторая & строка", timed)

    def test_writes_self_describing_transcript(self):
        meta = self.metadata()
        with tempfile.TemporaryDirectory() as temp_dir:
            output = write_transcript(temp_dir, meta, "Готовый текст", lang="ru")
            text = Path(output).read_text(encoding="utf-8")
        self.assertIn("source: subs", text)
        self.assertIn("lang: ru", text)
        self.assertTrue(text.endswith("Готовый текст"))

    def test_missing_subtitles_stop_before_paid_ai(self):
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as temp_dir, \
             mock.patch.object(worker, "fetch_metadata", return_value=(self.metadata(), None)), \
             mock.patch.object(worker, "stage_subtitles", return_value=None), \
             mock.patch.object(worker, "stage_ai") as stage_ai, \
             redirect_stdout(output):
            status = worker.main([
                f"https://rutube.ru/video/{VIDEO_ID}/",
                "--out-dir", temp_dir,
            ])
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(status, 0)
        self.assertIn("subs_missing", [event["type"] for event in events])
        stage_ai.assert_not_called()

    def test_ai_runs_only_with_explicit_flag(self):
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as temp_dir, \
             mock.patch.object(worker, "fetch_metadata", return_value=(self.metadata(), None)), \
             mock.patch.object(worker, "stage_subtitles") as stage_subtitles, \
             mock.patch.object(worker, "stage_ai", return_value="/tmp/result.txt") as stage_ai, \
             redirect_stdout(output):
            status = worker.main([
                f"https://rutube.ru/video/{VIDEO_ID}/",
                "--out-dir", temp_dir,
                "--ai",
                "--engine", "assemblyai",
            ])
        self.assertEqual(status, 0)
        stage_subtitles.assert_not_called()
        stage_ai.assert_called_once()
        self.assertEqual(stage_ai.call_args.args[1], "assemblyai")


if __name__ == "__main__":
    unittest.main()
