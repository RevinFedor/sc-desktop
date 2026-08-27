import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tg_live_ndjson import parse_message_url


class TelegramLiveUrlTests(unittest.TestCase):
    def test_private_chat_and_forum_urls(self):
        plain = parse_message_url("https://t.me/c/2719624138/5299")
        self.assertEqual(plain["chat"], "2719624138")
        self.assertEqual(plain["message_id"], 5299)
        self.assertIsNone(plain["topic_id"])

        forum = parse_message_url("https://t.me/c/1769090887/22875/45751?single")
        self.assertEqual(forum["chat_key"], "c:1769090887")
        self.assertEqual(forum["topic_id"], 22875)
        self.assertEqual(forum["message_id"], 45751)

    def test_public_url(self):
        parsed = parse_message_url("https://t.me/neuraldeepchat/123")
        self.assertEqual(parsed["chat"], "neuraldeepchat")
        self.assertEqual(parsed["chat_key"], "u:neuraldeepchat")
        self.assertEqual(parsed["message_id"], 123)

    def test_rejects_non_message_urls(self):
        self.assertIsNone(parse_message_url("https://example.com/c/1/2"))
        self.assertIsNone(parse_message_url("https://t.me/neuraldeepchat"))


if __name__ == "__main__":
    unittest.main()
