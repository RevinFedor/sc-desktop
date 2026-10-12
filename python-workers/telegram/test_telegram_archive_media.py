import asyncio
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import telegram_archive_media as media
from shared import boosty_soniox_credential as credential


class ArchiveMediaTests(unittest.TestCase):
    def test_only_voice_and_documents_not_media_files(self):
        meta = {'file_name': 'cv.pdf', 'content_type': 'application/pdf', 'bytes': 23}
        self.assertEqual(media.decision('document', meta, duration=None, size_limit=100), 'pending')
        self.assertEqual(media.decision('voice', meta, duration=20, size_limit=100), 'pending')
        for kind in ['audio','video','video_note','photo']:
            self.assertEqual(media.decision(kind, meta, duration=20, size_limit=100), 'scope_excluded')
        for name, mime in [('podcast.mp3','application/octet-stream'),('mislabelled.pdf','audio/ogg')]:
            self.assertEqual(media.decision('document', {**meta,'file_name':name,'content_type':mime}, duration=None,size_limit=100), 'scope_excluded')

    def test_unknown_size_or_duration_never_zero(self):
        for value in [None, 0, -1, float('nan')]:
            self.assertEqual(media.decision('voice', {'bytes':10}, duration=value,size_limit=100), 'duration_unknown')
        self.assertEqual(media.decision('document', {'bytes':None},duration=None,size_limit=100),'size_unknown')
        self.assertEqual(media.decision('document', {'bytes':101},duration=None,size_limit=100),'byte_ceiling')

    def connection(self):
        c=sqlite3.connect(':memory:',isolation_level=None);c.row_factory=sqlite3.Row
        c.executescript('''CREATE TABLE sources(id INTEGER,platform TEXT,handle TEXT,tg_session TEXT,tg_session_conflict INTEGER,external_id TEXT);
          CREATE TABLE items(id INTEGER,source_id INTEGER,external_id TEXT,type TEXT,raw_meta_json TEXT,duration_seconds REAL,
            caption TEXT,transcribe_status TEXT,transcript_path TEXT,media_path TEXT,download_status TEXT,transcribe_error TEXT,
            transcribe_engine TEXT,transcribe_cost_usd REAL,updated_at INTEGER);
          CREATE VIRTUAL TABLE items_fts USING fts5(caption,transcript);''')
        c.execute("INSERT INTO sources VALUES(1,'telegram','-100123','session_test',0,'123')")
        return c

    def insert(self,c, item=1, external='10',kind='voice',status='none',caption='author'):
        raw=json.dumps({'media':[{'file_name':'voice.ogg' if kind=='voice' else 'cv.pdf','content_type':'audio/ogg' if kind=='voice' else 'application/pdf','bytes':20}]})
        c.execute('INSERT INTO items(id,source_id,external_id,type,raw_meta_json,duration_seconds,caption,transcribe_status) VALUES(?,1,?,?,?,?,?,?)',
            (item,external,kind,raw,20,caption,status))

    def state(self): return {'job_id':'test','source_ids':[1],'session':'session_test','max_file_bytes':1000,'rows':[],'sources':{}}

    def test_inventory_preserves_receipts_adds_future_history(self):
        c=self.connection(); self.insert(c); s=self.state(); media.inventory(s,c)
        s['rows'][0]['state']='downloaded';s['rows'][0]['remote_document_id']='123'
        self.insert(c,2,'11');media.inventory(s,c)
        self.assertEqual(len(s['rows']),2);self.assertEqual(s['rows'][0]['remote_document_id'],'123')
        self.assertEqual(s['rows'][0]['state'],'downloaded')

    def test_reuse_and_historical_paid_unknown(self):
        c=self.connection();self.insert(c,status='done');self.insert(c,2,'53979');s=self.state();s['quarantined_messages']=['1:53979'];media.inventory(s,c)
        self.assertEqual([r['state'] for r in s['rows']],['reused','paid_unknown_quarantined'])

    def test_wrong_session_rejects_before_network(self):
        c=self.connection();c.execute("UPDATE sources SET tg_session='another'")
        with self.assertRaises(ValueError):media.inventory(self.state(),c)

    def test_legacy_positive_handle_requires_exact_proven_peer(self):
        c=self.connection();self.insert(c);c.execute("UPDATE sources SET handle='123'");s=self.state()
        with self.assertRaises(ValueError):media.inventory(s,c)
        s['peer_ids']={'1':'-100123'};media.inventory(s,c);self.assertEqual(s['rows'][0]['peer_id'],-100123)
        s['peer_ids']={'1':'-100999'}
        with self.assertRaises(ValueError):media.inventory(s,c)

    def test_shared_project_budget_path_is_same(self):
        with patch.object(media,'app_root',return_value=Path('/tmp/sc')):
            b,r=media.provider_paths({'provider_project':'p'},{'item_id':8})
        self.assertEqual(str(b),'/tmp/sc/jobs/boosty-soniox/p/budget.json')
        self.assertEqual(str(r),'/tmp/sc/jobs/telegram-soniox/p/item-8.json')

    def test_publication_preserves_author_and_wrong_message_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            c=self.connection();self.insert(c);s=self.state();media.inventory(s,c);row=s['rows'][0]
            txt=media.stable_file(Path(t)/'full.txt','spoken content');row.update(original_path=str(Path(t)/'v.ogg'),original_sha256='a'*64)
            media.publish(c,s,row,'spoken content',{'txt':txt},'soniox')
            saved=c.execute('SELECT caption,transcript_path FROM items WHERE id=1').fetchone()
            self.assertEqual(saved['caption'],'author\n\n[голосовое — расшифровка · soniox]\nspoken content')
            self.assertEqual(saved['transcript_path'],txt)
            media.publish(c,s,row,'spoken content',{'txt':txt},'soniox')
            self.assertEqual(c.execute('SELECT caption FROM items WHERE id=1').fetchone()[0],saved['caption'])
            row['message_id']=99
            with self.assertRaises(ValueError):media.publish(c,s,row,'bad',{'txt':txt},'soniox')

    def test_rag_pending_never_deletes_voice(self):
        c=self.connection();self.insert(c);s=self.state();media.inventory(s,c);r=s['rows'][0]
        r.update(state='text_ready',published_caption_sha256='h')
        s['sources']={'1':{'index_job_id':'index-1'}}
        with patch.object(media,'public_call',return_value={'index':{'state':'running'}}), patch.object(Path,'unlink') as remove:
            media.prove_and_cleanup(s,c,1)
        remove.assert_not_called()

    def test_caption_change_after_index_keeps_original(self):
        c=self.connection();self.insert(c);s=self.state();media.inventory(s,c);r=s['rows'][0]
        r.update(state='text_ready',published_caption_sha256='wrong');s['sources']={'1':{'index_job_id':'index-1'}}
        s['sources']['1']['index_input_hash']=media.hashlib.sha256(json.dumps([(r['item_id'],'wrong')],sort_keys=True).encode()).hexdigest()
        with patch.object(media,'public_call',return_value={'index':{'state':'idle','ready_current_messages':1}}),patch.object(Path,'unlink') as remove:
            with self.assertRaises(ValueError):media.prove_and_cleanup(s,c,1)
        remove.assert_not_called()

    def test_stable_outputs_not_overwritten(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'txt';media.stable_file(p,'one')
            with self.assertRaises(ValueError):media.stable_file(p,'two')
            self.assertEqual(p.read_text(),'one')

    def test_additional_scope_needs_explicit_existing_release_and_keeps_ref(self):
        with tempfile.TemporaryDirectory() as t, patch.object(credential,'root',return_value=Path(t)):
            result=credential.put('test-dummy-key-not-a-provider-secret')
            reference=result['credential_ref']
            with self.assertRaises(ValueError):credential.load(reference,purpose='telegram_voice')
            with self.assertRaises(ValueError):credential.authorize_scope(reference,'telegram_voice')
            path=next(Path(t).glob('*.json'));private=json.loads(path.read_text())
            private.update(user_ASR_model_cost_release=True,provider_project_cap_confirmed=True)
            path.write_text(json.dumps(private));os.chmod(path,0o600)
            granted=credential.authorize_scope(reference,'telegram_voice')
            self.assertEqual(granted['credential_ref'],reference);self.assertNotIn('key',granted)
            self.assertEqual(credential.load(reference,purpose='telegram_voice')['scope'],'boosty_only')

    def test_project_budget_counts_both_scopes_and_blocks_unbilled(self):
        from shared.boosty_soniox import admit_budget, SonioxPending
        ledger={'baseline_cost_usd':'0','requests':{
          'boosty':{'state':'billed','cost_usd':'1'},'telegram':{'state':'billed','cost_usd':'0.02'}}}
        self.assertGreater(admit_budget(ledger,20,'1.02'),0)
        with self.assertRaises(SonioxPending):admit_budget(ledger,20,'1.00')
        ledger['requests']['active']={'state':'submitted'}
        with self.assertRaises(SonioxPending):admit_budget(ledger,20,'1.02')

    def test_failed_partial_full_history_is_not_media_ready_between_retries(self):
        c=self.connection();c.execute('CREATE TABLE jobs(source_id INTEGER,type TEXT,status TEXT,parameters_json TEXT)')
        s={**self.state(),'expected_account_id':11}
        params={'full_history':True,'expected_account_id':11,'_tg_session_override':'session_test','_fetch_report':{'remote_eof':False,'persistence':{'finalization_succeeded':True}}}
        c.execute('INSERT INTO jobs VALUES(1,\'tg_fetch\',\'error\',?)',(json.dumps(params),))
        self.assertFalse(media.source_ready_for_media(c,1,s))
        params['_fetch_report']['remote_eof']=True;c.execute('UPDATE jobs SET status=\'done\',parameters_json=?',(json.dumps(params),))
        self.assertTrue(media.source_ready_for_media(c,1,s))
        c.execute('INSERT INTO jobs VALUES(1,\'tg_index\',\'running\',\'{}\')')
        self.assertFalse(media.source_ready_for_media(c,1,s))


if __name__=='__main__':unittest.main()
