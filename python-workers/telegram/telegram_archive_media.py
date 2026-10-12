#!/usr/bin/env python3
"""Supported SC CLI producer for a saved Telegram voice/document catch-up.

No history traversal, joining, settings change, or fallback key. Voice uses
the already released Soniox project ledger and the existing USB media pool.
Documents stay on Mac; extraction/OCR is local. Application API publishes RAG.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import signal
import subprocess
import sys
import time
import uuid
import contextlib
import fcntl
from pathlib import Path
from types import SimpleNamespace
import urllib.request

HERE = Path(__file__).resolve().parent
WORKERS = HERE.parent
for directory in [WORKERS, WORKERS / 'shared', WORKERS / 'web', HERE]:
    sys.path.insert(0, str(directory))

from shared.library_db import open_db, set_item_transcript
from shared.boosty_soniox_credential import load
from shared.boosty_soniox import Client, SonioxPending, atomic, cost, digest, transcribe, token_outputs, reconcile_delivery, retry_unpaid_upload
from shared.boosty_download_budget import DownloadBudget, BudgetPause
from shared.boosty_storage import inspect_storage
from boosty_download_phase import load_state as load_pool, state_path as pool_state_path, decode_audio
from boosty_full_channel import app_root, exclusive_run
from boosty_assets_phase import extract_pdf, extract_text_file, MEDIA_SUFFIXES, volume_info
from tg_message_payload import attachment_metadata
from tg_attachment_cache import safe_file_name

TERMINAL = {'text_ready', 'text_partial', 'original_only', 'reused', 'unavailable', 'scope_excluded', 'byte_ceiling', 'duration_unknown', 'paid_unknown_quarantined'}


def key_path(job_id):
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', job_id or ''): raise ValueError('Invalid job ID')
    return app_root() / 'jobs/telegram-archive-media' / (job_id + '.json')


def public_call(route, body=None):
    request = urllib.request.Request('http://127.0.0.1:53127/telegram-rag/' + route,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json'} if body is not None else {})
    with urllib.request.urlopen(request, timeout=35) as response: result = json.load(response)
    if result.get('ok') is not True: raise RuntimeError('Application API rejected operation')
    return result


def metadata(value):
    raw = json.loads(value or '{}')
    media = raw.get('media') or []
    return dict(media[0]) if media and isinstance(media[0], dict) else {}


def decision(kind, attachment, *, duration, size_limit):
    name = str(attachment.get('file_name') or '')
    mime = str(attachment.get('content_type') or '').lower()
    if kind not in {'voice', 'document'}: return 'scope_excluded'
    if kind == 'document' and (mime.startswith(('audio/', 'video/')) or Path(name).suffix.lower() in MEDIA_SUFFIXES):
        return 'scope_excluded'
    size = attachment.get('bytes')
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0: return 'size_unknown'
    if size > size_limit: return 'byte_ceiling'
    if kind == 'voice' and (isinstance(duration, bool) or not isinstance(duration, (float, int)) or not math.isfinite(duration) or duration <= 0):
        return 'duration_unknown'
    return 'pending'


def inventory(state, conn):
    """Add newly persisted messages; preserve every existing receipt/state."""
    if 'quarantined_messages' not in state:
        state['quarantined_messages']=[str(r['source_id'])+':'+str(r['message_id']) for r in state['rows'] if r['state']=='paid_unknown_quarantined']
    existing = {r['item_id'] for r in state['rows']}
    for source_id in state['source_ids']:
        source = conn.execute('SELECT * FROM sources WHERE id=? AND platform=\'telegram\'', (source_id,)).fetchone()
        if not source or source['tg_session'] != state['session'] or source['tg_session_conflict']:
            raise ValueError('Exact saved source/session binding required')
        peer = str(state.get('peer_ids', {}).get(str(source_id)) or source['handle'])
        if not re.fullmatch(r'-[1-9][0-9]*', peer): raise ValueError('Exact marked peer required, no title/positive-ID guessing')
        raw_peer = peer[4:] if peer.startswith('-100') else peer[1:]
        if str(source['external_id']) != raw_peer: raise ValueError('Explicit marked peer differs from saved source identity')
        for saved in conn.execute("SELECT * FROM items WHERE source_id=? AND type IN ('voice','document') ORDER BY id", (source_id,)):
            if saved['id'] in existing: continue
            attachment = metadata(saved['raw_meta_json'])
            status = decision(saved['type'], attachment, duration=saved['duration_seconds'], size_limit=state['max_file_bytes'])
            if saved['type'] == 'voice' and str(source_id)+':'+str(saved['external_id']) in state['quarantined_messages']:
                status = 'paid_unknown_quarantined'
            if saved['transcribe_status'] == 'done' and saved['type'] == 'voice': status = 'reused'
            state['rows'].append({'source_id': source_id, 'peer_id': int(peer), 'item_id': saved['id'],
                'message_id': int(saved['external_id']), 'kind': saved['type'], 'attachment': attachment,
                'duration_seconds': saved['duration_seconds'], 'state': status,
                'original_caption_sha256': hashlib.sha256((saved['caption'] or '').encode()).hexdigest()})
            existing.add(saved['id'])
    return state


def summary(state):
    counts = {}; kinds = {}
    for row in state['rows']:
        counts[row['state']] = counts.get(row['state'], 0) + 1
        kinds[row['kind']] = kinds.get(row['kind'], 0) + 1
    return {'ok': True, 'job_id': state['job_id'], 'status': state['status'], 'pid': state.get('pid'),
        'db_job_id': state.get('db_job_id'), 'selected': len(state['rows']), 'kinds': kinds, 'counts': counts,
        'sources': state.get('sources', {}), 'latest': state.get('latest'), 'error_code': state.get('error_code'),
        'shared_soniox_budget': True, 'new_budget_or_key_namespace': False,
        'originals_bytes': sum(r.get('original_bytes', 0) for r in state['rows']),
        'voice_seconds_saved_metadata': sum(r['duration_seconds'] or 0 for r in state['rows'] if r['kind'] == 'voice'),
        'receipt_path': str(key_path(state['job_id']))}


def plan(args):
    path = key_path(args.job_id)
    state = json.loads(path.read_text()) if path.exists() else None
    if state:
        if state.get('pid'): return summary(state)
        if args.source_ids or args.session or args.credential_ref:
            expected = {'source_ids':list(dict.fromkeys(int(s) for s in (args.source_ids or '').split(',') if s)),
                'session':args.session, 'expected_account_id':args.expected_account_id, 'credential_ref':args.credential_ref,
                'media_pool_job_id':args.media_pool_job_id, 'peer_ids':dict(value.split(':',1) for value in args.peer)}
            if args.exclude_unknown:
                expected['quarantined_messages']=sorted(set(args.exclude_unknown))
            if any(state.get(k)!=v for k,v in expected.items()):
                raise ValueError('Existing plan is immutable; changed target/profile is rejected')
            return summary(state)
    else:
        sources = list(dict.fromkeys(int(s) for s in (args.source_ids or '').split(',') if s))
        if not sources or not args.session or not args.expected_account_id or not args.credential_ref or not args.media_pool_job_id:
            raise ValueError('Explicit source/session/account/credential/pool required')
        private = load(args.credential_ref, purpose='telegram_voice')
        if not private.get('provider_project_cap_confirmed') or not private.get('user_ASR_model_cost_release'):
            raise ValueError('Released project/model/budget proof required')
        pool = load_pool(args.media_pool_job_id)
        state = {'version': 1, 'job_id': args.job_id, 'source_ids': sources, 'session': args.session,
            'peer_ids': dict(value.split(':',1) for value in args.peer),
            'quarantined_messages':sorted(set(args.exclude_unknown)),
            'expected_account_id': args.expected_account_id, 'credential_ref': args.credential_ref,
            'media_pool_job_id': args.media_pool_job_id, 'volume_uuid': pool['config']['volume_uuid'],
            'status': 'planned', 'rows': [], 'sources': {}, 'max_file_bytes': 128 * 1024**2,
            'max_document_bytes': 2 * 1024**3, 'created_at': time.time(), 'pid': None}
    conn = open_db()
    try: inventory(state, conn)
    finally: conn.close()
    atomic(path, state)
    return summary(state)


def publish(conn, state, row, text, files, engine, partial=False, provider_receipt=None):
    """Same item only; labelled extraction preserves author caption/provenance."""
    conn.execute('BEGIN IMMEDIATE')
    try:
        saved = conn.execute('SELECT * FROM items WHERE id=? AND source_id=? AND external_id=? AND type=?',
            (row['item_id'], row['source_id'], str(row['message_id']), row['kind'])).fetchone()
        if not saved: raise ValueError('Library message identity changed')
        raw = json.loads(saved['raw_meta_json'] or '{}')
        old = (raw.get('telegram_archive_media') or {})
        if old and old.get('job_id') != state['job_id']: raise ValueError('Another processing receipt owns this original')
        heading = ('[голосовое — расшифровка · soniox]' if row['kind'] == 'voice' else '[документ — извлечение · ' + engine + ']')
        caption = saved['caption'] or ''
        if heading not in caption:
            caption += ('\n\n' if caption else '') + heading + (' [частичное извлечение]' if partial else '') + '\n' + text
        elif old.get('text_sha256') != digest(files['txt']):
            raise ValueError('Existing processing text differs; no overwrite')
        record = {'job_id': state['job_id'], 'kind': row['kind'], 'engine': engine, 'original_path': row['original_path'],
            'original_sha256': row['original_sha256'], 'text_sha256': digest(files['txt']), 'files': files,
            'partial': partial, 'provider_job_id': (provider_receipt or {}).get('transcription_id'),
            'actual_cost_usd':(provider_receipt or {}).get('actual_cost_usd')}
        raw['telegram_archive_media'] = record
        conn.execute('UPDATE items SET caption=?,raw_meta_json=?,media_path=COALESCE(media_path,?),download_status=\'done\' WHERE id=?',
            (caption, json.dumps(raw, ensure_ascii=False), row['original_path'], row['item_id']))
        added_cost=float(record['actual_cost_usd']) if record['actual_cost_usd'] is not None and old.get('actual_cost_usd') is None else None
        set_item_transcript(conn, row['item_id'], transcript_path=files['txt'], transcript_text=text, engine=engine,cost_usd=added_cost)
        if partial: conn.execute("UPDATE items SET transcribe_status='partial' WHERE id=?", (row['item_id'],))
        conn.commit()
    except BaseException:
        conn.rollback(); raise
    row.update(files=files, file_hashes={kind: digest(file) for kind, file in files.items()}, text_sha256=record['text_sha256'],
        published_caption_sha256=hashlib.sha256(caption.encode()).hexdigest(), state='text_partial' if partial else 'text_ready')


def stable_file(path, content):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = content.encode()
    if path.exists():
        if path.read_bytes() != data: raise ValueError('Saved original output differs; preserve it')
    else:
        part = path.with_suffix(path.suffix + '.part')
        with part.open('wb') as output:
            os.fchmod(output.fileno(), 0o600); output.write(data); output.flush(); os.fsync(output.fileno())
        os.replace(part, path)
    return str(path)


def provider_paths(private, row):
    project = app_root() / 'jobs/boosty-soniox' / private['provider_project']
    receipt = app_root() / 'jobs/telegram-soniox' / private['provider_project'] / ('item-' + str(row['item_id']) + '.json')
    return project / 'budget.json', receipt


@contextlib.contextmanager
def project_lock(path, deadline_seconds=120):
    """Same mutex as Boosty; wait for its current paid child, never override."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = path.open('a+')
    deadline = time.monotonic() + deadline_seconds
    try:
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB); break
            except BlockingIOError:
                if time.monotonic() >= deadline: raise SonioxPending('Shared project mutex busy; current paid receipt retained')
                time.sleep(0.2)
        handle.seek(0); handle.truncate(); handle.write(str(os.getpid())+'\n');handle.flush()
        yield
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN);handle.close()


def speech(state, row, conn):
    private = load(state['credential_ref'], purpose='telegram_voice')
    budget_path, receipt_path = provider_paths(private, row)
    identity = {'platform': 'telegram', 'account_id': state['expected_account_id'], 'session': state['session'],
        **{k: row[k] for k in ['source_id', 'peer_id', 'item_id', 'message_id', 'remote_document_id']},
        'audio_sha256': row['original_sha256'], 'duration_seconds': row['audio_proof']['duration_seconds'],
        'credential_ref': state['credential_ref'], 'model': 'stt-async-v5'}
    with project_lock(budget_path.with_suffix('.lock')):
        ledger = json.loads(budget_path.read_text())
        if ledger['credential_ref'] != state['credential_ref']: raise ValueError('Shared project budget connection differs')
        client = Client(private['key'])
        if receipt_path.exists():
            previous = json.loads(receipt_path.read_text())
            if previous.get('state') in {'upload_inflight', 'submit_inflight'}:
                try: reconcile_delivery(client, row['original_path'], identity, receipt_path, ledger, lambda v: atomic(budget_path, v))
                except SonioxPending:
                    if previous.get('state') != 'upload_inflight' or previous.get('file_upload_recovery_attempts'):
                        raise
                    # This helper rechecks complete provider inventories,
                    # concurrency and actual usage. One unpaid FILE transfer;
                    # unknown paid creates are never replaced.
                    retry_unpaid_upload(client, row['original_path'], identity, receipt_path, ledger)
        payload, receipt = transcribe(client, row['original_path'], identity, receipt_path, ledger, lambda v: atomic(budget_path, v))
        if not (payload.get('text') or '').strip() and not payload.get('tokens'):
            text, srt = '[Soniox: речь не обнаружена.]', ''
            raw = {'identity': identity, 'provider': 'soniox', 'model': 'stt-async-v5', 'transcription_id': payload['id'],
                'text': '', 'tokens': [], 'result_status': 'no_speech'}
        else: text, srt, raw = token_outputs(payload, identity)
        directory = app_root() / 'transcripts/telegram' / state['session'] / str(row['source_id']) / str(row['message_id'])
        files = {'txt': stable_file(directory / 'full.txt', text), 'srt': stable_file(directory / 'full.srt', srt),
            'raw': stable_file(directory / 'soniox.json', json.dumps(raw, ensure_ascii=False))}
        receipt.update(state='saved', files=files, saved_hashes={k: digest(v) for k, v in files.items()})
        atomic(receipt_path, receipt)
        bill = client.billed(receipt['client_reference_id'], ledger['window_start'])
        ledger['requests'][receipt['client_reference_id']].update(state='billed', cost_usd=str(cost(bill['cost_usd'])), usage_uuid=bill['uuid'])
        atomic(budget_path, ledger)
        receipt['actual_cost_usd'] = str(cost(bill['cost_usd'])); atomic(receipt_path, receipt)
        publish(conn, state, row, text, files, 'soniox', provider_receipt=receipt)
        row.update(provider_receipt_path=str(receipt_path), actual_cost_usd=receipt['actual_cost_usd'])


def document(state, row, conn):
    original = Path(row['original_path']); directory = original.parent
    result = extract_pdf(original, directory) if original.suffix.lower() == '.pdf' else extract_text_file(original, directory)
    row['extraction'] = result
    if not result.get('text_path'):
        row['state'] = 'original_only';
        conn.execute("UPDATE items SET media_path=COALESCE(media_path,?),download_status='done' WHERE id=? AND source_id=? AND external_id=?",
            (str(original), row['item_id'], row['source_id'], str(row['message_id'])))
        return
    text = Path(result['text_path']).read_text(encoding='utf-8')
    if not text.strip(): row['state'] = 'original_only'; return
    publish(conn, state, row, text, {'txt': result['text_path']},
        'local-pdf' if original.suffix.lower() == '.pdf' else 'local-document',
        partial=result['state'] != 'text_extracted_complete')


def prepare_document_extractions(args):
    """Offline recovery on OWN selected receipts; never opens Library or connects TG."""
    from tg_document_extraction import extract, sha, stable
    state = json.loads(key_path(args.job_id).read_text())
    selected = list(dict.fromkeys(int(value) for value in (args.item_ids or '').split(',') if value))
    if not selected or len(selected) > 100: raise ValueError('1..100 exact document item IDs required')
    root = Path(args.output_dir or '').resolve()
    if not args.output_dir or not root.is_relative_to((app_root() / 'tmp').resolve()):
        raise ValueError('Prepared derivatives must stay in owned Mac app tmp')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest_path = root / 'prepared-documents.json'
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text())
        if previous['job_id'] != args.job_id or previous['item_ids'] != selected:
            raise ValueError('Prepared selection immutable; do not overwrite')
    results = []
    for item_id in selected:
        row = next((r for r in state['rows'] if r['item_id'] == item_id), None)
        if not row or row['kind'] != 'document' or not row.get('original_sha256'):
            raise ValueError('Only exact already-saved document originals are eligible')
        original = Path(row['original_path'])
        namespace = app_root() / 'originals/telegram' / state['session'] / str(row['source_id']) / str(row['message_id']) / state['job_id']
        if original.is_symlink() or original.parent.resolve() != namespace.resolve() or sha(original) != row['original_sha256']:
            raise ValueError('Owned exported original identity/hash mismatch')
        def progress(event):
            print(json.dumps({'type':'local_extraction_progress','job_id':args.job_id,'item_id':item_id,**event}),flush=True)
        result = extract(original, root / str(item_id), row['original_sha256'], app_root() / 'models/tesseract', progress)
        results.append({'item_id':item_id,'source_id':row['source_id'],'message_id':row['message_id'],
            'original_caption_sha256':row['original_caption_sha256'], 'previous_state':row['state'],
            'previous_wait_reason':row.get('wait_reason'), 'extraction':result})
    manifest = {'version':1,'job_id':args.job_id,'db_job_id':state['db_job_id'],'session':state['session'],
        'expected_account_id':state['expected_account_id'],'item_ids':selected,'rows':results,
        'prepared_only':True,'caption_mutations':0,'new_downloads':0,'new_provider_requests':0}
    stable(manifest_path,json.dumps(manifest,ensure_ascii=False,sort_keys=True))
    return {'ok':True,'job_id':args.job_id,'prepared_manifest':str(manifest_path),'prepared_only':True,
        'caption_mutations':0,'new_downloads':0,'new_provider_requests':0,
        'rows':[{'item_id':r['item_id'],'message_id':r['message_id'],**{k:r['extraction'][k] for k in ['state','pages_total','pages_attempted','pages_extracted','chars','original_sha256','text_sha256','text_path']}} for r in results]}


def retry_document_extractions(args):
    """Publish prepared local recovery through SAME producer, only at a safe boundary.

    Never force/steal its lifetime lock. ROOT decides when its current index and
    controller can yield; this operation cannot cancel/resume/index/download/ASR.
    """
    from tg_document_extraction import sha, stable, POLICY
    path = key_path(args.job_id)
    prepared_path = Path(args.prepared_manifest or '').resolve()
    if not prepared_path.is_relative_to((app_root() / 'tmp').resolve()) or prepared_path.is_symlink():
        raise ValueError('An owned prepared extraction manifest is required')
    prepared = json.loads(prepared_path.read_text())
    if prepared.get('job_id') != args.job_id or prepared.get('prepared_only') is not True:
        raise ValueError('Prepared results must bind this original producer')
    if (not prepared.get('rows') or len(prepared['rows'])>100
            or prepared.get('item_ids')!=[r['item_id'] for r in prepared['rows']]
            or len(set(prepared['item_ids']))!=len(prepared['item_ids'])):
        raise ValueError('Prepared selection must contain exact unique document rows')
    if not re.fullmatch(r'index-[1-9][0-9]*', args.after_index_job or ''):
        raise ValueError('Exact ROOT index identity is required before publication')
    with exclusive_run(path.with_suffix('.lock')):
        state = json.loads(path.read_text())
        if state.get('pid'): raise ValueError('Current producer is live; keep prepared results, no state patch')
        if any(prepared.get(k)!=state.get(k) for k in ['db_job_id','session','expected_account_id']):
            raise ValueError('Original producer identity changed')
        exact = public_call('index/status?id='+args.after_index_job)
        job = exact.get('job') or {}
        if job.get('id')!=args.after_index_job or job.get('status') not in {'done','error','cancelled','interrupted'}:
            raise ValueError('Exact ROOT index is active/unknown; no caption mutation')
        conn = open_db()
        try:
            for result in prepared['rows']:
                row = next(r for r in state['rows'] if r['item_id']==result['item_id'])
                extraction = result['extraction']
                if extraction.get('policy')!=POLICY or extraction.get('pages_extracted',0)<1:
                    raise ValueError('Obsolete/unreadable prepared output; no placeholder-only publication')
                if (row['kind']!='document' or row['source_id']!=result['source_id'] or row['message_id']!=result['message_id']
                        or row['original_sha256']!=extraction['original_sha256'] or sha(row['original_path'])!=row['original_sha256']
                        or sha(extraction['text_path'])!=extraction['text_sha256']):
                    raise ValueError('Prepared document/original/text binding changed')
                if int(job.get('source_id') or -1)!=row['source_id'] or not source_ready_for_media(conn,row['source_id'],state):
                    raise ValueError('Source has active/unknown index/fetch; no caption mutation')
                current=conn.execute('SELECT caption,raw_meta_json FROM items WHERE id=? AND source_id=? AND external_id=?',
                    (row['item_id'],row['source_id'],str(row['message_id']))).fetchone()
                if not current or hashlib.sha256((current['caption'] or '').encode()).hexdigest()!=result['original_caption_sha256']:
                    # Recover a committed caption whose SAME receipt checkpoint was
                    # interrupted: verify owned raw binding/file/text, never append.
                    published=(json.loads(current['raw_meta_json'] or '{}').get('telegram_archive_media') or {}) if current else {}
                    heading='[документ — извлечение · '+('local-pdf' if Path(row['original_path']).suffix.lower()=='.pdf' else 'local-document')+']'
                    text=Path(extraction['text_path']).read_text(encoding='utf-8')
                    if (published.get('job_id')==state['job_id'] and published.get('original_sha256')==row['original_sha256']
                            and published.get('text_sha256')==extraction['text_sha256'] and published.get('files',{}).get('txt')
                            and sha(published['files']['txt'])==extraction['text_sha256']
                            and (current['caption'] or '').endswith('\n'+text) and heading in current['caption']):
                        row.update(extraction=extraction,files=published['files'],file_hashes={k:sha(v) for k,v in published['files'].items()},
                            text_sha256=extraction['text_sha256'],published_caption_sha256=hashlib.sha256(current['caption'].encode()).hexdigest(),
                            state='text_partial' if extraction['state']!='text_extracted_complete' else 'text_ready',
                            extraction_recovery={'prepared_manifest':str(prepared_path),'after_index_job':args.after_index_job,'reconciled_commit':True})
                        state['sources'].setdefault(str(row['source_id']),{}).update(extraction_done=False,media_done=False,current_rag_verified=False)
                        atomic(path,state)
                        continue
                    raise ValueError('Canonical caption changed since preparation; no overwrite')
                text=Path(extraction['text_path']).read_text(encoding='utf-8')
                target=Path(row['original_path']).parent/'local-recovery-v1'/'full.txt'
                stable(target,text)
                row.setdefault('extraction_retry_history',[]).append({'previous_state':row['state'],'wait_reason':row.get('wait_reason'),
                    'original_sha256':row['original_sha256'],'prepared_text_sha256':extraction['text_sha256'],'at':time.time()})
                row['extraction']=extraction
                publish(conn,state,row,text,{'txt':str(target)},'local-pdf' if Path(row['original_path']).suffix.lower()=='.pdf' else 'local-document',
                    partial=extraction['state']!='text_extracted_complete')
                row['extraction_recovery']={'prepared_manifest':str(prepared_path),'after_index_job':args.after_index_job,
                    'text_sha256':extraction['text_sha256'],'at':time.time()}
                state['sources'].setdefault(str(row['source_id']),{}).update(extraction_done=False,media_done=False,current_rag_verified=False)
                atomic(path,state)
        finally: conn.close()
    return {'ok':True,'job_id':args.job_id,'published_items':prepared['item_ids'],'new_downloads':0,'new_provider_requests':0,
        'index_started':False,'next':'ROOT may index the changed current captions through ordinary App after this publication.'}


def source_ready_for_media(conn, source_id, state=None):
    active = conn.execute("SELECT 1 FROM jobs WHERE source_id=? AND type IN ('tg_fetch','tg_index') AND status IN ('pending','running','cancelling','awaiting_ai') LIMIT 1", (source_id,)).fetchone()
    if active: return False
    if state is not None:
        full = list(conn.execute("""SELECT status,parameters_json FROM jobs WHERE source_id=? AND type='tg_fetch'
          AND json_valid(parameters_json) AND json_extract(parameters_json,'$.full_history')=1
          AND json_extract(parameters_json,'$.expected_account_id')=?
          AND json_extract(parameters_json,'$._tg_session_override')=?""",
          (source_id,state['expected_account_id'],state['session'])))
        if full and not any(r['status']=='done' and json.loads(r['parameters_json']).get('_fetch_report',{}).get('remote_eof') is True and
            json.loads(r['parameters_json']).get('_fetch_report',{}).get('persistence',{}).get('finalization_succeeded') is True for r in full):
            return False
    return True


async def attachment(client, state, row, conn):
    from tg_live_ndjson import message_type
    from telethon import utils
    raw_id, peer_type = utils.resolve_id(row['peer_id'])
    entity = await client.get_entity(peer_type(raw_id))
    if utils.get_peer_id(entity) != row['peer_id']: raise ValueError('Resolved peer differs')
    msg = await client.get_messages(entity, ids=row['message_id'])
    if not msg: row['state'] = 'unavailable'; return
    actual_kind = message_type(msg); current = attachment_metadata(msg, actual_kind) or {}
    reason = decision(actual_kind, current, duration=current.get('duration_seconds') or row['duration_seconds'], size_limit=state['max_file_bytes'])
    if actual_kind != row['kind'] or reason != 'pending': row.update(state=reason if reason != 'pending' else 'scope_excluded'); return
    for name in ['content_type', 'bytes']:
        if row['attachment'].get(name) is not None and current.get(name) != row['attachment'][name]: raise ValueError('Selected attachment identity changed before download')
    remote_id = str(msg.document.id)
    if row.get('remote_document_id') not in (None, remote_id): raise ValueError('Remote document changed; no automatic replacement')
    row['remote_document_id'] = remote_id
    if row.get('original_path') and Path(row['original_path']).is_file():
        if digest(row['original_path']) != row['original_sha256']: raise ValueError('Cached original changed')
        return
    name = safe_file_name(current.get('file_name'), 'voice.ogg' if row['kind'] == 'voice' else 'document')
    if row['kind'] == 'document' and str(current.get('content_type') or '').split(';',1)[0].lower() == 'application/pdf' and Path(name).suffix.lower() != '.pdf': name += '.pdf'
    if row['kind'] == 'voice':
        pool = load_pool(state['media_pool_job_id'])
        if pool['config']['volume_uuid'] != state['volume_uuid']: raise BudgetPause('Media pool physical identity changed')
        with exclusive_run(pool_state_path(state['media_pool_job_id']).with_suffix('.lock')):
            budget = DownloadBudget(pool['config'], pool['owned_root'], pool['ceiling_bytes'])
            budget.check(extra_bytes=current['bytes'], physical=True)
            directory = Path(pool['owned_root']) / 'telegram-voice' / state['job_id'] / str(row['source_id']) / str(row['message_id'])
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            target = directory / name
            def progress(done, total): budget.check()
            if target.exists() and row.get('download_intent', {}).get('target') != str(target):
                raise ValueError('Unowned existing voice file; no overwrite')
            row['download_intent'] = {'target': str(target), 'remote_document_id': remote_id, 'bytes': current['bytes']}
            atomic(key_path(state['job_id']), state)
            path = await msg.download_media(file=str(target), progress_callback=progress)
            budget.check(physical=True)
            if not path or Path(path).stat().st_dev != budget.device: raise BudgetPause('Voice file is not on the admitted USB')
            row['audio_proof'] = decode_audio(path, row['duration_seconds'])
    else:
        if sum(r.get('original_bytes', 0) for r in state['rows'] if r['kind'] == 'document') + current['bytes'] > state['max_document_bytes']:
            row['state'] = 'byte_ceiling'; return
        if volume_info(app_root()).get('Internal') is not True: raise ValueError('Documents/text must stay on physical Mac storage')
        directory = app_root() / 'originals/telegram' / state['session'] / str(row['source_id']) / str(row['message_id']) / state['job_id']
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not directory.resolve().is_relative_to(app_root().resolve()) or directory.stat().st_dev != app_root().stat().st_dev:
            raise ValueError('Document directory escaped Mac originals')
        target = directory / name
        if target.exists() and row.get('download_intent', {}).get('target') != str(target):
            raise ValueError('Unowned existing document file; no overwrite')
        row['download_intent'] = {'target': str(target), 'remote_document_id': remote_id, 'bytes': current['bytes']}
        atomic(key_path(state['job_id']), state)
        path = await msg.download_media(file=str(target))
    if not path or Path(path).stat().st_size != current['bytes']: raise ValueError('Original size mismatch; retain partial')
    row.update(original_path=str(Path(path).resolve()), original_bytes=Path(path).stat().st_size,
        original_sha256=digest(path), state='downloaded')
    atomic(key_path(state['job_id']), state)


def prove_and_cleanup(state, conn, source_id):
    rows = [r for r in state['rows'] if r['source_id'] == source_id and r['state'] not in {'reused', 'scope_excluded'}]
    source = state['sources'].setdefault(str(source_id), {})
    if any(r['state'] not in TERMINAL for r in rows): return
    source['extraction_done'] = True
    changed = [r for r in rows if r.get('published_caption_sha256')]
    if not changed: source['media_done'] = True; return
    signature=hashlib.sha256(json.dumps([(r['item_id'],r['published_caption_sha256']) for r in changed],sort_keys=True).encode()).hexdigest()
    if not source.get('index_job_id') or source.get('index_input_hash') != signature:
        active=public_call('index/status?source_id='+str(source_id))
        if active['index'].get('state')=='running': return
        out = public_call('index/start', {'source_id': source_id})
        source.update(index_job_id=out['job_id'],index_input_hash=signature); atomic(key_path(state['job_id']), state); return
    out = public_call('index/status?source_id=' + str(source_id))
    index = out['index']
    if index.get('state') == 'running' or any(index.get(k, 0) for k in ['pending_messages','partial_messages','stale_messages','legacy_unverified_messages']): return
    if index.get('ready_current_messages', 0) < len(changed): return
    for row in changed:
        saved = conn.execute('SELECT caption FROM items WHERE id=? AND source_id=? AND external_id=?',
            (row['item_id'], source_id, str(row['message_id']))).fetchone()
        if not saved or hashlib.sha256((saved['caption'] or '').encode()).hexdigest() != row['published_caption_sha256']:
            raise ValueError('Published caption changed; retain own media')
        if any(digest(file) != row['file_hashes'][kind] for kind, file in row['files'].items()):
            raise ValueError('Saved text/raw outputs changed')
        row['current_rag_verified'] = True
        if row['kind'] == 'voice' and not row.get('own_media_deleted_after_current_rag'):
            pool = load_pool(state['media_pool_job_id'])
            proof=inspect_storage(pool['config'],external_mount=pool['config']['external_mount'],
                expected_volume_uuid=state['volume_uuid'],reserve_bytes=0)
            original = Path(row['original_path'])
            if not original.exists() and row.get('eviction_intent')=={'path':str(original),'sha256':row['original_sha256'],'after_current_rag':True}:
                row['media_absent_after_authorized_eviction_intent']=True
                conn.execute("UPDATE items SET media_path=NULL,download_status='evicted' WHERE id=? AND media_path=?",(row['item_id'],str(original)))
                continue
            if not original.resolve().is_relative_to(Path(pool['owned_root']).resolve()) or original.stat().st_dev!=proof['st_dev'] or digest(original) != row['original_sha256']:
                raise ValueError('Only exact owned voice may be evicted')
            row['eviction_intent']={'path':str(original),'sha256':row['original_sha256'],'after_current_rag':True}
            atomic(key_path(state['job_id']),state)
            original.unlink()
            conn.execute("UPDATE items SET media_path=NULL,download_status='evicted' WHERE id=? AND media_path=?", (row['item_id'], str(original)))
            row['own_media_deleted_after_current_rag'] = True
            atomic(key_path(state['job_id']),state)
    source.update(media_done=True, current_rag_verified=True)


async def execute(state, max_items=None, kind=None):
    from telethon import TelegramClient
    from credentials import telegram_credentials
    from tg_session_path import resolve_session_path, connect_authorized
    from tg_concurrent_session import telegram_session
    api_id, api_hash = telegram_credentials()
    session_path = resolve_session_path(state['session'], HERE)
    if not session_path.exists(): raise ValueError('Exact Telegram session missing')
    client = TelegramClient(telegram_session(str(session_path).removesuffix('.session')), api_id, api_hash,
        receive_updates=False, catch_up=False, flood_sleep_threshold=0)
    ok, _, _ = await connect_authorized(client, session_name=session_path.stem)
    if not ok or int((await client.get_me()).id) != state['expected_account_id']:
        await client.disconnect(); raise ValueError('Telegram account authorization/fence failed')
    conn = open_db(); processed = 0
    try:
        while True:
            if key_path(state['job_id']).with_suffix('.cancel').exists(): raise KeyboardInterrupt()
            count_before = len(state['rows']); inventory(state, conn)
            if len(state['rows']) != count_before:
                # A full text fetch may finish after this media plan started.
                # New saved IDs reopen that source, without replacing receipts.
                for source_id in state['source_ids']:
                    if any(r['source_id'] == source_id and r['state'] not in TERMINAL for r in state['rows']):
                        state['sources'].setdefault(str(source_id), {}).update(media_done=False, extraction_done=False)
            state['latest'] = {'stage': 'selecting', 'at': time.time()}; atomic(key_path(state['job_id']), state)
            work = [r for r in state['rows'] if r['state'] not in TERMINAL and (kind is None or r['kind'] == kind)
                and r.get('retry_after', 0) <= time.time() and source_ready_for_media(conn, r['source_id'], state)]
            for row in work:
                if key_path(state['job_id']).with_suffix('.cancel').exists(): raise KeyboardInterrupt()
                state['latest'] = {'item_id': row['item_id'], 'source_id': row['source_id'], 'kind': row['kind'], 'stage': 'processing'}
                atomic(key_path(state['job_id']), state)
                try:
                    await attachment(client, state, row, conn)
                    if row['state'] == 'downloaded':
                        if row['kind'] == 'voice': speech(state, row, conn)
                        else: document(state, row, conn)
                except SonioxPending as error:
                    row['wait_reason'] = str(error)
                    if 'Delivery outcome unknown' in str(error): row['state'] = 'paid_unknown_quarantined'
                except (RuntimeError, BudgetPause) as error:
                    row['wait_reason'] = type(error).__name__
                except Exception as error:
                    row['wait_reason'] = type(error).__name__
                    if type(error).__name__ == 'FloodWaitError': row['retry_after'] = time.time() + max(1, int(getattr(error, 'seconds', 60)))
                    else: row['state'] = 'error'
                atomic(key_path(state['job_id']), state)
                conn.execute('UPDATE jobs SET items_done=?,items_total=? WHERE id=?',
                    (sum(r['state'] in TERMINAL for r in state['rows']), len(state['rows']), state['db_job_id']))
                processed += 1
                if max_items and processed >= max_items: break
            for source_id in state['source_ids']:
                if source_ready_for_media(conn, source_id, state):
                    try: prove_and_cleanup(state, conn, source_id)
                    except Exception as error: state['sources'].setdefault(str(source_id), {})['proof_error'] = type(error).__name__
            atomic(key_path(state['job_id']), state)
            if max_items and processed >= max_items: return
            outstanding = [r for r in state['rows'] if r['state'] not in TERMINAL]
            waiting_history = any(not source_ready_for_media(conn, sid, state) for sid in state['source_ids'])
            waiting_rag = any(not s.get('media_done') for s in state['sources'].values())
            if not outstanding and not waiting_history and not waiting_rag:
                state['status'] = 'done_with_limitations' if any(r['state'] in {'text_partial','original_only','unavailable','byte_ceiling','duration_unknown','paid_unknown_quarantined'} for r in state['rows']) else 'done_current_saved_inventory'
                return
            if time.time() > state.get('deadline_at', time.time() + 1):
                state['status'] = 'paused_checkpoint'; return
            await asyncio.sleep(30)  # pending source/provider/storage/RAG retry, not a completion guess
    finally:
        conn.close(); await client.disconnect()


def run(args):
    path = key_path(args.job_id)
    with exclusive_run(path.with_suffix('.lock')):
        state = json.loads(path.read_text())
        if args.run_token and state.get('run_token') != args.run_token: raise ValueError('Controller identity changed')
        state.update(status='running', pid=os.getpid(), deadline_at=time.time() + 12 * 3600)
        conn = open_db()
        try:
            if not state.get('db_job_id'):
                state['db_job_id'] = conn.execute("INSERT INTO jobs(type,status,items_total,items_done,parameters_json,started_at,pid) VALUES('tg_archive_media','running',?,0,?,?,?)",
                    (len(state['rows']), json.dumps({'job_id': state['job_id'], 'origin': 'mcp', 'autoCopy': False,
                        'voice_types': ['voice'], 'documents': True, 'shared_soniox_budget': True}), int(time.time()), os.getpid())).lastrowid
            else: conn.execute("UPDATE jobs SET status='running',pid=?,finished_at=NULL WHERE id=?", (os.getpid(), state['db_job_id']))
            atomic(path, state)
            asyncio.run(execute(state, args.max_items, args.kind))
            if state['status'] == 'running': state['status'] = 'paused_checkpoint'
        except KeyboardInterrupt: state['status'] = 'interrupted'
        except Exception as error: state.update(status='error', error_code=type(error).__name__)
        finally:
            state.update(pid=None, finished_at=time.time()); atomic(path, state)
            conn.execute('UPDATE jobs SET status=?,pid=NULL,items_done=?,items_total=?,finished_at=? WHERE id=?',
                (state['status'], sum(r['state'] in TERMINAL for r in state['rows']), len(state['rows']), int(time.time()), state['db_job_id']))
            conn.close()
    return summary(state)


def background(args):
    path = key_path(args.job_id)
    with exclusive_run(path.with_suffix('.dispatch.lock')):
        state = json.loads(path.read_text())
        if state.get('pid'):
            probe=subprocess.run(['/bin/ps','-p',str(state['pid']),'-o','command='],capture_output=True,text=True,timeout=5)
            if probe.returncode==0:
                command=probe.stdout
                if str(Path(__file__).resolve()) not in command or ('--job-id '+args.job_id) not in command:
                    raise ValueError('Controller PID identity changed; no blind dispatch')
                return summary(state)
            if probe.returncode!=1: raise ValueError('Controller state is unknown')
        with exclusive_run(path.with_suffix('.lock')):
            token = str(uuid.uuid4()); state.update(run_token=token, status='starting', pid=None); atomic(path, state)
            path.with_suffix('.cancel').unlink(missing_ok=True)
            log = path.with_suffix('.log')
            with log.open('ab') as output:
                process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'run', '--job-id', args.job_id,
                    '--run-token', token], stdout=output, stderr=output, start_new_session=True)
            state['pid'] = process.pid; atomic(path, state)
        return summary(state)


def original_proof(args):
    state=json.loads(key_path(args.job_id).read_text())
    row=next(r for r in state['rows'] if r['item_id']==args.item_id)
    if not row.get('files'):raise ValueError('No saved derived original yet')
    hashes={kind:digest(file) for kind,file in row['files'].items()}
    if hashes!=row['file_hashes']:raise ValueError('Saved derived originals changed')
    result={'ok':True,'job_id':args.job_id,'item_id':row['item_id'],'source_id':row['source_id'],
        'message_id':row['message_id'],'kind':row['kind'],'state':row['state'],'original_sha256':row['original_sha256'],
        'saved_hashes':hashes,'actual_cost_usd':row.get('actual_cost_usd'),'files':row['files'],'new_paid_requests':0,'new_uploads':0}
    if row['kind']=='voice':
        raw=json.loads(Path(row['files']['raw']).read_text());receipt=json.loads(Path(row['provider_receipt_path']).read_text())
        if raw['identity']!=receipt['identity'] or raw['transcription_id']!=receipt['transcription_id'] or receipt['saved_hashes']!=hashes:
            raise ValueError('Provider/raw/paired-original identity differs')
        result.update(model=raw['model'],provider_job_id=raw['transcription_id'],
            enable_speaker_diarization=receipt['provider_metadata']['enable_speaker_diarization'],
            enable_language_identification=receipt['provider_metadata']['enable_language_identification'],
            speaker_labels=sorted({str(t['speaker']) for t in raw['tokens'] if t.get('speaker') is not None}),
            languages=sorted({t['language'] for t in raw['tokens'] if t.get('language')}),
            token_count=len(raw['tokens']),cue_count=len(raw.get('cues',[])),speaker_labels_are_not_verified_people_or_roles=True)
    index=public_call('index/status?source_id='+str(row['source_id']))['index']
    result['source_current_rag']=index.get('state')!='running' and not any(index.get(k,0) for k in ['pending_messages','stale_messages','partial_messages','legacy_unverified_messages'])
    conn=open_db()
    try:
        saved=conn.execute('SELECT caption FROM items WHERE id=? AND source_id=? AND external_id=?',
            (row['item_id'],row['source_id'],str(row['message_id']))).fetchone()
        result['same_published_caption']=bool(saved and hashlib.sha256((saved['caption'] or '').encode()).hexdigest()==row['published_caption_sha256'])
    finally:conn.close()
    return result


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser(prog='sc telegram-archive-media', description=__doc__)
    p.add_argument('operation', choices=['plan','run','background','status','cancel','items','proof','prepare-extraction','retry-extraction'])
    p.add_argument('--job-id', required=True); p.add_argument('--source-ids'); p.add_argument('--session')
    p.add_argument('--expected-account-id', type=int); p.add_argument('--credential-ref'); p.add_argument('--media-pool-job-id')
    p.add_argument('--max-items', type=int); p.add_argument('--run-token'); p.add_argument('--kind', choices=['voice','document'])
    p.add_argument('--peer', action='append', default=[], help='Exact source_id:marked_peer for legacy positive source handles')
    p.add_argument('--after-item-id', type=int, default=0); p.add_argument('--limit', type=int, default=100)
    p.add_argument('--only-state')
    p.add_argument('--item-id',type=int)
    p.add_argument('--item-ids'); p.add_argument('--output-dir'); p.add_argument('--prepared-manifest'); p.add_argument('--after-index-job')
    p.add_argument('--exclude-unknown',action='append',default=[],help='Exact source_id:message_id of an already known uncertain paid attempt')
    args = p.parse_args()
    if any(not re.fullmatch(r'[1-9][0-9]*:[1-9][0-9]*',value) for value in args.exclude_unknown):p.error('Exact quarantine source:message required')
    try:
        if args.operation == 'plan': result = plan(args)
        elif args.operation == 'run': result = run(args)
        elif args.operation == 'background': result = background(args)
        elif args.operation == 'proof': result = original_proof(args)
        elif args.operation == 'prepare-extraction': result = prepare_document_extractions(args)
        elif args.operation == 'retry-extraction': result = retry_document_extractions(args)
        elif args.operation == 'cancel':
            stable_file(key_path(args.job_id).with_suffix('.cancel'), 'cancel\n'); result = {'ok': True, 'cancel_requested': True, 'new_provider_requests': 0}
        elif args.operation == 'items':
            state=json.loads(key_path(args.job_id).read_text())
            if args.limit < 1 or args.limit > 1000 or args.after_item_id < 0: raise ValueError('Bounded item page required')
            rows=sorted([r for r in state['rows'] if r['item_id'] > args.after_item_id and
                (args.kind is None or r['kind']==args.kind) and (args.only_state is None or r['state']==args.only_state)],key=lambda r:r['item_id'])
            result={'ok':True,'job_id':args.job_id,'rows':rows[:args.limit],
                'complete':len(rows)<=args.limit,'next_item_id':rows[min(args.limit,len(rows))-1]['item_id'] if rows else None}
        else: result = summary(json.loads(key_path(args.job_id).read_text()))
        print(json.dumps(result, ensure_ascii=False)); return 0
    except Exception as error:
        print(json.dumps({'ok': False, 'code': 'TELEGRAM_ARCHIVE_MEDIA_REJECTED', 'error_type': type(error).__name__,
            'new_provider_retry_not_authorized': True})); return 1


if __name__ == '__main__': raise SystemExit(main())
