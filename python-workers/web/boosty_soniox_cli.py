#!/usr/bin/env python3
"""SC Boosty-only Soniox lifecycle over exact admitted download receipts.

No shared settings/key fallback, no download, and no blind paid replay. One
child acceptance is explicit; bulk requires its verified same-version RAG.
"""
import argparse
import datetime
import json
import os
import re
import math
import shutil
import subprocess
import signal
import uuid
from types import SimpleNamespace
import sys
import time
import urllib.request
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
from boosty_cli import LOCAL_AUTH_TOKEN_PATH
from boosty_download_phase import load_state, sha_file
from boosty_full_channel import app_root, exclusive_run
from shared.boosty_storage import inspect_storage
from shared.boosty_soniox_credential import load
from shared.boosty_soniox import Client, SonioxPending, atomic, cost, transcribe, token_outputs, reconcile_delivery, retry_unpaid_upload
from shared.library_db import open_db


def selected(args):
    download = load_state(args.download_job_id)
    row = next(r for r in download['selection'] if r['video_id'] == args.video_id)
    if row['state'] != 'ready_audio' or not row.get('native_child_verified'):
        raise SonioxPending('Only a verified owned exact native audio is admitted')
    private = load(args.credential_ref)
    if (private.get('provider_project_cap_confirmed') is not True or private.get('user_ASR_model_cost_release') is not True
        or not private.get('key_project_binding') or private.get('provider_autopay_enabled') is not False):
        raise SonioxPending('Current key-project/budget/release proof required')
    _, existing_receipt = context_paths(private, row)
    known = json.loads(existing_receipt.read_text()) if existing_receipt.exists() else {}
    paid_resume = bool(known.get('transcription_id'))
    if paid_resume and (known['identity']['item_id'] != row['item_id'] or known['identity']['video_id'] != row['video_id'] or known['identity']['credential_ref'] != args.credential_ref):
        raise SonioxPending('Known receipt belongs to another identity')
    if not paid_resume:
        proof = inspect_storage(download['config'], external_mount=download['config']['external_mount'],
            expected_volume_uuid=download['config']['volume_uuid'], reserve_bytes=download['config']['reserve_bytes'])
        audio = Path(row['audio_path']).resolve(strict=True)
        owned = Path(download['owned_root']).resolve(strict=True)
        if not audio.is_relative_to(owned) or audio.stat().st_dev != proof['st_dev'] or sha_file(audio) != row['audio_proof']['sha256']:
            raise SonioxPending('Owned audio path/device/hash changed')
    conn = open_db()
    try:
        saved = conn.execute("SELECT * FROM items WHERE id=? AND source_id=? AND external_id=? AND type='boosty_video'", (row['item_id'], row['source_id'], row['video_id'])).fetchone()
        if not saved or saved['parent_external_id'] != 'post:' + row['post_id']: raise SonioxPending('Library child identity changed')
        if saved['transcript_path'] and Path(saved['transcript_path']).is_file() and Path(saved['transcript_path']).stat().st_size:
            if not paid_resume or known.get('files', {}).get('txt') != saved['transcript_path']:
                raise SonioxPending('Saved transcript already exists: reuse, never paid repeat')
    finally: conn.close()
    return download, row, private


def context_paths(private, row):
    root = app_root() / 'jobs/boosty-soniox' / private['provider_project']
    return root / 'budget.json', root / ('item-' + str(row['item_id']) + '.json')


def recover_delivery(args):
    download, row, private = selected(args)
    budget_path, receipt_path = context_paths(private, row)
    with exclusive_run(budget_path.with_suffix('.lock')):
        receipt = json.loads(receipt_path.read_text()); ledger = json.loads(budget_path.read_text())
        try:
            if args.operation == 'retry-unpaid-upload':
                return retry_unpaid_upload(Client(private['key']), row['audio_path'], receipt['identity'], receipt_path, ledger)
            return reconcile_delivery(Client(private['key']), row['audio_path'], receipt['identity'], receipt_path,
                ledger, lambda value: atomic(budget_path, value))
        except SonioxPending as error:
            return {'ok': False, 'code': 'BOOSTY_SONIOX_DELIVERY_PENDING', 'reason': str(error),
                    'details': getattr(error, 'recovery_details', None),
                    'new_uploads': 0, 'new_paid_requests': 0}


def local_call(route, body=None):
    if LOCAL_AUTH_TOKEN_PATH.stat().st_mode & 0o077: raise SonioxPending('Local Application API token must remain private')
    token = LOCAL_AUTH_TOKEN_PATH.read_text().strip()
    headers = {'Authorization': 'Bearer ' + token}
    if body is not None: headers['Content-Type'] = 'application/json'
    req = urllib.request.Request('http://127.0.0.1:53127/boosty-rag/' + route,
        data=json.dumps(body).encode() if body is not None else None, headers=headers)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *values, **options): raise SonioxPending('Local API redirects are not allowed')
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=120) as response: result = json.load(response)
    if result.get('ok') is not True: raise SonioxPending('Supported RAG API rejected this operation')
    return result


def publish_text(row, text, srt, raw, receipt, path):
    directory = app_root() / 'transcripts/boosty' / row['handle'] / row['post_id']
    directory.mkdir(parents=True, exist_ok=True)
    files = {'txt': directory / (row['video_id'] + '.txt'), 'srt': directory / (row['video_id'] + '.srt'),
             'raw': directory / (row['video_id'] + '.soniox.json')}
    for kind, content in [('txt', text), ('srt', srt), ('raw', json.dumps(raw, ensure_ascii=False))]:
        target = files[kind]
        if target.exists():
            if target.read_text() != content: raise SonioxPending('Saved output changed/unowned; no overwrite')
        else:
            part = target.with_suffix(target.suffix + '.part')
            with part.open('w', encoding='utf-8') as stream:
                os.chmod(part, 0o600); stream.write(content); stream.flush(); os.fsync(stream.fileno())
            os.replace(part, target)
    receipt.update(state='saved', files={k: str(v) for k, v in files.items()}, saved_hashes={k: sha_file(v) for k, v in files.items()})
    atomic(path, receipt)  # Paired full originals are stable BEFORE library publication.
    conn = open_db()
    try:
        existing = conn.execute('SELECT raw_meta_json,transcript_path FROM items WHERE id=?', (row['item_id'],)).fetchone()
        if existing['transcript_path'] and existing['transcript_path'] != str(files['txt']): raise SonioxPending('Another saved original appeared; preserve both')
        meta = json.loads(existing['raw_meta_json'] or '{}')
        meta['soniox'] = {'model': 'stt-async-v5', 'raw_tokens_path': str(files['raw']), 'raw_tokens_sha256': receipt['saved_hashes']['raw'],
                         'speaker_labels_not_names_or_roles': True, 'original_languages_retained': True}
        conn.execute("UPDATE items SET transcript_path=?,transcribe_status='done',transcribe_engine='soniox',raw_meta_json=?,updated_at=unixepoch() WHERE id=?",
                     (str(files['txt']), json.dumps(meta, ensure_ascii=False), row['item_id']))
    finally: conn.close()
    return receipt


def run_one(args):
    download, row, private = selected(args)
    budget_path, receipt_path = context_paths(private, row)
    with exclusive_run(budget_path.with_suffix('.lock')):
        client = Client(private['key'])
        if budget_path.exists(): ledger = json.loads(budget_path.read_text())
        else:
            now = datetime.datetime.now(datetime.timezone.utc)
            start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat().replace('+00:00', 'Z')
            total = client.usage(start)['total']['total_cost_usd']
            ledger = {'project': private['provider_project'], 'credential_ref': args.credential_ref, 'window_start': start,
                'baseline_cost_usd': str(cost(total)), 'requests': {}, 'max_new_spend_usd': '20', 'client_safety_reserve_usd': '2',
                'reservation_is_estimate_not_price_guarantee': True, 'provider_enforcement_delay_possible': True}
            atomic(budget_path, ledger)
        if ledger['credential_ref'] != args.credential_ref: raise SonioxPending('Another connection owns shared project budget')
        identity = {k: row[k] for k in ['source_id', 'post_id', 'video_id', 'item_id']}
        identity.update(audio_sha256=row['audio_proof']['sha256'], duration_seconds=row['audio_proof']['duration_seconds'],
                        credential_ref=args.credential_ref, model='stt-async-v5')
        payload, receipt = transcribe(client, row['audio_path'], identity, receipt_path, ledger, lambda v: atomic(budget_path, v),
            progress=lambda r: print(json.dumps({'item_id': row['item_id'], 'provider_job_id': r.get('transcription_id'),
                'stage': r.get('provider_status'), 'model': 'stt-async-v5'}), flush=True))
        text, srt, raw = token_outputs(payload, identity)
        receipt = publish_text(row, text, srt, raw, receipt, receipt_path)
        try:
            usage = client.billed(receipt['client_reference_id'], ledger['window_start'])
            ledger['requests'][receipt['client_reference_id']].update(state='billed', cost_usd=str(cost(usage['cost_usd'])), usage_uuid=usage['uuid'])
            atomic(budget_path, ledger)
            receipt['actual_cost_usd'] = str(cost(usage['cost_usd'])); atomic(receipt_path, receipt)
        except SonioxPending: receipt['billing_state'] = 'pending_actual_usage_no_next_charge'; atomic(receipt_path, receipt)
        out = local_call('original', {'item_id': row['item_id'], 'format': 'txt', 'max_chars': 128})
        if out['original_hash'] != receipt['saved_hashes']['txt'] or out['video_external_id'] != row['video_id']:
            raise SonioxPending('Canonical original identity/hash differs; retain media')
        srt_read = local_call('original', {'item_id': row['item_id'], 'format': 'srt', 'expected_document_hash': out['document_hash'], 'max_chars': 128})
        if srt_read['original_hash'] != receipt['saved_hashes']['srt']: raise SonioxPending('Saved paired SRT differs')
        request_id = 'soniox-item-' + str(row['item_id']) + '-' + receipt['saved_hashes']['txt'][:16]
        if receipt.get('document_hash') != out['document_hash'] or not receipt.get('index'):
            receipt['index'] = local_call('index/start', {'source_id': row['source_id'], 'item_ids': [row['item_id']],
                'request_id': 'soniox-item-' + str(row['item_id']) + '-' + out['document_hash'][:16]})
        receipt['document_hash'] = out['document_hash']; atomic(receipt_path, receipt)
        return {'ok': True, 'item_id': row['item_id'], 'video_id': row['video_id'], 'provider_job_id': receipt['transcription_id'],
            'receipt_path': str(receipt_path), 'state': receipt['state'], 'model': 'stt-async-v5', 'saved_hashes': receipt['saved_hashes'],
            'actual_cost_usd': receipt.get('actual_cost_usd'), 'billing_state': receipt.get('billing_state'),
            'speakers': sorted({str(t['speaker']) for t in raw['tokens'] if t.get('speaker') is not None}),
            'languages': sorted({t['language'] for t in raw['tokens'] if t.get('language')}),
            'index_job_id': receipt['index']['job_id'], 'index_accepted_is_not_current_ready': True, 'media_deleted': False}


def status_or_cleanup(args):
    download = load_state(args.download_job_id)
    row = next(r for r in download['selection'] if r['video_id'] == args.video_id)
    private = load(args.credential_ref); _, path = context_paths(private, row)
    if not path.exists(): return {'ok': True, 'ASR': 0, 'provider_job_ids': [], 'state': 'not_dispatched'}
    receipt = json.loads(path.read_text())
    if args.operation == 'reformat-saved':
        if receipt['state'] != 'saved': raise SonioxPending('Only a known saved result can be reformatted')
        for kind, name in receipt['files'].items():
            if sha_file(name) != receipt['saved_hashes'][kind]: raise SonioxPending('Saved original changed; no formatting overwrite')
        raw = json.loads(Path(receipt['files']['raw']).read_text())
        text, srt, replacement = token_outputs({'id': raw['transcription_id'], 'text': raw['text'], 'tokens': raw['tokens']}, raw['identity'])
        if Path(receipt['files']['txt']).read_text() != text: raise SonioxPending('TXT differs from original provider text')
        old = receipt['saved_hashes'].copy()
        revision = Path(receipt['files']['txt']).parent / 'revisions' / old['srt']
        revision.mkdir(parents=True, exist_ok=True)
        for kind in ['srt', 'raw']:
            file = Path(receipt['files'][kind]); backup = revision / file.name
            if backup.exists() and sha_file(backup) != old[kind]: raise SonioxPending('Historical revision differs')
            if not backup.exists(): shutil.copy2(file, backup)
        receipt['format_revision_inflight'] = {'old_hashes': old, 'backup': str(revision)}; atomic(path, receipt)
        for kind, value in [('srt', srt), ('raw', json.dumps(replacement, ensure_ascii=False))]:
            file = Path(receipt['files'][kind]); part = file.with_suffix(file.suffix + '.format-part')
            with part.open('w', encoding='utf-8') as stream:
                os.chmod(part, 0o600); stream.write(value); stream.flush(); os.fsync(stream.fileno())
            os.replace(part, file)
        receipt['saved_hashes'] = {k: sha_file(v) for k, v in receipt['files'].items()}
        receipt['format_revision'] = receipt.pop('format_revision_inflight'); atomic(path, receipt)
        conn = open_db()
        try:
            saved = conn.execute('SELECT raw_meta_json FROM items WHERE id=?', (row['item_id'],)).fetchone()
            meta = json.loads(saved['raw_meta_json'] or '{}'); meta['soniox']['raw_tokens_sha256'] = receipt['saved_hashes']['raw']
            conn.execute('UPDATE items SET raw_meta_json=?,updated_at=unixepoch() WHERE id=?', (json.dumps(meta, ensure_ascii=False), row['item_id']))
        finally: conn.close()
        original = local_call('original', {'item_id': row['item_id'], 'format': 'txt', 'max_chars': 128})
        if original['original_hash'] != receipt['saved_hashes']['txt']: raise SonioxPending('Public saved TXT changed')
        receipt['document_hash'] = original['document_hash']
        receipt['index'] = local_call('index/start', {'source_id': row['source_id'], 'item_ids': [row['item_id']],
            'request_id': 'soniox-format-' + str(row['item_id']) + '-' + receipt['document_hash'][:16]})
        atomic(path, receipt)
        return {'ok': True, 'provider_job_id': receipt['transcription_id'], 'new_paid_calls': 0,
            'saved_hashes': receipt['saved_hashes'], 'previous_revision': str(revision), 'index_job_id': receipt['index']['job_id']}
    if args.operation == 'tokens':
        file = Path(receipt['files']['raw']); digest = sha_file(file)
        if args.expected_hash and digest != args.expected_hash or args.offset and not args.expected_hash: raise SonioxPending('Same raw-token hash required')
        raw = json.loads(file.read_text()); tokens = raw['tokens']; end = min(len(tokens), args.offset + args.limit)
        return {'ok': True, 'identity': raw['identity'], 'raw_hash': digest, 'tokens': tokens[args.offset:end],
                'offset': args.offset, 'next_offset': end if end < len(tokens) else None, 'speaker_labels_are_not_names_or_roles': True}
    if args.operation in {'proof', 'cleanup'}:
        for kind, name in receipt.get('files', {}).items():
            if sha_file(name) != receipt['saved_hashes'][kind]: raise SonioxPending('Saved originals changed; retain media')
        original = local_call('original', {'item_id': row['item_id'], 'expected_document_hash': receipt['document_hash'], 'format': 'txt', 'max_chars': 128})
        if original['original_hash'] != receipt['saved_hashes']['txt']: raise SonioxPending('Original proof changed')
        paired = local_call('original', {'item_id': row['item_id'], 'expected_document_hash': receipt['document_hash'], 'format': 'srt', 'max_chars': 128})
        if paired['original_hash'] != receipt['saved_hashes']['srt']: raise SonioxPending('Paired SRT proof changed')
        public = local_call('interviews?source_id=' + str(row['source_id']) + '&limit=500')
        child = next(r for r in public['interviews'] if r['item_id'] == row['item_id'])
        if child['index']['state'] != 'ready_current' or child['document_hash'] != receipt['document_hash']: raise SonioxPending('Same-child current RAG not ready')
        context = local_call('context', {'item_id': row['item_id'], 'expected_document_hash': receipt['document_hash'], 'cue_index': 0, 'after_cues': 5, 'max_chars': 1200})
        if context['video_external_id'] != row['video_id'] or not context['cues']: raise SonioxPending('Same-child cue proof absent')
        raw = json.loads(Path(receipt['files']['raw']).read_text())
        if raw['identity']['video_id'] != row['video_id'] or raw['identity']['source_id'] != row['source_id'] or raw['identity']['item_id'] != row['item_id']:
            raise SonioxPending('Raw speaker/timing original belongs to another child')
        checked = []
        for cue in context['cues']:
            native = raw['cues'][cue['cue_index']]
            if (native['text'] != cue['text'] or abs(native['start_ms'] / 1000 - cue['start_seconds']) > .002
                or abs(native['end_ms'] / 1000 - cue['end_seconds']) > .002):
                raise SonioxPending('Raw speaker cue does not align with THIS saved SRT')
            checked.append({**cue, 'speaker': native['speaker'], 'languages': native['languages']})
        confidence = [t['confidence'] for t in raw['tokens'] if isinstance(t.get('confidence'), (int, float)) and math.isfinite(t['confidence'])]
        proof = {'ok': True, 'source_id': row['source_id'], 'item_id': row['item_id'], 'video_id': row['video_id'],
            'canonical_url': original['canonical_url'], 'document_hash': receipt['document_hash'], 'original_hashes': receipt['saved_hashes'],
            'current_rag': child['index'], 'provider_job_id': receipt['transcription_id'], 'model': raw['model'],
            'token_count': len(raw['tokens']), 'raw_speakers': sorted({str(t['speaker']) for t in raw['tokens'] if t.get('speaker') is not None}),
            'raw_languages': sorted({t['language'] for t in raw['tokens'] if t.get('language')}),
            'mean_token_confidence': sum(confidence) / len(confidence) if confidence else None,
            'quality_scope': 'requested_model_profile_original_hashes_cue_alignment_and_raw_labels_not_audio_WER_or_named_roles',
            'speaker_labels_not_names_or_roles': True, 'matched_context_cues': checked,
            'actual_cost_usd': receipt.get('actual_cost_usd'), 'media_deleted': receipt.get('own_media_deleted_after_current_rag', False)}
        if args.operation == 'proof': return proof
        if receipt.get('own_media_deleted_after_current_rag'): return proof
        inspect_storage(download['config'], external_mount=download['config']['external_mount'], expected_volume_uuid=download['config']['volume_uuid'], reserve_bytes=download['config']['reserve_bytes'])
        audio = Path(row['audio_path']).resolve(strict=True)
        if not audio.is_relative_to(Path(download['owned_root']).resolve()) or sha_file(audio) != row['audio_proof']['sha256']:
            raise SonioxPending('Exact owned media changed')
        conn = open_db()
        try:
            live = conn.execute('SELECT media_path,transcript_path FROM items WHERE id=?', (row['item_id'],)).fetchone()
            if live['media_path'] != str(audio) or live['transcript_path'] != receipt['files']['txt']: raise SonioxPending('Live pointer changed; no eviction')
            receipt['cleanup_state'] = 'delete_owned_inflight'; atomic(path, receipt)
            audio.unlink()
            conn.execute("UPDATE items SET media_path=NULL,download_status='evicted',download_error=NULL,updated_at=unixepoch() WHERE id=? AND media_path=?", (row['item_id'], str(audio)))
        finally: conn.close()
        receipt['own_media_deleted_after_current_rag'] = True; atomic(path, receipt)
        from boosty_download_phase import state_path
        journal = state_path(args.download_job_id).with_suffix('.evicted.json')
        with exclusive_run(journal.with_suffix('.lock')):
            evicted = json.loads(journal.read_text()) if journal.exists() else {'job_id': args.download_job_id, 'items': {}}
            evicted['items'][str(row['item_id'])] = {'video_id': row['video_id'], 'audio_path': str(audio), 'bytes': row['audio_proof']['bytes'],
                'sha256': row['audio_proof']['sha256'], 'document_hash': receipt['document_hash'], 'paid_receipt': str(path)}
            atomic(journal, evicted)
    return {'ok': True, 'state': receipt['state'], 'provider_job_id': receipt.get('transcription_id'),
        'file_id': receipt.get('file_id'), 'unpaid_upload_recovery_attempt': receipt.get('unpaid_upload_recovery_attempt', 0),
        'receipt_path': str(path), 'saved_hashes': receipt.get('saved_hashes'), 'actual_cost_usd': receipt.get('actual_cost_usd'),
        'index': receipt.get('index'), 'media_deleted': receipt.get('own_media_deleted_after_current_rag', False)}


def batch_path(args):
    private = load(args.credential_ref)
    # The existing project/paid receipts and exact download selection survive
    # controller restarts. This is not a new paid namespace.
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', args.download_job_id): raise ValueError('Invalid download job')
    return app_root() / 'jobs/boosty-soniox' / private['provider_project'] / ('batch-' + args.download_job_id + '.json')


def batch_status(args):
    path = batch_path(args)
    state = json.loads(path.read_text()) if path.exists() else {'status': 'not_started'}
    private = load(args.credential_ref); download = load_state(args.download_job_id)
    budget = path.parent / 'budget.json'; ledger = json.loads(budget.read_text()) if budget.exists() else {'requests': {}}
    entries = list(ledger['requests'].values())
    own_ids = {r['item_id'] for r in download['selection']}
    own_entries = [r for r in entries if r.get('identity', {}).get('platform') != 'telegram' and r.get('identity', {}).get('item_id') in own_ids]
    total = sum((cost(r['cost_usd']) for r in entries if r.get('state') == 'billed'), cost('0'))
    return {'ok': True, 'download_job_id': args.download_job_id, 'batch': state,
        'actual_spend_usd': str(total), 'budget_usd': ledger.get('max_new_spend_usd', '20'), 'client_safety_reserve_usd': ledger.get('client_safety_reserve_usd', '2'),
        'reserved_usd': str(sum((cost(r['reservation_usd']) for r in entries if r.get('state') != 'billed'), cost('0'))),
        'reserved_or_unknown_requests': sum(r.get('state') != 'billed' for r in entries),
        'billed_requests': sum(r.get('state') == 'billed' for r in own_entries),
        'project_billed_requests': sum(r.get('state') == 'billed' for r in entries),
        'download_state': download['status'], 'download_ready_count': sum(r['state'] == 'ready_audio' for r in download['selection']),
        'selection_total': len(download['selection']), 'provider_cap_is_absolute_guarantee': False}


def reconcile_evictions(args):
    """Metadata-only repair of THIS paid workflow's already proven evictions."""
    from boosty_download_phase import state_path
    journal_path = state_path(args.download_job_id).with_suffix('.evicted.json')
    entries = json.loads(journal_path.read_text())['items'] if journal_path.exists() else {}
    conn = open_db(); updated = 0
    try:
        for identifier, entry in entries.items():
            receipt = json.loads(Path(entry['paid_receipt']).read_text())
            if receipt.get('own_media_deleted_after_current_rag') is not True: raise SonioxPending('Eviction not confirmed')
            identity = receipt['identity']
            if identity['item_id'] != int(identifier) or identity['video_id'] != entry['video_id']: raise SonioxPending('Eviction identity mismatch')
            if not all(sha_file(file) == receipt['saved_hashes'][kind] for kind, file in receipt['files'].items()): raise SonioxPending('Saved pair/raw changed')
            updated += conn.execute("UPDATE items SET download_status='evicted',download_error=NULL WHERE id=? AND source_id=? AND external_id=? AND media_path IS NULL AND transcript_path=? AND download_status!='evicted'",
                (identity['item_id'], identity['source_id'], identity['video_id'], receipt['files']['txt'])).rowcount
    finally: conn.close()
    return {'ok': True, 'confirmed_own_evictions': len(entries), 'metadata_rows_updated': updated, 'media_deleted_now': 0, 'paid_calls': 0}


def run_batch(args):
    path = batch_path(args)
    with exclusive_run(path.with_suffix('.lock')):
        state = json.loads(path.read_text()) if path.exists() else {'download_job_id': args.download_job_id, 'credential_ref': args.credential_ref}
        if state.get('credential_ref') != args.credential_ref: raise SonioxPending('Batch connection changed')
        if args.run_token and state.get('run_token') != args.run_token: raise SonioxPending('Controller identity changed')
        state.update(status='running', pid=os.getpid(), started_at=time.time())
        atomic(path, state)
        conn = open_db()
        try:
            if not state.get('db_job_id'):
                state['db_job_id'] = conn.execute("INSERT INTO jobs(type,status,items_total,items_done,parameters_json,started_at,pid) VALUES('boosty_soniox_bulk','running',?,0,?,?,?)",
                    (len(load_state(args.download_job_id)['selection']), json.dumps({'download_job_id': args.download_job_id, 'credential_ref': args.credential_ref, 'origin': 'mcp', 'autoCopy': False}), int(time.time()), os.getpid())).lastrowid
                atomic(path, state)
            else: conn.execute("UPDATE jobs SET status='running',pid=? WHERE id=?", (os.getpid(), state['db_job_id']))
            # The first real sample must already have SAME-hash public proof;
            # accepting a provider ID or index ACK never releases the batch.
            sample = status_or_cleanup(SimpleNamespace(**{**vars(args), 'operation': 'proof'}))
            if sample.get('current_rag', {}).get('state') != 'ready_current': raise SonioxPending('First real sample not verified')
            completed = 0
            for row in load_state(args.download_job_id)['selection']:
                current = load_state(args.download_job_id)
                row = next(r for r in current['selection'] if r['item_id'] == row['item_id'])
                child_args = SimpleNamespace(**{**vars(args), 'video_id': row['video_id']})
                private = load(args.credential_ref); _, receipt_path = context_paths(private, row)
                receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
                if receipt and receipt.get('own_media_deleted_after_current_rag'): completed += 1; continue
                if row['state'] != 'ready_audio':
                    if row['state'] in {'locked', 'access_unknown', 'unavailable_audio', 'cached_user_media', 'ready_transcript_reused'}: continue
                    state.update(status='paused_waiting_download', waiting_item_id=row['item_id']); atomic(path, state)
                    break
                state.update(status='running', current_item_id=row['item_id'], current_video_id=row['video_id'], completed=completed)
                atomic(path, state)
                if not receipt or receipt['state'] != 'saved': run_one(child_args)
                else:
                    # Reconcile an already saved bill/index through the SAME
                    # provider ID and files; never new upload/create.
                    run_one(child_args)
                started = time.monotonic()
                while True:
                    receipt = json.loads(receipt_path.read_text())
                    if receipt.get('actual_cost_usd') is None: raise SonioxPending('Actual billing pending; no next charge')
                    try:
                        proof = status_or_cleanup(SimpleNamespace(**{**vars(child_args), 'operation': 'proof'}))
                        break
                    except SonioxPending:
                        status = local_call('index/status?job_id=' + receipt['index']['job_id'] + '&source_id=' + str(row['source_id']))
                        if status['job']['status'] in {'error', 'cancelled', 'interrupted'}: raise SonioxPending('Exact RAG index needs safe resume')
                        if time.monotonic() - started > 600: raise SonioxPending('Public RAG pending; media retained')
                        time.sleep(3)
                status_or_cleanup(SimpleNamespace(**{**vars(child_args), 'operation': 'cleanup'}))
                completed += 1; state['completed'] = completed; atomic(path, state)
                conn.execute('UPDATE jobs SET items_done=? WHERE id=?', (completed, state['db_job_id']))
                print(json.dumps({'stage': 'child_ready_current_and_evicted', 'item_id': row['item_id'], 'video_id': row['video_id'],
                    'actual_cost_usd': proof['actual_cost_usd'], 'completed': completed}), flush=True)
            else: state['status'] = 'done_current_selection'
        except SonioxPending as error:
            state['status'] = 'paused_safe'; state['stop_reason'] = str(error)
        except (KeyboardInterrupt, SystemExit):
            state['status'] = 'interrupted'; state['stop_reason'] = 'caller_stop_known_receipts_preserved'
        except Exception as error:
            state['status'] = 'error'; state['error_type'] = type(error).__name__
        finally:
            state['pid'] = None; state['finished_at'] = time.time(); atomic(path, state)
            if state.get('db_job_id'): conn.execute('UPDATE jobs SET status=?,pid=NULL,finished_at=? WHERE id=?', (state['status'], int(time.time()), state['db_job_id']))
            conn.close()
    return batch_status(args)


def background_batch(args):
    path = batch_path(args)
    with exclusive_run(path.with_suffix('.lock')):
        old = json.loads(path.read_text()) if path.exists() else {}
        if old.get('pid') or old.get('status') in {'running', 'dispatching'}: raise SonioxPending('Existing controller active/unconfirmed; no duplicate')
        token = str(uuid.uuid4()); state = {**old, 'download_job_id': args.download_job_id, 'credential_ref': args.credential_ref,
            'run_token': token, 'status': 'dispatching'}; atomic(path, state)
        parallel = args.operation == 'parallel-background' or old.get('mode') == 'parallel'
        if parallel:
            state.update(mode='parallel', workers=args.workers if args.operation == 'parallel-background' else old.get('workers', 8),
                         quota_proof_file=args.quota_proof_file or old.get('quota_proof_file'))
            atomic(path, state)
        output = path.with_suffix('.ndjson'); env = os.environ.copy()
        for name in list(env):
            if name.endswith('API_KEY'): env.pop(name, None)
        with output.open('ab') as stream:
            os.chmod(output, 0o600)
            command = [sys.executable, str(Path(__file__).resolve()), 'parallel-bulk' if parallel else 'bulk', '--download-job-id', args.download_job_id,
                '--video-id', args.video_id, '--credential-ref', args.credential_ref, '--run-token', token]
            if parallel: command += ['--workers', str(state['workers']), '--quota-proof-file', state['quota_proof_file']]
            child = subprocess.Popen(command,
                stdin=subprocess.DEVNULL, stdout=stream, stderr=stream, env=env, start_new_session=True)
        # Parent must not overwrite a fast runner's updated state after launch.
        # The run lock is still held here; runner will publish its own PID.
        return {'ok': True, 'accepted': True, 'pid': child.pid, 'run_token': token, 'receipt_path': str(path), 'log_path': str(output)}


def main():
    p = argparse.ArgumentParser(prog='sc boosty-soniox', description=__doc__)
    p.add_argument('operation', choices=['preflight', 'run-one', 'status', 'tokens', 'proof', 'cleanup', 'reformat-saved', 'bulk', 'background', 'batch-status', 'reconcile-evictions', 'reconcile-delivery', 'retry-unpaid-upload', 'provider-info', 'quarantine-unpaid', 'provider-cleanup', 'provider-cleanup-all', 'parallel-bulk', 'parallel-background', 'parallel-pause'])
    p.add_argument('--download-job-id', required=True); p.add_argument('--video-id', required=True); p.add_argument('--credential-ref', required=True)
    p.add_argument('--offset', type=int, default=0); p.add_argument('--limit', type=int, default=100); p.add_argument('--expected-hash')
    p.add_argument('--run-token')
    p.add_argument('--max-items', type=int, default=0)
    p.add_argument('--workers', type=int, default=8); p.add_argument('--quota-proof-file')
    args = p.parse_args()
    try:
        if not 0 <= args.offset or not 1 <= args.limit <= 1000 or args.max_items < 0 or not 1 <= args.workers <= 8: raise ValueError('Invalid pagination/bounded workers')
        if args.operation == 'preflight':
            _, row, private = selected(args)
            result = {'ok': True, 'item_id': row['item_id'], 'video_id': row['video_id'], 'model': private['model'],
                      'duration_seconds': row['audio_proof']['duration_seconds'], 'media_verified_external': True, 'paid_dispatch': False}
        elif args.operation == 'run-one': result = run_one(args)
        elif args.operation == 'bulk': result = run_batch(args)
        elif args.operation in {'background', 'parallel-background'}: result = background_batch(args)
        elif args.operation == 'parallel-bulk':
            from shared.boosty_soniox_parallel import run
            result = run(sys.modules[__name__], args)
        elif args.operation == 'parallel-pause':
            from shared.boosty_soniox_parallel import request_pause
            result = request_pause(sys.modules[__name__], args)
        elif args.operation == 'batch-status': result = batch_status(args)
        elif args.operation == 'reconcile-evictions': result = reconcile_evictions(args)
        elif args.operation == 'reconcile-delivery': result = recover_delivery(args)
        elif args.operation == 'retry-unpaid-upload': result = recover_delivery(args)
        elif args.operation in {'provider-info', 'quarantine-unpaid', 'provider-cleanup', 'provider-cleanup-all'}:
            from shared.boosty_soniox_parallel import provider_info, quarantine_unpaid, provider_cleanup_one, provider_cleanup_all
            if args.operation == 'provider-info': result = provider_info(load(args.credential_ref))
            else:
                module = sys.modules[__name__]
                result = (quarantine_unpaid(module, args) if args.operation == 'quarantine-unpaid' else
                          provider_cleanup_all(module, args) if args.operation == 'provider-cleanup-all' else provider_cleanup_one(module, args))
        else: result = status_or_cleanup(args)
        print(json.dumps(result, ensure_ascii=False)); return 0
    except Exception as error:
        print(json.dumps({'ok': False, 'code': 'BOOSTY_SONIOX_' + ('PAUSED' if isinstance(error, SonioxPending) else 'FAILED'),
            'error_type': type(error).__name__, 'provider_error_code': getattr(error, 'code', None),
            'provider_http_status': getattr(error, 'status', None),
            'recovery': 'Read exact receipt; no new credential/paid namespace or blind POST retry'})); return 1


if __name__ == '__main__': raise SystemExit(main())
