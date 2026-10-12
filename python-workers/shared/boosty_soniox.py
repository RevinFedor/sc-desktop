"""Boosty-only async-v5 adapter. Write-ahead outcomes, original tokens, actual billing.

Provider cap enforcement is delayed: this module ALSO serializes one project
request, reserves conservatively, and refuses another charge until actual usage
is reconciled. An hourly estimate is not a hard quote or a zero unknown bill.
"""
import datetime
import hashlib
import json
import math
import os
import time
import uuid
from decimal import Decimal
from pathlib import Path


class SonioxPending(RuntimeError):
    pass


class SonioxError(RuntimeError):
    def __init__(self, code, status=None):
        super().__init__(code); self.code = code; self.status = status


def atomic(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    part = path.with_suffix(path.suffix + '.part')
    with part.open('w', encoding='utf-8') as stream:
        os.chmod(part, 0o600); json.dump(value, stream, ensure_ascii=False); stream.flush(); os.fsync(stream.fileno())
    os.replace(part, path)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()


class Client:
    def __init__(self, key, session=None):
        import requests
        self.session = session or requests.Session()
        self.headers = {'Authorization': 'Bearer ' + key}

    def call(self, route, *, method='GET', params=None, body=None, audio=None):
        # No redirects, secret URLs, retries of POST, or shared credential fallback.
        url = 'https://api.soniox.com/v1/' + route
        if audio:
            with Path(audio).open('rb') as stream:
                response = self.session.request(method, url, headers=self.headers, data=body,
                    files={'file': (Path(audio).name, stream, 'audio/mp4')}, timeout=(30, 900), allow_redirects=False)
        else:
            response = self.session.request(method, url, headers=self.headers, params=params,
                json=body, timeout=(30, 60), allow_redirects=False)
        if not 200 <= response.status_code < 300:
            # Never surface arbitrary error_message/body/requests exception repr.
            try: code = response.json().get('error_type')
            except Exception: code = None
            if not isinstance(code, str) or not code.replace('_', '').isalnum(): code = 'provider_http_error'
            raise SonioxError(code, response.status_code)
        return response.json() if response.content else {}

    def usage(self, start):
        end = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
        return self.call('usage/summary', params={'start_time': start, 'end_time': end})

    def billed(self, reference, start):
        # A client_reference_id is tracking, NOT provider idempotency. Detect
        # duplicates explicitly instead of assuming only one log can exist.
        end = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
        params = {'start_time': start, 'end_time': end, 'limit': 1000, 'sort': 'end_time_asc'}
        found = []; cursors = set()
        for _ in range(32):
            page = self.call('usage-logs', params=params)
            found.extend(r for r in page.get('usage_logs', []) if r.get('client_reference_id') == reference)
            cursor = page.get('next_page_cursor')
            if cursor is None: break
            if cursor in cursors: raise SonioxPending('Usage cursor cycle; keep charge reservation')
            cursors.add(cursor); params['cursor'] = cursor
        else: raise SonioxPending('Usage page ceiling; keep charge reservation')
        if not found: raise SonioxPending('Actual billing not yet visible; no next paid request')
        if len(found) != 1: raise SonioxPending('Multiple billing entries for one own identity; no replay')
        return found[0]


def cost(value):
    if value is None: raise SonioxPending('Missing cost is unknown, not zero')
    result = Decimal(str(value))
    if not result.is_finite() or result < 0: raise SonioxPending('Invalid cost')
    return result


def isolated_unpaid(entry):
    return (entry.get('state') == 'quarantined_unpaid_upload'
            and entry.get('paid_create_barrier_never_crossed') is True
            and entry.get('risk_reservation_retained') is True)


def outstanding_reservations(ledger):
    return sum((cost(r['reservation_usd']) for r in ledger['requests'].values() if r.get('state') != 'billed'), Decimal('0'))


def admit_budget(ledger, duration, observed_total):
    if not duration or not math.isfinite(duration) or duration <= 0: raise SonioxPending('Unknown duration cannot be quoted as zero')
    if duration > 5 * 3600: raise SonioxPending('Long recording requires a separately verified provider-duration contract')
    if any(r.get('state') != 'billed' and not isolated_unpaid(r) for r in ledger.get('requests', {}).values()):
        raise SonioxPending('Another reserved/unknown/unbilled charge exists; resume that receipt')
    actual = cost(observed_total) - cost(ledger['baseline_cost_usd'])
    if actual < 0: raise SonioxPending('Provider usage window/reset changed')
    own = sum((cost(r['cost_usd']) for r in ledger.get('requests', {}).values() if r.get('state') == 'billed'), Decimal('0'))
    if actual != own: raise SonioxPending('Foreign or unreconciled project usage; shared accounting required')
    # This is explicitly a conservative CLIENT admission estimate, not a
    # guaranteed upper bill. Leave2USD unused for delayed provider enforcement.
    reservation = Decimal(str(duration)) / Decimal('3600') * Decimal('0.30') + Decimal('0.10')
    if actual + outstanding_reservations(ledger) + reservation + Decimal('2') > cost(ledger.get('max_new_spend_usd', '20')):
        raise SonioxPending('Budget pause: actual+aggregate reservations+2USD reserve exceeds released cap')
    return reservation


def reconcile_delivery(client, audio, identity, receipt_path, ledger, save_ledger):
    """GET-only adoption of one exact reference after a lost upload/create ACK.

    Tracking is not idempotency: all pages, uniqueness and input/profile checks
    are required. Absence never permits another POST.
    """
    receipt = json.loads(Path(receipt_path).read_text())
    if receipt['identity'] != identity or receipt['state'] not in {'upload_inflight', 'submit_inflight'}:
        raise SonioxPending('Only the exact unresolved delivery can be reconciled')
    reference = receipt['client_reference_id']
    upload_reference = receipt.get('upload_reference_id') or reference
    entry = ledger['requests'].get(reference)
    if not entry or entry['identity'] != identity: raise SonioxPending('Reservation identity differs')
    if digest(audio) != identity['audio_sha256']: raise SonioxPending('Original audio changed')

    def pages(route, field):
        params = {'limit': 1000}; result = []; cursors = set()
        for _ in range(32):
            page = client.call(route, params=params)
            if not isinstance(page.get(field), list): raise SonioxPending('Provider inventory unavailable')
            result.extend(page[field]); cursor = page.get('next_page_cursor')
            if cursor is None: return result
            if cursor in cursors: raise SonioxPending('Provider inventory cursor cycle')
            cursors.add(cursor); params['cursor'] = cursor
        raise SonioxPending('Provider inventory incomplete')

    files = pages('files', 'files')
    candidates = [f for f in files if f.get('client_reference_id') == upload_reference
                  or (f.get('filename') == Path(audio).name and f.get('size') == Path(audio).stat().st_size)]
    exact = []
    for candidate in candidates:
        file = client.call('files/' + str(uuid.UUID(candidate['id'])))
        if file.get('client_reference_id') == upload_reference: exact.append(file)
    if len(exact) != 1:
        error = SonioxPending('Upload identity missing/ambiguous; never repeat POST')
        error.recovery_details = {'matching_files': len(exact), 'provider_files_seen': len(files), 'filename_size_candidates': len(candidates)}
        raise error
    file = exact[0]
    if file.get('filename') != Path(audio).name or file.get('size') != Path(audio).stat().st_size:
        raise SonioxPending('Provider file differs from exact owned input')
    file_id = str(uuid.UUID(file['id']))
    if receipt.get('file_id') and receipt['file_id'] != file_id: raise SonioxPending('Known provider file differs')
    matches = [t for t in pages('transcriptions', 'transcriptions') if t.get('client_reference_id') == reference]
    if len(matches) > 1: raise SonioxPending('Duplicate provider jobs; preserve reservation')
    if matches:
        job = client.call('transcriptions/' + str(uuid.UUID(matches[0]['id'])))
        if (job.get('file_id') != file_id or job.get('client_reference_id') != reference or job.get('model') != 'stt-async-v5'
            or job.get('enable_speaker_diarization') is not True or job.get('enable_language_identification') is not True):
            raise SonioxPending('Provider job identity/profile differs')
        receipt.update(state='submitted', file_id=file_id, transcription_id=str(uuid.UUID(job['id'])))
        entry.update(state='submitted', transcription_id=receipt['transcription_id']); save_ledger(ledger)
    elif receipt['state'] == 'upload_inflight':
        # No create was attempted: its write-ahead barrier was never crossed.
        receipt.update(state='uploaded', file_id=file_id)
    else: raise SonioxPending('Create outcome still unknown; never repeat POST')
    receipt['delivery_reconciled_get_only'] = True; atomic(receipt_path, receipt)
    return {'ok': True, 'state': receipt['state'], 'file_id': file_id,
            'provider_job_id': receipt.get('transcription_id'), 'new_uploads': 0, 'new_paid_requests': 0}


def retry_unpaid_upload(client, audio, identity, receipt_path, ledger):
    """One explicit replacement FILE transfer, never a transcription replay.

    Only upload_inflight with the paid-create barrier never crossed is eligible.
    Preserve its history/reservation and use a new FILE tracking reference. A
    late old file cannot spawn a transcription; paid create remains once-only.
    """
    receipt = json.loads(Path(receipt_path).read_text()); reference = receipt['client_reference_id']
    if (receipt['identity'] != identity or receipt['state'] != 'upload_inflight' or receipt.get('transcription_id')
        or receipt.get('file_id') or receipt.get('unpaid_upload_recovery_attempt')):
        raise SonioxPending('Only one unresolved FILE transfer before any paid-create attempt is eligible')
    if digest(audio) != identity['audio_sha256']: raise SonioxPending('Owned original audio changed')
    entry = ledger['requests'].get(reference)
    if not entry or entry['state'] != 'reserved' or entry['identity'] != identity:
        raise SonioxPending('Exact original reservation required')
    if any(k != reference and r['state'] != 'billed' and not isolated_unpaid(r) for k, r in ledger['requests'].items()):
        raise SonioxPending('Another unknown paid request exists')
    def inventory(route, field):
        result, cursors, params = [], set(), {'limit': 1000}
        for _ in range(32):
            page = client.call(route, params=params)
            if not isinstance(page.get(field), list): raise SonioxPending('Inventory unavailable')
            result.extend(page[field]); cursor = page.get('next_page_cursor')
            if cursor is None: return result
            if cursor in cursors: raise SonioxPending('Inventory cursor cycle')
            cursors.add(cursor); params['cursor'] = cursor
        raise SonioxPending('Inventory incomplete')
    files = inventory('files', 'files')
    if any(f.get('client_reference_id') == reference or f.get('filename') == Path(audio).name for f in files):
        raise SonioxPending('Existing/candidate file must be reconciled, not replaced')
    if any(t.get('client_reference_id') == reference for t in inventory('transcriptions', 'transcriptions')):
        raise SonioxPending('Existing transcription must be reconciled, never replaced')
    if client.call('concurrency-limits').get('project', {}).get('current', {}).get('transcribe_concurrent') != 0:
        raise SonioxPending('Other transcription active/unknown')
    total = cost(client.usage(ledger['window_start'])['total']['total_cost_usd']) - cost(ledger['baseline_cost_usd'])
    own = sum((cost(r['cost_usd']) for r in ledger['requests'].values() if r['state'] == 'billed'), Decimal('0'))
    if total != own or total + outstanding_reservations(ledger) + Decimal('2') > cost(ledger.get('max_new_spend_usd', '20')):
        raise SonioxPending('Current project billing/budget not reconciled')
    receipt.update(unpaid_upload_recovery_attempt=1, original_upload_outcome='unknown_no_paid_create_attempted',
        upload_reference_id=reference + '-file-recovery-1', recovery_paid_create_attempted=False)
    atomic(receipt_path, receipt)  # No second replacement transfer after lost ACK.
    data = client.call('files', method='POST', audio=audio, body={'client_reference_id': receipt['upload_reference_id']})
    file_id = str(uuid.UUID(data['id'])); meta = client.call('files/' + file_id)
    if (meta.get('client_reference_id') != receipt['upload_reference_id'] or meta.get('filename') != Path(audio).name
        or meta.get('size') != Path(audio).stat().st_size):
        raise SonioxPending('Returned file identity differs; retain unknown, do not create transcription')
    receipt.update(state='uploaded', file_id=file_id); atomic(receipt_path, receipt)
    return {'ok': True, 'state': 'uploaded', 'file_id': file_id, 'new_uploads': 1, 'new_paid_requests': 0,
            'original_unknown_upload_retained': True, 'same_paid_reference_and_reservation': True}


def transcribe(client, audio, identity, receipt_path, ledger, save_ledger, *, poll=lambda: time.sleep(3), progress=lambda r: None):
    receipt_path = Path(receipt_path)
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {'identity': identity, 'state': 'not_submitted'}
    if receipt['identity'] != identity: raise SonioxPending('Paid receipt identity changed; no resubmit')
    if Path(audio).exists():
        if digest(audio) != identity['audio_sha256']: raise SonioxPending('Input audio changed')
    elif not receipt.get('transcription_id'):
        raise SonioxPending('No verified audio for a new paid request')
    reference = receipt.get('client_reference_id') or 'boosty-' + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    entry = ledger['requests'].get(reference)
    if receipt['state'] in {'upload_inflight', 'submit_inflight'}: raise SonioxPending('Delivery outcome unknown; reconcile exact request, never retry POST')
    if receipt['state'] == 'not_submitted':
        concurrency = client.call('concurrency-limits')
        if concurrency.get('project', {}).get('current', {}).get('transcribe_concurrent') != 0:
            raise SonioxPending('Other provider processing is active/unconfirmed')
        total = client.usage(ledger['window_start'])['total']['total_cost_usd']
        reservation = admit_budget(ledger, identity['duration_seconds'], total)
        ledger['requests'][reference] = {'state': 'reserved', 'reservation_usd': str(reservation), 'identity': identity}
        save_ledger(ledger)  # Reserve BEFORE upload/create. Keep on unknown delivery.
        receipt.update(state='upload_inflight', client_reference_id=reference); atomic(receipt_path, receipt)
        data = client.call('files', method='POST', audio=audio, body={'client_reference_id': reference})
        file_id = str(uuid.UUID(data['id']))
        receipt.update(state='uploaded', file_id=file_id); atomic(receipt_path, receipt)
    if receipt['state'] == 'uploaded':
        entry = ledger['requests'].get(reference)
        total = cost(client.usage(ledger['window_start'])['total']['total_cost_usd']) - cost(ledger['baseline_cost_usd'])
        own = sum((cost(r['cost_usd']) for r in ledger['requests'].values() if r['state'] == 'billed'), Decimal('0'))
        if (not entry or entry['state'] != 'reserved' or total != own
            or any(k != reference and r['state'] != 'billed' and not isolated_unpaid(r) for k, r in ledger['requests'].items())
            or total + outstanding_reservations(ledger) + Decimal('2') > cost(ledger.get('max_new_spend_usd', '20'))):
            raise SonioxPending('Existing upload budget must be reconciled before its first paid create')
        receipt['state'] = 'submit_inflight'; atomic(receipt_path, receipt)
        data = client.call('transcriptions', method='POST', body={
            'file_id': receipt['file_id'], 'model': 'stt-async-v5', 'language_hints': ['ru', 'en'],
            'enable_language_identification': True, 'enable_speaker_diarization': True, 'client_reference_id': reference})
        transcription_id = str(uuid.UUID(data['id']))
        receipt.update(state='submitted', transcription_id=transcription_id); atomic(receipt_path, receipt)
        ledger['requests'][reference].update(state='submitted', transcription_id=transcription_id); save_ledger(ledger)
    if not receipt.get('transcription_id'): raise SonioxPending('No known paid ID; no replacement')
    started = time.monotonic()
    while receipt['state'] not in {'completed', 'saved'}:
        data = client.call('transcriptions/' + receipt['transcription_id'])
        if data.get('id') != receipt['transcription_id'] or data.get('model') != 'stt-async-v5':
            raise SonioxPending('Provider returned another identity/model')
        receipt['provider_status'] = data.get('status'); atomic(receipt_path, receipt); progress(receipt)
        if data.get('status') in {'failed', 'error'}: raise SonioxPending('Provider terminal error; retain known paid receipt and media')
        if data.get('status') == 'completed':
            if data.get('enable_speaker_diarization') is not True or data.get('enable_language_identification') is not True:
                raise SonioxPending('Requested speaker/language profile not confirmed by provider')
            receipt.update(state='completed', provider_metadata={k: data.get(k) for k in ['id', 'model', 'status', 'audio_duration_ms', 'enable_speaker_diarization', 'enable_language_identification']})
            atomic(receipt_path, receipt); break
        if time.monotonic() - started > 3600: raise SonioxPending('Known provider job still pending; resume GET only')
        poll()
    if receipt['state'] == 'saved' and receipt.get('files', {}).get('raw'):
        raw_file = Path(receipt['files']['raw'])
        if digest(raw_file) != receipt['saved_hashes']['raw']: raise SonioxPending('Saved raw original changed')
        raw = json.loads(raw_file.read_text())
        payload = {'id': raw['transcription_id'], 'text': raw['text'], 'tokens': raw['tokens']}
    else: payload = client.call('transcriptions/' + receipt['transcription_id'] + '/transcript')
    if payload.get('id') != receipt['transcription_id']: raise SonioxPending('Transcript identity mismatch')
    return payload, receipt


def token_outputs(payload, identity):
    text = payload.get('text')
    if not isinstance(text, str) or not text.strip(): raise SonioxPending('Empty completed text')
    tokens = payload.get('tokens')
    if not isinstance(tokens, list) or not tokens: raise SonioxPending('Missing raw tokens')
    usable = [t for t in tokens if isinstance(t, dict) and isinstance(t.get('text'), str) and
              t['text'] not in {'<end>', '<fin>'} and t.get('start_ms') is not None and t.get('end_ms') is not None]
    token_index = {id(t): i for i, t in enumerate(tokens)}
    cues = []; group = []
    def flush():
        if not group: return
        value = ''.join(t['text'] for t in group).strip()
        if value: cues.append({'cue_index': len(cues), 'start_ms': group[0]['start_ms'], 'end_ms': group[-1]['end_ms'],
            'text': value, 'speaker': group[0].get('speaker'), 'languages': sorted({t['language'] for t in group if t.get('language')}),
            'tokens': [token_index[id(t)] for t in group]})
        group.clear()
    for token in usable:
        start, end = token['start_ms'], token['end_ms']
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or not math.isfinite(start + end) or start < 0 or end < start or end > identity['duration_seconds'] * 1000 + 5000:
            raise SonioxPending('Invalid/out-of-child token times')
        # Soniox tokens are subwords, not words. A time/line-length boundary
        # must wait for the next word's leading whitespace; splitting a BPE
        # token sequence creates "ауди\nоработу" and breaks both reading/RAG.
        word_boundary = bool(token['text'][:1].isspace())
        if group and (group[-1].get('speaker') != token.get('speaker') or word_boundary and
                      (start - group[0]['start_ms'] > 6000 or len(''.join(t['text'] for t in group)) > 180)):
            flush()
        group.append(token)
    flush()
    if not cues or not any(t.get('speaker') is not None for t in usable) or not any(t.get('language') for t in usable):
        raise SonioxPending('Requested speaker/language evidence missing; retain media')
    def stamp(ms):
        n = max(0, int(ms)); return f'{n//3600000:02}:{n//60000%60:02}:{n//1000%60:02},{n%1000:03}'
    srt = '\n\n'.join(f'{i + 1}\n{stamp(c["start_ms"])} --> {stamp(max(c["start_ms"] + 1, c["end_ms"]))}\n{c["text"]}' for i, c in enumerate(cues)) + '\n'
    raw = {'identity': identity, 'provider': 'soniox', 'model': 'stt-async-v5', 'transcription_id': payload['id'],
           'tokens': tokens, 'cues': cues, 'text': text, 'speaker_labels_are_not_names_or_roles': True,
           'language_hints': ['ru', 'en'], 'enable_speaker_diarization': True, 'enable_language_identification': True,
           'original_languages_retained': True}
    raw['subtitle_format_version'] = 'soniox-word-boundaries-v2'
    return text, srt, raw
