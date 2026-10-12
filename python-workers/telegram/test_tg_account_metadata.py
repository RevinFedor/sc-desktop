import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


class MetadataTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sc-account-meta-fixture-")
        self.root = Path(self.tmp.name)
        credentials = ModuleType("credentials")
        credentials.telegram_credentials = lambda: (123, "fixture-only")
        locations = ModuleType("tg_session_path")
        locations.USER_SESSION_DIR = self.root / "user"
        locations.session_dirs = lambda _here: [self.root / "user"]
        spec = importlib.util.spec_from_file_location("_account_metadata_fixture", HERE / "tg_sessions_ndjson.py")
        self.worker = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"credentials": credentials, "tg_session_path": locations}):
            spec.loader.exec_module(self.worker)
        self.path = locations.USER_SESSION_DIR / "old.session"
        self.path.write_bytes(b"existing auth fixture")

    def tearDown(self): self.tmp.cleanup()

    def test_verified_label_survives_legacy_ui_identity_cache_replacement(self):
        self.assertTrue(self.worker._write_session_meta(self.path, {"id": 300, "label": "Менеджер FlowTab", "first_name": "Manager"}))
        self.worker._meta_path(self.path).write_text(json.dumps({"id": 300, "first_name": "Manager"}))
        self.assertEqual(self.worker._read_session_meta(self.path)["label"], "Менеджер FlowTab")
        self.assertEqual(self.path.read_bytes(), b"existing auth fixture")

    def test_refresh_same_account_preserves_binding_without_overwriting_session(self):
        self.worker._write_session_meta(self.path, {"id": 300, "label": "support"})
        self.worker._write_session_meta(self.path, {"id": 300, "username": "manager"})
        self.assertEqual(self.worker._read_session_meta(self.path)["label"], "support")
        self.assertEqual(self.path.read_bytes(), b"existing auth fixture")

    def test_new_identity_cannot_inherit_previous_account_label(self):
        self.worker._write_session_meta(self.path, {"id": 300, "label": "support"})
        self.worker._write_session_meta(self.path, {"id": 400, "first_name": "Different"})
        self.assertIsNone(self.worker._read_session_meta(self.path).get("label"))

    def test_invalid_cache_is_advisory_not_auth_proof(self):
        self.worker._meta_path(self.path).write_text('[]')
        self.assertIsNone(self.worker._read_session_meta(self.path))
        self.assertEqual(self.path.read_bytes(), b"existing auth fixture")


if __name__ == "__main__": unittest.main()
