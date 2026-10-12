"""Materialise exactly one Telegram attachment into SC Desktop's cache.

The live search/context/range worker stays metadata-only.  This module is used
only by the explicit attachment operation and therefore never walks a chat or
downloads neighbouring messages.
"""

from __future__ import annotations

import mimetypes
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from tg_message_payload import (
    TEXT_DOCUMENT_MAX_BYTES,
    is_pdf_attachment,
    is_text_attachment,
    read_text_attachment,
)


DEFAULT_MAX_BYTES = 100 * 1024 * 1024
MAX_ALLOWED_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_MAX_TEXT_CHARS = 200_000
MAX_TEXT_CHARS = 1_000_000
CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
CACHE_MAX_BYTES = 1024 * 1024 * 1024
CACHE_MAX_FILES = 500

_IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".avif", ".svg",
}

_AUDIO_EXTENSIONS = {
    ".aac", ".aiff", ".amr", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav", ".wma",
}

_VIDEO_EXTENSIONS = {
    ".3gp", ".avi", ".flv", ".m4v", ".mkv", ".mov", ".mp4", ".webm", ".wmv",
}

_MIME_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/svg+xml": ".svg",
    "audio/ogg": ".oga",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
}


def library_root():
    override = os.environ.get("SC_DESKTOP_DIR") or os.environ.get("MEDIA_INBOX_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return (Path.home() / "Library" / "Application Support" / "sc-desktop").resolve()


def attachment_cache_root():
    return library_root() / "cache" / "telegram-live-attachments"


def safe_file_name(value, fallback="attachment"):
    raw = Path(str(value or "")).name
    raw = re.sub(r"[\x00-\x1f\x7f/:\\]+", "_", raw).strip(" .")
    if not raw:
        raw = fallback
    suffix = Path(raw).suffix
    stem = raw[:-len(suffix)] if suffix else raw
    max_stem = max(1, 140 - len(suffix))
    return f"{stem[:max_stem]}{suffix[:20]}"


def effective_content_type(attachment, file_path=None):
    declared = str((attachment or {}).get("content_type") or "").split(";", 1)[0].strip().lower()
    path = Path(file_path) if file_path else Path(str((attachment or {}).get("file_name") or ""))
    try:
        with path.open("rb") as handle:
            head = handle.read(32)
        if head.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if head.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if head.startswith((b"GIF87a", b"GIF89a")):
            return "image/gif"
        if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
            return "image/webp"
        if head.startswith(b"%PDF-"):
            return "application/pdf"
    except Exception:
        pass
    if declared:
        return declared
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def attachment_content_kind(attachment, file_path=None):
    content_type = effective_content_type(attachment, file_path)
    path = Path(file_path) if file_path else Path(str((attachment or {}).get("file_name") or ""))
    suffix = path.suffix.lower()
    if content_type.startswith("image/") or suffix in _IMAGE_EXTENSIONS:
        return "image"
    if content_type.startswith("audio/") or suffix in _AUDIO_EXTENSIONS:
        return "audio"
    if content_type.startswith("video/") or suffix in _VIDEO_EXTENSIONS:
        return "video"
    enriched = {**(attachment or {}), "content_type": content_type, "file_name": path.name}
    if is_pdf_attachment(enriched):
        return "pdf"
    if is_text_attachment(enriched):
        return "text"
    return "binary"


def _fallback_name(message_id, attachment):
    content_type = str((attachment or {}).get("content_type") or "").lower()
    suffix = _MIME_EXTENSIONS.get(content_type)
    if not suffix:
        suffix = mimetypes.guess_extension(content_type) if content_type else None
    return f"attachment-{int(message_id)}{suffix or ''}"


def cache_path_for(chat_id, message_id, attachment):
    original = (attachment or {}).get("file_name")
    name = safe_file_name(original, _fallback_name(message_id, attachment))
    return attachment_cache_root() / str(int(chat_id)) / str(int(message_id)) / f"{int(message_id)}-{name}"


def _inside(root, path):
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
        return True
    except Exception:
        return False


def prune_attachment_cache(*, keep_path=None):
    """Best-effort age/count/byte pruning. The selected result is never pruned."""
    root = attachment_cache_root()
    if not root.exists():
        return
    keep = Path(keep_path).resolve() if keep_path else None
    now = time.time()
    files = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        resolved = path.resolve()
        if keep is not None and resolved == keep:
            continue
        if ".part-" in path.name:
            if now - stat.st_mtime > 60 * 60:
                try:
                    path.unlink()
                except OSError:
                    pass
            # A fresh partial belongs to another live attachment job. Never
            # count/prune it from this process; its owner or the 1h sweep does.
            continue
        if now - stat.st_mtime > CACHE_TTL_SECONDS:
            try:
                path.unlink()
            except OSError:
                pass
            continue
        files.append((stat.st_mtime, stat.st_size, path))

    files.sort(key=lambda row: row[0], reverse=True)
    kept_bytes = 0
    kept_count = 0
    for _, size, path in files:
        if kept_count >= CACHE_MAX_FILES or kept_bytes + size > CACHE_MAX_BYTES:
            try:
                path.unlink()
            except OSError:
                pass
            continue
        kept_count += 1
        kept_bytes += size

    for directory in sorted((p for p in root.rglob("*") if p.is_dir()), reverse=True):
        try:
            directory.rmdir()
        except OSError:
            pass


def cleanup_current_process_parts():
    """Remove only partial downloads owned by this worker PID."""
    root = attachment_cache_root()
    if not root.exists():
        return
    suffix = f".part-{os.getpid()}"
    for path in root.rglob(f"*{suffix}"):
        try:
            if path.is_file() and _inside(root, path):
                path.unlink()
        except OSError:
            pass


def _trim_text(text, max_chars):
    value = str(text or "").replace("\x00", "").strip()
    if len(value) <= max_chars:
        return value, False
    return value[:max_chars] + "\n\n[текст обрезан безопасным лимитом MCP]", True


def extract_pdf_text(file_path, *, max_chars=DEFAULT_MAX_TEXT_CHARS):
    candidates = [
        shutil.which("pdftotext"),
        "/opt/homebrew/bin/pdftotext",
        "/usr/local/bin/pdftotext",
    ]
    executable = next((value for value in candidates if value and Path(value).is_file()), None)
    if not executable:
        return None, {
            "status": "file_only",
            "engine": None,
            "limitation": "pdftotext is unavailable; inspect the returned local PDF file directly",
        }
    try:
        completed = subprocess.run(
            [executable, "-layout", str(file_path), "-"],
            capture_output=True,
            timeout=60,
            check=False,
        )
    except Exception as error:
        return None, {
            "status": "file_only",
            "engine": "pdftotext",
            "limitation": f"PDF text extraction failed: {type(error).__name__}: {error}",
        }
    if completed.returncode != 0:
        error = completed.stderr.decode("utf-8", errors="replace").strip()
        return None, {
            "status": "file_only",
            "engine": "pdftotext",
            "limitation": f"PDF text extraction failed: {error or f'exit {completed.returncode}'}",
        }
    text, truncated = _trim_text(completed.stdout.decode("utf-8", errors="replace"), max_chars)
    if not text:
        return None, {
            "status": "file_only",
            "engine": "pdftotext",
            "limitation": "PDF has no extractable text (it may be scanned); inspect the returned local file/pages",
        }
    return text, {
        "status": "extracted",
        "engine": "pdftotext",
        "chars": len(text),
        "truncated": truncated,
        "limitation": None,
    }


def extract_attachment_content(file_path, attachment, *, max_text_chars=DEFAULT_MAX_TEXT_CHARS):
    max_text_chars = max(1, min(MAX_TEXT_CHARS, int(max_text_chars or DEFAULT_MAX_TEXT_CHARS)))
    content_type = effective_content_type(attachment, file_path)
    kind = attachment_content_kind({**(attachment or {}), "content_type": content_type}, file_path)
    if kind == "image":
        return kind, content_type, None, {
            "status": "mcp_image",
            "engine": None,
            "chars": 0,
            "truncated": False,
            "limitation": None,
        }
    if kind == "text":
        text, truncated = read_text_attachment(
            file_path,
            max_bytes=TEXT_DOCUMENT_MAX_BYTES,
            max_chars=max_text_chars,
        )
        return kind, content_type, text, {
            "status": "extracted",
            "engine": "local-text",
            "chars": len(text),
            "truncated": truncated,
            "limitation": None,
        }
    if kind == "pdf":
        text, extraction = extract_pdf_text(file_path, max_chars=max_text_chars)
        return kind, content_type, text, extraction
    if kind in {"audio", "video"}:
        return kind, content_type, None, {
            "status": "file_only",
            "engine": None,
            "chars": 0,
            "truncated": False,
            "limitation": (
                f"{kind} content is available at file_path; "
                "call telegram_live_transcribe to obtain text"
            ),
        }
    return kind, content_type, None, {
        "status": "file_only",
        "engine": None,
        "chars": 0,
        "truncated": False,
        "limitation": "unsupported binary format; the original file is available at file_path but no text was claimed",
    }


async def materialize_message_attachment(
    message,
    *,
    chat_id,
    message_id,
    attachment,
    max_bytes=DEFAULT_MAX_BYTES,
    max_text_chars=DEFAULT_MAX_TEXT_CHARS,
    progress_callback=None,
):
    max_bytes = max(1, min(MAX_ALLOWED_BYTES, int(max_bytes or DEFAULT_MAX_BYTES)))
    expected = (attachment or {}).get("bytes")
    if expected is not None and int(expected) > max_bytes:
        return {
            **(attachment or {}),
            "file_path": None,
            "downloaded": False,
            "cached": False,
            "content_kind": attachment_content_kind(attachment),
            "extracted_text": None,
            "extraction": {
                "status": "blocked",
                "engine": None,
                "chars": 0,
                "truncated": False,
                "limitation": f"attachment is {int(expected)} bytes; max_bytes is {max_bytes}",
            },
        }

    root = attachment_cache_root()
    final_path = cache_path_for(chat_id, message_id, attachment)
    prune_attachment_cache(keep_path=final_path)
    final_path.parent.mkdir(parents=True, exist_ok=True)

    cached = False
    if final_path.is_file():
        try:
            actual = final_path.stat().st_size
            cached = expected is None or int(expected) == actual
        except OSError:
            cached = False
        if not cached:
            try:
                final_path.unlink()
            except OSError:
                pass

    part_path = final_path.with_name(f"{final_path.name}.part-{os.getpid()}")
    if not cached:
        if part_path.exists():
            try:
                part_path.unlink()
            except OSError:
                pass

        def on_progress(current, total):
            if current > max_bytes:
                raise RuntimeError(f"attachment exceeded max_bytes={max_bytes}")
            if progress_callback:
                progress_callback(int(current or 0), int(total or expected or 0))

        downloaded_path = None
        try:
            downloaded_path = await message.download_media(
                file=str(part_path),
                progress_callback=on_progress,
            )
            if not downloaded_path:
                raise RuntimeError("Telegram download_media returned no path")
            downloaded_path = Path(downloaded_path).resolve()
            if not _inside(root, downloaded_path):
                raise RuntimeError("Telegram returned an attachment path outside SC Desktop cache")
            actual = downloaded_path.stat().st_size
            if actual > max_bytes:
                raise RuntimeError(f"attachment exceeded max_bytes={max_bytes}")
            os.replace(downloaded_path, final_path)
            # Telethon preserves the Telegram message timestamp on downloaded
            # media. Cache pruning must use materialisation/access time, not
            # the source message's age, otherwise an old message is deleted by
            # the very next attachment request.
            os.utime(final_path, None)
        except Exception:
            for candidate in {part_path, Path(downloaded_path) if downloaded_path else None}:
                if candidate is None:
                    continue
                try:
                    if candidate.exists() and _inside(root, candidate):
                        candidate.unlink()
                except OSError:
                    pass
            raise
    else:
        try:
            os.utime(final_path, None)
        except OSError:
            pass

    actual_bytes = final_path.stat().st_size
    kind, content_type, extracted_text, extraction = extract_attachment_content(
        final_path,
        attachment,
        max_text_chars=max_text_chars,
    )
    prune_attachment_cache(keep_path=final_path)
    return {
        **(attachment or {}),
        "content_type": content_type,
        "bytes": actual_bytes,
        "file_path": str(final_path),
        "downloaded": not cached,
        "cached": cached,
        "content_kind": kind,
        "extracted_text": extracted_text,
        "extraction": extraction,
        "cache_ttl_seconds": CACHE_TTL_SECONDS,
    }


def write_attachment_transcript(file_path, text, *, engine="soniox"):
    """Atomically save a transcript beside its one selected cached media file."""
    root = attachment_cache_root()
    source = Path(file_path).resolve()
    if not source.is_file() or not _inside(root, source):
        raise RuntimeError("Telegram transcript source is outside SC Desktop cache")
    safe_engine = safe_file_name(engine, "transcript").replace(".", "_")
    output = source.with_name(f"{source.stem}__{safe_engine}.txt")
    partial = output.with_name(f"{output.name}.part-{os.getpid()}")
    body = str(text or "").replace("\x00", "").strip()
    try:
        partial.write_text(body + ("\n" if body else ""), encoding="utf-8")
        os.replace(partial, output)
        os.utime(output, None)
    except Exception:
        try:
            if partial.exists() and _inside(root, partial):
                partial.unlink()
        except OSError:
            pass
        raise
    # Keep the selected media itself pinned for this pass. The transcript is
    # fresh and tiny, so the normal TTL/count sweep retains it alongside it.
    prune_attachment_cache(keep_path=source)
    return str(output)
