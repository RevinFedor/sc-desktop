import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("yt_channel_ndjson.py")
SPEC = importlib.util.spec_from_file_location("yt_channel_ndjson", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class YoutubeChannelCatalogTest(unittest.TestCase):
    def test_zero_limit_means_no_playlist_cap(self):
        command = MODULE.build_channel_command("https://youtube.com/@demo/videos", 0, False)
        self.assertNotIn("--playlist-end", command)

    def test_positive_limit_is_forwarded(self):
        command = MODULE.build_channel_command("https://youtube.com/@demo/videos", 50, True)
        index = command.index("--playlist-end")
        self.assertEqual(command[index + 1], "50")
        self.assertIn("--playlist-reverse", command)

    def test_coverage_distinguishes_complete_from_capped(self):
        self.assertEqual(MODULE.catalog_coverage(43, 50), {"complete": True, "total": 43})
        self.assertEqual(MODULE.catalog_coverage(50, 50), {"complete": False, "total": None})
        self.assertEqual(MODULE.catalog_coverage(243, 0), {"complete": True, "total": 243})


if __name__ == "__main__":
    unittest.main()
