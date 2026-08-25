import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from yt_single_ndjson import _format_timestamp_ms, extract_subtitles, write_text_file


class YoutubeTimedTranscriptTests(unittest.TestCase):
    def test_timestamp_formatter_preserves_milliseconds(self):
        self.assertEqual(_format_timestamp_ms(45.68), "00:00:45.680")
        self.assertEqual(_format_timestamp_ms(3661.004), "01:01:01.004")

    @patch("yt_single_ndjson._try_yt_dlp_subs")
    @patch("yt_single_ndjson._try_transcript_api", return_value="[00:00:01] Fast captions")
    def test_fast_transcript_does_not_start_yt_dlp(self, _api, yt_dlp):
        result = extract_subtitles("https://www.youtube.com/watch?v=inEFOFIEYlk", "en", True)

        self.assertEqual(result, "[00:00:01] Fast captions")
        yt_dlp.assert_not_called()

    def test_timestamped_output_does_not_overwrite_plain_transcript(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            plain = write_text_file(
                temp_dir,
                "inEFOFIEYlk",
                "Тестовое видео",
                "Канал",
                "https://www.youtube.com/watch?v=inEFOFIEYlk",
                "Обычный текст",
                lang="ru",
                with_ts=False,
            )
            timed = write_text_file(
                temp_dir,
                "inEFOFIEYlk",
                "Тестовое видео",
                "Канал",
                "https://www.youtube.com/watch?v=inEFOFIEYlk",
                "[00:00:03] Текст с таймкодом",
                lang="ru",
                with_ts=True,
            )

            self.assertNotEqual(plain, timed)
            self.assertTrue(timed.endswith("__timestamps.txt"))
            self.assertEqual(Path(plain).read_text(encoding="utf-8").splitlines()[-1], "Обычный текст")
            timed_text = Path(timed).read_text(encoding="utf-8")
            self.assertIn("timestamps: yes", timed_text)
            self.assertTrue(timed_text.endswith("[00:00:03] Текст с таймкодом"))


if __name__ == "__main__":
    unittest.main()
