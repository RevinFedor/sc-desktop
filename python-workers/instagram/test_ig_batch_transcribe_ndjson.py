import unittest

from ig_batch_transcribe_ndjson import (
    AUDIO_NO_TEXT_CODE,
    AUDIO_NO_TEXT_MESSAGE,
    _transcription_failure,
)


class InstagramTranscriptionFailureTests(unittest.TestCase):
    def test_empty_model_output_after_audio_prepare_has_machine_code(self):
        failure = _transcription_failure(
            text=None,
            error="Model returned no text",
            empty_text_error="Model returned no text",
            cost_usd=0.000026,
        )

        self.assertEqual(failure["code"], AUDIO_NO_TEXT_CODE)
        self.assertEqual(failure["message"], AUDIO_NO_TEXT_MESSAGE)
        self.assertEqual(failure["cost_usd"], 0.000026)

    def test_other_transcription_failures_keep_the_original_reason(self):
        failure = _transcription_failure(
            text=None,
            error="HTTP 500",
            empty_text_error="Model returned no text",
        )

        self.assertIsNone(failure["code"])
        self.assertEqual(failure["message"], "transcribe failed: HTTP 500")
        self.assertEqual(failure["cost_usd"], 0)


if __name__ == "__main__":
    unittest.main()
