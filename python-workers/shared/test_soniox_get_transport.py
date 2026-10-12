import http.client
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import soniox_utils as soniox


URL = "https://api.soniox.com/v1/transcriptions/known-id/transcript"
KEY = "private-test-key"


class SonioxAlternateGetTest(unittest.TestCase):
    def run_fallback(self, stdout=b'{"id":"known-id","text":"full","tokens":[]}', code=0):
        runner = patch.object(soniox.subprocess, "run", return_value=SimpleNamespace(
            returncode=code, stdout=stdout, stderr=KEY.encode()))
        with patch.object(soniox.shutil, "which", return_value="/usr/bin/curl"), runner as call:
            result = soniox._curl_json_get(URL, {"Authorization": "Bearer " + KEY}, 600)
            return result, call

    def test_full_unicode_json_after_native_incomplete_read(self):
        expected = {"id": "known-id", "text": "Привет😀" * 12000, "tokens": [{"text":"full"}]}
        with patch.object(soniox.urllib.request, "urlopen", side_effect=http.client.IncompleteRead(b"short", 100)), \
                patch.object(soniox.time, "sleep"), patch.object(soniox.shutil, "which", return_value="/usr/bin/curl"), \
                patch.object(soniox.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(expected).encode(), stderr=b"")) as call:
            self.assertEqual(soniox.http_json(URL, key=KEY), expected)
            self.assertEqual(call.call_count, 1)

    def test_credentials_only_in_stdin_and_bounded_no_redirect_no_retry(self):
        _, call = self.run_fallback()
        argv = call.call_args.args[0]
        self.assertNotIn(KEY, " ".join(argv))
        self.assertIn(KEY.encode(), call.call_args.kwargs["input"])
        self.assertIn(b'request = "GET"', call.call_args.kwargs["input"])
        self.assertIn("--disable", argv)
        self.assertIn("--http2", argv)
        self.assertNotIn("--location", argv)
        self.assertNotIn("--retry", argv)
        self.assertLessEqual(call.call_args.kwargs["timeout"], 65)

    def test_no_paid_or_delete_fallback(self):
        for method in ("POST", "DELETE"):
            with patch.object(soniox.urllib.request, "urlopen", side_effect=http.client.IncompleteRead(b"short",100)), \
                    patch.object(soniox, "_curl_json_get") as fallback:
                with self.assertRaises(http.client.IncompleteRead):
                    soniox.http_json(URL, key=KEY, method=method)
                fallback.assert_not_called()

    def test_post_does_not_automatically_retry(self):
        with patch.object(soniox.urllib.request,"urlopen",side_effect=ConnectionError("network")) as call:
            with self.assertRaises(ConnectionError):
                soniox.http_json(URL,key=KEY,method="POST",body={})
            self.assertEqual(call.call_count,1)

    def test_missing_curl_preserves_original_read_failure(self):
        with patch.object(soniox.urllib.request,"urlopen",side_effect=http.client.IncompleteRead(b"short",100)), \
                patch.object(soniox.time,"sleep"), patch.object(soniox.shutil,"which",return_value=None):
            with self.assertRaises(http.client.IncompleteRead):
                soniox.http_json(URL,key=KEY)

    def test_reject_partial_json_not_partial_text_success(self):
        with self.assertRaisesRegex(RuntimeError,"incomplete/invalid JSON"):
            self.run_fallback(b'{"id":"known-id","text":"partial",')

    def test_reject_other_transcription_identity(self):
        with self.assertRaisesRegex(RuntimeError,"identity/shape mismatch"):
            self.run_fallback(b'{"id":"different-id","text":"full","tokens":[]}')

    def test_reject_missing_full_transcript_fields(self):
        for value in ({"id":"known-id","tokens":[]}, {"id":"known-id","text":"full"}):
            with self.assertRaisesRegex(RuntimeError,"identity/shape mismatch"):
                self.run_fallback(json.dumps(value).encode())

    def test_failure_does_not_expose_secret_output(self):
        with self.assertRaises(RuntimeError) as error:
            self.run_fallback(stdout=KEY.encode(),code=18)
        self.assertNotIn(KEY,str(error.exception))

    def test_header_injection_cannot_reconfigure_method_or_output(self):
        with patch.object(soniox.shutil,"which",return_value="/usr/bin/curl"), patch.object(soniox.subprocess,"run") as call:
            with self.assertRaisesRegex(RuntimeError,"headers are invalid"):
                soniox._curl_json_get(URL,{"Authorization": 'Bearer key\nrequest = "POST"'},10)
            call.assert_not_called()

    def test_only_https_soniox_origin(self):
        with patch.object(soniox.shutil,"which",return_value="/usr/bin/curl"), patch.object(soniox.subprocess,"run") as call:
            for url in ("http://api.soniox.com/v1/files", "https://api.soniox.com.evil/v1/files", "https://user:pass@api.soniox.com/v1/files", "https://api.soniox.com/v1/files#fragment"):
                self.assertIsNone(soniox._curl_json_get(url,{"Authorization": "Bearer " + KEY},10))
            call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
