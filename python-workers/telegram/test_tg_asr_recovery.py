import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import tg_asr_recovery_ndjson as recovery

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.identity={'peer':['channel',123],'message_id':7,'document_id':'11','size':42}
        digest=hashlib.sha256(json.dumps(self.identity,sort_keys=True).encode()).hexdigest()
        self.file=Path(self.tmp.name)/(digest+'.json')
        self.value={'version':1,'identity':self.identity,'engine':'soniox','state':'uploading'}
        self.file.write_text(json.dumps(self.value))
        self.request={'state_dir':self.tmp.name,'expected_peer_id':-100123,'message_ids':[7,8],
          'originally_blocked_ids':[7],'started_at':1791344000,'finished_at':1791344200,
          'original_request_id':'original'}
        self.provider={'id':'file-1','filename':digest+'.oga','size':42,'created_at':'2026-10-07T03:35:00Z'}
        # Timestamp is deliberately bound exactly to this synthetic attempt.
        timestamp=recovery.datetime.fromisoformat(self.provider['created_at'].replace('Z','+00:00')).timestamp()
        self.request.update(started_at=timestamp-5,finished_at=timestamp+5)
    def provider(self,*args,**kwargs):
        return {'files':[self.provider], 'next_page_cursor':None}
    def test_empty_complete_inventory_never_clears_upload_unknown_and_other_ids_stay_safe(self):
        with patch.object(recovery,'get_soniox_key',return_value='fixture'):
            out=recovery.inspect(self.request,lambda *a,**k:{'files':[],'next_page_cursor':None})
        self.assertEqual(out['blocked_message_ids'],[7]);self.assertEqual(out['safe_message_ids'],[8])
        self.assertTrue(out['provider_inventory_complete']);self.assertEqual(json.loads(self.file.read_text()),self.value)
    def test_positive_unique_file_adoption_is_idempotent_and_preserves_identity(self):
        callback=lambda *a,**k:{'files':[self.provider],'next_page_cursor':None}
        req={**self.request,'message_id':7,'file_id':'file-1','expected_checkpoint_hash':recovery.fingerprint(self.value)}
        with patch.object(recovery,'get_soniox_key',return_value='fixture'):
            first=recovery.adopt_file(req,callback);second=recovery.adopt_file(req,callback)
            out=recovery.inspect(self.request,callback)
        self.assertFalse(first['idempotent']);self.assertTrue(second['idempotent'])
        self.assertEqual(out['blocked_message_ids'],[])
        actual=json.loads(self.file.read_text());self.assertEqual(actual['identity'],self.identity)
        self.assertEqual(actual['state'],'uploaded');self.assertEqual(actual['file_id'],'file-1')
    def test_wrong_size_time_duplicate_files_or_changed_hash_do_not_adopt(self):
        req={**self.request,'message_id':7,'file_id':'file-1','expected_checkpoint_hash':recovery.fingerprint(self.value)}
        for files in [[{**self.provider,'size':43}],[{**self.provider,'created_at':'2020-01-01T00:00:00Z'}],
                      [self.provider,{**self.provider,'id':'file-2'}],[]]:
            with self.subTest(files=files),patch.object(recovery,'get_soniox_key',return_value='fixture'):
                with self.assertRaisesRegex(RuntimeError,'uniquely match'):
                    recovery.adopt_file(req,lambda *a,**k:{'files':files,'next_page_cursor':None})
        with self.assertRaisesRegex(RuntimeError,'Checkpoint changed'):
            recovery.adopt_file({**req,'expected_checkpoint_hash':'0'*64},lambda *a,**k:None)
        self.assertEqual(json.loads(self.file.read_text()),self.value)
    def test_missing_original_uncertain_cache_is_not_a_fresh_attempt(self):
        self.file.unlink();out=recovery.inspect(self.request)
        self.assertEqual(out['blocked_message_ids'],[7]);self.assertEqual(out['items'][0]['state'],'missing_uncertain_checkpoint')
    def test_unknown_create_with_known_file_id_remains_blocked(self):
        self.file.write_text(json.dumps({**self.value,'state':'creating','file_id':'known-file'}))
        out=recovery.inspect(self.request);self.assertEqual(out['blocked_message_ids'],[7])
    def test_foreign_peer_is_ignored_and_invalid_identity_is_rejected(self):
        out=recovery.inspect({**self.request,'expected_peer_id':-100999,'provider_inventory':False})
        self.assertEqual(out['items'][0]['state'],'missing_uncertain_checkpoint')
        self.file.write_text(json.dumps({**self.value,'identity':{**self.identity,'size':99}}))
        with self.assertRaisesRegex(RuntimeError,'fingerprint'):
            recovery.inspect(self.request)
    def test_repeated_provider_cursor_is_not_complete_inventory(self):
        with self.assertRaisesRegex(RuntimeError,'cursor'):
            recovery.list_provider_files('fixture',lambda *a,**k:{'files':[],'next_page_cursor':'same'})

if __name__=='__main__':unittest.main()
