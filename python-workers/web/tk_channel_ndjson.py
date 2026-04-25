#!/usr/bin/env python3
"""Streaming TikTok channel fetcher for SC Desktop.

Lists a TikTok user's videos via yt-dlp --flat-playlist (free, fast: ~30
videos/sec). Emits one JSON object per line to stdout (ndjson).

Events mirror the YouTube channel script so the same job-runner handlers
can consume both:
  {"type": "info",            "message": "..."}
  {"type": "entity",          "channel_id": "<numeric_id>", "handle": "@name",
                              "title": "...", "avatar_url": "...",
                              "subs_count": null, "url": "..."}
  {"type": "page",            "loaded": N, "limit": L}
  {"type": "item",            "data": {video_id, url, title, duration_sec,
                                       view_count, timestamp, upload_date}}
  {"type": "preview_summary", "items_total": N, "total_duration_sec": S,
                              "date_min": ts, "date_max": ts}
  {"type": "error",           "message": "..."}
  {"type": "done",            "items_total": N, "duration_sec": 4.2}

Usage:
  tk_channel_ndjson.py <url-or-handle> [--limit 200] [--reverse]
"""
import sys
import os
import re
import json
import time
import argparse
import subprocess
import urllib.request


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


VIDEO_URL_RE = re.compile(r"tiktok\.com/@[\w.-]+/video/(\d+)")
HANDLE_URL_RE = re.compile(r"tiktok\.com/@([\w.-]+)/?$")
SHORT_URL_RE = re.compile(r"^https?://(?:vt|vm)\.tiktok\.com/")


def _resolve_short_url(short_url):
    """vt.tiktok.com/XXXX → real https://www.tiktok.com/@user/video/123 URL."""
    try:
        req = urllib.request.Request(short_url, headers={"User-Agent": "Mozilla/5.0"})
        opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler())
        with opener.open(req, timeout=10) as resp:
            return resp.geturl()
    except Exception:
        return short_url


def canonicalize(input_str):
    """Normalize various TikTok inputs to a profile URL.

    Accepts: full URL, '@handle', 'handle', short link (vt.tiktok.com/...).
    For a video URL, extracts the owning channel from the path.
    Returns: https://www.tiktok.com/@handle  (no trailing slash)
    """
    s = (input_str or "").strip()
    if not s:
        return None

    # Bare handle without scheme
    if not s.startswith("http"):
        s = s.lstrip("@")
        return f"https://www.tiktok.com/@{s}"

    # Short link → resolve via HEAD redirect
    if SHORT_URL_RE.match(s):
        s = _resolve_short_url(s)

    # Strip query
    s_no_q = s.split("?")[0].rstrip("/")

    # Video URL — extract handle from path
    m = re.search(r"tiktok\.com/(@[\w.-]+)/video/", s_no_q)
    if m:
        return f"https://www.tiktok.com/{m.group(1)}"

    # Profile URL already
    m = re.search(r"tiktok\.com/(@[\w.-]+)$", s_no_q)
    if m:
        return f"https://www.tiktok.com/{m.group(1)}"

    return s_no_q


def _handle_from_url(url):
    m = re.search(r"tiktok\.com/@([\w.-]+)", url or "")
    return f"@{m.group(1)}" if m else None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("target")
    p.add_argument("--limit", type=int, default=200,
                   help="max number of videos to enumerate (yt-dlp --playlist-end)")
    p.add_argument("--reverse", action="store_true",
                   help="oldest first (default: newest first)")
    args = p.parse_args()

    url = canonicalize(args.target)
    if not url:
        emit({"type": "error", "message": f"can't canonicalize: {args.target!r}"})
        sys.exit(2)

    handle = _handle_from_url(url)
    started = time.monotonic()
    emit({"type": "info", "message": f"Querying yt-dlp for {url} (limit={args.limit})"})

    cmd = [
        "yt-dlp",
        "--cookies-from-browser", "firefox",
        "--dump-single-json",
        "--flat-playlist",
        "--playlist-end", str(args.limit),
        "--ignore-errors",
        "--no-warnings",
        url,
    ]
    if args.reverse:
        cmd.append("--playlist-reverse")

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        emit({"type": "error", "message": "yt-dlp not installed (brew install yt-dlp)"})
        sys.exit(3)

    if result.returncode != 0 and not result.stdout.strip():
        tail = (result.stderr or "").strip()[-500:]
        emit({"type": "error", "message": f"yt-dlp failed: {tail or 'no output'}"})
        sys.exit(result.returncode or 1)

    # yt-dlp emits warnings before the JSON. Pick the first { ... } line.
    data = None
    for line in result.stdout.split("\n"):
        line = line.strip()
        if line.startswith("{"):
            try:
                data = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
    if not isinstance(data, dict):
        emit({"type": "error", "message": "yt-dlp returned no channel data (private or non-existent?)"})
        sys.exit(5)

    # ── Channel header ────────────────────────────────────────────────────
    # yt-dlp's TikTok extractor returns numeric uploader_id (e.g. "6773990553...")
    # which is the stable channel id. Handle is in title or extracted from URL.
    channel_id = data.get("uploader_id") or data.get("channel_id") or _from_first_entry(data, "uploader_id")
    title = data.get("title") or data.get("uploader") or handle
    avatar = _pick_avatar(data.get("thumbnails") or [])

    emit({
        "type": "entity",
        "channel_id": str(channel_id) if channel_id else None,
        "handle": handle,
        "title": title,
        "avatar_url": avatar,
        "subs_count": None,                # not available in flat-playlist
        "url": url,
    })

    # ── Videos ────────────────────────────────────────────────────────────
    entries = data.get("entries") or []
    total = 0
    total_duration = 0.0
    date_min = None
    date_max = None

    for entry in entries:
        if not entry:
            continue
        if entry.get("_type") == "playlist":
            continue
        vid = entry.get("id")
        if not vid:
            continue
        duration = entry.get("duration")
        ts = entry.get("timestamp") or entry.get("release_timestamp")
        upload_date = entry.get("upload_date")
        if not ts and upload_date and re.match(r"^\d{8}$", upload_date):
            try:
                from datetime import datetime, timezone
                ts = int(datetime.strptime(upload_date, "%Y%m%d")
                         .replace(tzinfo=timezone.utc).timestamp())
            except Exception:
                pass

        # yt-dlp's TikTok url field can be a watch URL or relative — normalise
        v_url = entry.get("url")
        if not v_url or not v_url.startswith("http"):
            v_url = f"{url}/video/{vid}"

        emit({"type": "item", "data": {
            "video_id":     str(vid),
            "url":          v_url,
            "title":        entry.get("title") or entry.get("description") or "",
            "duration_sec": duration,
            "view_count":   entry.get("view_count"),
            "timestamp":    ts,
            "upload_date":  upload_date,
        }})

        total += 1
        if duration:
            total_duration += float(duration)
        if ts:
            if date_min is None or ts < date_min: date_min = ts
            if date_max is None or ts > date_max: date_max = ts

        if total % 50 == 0:
            emit({"type": "page", "loaded": total, "limit": args.limit})

    emit({
        "type": "preview_summary",
        "items_total":        total,
        "total_duration_sec": total_duration,
        "date_min":           date_min,
        "date_max":           date_max,
    })

    elapsed = round(time.monotonic() - started, 2)
    emit({"type": "done", "items_total": total, "duration_sec": elapsed})


def _from_first_entry(data, key):
    e = data.get("entries") or []
    return e[0].get(key) if e else None


def _pick_avatar(thumbnails):
    if not thumbnails:
        return None
    avatars = [t for t in thumbnails if "avatar" in (t.get("id") or "")]
    if avatars:
        avatars.sort(key=lambda t: -(t.get("width") or 0))
        return avatars[0].get("url")
    # TikTok's flat-playlist sometimes has no avatar id'd thumbnail; pick the
    # widest one as a fallback.
    sorted_thumbs = sorted(thumbnails, key=lambda t: -(t.get("width") or 0))
    return sorted_thumbs[0].get("url") if sorted_thumbs else None


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(130)
    except Exception as e:
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        sys.exit(1)
