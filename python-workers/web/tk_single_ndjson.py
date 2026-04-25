#!/usr/bin/env python3
"""Streaming single-video TikTok transcript fetcher for SC Desktop.

Unlike YouTube, TikTok has no native subtitles → we always go straight to
AI transcription. No two-stage flow, no awaiting_ai state.

Pipeline (single spawn):
  1. TikWM API → play URL (no-watermark MP4)
  2. requests.get → MP4 file
  3. ffmpeg → AAC 16kHz mono .m4a
  4. Gemini → transcript text
  5. write .txt with header

Events:
  {"type": "info",            "message": "..."}
  {"type": "video",           "video_id": "...", "title": "...", "duration_sec": N,
                              "channel": "...", "url": "..."}
  {"type": "download_start"}
  {"type": "download_done",   "bytes": N}
  {"type": "transcribe_start","engine": "gemini"}
  {"type": "transcribe_done", "engine": "gemini", "chars": N, "cost_usd": F}
  {"type": "saved",           "file_path": "...", "kind": "ai", "chars": N, "cost_usd": F}
  {"type": "error",           "message": "..."}
  {"type": "done",            "duration_sec": 4.2}

Usage:
  tk_single_ndjson.py <url> --out-dir <dir> [--engine gemini|assemblyai]
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
import urllib.request
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "shared"))

TIKWM_API = "https://www.tikwm.com/api/"


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


@contextlib.contextmanager
def silenced():
    saved_out, saved_err = sys.stdout, sys.stderr
    try:
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        yield
    finally:
        sys.stdout = saved_out
        sys.stderr = saved_err


VIDEO_ID_RE = re.compile(r"tiktok\.com/@[\w.-]+/video/(\d+)")
SHORT_URL_RE = re.compile(r"^https?://(?:vt|vm)\.tiktok\.com/")


def extract_video_id(url):
    m = VIDEO_ID_RE.search(url or "")
    return m.group(1) if m else None


def resolve_short_url(short_url):
    """vt.tiktok.com/XXXX → real https://www.tiktok.com/@user/video/123 URL."""
    try:
        req = urllib.request.Request(short_url, headers={"User-Agent": "Mozilla/5.0"})
        opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler())
        with opener.open(req, timeout=10) as resp:
            return resp.geturl()
    except Exception:
        return short_url


def tikwm_video_info(url):
    """Returns (data_dict, error_msg). data_dict has play, duration, title, author, etc."""
    try:
        full = f"{TIKWM_API}?url={urllib.parse.quote(url)}&hd=1"
        req = urllib.request.Request(full, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            d = json.loads(resp.read())
        if d.get("code") != 0:
            return None, d.get("msg", "tikwm error")
        return d["data"], None
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def safe_slug(s, max_len=60):
    s = (s or "").strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"\s+", "_", s)
    return s[:max_len] or "untitled"


def write_text_file(out_dir, video_id, title, channel, video_url, body, engine="gemini"):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    fpath = out_dir / f"{video_id}__{safe_slug(title)}.txt"
    parts = [f"# {title}".rstrip()]
    if channel: parts.append(f"channel: {channel}")
    parts.append(f"url: {video_url}")
    parts.append(f"source: ai:{engine}")
    fpath.write_text("\n".join(parts) + "\n\n" + body, encoding="utf-8")
    return str(fpath)


def download_audio(play_url, out_audio_path):
    """Download MP4 → extract 16kHz mono m4a via ffmpeg. Returns bytes downloaded."""
    tmp_mp4 = out_audio_path + ".tmp.mp4"
    req = urllib.request.Request(play_url, headers={"User-Agent": "Mozilla/5.0"})
    size = 0
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp_mp4, "wb") as f:
        while True:
            chunk = resp.read(65536)
            if not chunk: break
            f.write(chunk)
            size += len(chunk)

    cmd = ["ffmpeg", "-y", "-i", tmp_mp4, "-vn", "-acodec", "aac",
           "-ar", "16000", "-ac", "1", out_audio_path]
    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=60)
    finally:
        try: os.remove(tmp_mp4)
        except Exception: pass

    return size


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--engine", default="gemini", choices=("gemini", "assemblyai"))
    args = ap.parse_args(argv)

    t0 = time.time()
    url = args.url

    # Resolve short URL if needed (cheap HEAD redirect)
    if SHORT_URL_RE.match(url):
        url = resolve_short_url(url)

    # ── Fetch metadata via TikWM ──────────────────────────────────────────
    data, err = tikwm_video_info(url)
    if not data:
        emit({"type": "error", "message": f"TikWM lookup failed: {err}"})
        return 2

    vid = str(data.get("id") or extract_video_id(url) or "")
    title = data.get("title") or ""
    duration = data.get("duration") or 0
    play_url = data.get("play") or data.get("hdplay")
    author = (data.get("author") or {}).get("unique_id") or ""

    if not play_url:
        emit({"type": "error", "message": "TikWM returned no play URL"})
        return 3

    emit({
        "type": "video",
        "video_id":     vid,
        "title":        title,
        "duration_sec": duration,
        "channel":      f"@{author}" if author else None,
        "url":          url,
    })

    # ── Download audio ────────────────────────────────────────────────────
    audio_tmp = f"/tmp/tk_single_{vid}.m4a"
    try:
        if os.path.exists(audio_tmp):
            os.remove(audio_tmp)
    except Exception:
        pass

    emit({"type": "download_start"})
    try:
        size = download_audio(play_url, audio_tmp)
        emit({"type": "download_done", "bytes": size})
    except subprocess.CalledProcessError as ex:
        tail = (ex.stderr or b"").decode(errors="ignore")[-300:]
        emit({"type": "error", "message": f"ffmpeg failed: {tail.strip()}"})
        return 4
    except Exception as ex:
        emit({"type": "error", "message": f"download failed: {type(ex).__name__}: {ex}"})
        return 5

    # ── Transcribe via Gemini/AssemblyAI ──────────────────────────────────
    emit({"type": "transcribe_start", "engine": args.engine})

    text, terr, cost = None, None, 0.0
    try:
        with silenced():
            import gemini_utils
            client = gemini_utils.GeminiClient()
            text, terr = client.transcribe_audio(audio_tmp, engine=args.engine)
            cost = client.calculate_cost() if args.engine == "gemini" else 0.0
    except Exception as ex:
        emit({"type": "error", "message": f"transcribe crashed: {type(ex).__name__}: {ex}"})
        return 6
    finally:
        try: os.remove(audio_tmp)
        except Exception: pass

    if terr or not text:
        emit({"type": "error", "message": f"transcribe failed: {terr or 'empty result'}"})
        return 7

    cost_r = round(float(cost or 0), 6)
    emit({"type": "transcribe_done", "engine": args.engine,
          "chars": len(text), "cost_usd": cost_r})

    fpath = write_text_file(args.out_dir, vid, title, f"@{author}" if author else None,
                            url, text, engine=args.engine)
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
