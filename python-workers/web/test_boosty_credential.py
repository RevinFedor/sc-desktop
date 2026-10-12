import os
import sys
import tempfile
import unittest
import json
import hashlib
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared.boosty_soniox_credential import put, load, describe, bind_budget


class Credentials(unittest.TestCase):
    def test_private_separate_ref_no_public_secret_or_shared_setting_write(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'SC_DESKTOP_DIR': tmp}):
            secret = 'TESTONLY-NEVER-REAL-KEY-123456'
            out = put(secret)
            self.assertNotIn(secret, str(out)); self.assertNotIn(secret, str(describe(out['credential_ref'])))
            self.assertEqual(load(out['credential_ref'])['key'], secret)
            self.assertFalse(out['provider_project_cap_confirmed'])
            self.assertFalse((Path(tmp) / 'settings.json').exists())
            file = next((Path(tmp) / 'secrets/boosty-soniox').glob('*.json'))
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
    def test_invalid_key_never_echoed(self):
        with self.assertRaises(ValueError): put('malformed\nprivate')
    def test_wrong_scope_rejected(self):
        with self.assertRaises(ValueError): load('voice-record:00000000-0000-0000-0000-000000000000')
    def test_existing_ref_budget_binds_only_matching_console_project_key_no_secret_reintake(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'SC_DESKTOP_DIR': tmp}):
            secret = 'TESTONLY-NEVER-REAL-KEY-123456'; ref = put(secret)['credential_ref']
            proof = Path(tmp) / 'console-proof.json'
            evidence = {'credential_ref': ref, 'secret_value_present_in_artifact': False,
                'user_ASR_model_cost_release': True, 'model': 'stt-async-v5', 'cap_verified_after_fresh_GET': True,
                'autopay_existing_enabled': False, 'project_monthly_limit_after_USD': 20,
                'budget_max_new_spend_USD': 20, 'provider_project': '11111111-1111-4111-8111-111111111111',
                'provider_org': '22222222-2222-4222-8222-222222222222', 'provider_enforcement_delay_warning': ['delayed']}
            proof.write_text(json.dumps(evidence))
            with self.assertRaises(ValueError): bind_budget(ref, proof, 17, 'f' * 64)
            self.assertFalse(describe(ref)['provider_project_cap_confirmed'])
            out = bind_budget(ref, proof, 17, hashlib.sha256(secret[:17].encode()).hexdigest())
            self.assertEqual(out['credential_ref'], ref); self.assertTrue(out['provider_project_cap_confirmed'])
            self.assertFalse(out['provider_cap_is_absolute_guarantee']); self.assertNotIn(secret, str(out))
            self.assertEqual(load(ref)['key'], secret)
            evidence['autopay_existing_enabled'] = True; proof.write_text(json.dumps(evidence))
            with self.assertRaises(ValueError): bind_budget(ref, proof, 17, hashlib.sha256(secret[:17].encode()).hexdigest())


if __name__ == '__main__': unittest.main()
