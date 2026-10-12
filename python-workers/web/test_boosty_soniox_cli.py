import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1])); sys.path.insert(0, str(Path(__file__).resolve().parent))
import boosty_soniox_cli as cli
from test_boosty_soniox import ProviderDouble
from shared.boosty_soniox import digest
from shared.library_db import open_db, upsert_source, upsert_item


class Cli(unittest.TestCase):
    def test_real_atomic_pair_raw_tokens_library_and_public_client_scope_with_provider_USB_API_doubles(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'SC_DESKTOP_DIR': tmp, 'SC_DESKTOP_DB': str(Path(tmp) / 'library.db')}):
            root = Path(tmp); audio = root / 'native.m4a'; audio.write_bytes(b'synthetic audio')
            conn = open_db(); sid = upsert_source(conn, platform='boosty', handle='fixture', external_id='owner')
            post = '11111111-1111-4111-8111-111111111111'; video = '33333333-3333-4333-8333-333333333333'
            id_ = upsert_item(conn, source_id=sid, external_id=video, type='boosty_video', raw_meta={'keep_old_context': True})
            conn.execute('UPDATE items SET parent_external_id=?,media_path=? WHERE id=?', ('post:' + post, str(audio), id_)); conn.close()
            row = {'source_id': sid, 'item_id': id_, 'post_id': post, 'video_id': video, 'handle': 'fixture', 'audio_path': str(audio),
                   'audio_proof': {'sha256': digest(audio), 'duration_seconds': 10}}
            private = {'key': 'TEST-ONLY-NOT-A-REAL-KEY', 'provider_project': '22222222-2222-4222-8222-222222222222'}
            args = SimpleNamespace(download_job_id='fixture', video_id=video, credential_ref='fixture-ref')
            provider = ProviderDouble(); provider.billed = lambda ref, start: {'cost_usd': '.002', 'uuid': 'fixture-usage'}
            calls = []
            def local(route, body):
                calls.append((route, body))
                if route == 'index/start': return {'job_id': 'fixture-index', 'accepted': True}
                ext = body['format']; file = root / 'transcripts/boosty/fixture' / post / (video + '.' + ext)
                self.assertTrue(file.is_file())
                return {'original_hash': digest(file), 'video_external_id': video, 'document_hash': 'd' * 64}
            with patch.object(cli, 'selected', return_value=({}, row, private)), patch.object(cli, 'Client', return_value=provider), patch.object(cli, 'local_call', side_effect=local), contextlib.redirect_stdout(io.StringIO()):
                out = cli.run_one(args)
            self.assertEqual(out['model'], 'stt-async-v5'); self.assertFalse(out['media_deleted']); self.assertTrue(audio.exists())
            self.assertEqual(out['speakers'], ['1', '2']); self.assertEqual(out['languages'], ['en', 'ru'])
            self.assertEqual(out['actual_cost_usd'], '0.002'); self.assertTrue(out['index_accepted_is_not_current_ready'])
            conn = open_db(); saved = conn.execute('SELECT * FROM items WHERE id=?', (id_,)).fetchone(); conn.close()
            self.assertEqual(saved['transcribe_engine'], 'soniox'); self.assertEqual(saved['transcribe_status'], 'done')
            self.assertTrue(json.loads(saved['raw_meta_json'])['keep_old_context'])
            raw = json.loads(Path(saved['transcript_path']).with_suffix('.soniox.json').read_text())
            self.assertEqual(raw['identity']['video_id'], video); self.assertEqual(raw['tokens'][0]['language'], 'ru')
            self.assertEqual(calls[-1][1]['item_ids'], [id_]); self.assertEqual(calls[-1][1]['source_id'], sid)


if __name__ == '__main__': unittest.main()
