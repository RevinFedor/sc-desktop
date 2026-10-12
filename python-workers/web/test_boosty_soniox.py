import json
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared.boosty_soniox import (admit_budget, cost, SonioxPending, transcribe, token_outputs, digest,
                                atomic, reconcile_delivery, retry_unpaid_upload)

FILE = '11111111-1111-4111-8111-111111111111'
TRANSCRIPT = '22222222-2222-4222-8222-222222222222'


class ProviderDouble:
    def __init__(self): self.calls = []; self.fail_submit = False
    def usage(self, start): return {'total': {'total_cost_usd': '0.0'}}
    def call(self, route, **options):
        self.calls.append((route, options))
        if route == 'concurrency-limits': return {'project': {'current': {'transcribe_concurrent': 0}}}
        if route == 'files': return {'id': FILE}
        if route == 'transcriptions':
            if self.fail_submit: raise TimeoutError('simulated unknown delivery')
            return {'id': TRANSCRIPT}
        if route.endswith('/transcript'):
            return {'id': TRANSCRIPT, 'text': 'Вопрос LoRA? Answer adapters.', 'tokens': [
                {'text': 'Вопрос LoRA?', 'start_ms': 0, 'end_ms': 2000, 'speaker': '1', 'language': 'ru', 'confidence': .91},
                {'text': ' Answer adapters.', 'start_ms': 2100, 'end_ms': 4500, 'speaker': '2', 'language': 'en', 'confidence': .87}]}
        return {'id': TRANSCRIPT, 'model': 'stt-async-v5', 'status': 'completed', 'enable_speaker_diarization': True, 'enable_language_identification': True}


class PaidLifecycle(unittest.TestCase):
    def setup_files(self, root):
        audio = root / 'native.m4a'; audio.write_bytes(b'fixture audio (downloader/USB double)')
        identity = {'source_id': 1, 'post_id': 'parent', 'video_id': 'child', 'item_id': 2,
            'audio_sha256': digest(audio), 'duration_seconds': 10, 'credential_ref': 'fixture-only', 'model': 'stt-async-v5'}
        return audio, identity, {'baseline_cost_usd': '0', 'window_start': '2026-10-10T00:00:00Z', 'requests': {}}
    def test_latest_profile_original_ru_en_speakers_and_raw_confidence_retained(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); audio, identity, ledger = self.setup_files(root); provider = ProviderDouble()
            payload, receipt = transcribe(provider, audio, identity, root / 'receipt.json', ledger, lambda x: None)
            post = next(o['body'] for r, o in provider.calls if r == 'transcriptions')
            self.assertEqual(post['model'], 'stt-async-v5'); self.assertEqual(post['language_hints'], ['ru', 'en'])
            self.assertTrue(post['enable_speaker_diarization']); self.assertTrue(post['enable_language_identification'])
            self.assertNotIn('translation', post)
            text, srt, raw = token_outputs(payload, identity)
            self.assertEqual(text, payload['text']); self.assertEqual(raw['tokens'], payload['tokens'])
            self.assertEqual([c['speaker'] for c in raw['cues']], ['1', '2'])
            self.assertEqual(raw['cues'][1]['languages'], ['en']); self.assertIn('00:00:02,100', srt)
            self.assertTrue(raw['speaker_labels_are_not_names_or_roles'])
            self.assertEqual(receipt['transcription_id'], TRANSCRIPT)

    def test_one_replacement_file_preserves_unknown_history_and_never_replays_paid_create(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); audio, identity, ledger = self.setup_files(root); ref = 'fixture-reference'
            ledger['requests'][ref] = {'state': 'reserved', 'identity': identity, 'reservation_usd': '.2'}
            receipt_path = root / 'receipt.json'
            atomic(receipt_path, {'identity': identity, 'state': 'upload_inflight', 'client_reference_id': ref})
            class Recovery(ProviderDouble):
                def call(self, route, **opts):
                    self.calls.append((route, opts)); method = opts.get('method', 'GET')
                    if route == 'files' and method == 'GET': return {'files': [], 'next_page_cursor': None}
                    if route == 'transcriptions' and method == 'GET': return {'transcriptions': [], 'next_page_cursor': None}
                    if route == 'concurrency-limits': return {'project': {'current': {'transcribe_concurrent': 0}}}
                    if route == 'files' and method == 'POST':
                        self.reference = opts['body']['client_reference_id']; return {'id': FILE}
                    if route == 'files/' + FILE:
                        return {'id': FILE, 'filename': audio.name, 'size': audio.stat().st_size, 'client_reference_id': self.reference}
                    raise AssertionError('Unexpected paid call')
            provider = Recovery()
            out = retry_unpaid_upload(provider, audio, identity, receipt_path, ledger)
            self.assertEqual(out['new_paid_requests'], 0); self.assertEqual(out['new_uploads'], 1)
            stored = json.loads(receipt_path.read_text())
            self.assertEqual(stored['client_reference_id'], ref)
            self.assertNotEqual(stored['upload_reference_id'], ref)
            self.assertEqual(stored['original_upload_outcome'], 'unknown_no_paid_create_attempted')
            count = len(provider.calls)
            with self.assertRaises(SonioxPending): retry_unpaid_upload(provider, audio, identity, receipt_path, ledger)
            self.assertEqual(len(provider.calls), count)
            self.assertEqual(ledger['requests'][ref]['state'], 'reserved')

    def test_missing_create_ack_cannot_enter_unpaid_replacement_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); audio, identity, ledger = self.setup_files(root); path = root / 'receipt.json'
            atomic(path, {'identity': identity, 'state': 'submit_inflight', 'client_reference_id': 'own', 'file_id': FILE})
            provider = ProviderDouble()
            with self.assertRaises(SonioxPending): retry_unpaid_upload(provider, audio, identity, path, ledger)
            self.assertFalse(provider.calls)

    def test_get_only_upload_reconciliation_matches_reference_input_and_unique_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); audio, identity, ledger = self.setup_files(root); path = root / 'receipt.json'; ref = 'own'
            atomic(path, {'identity': identity, 'state': 'upload_inflight', 'client_reference_id': ref})
            ledger['requests'][ref] = {'identity': identity, 'state': 'reserved'}
            meta = {'id': FILE, 'filename': audio.name, 'size': audio.stat().st_size, 'client_reference_id': ref}
            class Existing(ProviderDouble):
                def call(self, route, **opts):
                    self.calls.append((route, opts)); self_case.assertEqual(opts.get('method', 'GET'), 'GET')
                    if route == 'files': return {'files': [meta], 'next_page_cursor': None}
                    if route == 'files/' + FILE: return meta
                    if route == 'transcriptions': return {'transcriptions': [], 'next_page_cursor': None}
                    raise AssertionError(route)
            self_case = self; provider = Existing()
            out = reconcile_delivery(provider, audio, identity, path, ledger, lambda x: None)
            self.assertEqual(out['state'], 'uploaded'); self.assertEqual(out['new_uploads'], 0)
            self.assertEqual(out['new_paid_requests'], 0)
    def test_unknown_paid_post_is_never_replayed_after_restart_or_new_invocation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); audio, identity, ledger = self.setup_files(root); provider = ProviderDouble(); provider.fail_submit = True
            receipt = root / 'receipt.json'
            with self.assertRaises(TimeoutError): transcribe(provider, audio, identity, receipt, ledger, lambda x: None)
            self.assertEqual(json.loads(receipt.read_text())['state'], 'submit_inflight')
            count = len(provider.calls)
            with self.assertRaises(SonioxPending): transcribe(provider, audio, identity, receipt, ledger, lambda x: None)
            self.assertEqual(len(provider.calls), count)
            self.assertTrue(audio.exists()); self.assertEqual(next(iter(ledger['requests'].values()))['state'], 'reserved')
    def test_known_paid_id_resumes_get_only_and_changed_input_refuses_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); audio, identity, ledger = self.setup_files(root); provider = ProviderDouble(); receipt = root / 'receipt.json'
            transcribe(provider, audio, identity, receipt, ledger, lambda x: None)
            provider.calls.clear(); transcribe(provider, audio, identity, receipt, ledger, lambda x: None)
            self.assertTrue(all(o.get('method', 'GET') == 'GET' for _, o in provider.calls))
            audio.write_bytes(b'changed'); provider.calls.clear()
            with self.assertRaises(SonioxPending): transcribe(provider, audio, identity, receipt, ledger, lambda x: None)
            self.assertFalse(provider.calls)
    def test_missing_speaker_or_language_is_not_declared_success(self):
        identity = {'duration_seconds': 10}
        for field in ['speaker', 'language']:
            payload = ProviderDouble().call('any/transcript')
            for t in payload['tokens']: t.pop(field)
            with self.assertRaises(SonioxPending): token_outputs(payload, identity)
    def test_token_times_never_escape_own_child(self):
        payload = ProviderDouble().call('any/transcript'); payload['tokens'][0]['end_ms'] = 999999
        with self.assertRaises(SonioxPending): token_outputs(payload, {'duration_seconds': 10})
    def test_subword_tokens_are_not_split_by_nominal_six_second_caption_boundary(self):
        tokens = [{'text': s, 'start_ms': a, 'end_ms': b, 'speaker': '1', 'language': 'ru', 'confidence': .9}
                  for s, a, b in [('Компания', 0, 800), (' ауди', 5500, 6100), ('ора', 6100, 6200), ('боту.', 6200, 6350), (' Дальше.', 6400, 7000)]]
        _, srt, raw = token_outputs({'id': TRANSCRIPT, 'text': 'Компания аудиоработу. Дальше.', 'tokens': tokens}, {'duration_seconds': 10})
        self.assertEqual([c['text'] for c in raw['cues']], ['Компания аудиоработу.', 'Дальше.'])
        self.assertNotIn('ауди\n', srt)


class Billing(unittest.TestCase):
    def test_legacy_serial_TG_keeps_isolated_unpaid_risk_and_dynamic_same_project_release(self):
        ledger = {'baseline_cost_usd': '0', 'max_new_spend_usd': '34.27', 'requests': {
            'old': {'state': 'billed', 'cost_usd': '10.27'},
            'quarantine': {'state': 'quarantined_unpaid_upload', 'reservation_usd': '.33',
                           'paid_create_barrier_never_crossed': True, 'risk_reservation_retained': True}}}
        self.assertGreater(admit_budget(ledger, 1000, '10.27'), Decimal('.1'))
        ledger['max_new_spend_usd'] = '12.6'
        with self.assertRaises(SonioxPending): admit_budget(ledger, 1000, '10.27')
        ledger['requests']['quarantine']['paid_create_barrier_never_crossed'] = False
        with self.assertRaises(SonioxPending): admit_budget(ledger, 1000, '10.27')
    def test_unknown_and_foreign_usage_stop_new_charge_not_zero_or_estimate(self):
        for value in [None, '-1', 'NaN']:
            with self.assertRaises(SonioxPending): cost(value)
        ledger = {'baseline_cost_usd': '0', 'requests': {}}
        self.assertGreater(admit_budget(ledger, 1322.42, '0'), Decimal('.1'))
        with self.assertRaises(SonioxPending): admit_budget(ledger, 1322.42, '.03')
        ledger['requests']['own'] = {'state': 'submitted'}
        with self.assertRaises(SonioxPending): admit_budget(ledger, 1322.42, '0')
    def test_actual_cost_plus_reservation_and_safety_margin_pause_before_cap(self):
        ledger = {'baseline_cost_usd': '0', 'requests': {'own': {'state': 'billed', 'cost_usd': '17.95'}}}
        with self.assertRaises(SonioxPending): admit_budget(ledger, 1322.42, '17.95')
        with self.assertRaises(SonioxPending): admit_budget({'baseline_cost_usd': '0', 'requests': {}}, None, '0')


if __name__ == '__main__': unittest.main()
