import json
import sys
import tempfile
import unittest
import concurrent.futures
import threading
import os
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import boosty_soniox_cli as cli_module
from shared.library_db import open_db, upsert_source, upsert_item
from shared import boosty_soniox_parallel as parallel
from shared.boosty_soniox import atomic, digest, SonioxPending, SonioxError
from boosty_full_channel import exclusive_run
from shared.boosty_soniox_budget import SharedBudget, release_remaining

FID = '11111111-1111-4111-8111-111111111111'
TID = '22222222-2222-4222-8222-222222222222'


class Provider:
    def __init__(self): self.calls = []; self.deleted = False; self.status = 'completed'
    def call(self, route, **opts):
        self.calls.append((route, opts.get('method', 'GET')))
        if route == 'files': return {'files': [], 'next_page_cursor': None}
        if route == 'transcriptions': return {'transcriptions': [], 'next_page_cursor': None}
        if route == 'files/' + FID:
            if opts.get('method') == 'DELETE': self.deleted = True; return {}
            if self.deleted: raise SonioxError('file_not_found', 404)
            return {'id': FID, 'size': 7, 'filename': 'own.m4a', 'client_reference_id': 'own'}
        if route == 'transcriptions/' + TID:
            return {'id': TID, 'file_id': FID, 'status': self.status, 'client_reference_id': 'own'}
        if route.endswith('/count'): return {'total': 0}
        if route == 'concurrency-limits': return {'project': {'current': {'transcribe_concurrent': 0}}}
        raise AssertionError(route)


class Lifecycle(unittest.TestCase):
    def fixture(self, root, state='upload_inflight'):
        audio = root / 'own.m4a'; audio.write_bytes(b'fixture')
        identity = {'audio_sha256': digest(audio)}
        row = {'video_id': 'child', 'item_id': 5, 'audio_path': str(audio)}
        ledger = {'requests': {'own': {'state': 'reserved', 'identity': identity, 'reservation_usd': '.3'}}}
        receipt = {'identity': identity, 'state': state, 'client_reference_id': 'own', 'unpaid_upload_recovery_attempt': 1}
        bp, rp = root / 'budget.json', root / 'receipt.json'; atomic(bp, ledger); atomic(rp, receipt)
        cli = SimpleNamespace(selected=lambda a: ({}, row, {'key': 'fixture-only'}),
            context_paths=lambda p, r: (bp, rp), exclusive_run=exclusive_run)
        return cli, row, bp, rp

    def test_read_only_inventory_reports_unknown_sizes_without_secret_fields(self):
        provider = Provider()
        original = provider.call
        def call(route, **opts):
            if route == 'files': return {'files': [{'id': FID, 'size': 23, 'url': 'SECRET'}, {'id': TID}], 'next_page_cursor': None}
            return original(route, **opts)
        provider.call = call
        with patch.object(parallel, 'Client', return_value=provider): out = parallel.provider_info({'key': 'fixture'})
        self.assertEqual(out['provider_file_bytes'], 23); self.assertEqual(out['unknown_file_sizes'], 1)
        self.assertNotIn('SECRET', json.dumps(out)); self.assertTrue(all(m == 'GET' for _, m in provider.calls))

    def test_incomplete_inventory_never_proves_absence(self):
        provider = Provider(); provider.call = lambda *a, **k: {'files': [], 'next_page_cursor': 'same'}
        with self.assertRaises(SonioxPending): parallel.inventory(provider, 'files', 'files')

    def test_precreate_quarantine_preserves_unknown_history_and_risk_no_post(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli, row, bp, rp = self.fixture(Path(tmp)); provider = Provider()
            with patch.object(parallel, 'Client', return_value=provider): out = parallel.quarantine_unpaid(cli, SimpleNamespace())
            self.assertEqual(out['risk_reservation_usd'], '.3')
            receipt = json.loads(rp.read_text()); ledger = json.loads(bp.read_text())
            self.assertEqual(receipt['unpaid_upload_recovery_attempt'], 1)
            self.assertTrue(receipt['quarantine']['unknown_upload_not_erased'])
            self.assertEqual(ledger['requests']['own']['reservation_usd'], '.3')
            self.assertTrue(all(m == 'GET' for _, m in provider.calls))

    def test_uncertain_paid_create_is_never_quarantined_as_unpaid(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli, _, _, rp = self.fixture(Path(tmp), 'submit_inflight'); provider = Provider()
            with patch.object(parallel, 'Client', return_value=provider), self.assertRaises(SonioxPending):
                parallel.quarantine_unpaid(cli, SimpleNamespace())
            self.assertEqual(json.loads(rp.read_text())['state'], 'submit_inflight')

    def test_cloud_delete_requires_completed_billed_current_hash_and_preserves_originals(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); cli, row, bp, rp = self.fixture(root, 'saved'); provider = Provider()
            ledger = json.loads(bp.read_text()); ledger['requests']['own']['state'] = 'billed'; atomic(bp, ledger)
            receipt = json.loads(rp.read_text()); receipt.update(file_id=FID, transcription_id=TID); atomic(rp, receipt)
            cli.load_state = lambda _: {'selection': [row]}; cli.load = lambda _: {'key': 'fixture'}
            cli.status_or_cleanup = lambda _: {'current_rag': {'state': 'ready_current'}, 'actual_cost_usd': '.1',
                                               'document_hash': 'hash', 'original_hashes': {'txt': 'hash'}}
            args = SimpleNamespace(download_job_id='same', video_id='child', credential_ref='same')
            with patch.object(parallel, 'Client', return_value=provider): out = parallel.provider_cleanup_one(cli, args)
            self.assertEqual(out['deleted_bytes'], 7); self.assertTrue(Path(row['audio_path']).exists())
            self.assertTrue(out['provider_job_retained']); self.assertEqual(out['paid_requests'], 0)

    def test_active_cloud_job_refuses_deletion(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli, row, bp, rp = self.fixture(Path(tmp), 'saved'); provider = Provider(); provider.status = 'processing'
            ledger = json.loads(bp.read_text()); ledger['requests']['own']['state'] = 'billed'; atomic(bp, ledger)
            receipt = json.loads(rp.read_text()); receipt.update(file_id=FID, transcription_id=TID); atomic(rp, receipt)
            cli.load_state = lambda _: {'selection': [row]}; cli.load = lambda _: {'key': 'fixture'}
            cli.status_or_cleanup = lambda _: {'current_rag': {'state': 'ready_current'}, 'actual_cost_usd': '.1'}
            with patch.object(parallel, 'Client', return_value=provider), self.assertRaises(SonioxPending):
                parallel.provider_cleanup_one(cli, SimpleNamespace(download_job_id='same', video_id='child', credential_ref='same'))
            self.assertFalse(provider.deleted)


class Reservations(unittest.TestCase):
    def ledger(self, root, cap='20'):
        path = root / 'budget.json'
        atomic(path, {'credential_ref': 'same', 'baseline_cost_usd': '0', 'window_start': '2026-10-01T00:00:00Z',
            'requests': {}, 'max_new_spend_usd': cap, 'client_safety_reserve_usd': '2',
            'parallel_policy': {'workers': 8, 'initial_provider_file_bytes': 10, 'provider_storage_ceiling_bytes': 10000}})
        return SharedBudget(path, 'same', 'same-run')

    def test_eight_concurrent_admissions_are_short_atomic_and_aggregate_reservations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); budget = self.ledger(root); start = threading.Barrier(8)
            def admit(i):
                start.wait(timeout=5)
                return budget.admit(str(i), {'duration_seconds': 120}, root / (str(i) + '.json'), 20, '0')
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool: list(pool.map(admit, range(8)))
            saved = budget.read(); self.assertEqual(len(saved['requests']), 8)
            actual, reserved = budget.totals(saved); self.assertEqual(actual, 0)
            self.assertEqual(reserved, Decimal('.11') * 8)
            with self.assertRaises(SonioxPending): budget.admit('ninth', {'duration_seconds': 120}, root / '9.json', 20, '0')

    def test_quarantined_unpaid_risk_not_erased_or_counted_as_free_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); budget = self.ledger(root, '3')
            budget.update(lambda l: l['requests'].update({'old': {'state': 'quarantined_unpaid_upload', 'reservation_usd': '.9'}}))
            with self.assertRaises(SonioxPending): budget.admit('new', {'duration_seconds': 120}, root / 'new.json', 20, '0')
            self.assertEqual(budget.read()['requests']['old']['reservation_usd'], '.9')

    def test_uncertain_paid_and_previous_run_handoff_block_new_create(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); budget = self.ledger(root)
            budget.update(lambda l: l['requests'].update({'old': {'state': 'submit_inflight', 'reservation_usd': '.2', 'active_run_token': 'dead-run'}}))
            with self.assertRaises(SonioxPending): budget.admit('new', {'duration_seconds': 120}, root / 'new.json', 20, '0')

    def test_foreign_usage_and_cloud_capacity_block_before_any_receipt_post(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); budget = self.ledger(root)
            for size, total in [(20, '1'), (20000, '0')]:
                with self.assertRaises(SonioxPending): budget.admit('new', {'duration_seconds': 120}, root / 'new.json', size, total)
            self.assertFalse((root / 'new.json').exists())

    def test_actual_billing_frees_just_own_reservation_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); budget = self.ledger(root)
            for i in range(2): budget.admit(str(i), {'duration_seconds': 120}, root / (str(i) + '.json'), 20, '0')
            bill = {'cost_usd': '.003', 'uuid': 'actual-once'}; budget.bill('0', bill); budget.bill('0', bill)
            actual, reserved = budget.totals(budget.read())
            self.assertEqual(actual, Decimal('.003')); self.assertEqual(reserved, Decimal('.11'))
            with self.assertRaises(SonioxPending): budget.bill('0', {'cost_usd': '.006', 'uuid': 'different'})

    def test_provider_cap_rounding_and_idempotent_existing_ref_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); secret_root = root / 'secrets/boosty-soniox'; secret_root.mkdir(parents=True)
            project = '11111111-1111-4111-8111-111111111111'; ref = 'boosty-soniox:22222222-2222-4222-8222-222222222222'
            path = root / 'jobs/boosty-soniox' / project / 'budget.json'
            atomic(path, {'credential_ref': ref, 'baseline_cost_usd': '0', 'window_start': 'month',
                'requests': {'old': {'state': 'billed', 'cost_usd': '10.2759695'}}, 'max_new_spend_usd': '20'})
            proof = root / 'proof.json'; atomic(proof, {'credential_ref': ref, 'provider_project': project, 'provider_org': 'same-org',
                'secret_value_present_in_artifact': False, 'cap_verified_after_fresh_GET': True, 'autopay_existing_enabled': False,
                'user_ASR_model_cost_release': True, 'budget_remaining_USD': 24, 'project_monthly_limit_after_USD': 34.27})
            private = {'key': 'FIXTURE-NOT-A-REAL-KEY', 'provider_project': project, 'provider_org': 'same-org'}
            provider = SimpleNamespace(usage=lambda _: {'total': {'total_cost_usd': '10.2759695'}})
            with patch('shared.boosty_soniox_credential.load', return_value=private), patch('shared.boosty_soniox_credential.root', return_value=secret_root), patch('shared.boosty_soniox.Client', return_value=provider):
                first = release_remaining(ref, '24', proof); again = release_remaining(ref, '24', proof)
            self.assertEqual(first['max_new_spend_usd'], '34.2700000'); self.assertEqual(first['remaining_authorized_usd'], '23.9940305')
            self.assertTrue(again['deduplicated']); self.assertEqual(json.loads(path.read_text())['max_new_spend_usd'], '34.2700000')


class ProviderWorkers(unittest.TestCase):
    def test_two_provider_workers_overlap_and_publish_real_pairs_then_resume_without_paid_post(self):
        # Real parallel coordinator, project locks, raw/TXT/SRT and library;
        # provider HTTP, physical USB selection are explicit doubles.
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'SC_DESKTOP_DIR': tmp, 'SC_DESKTOP_DB': str(Path(tmp) / 'library.db')}):
            root = Path(tmp); conn = open_db(); sid = upsert_source(conn, platform='boosty', handle='fixture', external_id='fixture-owner')
            parent = str(__import__('uuid').uuid4()); rows = []
            for i in range(2):
                video = str(__import__('uuid').uuid4()); item = upsert_item(conn, source_id=sid, external_id=video, type='boosty_video')
                conn.execute('UPDATE items SET parent_external_id=? WHERE id=?', ('post:' + parent, item))
                audio = root / ('own' + str(i) + '.m4a'); audio.write_bytes(b'SYNTHETIC AUDIO')
                rows.append({'source_id': sid, 'item_id': item, 'post_id': parent, 'video_id': video, 'handle': 'fixture',
                             'audio_path': str(audio), 'audio_proof': {'sha256': digest(audio), 'duration_seconds': 10}})
            conn.close(); private = {'key': 'FIXTURE-NOT-A-REAL-KEY', 'provider_project': '11111111-1111-4111-8111-111111111111'}
            bp, _ = cli_module.context_paths(private, rows[0])
            atomic(bp, {'credential_ref': 'same', 'baseline_cost_usd': '0', 'window_start': 'month', 'max_new_spend_usd': '20',
                'requests': {}, 'parallel_policy': {'workers': 2, 'initial_provider_file_bytes': 0, 'provider_storage_ceiling_bytes': 10000}})
            budget = SharedBudget(bp, 'same', 'test-run'); events = __import__('queue').SimpleQueue()
            barrier = threading.Barrier(2); calls = []; charges = {}; charge_lock = threading.Lock()
            class ProviderDouble:
                def __init__(self, *args):
                    self.fid = str(__import__('uuid').uuid4()); self.tid = str(__import__('uuid').uuid4()); self.ticks = 0
                def usage(self, *args):
                    with charge_lock: total = sum(charges.values())
                    return {'total': {'total_cost_usd': str(total)}}
                def billed(self, ref, *args): return {'cost_usd': '.001', 'uuid': ref}
                def call(self, route, **opts):
                    method = opts.get('method', 'GET'); calls.append((route, method))
                    if route == 'files' and method == 'POST':
                        self.audio = Path(opts['audio']); self.ref = opts['body']['client_reference_id']; return {'id': self.fid}
                    if route == 'files/' + self.fid:
                        return {'id': self.fid, 'size': self.audio.stat().st_size, 'filename': self.audio.name, 'client_reference_id': self.ref}
                    if route == 'transcriptions' and method == 'POST': return {'id': self.tid}
                    if route == 'transcriptions/' + self.tid:
                        self.ticks += 1
                        if self.ticks == 1: barrier.wait(timeout=5)
                        else:
                            with charge_lock: charges[self.ref] = Decimal('.001')
                        return {'id': self.tid, 'status': 'processing' if self.ticks == 1 else 'completed', 'model': 'stt-async-v5',
                                'enable_speaker_diarization': True, 'enable_language_identification': True}
                    if route.endswith('/transcript'):
                        return {'id': self.tid, 'text': 'Вопрос? Answer.', 'tokens': [
                            {'text': 'Вопрос?', 'start_ms': 0, 'end_ms': 1000, 'speaker': '1', 'language': 'ru'},
                            {'text': ' Answer.', 'start_ms': 1100, 'end_ms': 2000, 'speaker': '2', 'language': 'en'}]}
                    raise AssertionError(route)
            def selected(args): return {}, next(r for r in rows if r['video_id'] == args.video_id), private
            args = [SimpleNamespace(download_job_id='same', video_id=r['video_id'], credential_ref='same') for r in rows]
            with patch.object(cli_module, 'load_state', return_value={'selection': rows}), patch.object(cli_module, 'load', return_value=private), patch.object(cli_module, 'selected', side_effect=selected), patch.object(parallel, 'BudgetClient', ProviderDouble):
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    out = list(pool.map(lambda a: parallel.provider_worker(cli_module, a, budget, {}, events), args))
                self.assertEqual(len(out), 2); self.assertEqual(len(charges), 2)
                self.assertEqual(sum(m == 'POST' and r == 'transcriptions' for r, m in calls), 2)
                self.assertEqual(budget.totals(budget.read())[0], Decimal('.002'))
                before = len(calls)
                for a in args: parallel.provider_worker(cli_module, a, budget, {}, events)
                self.assertTrue(all(m != 'POST' for _, m in calls[before:]))
            conn = open_db(); saved = conn.execute("SELECT * FROM items WHERE type='boosty_video'").fetchall(); conn.close()
            for row in saved:
                self.assertEqual(row['transcribe_status'], 'done'); self.assertTrue(Path(row['transcript_path']).exists())
                raw = json.loads(Path(row['transcript_path']).with_suffix('.soniox.json').read_text())
                self.assertEqual(raw['identity']['item_id'], row['id']); self.assertEqual(raw['cues'][1]['languages'], ['en'])


if __name__ == '__main__': unittest.main()
