#!/usr/bin/env python3
"""Supported repo-backed SC download-only phase. NO provider upload or ASR."""
import argparse
import contextlib
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
from boosty_api import api_get, decode_auth_cookie, canonicalize_post_url
from boosty_cli import request_browser_auth
from boosty_full_channel import app_root, atomic_json, exclusive_run
from shared.boosty_storage import inspect_storage
from shared.library_db import open_db
from shared.boosty_download_budget import DownloadBudget, BudgetPause
_STAGE = 'starting'
_PROCESS = None


class AudioFailure(RuntimeError):
    def __init__(self, code, **details):
        super().__init__(code)
        self.code = code
        self.details = details


def sha_file(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()


def state_path(job_id):
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', job_id or ''): raise ValueError('Invalid job_id')
    return app_root() / 'jobs/boosty-download' / (job_id + '.json')


def load_state(job_id):
    return json.loads(state_path(job_id).read_text(encoding='utf-8'))


def save_state(state):
    with exclusive_run(state_path(state['job_id']).with_suffix('.state.lock')):
        atomic_json(state_path(state['job_id']), state)


def audio_format(entry):
    formats = [f for f in entry.get('formats') or [] if f.get('vcodec') == 'none'
               and f.get('acodec') not in (None, 'none') and f.get('format_id') and f.get('url')]
    return max(formats, key=lambda f: float(f.get('tbr') or 0)) if formats else None


def extractor_metadata(url, cookie):
    from boosty_single_ndjson import load_metadata
    try:
        return load_metadata(url, cookie, allow_empty_formats=True)
    except RuntimeError as error:
        # Export enums only: even a URL-redacted stderr can contain credentials
        # or the text of an unrelated embedded resource in this post.
        message = str(error).lower()
        categories = [name for name, needle in [
            ('no_formats', 'no video formats'), ('requested_format_missing', 'requested format is not available'),
            ('subscription_required', 'requires a subscription'), ('no_videos', 'no videos found'),
            ('youtube_error', '[youtube]'), ('manifest_error', 'manifest'),
            ('http_403', 'http error 403'), ('http_404', 'http error 404'),
            ('http_429', 'http error 429'), ('network_timeout', 'timed out'),
            ('unsupported_url', 'unsupported url')
        ] if needle in message]
        raise AudioFailure('extractor_failed', categories=categories or ['unclassified']) from None


def decode_audio(file, expected_duration):
    try:
        result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration',
            '-of', 'json', str(file)], capture_output=True, stdin=subprocess.DEVNULL, timeout=30)
    except subprocess.TimeoutExpired:
        raise AudioFailure('audio_probe_timeout', bytes=Path(file).stat().st_size)
    if result.returncode: raise AudioFailure('audio_probe_failed', exit_code=result.returncode)
    data = json.loads(result.stdout)
    streams = data.get('streams') or []
    duration = float((data.get('format') or {}).get('duration') or 0)
    if not streams or any(s.get('codec_type') != 'audio' for s in streams) or duration <= 0:
        raise AudioFailure('non_audio_or_empty', duration_seconds=duration, streams=streams)
    if expected_duration and abs(duration - float(expected_duration)) > max(5, expected_duration * 0.02):
        raise AudioFailure('duration_mismatch', actual_duration_seconds=duration, expected_duration_seconds=expected_duration)
    # Decode the entire file, not only metadata/header or first few seconds.
    try:
        result = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-i', str(file), '-map', '0:a:0', '-f', 'null', '-'],
                                capture_output=True, stdin=subprocess.DEVNULL, timeout=max(120, duration / 2))
    except subprocess.TimeoutExpired:
        raise AudioFailure('full_audio_decode_timeout', duration_seconds=duration)
    if result.returncode: raise AudioFailure('full_audio_decode_failed', exit_code=result.returncode,
                                           duration_seconds=duration)
    return {'duration_seconds': duration, 'streams': streams, 'sha256': sha_file(file), 'bytes': Path(file).stat().st_size,
            'full_decode_verified': True}


def kill_own():
    if _PROCESS and _PROCESS.poll() is None:
        try: os.killpg(_PROCESS.pid, signal.SIGTERM)
        except ProcessLookupError: pass


def interrupted(_signum, _frame):
    kill_own(); raise KeyboardInterrupt()


def command_progress(command, env, budget, callback=None):
    global _PROCESS
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                               env=env, start_new_session=True)
    _PROCESS = process
    markers = []
    try:
        for line in process.stdout:
            if line.startswith('__SC_FILE__'): markers.append(line.strip().removeprefix('__SC_FILE__'))
            if line.startswith('__SC_PROGRESS__') or line.startswith('progress='):
                usage = budget.check()
                if callback: callback(usage)
        code = process.wait()
        if code: raise RuntimeError('Audio download/conversion failed; files retained')
        budget.check(physical=True)
        return markers
    finally:
        if process.poll() is None:
            kill_own()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=5)
        _PROCESS = None


def create_job(args):
    path = state_path(args.job_id)
    if path.exists(): raise ValueError('Use exact existing job run/resume/status, never replace its selection')
    conn = open_db()
    try:
        selected, seen, excluded = [], set(), []
        for report_file in args.from_report:
            report = json.loads(Path(report_file).read_text(encoding='utf-8'))
            sid = int(report['source_id']); handle = report['handle']
            source = conn.execute("SELECT handle FROM sources WHERE id=? AND platform='boosty'", (sid,)).fetchone()
            if not source or source['handle'] != handle: raise ValueError('Source identity mismatch')
            for child in report['children']:
                identifier = child['video_id']; identity = (sid, identifier)
                if identity in seen: continue
                seen.add(identity)
                if not re.fullmatch(r'[0-9a-f-]{36}', identifier):
                    excluded.append({'source_id': sid, 'video_id': identifier, 'state': 'external_reference_unknown_duration'}); continue
                row = conn.execute("SELECT id,transcript_path,media_path,parent_external_id FROM items WHERE source_id=? AND external_id=? AND type='boosty_video'", identity).fetchone()
                if not row or str(row['parent_external_id']).removeprefix('post:') != child['post_id']: raise ValueError('Exact parent/child mismatch')
                if row['transcript_path'] and Path(row['transcript_path']).is_file() and Path(row['transcript_path']).stat().st_size:
                    excluded.append({'source_id': sid, 'video_id': identifier, 'state': 'ready_transcript_reused'}); continue
                if child['has_access'] is not True: continue
                canonical = canonicalize_post_url(child['url'])
                if canonical['author'] != handle or canonical['post_id'] != child['post_id']: raise ValueError('Canonical post mismatch')
                selected.append({k: child.get(k) for k in ['video_id', 'post_id', 'duration_sec']} |
                    {'url': canonical['canonical_url']} |
                    {'source_id': sid, 'item_id': row['id'], 'handle': handle, 'state': 'pending'})
        rank = {post: i for i, post in enumerate(args.priority_post)}
        selected.sort(key=lambda r: (rank.get(r['post_id'], len(rank)), r['source_id'] != 5527, r['item_id']))
        owned = Path(args.external_root) / 'strict-download' / args.job_id
        config = {'audio_dir': str(owned / 'audio'), 'work_dir': str(owned / 'work'), 'external_mount': args.external_mount,
                  'transcript_dir': str(app_root() / 'transcripts/boosty'), 'library_root': str(app_root()),
                  'reserve_bytes': args.reserve_bytes}
        proof = inspect_storage(config, external_mount=args.external_mount, reserve_bytes=args.reserve_bytes)
        config.update(proof['roots']); config['volume_uuid'] = proof['volume_uuid']
        if owned.exists(): raise ValueError('New job cannot claim an existing media namespace')
        owned.mkdir(parents=True, mode=0o700)
        atomic_json(owned / '.sc-owner.json', {'job_id': args.job_id, 'source_ids': sorted({r['source_id'] for r in selected})})
        state = {'version': 1, 'job_id': args.job_id, 'status': 'prepared', 'created_at': time.time(), 'selection': selected,
                 'excluded': excluded, 'config': config, 'owned_root': str(owned), 'storage_proof': proof,
                 'ceiling_bytes': args.ceiling_bytes, 'ASR': 0, 'provider_uploads': 0, 'pid': None,
                 'selection_hash': hashlib.sha256(json.dumps(selected, sort_keys=True).encode()).hexdigest()}
        state['db_job_id'] = conn.execute("INSERT INTO jobs(type,status,items_total,parameters_json,started_at) VALUES('boosty_download_only','pending',?,?,?)",
            (len(selected), json.dumps({'job_id': args.job_id, 'origin': 'mcp', 'autoCopy': False, 'mode': 'download_only', 'source_ids': sorted({r['source_id'] for r in selected})}), int(time.time()))).lastrowid
        save_state(state)
        return summary(state)
    finally: conn.close()


def summary(state):
    rows = state['selection']
    counts = {}
    for row in rows: counts[row['state']] = counts.get(row['state'], 0) + 1
    journal = state_path(state['job_id']).with_suffix('.evicted.json')
    evicted = json.loads(journal.read_text())['items'] if journal.exists() else {}
    failed = state['status'] == 'error'
    return {'ok': True, 'job_id': state['job_id'], 'db_job_id': state.get('db_job_id'), 'status': state['status'], 'pid': state.get('pid'),
        'counts': counts, 'selected': len(rows), 'excluded': len(state['excluded']),
        'verified_downloaded_audio_bytes': sum(r.get('audio_proof', {}).get('bytes', 0) for r in rows),
        'actual_audio_bytes': sum(r.get('audio_proof', {}).get('bytes', 0) for r in rows if str(r['item_id']) not in evicted),
        'byte_count_scope': 'download_receipts_minus_verified_own_evictions_not_fresh_filesystem_scan', 'evicted_after_current_rag': len(evicted),
        'error_stage': state.get('error_stage') if failed else None, 'error_code': state.get('error_code') if failed else None,
        'error_details': state.get('error_details') if failed else None, 'error_type': state.get('error_type') if failed else None,
        'previous_failure': {k: state.get(k) for k in ['error_stage', 'error_code', 'error_details', 'error_type']} if not failed and state.get('error_type') else None,
        'stop_reason': None if state['status'] in {'running', 'dispatching'} else state.get('stop_reason'),
        'owned_usage': state.get('owned_usage'), 'receipt_path': str(state_path(state['job_id'])),
        'ASR': state['ASR'], 'provider_uploads': state['provider_uploads']}


def run_job(args):
    global _STAGE
    with exclusive_run(state_path(args.job_id).with_suffix('.lock')):
        state = load_state(args.job_id)
        config = state['config']; owned = Path(state['owned_root'])
        budget = DownloadBudget(config, owned, state['ceiling_bytes'])
        if args.run_token and state.get('run_token') != args.run_token: raise RuntimeError('Runner identity changed')
        if not args.run_token and state['status'] in {'dispatching', 'running'}: raise RuntimeError('Existing delivery/runtime unknown; do not replace')
        Path(config['work_dir']).mkdir(parents=True, exist_ok=True)
        tempfile.tempdir = config['work_dir']
        os.environ.update(TMPDIR=config['work_dir'], TMP=config['work_dir'], TEMP=config['work_dir'])
        state.update(status='running', pid=os.getpid(), started_at=time.time())
        save_state(state)
        conn = open_db(); auth = None; completed_this_run = 0
        try:
            conn.execute("UPDATE jobs SET status='running',pid=? WHERE id=?", (os.getpid(), state['db_job_id']))
            for row in state['selection']:
                if args.max_items and completed_this_run >= args.max_items: break
                if row['state'] in {'ready_audio', 'ready_transcript_reused', 'cached_user_media', 'unavailable_audio', 'locked'}: continue
                if row['state'] == 'verified_audio':
                    final = Path(row['audio_path']); original = Path(row['source_audio_path'])
                    if not final.exists() and original.exists() and sha_file(original) == row['audio_proof']['sha256']:
                        os.replace(original, final)
                    if final.exists() and sha_file(final) == row['audio_proof']['sha256']:
                        row['state'] = 'ready_audio'
                        conn.execute("UPDATE items SET media_path=?,download_status='done' WHERE id=? AND (media_path IS NULL OR media_path=?)", (str(final), row['item_id'], str(final)))
                        save_state(state); completed_this_run += 1; continue
                    raise RuntimeError('Verified publication changed; preserve files')
                existing = conn.execute("SELECT transcript_path,media_path FROM items WHERE id=? AND source_id=? AND external_id=?", (row['item_id'], row['source_id'], row['video_id'])).fetchone()
                if not existing: raise RuntimeError('Selected row disappeared; no replacement')
                if existing['transcript_path'] and Path(existing['transcript_path']).is_file() and Path(existing['transcript_path']).stat().st_size:
                    row['state'] = 'ready_transcript_reused'; save_state(state); continue
                if existing['media_path'] and Path(existing['media_path']).is_file() and Path(existing['media_path']).stat().st_size:
                    media = Path(existing['media_path']).resolve()
                    if not media.is_relative_to(Path(config['external_mount'])): raise RuntimeError('Cached media not physically on admitted USB')
                    row['audio_proof'] = decode_audio(media, row['duration_sec']); row['audio_path'] = str(media)
                    row['state'] = 'cached_user_media'; save_state(state); continue
                _STAGE = 'storage'; budget.check(physical=True)
                _STAGE = 'authorized_exact_child'
                auth = auth or request_browser_auth(20)
                raw = raw_post(row['handle'], row['post_id'], auth)
                if raw.get('hasAccess') is not True:
                    row['state'] = 'locked' if raw.get('hasAccess') is False else 'access_unknown'; save_state(state); continue
                player = inspect_player(raw, row['video_id'])
                if not any(isinstance(p, dict) and p.get('url') for p in player.get('playerUrls') or []):
                    # Entitlement and playable source availability are distinct.
                    # Preserve this exact child and continue the other children,
                    # rather than declaring the whole post/source inaccessible.
                    row.update(state='unavailable_audio', availability={
                        'reason': 'upstream_player_urls_empty', 'account_has_access': True,
                        'status': player.get('status'), 'upload_status': player.get('uploadStatus'),
                        'checked_at': time.time(), 'media_downloads': 0})
                    save_state(state); continue
                work = Path(config['work_dir']) / row['video_id']; work.mkdir(parents=True, exist_ok=True)
                audio_dir = Path(config['audio_dir']) / str(row['source_id']) / row['post_id']; audio_dir.mkdir(parents=True, exist_ok=True)
                from boosty_single_ndjson import write_cookie_file
                cookie = write_cookie_file(work, auth['value'], auth.get('expirationDate'))
                try:
                    _STAGE = 'extractor_metadata'; info = extractor_metadata(row['url'], cookie)
                    entries = info.get('entries') or [info]
                    pair = next(((i, entry) for i, entry in enumerate(entries, 1) if str(entry.get('id')) == row['video_id']), None)
                    if not pair: raise RuntimeError('Exact extractor child missing; no position fallback')
                    position, entry = pair; chosen = audio_format(entry)
                    if chosen is None:
                        row.update(state='unavailable_audio', availability={
                            'reason': 'no_verified_audio_only_format', 'account_has_access': True,
                            'checked_at': time.time(), 'formats_count': len(entry.get('formats') or [])})
                        save_state(state); continue
                    row.update(state='downloading', audio_format={k: chosen.get(k) for k in ['format_id', 'ext', 'vcodec', 'acodec', 'protocol', 'tbr']})
                    save_state(state)
                    env = os.environ.copy()
                    for k in list(env):
                        if k.endswith('API_KEY') or k in {'SC_BOOSTY_AUTH_COOKIE', 'SC_BOOSTY_AUTH_EXPIRES'}: env.pop(k, None)
                    env.update(TMPDIR=str(work), TMP=str(work), TEMP=str(work))
                    def progress(usage):
                        state['owned_usage'] = usage; save_state(state)
                    fmt = chosen['format_id']
                    command = ['yt-dlp', '--cookies', str(cookie), '--no-cache-dir', '--no-overwrites', '--continue',
                        '--format', fmt, '--playlist-items', str(position), '--output', str(work / 'source.%(ext)s'),
                        '--paths', 'temp:' + str(work), '--quiet', '--newline', '--no-warnings', '--no-color', '--progress',
                        '--progress-template', 'download:__SC_PROGRESS__%(progress.downloaded_bytes)s',
                        '--print', 'after_move:__SC_FILE__%(id)s|%(format_id)s|%(filepath)s', row['url']]
                    _STAGE = 'audio_download'; markers = command_progress(command, env, budget, progress)
                    _STAGE = 'download_identity'
                    mark = next((m.split('|', 2) for m in markers if m.split('|', 2)[0] == row['video_id']), None)
                    if not mark or mark[1] != fmt: raise RuntimeError('Downloaded child/format identity unconfirmed')
                    original = Path(mark[2]).resolve()
                    if not original.is_relative_to(work.resolve()): raise RuntimeError('Downloader file escaped external work')
                    _STAGE = 'audio_decode'; proof = decode_audio(original, row['duration_sec']); budget.check(physical=True)
                    suffix = original.suffix.lower()
                    if suffix not in {'.m4a', '.mp3', '.aac', '.ogg', '.opus', '.wav', '.flac'}:
                        raise RuntimeError('Native audio-only container not supported; preserve scratch')
                    final = audio_dir / (row['video_id'] + suffix)
                    if final.exists(): raise RuntimeError('Unledgered final file exists; preserve without overwrite')
                    row.update(state='verified_audio', audio_path=str(final), audio_proof=proof,
                               source_audio_path=str(original), native_child_verified=True)
                    save_state(state)
                    # Native AAC audio is already a provider-supported format.
                    # Move, never throw away the original or create a redundant
                    # lossy MP3. The96kbps figure is an estimate, not a promise.
                    os.replace(original, final)
                    row.update(state='ready_audio', audio_path=str(final), audio_proof=proof, source_audio_sha256=proof['sha256'],
                               native_child_verified=True, ASR=0, provider_uploads=0, finished_at=time.time())
                    # Retain all remaining partial scratch. The verified native
                    # original itself is the final audio, not deleted media.
                    state['owned_usage'] = budget.check()
                    save_state(state)
                    conn.execute("UPDATE items SET media_path=?,download_status='done',download_error=NULL,updated_at=unixepoch() WHERE id=? AND (media_path IS NULL OR media_path=?)", (str(final), row['item_id'], str(final)))
                    completed_this_run += 1
                    conn.execute("UPDATE jobs SET items_done=? WHERE id=?", (sum(r['state'] in {'ready_audio', 'cached_user_media', 'ready_transcript_reused'} for r in state['selection']), state['db_job_id']))
                    print(json.dumps({'job_id': args.job_id, 'video_id': row['video_id'], 'source_id': row['source_id'],
                        'stage': 'ready_audio', 'bytes': proof['bytes'], 'duration_seconds': proof['duration_seconds'], 'ASR': 0}), flush=True)
                finally:
                    try: cookie.unlink()
                    except OSError: pass
            pending = any(r['state'] in {'pending', 'downloading', 'verified_audio'} for r in state['selection'])
            state['status'] = 'paused_item_limit' if pending else 'done_partial' if any(r['state'] not in {'ready_audio', 'cached_user_media', 'ready_transcript_reused'} for r in state['selection']) else 'done'
        except BudgetPause:
            state['status'] = 'paused_storage'; state['stop_reason'] = 'ceiling_or_reserve'; kill_own()
        except KeyboardInterrupt:
            state['status'] = 'interrupted'; state['stop_reason'] = 'caller_cancelled'; kill_own()
        except Exception as e:
            state['status'] = 'error'; state['stop_reason'] = 'download_failure_retained'; state['error_type'] = type(e).__name__
            state['error_stage'] = _STAGE; state['error_code'] = getattr(e, 'code', 'unclassified_' + _STAGE)
            state['error_details'] = getattr(e, 'details', {})
            current = next((r for r in state['selection'] if r['state'] in {'downloading', 'verified_audio'}), None)
            if current: current['error_type'] = type(e).__name__
            kill_own()
        finally:
            state['pid'] = None; state['finished_at'] = time.time(); save_state(state)
            conn.execute("UPDATE jobs SET status=?,finished_at=?,pid=NULL WHERE id=?", (state['status'], int(time.time()), state['db_job_id']))
            conn.close()
        return summary(state)


def diagnose_job(args):
    """Probe exact own interrupted scratch without auth, download, publication or deletion."""
    state = load_state(args.job_id)
    with exclusive_run(state_path(args.job_id).with_suffix('.lock')):
        budget = DownloadBudget(state['config'], state['owned_root'], state['ceiling_bytes'])
        usage = budget.check(physical=True)
        records = []
        for row in state['selection']:
            if row['state'] not in {'downloading', 'verified_audio'}: continue
            work = Path(state['config']['work_dir']) / row['video_id']
            record = {'source_id': row['source_id'], 'video_id': row['video_id'], 'post_id': row['post_id'],
                      'expected_duration_seconds': row['duration_sec'], 'scratch_files': []}
            for file in work.glob('source.*'):
                if file.is_symlink() or not file.is_file(): raise AudioFailure('unsafe_scratch')
                entry = {'name': file.name, 'bytes': file.stat().st_size}
                if file.suffix == '.m4a':
                    try: entry['audio_proof'] = decode_audio(file, row['duration_sec'])
                    except AudioFailure as error: entry.update(code=error.code, details=error.details)
                record['scratch_files'].append(entry)
            records.append(record)
        return {'ok': True, 'job_id': args.job_id, 'status': state['status'], 'error_stage': state.get('error_stage'),
                'owned_usage': usage, 'rows': records, 'ASR': 0, 'provider_uploads': 0}


def raw_post(handle, post_id, auth):
    return api_get(f"/blog/{urllib.parse.quote(handle, safe='._-')}/post/{post_id}", decode_auth_cookie(auth['value']))


def inspect_player(post, video_id):
    if post.get('hasAccess') is not True: raise RuntimeError('Account access not explicitly confirmed')
    nodes = [n for n in post.get('data') or [] if isinstance(n, dict)]
    player = next((n for n in nodes if str(n.get('id')) == video_id and n.get('type') in {'ok_video', 'video'}), None)
    if not player: raise RuntimeError('Exact native child not exposed in authorized post')
    return player


def inspect_command(args):
    global _STAGE
    _STAGE = 'storage'
    canonical = canonicalize_post_url(args.post_url)
    config = {'audio_dir': Path(args.external_root) / 'audio', 'work_dir': Path(args.external_root) / 'strict-download/inspect',
              'transcript_dir': app_root() / 'transcripts/boosty', 'library_root': app_root()}
    proof = inspect_storage(config, external_mount=args.external_mount)
    _STAGE = 'browser_auth'
    auth = request_browser_auth(20)
    _STAGE = 'account_post'
    raw = raw_post(canonical['author'], canonical['post_id'], auth)
    _STAGE = 'exact_player'
    node = inspect_player(raw, args.video_id)
    urls = node.get('playerUrls') or []
    def shape(value):
        if isinstance(value, dict):
            return {k: (v if k in {'type', 'name', 'quality'} and isinstance(v, (str, int)) and not str(v).startswith('http') else
                        {'present': bool(v), 'scheme': urllib.parse.urlsplit(v).scheme} if k == 'url' and isinstance(v, str) else type(v).__name__) for k, v in value.items()}
        return type(value).__name__
    result = {'mode': 'metadata_only', 'post_id': canonical['post_id'], 'video_id': args.video_id,
              'account_has_access': raw.get('hasAccess'), 'node_keys': list(node), 'player_urls_shape': [shape(u) for u in urls] if isinstance(urls, list) else shape(urls),
              'storage': proof, 'media_downloads': 0, 'ASR': 0, 'provider_uploads': 0}
    result['player_state'] = {k: node.get(k) for k in ['status', 'uploadStatus', 'isInvalid', 'complete', 'duration']}
    result['post_media_shapes'] = [{'type': n.get('type'), 'id': n.get('id'), 'keys': list(n)}
        for n in raw.get('data') or [] if isinstance(n, dict) and n.get('type') in {'ok_video', 'video', 'audio'}]
    from boosty_single_ndjson import write_cookie_file
    Path(config['work_dir']).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='own-inspect-', dir=config['work_dir']) as work:
        cookie = write_cookie_file(work, auth['value'], auth.get('expirationDate'))
        _STAGE = 'extractor_formats'
        try:
            info = extractor_metadata(canonical['canonical_url'], cookie)
        except AudioFailure as error:
            result.update(ok=False, code=error.code, details=error.details)
            print(json.dumps(result, ensure_ascii=False)); return 1
        entries = info.get('entries') or [info]
        entry = next((n for n in entries if str(n.get('id')) == args.video_id), None)
        if entry:
            result['formats'] = [{k: f.get(k) for k in ['format_id', 'ext', 'vcodec', 'acodec', 'protocol', 'tbr', 'filesize', 'filesize_approx']} for f in entry.get('formats') or []]
        else: result['formats_status'] = 'exact_child_not_in_extractor'
    print(json.dumps(result, ensure_ascii=False))
    return 0


def background_job(args):
    # ROOT observer and owner may both request resume. Reservation is serialized
    # before spawning; run-lock rejects a controller outside the durable state.
    with exclusive_run(state_path(args.job_id).with_suffix('.dispatch.lock')):
        return _background_job_locked(args)


def _background_job_locked(args):
    state = load_state(args.job_id)
    if state.get('pid') or state['status'] in {'running', 'dispatching'}:
        raise RuntimeError('Existing runner identity is active/unconfirmed; inspect status, no duplicate dispatch')
    config = state['config']
    inspect_storage(config, external_mount=config['external_mount'], expected_volume_uuid=config['volume_uuid'], reserve_bytes=config['reserve_bytes'])
    output = state_path(args.job_id).with_suffix('.ndjson')
    token = str(uuid.uuid4())
    with exclusive_run(state_path(args.job_id).with_suffix('.lock')):
        current = load_state(args.job_id)
        if current.get('pid') or current['status'] in {'running', 'dispatching'}:
            raise RuntimeError('Resume already admitted; no duplicate dispatch')
        if current != state: raise RuntimeError('Receipt changed during preflight; reread before resume')
        state.update(status='dispatching', run_token=token)
        save_state(state)
    env = os.environ.copy(); env.update(TMPDIR=config['work_dir'], TMP=config['work_dir'], TEMP=config['work_dir'])
    for name in list(env):
        if name.endswith('API_KEY'): env.pop(name, None)
    with output.open('ab') as log:
        os.chmod(output, 0o600)
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'run', '--job-id', args.job_id, '--run-token', token],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, start_new_session=True)
    with exclusive_run(state_path(args.job_id).with_suffix('.state.lock')):
        current = load_state(args.job_id)
        if current.get('run_token') == token and current['status'] == 'dispatching':
            current['pid'] = process.pid; atomic_json(state_path(args.job_id), current)
    # Runner owns the next durable write. Do not overwrite its terminal/updated
    # state merely because dispatch ACK returned after it started.
    return {'ok': True, 'job_id': args.job_id, 'pid': process.pid, 'run_token': token, 'accepted': True,
            'log_path': str(output), 'receipt_path': str(state_path(args.job_id)), 'ASR': 0, 'provider_uploads': 0}


def main(argv=None):
    parser = argparse.ArgumentParser(prog='sc boosty-download', description=__doc__)
    commands = parser.add_subparsers(dest='operation', required=True)
    inspect = commands.add_parser('inspect', help='safe authorized player/audio format metadata, no download')
    inspect.add_argument('--post-url', required=True); inspect.add_argument('--video-id', required=True)
    inspect.add_argument('--external-root', default='/Volumes/digma512/SC Desktop/Boosty')
    inspect.add_argument('--external-mount', default='/Volumes/digma512')
    plan = commands.add_parser('plan', help='exact missing native selection from prior supported account reports, no full feed redo')
    plan.add_argument('--from-report', action='append', required=True); plan.add_argument('--job-id', required=True)
    plan.add_argument('--priority-post', action='append', default=[])
    plan.add_argument('--external-root', default='/Volumes/digma512/SC Desktop/Boosty'); plan.add_argument('--external-mount', default='/Volumes/digma512')
    plan.add_argument('--ceiling-bytes', type=int, default=20 * 1024 ** 3); plan.add_argument('--reserve-bytes', type=int, default=5 * 1024 ** 3)
    for op in ['run', 'status', 'ledger', 'background', 'diagnose']:
        cmd = commands.add_parser(op); cmd.add_argument('--job-id', required=True)
        if op == 'ledger': cmd.add_argument('--only-state')
        if op == 'run':
            cmd.add_argument('--max-items', type=int, default=0); cmd.add_argument('--run-token')
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    args = parser.parse_args(argv)
    try:
        if args.operation == 'inspect': return inspect_command(args)
        result = create_job(args) if args.operation == 'plan' else run_job(args) if args.operation == 'run' else background_job(args) if args.operation == 'background' else diagnose_job(args) if args.operation == 'diagnose' else load_state(args.job_id) if args.operation == 'ledger' else summary(load_state(args.job_id))
        if args.operation == 'ledger' and args.only_state: result = {'job_id': args.job_id, 'status': result['status'], 'error_type': result.get('error_type'), 'rows': [r for r in result['selection'] if r['state'] == args.only_state]}
        print(json.dumps(result, ensure_ascii=False)); return 0 if result.get('status') != 'error' else 1
    except Exception as error:
        print(json.dumps({'ok': False, 'code': 'BOOSTY_DOWNLOAD_PREFLIGHT_FAILED', 'stage': _STAGE,
                          'error_type': type(error).__name__, 'http_status': getattr(error, 'status', None), 'media_downloads': 0, 'ASR': 0}))
        return 1


if __name__ == '__main__': raise SystemExit(main())
