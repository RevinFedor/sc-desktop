#!/usr/bin/env python3
"""Streaming YouTube comments fetcher for SC Desktop.

Wraps yt-dlp's `--write-comments` (which writes them into <id>.info.json) and
turns it into our standard ndjson event protocol. Renders the result as a
flat-with-replies plain-text file in the same family as transcripts:

    @author · автор · закреп · 4500 ❤
    Top-level comment text here.
      ↳ @reply_author · 12 ❤
        First reply
      ↳ @another · 3 ❤
        Second reply

    @next_author · 312 ❤
    Next thread...

Events:
  {"type": "info",            "message": "..."}
  {"type": "video",           "video_id": "...", "title": "...", "channel": "...", "url": "..."}
  {"type": "fetch_progress",  "got": N, "expected": M}        # streamed from yt-dlp stdout
  {"type": "saved",           "file_path": "...", "count_total": N, "count_top": K, "count_replies": R}
  {"type": "error",           "message": "..."}
  {"type": "done",            "duration_sec": 4.2}
"""
import sys
import os
import re
import json
import time
import argparse
import subprocess
import tempfile
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


# ─── Helpers (deliberate copy from yt_single_ndjson — keeps these scripts
# independent and avoids cross-imports that would tangle prod packaging) ──

VIDEO_ID_RE = [
    r"(?:v=|/)([0-9A-Za-z_-]{11}).*",
    r"youtu\.be/([0-9A-Za-z_-]{11})",
    r"shorts/([0-9A-Za-z_-]{11})",
]


def extract_video_id(url):
    for p in VIDEO_ID_RE:
        m = re.search(p, url)
        if m:
            return m.group(1)
    return None


def safe_slug(s, max_len=80):
    s = re.sub(r"[^\w\s-]", "", s or "").strip()
    s = re.sub(r"\s+", "_", s)
    return s[:max_len] or "video"


def fmt_likes(n):
    """`4500` -> `4.5k`, `1234567` -> `1.2M`. Empty for None/0."""
    if not n:
        return ""
    n = int(n)
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M".replace(".0M", "M")
    if n >= 1_000:
        return f"{n/1_000:.1f}k".replace(".0k", "k")
    return str(n)


def render_comments(comments, video_meta, params):
    """Flat-with-replies format. One blank line between threads.
    Reply tree is at most 1 level deep on YouTube — verified empirically.
    Tags 'автор' / 'закреп' inline only when present; likes always last.
    """
    by_parent = {}
    by_id = {}
    for c in comments:
        by_id[c.get("id")] = c
        p = c.get("parent")
        if p == "root" or p is None:
            by_parent.setdefault("root", []).append(c)
        else:
            by_parent.setdefault(p, []).append(c)

    # Header — self-describing, same family as transcripts.
    header = []
    title = video_meta.get("title", "")
    if title:
        header.append(f"# {title}")
    if video_meta.get("channel"):
        header.append(f"channel: {video_meta['channel']}")
    header.append(f"url: {video_meta.get('webpage_url') or ''}")
    header.append(f"source: comments")
    header.append(f"sort: {params.get('sort', 'new')}")
    if params.get('limit'):
        header.append(f"limit: {params['limit']}")
    header.append(f"with_replies: {'yes' if params.get('include_replies') else 'no'}")

    body_lines = []
    top_count = 0
    reply_count = 0

    def author_tail(c):
        bits = []
        if c.get("author_is_uploader"):
            bits.append("автор")
        if c.get("is_pinned"):
            bits.append("закреп")
        likes = fmt_likes(c.get("like_count"))
        if likes:
            bits.append(f"{likes} ❤")
        return (" · " + " · ".join(bits)) if bits else ""

    for top in by_parent.get("root", []):
        if body_lines:
            body_lines.append("")
        author = top.get("author") or "(аноним)"
        body_lines.append(f"{author}{author_tail(top)}")
        text = (top.get("text") or "").strip()
        if text:
            body_lines.append(text)
        top_count += 1

        if params.get("include_replies"):
            for rep in by_parent.get(top.get("id"), []):
                ra = rep.get("author") or "(аноним)"
                body_lines.append(f"  ↳ {ra}{author_tail(rep)}")
                rt = (rep.get("text") or "").strip()
                if rt:
                    # 4-space indent so the reply visually nests under ↳ marker.
                    for ln in rt.splitlines():
                        body_lines.append(f"    {ln}")
                reply_count += 1

    return ("\n".join(header) + "\n\n" + "\n".join(body_lines).rstrip() + "\n",
            top_count, reply_count)


def fetch_meta(url, attempts=3):
    """yt-dlp metadata pull with retry. Mirrors yt_single_ndjson.py::fetch_meta
    so the form has a useful `entity` event before the long comments fetch.

    Retries transient first-call flakes (same root cause as the single-video
    path — see yt_single_ndjson.py::fetch_meta). Returns the meta dict or None;
    the caller degrades to an empty header on None, so the contract stays
    single-value here (no error string needed)."""
    cmd = [
        "yt-dlp",
        "--cookies-from-browser", "firefox",
        "--remote-components", "ejs:github",
        "--dump-json",
        "--no-playlist",
        "--skip-download",
        "--no-warnings",
        url,
    ]
    for i in range(max(1, attempts)):
        if i:
            time.sleep(0.8 * i)  # linear backoff: 0.8s, 1.6s
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=45)
            data = json.loads(r.stdout.strip().split("\n", 1)[0])
            return {
                "id":           data.get("id"),
                "title":        data.get("title", ""),
                "duration_sec": int(data.get("duration") or 0),
                "channel":      data.get("channel") or data.get("uploader") or "",
                "webpage_url":  data.get("webpage_url") or url,
                "comment_count": int(data.get("comment_count") or 0),
            }
        except Exception:
            continue
    return None


# ─── Main ────────────────────────────────────────────────────────────────

# yt-dlp stdout chatter we care about looks like:
#   [youtube] Downloading comment API JSON page 5 (412/~1242)
#   [youtube] Extracted 412 comments
# Two regexes — the page line gives us the live counter, the Extracted line
# is the final summary.
RE_PAGE = re.compile(r"comment.*?\((\d+)/~?(\d+)\)", re.IGNORECASE)
RE_EXTRACTED = re.compile(r"Extracted\s+(\d+)\s+comments?", re.IGNORECASE)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("--out-dir", required=True,
                   help="Where to write <id>__<slug>__comments_<sort>_<limit>.txt")
    p.add_argument("--sort", choices=["new", "top"], default="new",
                   help="Sort comments. Default 'new' matches user expectation.")
    p.add_argument("--limit", type=int, default=200,
                   help="Max comments (top-level + replies if --with-replies). 0 = no limit.")
    p.add_argument("--with-replies", action="store_true",
                   help="Include reply threads (default: top-level only).")
    args = p.parse_args()

    t0 = time.time()
    vid = extract_video_id(args.url)
    if not vid:
        emit({"type": "error", "message": f"Cannot extract video id from {args.url}"})
        return 2

    # Fetch metadata first — small + fast, gives renderer a video header.
    meta = fetch_meta(args.url) or {
        "id": vid, "title": "", "channel": "",
        "webpage_url": args.url, "comment_count": 0,
    }
    emit({
        "type": "video",
        "video_id":     vid,
        "title":        meta.get("title", ""),
        "channel":      meta.get("channel", ""),
        "duration_sec": int(meta.get("duration_sec") or 0),
        "comment_count": int(meta.get("comment_count") or 0),
        "url":          meta.get("webpage_url") or args.url,
    })

    # Build extractor-args. yt-dlp packs comma-separated:
    #   max_comments,max_parents,max_replies,max_replies_per_thread,max_depth
    # When --with-replies is off we set max_replies=0 so we get clean
    # top-level fill up to the limit instead of mixing replies in.
    if args.limit > 0:
        if args.with_replies:
            mc_arg = f"max_comments={args.limit}"
        else:
            mc_arg = f"max_comments={args.limit},max_parents={args.limit},max_replies=0"
    else:
        mc_arg = "max_comments=all"
    extractor_args = f"youtube:{mc_arg};comment_sort={args.sort}"

    # Use a private tempdir for the .info.json; we copy out the .txt to out-dir
    # so we never accidentally produce sibling artefacts where the user can
    # see them.
    tmp_dir = Path(tempfile.mkdtemp(prefix="sc_yt_comments_"))
    try:
        cmd = [
            "yt-dlp",
            "--cookies-from-browser", "firefox",
            "--remote-components", "ejs:github",
            "--skip-download",
            "--write-comments",
            "--write-info-json",
            "--no-warnings",
            "--extractor-args", extractor_args,
            "--paths", str(tmp_dir),
            "-o", "%(id)s.%(ext)s",
            args.url,
        ]

        emit({"type": "info", "message": f"yt-dlp comments fetch · sort={args.sort} · limit={args.limit or 'all'}"})

        # Stream stdout so we can convert page-progress lines into events.
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        last_got = -1
        last_expected = 0
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.rstrip()
                if not line:
                    continue
                m = RE_PAGE.search(line)
                if m:
                    got = int(m.group(1))
                    expected = int(m.group(2))
                    # Throttle: only emit when count changes — yt-dlp emits the
                    # same line for both root pages and reply pages.
                    if got != last_got or expected != last_expected:
                        last_got = got
                        last_expected = expected
                        emit({"type": "fetch_progress", "got": got, "expected": expected})
                    continue
                m = RE_EXTRACTED.search(line)
                if m:
                    got = int(m.group(1))
                    if got != last_got:
                        last_got = got
                        emit({"type": "fetch_progress", "got": got, "expected": got})
                    continue
        finally:
            proc.wait(timeout=600)

        if proc.returncode != 0:
            emit({"type": "error",
                  "message": f"yt-dlp exited {proc.returncode} (no info.json or aborted)"})
            return 2

        info_path = tmp_dir / f"{vid}.info.json"
        if not info_path.exists():
            emit({"type": "error", "message": f"yt-dlp produced no info.json for {vid}"})
            return 2

        try:
            data = json.loads(info_path.read_text(encoding="utf-8"))
        except Exception as e:
            emit({"type": "error", "message": f"Cannot parse info.json: {e}"})
            return 2

        comments = data.get("comments") or []
        if not comments:
            emit({"type": "error", "message": "Видео не имеет комментариев или они отключены"})
            return 2

        params = {
            "sort": args.sort,
            "limit": args.limit,
            "include_replies": args.with_replies,
        }
        body, top_count, reply_count = render_comments(comments, meta, params)

        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        # File name encodes the cache key — sort, limit, replies. Different
        # parameter sets get different files; cache lookup matches by exact
        # signature so users can keep multiple variants of the same video.
        suffix_parts = [args.sort]
        suffix_parts.append(str(args.limit) if args.limit > 0 else "all")
        if args.with_replies:
            suffix_parts.append("withreplies")
        slug = safe_slug(meta.get("title", "")) or vid
        file_path = out_dir / f"{vid}__{slug}__comments_{'_'.join(suffix_parts)}.txt"
        file_path.write_text(body, encoding="utf-8")

        emit({
            "type": "saved",
            "file_path":     str(file_path),
            "count_total":   len(comments),
            "count_top":     top_count,
            "count_replies": reply_count,
        })
        emit({"type": "done", "duration_sec": round(time.time() - t0, 2)})
        return 0
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    try:
        rc = main()
        sys.exit(rc)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        emit({"type": "error", "message": f"Unhandled: {e}"})
        sys.exit(1)
