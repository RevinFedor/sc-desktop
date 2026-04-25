#!/usr/bin/env python3
"""Batch YouTube transcript fetcher for SC Desktop.

Takes N video URLs (or IDs), iterates over them, emits per-video events.
For each video: subs are tried first (free). If absent and --auto-ai is on,
the chosen engine transcribes; otherwise the video is marked skipped.

Events:
  {"type": "info",            "message": "..."}
  {"type": "item_start",      "i": 1, "n": 10, "video_id": "...", "url": "...", "title": "...",
                              "duration_sec": 754, "channel": "..."}
  {"type": "subs_racing",     "i": 1, "video_id": "..."}
  {"type": "subs_found",      "i": 1, "video_id": "...", "lang": "ru", "with_ts": false, "chars": 1234}
  {"type": "subs_missing",    "i": 1, "video_id": "...", "duration_sec": 754, "est_cost_usd": 0.0026}
  {"type": "transcribe_start","i": 1, "video_id": "...", "engine": "gemini"}
  {"type": "transcribe_done", "i": 1, "video_id": "...", "engine": "gemini", "chars": 4321, "cost_usd": 0.0028}
  {"type": "saved",           "i": 1, "video_id": "...", "file_path": "...", "kind": "subs|ai", "chars": N}
  {"type": "skipped",         "i": 1, "video_id": "...", "reason": "no_subs_no_ai"}
  {"type": "item_error",      "i": 1, "video_id": "...", "message": "..."}
  {"type": "error",           "message": "..."}
  {"type": "done",            "items_total": N, "saved": M, "skipped": S, "errors": E,
                              "total_cost_usd": F, "duration_sec": 4.2}

Usage:
  yt_batch_transcribe_ndjson.py
      --videos VID1,VID2,...   (11-char ids OR full URLs)
      --out-dir <dir>
      [--lang ru]
      [--with-ts]
      [--auto-ai]              (default off — skip videos without subs)
      [--engine gemini|assemblyai]   (only if --auto-ai)
"""
import sys
import os
import json
import time
import argparse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))                  # for yt_single_ndjson
sys.path.insert(0, str(HERE.parent / "shared"))  # for gemini_utils

# Reuse the single-video module's helpers — keeping the subs-race / SRT
# parsing / slug / file-writing in one place. We don't reuse stage_subs/
# stage_ai because their emit() calls are single-video-shaped.
from yt_single_ndjson import (   # noqa: E402
    emit as _single_emit,            # not used, but documented
    extract_video_id,
    extract_subtitles,
    fetch_meta,
    silenced,
    write_text_file,
)


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def parse_videos(raw):
    """Accept comma-separated ids/URLs. Each entry → (video_id, normalized_url)."""
    out = []
    for piece in (raw or "").split(","):
        piece = piece.strip()
        if not piece:
            continue
        if len(piece) == 11 and "/" not in piece and not piece.startswith("http"):
            vid = piece
            url = f"https://www.youtube.com/watch?v={vid}"
        else:
            vid = extract_video_id(piece)
            if not vid:
                emit({"type": "info", "message": f"skip non-video input: {piece!r}"})
                continue
            url = piece if piece.startswith("http") else f"https://www.youtube.com/watch?v={vid}"
        out.append((vid, url))
    return out


def process_one(i, n, vid, url, args, totals):
    # ── Per-video metadata ────────────────────────────────────────────────
    with silenced():
        meta, meta_err = fetch_meta(url)
    if not meta or not meta.get("id"):
        emit({"type": "item_error", "i": i, "video_id": vid,
              "message": f"yt-dlp metadata fetch failed: {meta_err or 'no metadata'}"})
        totals["errors"] += 1
        return

    emit({"type": "item_start", "i": i, "n": n,
          "video_id":     meta["id"],
          "url":          meta["webpage_url"],
          "title":        meta["title"],
          "duration_sec": meta["duration_sec"],
          "channel":      meta["channel"]})

    # ── Stage 1: subs ─────────────────────────────────────────────────────
    emit({"type": "subs_racing", "i": i, "video_id": meta["id"]})
    text = None
    try:
        with silenced():
            text = extract_subtitles(url, preferred_lang=args.lang, with_ts=args.with_ts)
    except Exception as ex:
        emit({"type": "item_error", "i": i, "video_id": meta["id"],
              "message": f"subs failed: {type(ex).__name__}: {ex}"})
        totals["errors"] += 1
        return

    if text:
        emit({"type": "subs_found", "i": i, "video_id": meta["id"],
              "lang": args.lang, "with_ts": bool(args.with_ts), "chars": len(text)})
        fpath = write_text_file(args.out_dir, meta["id"], meta["title"], meta["channel"],
                                meta["webpage_url"], text,
                                lang=args.lang, with_ts=args.with_ts)
        emit({"type": "saved", "i": i, "video_id": meta["id"],
              "file_path": fpath, "kind": "subs", "chars": len(text)})
        totals["saved"] += 1
        return

    # ── Stage 2: AI (only if --auto-ai) ───────────────────────────────────
    dur = meta["duration_sec"] or 0
    est = round((dur / 3600.0) * 0.0125, 4) if dur else 0.005
    emit({"type": "subs_missing", "i": i, "video_id": meta["id"],
          "duration_sec": dur, "est_cost_usd": est})

    if not args.auto_ai:
        emit({"type": "skipped", "i": i, "video_id": meta["id"],
              "reason": "no_subs_no_ai"})
        totals["skipped"] += 1
        return

    audio_tmp = f"/tmp/yt_batch_{meta['id']}.mp3"
    try:
        if os.path.exists(audio_tmp):
            os.remove(audio_tmp)
    except Exception:
        pass

    emit({"type": "transcribe_start", "i": i, "video_id": meta["id"], "engine": args.engine})

    import subprocess  # local import — only needed for AI path
    cmd = [
        "yt-dlp",
        "--cookies-from-browser", "firefox",
        "--remote-components", "ejs:github",
        "-x", "--audio-format", "mp3",
        "--audio-quality", "9",
        "--no-warnings",
        "--ignore-errors",
        "-o", audio_tmp,
        url,
    ]
    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=600)
    except subprocess.TimeoutExpired:
        emit({"type": "item_error", "i": i, "video_id": meta["id"],
              "message": "yt-dlp timeout (>10m)"})
        totals["errors"] += 1
        return
    except subprocess.CalledProcessError as ex:
        tail = ex.stderr or b""
        if isinstance(tail, bytes):
            tail = tail.decode(errors="ignore")
        emit({"type": "item_error", "i": i, "video_id": meta["id"],
              "message": f"yt-dlp failed: {tail[-300:].strip()}"})
        totals["errors"] += 1
        return
    if not os.path.exists(audio_tmp):
        emit({"type": "item_error", "i": i, "video_id": meta["id"],
              "message": "audio file missing after download"})
        totals["errors"] += 1
        return

    text2, err, cost = None, None, 0.0
    try:
        with silenced():
            import gemini_utils
            client = gemini_utils.GeminiClient()
            text2, err = client.transcribe_audio(audio_tmp, engine=args.engine)
            cost = client.calculate_cost() if args.engine == "gemini" else 0.0
    except Exception as ex:
        emit({"type": "item_error", "i": i, "video_id": meta["id"],
              "message": f"transcribe crashed: {type(ex).__name__}: {ex}"})
        totals["errors"] += 1
        return
    finally:
        try: os.remove(audio_tmp)
        except Exception: pass

    if err or not text2:
        emit({"type": "item_error", "i": i, "video_id": meta["id"],
              "message": f"transcribe failed: {err or 'empty result'}"})
        totals["errors"] += 1
        return

    cost_r = round(float(cost or 0), 6)
    emit({"type": "transcribe_done", "i": i, "video_id": meta["id"],
          "engine": args.engine, "chars": len(text2), "cost_usd": cost_r})
    fpath = write_text_file(args.out_dir, meta["id"], meta["title"], meta["channel"],
                            meta["webpage_url"], text2, engine=args.engine)
    emit({"type": "saved", "i": i, "video_id": meta["id"],
          "file_path": fpath, "kind": "ai", "chars": len(text2),
          "cost_usd": cost_r})
    totals["saved"] += 1
    totals["cost_usd"] += cost_r


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", required=True,
                    help="comma-separated video ids or URLs")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--lang", default="ru")
    ap.add_argument("--with-ts", action="store_true")
    ap.add_argument("--auto-ai", action="store_true",
                    help="if subs missing, transcribe with AI (default: skip)")
    ap.add_argument("--engine", default="gemini", choices=("gemini", "assemblyai"))
    args = ap.parse_args(argv)

    items = parse_videos(args.videos)
    n = len(items)
    if n == 0:
        emit({"type": "error", "message": "no valid video ids/URLs"})
        return 2

    totals = {"saved": 0, "skipped": 0, "errors": 0, "cost_usd": 0.0}
    started = time.monotonic()

    for i, (vid, url) in enumerate(items, 1):
        try:
            process_one(i, n, vid, url, args, totals)
        except KeyboardInterrupt:
            emit({"type": "error", "message": "interrupted"})
            break
        except Exception as ex:
            emit({"type": "item_error", "i": i, "video_id": vid,
                  "message": f"{type(ex).__name__}: {ex}"})
            totals["errors"] += 1

    emit({"type": "done",
          "items_total":     n,
          "saved":           totals["saved"],
          "skipped":         totals["skipped"],
          "errors":          totals["errors"],
          "total_cost_usd":  round(totals["cost_usd"], 6),
          "duration_sec":    round(time.monotonic() - started, 2)})
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
