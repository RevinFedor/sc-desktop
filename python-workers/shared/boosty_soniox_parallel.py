"""Supported Boosty parallel lifecycle; never a second provider/budget namespace."""
import json
import time
import uuid
import sys
import os
import hashlib
import queue
import concurrent.futures
import threading
import signal
import subprocess
from types import SimpleNamespace
from collections import Counter
from pathlib import Path
from shared.boosty_soniox import Client, SonioxPending, atomic, cost, digest
from shared.boosty_soniox import token_outputs
from shared.boosty_soniox_budget import SharedBudget, project_transaction


def inventory(client, route, field):
    rows, cursors, params = [], set(), {'limit': 1000}
    for _ in range(32):
        page = client.call(route, params=params)
        if not isinstance(page.get(field), list):
            raise SonioxPending('Provider inventory unavailable')
        rows.extend(page[field]); cursor = page.get('next_page_cursor')
        if cursor is None:
            ids = [r.get('id') for r in rows]
            if len(set(ids)) != len(ids): raise SonioxPending('Duplicate provider inventory IDs')
            return rows
        if cursor in cursors: raise SonioxPending('Provider inventory cursor cycle')
        cursors.add(cursor); params['cursor'] = cursor
    raise SonioxPending('Provider inventory incomplete')


def provider_info(private):
    client = Client(private['key'])
    files = inventory(client, 'files', 'files')
    jobs = inventory(client, 'transcriptions', 'transcriptions')
    sizes = [r.get('size') for r in files]
    known = [n for n in sizes if isinstance(n, int) and not isinstance(n, bool) and n >= 0]
    # This endpoint is REALTIME WebSocket concurrency, not an async cap.
    realtime = client.call('concurrency-limits')
    counts = {}
    for route in ['files/count', 'transcriptions/count']:
        payload = client.call(route)
        counts[route] = {k: v for k, v in payload.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
    return {'ok': True, 'provider_files': len(files), 'provider_file_bytes': sum(known),
            'unknown_file_sizes': len(sizes) - len(known), 'provider_jobs': len(jobs),
            'provider_job_states': dict(Counter(r.get('status') or 'unknown' for r in jobs)),
            'counts': counts, 'realtime_concurrency_not_async': realtime,
            'async_storage_default_bytes': 10_000_000_000,
            'async_pending_default': 100, 'defaults_are_not_live_project_quota_proof': True,
            'provider_uploads': 0, 'paid_requests': 0, 'inventory_complete': True,
            'checked_at': time.time()}


def quarantine_unpaid(cli, args):
    _, row, private = cli.selected(args)
    budget_path, receipt_path = cli.context_paths(private, row)
    client = Client(private['key'])
    files = inventory(client, 'files', 'files')
    jobs = inventory(client, 'transcriptions', 'transcriptions')
    with cli.exclusive_run(budget_path.with_suffix('.lock')):
        receipt = json.loads(receipt_path.read_text()); ledger = json.loads(budget_path.read_text())
        ref = receipt['client_reference_id']
        if receipt['state'] == 'quarantined_unpaid_upload':
            entry = ledger['requests'][ref]
            if entry.get('paid_create_barrier_never_crossed') is not True or entry['identity'] != receipt['identity']:
                raise SonioxPending('Existing quarantine ownership differs')
            entry['cloud_storage_reservation_bytes'] = Path(row['audio_path']).stat().st_size
            atomic(budget_path, ledger)
            return {'ok': True, 'deduplicated': True, 'item_id': row['item_id'], 'state': receipt['state'],
                    'risk_reservation_usd': entry['reservation_usd'], 'new_uploads': 0, 'paid_requests': 0}
        if (receipt['state'] != 'upload_inflight' or receipt.get('transcription_id') or receipt.get('file_id')
                or receipt.get('recovery_paid_create_attempted') is True):
            raise SonioxPending('Only proven pre-paid-create upload can be quarantined')
        entry = ledger['requests'][ref]
        if entry['identity'] != receipt['identity'] or entry['state'] != 'reserved':
            raise SonioxPending('Exact original risk reservation required')
        if digest(row['audio_path']) != receipt['identity']['audio_sha256']:
            raise SonioxPending('Owned original changed')
        refs = {ref, receipt.get('upload_reference_id') or ref}
        if any(f.get('client_reference_id') in refs or f.get('filename') == Path(row['audio_path']).name for f in files):
            raise SonioxPending('Existing candidate file requires exact GET reconciliation')
        if any(t.get('client_reference_id') == ref for t in jobs):
            raise SonioxPending('Existing paid request cannot be quarantined as unpaid')
        previous = {k: receipt.get(k) for k in ['state', 'unpaid_upload_recovery_attempt', 'upload_reference_id', 'original_upload_outcome']}
        receipt.update(state='quarantined_unpaid_upload', quarantine={'previous': previous,
            'paid_create_barrier_never_crossed': True, 'files_seen': len(files), 'jobs_seen': len(jobs),
            'unknown_upload_not_erased': True, 'checked_at': time.time()})
        entry.update(state='quarantined_unpaid_upload', paid_create_barrier_never_crossed=True,
                     risk_reservation_retained=True)
        # Never release the monetary risk or permit this child to POST again.
        atomic(receipt_path, receipt); atomic(budget_path, ledger)
    return {'ok': True, 'item_id': row['item_id'], 'state': receipt['state'],
            'risk_reservation_usd': entry['reservation_usd'], 'new_uploads': 0, 'paid_requests': 0}


def provider_cleanup_one(cli, args):
    """Delete only THIS completed cloud file after current local public proof."""
    proof = cli.status_or_cleanup(type(args)(**{**vars(args), 'operation': 'proof'}))
    if proof.get('current_rag', {}).get('state') != 'ready_current' or proof.get('actual_cost_usd') is None:
        raise SonioxPending('Current original and actual bill required for cloud cleanup')
    download = cli.load_state(args.download_job_id)
    row = next(r for r in download['selection'] if r['video_id'] == args.video_id)
    private = cli.load(args.credential_ref); budget_path, receipt_path = cli.context_paths(private, row)
    client = Client(private['key'])
    with cli.exclusive_run(receipt_path.with_suffix('.cloud.lock')):
        receipt = json.loads(receipt_path.read_text())
        if receipt.get('provider_file_deleted_after_current_rag'): return {'ok': True, 'already_deleted': True, 'deleted_bytes': 0}
        ledger = json.loads(budget_path.read_text()); entry = ledger['requests'][receipt['client_reference_id']]
        if entry['state'] != 'billed' or entry['identity'] != receipt['identity']:
            raise SonioxPending('Cloud cleanup requires exact billed ownership')
        fid = str(uuid.UUID(receipt['file_id'])); tid = str(uuid.UUID(receipt['transcription_id']))
        job = client.call('transcriptions/' + tid)
        if job.get('status') != 'completed' or job.get('file_id') != fid or job.get('client_reference_id') != receipt['client_reference_id']:
            raise SonioxPending('Active/foreign cloud input must be retained')
        related = [j for j in inventory(client, 'transcriptions', 'transcriptions') if j.get('file_id') == fid]
        if any(j.get('status') not in {'completed', 'error', 'failed'} for j in related):
            raise SonioxPending('Another active transcription references this cloud file')
        try: file = client.call('files/' + fid)
        except Exception as error:
            if getattr(error, 'status', None) == 404 and receipt.get('provider_file_delete_intent', {}).get('file_id') == fid:
                receipt['provider_file_deleted_after_current_rag'] = True; atomic(receipt_path, receipt)
                return {'ok': True, 'reconciled_delete': True, 'deleted_bytes': 0}
            raise
        expected_ref = receipt.get('upload_reference_id') or receipt['client_reference_id']
        if file.get('client_reference_id') != expected_ref or file.get('filename') != Path(row['audio_path']).name:
            raise SonioxPending('Cloud file ownership changed')
        receipt['provider_file_delete_intent'] = {'file_id': fid, 'size': file['size'],
            'document_hash': proof['document_hash'], 'original_hashes': proof['original_hashes'], 'checked_at': time.time()}
        atomic(receipt_path, receipt)
        client.call('files/' + fid, method='DELETE')
        try: client.call('files/' + fid)
        except Exception as error:
            if getattr(error, 'status', None) != 404: raise
        else: raise SonioxPending('Cloud deletion unconfirmed; retain intent')
        receipt['provider_file_deleted_after_current_rag'] = True; atomic(receipt_path, receipt)
        return {'ok': True, 'item_id': row['item_id'], 'file_id': fid, 'deleted_bytes': file['size'],
                'local_originals_retained': True, 'provider_job_retained': True, 'paid_requests': 0}


def provider_cleanup_all(cli, args):
    """Bounded serial maintenance over original selected/billed children only."""
    private = cli.load(args.credential_ref); download = cli.load_state(args.download_job_id)
    completed, removed, errors = 0, 0, []
    for row in download['selection']:
        _, path = cli.context_paths(private, row)
        if not path.exists(): continue
        receipt = json.loads(path.read_text())
        if receipt.get('state') != 'saved' or receipt.get('actual_cost_usd') is None: continue
        if args.max_items and completed >= args.max_items: break
        child = type(args)(**{**vars(args), 'video_id': row['video_id']})
        try:
            out = provider_cleanup_one(cli, child); removed += out['deleted_bytes']; completed += 1
            print(json.dumps({'stage': 'provider_file_cleanup_verified', **out}), flush=True)
        except Exception as error:
            errors.append({'item_id': row['item_id'], 'error_type': type(error).__name__,
                           'provider_error_code': getattr(error, 'code', None), 'provider_http_status': getattr(error, 'status', None)})
            # Rate errors/unknown delete retain intent; no repeat DELETE loop.
            break
    return {'ok': not errors, 'verified': completed, 'deleted_bytes': removed, 'errors': errors, 'paid_requests': 0}


class BudgetClient(Client):
    def __init__(self, key, budget, policy):
        super().__init__(key); self.budget = budget; self.policy = policy

    def call(self, route, **opts):
        if route in {'usage/summary', 'usage-logs'}:
            field = 'usage_summary_rpm' if route == 'usage/summary' else 'usage_logs_rpm'
            # Leave10% RPM room for independent read-only observers.
            self.budget.rate_limit(route, max(1, int(self.policy[field]) * 9 // 10))
        return super().call(route, **opts)


def configure_policy(cli, args, state):
    private = cli.load(args.credential_ref); path = cli.context_paths(private, {'item_id': 0})[0]
    proof_path = args.quota_proof_file or state.get('quota_proof_file')
    if not proof_path: raise SonioxPending('Fresh effective async quota proof required')
    raw = Path(proof_path).read_bytes(); proof = json.loads(raw)
    if (proof.get('read_status') != 200 or proof.get('project') != private['provider_project']
        or proof.get('provider_org') != private['provider_org'] or proof.get('project_quota_inheritance_confirmed_by_previous_GET') is not True):
        raise SonioxPending('Effective same-project async quota proof differs')
    recorded = __import__('datetime').datetime.fromisoformat(proof['recorded_at'].replace('Z', '+00:00')).timestamp()
    if time.time() - recorded > 86400: raise SonioxPending('Async quota observation too old for new admission')
    regions = [r for r in proof['region_limits'] if r.get('region') == 'main']
    if len(regions) != 1: raise SonioxPending('Fixed API main region must have exact quota evidence')
    quota = regions[0]; report = provider_info(private)
    occupied = sum(n for s, n in report['provider_job_states'].items() if s not in {'completed', 'error', 'failed'})
    workers = min(args.workers, int(quota['transcribe_async_concurrent']) - occupied,
                  int(quota['transcribe_async_pending_num_files']) - occupied)
    if not 1 <= workers <= 8 or report['unknown_file_sizes']:
        raise SonioxPending('No proven bounded async capacity')
    policy = {'workers': workers, 'configured_async_concurrent': quota['transcribe_async_concurrent'],
              'observed_other_pending': occupied, 'provider_storage_ceiling_bytes': int(cost(quota['files_total_size_gb']) * 1_000_000_000),
              'initial_provider_file_bytes': report['provider_file_bytes'], 'usage_summary_rpm': int(quota['usage_summary_rpm']),
              'usage_logs_rpm': int(quota['usage_logs_rpm']), 'quota_proof_sha256': hashlib.sha256(raw).hexdigest(),
              'configured_at': time.time(), 'run_token': state['run_token']}
    with project_transaction(path):
        ledger = json.loads(path.read_text())
        if cost(private['provider_budget_usd']) < cost(ledger['baseline_cost_usd']) + cost(ledger.get('max_new_spend_usd', '20')):
            raise SonioxPending('Client release exceeds verified provider monthly cap')
        ledger['parallel_policy'] = policy; atomic(path, ledger)
    state.update(workers=workers, quota_proof_file=str(proof_path), parallel_policy=policy)
    return policy, SharedBudget(path, args.credential_ref, state['run_token'])


def provider_worker(cli, args, budget, policy, events):
    # An item lock spans its full lifecycle; the PROJECT mutex never spans I/O.
    download = cli.load_state(args.download_job_id)
    row = next(r for r in download['selection'] if r['video_id'] == args.video_id)
    private = cli.load(args.credential_ref); _, path = cli.context_paths(private, row)
    with cli.exclusive_run(path.with_suffix('.worker.lock')):
        _, row, private = cli.selected(args)
        identity = {k: row[k] for k in ['source_id', 'post_id', 'video_id', 'item_id']}
        identity.update(audio_sha256=row['audio_proof']['sha256'], duration_seconds=row['audio_proof']['duration_seconds'],
                        credential_ref=args.credential_ref, model='stt-async-v5')
        client = BudgetClient(private['key'], budget, policy)
        receipt = json.loads(path.read_text()) if path.exists() else None
        reference = receipt.get('client_reference_id') if receipt else 'boosty-' + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        if receipt and receipt['identity'] != identity: raise SonioxPending('Exact input identity changed; no paid replay')
        if receipt and receipt['state'] in {'upload_inflight', 'submit_inflight', 'quarantined_unpaid_upload'}:
            raise SonioxPending('Exact unresolved delivery cannot enter new POST')
        if not receipt:
            total = client.usage(budget.read()['window_start'])['total']['total_cost_usd']
            budget.admit(reference, identity, path, Path(row['audio_path']).stat().st_size, total)
            receipt = json.loads(path.read_text())
        else:
            def adopt(ledger):
                entry = ledger['requests'][reference]
                if entry['identity'] != identity or entry.get('outcome_unknown'):
                    raise SonioxPending('Uncertain paid outcome cannot be adopted')
                entry.setdefault('resume_history', []).append({'previous_run_token': entry.get('active_run_token'), 'at': time.time()})
                entry['active_run_token'] = budget.run_token
            budget.update(adopt)
        def phase(value):
            events.put({'item_id': row['item_id'], 'video_id': row['video_id'], 'phase': value,
                        'provider_job_id': receipt.get('transcription_id'), 'at': time.time()})
        try:
            if receipt['state'] == 'not_submitted':
                receipt['state'] = 'upload_inflight'; atomic(path, receipt); budget.mark(reference, state='upload_inflight')
                phase('uploading')
                data = client.call('files', method='POST', audio=row['audio_path'], body={'client_reference_id': reference})
                fid = str(uuid.UUID(data['id'])); meta = client.call('files/' + fid)
                if meta.get('client_reference_id') != reference or meta.get('filename') != Path(row['audio_path']).name or meta.get('size') != Path(row['audio_path']).stat().st_size:
                    raise SonioxPending('Uploaded file ownership differs')
                receipt.update(state='uploaded', file_id=fid); atomic(path, receipt)
                budget.mark(reference, state='uploaded', file_id=fid)
            if receipt['state'] == 'uploaded':
                total = client.usage(budget.read()['window_start'])['total']['total_cost_usd']
                budget.before_create(reference, total)
                receipt['state'] = 'submit_inflight'; atomic(path, receipt)
                data = client.call('transcriptions', method='POST', body={'file_id': receipt['file_id'], 'model': 'stt-async-v5',
                    'language_hints': ['ru', 'en'], 'enable_language_identification': True,
                    'enable_speaker_diarization': True, 'client_reference_id': reference})
                receipt.update(state='submitted', transcription_id=str(uuid.UUID(data['id']))); atomic(path, receipt)
                budget.mark(reference, state='submitted', transcription_id=receipt['transcription_id']); phase('submitted')
            if not receipt.get('transcription_id'): raise SonioxPending('No known paid ID; no replacement')
            deadline = time.monotonic() + 3600
            while receipt['state'] not in {'completed', 'saved'}:
                data = client.call('transcriptions/' + receipt['transcription_id'])
                if data.get('id') != receipt['transcription_id'] or data.get('model') != 'stt-async-v5':
                    raise SonioxPending('Provider identity/profile differs')
                status = data.get('status'); receipt['provider_status'] = status; atomic(path, receipt)
                phase(status)
                if status == 'completed':
                    if data.get('enable_speaker_diarization') is not True or data.get('enable_language_identification') is not True:
                        raise SonioxPending('Requested speaker/language profile absent')
                    receipt.update(state='completed', provider_metadata={k: data.get(k) for k in ['id', 'model', 'status', 'audio_duration_ms', 'enable_speaker_diarization', 'enable_language_identification']})
                    atomic(path, receipt); budget.mark(reference, state='completed'); break
                if status in {'failed', 'error'}: raise SonioxPending('Known provider terminal failure; retain paid receipt')
                if time.monotonic() > deadline: raise SonioxPending('Known provider pending; GET-only resume')
                time.sleep(3)
            if receipt['state'] == 'saved':
                raw = json.loads(Path(receipt['files']['raw']).read_text())
                if digest(receipt['files']['raw']) != receipt['saved_hashes']['raw']: raise SonioxPending('Saved raw hash changed')
                payload = {'id': raw['transcription_id'], 'text': raw['text'], 'tokens': raw['tokens']}
            else: payload = client.call('transcriptions/' + receipt['transcription_id'] + '/transcript')
            if payload.get('id') != receipt['transcription_id']: raise SonioxPending('Another transcript returned')
            text, srt, raw = token_outputs(payload, identity)
            receipt = cli.publish_text(row, text, srt, raw, receipt, path)
            phase('saved')
            deadline = time.monotonic() + 600
            while receipt.get('actual_cost_usd') is None:
                try:
                    billing = client.billed(reference, budget.read()['window_start']); budget.bill(reference, billing)
                    receipt['actual_cost_usd'] = str(cost(billing['cost_usd'])); atomic(path, receipt)
                except SonioxPending:
                    if time.monotonic() > deadline: raise
                    time.sleep(3)
            phase('billed')
            return row
        except Exception as error:
            receipt.update(last_error={'stage': receipt['state'], 'type': type(error).__name__,
                'provider_code': getattr(error, 'code', None), 'http_status': getattr(error, 'status', None), 'at': time.time()})
            atomic(path, receipt)
            if receipt['state'] in {'upload_inflight', 'submit_inflight'}:
                budget.mark(reference, outcome_unknown=True)
            phase('paused'); raise


def finish_group(cli, args, rows, budget, events):
    source = rows[0]['source_id']; private = cli.load(args.credential_ref)
    revisions = []
    for row in rows:
        _, path = cli.context_paths(private, row); receipt = json.loads(path.read_text())
        original = cli.local_call('original', {'item_id': row['item_id'], 'format': 'txt', 'max_chars': 128})
        paired = cli.local_call('original', {'item_id': row['item_id'], 'format': 'srt', 'expected_document_hash': original['document_hash'], 'max_chars': 128})
        if original['original_hash'] != receipt['saved_hashes']['txt'] or paired['original_hash'] != receipt['saved_hashes']['srt'] or original['video_external_id'] != row['video_id']:
            raise SonioxPending('Same-child public pair differs; retain media')
        receipt['document_hash'] = original['document_hash']; atomic(path, receipt)
        revisions.append((row['item_id'], receipt['document_hash']))
    key = 'soniox-parallel-' + str(source) + '-' + hashlib.sha256(json.dumps(revisions).encode()).hexdigest()[:24]
    body = {'source_id': source, 'item_ids': [r['item_id'] for r in rows], 'request_id': key}
    job = cli.local_call('index/start', body)
    for row in rows:
        _, path = cli.context_paths(private, row); receipt = json.loads(path.read_text()); receipt['index'] = job; atomic(path, receipt)
    deadline = time.monotonic() + 1200
    for attempt in range(3):
        while True:
            status = cli.local_call('index/status?job_id=' + job['job_id'] + '&source_id=' + str(source))
            phase = status['job']['status']
            if phase in {'done', 'error', 'cancelled', 'interrupted'}: break
            if time.monotonic() > deadline: raise SonioxPending('Current RAG pending; keep originals/media')
            time.sleep(3)
        if phase == 'done': break
        job = cli.local_call('index/resume', {**body, 'resume_of': job['job_id'], 'request_id': key + '-resume-' + str(attempt)})
        for row in rows:
            _, path = cli.context_paths(private, row); receipt = json.loads(path.read_text()); receipt['index'] = job; atomic(path, receipt)
    else: raise SonioxPending('RAG exact scope needs further safe resume')
    for row in rows:
        child = SimpleNamespace(**{**vars(args), 'video_id': row['video_id'], 'operation': 'cleanup'})
        cli.status_or_cleanup(child)
        cloud = provider_cleanup_one(cli, child)
        _, path = cli.context_paths(private, row); receipt = json.loads(path.read_text())
        budget.mark(receipt['client_reference_id'], provider_file_deleted_after_current_rag=True)
        events.put({'item_id': row['item_id'], 'video_id': row['video_id'], 'phase': 'ready_current_evicted',
                    'provider_job_id': receipt['transcription_id'], 'at': time.time()})
    return rows


def run(cli, args):
    path = cli.batch_path(args)
    with cli.exclusive_run(path.with_suffix('.lock')):
        state = json.loads(path.read_text()) if path.exists() else {}
        if state.get('credential_ref') != args.credential_ref or not state.get('db_job_id'):
            raise SonioxPending('Existing tracked batch/connection required; no second job')
        if args.run_token and state.get('run_token') != args.run_token:
            raise SonioxPending('Controller identity changed')
        state.setdefault('continuations', []).append({k: state.get(k) for k in ['status', 'run_token', 'error_type', 'stop_reason', 'finished_at']})
        state.update(status='running', mode='parallel', pid=os.getpid(), run_token=args.run_token or str(uuid.uuid4()), started_at=time.time())
        for key in ['error_type', 'stop_reason', 'finished_at']: state.pop(key, None)
        atomic(path, state)
        conn = cli.open_db(); events = queue.SimpleQueue(); errors = []; ready = []; dispatched = 0
        pause = threading.Event(); previous_signals = {}
        if threading.current_thread() is threading.main_thread():
            for sig in [signal.SIGTERM, signal.SIGINT]:
                previous_signals[sig] = signal.getsignal(sig)
                signal.signal(sig, lambda *_: pause.set())
        provider_pool = None; index_pool = None; active = {}; indexing = None; stop_admission = False
        private = cli.load(args.credential_ref); work = []
        try:
            # SAME initial real sample acceptance remains mandatory.
            sample = cli.status_or_cleanup(SimpleNamespace(**{**vars(args), 'operation': 'proof'}))
            if sample.get('current_rag', {}).get('state') != 'ready_current': raise SonioxPending('Initial real acceptance changed')
            policy, budget = configure_policy(cli, args, state)
            completed = 0; excluded = []
            for row in cli.load_state(args.download_job_id)['selection']:
                _, rp = cli.context_paths(private, row)
                receipt = json.loads(rp.read_text()) if rp.exists() else None
                if receipt and receipt.get('own_media_deleted_after_current_rag'): completed += 1; continue
                if receipt and receipt['state'] == 'quarantined_unpaid_upload':
                    excluded.append({'item_id': row['item_id'], 'reason': 'quarantined_unpaid_upload'}); continue
                if row['state'] != 'ready_audio':
                    excluded.append({'item_id': row['item_id'], 'reason': row['state']}); continue
                work.append(row)
            state.update(completed=completed, pending_provider=len(work), exclusions=excluded,
                         metrics={'max_worker_futures': 0, 'max_provider_outstanding': 0, 'max_provider_processing': 0},
                         provider_jobs={}, errors=[])
            atomic(path, state)
            conn.execute("UPDATE jobs SET status='running',pid=? WHERE id=?", (os.getpid(), state['db_job_id']))
            provider_pool = concurrent.futures.ThreadPoolExecutor(max_workers=policy['workers'])
            index_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            def persist():
                ledger = budget.read(); actual, reserved = budget.totals(ledger)
                state.update(actual_spend_usd=str(actual), reserved_usd=str(reserved), pending_provider=len(work),
                             active_provider_workers=len(active), pending_index=len(ready), index_active=indexing is not None,
                             progress_at=time.time())
                atomic(path, state)
            while work or active or ready or indexing:
                if pause.is_set(): stop_admission = True; state['pause_requested'] = True
                while work and len(active) < policy['workers'] and not stop_admission and (not args.max_items or dispatched < args.max_items):
                    row = work.pop(0); child = SimpleNamespace(**{**vars(args), 'video_id': row['video_id']})
                    active[provider_pool.submit(provider_worker, cli, child, budget, policy, events)] = row
                    dispatched += 1; state['metrics']['max_worker_futures'] = max(state['metrics']['max_worker_futures'], len(active))
                if indexing is None and ready:
                    source = ready[0]['source_id']; group = [r for r in ready if r['source_id'] == source]
                    ready = [r for r in ready if r['source_id'] != source]
                    indexing = index_pool.submit(finish_group, cli, args, group, budget, events)
                    state['current_index_items'] = [r['item_id'] for r in group]
                while not events.empty():
                    event = events.get(); state['provider_jobs'][str(event['item_id'])] = event
                    statuses = [e['phase'] for e in state['provider_jobs'].values()]
                    outstanding = sum(s in {'submitted', 'queued', 'processing'} for s in statuses)
                    processing = statuses.count('processing')
                    state['metrics']['max_provider_outstanding'] = max(state['metrics']['max_provider_outstanding'], outstanding)
                    state['metrics']['max_provider_processing'] = max(state['metrics']['max_provider_processing'], processing)
                    print(json.dumps({'stage': 'parallel_progress', **event, 'provider_outstanding_observed': outstanding,
                                      'provider_processing_observed': processing}), flush=True)
                futures = list(active) + ([indexing] if indexing else [])
                if not futures:
                    if stop_admission or args.max_items and dispatched >= args.max_items: break
                    continue
                done, _ = concurrent.futures.wait(futures, timeout=.25, return_when=concurrent.futures.FIRST_COMPLETED)
                for future in done:
                    if future is indexing:
                        try:
                            finished = future.result(); completed += len(finished); state['completed'] = completed
                            conn.execute('UPDATE jobs SET items_done=? WHERE id=?', (completed, state['db_job_id']))
                        except Exception as error:
                            stop_admission = True; errors.append({'stage': 'index_proof_cleanup', 'error_type': type(error).__name__,
                                'item_ids': state.get('current_index_items'), 'reason': str(error) if isinstance(error, SonioxPending) else None})
                        indexing = None
                    else:
                        row = active.pop(future)
                        try: ready.append(future.result())
                        except Exception as error:
                            stop_admission = True; errors.append({'stage': 'provider', 'item_id': row['item_id'],
                                'error_type': type(error).__name__, 'provider_error_code': getattr(error, 'code', None),
                                'provider_http_status': getattr(error, 'status', None),
                                'reason': str(error) if isinstance(error, SonioxPending) else None})
                state['errors'] = errors; persist()
                if not active and not ready and indexing is None and (stop_admission or args.max_items and dispatched >= args.max_items): break
            state['status'] = 'paused_safe' if errors else 'paused_requested' if pause.is_set() else 'paused_item_limit' if work else 'done_current_available_selection'
            state['remaining_not_admitted'] = len(work)
        except Exception as error:
            state.update(status='paused_safe' if isinstance(error, SonioxPending) else 'error',
                         error_type=type(error).__name__, stop_reason=str(error) if isinstance(error, SonioxPending) else None)
        finally:
            # Accepted provider work is drained, never killed/refunded/replayed.
            if provider_pool: provider_pool.shutdown(wait=True)
            if index_pool: index_pool.shutdown(wait=True)
            state.update(pid=None, finished_at=time.time()); atomic(path, state)
            conn.execute('UPDATE jobs SET status=?,pid=NULL,finished_at=? WHERE id=?', (state['status'], int(time.time()), state['db_job_id']))
            conn.close()
            for sig, handler in previous_signals.items(): signal.signal(sig, handler)
    return cli.batch_status(args)


def request_pause(cli, args):
    """Exact normal signal: stop admission, drain accepted work and publication."""
    path = cli.batch_path(args); state = json.loads(path.read_text()); pid = state.get('pid')
    if state.get('mode') != 'parallel': raise SonioxPending('This pause belongs only to existing parallel controller')
    if not pid: return {'ok': True, 'already_terminal': True, 'status': state['status'], 'db_job_id': state['db_job_id']}
    command = subprocess.run(['ps', '-p', str(int(pid)), '-o', 'command='], capture_output=True, text=True, check=True).stdout
    if ('boosty_soniox_cli.py parallel-bulk' not in command or args.download_job_id not in command
            or args.credential_ref not in command):
        raise SonioxPending('Exact controller process proof differs; no signal')
    atomic(path.with_suffix('.pause.json'), {'run_token': state['run_token'], 'pid': pid, 'requested_at': time.time(), 'drain_accepted': True})
    os.kill(pid, signal.SIGTERM)
    return {'ok': True, 'pause_requested': True, 'pid': pid, 'db_job_id': state['db_job_id'],
            'run_token': state['run_token'], 'accepted_provider_jobs_not_cancelled': True,
            'safe_pause_requires_terminal_readback': True}
