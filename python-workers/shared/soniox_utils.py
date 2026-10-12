"""Shared Soniox async transcription client for SC Desktop workers.

The local-file and Telegram-live flows both submit one already-selected media
file.  Keeping the provider client here prevents Telegram from depending on a
different executable worker and lets the owning job keep progress/cancellation
under one process.
"""

from __future__ import annotations

import json
import http.client
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid
from pathlib import Path


VIDEO_EXTENSIONS = {
    ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".flv", ".wmv", ".3gp",
}


def clean_transcript_text(value):
    text = re.sub(r"\s+", " ", str(value or ""))
    text = re.sub(r"\s+([,.;:!?…])", r"\1", text)
    return text.strip()


def _safe_slug(value, max_len=80):
    text = re.sub(r"[^\w\s-]", "", str(value or "")).strip()
    text = re.sub(r"\s+", "_", text)
    return text[:max_len] or "file"


def _read_dotenv_value(path, name):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                match = re.match(rf"\s*{re.escape(name)}\s*=\s*(.*?)\s*$", line)
                if not match:
                    continue
                value = match.group(1).strip()
                if ((value.startswith('"') and value.endswith('"'))
                        or (value.startswith("'") and value.endswith("'"))):
                    value = value[1:-1]
                return value.strip() or None
    except OSError:
        return None
    return None


def get_soniox_key():
    key = os.environ.get("SONIOX_API_KEY")
    if key:
        return key.strip()
    try:
        import settings
        key = settings.get_api_key("SONIOX_API_KEY")
        if key:
            return key.strip()
    except Exception:
        pass
    return _read_dotenv_value(
        Path.home() / ".noted-terminal" / ".env",
        "SONIOX_API_KEY",
    )


def http_json(url, *, key, method="GET", body=None, headers=None, timeout=600):
    request_headers = {"Authorization": f"Bearer {key}"}
    if headers:
        request_headers.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url,
        data=data,
        headers=request_headers,
        method=method,
    )
    attempts = 3 if method == "GET" else 1
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(
                f"soniox {method} {url} failed {error.code}: {detail}"
            ) from error
        except (http.client.IncompleteRead, urllib.error.URLError, ConnectionError, TimeoutError):
            if attempt+1 >= attempts:
                # Some native HTTP/1 responses repeatedly end around 64KiB.
                # A second transport may GET the same complete provider JSON,
                # never another upload/create. Keep credentials out of argv.
                if method == "GET" and body is None:
                    recovered = _curl_json_get(url, request_headers, timeout)
                    if recovered is not None:
                        return recovered
                raise
            time.sleep(0.2*(attempt+1))


def _curl_json_get(url, headers, timeout):
    """One bounded GET-only fallback; no redirect, curlrc or paid retry."""
    parsed = urlsplit(url)
    executable = shutil.which("curl")
    if (not executable or parsed.scheme != "https" or parsed.hostname != "api.soniox.com"
            or parsed.username is not None or parsed.password is not None
            or parsed.port not in (None, 443) or parsed.fragment):
        return None
    for name, value in headers.items():
        if not re.fullmatch(r"[A-Za-z0-9-]+", name) or any(c in str(value) for c in "\r\n\x00"):
            raise RuntimeError("soniox GET fallback headers are invalid")
    # JSON quoting is compatible with curl's quoted config strings for these
    # validated values. Only stdin contains the private authorization header.
    config = "url = " + json.dumps(url) + "\nrequest = \"GET\"\n"
    config += "".join("header = " + json.dumps(name + ": " + str(value)) + "\n"
                      for name, value in headers.items())
    deadline = max(1, min(float(timeout), 60))
    result = subprocess.run([
        executable, "--disable", "--config", "-", "--http2", "--compressed",
        "--silent", "--show-error", "--fail-with-body", "--proto", "=https",
        "--connect-timeout", str(min(15, deadline)), "--max-time", str(deadline),
    ], input=config.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=deadline + 5, check=False)
    if result.returncode:
        # Do not include raw provider output/stderr/config in logs or NDJSON.
        raise RuntimeError(f"soniox GET alternate transport failed (curl {result.returncode})")
    try:
        payload = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeError, ValueError) as error:
        raise RuntimeError("soniox GET alternate transport returned incomplete/invalid JSON") from error
    if not isinstance(payload, dict):
        raise RuntimeError("soniox GET alternate transport returned a non-object response")
    transcript = re.fullmatch(r"/v1/transcriptions/([^/]+)/transcript", parsed.path)
    if transcript and (payload.get("id") != transcript.group(1)
                       or not isinstance(payload.get("text"), str)
                       or not isinstance(payload.get("tokens"), list)):
        raise RuntimeError("soniox GET alternate transcript identity/shape mismatch")
    print(f"[soniox] alternate GET complete bytes={len(result.stdout)}", file=sys.stderr)
    return payload


def upload_file(file_path, key):
    boundary = "----scdesktop" + uuid.uuid4().hex
    name = Path(file_path).name
    with open(file_path, "rb") as handle:
        blob = handle.read()
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    request = urllib.request.Request(
        "https://api.soniox.com/v1/files",
        data=head + blob + tail,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            return json.loads(response.read().decode("utf-8"))["id"]
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(
            f"soniox upload failed {error.code}: {detail}"
        ) from error


def prepare_upload_file(source, *, temporary_dir=None):
    """Return (upload_path, temporary_directory_or_none).

    Soniox accepts common video containers directly.  Copying the audio stream
    first merely avoids uploading the picture track when ffmpeg can do that
    losslessly; failure safely falls back to the original selected file.
    """
    source = Path(source)
    if source.suffix.lower() not in VIDEO_EXTENSIONS:
        return str(source), None
    temporary = tempfile.TemporaryDirectory(prefix="sc-soniox-", dir=temporary_dir)
    output = Path(temporary.name) / f"{_safe_slug(source.stem)}.m4a"
    try:
        completed = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-y", "-i", str(source),
                "-map", "0:a:0", "-c:a", "copy", str(output),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if completed.returncode == 0 and output.exists() and output.stat().st_size > 0:
            return str(output), temporary
    except Exception:
        pass
    temporary.cleanup()
    return str(source), None


def _normalise_language_hints(values):
    hints = []
    for value in values or ["ru", "en"]:
        hint = str(value or "").strip().lower()
        if not hint or hint in hints:
            continue
        hints.append(hint[:16])
        if len(hints) >= 5:
            break
    return hints or ["ru", "en"]


def _context_payload(*, text=None, terms=None, general=None):
    payload = {}
    clean_text = str(text or "").strip()
    if clean_text:
        payload["text"] = clean_text[:8000]
    clean_terms = []
    for value in terms or []:
        term = str(value or "").strip()
        if term and term not in clean_terms:
            clean_terms.append(term[:200])
        if len(clean_terms) >= 100:
            break
    if clean_terms:
        payload["terms"] = clean_terms
    clean_general = []
    for item in general or []:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()[:80]
        value = str(item.get("value") or "").strip()[:500]
        if key and value:
            clean_general.append({"key": key, "value": value})
        if len(clean_general) >= 20:
            break
    if clean_general:
        payload["general"] = clean_general
    return payload or None


def transcribe_file(
    source,
    *,
    timings=False,
    language_hints=None,
    context_text=None,
    context_terms=None,
    context_general=None,
    client_reference_id="sc-desktop",
    progress_callback=None,
    api_key=None,
    sleep=time.sleep,
    checkpoint=None,
    temporary_dir=None,
):
    """Transcribe one local audio/video file with Soniox async STT.

    Returns ``(text, error, details)``. Provider file and transcription objects
    are deleted best-effort in every terminal path. ``progress_callback`` gets
    keyword arguments ``stage``, and optionally ``status``/``attempt``.
    """
    def progress(stage, **extra):
        if progress_callback:
            progress_callback(stage=stage, **extra)

    state = checkpoint.load() if checkpoint else {}
    if state.get("state") == "completed":
        return state.get("text", ""), None, state.get("details", {})
    if checkpoint and ((state.get("state") == "uploading" and not state.get("file_id")) or
                       (state.get("state") == "creating" and not state.get("transcription_id"))):
        error = RuntimeError("Soniox delivery unknown; recover the original attempt, do not upload/create again")
        error.code = "media_delivery_unknown"
        raise error
    if state.get("state") == "external_processing" or (state and state.get("engine") not in (None, "soniox") and state.get("state") != "completed"):
        error = RuntimeError("Original ASR attempt belongs to another engine; do not create a new Soniox request")
        error.code = "media_delivery_unknown"
        raise error
    key = (api_key or get_soniox_key() or "").strip()
    if not key:
        return None, "SONIOX_API_KEY not configured", {}
    file_id = state.get("file_id")
    transcription_id = state.get("transcription_id")
    temporary = None
    completed_saved = False
    def save_state(**updates):
        nonlocal state
        state = {**state, **updates}
        if checkpoint:
            checkpoint.save(state)
    try:
        if not file_id and not transcription_id:
            upload_path, temporary = (prepare_upload_file(source) if temporary_dir is None
                                      else prepare_upload_file(source, temporary_dir=temporary_dir))
            save_state(state="uploading")
            progress("uploading")
            try:
                file_id = upload_file(upload_path, key)
            except Exception as failure:
                if checkpoint:
                    error = RuntimeError("Soniox upload outcome is unknown; recover the original checkpoint before another upload")
                    error.code = "media_delivery_unknown"
                    raise error from failure
                raise
            save_state(state="uploaded", file_id=file_id)
        progress("processing", status="queued", attempt=0)
        request_body = {
            "file_id": file_id,
            "model": "stt-async-v5",
            "language_hints": _normalise_language_hints(language_hints),
            "enable_language_identification": True,
            "client_reference_id": str(client_reference_id or "sc-desktop")[:256],
        }
        context = _context_payload(
            text=context_text,
            terms=context_terms,
            general=context_general,
        )
        if context:
            request_body["context"] = context
        if not transcription_id:
            save_state(state="creating", file_id=file_id)
            try:
                created = http_json(
                    "https://api.soniox.com/v1/transcriptions",
                    key=key, method="POST", body=request_body, timeout=120,
                )
                transcription_id = created["id"]
                if not transcription_id:
                    raise RuntimeError("Soniox create returned no provider id")
            except Exception as failure:
                if checkpoint:
                    error = RuntimeError("Soniox create outcome is unknown; recover the original checkpoint before another create")
                    error.code = "media_delivery_unknown"
                    raise error from failure
                raise
            save_state(state="processing", transcription_id=transcription_id)
        attempt = 0
        while True:
            attempt += 1
            sleep(1 if attempt < 30 else 3)
            polled = http_json(
                f"https://api.soniox.com/v1/transcriptions/{transcription_id}",
                key=key,
                timeout=120,
            )
            status = polled.get("status")
            progress("processing", status=status, attempt=attempt)
            if status == "completed":
                break
            if status == "error":
                return None, "Soniox error: " + (
                    polled.get("error_message") or "unknown"
                ), {}
            if attempt > 600:
                return None, "Soniox poll timeout (>30 min)", {}

        progress("fetching")
        transcript = http_json(
            f"https://api.soniox.com/v1/transcriptions/{transcription_id}/transcript",
            key=key,
            timeout=120,
        )
        tokens = transcript.get("tokens") or []
        text = clean_transcript_text(
            "".join(str(token.get("text") or "") for token in tokens)
        )
        details = {
            "tokens": tokens if timings else [],
            "token_count": len(tokens),
            "model": "stt-async-v5",
            "result_status": "transcribed" if text.strip() else "no_speech",
        }
        save_state(state="completed", text=text, details=details, result_status=details["result_status"])
        completed_saved = True
        return text, None, details
    finally:
        if transcription_id and (checkpoint is None or completed_saved):
            try:
                http_json(
                    f"https://api.soniox.com/v1/transcriptions/{transcription_id}",
                    key=key,
                    method="DELETE",
                    timeout=30,
                )
            except Exception:
                pass
        if file_id and (checkpoint is None or completed_saved):
            try:
                http_json(
                    f"https://api.soniox.com/v1/files/{file_id}",
                    key=key,
                    method="DELETE",
                    timeout=30,
                )
            except Exception:
                pass
        if temporary:
            temporary.cleanup()
