#!/usr/bin/env python3
"""Batch Instagram reel transcript fetcher for SC Desktop.

Two backends, picked per-job by --backend (no auto-fallback — failures
surface to the UI so the user decides):

  --backend api   (default)  Free path. Known profile: anonymous
                  clips/user/. Bare shortcode: authenticated media/<pk>/
                  info/. Both return video_url → curl → ffmpeg → AI.

  --backend apify Cloud path: apify_apple_yang scraper → audioUrl
                  ($0.001/reel) → curl → ffmpeg → Gemini. Use when api
                  rate-limits, when reels are private-but-shareable,
                  or when running on a cluster that can't hit IG mobile
                  endpoints directly.

Per-reel flow:
  1. resolve a media URL (api: video_url, apify: audioUrl)
  2. curl to /tmp
  3. ffmpeg → mp3 16kHz mono
  4. gemini_utils.transcribe_audio(file, engine="gemini") → text + cost
  5. Write text to <out-dir>/<shortcode>__<slug>.txt and emit `saved`.

ndjson contract — same shape as yt_batch_transcribe_ndjson.py so
job-runner.handleInstagramBatchEvent can stay tiny.

Usage:
  ig_batch_transcribe_ndjson.py
      --shortcodes ABC123,DEF456,...
      --out-dir <dir>
      [--backend api|apify]          (default api)
      [--engine gemini|assemblyai]   (default gemini)
"""
import sys
import os
import io
import re
import json
import time
import argparse
import contextlib
import platform
import subprocess
import warnings
from pathlib import Path

# macOS Tahoe + Electron spawn workaround.
if sys.platform == 'darwin':
    _v = platform.mac_ver()
    if not _v[0]:
        try:
            r = subprocess.check_output(['/usr/bin/sw_vers', '-productVersion'], text=True).strip()
        except Exception:
            r = '14.0'
        platform.mac_ver = lambda r=r: (r, ('', '', ''), platform.machine())

warnings.filterwarnings("ignore")

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "shared"))

import requests
import settings as cfg

APIFY_BASE      = "https://api.apify.com/v2"
APIFY_AUDIO_ACT = "apple_yang~instagram-transcripts-scraper"
AUDIO_NO_TEXT_CODE = "audio_no_text"
AUDIO_NO_TEXT_MESSAGE = "Аудиодорожка есть, но распознанного текста нет."


def emit(ev):
    sys.__stdout__.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")
    sys.__stdout__.flush()


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


def _slug(s):
    s = re.sub(r"\s+", "_", (s or "").strip())[:80]
    s = re.sub(r"[^\w.\-]", "", s)
    return s or "reel"


def write_text_file(out_dir, shortcode, caption, url, text, engine="gemini"):
    """Write a single transcript file, returns absolute path. Header is
    consistent with the YouTube/CLI format so consumers can copy without
    surprises."""
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    title_slug = _slug(caption[:60] if caption else shortcode)
    fname = f"{shortcode}__{title_slug}.txt"
    fpath = str(Path(out_dir) / fname)
    header = f"--- Instagram Reel · {shortcode} | {url or ''} ---\n"
    if caption:
        header += f"Caption: {caption.strip()}\n\n"
    body = (text or "").strip() + "\n"
    Path(fpath).write_text(header + body, encoding="utf-8")
    return fpath


def _apify_token():
    tok = cfg.get_apify_token()
    if not tok:
        emit({"type": "error", "message":
              "Apify token не задан. Открой Library → Instagram → задай токен."})
        sys.exit(2)
    return tok


# Keep anonymous and authenticated clients separate. Profile batches keep
# using the cookies-free endpoint; bare links opt into the saved API session.
_ig_clients = {}
def _get_ig_client(use_session=False):
    key = "session" if use_session else "anonymous"
    if key in _ig_clients:
        return _ig_clients[key]
    with silenced():
        from ig_api_core import IGAPIClient  # noqa: E402
        _ig_clients[key] = IGAPIClient(skip_session=not use_session)
    return _ig_clients[key]


def _api_get_video_url(shortcode, user_id, _cache):
    """Resolve a reel CDN URL without a paid fallback.

    A known profile keeps the anonymous clips/user/ path. A bare link uses
    the saved Android API cookie session and media/<pk>/info/.
    """
    if not user_id:
        try:
            client = _get_ig_client(use_session=True)
        except Exception as ex:
            return None, f"Android API: не удалось загрузить Instagram-сессию ({ex})"
        if not client.user_id:
            return None, (
                "Android API: Instagram-сессия не найдена. Выполни вход в "
                "настройках Instagram и нажми «Проверить»."
            )
        try:
            with silenced():
                media = client.get_media_info_by_shortcode(shortcode)
        except Exception as ex:
            return None, f"Android API: запрос ролика завершился ошибкой ({type(ex).__name__}: {ex})"
        if media and media.get("video_url"):
            return media["video_url"], None

        response = getattr(client, "last_response", None)
        status = getattr(response, "status_code", None)
        payload = client.last_json if isinstance(client.last_json, dict) else {}
        message = payload.get("message") or payload.get("error_type")
        if status in (401, 403) or "login" in str(message or "").lower():
            return None, (
                f"Android API: Instagram отклонил сохранённую сессию"
                f"{f' (HTTP {status})' if status else ''}. Перелогинься и проверь сессию."
            )
        detail = f"HTTP {status}" if status else (message or "пустой ответ")
        return None, f"Android API: Instagram не вернул ролик по этой ссылке ({detail})"

    try:
        client = _get_ig_client(use_session=False)
    except Exception as ex:
        return None, f"api: ig_api_core import failed ({ex})"

    cache_entry = _cache.setdefault(str(user_id), {"reels": {}, "exhausted": False, "max_id": ""})

    # Already seen on a previous call? Reels carry video_url already.
    hit = cache_entry["reels"].get(shortcode)
    if hit:
        return hit, None

    # Otherwise paginate clips/user/ until we find this shortcode (or run
    # out). Each page is ~12 reels; for a typical "transcribe last N
    # selected" batch we need ≤2 pages.
    while not cache_entry["exhausted"]:
        with silenced():
            data = client._request(
                "clips/user/",
                data={
                    "target_user_id": str(user_id),
                    "max_id": cache_entry["max_id"],
                    "page_size": 12,
                    "include_feed_video": "true",
                },
            )
        if not data:
            return None, ("api: clips/user/ returned empty "
                          "(private profile or rate-limit)")
        items = data.get("items") or []
        for item in items:
            media = item.get("media", item)
            extracted = client._extract_reel(media)
            if not extracted:
                continue
            sc = extracted.get("shortcode")
            url = extracted.get("video_url")
            if sc and url:
                cache_entry["reels"][sc] = url
        paging = data.get("paging_info") or {}
        cache_entry["max_id"] = paging.get("max_id") or ""
        if not paging.get("more_available") or not cache_entry["max_id"]:
            cache_entry["exhausted"] = True
        # Did the requested code show up in this page?
        if shortcode in cache_entry["reels"]:
            return cache_entry["reels"][shortcode], None

    return None, "api: shortcode not found in profile (deleted? archived?)"


def _apify_get_audio_url(shortcode, token):
    """Run apple_yang scraper for one reel, return signed audioUrl or None."""
    reel_url = f"https://www.instagram.com/reel/{shortcode}/"
    start = f"{APIFY_BASE}/acts/{APIFY_AUDIO_ACT}/runs?token={token}"
    try:
        r = requests.post(start, json={"videoUrl": reel_url}, timeout=30)
    except Exception as ex:
        return None, f"apify start failed: {ex}"
    if r.status_code != 201:
        return None, f"apify start HTTP {r.status_code}: {r.text[:200]}"
    run = r.json()["data"]
    run_id = run["id"]
    dataset_id = run.get("defaultDatasetId")

    poll = f"{APIFY_BASE}/actor-runs/{run_id}?token={token}"
    elapsed = 0
    while True:
        time.sleep(3)
        elapsed += 3
        try:
            r = requests.get(poll, timeout=30)
        except Exception:
            continue
        if r.status_code != 200:
            continue
        run = r.json()["data"]
        st = run["status"]
        if st in ("RUNNING", "READY"):
            continue
        if st == "SUCCEEDED":
            break
        return None, f"apify run {st}"

    ds = f"{APIFY_BASE}/datasets/{dataset_id}/items?token={token}&format=json"
    try:
        r = requests.get(ds, timeout=60)
    except Exception as ex:
        return None, f"apify dataset fetch failed: {ex}"
    if r.status_code != 200:
        return None, f"apify dataset HTTP {r.status_code}"
    records = r.json()
    if not records:
        return None, "apify returned empty dataset"
    audio_url = records[0].get("audioUrl") or records[0].get("videoUrl")
    if not audio_url:
        return None, "no audioUrl in apify response"
    return audio_url, None


def _download_and_convert(audio_url, mp3_path):
    """Download audio with curl, convert to 16kHz mono mp3 with ffmpeg.

    Returns (ok, error). Uses raw subprocess.run rather than requests so we
    don't pull the whole file into Python memory — reels are small (~1-5MB)
    but this keeps it consistent with the CLI."""
    raw = mp3_path + ".source"
    try:
        if os.path.exists(raw):  os.remove(raw)
        if os.path.exists(mp3_path): os.remove(mp3_path)
    except Exception:
        pass

    try:
        subprocess.run(
            ["/usr/bin/curl", "-sL", "-A", "Mozilla/5.0", "-o", raw, audio_url],
            check=True, timeout=120, capture_output=True,
        )
    except subprocess.TimeoutExpired:
        return False, "curl timeout (>2m)"
    except subprocess.CalledProcessError as ex:
        return False, f"curl failed: {(ex.stderr or b'').decode(errors='ignore')[-200:].strip()}"

    if not os.path.exists(raw) or os.path.getsize(raw) == 0:
        return False, "downloaded file is empty"

    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", raw, "-vn", "-ar", "16000", "-ac", "1",
             "-b:a", "64k", mp3_path],
            check=True, timeout=120, capture_output=True,
        )
    except subprocess.TimeoutExpired:
        return False, "ffmpeg timeout"
    except subprocess.CalledProcessError as ex:
        return False, f"ffmpeg failed: {(ex.stderr or b'').decode(errors='ignore')[-200:].strip()}"
    finally:
        try: os.remove(raw)
        except Exception: pass

    if not os.path.exists(mp3_path) or os.path.getsize(mp3_path) == 0:
        return False, "ffmpeg produced empty mp3"
    return True, None


def _transcription_failure(text, error, empty_text_error, cost_usd=0.0):
    """Return a stable worker error payload after media was prepared.

    A successful audio conversion followed by an empty model response is a
    valid media outcome, not a JSON parser crash. Keep the human message and
    machine code separate so Electron/iOS never need to match strings.
    """
    payload = {
        "cost_usd": round(float(cost_usd or 0), 6),
    }
    if not text and (not error or error == empty_text_error):
        payload.update({
            "code": AUDIO_NO_TEXT_CODE,
            "message": AUDIO_NO_TEXT_MESSAGE,
        })
        return payload
    payload.update({
        "code": None,
        "message": f"transcribe failed: {error or 'empty result'}",
    })
    return payload


def process_one(i, n, shortcode, caption, args, token, totals, api_cache):
    reel_url = f"https://www.instagram.com/reel/{shortcode}/"
    emit({"type": "item_start", "i": i, "n": n,
          "video_id": shortcode, "url": reel_url,
          "title": (caption or "")[:80], "duration_sec": None, "channel": None})

    # Resolve a media URL via the chosen backend. No auto-fallback —
    # the user picked the path, errors surface to the UI.
    resolve_mode = (
        "profile_clips" if args.user_id else "shortcode_session"
    ) if args.backend == "api" else "apify"
    emit({"type": "resolve_start", "i": i, "video_id": shortcode,
          "backend": args.backend, "mode": resolve_mode})
    if args.backend == "api":
        media_url, err = _api_get_video_url(shortcode, args.user_id, api_cache)
    else:
        media_url, err = _apify_get_audio_url(shortcode, token)

    if err or not media_url:
        emit({"type": "item_error", "i": i, "video_id": shortcode,
              "message": err or "no media url"})
        totals["errors"] += 1
        return

    emit({"type": "resolve_done", "i": i, "video_id": shortcode,
          "backend": args.backend, "mode": resolve_mode})
    mp3 = f"/tmp/ig_batch_{shortcode}.mp3"
    emit({"type": "download_start", "i": i, "video_id": shortcode})
    ok, derr = _download_and_convert(media_url, mp3)
    if not ok:
        emit({"type": "item_error", "i": i, "video_id": shortcode,
              "message": derr or "download failed"})
        totals["errors"] += 1
        return

    emit({"type": "download_done", "i": i, "video_id": shortcode,
          "bytes": os.path.getsize(mp3) if os.path.exists(mp3) else 0})
    emit({"type": "transcribe_start", "i": i, "video_id": shortcode, "engine": args.engine})

    text, terr, cost = None, None, 0.0
    try:
        with silenced():
            import gemini_utils
            client = gemini_utils.GeminiClient()
            text, terr = client.transcribe_audio(mp3, engine=args.engine)
            cost = client.calculate_cost() if args.engine == "gemini" else 0.0
    except Exception as ex:
        emit({"type": "item_error", "i": i, "video_id": shortcode,
              "message": f"transcribe crashed: {type(ex).__name__}: {ex}"})
        totals["errors"] += 1
        try: os.remove(mp3)
        except Exception: pass
        return
    finally:
        try: os.remove(mp3)
        except Exception: pass

    if terr or not text:
        failure = _transcription_failure(
            text,
            terr,
            gemini_utils.EMPTY_TEXT_ERROR,
            cost_usd=cost,
        )
        event = {
            "type": "item_error",
            "i": i,
            "video_id": shortcode,
            "message": failure["message"],
            "cost_usd": failure["cost_usd"],
        }
        if failure["code"]:
            event["code"] = failure["code"]
        emit(event)
        totals["errors"] += 1
        totals["cost_usd"] += failure["cost_usd"]
        return

    cost_r = round(float(cost or 0), 6)
    emit({"type": "transcribe_done", "i": i, "video_id": shortcode,
          "engine": args.engine, "chars": len(text), "cost_usd": cost_r})

    emit({"type": "save_start", "i": i, "video_id": shortcode})
    fpath = write_text_file(args.out_dir, shortcode, caption, reel_url, text, engine=args.engine)
    emit({"type": "saved", "i": i, "video_id": shortcode,
          "file_path": fpath, "kind": "ai", "chars": len(text),
          "cost_usd": cost_r})
    totals["saved"]    += 1
    totals["cost_usd"] += cost_r


def parse_shortcodes(raw):
    out = []
    for piece in (raw or "").split(","):
        s = piece.strip()
        if not s:
            continue
        # If a full URL was passed, extract /reel/<code>/ or /p/<code>/.
        m = re.search(r"/(?:reel|p)/([A-Za-z0-9_-]+)/?", s)
        if m:
            out.append(m.group(1))
        else:
            out.append(s)
    return out


def parse_captions(raw):
    """Optional --captions CSV passes a parallel list of captions so the
    transcript file header stays informative without us hitting Apify a
    second time. Empty string = no caption for that reel."""
    if not raw:
        return []
    # Use a separator unlikely to appear in captions.
    return raw.split("") if "" in raw else raw.split("|||")


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--shortcodes", required=True,
                    help="comma-separated reel shortcodes or URLs")
    ap.add_argument("--captions", default=None,
                    help="optional pipe-separated (|||) captions, parallel to --shortcodes")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--backend", default="api", choices=("api", "apify"),
                    help="api: cookies-free mobile endpoint (default). "
                         "apify: apple_yang scraper (~$0.001/reel).")
    ap.add_argument("--user-id", default=None,
                    help="optional profile pk for the anonymous clips/user/ "
                         "path; without it api resolves shortcode through "
                         "the saved Instagram session.")
    ap.add_argument("--engine", default="gemini", choices=("gemini", "assemblyai"))
    args = ap.parse_args(argv)

    items = parse_shortcodes(args.shortcodes)
    captions = parse_captions(args.captions)
    n = len(items)
    if n == 0:
        emit({"type": "error", "message": "no valid shortcodes"})
        return 2

    # Token is mandatory for apify backend, irrelevant for api. Fail fast
    # so the user knows before any reels start downloading.
    token = _apify_token() if args.backend == "apify" else None
    totals = {"saved": 0, "skipped": 0, "errors": 0, "cost_usd": 0.0}
    started = time.monotonic()

    # Per-user cache of paginated reel listings — re-using one client for
    # the whole batch means shortcode #2 hits the cache from shortcode #1.
    api_cache = {}

    for i, code in enumerate(items, 1):
        cap = captions[i - 1] if i - 1 < len(captions) else ""
        try:
            process_one(i, n, code, cap, args, token, totals, api_cache)
        except KeyboardInterrupt:
            emit({"type": "error", "message": "interrupted"})
            break
        except Exception as ex:
            emit({"type": "item_error", "i": i, "video_id": code,
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
