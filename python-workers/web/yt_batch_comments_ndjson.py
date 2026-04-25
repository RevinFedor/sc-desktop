#!/usr/bin/env python3
"""Batch YouTube comments fetcher for SC Desktop.

Same protocol as yt_batch_transcribe_ndjson.py but for comments. For each
video: invoke yt_comments_ndjson.py as a child, stream its events, re-emit
with batch-level (`i`, `n`) wrappers.

Events:
  {"type": "info",            "message": "..."}
  {"type": "item_start",      "i": 1, "n": 10, "video_id": "...", "url": "...", "title": "...",
                              "channel": "...", "comment_count": N}
  {"type": "fetch_progress",  "i": 1, "video_id": "...", "got": N, "expected": M}
  {"type": "saved",           "i": 1, "video_id": "...", "file_path": "...",
                              "count_total": N, "count_top": K, "count_replies": R}
  {"type": "skipped",         "i": 1, "video_id": "...", "reason": "no_comments"}
  {"type": "item_error",      "i": 1, "video_id": "...", "message": "..."}
  {"type": "error",           "message": "..."}
  {"type": "done",            "items_total": N, "saved": M, "skipped": S, "errors": E,
                              "duration_sec": 4.2}

Usage:
  yt_batch_comments_ndjson.py
      --videos VID1,VID2,...
      --out-dir <dir>
      --sort new|top
      --limit N        (0 = all)
      [--with-replies]
"""
import sys
import os
import json
import time
import argparse
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Reuse single-video helpers (extract_video_id, etc.).
sys.path.insert(0, str(HERE))
from yt_comments_ndjson import extract_video_id  # noqa: E402


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def parse_videos(raw):
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
    """Fork yt_comments_ndjson.py for this video, translate its events into
    batch-shape events. Each child runs its own yt-dlp subprocess; we keep
    them sequential so the user sees `i/n` progress without paralleising
    yt-dlp's anti-bot rate-limit risk."""
    cmd = [
        sys.executable,
        str(HERE / "yt_comments_ndjson.py"),
        url,
        "--out-dir", args.out_dir,
        "--sort", args.sort,
        "--limit", str(args.limit),
    ]
    if args.with_replies:
        cmd.append("--with-replies")

    # We've already emitted the `i/n` shell event (see main loop) — start
    # streaming child output and wrap each line.
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    item_started = False
    saved = False
    error_msg = None
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except Exception:
                continue
            t = evt.get("type")
            if t == "video":
                emit({"type":          "item_start",
                      "i":             i,
                      "n":             n,
                      "video_id":      evt.get("video_id") or vid,
                      "url":           evt.get("url") or url,
                      "title":         evt.get("title", ""),
                      "channel":       evt.get("channel", ""),
                      "duration_sec":  evt.get("duration_sec"),
                      "comment_count": evt.get("comment_count")})
                item_started = True
            elif t == "fetch_progress":
                emit({"type":     "fetch_progress",
                      "i":        i,
                      "video_id": vid,
                      "got":      evt.get("got"),
                      "expected": evt.get("expected")})
            elif t == "saved":
                emit({"type":          "saved",
                      "i":             i,
                      "video_id":      evt.get("video_id") or vid,
                      "file_path":     evt.get("file_path"),
                      "count_total":   evt.get("count_total"),
                      "count_top":     evt.get("count_top"),
                      "count_replies": evt.get("count_replies")})
                saved = True
                totals["saved"] += 1
            elif t == "error":
                msg = evt.get("message", "")
                error_msg = msg
                # "no comments" is an expected outcome for some videos —
                # surface as `skipped` rather than `item_error`. Same
                # pattern as `subs_missing` → `skipped` in the transcribe
                # batch script.
                if "комментариев" in msg or "comments" in msg.lower():
                    emit({"type": "skipped", "i": i, "video_id": vid,
                          "reason": "no_comments"})
                    totals["skipped"] += 1
                else:
                    emit({"type": "item_error", "i": i, "video_id": vid,
                          "message": msg})
                    totals["errors"] += 1
            # `info` and `done` from the child are dropped — we re-emit our
            # own batch-level done at the end.
    finally:
        proc.wait(timeout=600)

    if proc.returncode != 0 and not saved and not error_msg:
        emit({"type": "item_error", "i": i, "video_id": vid,
              "message": f"yt-dlp exited {proc.returncode}"})
        totals["errors"] += 1


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--sort", choices=["new", "top"], default="new")
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--with-replies", action="store_true")
    args = ap.parse_args(argv)

    items = parse_videos(args.videos)
    n = len(items)
    if n == 0:
        emit({"type": "error", "message": "no valid video ids/URLs"})
        return 2

    totals = {"saved": 0, "skipped": 0, "errors": 0}
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
          "items_total":  n,
          "saved":        totals["saved"],
          "skipped":      totals["skipped"],
          "errors":       totals["errors"],
          "duration_sec": round(time.monotonic() - started, 2)})
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
