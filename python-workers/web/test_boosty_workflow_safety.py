import fcntl
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
from shared.boosty_storage import inspect_storage, StorageError
from shared.boosty_asr_receipt import Receipt, AsrDeliveryUnknown
from boosty_full_channel import estimate_plan
from boosty_api import normalize_post
import boosty_single_ndjson as worker


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.usb = self.root / 'USB'; self.usb.mkdir()
        self.local = self.root / 'Mac'; self.local.mkdir()
        self.config = {'audio_dir': self.usb / 'audio', 'work_dir': self.usb / 'work',
                       'transcript_dir': self.local / 'text', 'library_root': self.local}
        self.info = {'MountPoint': str(self.usb), 'Internal': False, 'BusProtocol': 'USB',
                     'WritableVolume': True, 'ReadOnlyVolume': False, 'VolumeUUID': 'physical-fixture', 'DeviceIdentifier': 'test1'}
        self.kwargs = {'external_mount': str(self.usb), 'expected_volume_uuid': 'physical-fixture',
            'disk_info': lambda p: self.info if Path(p).is_relative_to(self.usb) else {'Internal': True},
            'stat': lambda p: SimpleNamespace(st_dev=2 if Path(p).is_relative_to(self.usb) else 1),
            'usage': lambda p: SimpleNamespace(free=20 * 1024 ** 3)}
    def tearDown(self): self.temporary.cleanup()
    def test_real_usb_and_mac_split(self):
        proof = inspect_storage(self.config, **self.kwargs)
        self.assertTrue(proof['ok']); self.assertEqual(proof['st_dev'], 2)
    def test_mount_looking_directory_is_not_a_volume(self):
        self.info['MountPoint'] = '/different-physical-volume'
        with self.assertRaises(StorageError): inspect_storage(self.config, **self.kwargs)
    def test_mac_work_dir_refused(self):
        self.config['work_dir'] = self.local / 'temp'
        with self.assertRaises(StorageError): inspect_storage(self.config, **self.kwargs)
    def test_symlink_media_escape_refused(self):
        (self.usb / 'escape').symlink_to(self.local, target_is_directory=True)
        self.config['work_dir'] = self.usb / 'escape' / 'new'
        with self.assertRaises(StorageError): inspect_storage(self.config, **self.kwargs)
    def test_changed_uuid_refused(self):
        self.info['VolumeUUID'] = 'other-device'
        with self.assertRaises(StorageError): inspect_storage(self.config, **self.kwargs)
    def test_readonly_refused(self):
        self.info['WritableVolume'] = False
        with self.assertRaises(StorageError): inspect_storage(self.config, **self.kwargs)
    def test_free_reserve_refused(self):
        self.kwargs['usage'] = lambda p: SimpleNamespace(free=4 * 1024 ** 3)
        with self.assertRaises(StorageError): inspect_storage(self.config, **self.kwargs)
    def test_external_transcript_refused(self):
        self.config['transcript_dir'] = self.usb / 'text'
        with self.assertRaises(StorageError): inspect_storage(self.config, **self.kwargs)


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.audio = Path(self.tmp.name) / 'own.mp3'; self.audio.write_bytes(b'not real media')
        self.receipt = Receipt(Path(self.tmp.name) / 'receipt.json', {'child': 'A', 'model': 'fixture'})
        self.submitted = []; self.gets = []
    def tearDown(self): self.tmp.cleanup()
    def submit(self): self.submitted.append(1); return SimpleNamespace(id='exact-provider-id')
    def get(self, identifier): self.gets.append(identifier); return SimpleNamespace(id=identifier)
    def test_known_id_resumes_get_never_paid_submit(self):
        self.receipt.get_or_submit(self.audio, self.submit, self.get)
        self.receipt.completed('exact-provider-id')
        self.receipt.get_or_submit(self.audio, self.submit, self.get)
        self.assertEqual(len(self.submitted), 1); self.assertEqual(self.gets, ['exact-provider-id'])
    def test_unknown_ack_blocks_retry(self):
        def lost(): raise ConnectionError('After remote submit, ACK lost')
        with self.assertRaises(ConnectionError): self.receipt.get_or_submit(self.audio, lost, self.get)
        with self.assertRaises(AsrDeliveryUnknown): self.receipt.get_or_submit(self.audio, self.submit, self.get)
        self.assertEqual(self.submitted, []); self.assertEqual(self.receipt.load()['state'], 'submit_inflight')
    def test_changed_audio_blocks_provider_replay(self):
        self.receipt.get_or_submit(self.audio, self.submit, self.get)
        self.audio.write_bytes(b'changed')
        with self.assertRaises(AsrDeliveryUnknown): self.receipt.get_or_submit(self.audio, self.submit, self.get)
        self.assertEqual(len(self.submitted), 1)
    def test_different_child_or_model_blocks_replay(self):
        self.receipt.get_or_submit(self.audio, self.submit, self.get)
        other = Receipt(self.receipt.path, {'child': 'B'})
        with self.assertRaises(AsrDeliveryUnknown): other.get_or_submit(self.audio, self.submit, self.get)
    def test_corrupt_receipt_blocks_replay(self):
        self.receipt.path.write_text('unknown delivery')
        with self.assertRaises(AsrDeliveryUnknown): self.receipt.get_or_submit(self.audio, self.submit, self.get)
    def test_concurrent_submission_lock_blocks(self):
        with self.receipt.path.with_suffix('.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(AsrDeliveryUnknown): self.receipt.get_or_submit(self.audio, self.submit, self.get)
        self.assertEqual(self.submitted, [])


class MetadataTests(unittest.TestCase):
    def test_pdf_asset_metadata_is_not_original_or_text_coverage_and_leaks_no_url(self):
        post = normalize_post({'id': 'post-id', 'hasAccess': True, 'data': [
            {'type': 'file', 'id': 42, 'name': 'CV_Fixture.pdf', 'size': 442996, 'url': 'https://signed.invalid/SECRET'},
            {'type': 'image', 'id': 'img1', 'url': 'https://signed.invalid/SECRET'},
            {'type': 'audio', 'id': 'audio1', 'duration': 10.2, 'signedQuery': 'SECRET'},
            {'type': 'link', 'title': 'External reference', 'url': 'https://external.invalid/SECRET'}]}, 'author')
        assets = post['assets_metadata']
        self.assertEqual([a['kind'] for a in assets], ['file', 'image', 'audio', 'link'])
        self.assertEqual(assets[0]['asset_id'], '42'); self.assertEqual(assets[0]['name'], 'CV_Fixture.pdf')
        self.assertIsNone(assets[-1]['asset_id'])
        self.assertTrue(all(a['original_saved'] is None and a['extracted_text_saved'] is None for a in assets))
        self.assertNotIn('SECRET', repr(assets)); self.assertNotIn('url', repr(assets))
    def test_unknown_duration_is_not_zero_cost_or_complete_size(self):
        plan = estimate_plan([{'duration_sec': None}, {'duration_sec': 3600}])
        self.assertEqual(plan['known_duration_sec'], 3600)
        self.assertEqual(plan['unknown_duration_count'], 1)
        self.assertIsNone(plan['duration_sec']); self.assertIsNone(plan['estimated_cost_usd']); self.assertIsNone(plan['audio_bytes'])
    def test_known_duration(self):
        plan = estimate_plan([{'duration_sec': 191006}])
        self.assertEqual(plan['duration_sec'], 191006); self.assertEqual(plan['unknown_duration_count'], 0)
    def test_strict_uuid_never_falls_back_to_neighbor_position(self):
        with patch.object(worker, '_STRICT_CONFIG', {'strict': True}):
            selected, errors = worker.select_requested_videos({'entries': [{'id': 'OTHER'}]}, [{'video_id': 'MISSING', 'position': 1}])
            self.assertEqual(selected, []); self.assertEqual(errors[0]['video_id'], 'missing')
    def test_legacy_position_fallback_preserved(self):
        with patch.object(worker, '_STRICT_CONFIG', None):
            selected, _ = worker.select_requested_videos({'entries': [{'id': 'OTHER'}]}, [{'video_id': 'MISSING', 'position': 1}])
            self.assertEqual(selected[0][0]['id'], 'OTHER')


if __name__ == '__main__': unittest.main()
