#!/usr/bin/env python3
"""Batch TikTok transcript fetcher for SC Desktop.

Iterates over N TikTok video URLs (or video IDs + handle), per-video:
  TikWM API → play URL → ffmpeg → Gemini → write .txt.

Unlike YouTube there's no subs path — every video goes through AI.
No --auto-ai flag (it would always be on).

Events match yt_batch_transcribe_ndjson.py shape so the same job-runner
handler can consume both, minus the subs-related events:
  {"type": "info",            "message": "..."}
  {"type": "item_start",      "i": 1, "n": 10, "video_id": "...", "url": "...",
                              "title": "...", "duration_sec": 38, "channel": "..."}
  {"type": "transcribe_start","i": 1, "video_id": "...", "engine": "gemini"}
  {"type": "transcribe_done", "i": 1, "video_id": "...", "engine": "gemini",
                              "chars": N, "cost_usd": F}
  {"type": "saved",           "i": 1, "video_id": "...", "file_path": "...",
                              "kind": "ai", "chars": N, "cost_usd": F}
  {"type": "item_error",      "i": 1, "video_id": "...", "message": "..."}
  {"type": "done",            "items_total": N, "saved": M, "skipped": 0,
                              "errors": E, "total_cost_usd": F, "duration_sec": 4.2}

Usage:
  tk_batch_transcribe_ndjson.py
      --videos VID1,VID2,...   (numeric ids OR full URLs)
      --handle <@user>         (required if VIDs are bare numeric ids)
      --out-dir <dir>
      [--engine gemini|assemblyai]
"""
import sys
import os
import json
import time
import argparse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))                     # for tk_single_ndjson
sys.path.insert(0, str(HERE.parent / "shared"))   # for gemini_utils

from tk_single_ndjson import (   # noqa: E402
    extract_video_id,
    resolve_short_url,
    tikwm_video_info,
    download_audio,
    write_text_file,
    silenced,
)


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def parse_videos(raw, default_handle=None):
    """Accept comma-separated numeric ids or full URLs.
    Each → (video_id, full_url). Numeric ids need default_handle."""
    out = []
    for piece in (raw or "").split(","):
        piece = piece.strip()
        if not piece:
            continue
        if piece.startswith("http"):
            url = piece
            vid = extract_video_id(piece)
            if not vid:
                # Possibly a short URL → resolve, retry
                resolved = resolve_short_url(piece)
                vid = extract_video_id(resolved)
                if vid:
                    url = resolved
            if not vid:
                emit({"type": "info", "message": f"skip non-video input: {piece!r}"})
                continue
        else:
            # Numeric id
            if not piece.isdigit():
                emit({"type": "info", "message": f"skip non-id input: {piece!r}"})
                continue
            vid = piece
            handle = (default_handle or "").lstrip("@").strip()
            if not handle:
                emit({"type": "info", "message": f"skip {vid!r}: no --handle for bare ids"})
                continue
            url = f"https://www.tiktok.com/@{handle}/video/{vid}"
        out.append((vid, url))
    return out


def process_one(i, n, vid, url, args, totals):
    # ── Per-video metadata via TikWM ──────────────────────────────────────
    data, terr = tikwm_video_info(url)
    if not data:
        emit({"type": "item_error", "i": i, "video_id": vid,
              "message": f"TikWM lookup failed: {terr}"})
        totals["errors"] += 1
        return

    title = data.get("title") or ""
    duration = data.get("duration") or 0
    play_url = data.get("play") or data.get("hdplay")
    author = (data.get("author") or {}).get("unique_id") or ""

    if not play_url:
        emit({"type": "item_error", "i": i, "video_id": vid,
              "message": "TikWM returned no play URL"})
        totals["errors"] += 1
        return

    emit({"type": "item_start", "i": i, "n": n,
          "video_id":     vid,
          "url":          url,
          "title":        title,
          "duration_sec": duration,
          "channel":      f"@{author}" if author else None})

    audio_tmp = f"/tmp/tk_batch_{vid}.m4a"
    try:
        if os.path.exists(audio_tmp):
            os.remove(audio_tmp)
    except Exception:
        pass

    # ── Download audio ────────────────────────────────────────────────────
    try:
        download_audio(play_url, audio_tmp)
    except Exception as ex:
        emit({"type": "item_error", "i": i, "video_id": vid,
              "message": f"download failed: {type(ex).__name__}: {ex}"})
        totals["errors"] += 1
        return

    # ── Transcribe ────────────────────────────────────────────────────────
    emit({"type": "transcribe_start", "i": i, "video_id": vid, "engine": args.engine})

    text, terr, cost = None, None, 0.0
    try:
        with silenced():
            import gemini_utils
            client = gemini_utils.GeminiClient()
            text, terr = client.transcribe_audio(audio_tmp, engine=args.engine)
            cost = client.calculate_cost() if args.engine == "gemini" else 0.0
    except Exception as ex:
        emit({"type": "item_error", "i": i, "video_id": vid,
              "message": f"transcribe crashed: {type(ex).__name__}: {ex}"})
        totals["errors"] += 1
        return
    finally:
        try: os.remove(audio_tmp)
        except Exception: pass

    if terr or not text:
        emit({"type": "item_error", "i": i, "video_id": vid,
              "message": f"transcribe failed: {terr or 'empty result'}"})
        totals["errors"] += 1
        return

    cost_r = round(float(cost or 0), 6)
    emit({"type": "transcribe_done", "i": i, "video_id": vid,
          "engine": args.engine, "chars": len(text), "cost_usd": cost_r})

    fpath = write_text_file(args.out_dir, vid, title,
                            f"@{author}" if author else None, url, text,
                            engine=args.engine)
    emit({"type": "saved", "i": i, "video_id": vid,
          "file_path": fpath, "kind": "ai", "chars": len(text),
          "cost_usd": cost_r})
    totals["saved"] += 1
    totals["cost_usd"] += cost_r


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", required=True,
                    help="comma-separated numeric video ids or URLs")
    ap.add_argument("--handle", default=None,
                    help="@user — required when --videos contains bare numeric ids")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--engine", default="gemini", choices=("gemini", "assemblyai"))
    args = ap.parse_args(argv)

    items = parse_videos(args.videos, default_handle=args.handle)
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
