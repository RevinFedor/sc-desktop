import unittest

from gemini_utils import EMPTY_TEXT_ERROR, GeminiClient


class GeminiResponseParsingTests(unittest.TestCase):
    def test_stop_candidate_without_parts_is_empty_text_not_key_error(self):
        client = GeminiClient.__new__(GeminiClient)
        client.total_input_tokens = 0
        client.total_output_tokens = 0

        text, error = client._parse_response({
            "candidates": [{
                "content": {"role": "model"},
                "finishReason": "STOP",
                "index": 0,
            }],
            "usageMetadata": {
                "promptTokenCount": 258,
                "totalTokenCount": 258,
            },
        })

        self.assertIsNone(text)
        self.assertEqual(error, EMPTY_TEXT_ERROR)
        self.assertEqual(client.total_input_tokens, 258)


if __name__ == "__main__":
    unittest.main()
