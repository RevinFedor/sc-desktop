import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import boosty_download_phase as phase
from shared.boosty_download_budget import owned_bytes, DownloadBudget, BudgetPause
from shared.library_db import open_db, upsert_source, upsert_item


class AudioPolicy(unittest.TestCase):
    def test_decode_cannot_consume_next_cli_selection_from_stdin(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'audio.m4a'; file.write_bytes(b'fixture')
            probe = SimpleNamespace(returncode=0, stdout=json.dumps({'streams': [{'codec_type': 'audio'}], 'format': {'duration': 10}}))
            with patch.object(phase.subprocess, 'run', side_effect=[probe, SimpleNamespace(returncode=0)]) as run:
                self.assertTrue(phase.decode_audio(file, 10)['full_decode_verified'])
                self.assertTrue(all(c.kwargs['stdin'] == phase.subprocess.DEVNULL for c in run.call_args_list))
                self.assertIn('-nostdin', run.call_args_list[1].args[0])
    def test_failed_sibling_metadata_remains_exact_and_does_not_abort_playlist(self):
        import boosty_single_ndjson as single
        fake = {'entries': [{'id': 'failed', 'formats': []}, {'id': 'wanted', 'formats': [
            {'format_id': 'audio', 'vcodec': 'none', 'acodec': 'aac', 'url': 'PRIVATE'}]}]}
        with patch.object(single.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(fake))), patch.object(single, 'yt_dlp_binary', return_value='fixture') as binary:
            info = phase.extractor_metadata('https://boosty.to/fixture/posts/exact', 'private-cookie')
            self.assertEqual(info['entries'][0]['formats'], [])
            self.assertEqual(single.select_videos(info, 'wanted')[0][1], 2)
            command = single.subprocess.run.call_args.args[0]
            self.assertIn('--ignore-no-formats-error', command)
            self.assertIn('--skip-download', command)
    def test_diagnostics_do_not_export_unstructured_error_or_signed_urls(self):
        import boosty_single_ndjson as single
        with patch.object(single, 'load_metadata', side_effect=RuntimeError('No video formats https://SECRET Cookie=SECRET')):
            with self.assertRaises(phase.AudioFailure) as caught: phase.extractor_metadata('fixture', 'fixture')
        self.assertEqual(caught.exception.details, {'categories': ['no_formats']})
        self.assertNotIn('SECRET', json.dumps(caught.exception.details))
    def test_no_video_or_untyped_hls_fallback(self):
        self.assertIsNone(phase.audio_format({'formats': [
            {'format_id': 'high', 'vcodec': 'avc1', 'acodec': 'aac', 'url': 'SECRET'},
            {'format_id': 'hls', 'vcodec': None, 'acodec': None, 'url': 'SECRET'}]}))
    def test_audio_only_choice_and_exact_id(self):
        selected = phase.audio_format({'formats': [{'format_id': 'a1', 'vcodec': 'none', 'acodec': 'aac', 'url': 'SECRET', 'tbr': 128}]})
        self.assertEqual(selected['format_id'], 'a1')
        with self.assertRaises(RuntimeError): phase.inspect_player({'hasAccess': True, 'data': [{'id': 'wrong', 'type': 'ok_video'}]}, 'wanted')
    def test_missing_null_access_not_authorized(self):
        for flag in [None, False]:
            with self.assertRaises(RuntimeError): phase.inspect_player({'hasAccess': flag, 'data': []}, 'wanted')


class Budget(unittest.TestCase):
    def test_actual_media_and_scratch_are_both_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'media').mkdir(); (root / 'temp').mkdir()
            (root / 'media/a.m4a').write_bytes(b'x' * 10000); (root / 'temp/a.part').write_bytes(b'x' * 20000)
            size = owned_bytes(root, root.stat().st_dev)
            self.assertGreaterEqual(size, 30000)
            budget = DownloadBudget({'external_mount': tmp, 'reserve_bytes': 0}, root, size - 1,
                                    proof={'st_dev': root.stat().st_dev})
            with self.assertRaises(BudgetPause): budget.check()
            self.assertTrue((root / 'temp/a.part').exists())
    def test_symlink_is_not_owned(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'link').symlink_to('/tmp', target_is_directory=True)
            with self.assertRaises(BudgetPause): owned_bytes(root, root.stat().st_dev)
    def test_reserve_is_checked_before_next_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            budget = DownloadBudget({'external_mount': tmp, 'reserve_bytes': 100}, root, 100000,
                                    proof={'st_dev': root.stat().st_dev})
            with patch('shared.boosty_download_budget.shutil.disk_usage', return_value=SimpleNamespace(free=101)):
                with self.assertRaises(BudgetPause): budget.check(extra_bytes=2)


class Selection(unittest.TestCase):
    def test_resume_rechecks_reservation_under_lock_before_spawn(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'SC_DESKTOP_DIR': tmp}):
            config = {'external_mount': tmp, 'reserve_bytes': 0, 'volume_uuid': 'DOUBLE'}
            state = {'job_id': 'race', 'pid': None, 'status': 'paused_item_limit', 'config': config}
            phase.save_state(state)
            def concurrent_resume(*args, **kwargs):
                concurrent = phase.load_state('race'); concurrent.update(status='dispatching', run_token='OTHER')
                phase.save_state(concurrent)
            with patch.object(phase, 'inspect_storage', side_effect=concurrent_resume), patch.object(phase.subprocess, 'Popen', side_effect=AssertionError('No duplicate')):
                with self.assertRaises(RuntimeError): phase.background_job(SimpleNamespace(job_id='race'))
            self.assertEqual(phase.load_state('race')['run_token'], 'OTHER')
    def test_actual_sql_identity_ready_skip_external_exclusion_no_full_catalog_or_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); report = root / 'report.json'; owned = root / 'external'
            with patch.dict(os.environ, {'SC_DESKTOP_DIR': str(root), 'SC_DESKTOP_DB': str(root / 'library.db')}):
                conn = open_db()
                sid = upsert_source(conn, platform='boosty', handle='fixture', external_id='owner')
                post = '11111111-1111-4111-8111-111111111111'
                ready = '22222222-2222-4222-8222-222222222222'; missing = '33333333-3333-4333-8333-333333333333'
                txt = root / 'ready.txt'; txt.write_text('old saved original')
                for identifier in [ready, missing]:
                    id_ = upsert_item(conn, source_id=sid, external_id=identifier, type='boosty_video', url=f'https://boosty.to/fixture/posts/{post}')
                    conn.execute('UPDATE items SET parent_external_id=?,transcript_path=? WHERE id=?', ('post:' + post, str(txt) if identifier == ready else None, id_))
                conn.close()
                report.write_text(json.dumps({'source_id': sid, 'handle': 'fixture', 'children': [
                    {'video_id': v, 'post_id': post, 'url': f'https://boosty.to/fixture/posts/{post}', 'has_access': True, 'duration_sec': 10} for v in [ready, missing, 'external-local-key']]}))
                args = SimpleNamespace(job_id='fixture', from_report=[str(report)], priority_post=[post], external_root=str(owned), external_mount=str(owned), reserve_bytes=1, ceiling_bytes=200000)
                def proof(c, **kwargs): return {'ok': True, 'roots': {k: str(c[k]) for k in ['audio_dir', 'work_dir', 'transcript_dir', 'library_root']}, 'volume_uuid': 'DOUBLE', 'st_dev': root.stat().st_dev}
                with patch.object(phase, 'inspect_storage', side_effect=proof), patch.object(phase, 'request_browser_auth', side_effect=AssertionError('No auth/network in selection')):
                    result = phase.create_job(args)
                    state = phase.load_state('fixture')
                    self.assertEqual(result['selected'], 1); self.assertEqual(result['excluded'], 2)
                    self.assertEqual(state['selection'][0]['video_id'], missing)
                    self.assertEqual(result['ASR'], 0); self.assertEqual(result['provider_uploads'], 0)
                    with self.assertRaises(ValueError): phase.create_job(args)


if __name__ == '__main__': unittest.main()
