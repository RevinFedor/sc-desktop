#!/usr/bin/env python3
"""Instagram profile fetch for SC Desktop UI.

Emits ndjson events. One spawn per fetch. Backends:

  --backend apify      (default in UI)  Apify cloud actor.
                       Tokens read from ~/.config/sc/settings.json
                       (instagram.apify_token), legacy fallback to
                       ~/.config/sc/apify_token.
  --backend android    Android private API via cookies in
                       ~/.config/sc/instagram_api_session.json.
                       Reels-only. Posts mode falls through to error.

Modes:
  --mode reels   only reels (clips)
  --mode posts   only photo/video timeline posts
  --mode both    both reels and posts (interleaved is fine —
                 they're stored under different external_id prefixes)

ndjson contract (matches fact-ipc.md):
  {"type":"info",  "message":"..."}
  {"type":"entity","kind":"profile","title":"…","username":"…","id":<num>}
  {"type":"page",  "loaded":N,"limit":L}      # progress, every page
  {"type":"item",  "data":{ ... }}            # one per reel/post
  {"type":"done",  "items_total":N}
  {"type":"error", "message":"..."}

Item.data shape (consumed by job-runner.handleEvent → bulkUpsertItems):
  external_id   "reel:<shortcode>" | "post:<shortcode>"
  type          "video" | "photo"
  url           https://www.instagram.com/reel/<code>/  (or /p/<code>/)
  title         null
  caption       text
  date          "YYYY-MM-DDTHH:MM:SSZ" or null
  duration_sec  float | null    (videos only)
  views         int | null
  likes         int | null
  comments      int | null
  has_media     1
"""
import sys
import os
import io
import json
import time
import argparse
import contextlib
import platform
import subprocess
import warnings
from pathlib import Path

# Silence urllib3 + requests certificate warnings so they don't leak into
# stderr (which the job-runner tail-captures and surfaces as job error).
warnings.filterwarnings("ignore")

# macOS Tahoe + Electron spawn workaround (see fix-telethon-electron-spawn.md).
if sys.platform == 'darwin':
    _v = platform.mac_ver()
    if not _v[0]:
        try:
            r = subprocess.check_output(['/usr/bin/sw_vers', '-productVersion'], text=True).strip()
        except Exception:
            r = '14.0'
        platform.mac_ver = lambda r=r: (r, ('', '', ''), platform.machine())

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "shared"))

import requests
import settings as cfg


def emit(ev):
    sys.__stdout__.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")
    sys.__stdout__.flush()


@contextlib.contextmanager
def silenced():
    """Swallow noisy stdout/stderr from imported CLI helpers (ig_api_core
    has print_info/print_error that write coloured text to stdout). ndjson
    contract requires emit() to be the only stdout writer — we route emit
    through sys.__stdout__ so it bypasses this redirect."""
    saved_out, saved_err = sys.stdout, sys.stderr
    try:
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        yield
    finally:
        sys.stdout = saved_out
        sys.stderr = saved_err


# ─── Apify backend ─────────────────────────────────────────────────────

# Reel scraper actor: takes username/profile URL, returns reel metadata
# with direct CDN videoUrl. ~$0.0026 / reel + minimal overhead.
APIFY_REEL_ACTOR = "apify~instagram-reel-scraper"

# Post scraper actor: profile feed (photos + videos), captions, counts.
# ~$2.30 / 1k posts at the time of this writing.
APIFY_POST_ACTOR = "apify~instagram-post-scraper"

APIFY_BASE = "https://api.apify.com/v2"


def _apify_token():
    tok = cfg.get_apify_token()
    if not tok:
        emit({"type": "error", "message":
              "Apify token не задан. Открой Library → Instagram → задай токен или переключи backend."})
        sys.exit(2)
    return tok


def _apify_run_actor(actor_id, token, input_payload):
    """Start a run with input, poll until SUCCEEDED, return dataset items.

    Polls every 3s. Apify single-actor runs typically finish in 5-30s for
    moderate inputs. We pump status to UI as `info` events so the user
    isn't staring at a blank progress bar."""
    url = f"{APIFY_BASE}/acts/{actor_id}/runs?token={token}"
    try:
        r = requests.post(url, json=input_payload, timeout=30)
    except Exception as ex:
        emit({"type": "error", "message": f"Apify start failed: {type(ex).__name__}: {ex}"})
        sys.exit(2)
    if r.status_code != 201:
        emit({"type": "error", "message": f"Apify start: HTTP {r.status_code} {r.text[:200]}"})
        sys.exit(2)
    run = r.json()["data"]
    run_id = run["id"]
    dataset_id = run.get("defaultDatasetId")
    emit({"type": "info", "message": f"Apify run {run_id} started"})

    # Poll status.
    poll_url = f"{APIFY_BASE}/actor-runs/{run_id}?token={token}"
    elapsed = 0
    while True:
        time.sleep(3)
        elapsed += 3
        try:
            r = requests.get(poll_url, timeout=30)
        except Exception as ex:
            emit({"type": "info", "message": f"Apify poll error (will retry): {ex}"})
            continue
        if r.status_code != 200:
            emit({"type": "info", "message": f"Apify poll HTTP {r.status_code}"})
            continue
        run = r.json()["data"]
        status = run["status"]
        if status in ("RUNNING", "READY"):
            if elapsed % 15 == 0:
                emit({"type": "info", "message": f"Apify {status} {elapsed}s"})
            continue
        if status == "SUCCEEDED":
            break
        emit({"type": "error", "message": f"Apify run finished as {status}"})
        sys.exit(2)

    # Fetch dataset items.
    ds_url = f"{APIFY_BASE}/datasets/{dataset_id}/items?token={token}&format=json"
    try:
        r = requests.get(ds_url, timeout=60)
    except Exception as ex:
        emit({"type": "error", "message": f"Apify dataset fetch failed: {ex}"})
        sys.exit(2)
    if r.status_code != 200:
        emit({"type": "error", "message": f"Apify dataset HTTP {r.status_code}"})
        sys.exit(2)
    return r.json()


def _normalize_apify_reel(it):
    """Map an apify reel-scraper record to our ndjson item.data shape."""
    code = it.get("shortCode") or it.get("shortcode") or ""
    if not code:
        return None
    ts = it.get("timestamp")  # ISO already
    return {
        "external_id":  f"reel:{code}",
        "type":         "video",
        "url":          f"https://www.instagram.com/reel/{code}/",
        "title":        None,
        "caption":      it.get("caption") or "",
        "date":         ts,
        "duration_sec": it.get("videoDuration") or None,
        "views":        it.get("videoPlayCount") or it.get("videoViewCount") or None,
        "likes":        it.get("likesCount") or None,
        "comments":     it.get("commentsCount") or None,
        "has_media":    1,
    }


def _normalize_apify_post(it):
    """Map an apify post-scraper record (or videoUrl-bearing reel) to our shape."""
    code = it.get("shortCode") or it.get("shortcode") or ""
    if not code:
        return None
    ts = it.get("timestamp")
    is_video = bool(it.get("videoUrl") or it.get("type") == "Video")
    return {
        "external_id":  f"post:{code}",
        "type":         "video" if is_video else "photo",
        "url":          f"https://www.instagram.com/p/{code}/",
        "title":        None,
        "caption":      it.get("caption") or "",
        "date":         ts,
        "duration_sec": it.get("videoDuration") or None,
        "views":        it.get("videoPlayCount") or None,
        "likes":        it.get("likesCount") or None,
        "comments":     it.get("commentsCount") or None,
        "has_media":    1,
    }


def run_apify(username, mode, limit):
    token = _apify_token()
    profile_url = f"https://www.instagram.com/{username}/"
    emit({"type": "info", "message": f"Apify backend, target {profile_url}"})

    # Apify needs a `username` in entity even before items arrive — emit a
    # minimal entity now so the UI gets a Library row immediately. The CLI
    # tools read display_name from this; we don't have it yet (would need
    # a separate API call), so handle == username == display.
    emit({"type": "entity", "kind": "profile",
          "username": username, "title": username, "id": None})

    items_total = 0
    fetched = []

    if mode in ("reels", "both"):
        payload = {"username": [username]}
        if limit and limit > 0:
            payload["resultsLimit"] = int(limit)
        records = _apify_run_actor(APIFY_REEL_ACTOR, token, payload)
        for rec in records:
            row = _normalize_apify_reel(rec)
            if row:
                fetched.append(row)
        emit({"type": "page", "loaded": len(fetched), "limit": None})

    if mode in ("posts", "both"):
        payload = {
            "username": [username],
            "resultsType": "posts",
        }
        if limit and limit > 0:
            payload["resultsLimit"] = int(limit)
        records = _apify_run_actor(APIFY_POST_ACTOR, token, payload)
        before = len(fetched)
        for rec in records:
            row = _normalize_apify_post(rec)
            if row:
                fetched.append(row)
        emit({"type": "page", "loaded": len(fetched), "limit": None})

    # Deduplicate (post-scraper sometimes also returns reels under /p/code).
    seen = set()
    deduped = []
    for r in fetched:
        if r["external_id"] in seen:
            continue
        seen.add(r["external_id"])
        deduped.append(r)

    for row in deduped:
        emit({"type": "item", "data": row})
        items_total += 1

    emit({"type": "done", "items_total": items_total})


# ─── api backend (mobile endpoints, no cookies needed) ────────────────
#
# Public reels of public profiles are returned by i.instagram.com/api/v1/
# clips/user/ when called with just User-Agent: Instagram and X-IG-App-ID.
# That's what IGAPIClient does — we just disable session loading so this
# script stays stateless.
#
# Private profiles return login_required → we surface that as an error.

def run_api(username, mode, limit):
    if mode in ("posts", "both"):
        emit({"type": "error", "message":
              "Backend api пока умеет только Reels. Для Posts используй Apify."})
        sys.exit(2)

    # Lazy import — silenced() because ig_api_core.py prints to stdout on
    # import. Stateless client: no cookies, no session file.
    try:
        with silenced():
            from ig_api_core import IGAPIClient  # noqa: E402
            client = IGAPIClient(skip_session=True)
    except Exception as ex:
        emit({"type": "error", "message":
              f"api backend unavailable: ig_api_core import failed ({ex})"})
        sys.exit(2)

    with silenced():
        info = client.get_user_profile(username)
    if not info:
        emit({"type": "error", "message":
              f"User @{username} not found (private profile? — try Apify)"})
        sys.exit(2)

    emit({"type": "entity", "kind": "profile",
          "username": info.get("username") or username,
          "title": info.get("full_name") or info.get("username") or username,
          "id": info.get("pk")})

    amount = int(limit or 0)
    with silenced():
        reels = client.get_user_reels_by_username(username, amount=amount)
    if not reels:
        emit({"type": "info", "message": "Reels not found (or session expired)"})

    items_total = 0
    for r in reels:
        code = r.get("shortcode")
        if not code:
            continue
        emit({"type": "item", "data": {
            "external_id":  f"reel:{code}",
            "type":         "video",
            "url":          r.get("url") or f"https://www.instagram.com/reel/{code}/",
            "title":        None,
            "caption":      r.get("caption") or "",
            "date":         r.get("date"),
            "duration_sec": r.get("duration") or None,
            "views":        r.get("play_count") or None,
            "likes":        r.get("like_count") or None,
            "comments":     r.get("comment_count") or None,
            "has_media":    1,
        }})
        items_total += 1
        if items_total % 12 == 0:
            emit({"type": "page", "loaded": items_total, "limit": None})

    emit({"type": "done", "items_total": items_total})


# ─── entrypoint ────────────────────────────────────────────────────────

def _normalize_target(t):
    """Strip @, https://www.instagram.com/, trailing slashes."""
    s = (t or "").strip()
    s = s.replace("https://www.instagram.com/", "").replace("https://instagram.com/", "")
    s = s.lstrip("@").rstrip("/")
    if "/" in s:
        s = s.split("/", 1)[0]
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    # `android` kept as a back-compat alias for `api` (the same code path)
    # so older invocations don't blow up while we migrate the UI/settings.
    ap.add_argument("--backend", choices=("api", "apify", "android"), required=True)
    ap.add_argument("--mode", choices=("reels", "posts", "both"), default="reels")
    ap.add_argument("--limit", type=int, default=50)
    args = ap.parse_args()

    username = _normalize_target(args.target)
    if not username:
        emit({"type": "error", "message": "empty target"})
        sys.exit(2)

    try:
        if args.backend == "apify":
            run_apify(username, args.mode, args.limit)
        else:
            # api (and legacy alias android) — both go through the same
            # cookies-free IGAPIClient path.
            run_api(username, args.mode, args.limit)
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(130)
    except Exception as ex:
        emit({"type": "error", "message": f"{type(ex).__name__}: {ex}"})
        sys.exit(2)


if __name__ == "__main__":
    main()
