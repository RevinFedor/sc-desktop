import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import boosty_api
import boosty_cli
import boosty_single_ndjson


class BoostyApiTests(unittest.TestCase):
    def test_cli_distinguishes_author_from_post_and_purchase_links(self):
        self.assertTrue(boosty_cli.is_channel_url("https://boosty.to/youareaageek/"))
        self.assertFalse(boosty_cli.is_channel_url(
            "https://boosty.to/youareaageek/posts/0431972d-f8c4-4d1b-b54e-440db9602629"
        ))
        self.assertFalse(boosty_cli.is_channel_url(
            "https://boosty.to/youareaageek/purchase/3997527?layer=video%3Ax%3Ay%3Az"
        ))

    def test_purchase_link_resolves_to_post_and_selected_video(self):
        value = boosty_api.canonicalize_post_url(
            "https://boosty.to/youareaageek/purchase/3997527?"
            "layer=video%3Ayouareaageek%3A9f342949-97c4-4861-ada7-2cb5e54199fe%3A"
            "8504941c-41fe-4749-9d02-27085221e3cd"
        )
        self.assertEqual(value["author"], "youareaageek")
        self.assertEqual(value["post_id"], "9f342949-97c4-4861-ada7-2cb5e54199fe")
        self.assertEqual(value["video_id"], "8504941c-41fe-4749-9d02-27085221e3cd")
        self.assertNotIn("purchase", value["canonical_url"])

    def test_post_normalization_keeps_every_video_but_no_signed_urls(self):
        raw = {
            "id": "0431972d-f8c4-4d1b-b54e-440db9602629",
            "title": "Two videos",
            "hasAccess": True,
            "contentCounters": [{"type": "ok_video", "count": 2}],
            "data": [
                {
                    "type": "ok_video",
                    "id": "fe5ec7ba-44a0-4565-8f27-4c0a84934c13",
                    "title": "One",
                    "duration": 10,
                    "preview": "https://images.boosty.to/image/one",
                    "playerUrls": [{"url": "https://signed.invalid/secret"}],
                },
                {
                    "type": "ok_video",
                    "id": "01be44b4-9f73-4c0a-80ea-ca033bca7bf3",
                    "title": "Two",
                    "duration": 20,
                    "preview": "https://images.boosty.to/image/two",
                    "playerUrls": [{"url": "https://signed.invalid/secret-2"}],
                },
            ],
        }
        post = boosty_api.normalize_post(raw, "youareaageek")
        self.assertEqual(post["video_count"], 2)
        self.assertEqual(len(post["videos"]), 2)
        self.assertNotIn("playerUrls", repr(post))
        selected = boosty_single_ndjson.select_videos(
            {"entries": [{"id": row["video_id"]} for row in post["videos"]]},
            None,
        )
        self.assertEqual(len(selected), 2)

    def test_catalog_follows_opaque_cursor_until_is_last(self):
        calls = []

        def fake_get(path, token=None, params=None, timeout=45):
            calls.append(dict(params or {}))
            if len(calls) == 1:
                return {
                    "data": [{"id": "one", "hasAccess": True, "data": []}],
                    "extra": {"offset": "opaque-next", "isLast": False},
                }
            return {
                "data": [{"id": "two", "hasAccess": True, "data": []}],
                "extra": {"offset": None, "isLast": True},
            }

        with mock.patch.object(boosty_api, "api_get", side_effect=fake_get):
            pages = list(boosty_api.iter_posts("author", "token", page_size=300))

        self.assertEqual([[row["post_id"] for row in page] for page, _ in pages], [["one"], ["two"]])
        self.assertIsNone(calls[0]["offset"])
        self.assertEqual(calls[1]["offset"], "opaque-next")
        self.assertTrue(pages[-1][1]["is_last"])

    def test_thumbnail_cache_resizes_source_png_to_small_webp(self):
        source = io.BytesIO()
        Image.new("RGB", (1672, 941), (120, 60, 20)).save(source, format="PNG")
        raw = source.getvalue()

        class Response(io.BytesIO):
            headers = {"Content-Type": "image/png"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(boosty_api.urllib.request, "urlopen", return_value=Response(raw)):
                result = boosty_api.download_thumbnail(
                    "https://images.boosty.to/image/example",
                    directory,
                    "author",
                    "video-id",
                )
            path = Path(result)
            self.assertEqual(path.suffix, ".webp")
            self.assertLess(path.stat().st_size, len(raw))
            with Image.open(path) as image:
                self.assertLessEqual(max(image.size), 512)


if __name__ == "__main__":
    unittest.main()
