import unittest
from unittest import mock

import local_transcribe_ndjson


class LocalSonioxWrapperTest(unittest.TestCase):
    def test_existing_local_file_flow_keeps_progress_and_domain_terms(self):
        seen = {}

        def shared_transcribe(source, **kwargs):
            seen.update({"source": source, **kwargs})
            kwargs["progress_callback"](stage="processing", status="processing", attempt=1)
            return "готово", None, {"token_count": 1}

        events = []
        with mock.patch.object(
            local_transcribe_ndjson,
            "transcribe_soniox_file",
            side_effect=shared_transcribe,
        ), mock.patch.object(local_transcribe_ndjson, "emit", side_effect=events.append):
            result = local_transcribe_ndjson.transcribe_soniox("fixture.ogg", timings=True)

        self.assertEqual(result[0], "готово")
        self.assertTrue(seen["timings"])
        self.assertIn("Codex", seen["context_terms"])
        self.assertEqual(events[0]["type"], "transcribe_progress")
        self.assertEqual(events[0]["engine"], "soniox")
        self.assertEqual(events[0]["stage"], "processing")


if __name__ == "__main__":
    unittest.main()
