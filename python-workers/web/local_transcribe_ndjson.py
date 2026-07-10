#!/usr/bin/env python3
"""Streaming local-file transcript runner for SC Desktop.

Mirrors yt_single_ndjson.py event shape so the renderer can reuse the same
`yt`-style stage/transcribing/done/error UI for files pasted from disk.

Events:
  {"type": "info",            "message": "..."}
  {"type": "file",            "path": "...", "name": "...", "size_bytes": N, "duration_sec": N}
  {"type": "transcribe_start","engine": "gemini"|"assemblyai"|"soniox"}
  {"type": "transcribe_done", "engine": "...", "chars": 4321, "cost_usd": 0.0028}
  {"type": "saved",           "file_path": "...", "srt_path": "...", "kind": "ai"}
  {"type": "error",           "message": "..."}
  {"type": "done",            "duration_sec": 4.2}

Usage:
  local_transcribe_ndjson.py <path> --out-dir <dir> [--engine gemini|assemblyai|soniox] [--timings]
"""
import sys
import os
import io
import re
import json
import time
import uuid
import argparse
import contextlib
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "shared"))


_REAL_STDOUT = sys.stdout  # captured before silenced() may replace sys.stdout


def emit(event):
    # Always write to the *real* stdout — even when called from inside the
    # `silenced()` block (where sys.stdout is a StringIO). Otherwise progress
    # events emitted by AAI's progress_cb would silently disappear.
    _REAL_STDOUT.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    _REAL_STDOUT.flush()


@contextlib.contextmanager
def silenced():
    """Swallow stdout/stderr from gemini_utils (it prints rich progress)."""
    saved_out, saved_err = sys.stdout, sys.stderr
    try:
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        yield
    finally:
        sys.stdout = saved_out
        sys.stderr = saved_err


def safe_slug(s, max_len=80):
    s = re.sub(r"[^\w\s-]", "", s or "").strip()
    s = re.sub(r"\s+", "_", s)
    return s[:max_len] or "file"


def probe_duration(file_path):
    """ffprobe → seconds (float). 0 if probe fails."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error",
             "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1",
             str(file_path)],
            capture_output=True, text=True, timeout=20,
        )
        if r.returncode == 0 and r.stdout.strip():
            return float(r.stdout.strip())
    except Exception:
        pass
    return 0.0


def write_text_file(out_dir, src_path, body, engine):
    """Save transcript to <out_dir>/<sourceStem>__<engine>.txt."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    src = Path(src_path)
    fpath = out_dir / f"{safe_slug(src.stem)}__{engine}.txt"
    parts = [
        f"# {src.name}",
        f"path: {src}",
        f"source: ai:{engine}",
    ]
    fpath.write_text("\n".join(parts) + "\n\n" + body, encoding="utf-8")
    return str(fpath)


def write_srt_file(out_dir, src_path, tokens, engine):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    src = Path(src_path)
    fpath = out_dir / f"{safe_slug(src.stem)}__{engine}.srt"
    cues = soniox_tokens_to_cues(tokens)
    fpath.write_text(format_srt(cues), encoding="utf-8")
    return str(fpath), len(cues)


def clean_space(s):
    s = re.sub(r"\s+", " ", s or "")
    s = re.sub(r"\s+([,.;:!?…])", r"\1", s)
    return s.strip()


def soniox_tokens_to_words(tokens):
    words = []
    cur = None
    for t in tokens or []:
        if t.get("start_ms") is None or t.get("end_ms") is None:
            continue
        text = str(t.get("text") or "")
        if not text:
            continue
        starts_new = text[:1].isspace() or cur is None
        piece = text.lstrip()
        if not piece:
            continue
        if starts_new and cur:
            cur["text"] = clean_space(cur["text"])
            if cur["text"]:
                words.append(cur)
            cur = None
        if cur is None:
            cur = {
                "text": "",
                "start_ms": int(t["start_ms"]),
                "end_ms": int(t["end_ms"]),
                "confidence_sum": 0.0,
                "token_count": 0,
            }
        cur["text"] += piece
        cur["end_ms"] = int(t["end_ms"])
        cur["confidence_sum"] += float(t.get("confidence") or 0)
        cur["token_count"] += 1
    if cur:
        cur["text"] = clean_space(cur["text"])
        if cur["text"]:
            words.append(cur)
    return words


def soniox_tokens_to_cues(tokens):
    words = soniox_tokens_to_words(tokens)
    groups = []
    group = []

    def close_group():
        nonlocal group
        if group:
            groups.append(group)
            group = []

    for word in words:
        prev = group[-1] if group else None
        if prev:
            gap = int(word["start_ms"]) - int(prev["end_ms"])
            sentence_end = re.search(r"[.!?…]$", prev["text"]) and (gap > 150 or len(group) >= 7)
            long_pause = gap > 1200 and len(group) >= 5
            too_long = (int(word["end_ms"]) - int(group[0]["start_ms"])) > 7200 or len(group) >= 18
            if sentence_end or long_pause or too_long:
                close_group()
        group.append(word)
    close_group()

    cues = []
    for g in groups:
        cues.append({
            "start_ms": int(g[0]["start_ms"]),
            "end_ms": int(g[-1]["end_ms"]),
            "text": clean_space(" ".join(w["text"] for w in g)),
        })
    return cues


def fmt_srt_time(ms):
    ms = max(0, int(round(ms or 0)))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def wrap_subtitle(text, width=52):
    words = clean_space(text).split()
    lines = []
    line = ""
    for word in words:
        if not line:
            line = word
        elif len(line + " " + word) <= width:
            line += " " + word
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return "\n".join(lines)


def format_srt(cues):
    blocks = []
    for i, cue in enumerate(cues, start=1):
        end_ms = cue["end_ms"] + 80
        if i < len(cues):
            end_ms = max(cue["end_ms"], min(end_ms, cues[i]["start_ms"] - 20))
        blocks.append(
            f"{i}\n"
            f"{fmt_srt_time(cue['start_ms'])} --> {fmt_srt_time(end_ms)}\n"
            f"{wrap_subtitle(cue['text'])}\n"
        )
    return "\n".join(blocks)


def read_dotenv_value(path, name):
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                m = re.match(rf"\s*{re.escape(name)}\s*=\s*(.*)\s*$", line)
                if not m:
                    continue
                value = m.group(1).strip()
                if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
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
    return read_dotenv_value(Path.home() / ".noted-terminal" / ".env", "SONIOX_API_KEY")


def http_json(url, *, key, method="GET", body=None, headers=None, timeout=600):
    req_headers = {"Authorization": f"Bearer {key}"}
    if headers:
        req_headers.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"soniox {method} {url} failed {e.code}: {detail}") from e


def soniox_upload_file(file_path, key):
    boundary = "----scdesktop" + uuid.uuid4().hex
    name = Path(file_path).name
    with open(file_path, "rb") as f:
        blob = f.read()
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = urllib.request.Request(
        "https://api.soniox.com/v1/files",
        data=head + blob + tail,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read().decode("utf-8"))["id"]
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"soniox upload failed {e.code}: {detail}") from e


VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".flv", ".wmv", ".3gp"}


def maybe_extract_audio(src):
    if src.suffix.lower() not in VIDEO_EXTS:
        return str(src), None
    tmp = tempfile.TemporaryDirectory(prefix="sc-local-soniox-")
    out = Path(tmp.name) / f"{safe_slug(src.stem)}.m4a"
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-y", "-i", str(src), "-map", "0:a:0", "-c:a", "copy", str(out)],
            capture_output=True, text=True, timeout=120,
        )
        if r.returncode == 0 and out.exists() and out.stat().st_size > 0:
            return str(out), tmp
    except Exception:
        pass
    tmp.cleanup()
    return str(src), None


def transcribe_soniox(src, timings=False):
    key = get_soniox_key()
    if not key:
        return None, "SONIOX_API_KEY not configured", {}

    upload_path, tmp = maybe_extract_audio(src)
    file_id = None
    transcription_id = None
    try:
        emit({"type": "transcribe_progress", "engine": "soniox", "stage": "uploading"})
        file_id = soniox_upload_file(upload_path, key)
        emit({"type": "transcribe_progress", "engine": "soniox", "stage": "processing", "status": "queued"})
        create = http_json(
            "https://api.soniox.com/v1/transcriptions",
            key=key,
            method="POST",
            body={
                "file_id": file_id,
                "model": "stt-async-v5",
                "language_hints": ["ru", "en"],
                "enable_language_identification": True,
                "context": {
                    "terms": [
                        "Codex", "Claude", "JSONL", "MCP", "Rewind", "Input",
                        "Timeline", "Answer", "Fast", "effort", "iOS", "PTY",
                    ]
                },
                "client_reference_id": "sc-desktop-local-file",
            },
            timeout=120,
        )
        transcription_id = create["id"]
        attempt = 0
        while True:
            attempt += 1
            time.sleep(1 if attempt < 30 else 3)
            poll = http_json(
                f"https://api.soniox.com/v1/transcriptions/{transcription_id}",
                key=key,
                timeout=120,
            )
            status = poll.get("status")
            emit({"type": "transcribe_progress", "engine": "soniox", "stage": "processing",
                  "status": status, "attempt": attempt})
            if status == "completed":
                break
            if status == "error":
                return None, "Soniox error: " + (poll.get("error_message") or "unknown"), {}
            if attempt > 600:
                return None, "Soniox poll timeout (>30 min)", {}

        emit({"type": "transcribe_progress", "engine": "soniox", "stage": "fetching"})
        transcript = http_json(
            f"https://api.soniox.com/v1/transcriptions/{transcription_id}/transcript",
            key=key,
            timeout=120,
        )
        tokens = transcript.get("tokens") or []
        text = clean_space("".join(str(t.get("text") or "") for t in tokens))
        return text, None, {"tokens": tokens if timings else [], "token_count": len(tokens)}
    finally:
        if transcription_id:
            try:
                http_json(f"https://api.soniox.com/v1/transcriptions/{transcription_id}", key=key, method="DELETE", timeout=30)
            except Exception:
                pass
        if file_id:
            try:
                http_json(f"https://api.soniox.com/v1/files/{file_id}", key=key, method="DELETE", timeout=30)
            except Exception:
                pass
        if tmp:
            tmp.cleanup()


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="Absolute path to audio/video file")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--engine", default="assemblyai", choices=("gemini", "assemblyai", "soniox"))
    ap.add_argument("--timings", action="store_true", help="Create an SRT file when the engine supports timings")
    args = ap.parse_args(argv)

    t0 = time.time()
    src = Path(os.path.expanduser(args.path))
    if not src.exists():
        emit({"type": "error", "message": f"file not found: {src}"})
        return 2
    if not src.is_file():
        emit({"type": "error", "message": f"not a file: {src}"})
        return 2

    try:
        size = src.stat().st_size
    except Exception:
        size = 0
    duration = probe_duration(src)

    emit({
        "type": "file",
        "path": str(src),
        "name": src.name,
        "size_bytes": size,
        "duration_sec": int(round(duration)) if duration else 0,
    })

    emit({"type": "transcribe_start", "engine": args.engine})

    text, err, cost, extra = None, None, 0.0, {}
    try:
        if args.engine == "soniox":
            text, err, extra = transcribe_soniox(src, timings=args.timings)
        else:
            # AssemblyAI doesn't need GEMINI_API_KEY but the GeminiClient
            # constructor requires it unconditionally. Inject a placeholder
            # so the class instantiates — assembly path won't ever call Gemini.
            if args.engine == "assemblyai" and not os.environ.get("GEMINI_API_KEY"):
                os.environ["GEMINI_API_KEY"] = "unused-by-assemblyai"
            # AAI progress: emit per-poll status so the UI can show
            # "uploading → queued → transcribing M:SS / ~ETA". Without this
            # the user sees one frozen spinner for hour-long files.
            def _aai_progress(stage, **kw):
                payload = {"type": "transcribe_progress", "engine": args.engine, "stage": stage}
                payload.update(kw)
                emit(payload)
            with silenced():
                import gemini_utils
                client = gemini_utils.GeminiClient()
                text, err = client.transcribe_audio(
                    str(src),
                    engine=args.engine,
                    progress_cb=_aai_progress if args.engine == "assemblyai" else None,
                )
                cost = client.calculate_cost() if args.engine == "gemini" else 0.0
    except Exception as ex:
        emit({"type": "error", "message": f"transcribe crashed: {type(ex).__name__}: {ex}"})
        return 4

    if err or not text:
        emit({"type": "error", "message": f"transcribe failed: {err or 'empty result'}"})
        return 4

    cost_r = round(float(cost or 0), 6)
    emit({"type": "transcribe_done", "engine": args.engine,
          "chars": len(text), "cost_usd": cost_r})

    fpath = write_text_file(args.out_dir, str(src), text, args.engine)
    srt_path = None
    srt_cues = 0
    if args.timings and args.engine == "soniox" and extra.get("tokens"):
        srt_path, srt_cues = write_srt_file(args.out_dir, str(src), extra["tokens"], args.engine)
    emit({"type": "saved", "file_path": fpath, "kind": "ai",
          "chars": len(text), "cost_usd": cost_r,
          "timings": bool(srt_path), "srt_path": srt_path,
          "srt_cues": srt_cues, "token_count": extra.get("token_count")})
    emit({"type": "done", "duration_sec": round(time.time() - t0, 2)})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(130)
    except Exception as ex:
        emit({"type": "error", "message": f"{type(ex).__name__}: {ex}"})
        sys.exit(1)
