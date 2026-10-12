#!/usr/bin/env python3
"""Streaming YouTube channel fetcher for SC Desktop.

Emits one JSON object per line to stdout (ndjson). Electron's job-runner
reads each line as a job event.

Events:
  {"type": "info",            "message": "..."}
  {"type": "entity",          "channel_id": "UC...", "handle": "@name", "title": "...",
                              "avatar_url": "...", "subs_count": 12345, "url": "..."}
  {"type": "page",            "loaded": N, "limit": L}
  {"type": "item",            "data": {video_id, url, title, duration_sec, view_count,
                                       upload_date, timestamp}}
  {"type": "preview_summary", "items_total": N, "total_duration_sec": S,
                              "date_min": ts, "date_max": ts}
  {"type": "error",           "message": "..."}
  {"type": "done",            "items_total": N, "duration_sec": 4.2}

Usage:
  yt_channel_ndjson.py <url-or-handle> [--limit 200] [--reverse]
"""
import sys
import os
import re
import json
import time
import argparse
import subprocess


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


UC_ID_RE = re.compile(r"^UC[\w-]{22}$")
VIDEO_URL_RE = re.compile(
    r"(?:[?&]v=|/v/|/embed/|/shorts/|/live/|youtu\.be/)([0-9A-Za-z_-]{11})"
)

def canonicalize(input_str):
    """Normalize various YouTube channel URL forms to the /videos endpoint
    so yt-dlp returns the videos tab specifically (not the meta-playlist of
    [Videos, Shorts] which it returns for bare /@handle URLs).

    Accepts: full URL, '@handle', 'handle', 'UCxxxxxxxxxxxxxxxxxxxxxx' (24 chars).
    For a video URL, resolves it to the owning channel via yt-dlp.
    """
    s = (input_str or "").strip()
    if not s:
        return None

    # Bare UC-id (24-char channel_id): /channel/UC...
    if not s.startswith("http") and UC_ID_RE.match(s):
        return f"https://www.youtube.com/channel/{s}/videos"

    # Bare handle without scheme: '@durov' or 'durov'
    if not s.startswith("http"):
        s = s.lstrip("@")
        s = f"https://www.youtube.com/@{s}"

    # Strip trailing slash and query (we need this BEFORE the video-URL check
    # so /watch?v=... still matches). Keep query for video URLs though.
    s_no_q = s.split("?")[0].rstrip("/")

    # If it's already pointing at /videos / /shorts-as-tab / /streams / /playlists,
    # leave it (user's choice).
    tail_re = re.compile(r"/(videos|streams|playlists|featured|community|about)$")
    if tail_re.search(s_no_q):
        return s_no_q

    # Bare /@handle, /c/x, /channel/UC..., /user/x — append /videos
    path_re = re.compile(r"^https://(?:www\.)?youtube\.com/(@[\w.-]+|c/[\w.-]+|channel/UC[\w-]+|user/[\w.-]+)$")
    if path_re.search(s_no_q):
        return s_no_q + "/videos"

    # Video URL → resolve to its channel via a quick yt-dlp metadata pull.
    if VIDEO_URL_RE.search(s):
        channel_url = _resolve_channel_from_video(s)
        if channel_url:
            return channel_url.rstrip("/") + "/videos"
        # fallthrough — let yt-dlp give a clear error

    return s_no_q


def _resolve_channel_from_video(video_url):
    """Use yt-dlp --dump-json --no-playlist to pull the channel_url for a
    given video URL. Returns the channel URL (https://www.youtube.com/channel/UC...)
    or None on failure."""
    try:
        result = subprocess.run([
            "yt-dlp",
            "--cookies-from-browser", "firefox",
            "--remote-components", "ejs:github",
            "--dump-json",
            "--no-playlist",
            "--skip-download",
            "--no-warnings",
            video_url,
        ], capture_output=True, text=True, check=False, timeout=30)
        if result.returncode != 0 or not result.stdout.strip():
            return None
        data = json.loads(result.stdout.strip().split("\n", 1)[0])
        return data.get("channel_url") or data.get("uploader_url")
    except Exception:
        return None


def build_channel_command(url, limit=200, reverse=False):
    cmd = [
        "yt-dlp",
        "--cookies-from-browser", "firefox",
        "--remote-components", "ejs:github",
        "--dump-single-json",
        "--flat-playlist",
        "--extractor-args", "youtubetab:approximate_date",
    ]
    if limit > 0:
        cmd.extend(["--playlist-end", str(limit)])
    cmd.extend(["--ignore-errors", "--no-warnings", url])
    if reverse:
        cmd.append("--playlist-reverse")
    return cmd


def catalog_coverage(total, requested_limit, reported_total=None):
    complete = requested_limit <= 0 or total < requested_limit
    known_total = total if complete else (
        int(reported_total)
        if isinstance(reported_total, (int, float)) and reported_total >= total
        else None
    )
    return {"complete": complete, "total": known_total}


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

    started = time.monotonic()
    emit({"type": "info", "message": f"Querying yt-dlp for {url} (limit={args.limit})"})

    # Approximate dates keep a complete catalog cheap: no per-video detail
    # requests. build_channel_command deliberately omits --playlist-end when
    # limit=0, which is the public "whole channel" contract.
    cmd = build_channel_command(url, args.limit, args.reverse)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        emit({"type": "error", "message": "yt-dlp not installed (brew install yt-dlp)"})
        sys.exit(3)

    if result.returncode != 0 and not result.stdout.strip():
        # nothing on stdout AND non-zero exit → real failure, last 500 bytes of stderr
        tail = (result.stderr or "").strip()[-500:]
        emit({"type": "error", "message": f"yt-dlp failed: {tail or 'no output'}"})
        sys.exit(result.returncode or 1)

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        emit({"type": "error", "message": f"can't parse yt-dlp JSON: {e}"})
        sys.exit(4)

    # yt-dlp can return null for a non-existent channel/playlist on its
    # extractor path — guard before attribute access to give a useful error.
    if not isinstance(data, dict):
        emit({"type": "error", "message": "yt-dlp returned no channel data (private or non-existent?)"})
        sys.exit(5)

    # ── Channel header ────────────────────────────────────────────────────
    channel_id = data.get("channel_id") or _from_first_entry(data, "channel_id")
    handle = (
        data.get("uploader_id")
        or _from_first_entry(data, "uploader_id")
        or _handle_from_url(url)
    )
    title = data.get("channel") or data.get("title") or handle
    subs = data.get("channel_follower_count")
    avatar = _pick_avatar(data.get("thumbnails") or [])
    canonical_channel_url = data.get("channel_url") or url

    emit({
        "type": "entity",
        "channel_id": channel_id,
        "handle": handle,
        "title": title,
        "avatar_url": avatar,
        "subs_count": subs,
        "url": canonical_channel_url,
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
        # 'type=playlist' entries (Shorts tab on bare /@handle, sub-playlists)
        # are skipped — we only emit actual videos.
        if entry.get("_type") == "playlist":
            continue
        vid = entry.get("id")
        if not vid or len(vid) != 11:
            continue
        duration = entry.get("duration")
        ts = entry.get("timestamp") or entry.get("release_timestamp")
        upload_date = entry.get("upload_date")
        # Some channels return upload_date in YYYYMMDD; convert to unix ts if
        # we don't have one already, so the UI can render a date range.
        if not ts and upload_date and re.match(r"^\d{8}$", upload_date):
            try:
                from datetime import datetime, timezone
                ts = int(datetime.strptime(upload_date, "%Y%m%d")
                         .replace(tzinfo=timezone.utc).timestamp())
            except Exception:
                pass

        emit({"type": "item", "data": {
            "video_id":     vid,
            "url":          entry.get("url") or f"https://www.youtube.com/watch?v={vid}",
            "title":        entry.get("title") or "",
            "duration_sec": duration,
            "view_count":   entry.get("view_count"),
            "timestamp":    ts,
            "upload_date":  upload_date,
        }})

        total += 1
        if duration: total_duration += float(duration)
        if ts:
            if date_min is None or ts < date_min: date_min = ts
            if date_max is None or ts > date_max: date_max = ts

        # Page boundary every 50 to keep UI feedback alive on large channels
        # without flooding IPC (matches Telegram's per-100 cadence; 50 here
        # because YouTube channels are usually smaller).
        if total % 50 == 0:
            emit({"type": "page", "loaded": total, "limit": args.limit})

    coverage = catalog_coverage(total, args.limit, data.get("playlist_count"))
    catalog_complete = coverage["complete"]
    catalog_total = coverage["total"]

    emit({
        "type": "preview_summary",
        "items_total":        total,
        "loaded_count":       total,
        "catalog_total":      catalog_total,
        "catalog_complete":   catalog_complete,
        "requested_limit":    args.limit,
        "total_duration_sec": total_duration,
        "date_min":           date_min,
        "date_max":           date_max,
    })

    elapsed = round(time.monotonic() - started, 2)
    emit({
        "type": "done",
        "items_total": total,
        "catalog_total": catalog_total,
        "catalog_complete": catalog_complete,
        "duration_sec": elapsed,
    })


def _from_first_entry(data, key):
    e = data.get("entries") or []
    return e[0].get(key) if e else None


def _handle_from_url(url):
    m = re.search(r"youtube\.com/(@[\w.-]+|c/[\w.-]+|channel/UC[\w-]+|user/[\w.-]+)", url)
    if m:
        seg = m.group(1)
        return seg if seg.startswith("@") else "@" + seg.split("/", 1)[1]
    return None


def _pick_avatar(thumbnails):
    """Pick the highest-quality square avatar from yt-dlp's thumbnails array."""
    if not thumbnails:
        return None
    avatars = [t for t in thumbnails if "avatar" in (t.get("id") or "")]
    if avatars:
        # 'avatar_uncropped' has preference=1, others negative — already sorted
        # in yt-dlp output, but we sort by width to be safe.
        avatars.sort(key=lambda t: -(t.get("width") or 0))
        return avatars[0].get("url")
    return None


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(130)
    except Exception as e:
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        sys.exit(1)
