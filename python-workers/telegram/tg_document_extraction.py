"""Local Telegram document recovery; no DB/network/provider/receipt access.

Native bytes stay auditable. OCR is explicitly partial (not a diplomatic
transcription/diagram interpretation). Work is per-page/member, bounded and
resumable; exported originals and earlier derived files are never overwritten.
"""
import csv
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import time
import zipfile
from pathlib import Path, PurePosixPath

POLICY = 'telegram-local-document-v2-explicit-tsv'
IMAGE_SUFFIXES = {'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp'}
TEXT_SUFFIXES = {'.txt', '.md', '.json', '.csv', '.srt', '.py', '.go', '.js', '.ts', '.java', '.sql', '.yaml', '.yml', '.html', '.css'}


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()


def stable(path, data):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = data.encode('utf-8') if isinstance(data, str) else data
    if path.exists():
        if path.read_bytes() != data: raise ValueError('Existing derived output differs; no overwrite')
        return path
    part = path.with_name(path.name + '.part')
    with part.open('xb') as f:
        os.fchmod(f.fileno(), 0o600); f.write(data); f.flush(); os.fsync(f.fileno())
    os.replace(part, path)
    return path


def run(argv, timeout=60):
    # Binary stdout/stderr: invalid PDF metadata must not fail unrelated decoding.
    return subprocess.run(argv, capture_output=True, check=True, timeout=timeout)


def tsv_text(data):
    text = data.decode('utf-8')
    if not text.startswith('level\tpage_num\t') or '\tconf\ttext' not in text.splitlines()[0]:
        raise ValueError('OCR output is not TSV; never treat an unknown format as empty text')
    lines, confidences = {}, []
    for row in csv.DictReader(io.StringIO(text), delimiter='\t'):
        word = (row.get('text') or '').strip()
        if not word: continue
        key = tuple(row.get(k) for k in ('page_num', 'block_num', 'par_num', 'line_num'))
        lines.setdefault(key, []).append(word)
        try:
            value = float(row.get('conf', '-1'))
            if value >= 0: confidences.append(value)
        except ValueError: pass
    return '\n'.join(' '.join(words) for words in lines.values()), {
        'words': len(confidences), 'mean_confidence': sum(confidences) / len(confidences) if confidences else None,
        'confidence_is_not_coverage_proof': True}


def model_args(models):
    models = Path(models) if models else None
    if models and all((models / (lang + '.traineddata')).is_file() for lang in ('rus', 'eng')):
        return ['--tessdata-dir', str(models)]
    languages = run(['tesseract', '--list-langs'], 10).stdout.decode('utf-8')
    if not all(lang in languages.splitlines() for lang in ('rus', 'eng')):
        raise ValueError('Existing offline rus+eng OCR models required; no download/fallback')
    return []


def ocr(image, directory, models, command=run):
    # The private models directory has traineddata, not configs/tsv. Positional
    # 'tsv' can warn and silently return plain text with exit0. Set variables.
    result = command(['tesseract', str(image), 'stdout', *model_args(models), '-l', 'rus+eng', '--psm', '3',
                      '-c', 'tessedit_create_tsv=1', '-c', 'tessedit_create_txt=0'], 60)
    stable(directory / 'ocr.tsv', result.stdout)
    text, quality = tsv_text(result.stdout)
    return text, {'method': 'offline_tesseract_rus_eng', 'quality': quality,
                  'raw_ocr_path': str(directory / 'ocr.tsv'), 'raw_ocr_sha256': sha(directory / 'ocr.tsv')}


def cache_read(directory):
    path = directory / 'result.json'
    if not path.exists(): return None
    record = json.loads(path.read_text(encoding='utf-8'))
    for path_key, hash_key in [('text_path', 'text_sha256'), ('image_path', 'image_sha256'), ('raw_native_path', 'raw_native_sha256'), ('raw_ocr_path', 'raw_ocr_sha256')]:
        if record.get(path_key) and sha(record[path_key]) != record[hash_key]:
            raise ValueError('Derived page cache hash changed; no silent reuse')
    return record


def finish_page(directory, number, text, record):
    if len(text.encode('utf-8')) > 2 * 1024**2: raise ValueError('Page text byte ceiling')
    target = stable(directory / 'text.txt', text)
    result = {'page': number, 'text_path': str(target), 'text_sha256': sha(target), 'chars': len(text), **record}
    stable(directory / 'result.json', json.dumps(result, ensure_ascii=False, sort_keys=True))
    return result


def pdf_page(original, number, directory, models, max_edge=2400, command=run):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    cached = cache_read(directory)
    if cached: return cached
    native = command(['pdftotext', '-f', str(number), '-l', str(number), '-layout', '-enc', 'UTF-8', str(original), '-'], 30).stdout
    raw = stable(directory / 'native.bin', native)
    record = {'raw_native_path': str(raw), 'raw_native_sha256': sha(raw), 'method': 'pdftotext_layout', 'gaps': []}
    invalid = False
    try: text = native.decode('utf-8').rstrip('\f')
    except UnicodeDecodeError as error:
        invalid, text = True, ''
        record['native_decode_error'] = {'start': error.start, 'end': error.end, 'bad_bytes': native[error.start:error.end].hex()}
    if invalid or len(text.strip()) < 40:
        prefix = directory / 'render'
        command(['pdftoppm', '-f', str(number), '-l', str(number), '-singlefile', '-scale-to', str(max_edge), '-png', str(original), str(prefix)], 60)
        image = prefix.with_suffix('.png')
        from PIL import Image
        with Image.open(image) as check:
            if max(check.size) > max_edge: raise ValueError('PDF raster exceeded admitted pixel edge')
            record['raster_size'] = list(check.size)
        record.update(image_path=str(image), image_sha256=sha(image))
        text, meta = ocr(image, directory, models, command)
        record.update(meta)
        record['gaps'].append({'reason': 'OCR_not_glyph_complete_or_visual_semantics_verified',
                              'native_invalid_utf8_recovered_by_OCR': invalid})
        if not text.strip(): record['gaps'].append({'reason': 'blank_or_unreadable_after_offline_OCR'})
    return finish_page(directory, number, text, record)


def natural_name(name):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r'(\d+)', name)]


def safe_member(entry):
    name = entry.filename
    parts = PurePosixPath(name.replace('\\', '/')).parts
    return not (name.startswith(('/', '\\')) or re.match(r'^[A-Za-z]:', name) or '..' in parts
                or stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1)


def zip_pages(original, directory, models, progress, deadline, max_edge=2400):
    records, gaps, inventory = [], [], []
    with zipfile.ZipFile(original) as archive:
        infos = sorted((i for i in archive.infolist() if not i.is_dir()), key=lambda i: natural_name(i.filename))
        total_bytes = sum(i.file_size for i in infos)
        if len(infos) > 10000 or total_bytes > 256 * 1024**2:
            return [], [{'reason': 'archive_byte_or_entry_ceiling', 'uncompressed_bytes': total_bytes}], [], len(infos)
        for number, entry in enumerate(infos, 1):
            if time.monotonic() > deadline:
                gaps.append({'reason': 'document_deadline', 'unattempted_members': len(infos) - number + 1}); break
            slot = directory / f'page-{number:04d}'; slot.mkdir(parents=True, exist_ok=True, mode=0o700)
            inventory.append({'member': entry.filename, 'bytes': entry.file_size, 'crc32': entry.CRC})
            if (not safe_member(entry) or entry.file_size > 8 * 1024**2
                    or entry.file_size > max(entry.compress_size, 1) * 100):
                gaps.append({'member': entry.filename, 'reason': 'unsafe_encrypted_or_member_byte_ratio_ceiling'}); continue
            cached = cache_read(slot)
            if cached:
                records.append(cached); progress({'page': number, 'kind': 'archive', 'cached': True}); continue
            try:
                # Reads CRC-verified bytes; never extracts original paths/code.
                data = archive.read(entry)
                if len(data) != entry.file_size: raise ValueError('Archive member size changed')
                suffix = Path(entry.filename).suffix.lower()
                record = {'member': entry.filename, 'member_sha256': hashlib.sha256(data).hexdigest(), 'crc_checked': True, 'gaps': []}
                if suffix in IMAGE_SUFFIXES:
                    from PIL import Image
                    with Image.open(io.BytesIO(data)) as image:
                        if image.width * image.height > 80_000_000: raise ValueError('Archive image pixel ceiling')
                        record['original_image_size'] = list(image.size)
                        image.draft('RGB', (max_edge, max_edge))
                        image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
                        image = image.convert('RGB')
                        target = slot / 'render.png'; image.save(target)
                        record.update(image_path=str(target), image_sha256=sha(target), raster_size=list(image.size))
                    text, meta = ocr(target, slot, models); record.update(meta)
                    record['gaps'].append({'reason': 'OCR_not_glyph_complete_or_visual_semantics_verified'})
                    if not text.strip(): record['gaps'].append({'reason': 'blank_or_unreadable_after_offline_OCR'})
                elif suffix in TEXT_SUFFIXES or Path(entry.filename).name.lower() in {'readme','license','makefile','dockerfile'}:
                    text = data.decode('utf-8'); record['method'] = 'archive_utf8_text'
                else:
                    gaps.append({'member': entry.filename, 'reason': 'binary_member_unsupported'}); continue
                records.append(finish_page(slot, number, text, record))
            except (UnicodeError, ValueError, zipfile.BadZipFile, subprocess.SubprocessError, OSError) as error:
                gaps.append({'member': entry.filename, 'reason': type(error).__name__})
            progress({'page': number, 'kind': 'archive', 'total': len(infos), 'text_pages': len(records)})
    return records, gaps, inventory, len(infos)


def extract(original, directory, expected_sha256, models=None, progress=lambda event: None, seconds=1800):
    original, directory = Path(original), Path(directory)
    if not original.is_file() or original.is_symlink() or sha(original) != expected_sha256:
        raise ValueError('Original SHA/path changed; no extraction')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if shutil.disk_usage(directory).free < 3 * 1024**3: raise ValueError('Mac free-space reserve unavailable')
    signature = {'policy': POLICY, 'original_sha256': expected_sha256, 'max_raster_edge': 2400, 'archive_bytes_ceiling': 256 * 1024**2}
    signature_path = directory / 'identity.json'
    stable(signature_path, json.dumps(signature, sort_keys=True))
    previous = directory / 'extraction.json'
    if previous.exists():
        result = json.loads(previous.read_text(encoding='utf-8'))
        if result['original_sha256'] != expected_sha256 or sha(result['text_path']) != result['text_sha256']:
            raise ValueError('Prepared extraction identity/hash changed')
        for page in result['pages']: cache_read(Path(page['text_path']).parent)
        return result
    deadline = time.monotonic() + seconds
    records, gaps, inventory = [], [], []
    if original.suffix.lower() == '.pdf':
        info = run(['pdfinfo', str(original)], 30)
        match = re.search(rb'^Pages:\s*(\d+)', info.stdout, re.M)
        if not match: raise ValueError('PDF page inventory unreadable')
        count = int(match.group(1))
        if count > 512:
            gaps.append({'reason': 'PDF_page_ceiling', 'pages_total': count})
        else:
            for number in range(1, count + 1):
                if time.monotonic() > deadline:
                    gaps.append({'reason': 'document_deadline', 'unattempted_pages': count - number + 1}); break
                try: records.append(pdf_page(original, number, directory / f'page-{number:04d}', models))
                except (UnicodeError, ValueError, subprocess.SubprocessError, OSError) as error:
                    gaps.append({'page': number, 'reason': type(error).__name__})
                progress({'page': number, 'kind': 'pdf', 'total': count, 'text_pages': len(records)})
    elif original.suffix.lower() == '.zip':
        records, gaps, inventory, count = zip_pages(original, directory, models, progress, deadline)
    else:
        raise ValueError('This TG repair entrypoint accepts PDF/ZIP, not media/exec/other formats')
    for page in records:
        gaps.extend({**gap, 'page': page['page'], **({'member':page['member']} if 'member' in page else {})} for gap in page.get('gaps', []))
    text = '\n\n'.join(('[Archive member ' + p['member'] + ']' if 'member' in p else '[PDF page ' + str(p['page']) + ']') + '\n' + Path(p['text_path']).read_text(encoding='utf-8') for p in records)
    if len(text.encode('utf-8')) > 32 * 1024**2: raise ValueError('Document text byte ceiling')
    target = stable(directory / 'full.txt', text)
    result = {'policy': POLICY, 'original_sha256': expected_sha256, 'original_path': str(original),
        'state': 'original_verified_text_partial' if gaps or len(records) != count or not text.strip() else 'text_extracted_complete',
        'pages_total': count, 'pages_attempted': len(records) + len([g for g in gaps if g.get('reason') in {'TimeoutExpired','CalledProcessError','UnicodeDecodeError','ValueError','OSError'}]),
        'pages_extracted': sum(bool(p['chars']) for p in records), 'chars': len(text), 'pages': records, 'gaps': gaps,
        'archive_inventory': inventory, 'text_path': str(target), 'text_sha256': sha(target),
        'extraction_method': 'bounded_native_pdf_plus_offline_OCR' if original.suffix.lower() == '.pdf' else 'bounded_archive_text_and_image_OCR',
        'paid_calls': 0, 'network_calls': 0, 'original_deleted': False,
        'limitations': ['OCR is not guaranteed glyph-complete; handwriting/math/figures are not semantically interpreted.'] if any(p.get('method') == 'offline_tesseract_rus_eng' for p in records) else []}
    if sha(original) != expected_sha256: raise ValueError('Original changed during extraction; no publication')
    stable(previous, json.dumps(result, ensure_ascii=False, sort_keys=True))
    return result
