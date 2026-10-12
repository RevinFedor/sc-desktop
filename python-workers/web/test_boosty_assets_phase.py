import io
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1])); sys.path.insert(0, str(Path(__file__).resolve().parent))
import boosty_assets_phase as phase


class Response(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *args): self.close()
    def geturl(self): return 'https://cdn.boosty.to/authorized-fixture'


class Assets(unittest.TestCase):
    def test_attachment_cannot_create_second_downloader_or_mac_fallback(self):
        import boosty_download_phase as download
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'SC_DESKTOP_DIR': tmp}):
            with patch.object(download, 'load_state', return_value={'pid': 123, 'status': 'running'}), \
                 patch.object(phase, 'request_browser_auth', side_effect=AssertionError('No dispatch/auth')):
                with self.assertRaises(ValueError): phase.fetch_audio_attachment(SimpleNamespace(download_job_id='same', job_id='same-assets', source_id=1, asset_id='exact'))
    def test_image_actual_publication_and_cached_original_no_second_fetch(self):
        from PIL import Image
        from shared.library_db import open_db, upsert_source, upsert_item
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'SC_DESKTOP_DIR': tmp, 'SC_DESKTOP_DB': str(Path(tmp) / 'library.db')}):
            root = Path(tmp); conn = open_db(); sid = upsert_source(conn, platform='boosty', handle='fixture', external_id='fixture')
            post_id = '11111111-1111-4111-8111-111111111111'
            parent = upsert_item(conn, source_id=sid, external_id='post:' + post_id, type='boosty_post', published_at=1)
            conn.close()
            payload = io.BytesIO(); Image.new('RGB', (5, 5)).save(payload, format='PNG')
            row = {'asset_id': 'image-id', 'kind': 'image', 'source_id': sid, 'handle': 'fixture', 'post_id': post_id,
                   'post_item_id': parent, 'canonical_url': 'https://boosty.to/fixture/posts/' + post_id, 'state': 'metadata_only'}
            phase.atomic_json(phase.manifest_path('fixture'), {'job_id': 'fixture', 'rows': [row], 'max_total_original_bytes': 10000})
            models = root / 'models/tesseract'; models.mkdir(parents=True)
            for lang in ['eng', 'rus']: (models / (lang + '.traineddata')).write_bytes(b'double-model')
            with patch.object(phase, 'volume_info', return_value={'Internal': True}), patch.object(phase, 'request_browser_auth', return_value={}), \
                 patch.object(phase, 'raw_post', return_value={'hasAccess': True, 'data': [{'type': 'image', 'id': 'image-id', 'url': 'https://cdn.boosty.to/private'}]}), \
                 patch.object(phase.urllib.request, 'build_opener') as opener, patch.object(phase.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='OCR double')):
                opener.return_value.open.return_value = Response(payload.getvalue())
                args = SimpleNamespace(job_id='fixture', max_items=1)
                result = phase.fetch_images(args)
                self.assertEqual(result['counts'], {'original_verified_text_partial': 1})
                opener.return_value.open.side_effect = AssertionError('No repeated image download')
                phase.fetch_images(args)
            stored = json.loads(phase.manifest_path('fixture').read_text())['rows'][0]
            self.assertEqual(phase.sha_file(stored['original_path']), stored['original_sha256'])
            self.assertEqual(stored['coverage'], 'image_original_plus_OCR_not_visual_semantic_study')
    def test_archives_never_extract_execute_or_claim_binary_members_as_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); original = root / 'task.zip'
            with zipfile.ZipFile(original, 'w') as archive:
                archive.writestr('main.go', 'package main\n// Русский 🙂')
                archive.writestr('../escape.py', 'DONT EXECUTE')
                archive.writestr('binary.png', b'not readable')
            result = phase.extract_text_file(original, root)
            self.assertEqual(result['state'], 'original_verified_text_partial')
            self.assertIn('package main', Path(result['text_path']).read_text())
            self.assertNotIn('DONT EXECUTE', Path(result['text_path']).read_text())
            self.assertEqual({g['reason'] for g in result['gaps']}, {'unsafe_member', 'binary_member_not_text'})
    def test_filename_whitespace_and_source_text_are_not_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); original = root / 'task.txt '; original.write_text('Существующий full original')
            self.assertEqual(phase.extract_text_file(original, root)['state'], 'text_extracted_complete')
            self.assertEqual(phase.file_suffix({'name': ' audio.m4a '}), '.m4a')
    def test_office_text_reports_visual_gap_without_mutating_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); original = root / 'job.docx'
            with zipfile.ZipFile(original, 'w') as archive:
                archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:t>Backend</w:t></w:document>')
            digest = phase.sha_file(original)
            result = phase.extract_text_file(original, root)
            self.assertEqual(result['state'], 'original_verified_text_partial')
            self.assertEqual(phase.sha_file(original), digest)
    def test_authorized_separate_signed_query_used_in_memory_without_cookie_or_origin(self):
        node = {'url': 'https://cdn.boosty.to/fixture'}
        with self.assertRaises(ValueError): phase.authorized_file_url(node, {'hasAccess': False, 'signedQuery': 'secret=TEST'})
        self.assertEqual(phase.authorized_file_url(node, {'hasAccess': True, 'signedQuery': '?secret=TEST'}), 'https://cdn.boosty.to/fixture?secret=TEST')
        headers = phase.attachment_headers('https://boosty.to/fixture/posts/11111111-1111-4111-8111-111111111111')
        self.assertNotIn('Cookie', headers); self.assertNotIn('Origin', headers); self.assertNotIn('Authorization', headers)
    def test_redirect_rejected_before_network_follow(self):
        with self.assertRaises(ValueError): phase.AuthorizedRedirect().redirect_request(None, None, 302, '', {}, 'https://127.0.0.1/secret')
    def test_file_url_allowlist_refuses_external_link_localhost_or_http(self):
        for url in ['http://cdn.boosty.to/file', 'https://localhost/file', 'https://boosty.to.evil.test/file', 'https://192.168.1.1/file']:
            with self.assertRaises(ValueError): phase.trusted_url(url)
    def test_bounded_original_matches_bytes_hash_without_signed_url_in_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'original.pdf'
            with patch.object(phase.urllib.request, 'build_opener') as opener:
                opener.return_value.open.return_value = Response(b'not real PDF')
                count, digest = phase.bounded_original('https://cdn.boosty.to/SECRET', file, 100, 12)
            self.assertEqual(count, 12); self.assertEqual(digest, phase.sha_file(file))
            with self.assertRaises(ValueError): phase.bounded_original('https://cdn.boosty.to/SECRET', file, 100)
    def test_actual_byte_overflow_retains_partial_and_never_claims_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'large.pdf'
            with patch.object(phase.urllib.request, 'build_opener') as opener:
                opener.return_value.open.return_value = Response(b'x' * 100)
                with self.assertRaises(ValueError): phase.bounded_original('https://cdn.boosty.to/fixture', file, 50)
            self.assertFalse(file.exists()); self.assertTrue(file.with_suffix('.pdf.part').exists())
    def test_hash_safe_unicode_codepoint_original_reader(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'SC_DESKTOP_DIR': tmp}):
            text = Path(tmp) / 'full.txt'; text.write_text('Ж🙂LoRA\n' * 30)
            m = phase.manifest_path('fixture')
            phase.atomic_json(m, {'rows': [{'asset_id': 'pdf-child', 'source_id': 1, 'post_id': 'parent', 'canonical_url': 'https://boosty.to/fixture/posts/parent', 'text_path': str(text)}]})
            args = SimpleNamespace(job_id='fixture', source_id=1, asset_id='pdf-child', format='text', expected_hash=None, offset=0, max_chars=7)
            first = phase.original_read(args); self.assertEqual(first['content'], 'Ж🙂LoRA\n')
            args.offset = first['next_offset']
            with self.assertRaises(ValueError): phase.original_read(args)
            args.expected_hash = first['original_hash']; self.assertEqual(phase.original_read(args)['content'], 'Ж🙂LoRA\n')
            text.write_text('changed')
            with self.assertRaises(ValueError): phase.original_read(args)
    def test_inventory_does_not_make_filenames_full_content(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'SC_DESKTOP_DIR': tmp}):
            report = Path(tmp) / 'safe.json'; report.write_text(json.dumps({'source_id': 1, 'handle': 'fixture', 'posts': [
                {'post_id': 'parent', 'item_id': 1, 'url': 'https://boosty.to/fixture/posts/parent', 'has_access': True,
                 'assets_metadata': [{'kind': 'file', 'asset_id': 'asset1', 'name': 'CV.pdf', 'position': 1}, {'kind': 'image', 'asset_id': None, 'position': 2}]}]}))
            out = phase.inventory(SimpleNamespace(job_id='fixture', from_report=[str(report)], max_file_bytes=100, max_total_bytes=1000))
            self.assertEqual(out['counts'], {'metadata_only': 2}); self.assertEqual(out['original_bytes'], 0)
            self.assertEqual(out['provider_uploads'], 0)


if __name__ == '__main__': unittest.main()
