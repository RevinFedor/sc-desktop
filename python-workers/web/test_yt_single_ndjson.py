import tempfile
import unittest
from pathlib import Path

from yt_single_ndjson import write_text_file


class YoutubeTimedTranscriptTests(unittest.TestCase):
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
