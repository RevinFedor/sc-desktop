#!/usr/bin/env python3
"""Streaming YouTube search fetcher for SC Desktop.

Emits one JSON object per line (ndjson). Used for the "paste a YouTube
search URL → pick videos → bulk transcribe" flow. Unlike yt_channel,
this script does NOT touch the Library — results are ephemeral and
the renderer wires them straight into the batch picker.

Events:
  {"type": "info",            "message": "..."}
  {"type": "entity",          "query": "...", "limit": N, "offset": M}
  {"type": "item",            "data": {video_id, url, title, duration_sec,
                                       view_count, timestamp, uploader}}
  {"type": "done",            "items_total": N, "duration_sec": 4.2}
  {"type": "error",           "message": "..."}

Usage:
  yt_search_ndjson.py --query "<text>" [--limit 20] [--offset 0]

  Pagination: spawn again with offset=20, limit=20 to get page 2.
  We rely on yt-dlp's stable result ordering between calls (it queries
  YouTube's relevance ranking, which is deterministic for short windows).

Notes:
  yt-dlp doesn't offer a true "search offset" — `ytsearch20:` returns top 20.
  For pagination we ask for `ytsearch{offset+limit}:` and slice locally
  starting at index=offset. This trades a bit of duplicate work for accuracy.
"""
import sys
import json
import time
import argparse
import subprocess


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


# Pipe-separated print template; matches order parsed below.
PRINT_FIELDS = "%(id)s|%(duration)s|%(timestamp)s|%(view_count)s|%(uploader)s|%(title)s"


def run_yt_dlp_search(query_or_url: str, total: int):
    """Spawn yt-dlp, return list of dicts in order.

    Two input shapes:
      1. plain query → wrapped as ytsearch{total}:{query} (top-N relevance)
      2. youtube.com/results?... URL → passed as-is (preserves sp= filters
         like sort=upload_date or videos-only). --playlist-end caps result
         count since the URL form has no built-in N.
    """
    is_url = query_or_url.startswith("http://") or query_or_url.startswith("https://")
    cmd = [
        "yt-dlp",
        query_or_url if is_url else f"ytsearch{total}:{query_or_url}",
        "--flat-playlist",
        "--extractor-args", "youtubetab:approximate_date",
        "--print", PRINT_FIELDS,
        "--no-warnings",
        "--ignore-errors",
    ]
    if is_url:
        cmd.extend(["--playlist-end", str(total)])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return None, "yt-dlp timeout (>2m)"
    if r.returncode != 0 and not r.stdout.strip():
        tail = (r.stderr or "")[-300:].strip()
        return None, f"yt-dlp failed: {tail}"
    out = []
    for line in (r.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        # Title can contain '|', so we split with maxsplit=5 to keep title intact.
        parts = line.split("|", 5)
        if len(parts) < 6:
            continue
        vid, dur, ts, views, uploader, title = parts
        if not vid or vid == "NA":
            continue
        try:
            dur_v = int(float(dur)) if dur and dur != "NA" else None
        except Exception:
            dur_v = None
        try:
            ts_v = int(ts) if ts and ts != "NA" else None
        except Exception:
            ts_v = None
        try:
            views_v = int(views) if views and views != "NA" else None
        except Exception:
            views_v = None
        out.append({
            "video_id":     vid,
            "url":          f"https://www.youtube.com/watch?v={vid}",
            "title":        title or "",
            "duration_sec": dur_v,
            "view_count":   views_v,
            "timestamp":    ts_v,
            "uploader":     (uploader or "").strip() if uploader and uploader != "NA" else None,
        })
    return out, None


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", required=True, help="search text (raw, not URL-encoded)")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--offset", type=int, default=0)
    args = ap.parse_args(argv)

    t0 = time.time()
    query = args.query.strip()
    if not query:
        emit({"type": "error", "message": "empty query"})
        return 2

    emit({"type": "entity", "query": query, "limit": args.limit, "offset": args.offset})

    total = max(1, args.offset + args.limit)
    rows, err = run_yt_dlp_search(query, total)
    if err is not None:
        emit({"type": "error", "message": err})
        return 3
    if rows is None:
        emit({"type": "error", "message": "no rows"})
        return 3

    # Slice for the requested page — we asked for offset+limit total above.
    page = rows[args.offset:args.offset + args.limit]
    for row in page:
        emit({"type": "item", "data": row})

    emit({"type": "done",
          "items_total": len(page),
          "duration_sec": round(time.time() - t0, 2)})
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
