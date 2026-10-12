#!/usr/bin/env python3
"""SC saved attachment inventory/original/text API through standard CLI.

Bounded documents on Mac; no cloud upload/ASR, no signed URL in manifests.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
import urllib.parse
import urllib.request
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
from boosty_full_channel import app_root, atomic_json, exclusive_run
from boosty_download_phase import raw_post, sha_file
from boosty_cli import request_browser_auth
from shared.library_db import open_db, upsert_item
from shared.boosty_storage import volume_info

MEDIA_SUFFIXES = {'.m4a', '.mp3', '.aac', '.ogg', '.opus', '.wav', '.flac', '.mp4', '.mov', '.webm', '.mkv'}
TEXT_SUFFIXES = {'.txt', '.md', '.json', '.csv', '.srt', '.py', '.go', '.js', '.ts', '.java', '.sql', '.yaml', '.yml', '.html', '.css'}


def file_suffix(row):
    return Path((row.get('name') or '').strip()).suffix.lower()


def mac_original_bytes(state):
    return sum(r.get('original_bytes', 0) for r in state['rows'] if file_suffix(r) not in MEDIA_SUFFIXES)


def extract_text_file(original, directory):
    suffix = original.name.strip().lower().rsplit('.', 1)[-1]
    gaps = []
    if '.' + suffix in TEXT_SUFFIXES:
        content = original.read_text(encoding='utf-8')
    elif suffix in {'zip', 'docx', 'pptx'}:
        # Do not extract paths to disk, execute code, follow archive symlinks,
        # or inflate unbounded data. A binary member is an explicit text gap.
        with zipfile.ZipFile(original) as archive:
            infos = archive.infolist()
            if len(infos) > 10000 or sum(i.file_size for i in infos) > 64 * 1024**2:
                raise ValueError('Archive extraction exceeds bounded budget')
            blocks = []
            for entry in sorted(infos, key=lambda i: i.filename):
                if entry.is_dir(): continue
                name = entry.filename
                if name.startswith('/') or '..' in Path(name).parts or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    gaps.append({'member': name[:200], 'reason': 'unsafe_member'}); continue
                if entry.file_size > 8 * 1024**2:
                    gaps.append({'member': name[:200], 'reason': 'member_byte_ceiling'}); continue
                if suffix in {'docx', 'pptx'}:
                    wanted = name == 'word/document.xml' if suffix == 'docx' else bool(re.fullmatch(r'ppt/(slides/slide\d+|notesSlides/notesSlide\d+)\.xml', name))
                    if not wanted: continue
                    from defusedxml import ElementTree
                    tree = ElementTree.fromstring(archive.read(entry))
                    text = '\n'.join(n.text or '' for n in tree.iter() if n.tag.endswith('}t'))
                elif Path(name).suffix.lower() in TEXT_SUFFIXES or Path(name).name.lower() in {'readme', 'license', 'makefile', 'dockerfile'}:
                    try: text = archive.read(entry).decode('utf-8')
                    except UnicodeError:
                        gaps.append({'member': name[:200], 'reason': 'not_utf8'}); continue
                else:
                    gaps.append({'member': name[:200], 'reason': 'binary_member_not_text'}); continue
                blocks.append(f'[Archive member {name}]\n{text}')
            content = '\n\n'.join(blocks)
            if suffix in {'docx', 'pptx'}:
                gaps.append({'reason': 'office_text_only_visuals_attachments_not_extracted'})
    else: return {'state': 'original_verified_binary_text_unsupported'}
    target = directory / 'full.txt'; target.write_text(content, encoding='utf-8')
    return {'state': 'original_verified_text_partial' if gaps or not content.strip() else 'text_extracted_complete',
            'text_path': str(target), 'text_sha256': sha_file(target), 'gaps': gaps,
            'extraction_method': 'bounded_archive_text' if suffix in {'zip', 'docx', 'pptx'} else 'utf8_original'}


def manifest_path(job_id):
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', job_id or ''): raise ValueError('Invalid asset job_id')
    return app_root() / 'jobs/boosty-assets' / (job_id + '.json')


def inventory(args):
    path = manifest_path(args.job_id)
    if path.exists(): raise ValueError('Use exact saved inventory, not a replacement')
    rows = []
    for report_file in args.from_report:
        report = json.loads(Path(report_file).read_text(encoding='utf-8'))
        for post in report['posts']:
            for asset in post.get('assets_metadata') or []:
                rows.append({'source_id': report['source_id'], 'handle': report['handle'], 'post_id': post['post_id'],
                    'canonical_url': post['url'], 'post_item_id': post['item_id'], 'account_has_access_snapshot': post['has_access'],
                    **asset, 'state': 'metadata_only', 'identity_basis': 'upstream_id' if asset.get('asset_id') else 'position_only_not_upstream_id'})
    state = {'job_id': args.job_id, 'status': 'inventoried', 'rows': rows, 'created_at': time.time(),
             'ASR': 0, 'provider_uploads': 0, 'max_file_bytes': args.max_file_bytes, 'max_total_original_bytes': args.max_total_bytes}
    atomic_json(path, state)
    return summary(state)


def summary(state):
    counts, types = {}, {}
    for row in state['rows']:
        counts[row['state']] = counts.get(row['state'], 0) + 1
        types[row['kind']] = types.get(row['kind'], 0) + 1
    return {'ok': True, 'job_id': state['job_id'], 'status': state['status'], 'rows': len(state['rows']),
            'types': types, 'counts': counts, 'original_bytes': sum(r.get('original_bytes', 0) for r in state['rows']),
            'Mac_document_image_bytes': mac_original_bytes(state),
            'original_ceiling_scope': 'Mac_documents_and_images_external_media_uses_download_pool',
            'inventory_scopes': state.get('inventory_scopes'),
            'receipt_path': str(manifest_path(state['job_id'])), 'ASR': 0, 'provider_uploads': 0}


def trusted_url(url):
    parsed = urllib.parse.urlsplit(url or '')
    # Signed file URLs from Boosty's first-party attachment nodes only; link
    # nodes are NOT arbitrary URLs to fetch, and never feed local/LAN targets.
    if parsed.scheme != 'https' or parsed.username or parsed.password or not parsed.hostname:
        raise ValueError('Untrusted asset URL')
    if not any(parsed.hostname == domain or parsed.hostname.endswith('.' + domain) for domain in ['boosty.to', 'boostycdn.com', 'mycdn.me', 'userapi.com']):
        raise ValueError('Attachment CDN host needs explicit adapter evidence')
    return url


def attachment_headers(referer=None):
    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'}
    if referer:
        from boosty_api import canonicalize_post_url
        headers['Referer'] = canonicalize_post_url(referer)['canonical_url']
    return headers


def authorized_file_url(node, post):
    if post.get('hasAccess') is not True: raise ValueError('Current account must authorize the file')
    url = trusted_url(node.get('url'))
    signed = post.get('signedQuery')
    # Boosty's authorized response carries a separate query capability for its
    # CDN files. Do not invent it, use cookies on a CDN, or persist this URL.
    if signed:
        if not isinstance(signed, str) or len(signed) > 8192 or re.search(r'[\r\n#]', signed):
            raise ValueError('Invalid upstream CDN query capability')
        query = signed.lstrip('?&')
        if not urllib.parse.parse_qsl(query, keep_blank_values=True): raise ValueError('Invalid upstream query')
        url += ('&' if urllib.parse.urlsplit(url).query else '?') + query
    return trusted_url(url)


class AuthorizedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        trusted_url(newurl)  # Check BEFORE following; do not fetch local/arbitrary redirect.
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def bounded_original(url, target, maximum, declared_bytes=None, referer=None, byte_guard=None):
    url = trusted_url(url)
    if declared_bytes is not None and declared_bytes > maximum: raise ValueError('Original exceeds per-file byte ceiling')
    request = urllib.request.Request(url, headers=attachment_headers(referer))
    part = target.with_suffix(target.suffix + '.part')
    if target.exists(): raise ValueError('Unledgered original exists; do not overwrite')
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with urllib.request.build_opener(AuthorizedRedirect()).open(request, timeout=120) as response:
        trusted_url(response.geturl())
        count = 0
        with part.open('wb') as out:
            os.chmod(part, 0o600)
            while True:
                block = response.read(min(1024 * 256, maximum + 1 - count))
                if not block: break
                count += len(block)
                if count > maximum: raise ValueError('Original actual bytes exceed ceiling; partial retained')
                out.write(block)
                if byte_guard: byte_guard()
            out.flush(); os.fsync(out.fileno())
    if not count or declared_bytes and count != declared_bytes: raise ValueError('Original byte identity unconfirmed')
    os.replace(part, target)
    return count, sha_file(target)


def extract_pdf(original, directory):
    info = subprocess.run(['pdfinfo', str(original)], capture_output=True, timeout=30)
    match = re.search(rb'^Pages:\s*(\d+)', info.stdout, re.M)
    if info.returncode or not match: raise ValueError('PDF structure unreadable')
    count = int(match.group(1))
    if count > 512: return {'state': 'original_verified_page_budget_pending', 'pages_total': count, 'pages_extracted': 0}
    text = directory / 'full.txt'
    subprocess.run(['pdftotext', '-layout', '-enc', 'UTF-8', str(original), str(text)], capture_output=True, check=True, timeout=120)
    pages = text.read_text(encoding='utf-8').split('\f')
    while pages and not pages[-1].strip(): pages.pop()
    if len(pages) > count: raise ValueError('Extracted page mapping invalid')
    rendered = directory / 'pages'; rendered.mkdir(exist_ok=True)
    subprocess.run(['pdftoppm', '-r', '110', '-png', str(original), str(rendered / 'page')],
                   capture_output=True, check=True, timeout=max(120, count * 30))
    records = []; gaps = []
    for i in range(1, count + 1):
        content = pages[i - 1] if i <= len(pages) else ''
        image = next(iter(rendered.glob('page-' + str(i).zfill(len(str(count))) + '.png')), None)
        if not image: image = next(iter(rendered.glob('page-' + str(i) + '.png')), None)
        method = 'pdftotext_layout'
        if len(content.strip()) < 40:
            # English-only system tessdata is not silently treated as RU+EN OCR.
            local_models = app_root() / 'models/tesseract'
            model_args = ['--tessdata-dir', str(local_models)] if (local_models / 'rus.traineddata').is_file() and (local_models / 'eng.traineddata').is_file() else []
            langs = subprocess.run(['tesseract', '--list-langs', *model_args], capture_output=True, text=True).stdout
            if 'rus' in langs and image:
                ocr = subprocess.run(['tesseract', str(image), 'stdout', *model_args, '-l', 'rus+eng'], capture_output=True, text=True, timeout=120)
                content = ocr.stdout if not ocr.returncode else ''; method = 'offline_tesseract_rus_eng'
                if not content.strip(): gaps.append({'page': i, 'reason': 'blank_or_unreadable_after_offline_OCR'})
            else: gaps.append({'page': i, 'reason': 'scan_or_empty_page_RU_OCR_model_missing'}); method = 'not_extracted'
        page_file = directory / f'page-{i}.txt'; page_file.write_text(content, encoding='utf-8')
        records.append({'page': i, 'text_path': str(page_file), 'text_sha256': sha_file(page_file),
            'chars': len(content), 'method': method, 'image_path': str(image) if image else None,
            'image_sha256': sha_file(image) if image else None})
    full = '\n\n'.join(f'[PDF page {r["page"]}]\n' + Path(r['text_path']).read_text(encoding='utf-8') for r in records)
    text.write_text(full, encoding='utf-8')
    return {'state': 'text_extracted_complete' if not gaps else 'original_verified_text_partial', 'pages_total': count,
            'pages_extracted': count - len(gaps), 'pages': records, 'gaps': gaps, 'text_path': str(text), 'text_sha256': sha_file(text)}


def fetch_documents(args):
    path = manifest_path(args.job_id)
    state = json.loads(path.read_text(encoding='utf-8'))
    local = volume_info(app_root())
    if local.get('Internal') is not True: raise ValueError('Document originals/text must stay on Mac')
    with exclusive_run(path.with_suffix('.lock')):
        auth = request_browser_auth(20); conn = open_db(); checked_posts = {}; done = 0
        try:
            selected = [r for r in state['rows'] if r['kind'] == 'file' and r['asset_id'] and
                        (not args.post_id or r['post_id'] in args.post_id)]
            selected.sort(key=lambda r: (r['post_id'] != 'c86072da-29f3-4b7b-821b-97b3615f6a05', r['source_id'], r['post_id'], r['position']))
            state['status'] = 'fetching_documents'; atomic_json(path, state)
            for row in selected:
                if args.max_items and done >= args.max_items: break
                if file_suffix(row) in MEDIA_SUFFIXES:
                    row.update(coverage='media_requires_external_lifecycle', media_storage_required='external_only')
                    if not row.get('original_path'): row['state'] = 'media_pending_external_lifecycle'
                    atomic_json(path, state); continue
                if row['state'].startswith('text_extracted') or (row['state'] == 'original_verified_binary_text_unsupported' and
                        file_suffix(row) not in TEXT_SUFFIXES | {'.zip', '.docx', '.pptx'}):
                    if row.get('original_path') and sha_file(row['original_path']) != row['original_sha256']:
                        raise ValueError('Saved attachment original changed; preserve without overwrite')
                    row.update(original_saved=True, extracted_text_saved=bool(row.get('text_path')), coverage=row['state'])
                    for key in ['error_type', 'http_status']: row.pop(key, None)
                    continue
                size = row.get('bytes'); total = mac_original_bytes(state)
                if size is not None and (size > state['max_file_bytes'] or total + size > state['max_total_original_bytes']):
                    row['state'] = 'original_pending_byte_ceiling'; atomic_json(path, state); continue
                identity = (row['handle'], row['post_id'])
                parent = conn.execute("SELECT i.published_at,s.handle FROM items i JOIN sources s ON s.id=i.source_id WHERE i.id=? AND i.source_id=? AND i.external_id=? AND i.type='boosty_post' AND s.platform='boosty'", (row['post_item_id'], row['source_id'], 'post:' + row['post_id'])).fetchone()
                if not parent or parent['handle'] != row['handle']: raise ValueError('Asset parent/source identity changed')
                if identity not in checked_posts: checked_posts[identity] = raw_post(*identity, auth)
                post = checked_posts[identity]
                if post.get('hasAccess') is not True:
                    row['state'] = 'locked_or_unknown_current_account'; atomic_json(path, state); continue
                node = next((n for n in post.get('data') or [] if isinstance(n, dict) and n.get('type') == 'file' and str(n.get('id')) == row['asset_id']), None)
                if not node: row['state'] = 'asset_not_exposed_now'; atomic_json(path, state); continue
                directory = app_root() / 'assets/boosty' / str(row['source_id']) / row['post_id'] / row['asset_id']
                name = Path(row.get('name') or 'original.bin').name
                name = re.sub(r'[^\w .-]', '_', name)[:180]
                original = directory / name
                try:
                    row['cdn_host'] = urllib.parse.urlsplit(node.get('url') or '').hostname
                    row['node_keys'] = list(node)
                    maximum = min(state['max_file_bytes'], state['max_total_original_bytes'] - total)
                    if row.get('original_sha256'):
                        if str(original) != row['original_path'] or sha_file(original) != row['original_sha256']:
                            raise ValueError('Saved original changed; no redownload/overwrite')
                        if row.get('text_path') and sha_file(row['text_path']) != row.get('text_sha256'):
                            raise ValueError('Saved extracted text changed; no overwrite on OCR retry')
                        count, digest = row['original_bytes'], row['original_sha256']
                    else:
                        count, digest = bounded_original(authorized_file_url(node, post), original, maximum, size, row['canonical_url'])
                    row.update(state='original_verified', original_path=str(original), original_sha256=digest, original_bytes=count,
                               provenance='authorized_author_attachment_not_Fedor_employment_evidence')
                    atomic_json(path, state)
                    if original.suffix.lower() == '.pdf': row.update(extract_pdf(original, directory))
                    else: row.update(extract_text_file(original, directory))
                    item_id = upsert_item(conn, source_id=row['source_id'], external_id='asset:' + row['asset_id'], type='boosty_asset',
                        url=row['canonical_url'], title=row.get('name'), published_at=parent['published_at'], raw_meta={'platform': 'boosty', 'entity_kind': 'asset',
                            'post_id': row['post_id'], 'asset_id': row['asset_id'], 'kind': 'file', 'original_sha256': row['original_sha256'],
                            'extraction_state': row['state'], 'text_sha256': row.get('text_sha256'), 'pages': row.get('pages'), 'provenance': row['provenance']})
                    conn.execute("UPDATE items SET parent_external_id=?,depth=1,media_path=?,has_media=1,transcript_path=? WHERE id=?", ('post:' + row['post_id'], str(original), row.get('text_path'), item_id))
                    row['item_id'] = item_id; done += 1
                    row.update(original_saved=True, extracted_text_saved=bool(row.get('text_path')), coverage=row['state'])
                    for key in ['error_type', 'http_status']: row.pop(key, None)
                except Exception as e:
                    row['state'] = 'original_or_extraction_error'; row['error_type'] = type(e).__name__; row['http_status'] = getattr(e, 'code', None)
                atomic_json(path, state)
                print(json.dumps({'job_id': args.job_id, 'asset_id': row['asset_id'], 'state': row['state'],
                    'bytes': row.get('original_bytes'), 'pages': row.get('pages_total'), 'provider_uploads': 0}), flush=True)
            state['status'] = 'documents_pass_complete_partial_other_types'
            atomic_json(path, state)
        finally: conn.close()
    return summary(state)


def set_limits(args):
    path = manifest_path(args.job_id)
    with exclusive_run(path.with_suffix('.lock')):
        state = json.loads(path.read_text())
        if not 1 <= args.max_file_bytes <= 128 * 1024**2 or not args.max_file_bytes <= args.max_total_bytes <= 1024**3:
            raise ValueError('Document limits exceed supported bounded pass')
        if shutil.disk_usage(app_root()).free < args.max_total_bytes + 5 * 1024**3:
            raise ValueError('Mac document reserve unavailable')
        state.setdefault('limit_history', []).append({'at': time.time(), 'previous_file': state['max_file_bytes'],
            'previous_total': state['max_total_original_bytes']})
        state.update(max_file_bytes=args.max_file_bytes, max_total_original_bytes=args.max_total_bytes)
        atomic_json(path, state)
    return summary(state)


def fetch_images(args):
    path = manifest_path(args.job_id)
    if volume_info(app_root()).get('Internal') is not True: raise ValueError('Image originals/text must remain on Mac')
    with exclusive_run(path.with_suffix('.lock')):
        state = json.loads(path.read_text()); auth = request_browser_auth(20); conn = open_db()
        posts = {}; done = 0
        try:
            for row in state['rows']:
                if row['kind'] != 'image': continue
                if args.max_items and done >= args.max_items: break
                if row.get('original_path'):
                    if sha_file(row['original_path']) != row.get('original_sha256'): raise ValueError('Image original changed')
                    continue
                if not row['asset_id']:
                    row['state'] = 'image_identity_missing'; atomic_json(path, state); continue
                identity = (row['handle'], row['post_id'])
                if identity not in posts: posts[identity] = raw_post(*identity, auth)
                post = posts[identity]
                if post.get('hasAccess') is not True:
                    row['state'] = 'locked_or_unknown_current_account'; atomic_json(path, state); continue
                node = next((n for n in post.get('data') or [] if isinstance(n, dict) and n.get('type') == 'image' and str(n.get('id')) == row['asset_id']), None)
                if node is None: row['state'] = 'asset_not_exposed_now'; atomic_json(path, state); continue
                directory = app_root() / 'assets/boosty' / str(row['source_id']) / row['post_id'] / row['asset_id']
                target = directory / 'original.image'
                total = mac_original_bytes(state)
                maximum = min(16 * 1024**2, state['max_total_original_bytes'] - total)
                if maximum <= 0:
                    row['state'] = 'original_pending_byte_ceiling'; atomic_json(path, state); continue
                try:
                    count, digest = bounded_original(authorized_file_url(node, post), target, maximum, None, row['canonical_url'])
                    row.update(original_path=str(target), original_sha256=digest, original_bytes=count,
                        state='original_verified_image_OCR_pending', provenance='authorized_author_image_not_verified_semantic_content')
                    atomic_json(path, state)
                    from PIL import Image
                    with Image.open(target) as picture:
                        if picture.width * picture.height > 25_000_000: raise ValueError('Image pixel ceiling')
                        dimensions = [picture.width, picture.height]; picture.verify()
                    models = app_root() / 'models/tesseract'
                    if not all((models / (lang + '.traineddata')).is_file() for lang in ['eng', 'rus']): raise ValueError('Offline RU/EN OCR models missing')
                    result = subprocess.run(['tesseract', str(target), 'stdout', '--tessdata-dir', str(models), '-l', 'rus+eng'],
                        capture_output=True, text=True, timeout=120)
                    if result.returncode: raise ValueError('Offline image OCR failed')
                    text = directory / 'full.txt'; text.write_text(result.stdout, encoding='utf-8')
                    row.update(state='original_verified_text_partial', dimensions=dimensions,
                        text_path=str(text), text_sha256=sha_file(text), original_saved=True,
                        extracted_text_saved=bool(result.stdout.strip()), coverage='image_original_plus_OCR_not_visual_semantic_study',
                        gaps=[{'reason': 'OCR_does_not_cover_visual_nontext_or_verify_accuracy'}])
                    parent = conn.execute("SELECT published_at FROM items WHERE id=? AND source_id=? AND type='boosty_post' AND external_id=?",
                        (row['post_item_id'], row['source_id'], 'post:' + row['post_id'])).fetchone()
                    if not parent: raise ValueError('Image parent identity changed')
                    item = upsert_item(conn, source_id=row['source_id'], external_id='asset:' + row['asset_id'], type='boosty_asset',
                        url=row['canonical_url'], published_at=parent['published_at'], title=row.get('name'),
                        raw_meta={'asset_id': row['asset_id'], 'kind': 'image', 'original_sha256': digest,
                            'extraction_state': row['state'], 'text_sha256': row['text_sha256'], 'gaps': row['gaps']})
                    conn.execute("UPDATE items SET parent_external_id=?,depth=1,media_path=?,has_media=1,transcript_path=? WHERE id=?",
                        ('post:' + row['post_id'], str(target), str(text), item))
                    row['item_id'] = item; done += 1
                except Exception as error:
                    row['state'] = 'original_or_extraction_error'; row['error_type'] = type(error).__name__
                    row['http_status'] = getattr(error, 'code', None)
                atomic_json(path, state)
                print(json.dumps({'asset_id': row['asset_id'], 'state': row['state'], 'original_bytes': row.get('original_bytes'),
                    'provider_uploads': 0, 'ASR': 0}), flush=True)
        finally: conn.close()
        state['status'] = 'images_pass_complete_partial_semantics'; atomic_json(path, state)
        return summary(state)


def relocate_media(args):
    """Recoverable own-file move, not eviction or paid work. No arbitrary path."""
    from boosty_download_phase import load_state, decode_audio
    from shared.boosty_download_budget import DownloadBudget
    path = manifest_path(args.job_id)
    with exclusive_run(path.with_suffix('.lock')):
        state = json.loads(path.read_text())
        row = next(r for r in state['rows'] if r['source_id'] == args.source_id and r['asset_id'] == args.asset_id and r['kind'] == 'file')
        if file_suffix(row) not in {'.m4a', '.mp3', '.aac', '.ogg', '.opus', '.wav', '.flac'}:
            raise ValueError('Only own saved audio attachments may be relocated')
        if not row.get('original_sha256') or not row.get('original_path'): raise ValueError('No verified own original')
        dl = load_state(args.download_job_id)
        budget = DownloadBudget(dl['config'], dl['owned_root'], dl['ceiling_bytes'])
        expected = app_root() / 'assets/boosty' / str(row['source_id']) / row['post_id'] / row['asset_id']
        target = Path(dl['owned_root']) / 'audio-assets' / str(row['source_id']) / row['asset_id'] / Path(row['original_path']).name
        old = Path(row.get('relocation', {}).get('from_path') or row['original_path'])
        if old.is_symlink() or old.parent.resolve() != expected.resolve(): raise ValueError('Original is outside own exact asset directory')
        if old.exists() and sha_file(old) != row['original_sha256']: raise ValueError('Original changed; no move')
        if target.exists() and (target.is_symlink() or sha_file(target) != row['original_sha256']): raise ValueError('Unmatched external destination')
        if not target.exists():
            budget.check(extra_bytes=row['original_bytes'], physical=True)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if target.parent.resolve().is_relative_to(Path(dl['owned_root']).resolve()) is not True: raise ValueError('External destination escaped')
            part = target.with_suffix(target.suffix + '.part')
            row['relocation'] = {'from_path': str(old), 'to_path': str(target), 'stage': 'copy_intent', 'at': time.time()}
            atomic_json(path, state)
            with old.open('rb') as source, part.open('wb') as out:
                os.chmod(part, 0o600)
                shutil.copyfileobj(source, out, 256 * 1024); out.flush(); os.fsync(out.fileno())
            if sha_file(part) != row['original_sha256']: raise ValueError('Copy hash mismatch; original retained')
            os.replace(part, target)
        proof = decode_audio(target, None); budget.check(physical=True)
        row['relocation'].update(stage='external_verified', audio_proof=proof)
        atomic_json(path, state)
        # Full identical copy is verified first. Files remain recoverable on USB;
        # no transcript/RAG/ASR paid receipt is deleted or synthesized.
        if old.exists(): old.unlink()
        row.update(original_path=str(target), state='external_original_verified_text_pending',
                   coverage='audio_original_saved_no_ASR', media_storage='external_USB', original_saved=True)
        row['relocation']['stage'] = 'moved'
        conn = open_db()
        try:
            conn.execute("UPDATE items SET media_path=? WHERE id=? AND source_id=? AND type='boosty_asset' AND external_id=? AND (media_path=? OR media_path=?)",
                (str(target), row['item_id'], row['source_id'], 'asset:' + row['asset_id'], str(old), str(target)))
        finally: conn.close()
        atomic_json(path, state)
        return {'ok': True, 'asset_id': row['asset_id'], 'source_id': row['source_id'], 'state': row['state'],
                'original_sha256': row['original_sha256'], 'audio_proof': proof, 'destination': str(target), 'ASR': 0,
                'provider_uploads': 0, 'original_preserved_external': True}


def fetch_audio_attachment(args):
    from boosty_download_phase import load_state, state_path, decode_audio
    from shared.boosty_download_budget import DownloadBudget
    # Exact single asset only, admitted against the same byte pool. Never a
    # second collector alongside the native downloader or a new paid namespace.
    with exclusive_run(state_path(args.download_job_id).with_suffix('.lock')):
        dl = load_state(args.download_job_id)
        if dl.get('pid') or dl['status'] in {'running', 'dispatching'}: raise ValueError('Native audio controller active; defer attachment')
        path = manifest_path(args.job_id)
        with exclusive_run(path.with_suffix('.lock')):
            state = json.loads(path.read_text())
            row = next(r for r in state['rows'] if r['source_id'] == args.source_id and r['asset_id'] == args.asset_id and r['kind'] == 'file')
            if file_suffix(row) not in {'.m4a', '.mp3', '.aac', '.ogg', '.opus', '.wav', '.flac'}: raise ValueError('Only audio-only file attachments')
            budget = DownloadBudget(dl['config'], dl['owned_root'], dl['ceiling_bytes'])
            budget.check(physical=True)
            if row.get('original_path'):
                original = Path(row['original_path'])
                if not original.resolve().is_relative_to(Path(dl['owned_root']).resolve()) or sha_file(original) != row.get('original_sha256'):
                    raise ValueError('Saved media is not the same verified external original')
                return {'ok': True, 'reused': True, 'asset_id': row['asset_id'], 'sha256': row['original_sha256'], 'ASR': 0}
            if not row.get('bytes') or row['bytes'] > 128 * 1024**2: raise ValueError('Attachment size missing or outside bounded media pass')
            budget.check(extra_bytes=row['bytes'], physical=True)
            post = raw_post(row['handle'], row['post_id'], request_browser_auth(20))
            node = next((n for n in post.get('data') or [] if isinstance(n, dict) and n.get('type') == 'file' and str(n.get('id')) == row['asset_id']), None)
            if not node or post.get('hasAccess') is not True or node.get('size') != row['bytes']: raise ValueError('Exact authorized attachment size/identity changed')
            target = Path(dl['owned_root']) / 'audio-assets' / str(row['source_id']) / row['asset_id'] / Path(row['name'].strip()).name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not target.parent.resolve().is_relative_to(Path(dl['owned_root']).resolve()): raise ValueError('Media path escaped external namespace')
            count, digest = bounded_original(authorized_file_url(node, post), target, row['bytes'], row['bytes'], row['canonical_url'], budget.check)
            row.update(original_path=str(target), original_sha256=digest, original_bytes=count, state='external_original_verified_decode_pending')
            atomic_json(path, state)
            proof = decode_audio(target, None); budget.check(physical=True)
            row.update(state='external_original_verified_text_pending', audio_proof=proof, original_saved=True,
                       media_storage='external_USB', coverage='audio_original_saved_no_ASR')
            conn = open_db()
            try:
                parent = conn.execute("SELECT published_at FROM items WHERE id=? AND source_id=? AND type='boosty_post' AND external_id=?",
                    (row['post_item_id'], row['source_id'], 'post:' + row['post_id'])).fetchone()
                if not parent: raise ValueError('Attachment parent identity changed')
                item = upsert_item(conn, source_id=row['source_id'], external_id='asset:' + row['asset_id'], type='boosty_asset',
                    url=row['canonical_url'], title=row.get('name'), published_at=parent['published_at'],
                    raw_meta={'asset_id': row['asset_id'], 'kind': 'file_audio', 'original_sha256': digest, 'extraction_state': row['state']})
                conn.execute("UPDATE items SET parent_external_id=?,depth=1,media_path=?,has_media=1 WHERE id=?",
                    ('post:' + row['post_id'], str(target), item))
                row['item_id'] = item
            finally: conn.close()
            atomic_json(path, state)
            return {'ok': True, 'asset_id': row['asset_id'], 'audio_proof': proof, 'destination': str(target), 'ASR': 0, 'provider_uploads': 0}


def audit_originals(args):
    from boosty_download_phase import load_state
    from shared.boosty_storage import inspect_storage
    state = json.loads(manifest_path(args.job_id).read_text())
    dl = load_state(args.download_job_id)
    storage = inspect_storage(dl['config'], external_mount=dl['config']['external_mount'],
        expected_volume_uuid=dl['config']['volume_uuid'], reserve_bytes=dl['config']['reserve_bytes'])
    records = []; errors = []
    for row in state['rows']:
        if not row.get('original_path'): continue
        original = Path(row['original_path']); media = file_suffix(row) in MEDIA_SUFFIXES
        admitted = Path(dl['owned_root']) if media else app_root() / 'assets/boosty' / str(row['source_id']) / row['post_id'] / row['asset_id']
        safe = not original.is_symlink() and original.resolve().is_relative_to(admitted.resolve())
        try: matched = safe and sha_file(original) == row['original_sha256']
        except OSError: matched = False
        if not matched: errors.append({'asset_id': row['asset_id'], 'reason': 'original_path_or_hash_mismatch'})
        records.append({'source_id': row['source_id'], 'post_id': row['post_id'], 'asset_id': row['asset_id'],
            'kind': row['kind'], 'state': row['state'], 'original_sha256': row['original_sha256'],
            'bytes': row['original_bytes'], 'hash_path_verified': matched, 'physical_scope': 'external_own_media' if media else 'Mac_own_document_or_image'})
    out = {'ok': not errors, 'checked_at': time.time(), 'job_id': args.job_id, 'download_job_id': args.download_job_id,
           'snapshot_scope': 'current_saved_asset_manifest_originals_not_all_remote_content', 'originals': len(records),
           'bytes': sum(r['bytes'] for r in records), 'storage': storage, 'records': records, 'errors': errors,
           'ASR': 0, 'provider_uploads': 0}
    if args.save_proof:
        proof = app_root() / 'tmp' / (args.job_id + '-originals-audit.json')
        atomic_json(proof, out); out['proof_path'] = str(proof)
    return out


def inspect_references(args):
    state = json.loads(manifest_path(args.job_id).read_text())
    rows = [r for r in state['rows'] if r['kind'] == 'video']
    auth = request_browser_auth(20); results = []
    for row in rows:
        post = raw_post(row['handle'], row['post_id'], auth)
        candidates = [n for n in post.get('data') or [] if isinstance(n, dict) and n.get('type') == 'video']
        for node in candidates:
            url = str(node.get('url') or ''); parsed = urllib.parse.urlsplit(url)
            canonical = None
            # Only reconstruct supported public provider identities, never an
            # arbitrary capability/private-link query in output or artifacts.
            if parsed.hostname in {'www.youtube.com', 'youtube.com'}:
                identifier = urllib.parse.parse_qs(parsed.query).get('v', [None])[0]
                if identifier and re.fullmatch(r'[A-Za-z0-9_-]{11}', identifier): canonical = 'https://www.youtube.com/watch?v=' + identifier
            elif parsed.hostname == 'youtu.be' and re.fullmatch(r'/[A-Za-z0-9_-]{11}', parsed.path):
                canonical = 'https://www.youtube.com/watch?v=' + parsed.path[1:]
            results.append({'source_id': row['source_id'], 'post_id': row['post_id'], 'asset_id': node.get('id'),
                'account_has_access': post.get('hasAccess'), 'provider_host': parsed.hostname,
                'canonical_public_provider_url': canonical, 'upstream_duration': node.get('duration'),
                'reference_sha256': hashlib.sha256(url.encode()).hexdigest(), 'keys': list(node),
                'coverage': 'reference_only_no_provider_content_download_or_ASR'})
    out = {'ok': True, 'references': results, 'remote_downloads': 0, 'ASR': 0, 'provider_uploads': 0}
    proof = app_root() / 'tmp' / (args.job_id + '-external-references.json')
    atomic_json(proof, out); out['proof_path'] = str(proof)
    return out


def refresh_asset_metadata(args):
    """Only missing asset snapshots for already known posts; no feed/body/child redo."""
    from boosty_api import normalize_assets_metadata
    path = manifest_path(args.job_id)
    with exclusive_run(path.with_suffix('.lock')):
        state = json.loads(path.read_text()); conn = open_db()
        try:
            source = conn.execute("SELECT handle FROM sources WHERE id=? AND platform='boosty'", (args.source_id,)).fetchone()
            if not source: raise ValueError('Unknown saved Boosty source')
            posts = conn.execute("SELECT id,external_id,url FROM items WHERE source_id=? AND type='boosty_post' ORDER BY published_at DESC,id", (args.source_id,)).fetchall()
            seen = state.setdefault('asset_metadata_checked_posts', [])
            auth = request_browser_auth(20)
            for parent in posts:
                key = str(args.source_id) + ':' + parent['external_id']
                if key in seen: continue
                identifier = parent['external_id'].removeprefix('post:')
                post = raw_post(source['handle'], identifier, auth)
                # Unknown/locked posts are inventoried, not silently read with
                # another identity. Bodies/teasers never overwrite saved text.
                for asset in normalize_assets_metadata(post.get('data') or []):
                    state['rows'].append({'source_id': args.source_id, 'handle': source['handle'], 'post_id': identifier,
                        'canonical_url': parent['url'], 'post_item_id': parent['id'], 'account_has_access_snapshot': post.get('hasAccess'),
                        **asset, 'state': 'metadata_only', 'identity_basis': 'upstream_id' if asset.get('asset_id') else 'position_only_not_upstream_id'})
                seen.append(key)
                state.setdefault('inventory_scopes', {})[str(args.source_id)] = {
                    'known_saved_posts': len(posts), 'posts_checked': sum(k.startswith(str(args.source_id) + ':') for k in seen),
                    'scope': 'known_saved_posts_asset_metadata_only_not_new_remote_feed_EOF', 'checked_at': time.time()}
                atomic_json(path, state)
            state['inventory_scopes'][str(args.source_id)]['complete_known_saved_post_scope'] = True
            atomic_json(path, state)
        finally: conn.close()
    return summary(state)


def diagnose_file(args):
    state = json.loads(manifest_path(args.job_id).read_text(encoding='utf-8'))
    row = next(r for r in state['rows'] if r['asset_id'] == args.asset_id and r['kind'] == 'file')
    post = raw_post(row['handle'], row['post_id'], request_browser_auth(20))
    if post.get('hasAccess') is not True: raise ValueError('Account access not verified')
    node = next(n for n in post.get('data') or [] if isinstance(n, dict) and str(n.get('id')) == row['asset_id'] and n.get('type') == 'file')
    url = authorized_file_url(node, post)
    parsed = urllib.parse.urlsplit(url)
    result = {'asset_id': row['asset_id'], 'cdn_host': parsed.hostname, 'path_segments': len(parsed.path.split('/')),
              'url_query_field_names': list(urllib.parse.parse_qs(parsed.query)), 'node_keys': list(node),
              'post_keys': list(post), 'signed_query_present': bool(post.get('signedQuery')), 'media_downloads': 0, 'ASR': 0, 'provider_uploads': 0}
    try:
        request = urllib.request.Request(url, headers=attachment_headers(row['canonical_url']), method='HEAD')
        with urllib.request.build_opener(AuthorizedRedirect()).open(request, timeout=30) as response:
            result.update(http_status=response.status, content_type=response.headers.get('Content-Type'), content_length=response.headers.get('Content-Length'))
    except urllib.error.HTTPError as error: result['http_status'] = error.code
    return result


def install_ocr():
    """Bounded official offline models; no global Tesseract or app mutation."""
    root = app_root() / 'models/tesseract'; root.mkdir(parents=True, exist_ok=True)
    models = []
    for language in ['eng', 'rus']:
        file = root / (language + '.traineddata')
        if not file.exists():
            part = file.with_suffix('.part')
            url = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/' + language + '.traineddata'
            with urllib.request.urlopen(url, timeout=60) as response, part.open('wb') as stream:
                total = 0
                while True:
                    block = response.read(256 * 1024)
                    if not block: break
                    total += len(block)
                    if total > 8 * 1024 ** 2: raise ValueError('OCR model byte ceiling')
                    stream.write(block)
                stream.flush(); os.fsync(stream.fileno())
            os.replace(part, file)
        models.append({'language': language, 'bytes': file.stat().st_size, 'sha256': sha_file(file)})
    checked = subprocess.run(['tesseract', '--list-langs', '--tessdata-dir', str(root)], capture_output=True, text=True, check=True)
    if not all(l in checked.stdout for l in ['rus', 'eng']): raise ValueError('Offline model load failed')
    return {'ok': True, 'local_models': models, 'provider_uploads': 0, 'global_settings_changed': False}


def original_read(args):
    state = json.loads(manifest_path(args.job_id).read_text(encoding='utf-8'))
    row = next(r for r in state['rows'] if r['asset_id'] == args.asset_id and r['source_id'] == args.source_id)
    if not 0 <= args.offset or not 1 <= args.max_chars <= 50000: raise ValueError('Invalid original pagination')
    row = {**row, 'original_saved': bool(row.get('original_sha256')), 'extracted_text_saved': bool(row.get('text_sha256')), 'coverage': row.get('state', 'unknown')}
    if row.get('original_sha256'):
        for key in ['error_type', 'http_status']: row.pop(key, None)
    field = 'text_path' if args.format == 'text' else 'original_path'
    file = Path(row[field]); digest = sha_file(file)
    if args.expected_hash and digest != args.expected_hash: raise ValueError('Original changed; do not join pages')
    if args.offset and not args.expected_hash: raise ValueError('Continuation requires same original hash')
    if args.format == 'metadata': return {'ok': True, 'asset': row, 'original_hash': digest}
    text = file.read_text(encoding='utf-8')
    out = text[args.offset:args.offset + args.max_chars]
    return {'ok': True, 'source_id': row['source_id'], 'post_id': row['post_id'], 'asset_id': args.asset_id,
            'canonical_url': row['canonical_url'], 'original_hash': digest, 'format': args.format, 'offset_unit': 'unicode_codepoints',
            'content': out, 'total_chars': len(text), 'next_offset': args.offset + len(out) if args.offset + len(out) < len(text) else None}


def main():
    parser = argparse.ArgumentParser(prog='sc boosty-assets', description=__doc__)
    commands = parser.add_subparsers(dest='operation', required=True)
    commands.add_parser('install-ocr')
    inv = commands.add_parser('inventory'); inv.add_argument('--job-id', required=True); inv.add_argument('--from-report', action='append', required=True)
    inv.add_argument('--max-file-bytes', type=int, default=16 * 1024 ** 2); inv.add_argument('--max-total-bytes', type=int, default=256 * 1024 ** 2)
    fetch = commands.add_parser('fetch-documents'); fetch.add_argument('--job-id', required=True)
    fetch.add_argument('--post-id', action='append'); fetch.add_argument('--max-items', type=int, default=0)
    images = commands.add_parser('fetch-images'); images.add_argument('--job-id', required=True)
    images.add_argument('--max-items', type=int, default=0)
    limits = commands.add_parser('set-limits'); limits.add_argument('--job-id', required=True)
    limits.add_argument('--max-file-bytes', type=int, required=True); limits.add_argument('--max-total-bytes', type=int, required=True)
    relocate = commands.add_parser('relocate-media'); relocate.add_argument('--job-id', required=True)
    relocate.add_argument('--download-job-id', required=True); relocate.add_argument('--source-id', type=int, required=True)
    relocate.add_argument('--asset-id', required=True)
    audio = commands.add_parser('fetch-audio-attachment'); audio.add_argument('--job-id', required=True)
    audio.add_argument('--download-job-id', required=True); audio.add_argument('--source-id', type=int, required=True)
    audio.add_argument('--asset-id', required=True)
    audit = commands.add_parser('audit'); audit.add_argument('--job-id', required=True)
    audit.add_argument('--download-job-id', required=True); audit.add_argument('--save-proof', action='store_true')
    references = commands.add_parser('inspect-references'); references.add_argument('--job-id', required=True)
    refresh = commands.add_parser('refresh-metadata'); refresh.add_argument('--job-id', required=True); refresh.add_argument('--source-id', type=int, required=True)
    diag = commands.add_parser('diagnose'); diag.add_argument('--job-id', required=True); diag.add_argument('--asset-id', required=True)
    for op in ['status', 'ledger', 'read']:
        cmd = commands.add_parser(op); cmd.add_argument('--job-id', required=True)
        if op == 'ledger': cmd.add_argument('--only-state')
        if op == 'read':
            cmd.add_argument('--asset-id', required=True); cmd.add_argument('--source-id', type=int, required=True)
            cmd.add_argument('--format', choices=['text', 'metadata'], default='metadata'); cmd.add_argument('--expected-hash')
            cmd.add_argument('--offset', type=int, default=0); cmd.add_argument('--max-chars', type=int, default=12000)
    args = parser.parse_args()
    try:
        if args.operation == 'install-ocr': out = install_ocr()
        elif args.operation == 'inventory': out = inventory(args)
        elif args.operation == 'fetch-documents': out = fetch_documents(args)
        elif args.operation == 'fetch-images': out = fetch_images(args)
        elif args.operation == 'set-limits': out = set_limits(args)
        elif args.operation == 'relocate-media': out = relocate_media(args)
        elif args.operation == 'fetch-audio-attachment': out = fetch_audio_attachment(args)
        elif args.operation == 'audit': out = audit_originals(args)
        elif args.operation == 'inspect-references': out = inspect_references(args)
        elif args.operation == 'refresh-metadata': out = refresh_asset_metadata(args)
        elif args.operation == 'read': out = original_read(args)
        elif args.operation == 'diagnose': out = diagnose_file(args)
        else:
            state = json.loads(manifest_path(args.job_id).read_text(encoding='utf-8'))
            out = state if args.operation == 'ledger' else summary(state)
            if args.operation == 'ledger' and args.only_state: out = {'job_id': args.job_id, 'rows': [r for r in state['rows'] if r['state'] == args.only_state]}
        print(json.dumps(out, ensure_ascii=False)); return 0
    except Exception as e:
        print(json.dumps({'ok': False, 'code': 'BOOSTY_ASSETS_REQUEST_FAILED', 'error_type': type(e).__name__, 'provider_uploads': 0})); return 1


if __name__ == '__main__': raise SystemExit(main())
