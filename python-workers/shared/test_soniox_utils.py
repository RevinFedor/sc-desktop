import tempfile
import unittest
from pathlib import Path
from unittest import mock

import soniox_utils


class SonioxUtilsTest(unittest.TestCase):
    def test_transcribes_one_file_with_bounded_context_and_cleans_remote_objects(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "voice.oga"
            source.write_bytes(b"OggSfixture")
            requests = []

            def fake_http(url, **kwargs):
                requests.append((url, kwargs))
                if kwargs.get("method") == "DELETE":
                    return {}
                if url.endswith("/v1/transcriptions"):
                    return {"id": "tr-1"}
                if url.endswith("/tr-1/transcript"):
                    return {
                        "tokens": [
                            {"text": " Привет", "start_ms": 0, "end_ms": 200},
                            {"text": " , мир", "start_ms": 210, "end_ms": 500},
                        ]
                    }
                if url.endswith("/tr-1"):
                    return {"status": "completed"}
                raise AssertionError(url)

            progress = []
            with mock.patch.object(soniox_utils, "upload_file", return_value="file-1"), \
                    mock.patch.object(soniox_utils, "http_json", side_effect=fake_http):
                text, error, details = soniox_utils.transcribe_file(
                    source,
                    api_key="test-key",
                    sleep=lambda _seconds: None,
                    language_hints=["RU", "en", "ru"],
                    context_text="чат про Таиланд",
                    context_general=[{"key": "chat", "value": "ОМ: Таиланд"}],
                    client_reference_id="telegram-37314",
                    progress_callback=lambda **event: progress.append(event),
                )

            self.assertIsNone(error)
            self.assertEqual(text, "Привет, мир")
            self.assertEqual(details["model"], "stt-async-v5")
            create = next(kwargs for url, kwargs in requests if url.endswith("/v1/transcriptions"))
            self.assertEqual(create["body"]["language_hints"], ["ru", "en"])
            self.assertEqual(create["body"]["context"]["text"], "чат про Таиланд")
            self.assertEqual(
                create["body"]["context"]["general"],
                [{"key": "chat", "value": "ОМ: Таиланд"}],
            )
            self.assertEqual(progress[0]["stage"], "uploading")
            self.assertEqual(progress[-1]["stage"], "fetching")
            deletes = [url for url, kwargs in requests if kwargs.get("method") == "DELETE"]
            self.assertEqual(len(deletes), 2)

    def test_missing_key_is_an_explicit_non_success(self):
        with mock.patch.object(soniox_utils, "get_soniox_key", return_value=None):
            text, error, details = soniox_utils.transcribe_file("missing.ogg")
        self.assertIsNone(text)
        self.assertEqual(error, "SONIOX_API_KEY not configured")
        self.assertEqual(details, {})


if __name__ == "__main__":
    unittest.main()
