#!/usr/bin/env python3
"""Streaming local-file transcript runner for SC Desktop.

Mirrors yt_single_ndjson.py event shape so the renderer can reuse the same
`yt`-style stage/transcribing/done/error UI for files pasted from disk.

Events:
  {"type": "info",            "message": "..."}
  {"type": "file",            "path": "...", "name": "...", "size_bytes": N, "duration_sec": N}
  {"type": "transcribe_start","engine": "gemini"|"assemblyai"}
  {"type": "transcribe_done", "engine": "...", "chars": 4321, "cost_usd": 0.0028}
  {"type": "saved",           "file_path": "...", "kind": "ai"}
  {"type": "error",           "message": "..."}
  {"type": "done",            "duration_sec": 4.2}

Usage:
  local_transcribe_ndjson.py <path> --out-dir <dir> [--engine gemini|assemblyai]
"""
import sys
import os
import io
import re
import json
import time
import argparse
import contextlib
import subprocess
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


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="Absolute path to audio/video file")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--engine", default="assemblyai", choices=("gemini", "assemblyai"))
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

    text, err, cost = None, None, 0.0
    try:
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
    emit({"type": "saved", "file_path": fpath, "kind": "ai",
          "chars": len(text), "cost_usd": cost_r})
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
