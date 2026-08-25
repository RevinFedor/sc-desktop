#!/usr/bin/env python3
"""Streaming single-video YouTube transcript fetcher for SC Desktop.

Emits one JSON object per line to stdout (ndjson). Electron's job-runner
reads them as job events. All chatty progress prints from underlying libs
are swallowed — only structured emit() calls reach the parent.

Events:
  {"type": "info",            "message": "..."}
  {"type": "video",           "video_id": "...", "title": "...", "duration_sec": N, "channel": "...", "url": "..."}
  {"type": "subs_racing"}
  {"type": "subs_found",      "lang": "ru", "with_ts": false, "chars": 1234}
  {"type": "subs_missing",    "duration_sec": 754, "est_cost_usd": 0.0026}
  {"type": "transcribe_start","engine": "gemini"}
  {"type": "transcribe_done", "engine": "gemini", "chars": 4321, "cost_usd": 0.0028}
  {"type": "saved",           "file_path": "...", "kind": "subs|ai"}
  {"type": "error",           "message": "..."}
  {"type": "done",            "duration_sec": 4.2}

Two-stage usage:
  Stage 1 — only subs check, no AI:
    yt_single_ndjson.py <url> --out-dir <dir> [--lang ru] [--with-ts]
       found:  emits subs_found + saved + done (file_path is .txt)
       missing: emits subs_missing + done (no file_path)

  Stage 2 — explicit AI transcribe:
    yt_single_ndjson.py <url> --out-dir <dir> --ai [--engine gemini|assemblyai]
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

# Shared deps (gemini_utils for AI path)
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "shared"))


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


@contextlib.contextmanager
def silenced():
    """Swallow stdout/stderr from chatty libs (gemini_utils prints progress
    bars, rich panels, etc.). The ndjson contract requires our emit() to be
    the *only* stdout writer."""
    saved_out, saved_err = sys.stdout, sys.stderr
    try:
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        yield
    finally:
        sys.stdout = saved_out
        sys.stderr = saved_err


# ─── YouTube helpers (inlined from web_core to avoid pulling in questionary/rich) ──

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


def _format_timestamp_ms(seconds):
    total_ms = max(0, int(round(float(seconds) * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{milliseconds:03d}"


def _try_transcript_api(url, lang, with_ts):
    """Fast path: youtube-transcript-api. May fail to import on this venv
    (Python 3.14 + homebrew expat conflict) — caught and ignored."""
    vid = extract_video_id(url)
    if not vid:
        return None
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except Exception:
        return None
    import requests

    class TimeoutSession(requests.Session):
        def request(self, *args, **kwargs):
            kwargs.setdefault("timeout", 6)
            return super().request(*args, **kwargs)

    langs = [lang]
    for fb in ("ru", "en"):
        if fb not in langs:
            langs.append(fb)

    # Public captions do not require an account. Avoid importing unrelated
    # Firefox cookies into a Yandex-browser flow; stale consent/account
    # cookies made this fast path intermittent. One retry absorbs an ordinary
    # short network reset before the much slower yt-dlp fallback is started.
    for attempt in range(2):
        try:
            session = TimeoutSession()
            session.headers.update({
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) "
                              "Gecko/20100101 Firefox/141.0",
            })
            snippets = list(YouTubeTranscriptApi(http_client=session).fetch(vid, languages=langs))
            if not snippets:
                return None

            if with_ts:
                lines = []
                for s in snippets:
                    ts = _format_timestamp_ms(s.start)
                    text = s.text.replace("\n", " ").strip()
                    if text:
                        lines.append(f"[{ts}] {text}")
                return "\n".join(lines)

            out = []
            for s in snippets:
                text = s.text.replace("\n", " ").strip()
                if text and (not out or out[-1] != text):
                    out.append(text)
            return "\n".join(out)
        except Exception:
            if attempt == 0:
                time.sleep(0.2)
    return None


def _read_and_clean_srt(path, with_ts=False):
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    if with_ts:
        blocks = re.split(r"\n\n+", content.strip())
        result = []
        for block in blocks:
            lines = block.strip().split("\n")
            if len(lines) < 2:
                continue
            tm = re.match(r"(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*"
                          r"(\d{2}:\d{2}:\d{2}),(\d{3})",
                          lines[1] if len(lines) > 1 else "")
            if not tm:
                continue
            start_s, start_ms = tm.group(1), int(tm.group(2))
            ts = f"{start_s}.{start_ms:03d}"
            end_s, end_ms = tm.group(3), int(tm.group(4))
            h1, m1, s1 = map(int, start_s.split(":"))
            h2, m2, s2 = map(int, end_s.split(":"))
            dur_ms = ((h2*3600+m2*60+s2)*1000+end_ms) - ((h1*3600+m1*60+s1)*1000+start_ms)
            if dur_ms <= 20:
                continue
            text_lines = [re.sub(r"<[^>]+>", "", l).strip() for l in lines[2:] if l.strip()]
            if not text_lines:
                continue
            new_text = text_lines[-1] if len(text_lines) > 1 else text_lines[0]
            if new_text and (not result or new_text != result[-1][1]):
                result.append((ts, new_text))
        try: os.remove(path)
        except Exception: pass
        return "\n".join(f"[{ts}] {text}" for ts, text in result)

    clean = re.sub(r"\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n", "", content)
    clean = re.sub(r"<[^>]+>", "", clean)
    lines = [l.strip() for l in clean.split("\n") if l.strip()]
    deduped = []
    for ln in lines:
        if not deduped or ln != deduped[-1]:
            deduped.append(ln)
    try: os.remove(path)
    except Exception: pass
    return "\n".join(deduped)


def _try_yt_dlp_subs(url, lang, with_ts=False):
    """Fallback: ask yt-dlp for the SRT, parse it ourselves."""
    # Cleanup any leftover from a previous run
    for f in os.listdir("/tmp"):
        if f.startswith("yt_single_subs"):
            try: os.remove(os.path.join("/tmp", f))
            except Exception: pass

    cmd = [
        "yt-dlp",
        "--cookies-from-browser", "firefox",
        "--remote-components", "ejs:github",
        "--skip-download",
        "--write-auto-subs",
        "--write-subs",
        "--sub-langs", lang,
        "--convert-subs", "srt",
        "--ignore-errors",
        "--no-warnings",
        "-o", "/tmp/yt_single_subs",
        url,
    ]
    try:
        subprocess.run(cmd, capture_output=True, check=False, timeout=90)
    except subprocess.TimeoutExpired:
        return None
    for f in os.listdir("/tmp"):
        if f.startswith("yt_single_subs") and f.endswith(".srt"):
            return _read_and_clean_srt(os.path.join("/tmp", f), with_ts=with_ts)
    return None


def extract_subtitles(url, preferred_lang="ru", with_ts=False):
    """Use the fast transcript API first, then start yt-dlp only if needed.

    A ThreadPool race cannot make the worker finish early: Python waits for
    the losing yt-dlp thread while shutting down. That made a two-second API
    result look like a roughly twenty-second load in the browser.
    """
    result = _try_transcript_api(url, preferred_lang, with_ts)
    if result:
        return result

    result = _try_yt_dlp_subs(url, preferred_lang, with_ts)
    if result:
        return result

    # Try alternative language (so ru-only videos still work when --lang en)
    for fb in ("ru", "en"):
        if fb == preferred_lang:
            continue
        res = _try_yt_dlp_subs(url, fb, with_ts=with_ts)
        if res:
            return res
    return None


def fetch_meta(url, attempts=3):
    """yt-dlp metadata pull with retry on transient failures.

    Returns (meta_dict, None) on success or (None, err_str) on final failure.

    Why retry: the very first metadata call after a cold pill-click flakes
    intermittently — YouTube-side rate-limit, a momentary Firefox cookie-DB
    lock when two yt-dlp processes touch cookies.sqlite at once, or nsig/
    sigfuncs warm-up. The exact same command succeeds on the next try. The
    symptom users hit: click `+ ai` → error → click `copy` → works → click
    `+ ai` again → works. Without a retry, one transient blip dead-ends the
    whole action.

    Why return the real error instead of bare None: the previous
    `except Exception: return None` collapsed every cause into the opaque
    "yt-dlp metadata fetch failed" in Activity. Surfacing stderr/exception
    text makes the next failure debuggable instead of a black box."""
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
    last_err = "unknown error"
    for i in range(max(1, attempts)):
        if i:
            time.sleep(0.8 * i)  # linear backoff: 0.8s, 1.6s
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=45)
        except subprocess.TimeoutExpired:
            last_err = "yt-dlp timeout (>45s)"
            continue
        except subprocess.CalledProcessError as ex:
            tail = (ex.stderr or "").strip()
            last_err = f"yt-dlp exit {ex.returncode}: {tail[-300:]}" if tail else f"yt-dlp exit {ex.returncode}"
            continue
        except Exception as ex:
            last_err = f"{type(ex).__name__}: {ex}"
            continue

        first_line = (r.stdout or "").strip().split("\n", 1)[0]
        if not first_line:
            last_err = "yt-dlp returned empty output"
            continue
        try:
            data = json.loads(first_line)
        except Exception as ex:
            last_err = f"bad JSON from yt-dlp: {type(ex).__name__}"
            continue

        return {
            "id":           data.get("id"),
            "title":        data.get("title", ""),
            "duration_sec": int(data.get("duration") or 0),
            "channel":      data.get("channel") or data.get("uploader") or "",
            "webpage_url":  data.get("webpage_url") or url,
            # Channel identity — needed so the runner can upsert a Library
            # source row + an items-row for this video. channel_id is the
            # stable UC-... id; channel_url falls back to channel/<id> form
            # which canonicalize() already understands.
            "channel_id":   data.get("channel_id"),
            "channel_url":  data.get("channel_url") or (
                data.get("channel_id") and f"https://www.youtube.com/channel/{data.get('channel_id')}/videos"
            ) or None,
            "uploader_id":  data.get("uploader_id"),  # @handle when present
        }, None

    return None, last_err


def safe_slug(s, max_len=80):
    s = re.sub(r"[^\w\s-]", "", s or "").strip()
    s = re.sub(r"\s+", "_", s)
    return s[:max_len] or "video"


def write_text_file(out_dir, video_id, title, channel, video_url, body,
                    lang=None, with_ts=False, engine=None):
    """Save transcript to <out_dir>/<videoId>__<slug>.txt.

    Header makes the file self-describing if a user opens it via
    'Reveal in Finder' months later."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # Keep the timestamped derivative next to the ordinary transcript without
    # overwriting it. JobDetail can generate this file later for an already
    # completed transcript, while the original job/file remains unchanged.
    suffix = "__timestamps" if with_ts else ""
    fpath = out_dir / f"{video_id}__{safe_slug(title)}{suffix}.txt"
    parts = [f"# {title}".rstrip()]
    if channel:    parts.append(f"channel: {channel}")
    parts.append(f"url: {video_url}")
    parts.append(f"source: {'subs' if engine is None else 'ai:' + engine}")
    if lang:    parts.append(f"lang: {lang}")
    if with_ts: parts.append("timestamps: yes")
    fpath.write_text("\n".join(parts) + "\n\n" + body, encoding="utf-8")
    return str(fpath)


# ─── stages ──────────────────────────────────────────────────────────────

def stage_subs(url, lang, with_ts, out_dir, meta):
    emit({"type": "subs_racing"})
    text = None
    try:
        with silenced():
            text = extract_subtitles(url, preferred_lang=lang, with_ts=with_ts)
    except Exception as ex:
        emit({"type": "error", "message": f"subs failed: {type(ex).__name__}: {ex}"})
        return None
    if not text:
        return None
    emit({"type": "subs_found", "lang": lang, "with_ts": bool(with_ts), "chars": len(text)})
    emit({"type": "save_start", "kind": "subs"})
    fpath = write_text_file(out_dir, meta["id"], meta["title"], meta["channel"],
                            meta["webpage_url"], text, lang=lang, with_ts=with_ts)
    emit({"type": "saved", "file_path": fpath, "kind": "subs", "chars": len(text)})
    return fpath


def stage_ai(url, engine, out_dir, meta):
    audio_tmp = f"/tmp/yt_single_{meta['id']}.mp3"
    try:
        if os.path.exists(audio_tmp):
            os.remove(audio_tmp)
    except Exception:
        pass

    emit({"type": "audio_download_start", "engine": engine})

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
        emit({"type": "error", "message": "yt-dlp timeout (>10m)"})
        return None
    except subprocess.CalledProcessError as ex:
        tail = ex.stderr or b""
        if isinstance(tail, bytes):
            tail = tail.decode(errors="ignore")
        emit({"type": "error", "message": f"yt-dlp failed: {tail[-300:].strip()}"})
        return None

    if not os.path.exists(audio_tmp):
        emit({"type": "error", "message": "audio file missing after download"})
        return None

    emit({"type": "audio_download_done", "engine": engine,
          "bytes": os.path.getsize(audio_tmp)})
    emit({"type": "transcribe_start", "engine": engine})
    text, err, cost = None, None, 0.0
    try:
        with silenced():
            import gemini_utils
            client = gemini_utils.GeminiClient()
            text, err = client.transcribe_audio(audio_tmp, engine=engine)
            cost = client.calculate_cost() if engine == "gemini" else 0.0
    except Exception as ex:
        emit({"type": "error", "message": f"transcribe crashed: {type(ex).__name__}: {ex}"})
        return None
    finally:
        try: os.remove(audio_tmp)
        except Exception: pass

    if err or not text:
        emit({"type": "error", "message": f"transcribe failed: {err or 'empty result'}"})
        return None

    cost_r = round(float(cost or 0), 6)
    emit({"type": "transcribe_done", "engine": engine, "chars": len(text), "cost_usd": cost_r})
    emit({"type": "save_start", "kind": "ai"})
    fpath = write_text_file(out_dir, meta["id"], meta["title"], meta["channel"],
                            meta["webpage_url"], text, engine=engine)
    emit({"type": "saved", "file_path": fpath, "kind": "ai", "chars": len(text), "cost_usd": cost_r})
    return fpath


# ─── main ────────────────────────────────────────────────────────────────

def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--lang", default="ru")
    ap.add_argument("--with-ts", action="store_true")
    ap.add_argument("--captions-only", action="store_true",
                    help="Skip yt-dlp metadata when the caller only needs existing captions")
    ap.add_argument("--title", default="")
    ap.add_argument("--ai", action="store_true",
                    help="Force AI transcription (skip subs check)")
    ap.add_argument("--engine", default="gemini", choices=("gemini", "assemblyai"))
    args = ap.parse_args(argv)

    t0 = time.time()
    vid = extract_video_id(args.url)
    if not vid:
        emit({"type": "error", "message": f"Cannot extract video id from {args.url}"})
        return 2

    if args.captions_only and not args.ai:
        meta = {
            "id": vid,
            "title": args.title.strip() or vid,
            "duration_sec": 0,
            "channel": "",
            "channel_id": None,
            "channel_url": None,
            "uploader_id": None,
            "webpage_url": args.url,
        }
    else:
        emit({"type": "metadata_start"})
        with silenced():
            meta, meta_err = fetch_meta(args.url)
        if not meta or not meta.get("id"):
            emit({"type": "error", "message": f"yt-dlp metadata fetch failed: {meta_err or 'no metadata'}"})
            return 3
    emit({
        "type": "video",
        "video_id":     meta["id"],
        "title":        meta["title"],
        "duration_sec": meta["duration_sec"],
        "channel":      meta["channel"],
        "channel_id":   meta.get("channel_id"),
        "channel_url":  meta.get("channel_url"),
        "uploader_id":  meta.get("uploader_id"),
        "url":          meta["webpage_url"],
    })

    if not args.ai:
        fpath = stage_subs(args.url, args.lang, args.with_ts, args.out_dir, meta)
        if fpath:
            emit({"type": "done", "duration_sec": round(time.time() - t0, 2)})
            return 0
        dur = meta["duration_sec"] or 0
        est = round((dur / 3600.0) * 0.0125, 4) if dur else 0.005
        emit({"type": "subs_missing", "duration_sec": dur, "est_cost_usd": est})
        emit({"type": "done", "duration_sec": round(time.time() - t0, 2)})
        return 0

    fpath = stage_ai(args.url, args.engine, args.out_dir, meta)
    emit({"type": "done", "duration_sec": round(time.time() - t0, 2)})
    return 0 if fpath else 4


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(130)
    except Exception as ex:
        emit({"type": "error", "message": f"{type(ex).__name__}: {ex}"})
        sys.exit(1)
