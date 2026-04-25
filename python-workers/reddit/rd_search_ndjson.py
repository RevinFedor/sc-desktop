#!/usr/bin/env python3
"""Reddit search-source fetch for SC Desktop UI.

Backends:
  --backend api    (default)  reddit.com/search.json через browser cookies. $0.
  --backend auto   Сначала api, потом платный Apify fallback.
  --backend apify  Apify trudax-lite.

ndjson contract:
  {"type":"info",  "message":"..."}
  {"type":"entity","kind":"search","title":"<query>","subreddit":"r/.."|null,"id":"<query-hash>","url":"...","query":"..."}
  {"type":"item",  "data":{...}}
  {"type":"page",  "loaded":N}
  {"type":"done",  "items_total":N, "cost_usd":F}
  {"type":"error", "message":"..."}

Item.data shape:
  external_id   "post:<id>"
  type          "text"
  url           reddit URL поста
  title         заголовок
  caption       body / selftext (preview)
  date          ISO 8601
  likes         upvotes
  comments      кол-во комментов (без скачивания)
  sender        author
  has_media     bool (true when raw_meta.media has image URLs)
  raw_meta      { subreddit, flair, media[] }
"""
import sys
import json
import time
import argparse
import platform
import subprocess
import warnings
import hashlib
import re
import html
from pathlib import Path
from urllib.parse import quote_plus, urlparse

warnings.filterwarnings("ignore")

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
from reddit_auth import load_reddit_cookies


def emit(ev):
    sys.__stdout__.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")
    sys.__stdout__.flush()


def to_iso(unix_ts):
    if not unix_ts: return None
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(unix_ts)))
    except Exception:
        return None


def clean_subreddit(value):
    if not value:
        return None
    s = str(value).strip()
    s = re.sub(r"^https?://(?:www\.)?reddit\.com/", "", s, flags=re.I)
    s = s.strip("/")
    if s.lower().startswith("r/"):
        s = s[2:]
    s = s.strip("/")
    return s or None


IMAGE_URL_RE = re.compile(r"\.(?:jpe?g|png|webp|gif)(?:[?#].*)?$", re.I)
IMAGE_HOST_RE = re.compile(
    r"(^|\.)("
    r"redd\.it|redditmedia\.com|redditstatic\.com|imgur\.com|giphy\.com|tenor\.com"
    r")$",
    re.I,
)


def _clean_media_url(value):
    if not value:
        return None
    url = html.unescape(str(value)).strip()
    if not url.startswith("http"):
        return None
    return url


def _looks_like_image_url(url):
    if not url:
        return False
    if IMAGE_URL_RE.search(url):
        return True
    host = re.sub(r"^https?://([^/]+).*$", r"\1", url, flags=re.I).lower()
    return bool(IMAGE_HOST_RE.search(host)) and (
        "/media/" in url or "/image/" in url or "preview.redd.it" in host or "i.redd.it" in host
    )


def _push_media(out, seen, url, *, preview_url=None, width=None, height=None, source="reddit"):
    url = _clean_media_url(url)
    if not url or url in seen:
        return
    seen.add(url)
    item = {
        "kind": "image",
        "url": url,
        "preview_url": _clean_media_url(preview_url) or None,
        "source": source,
    }
    if width:
        item["width"] = width
    if height:
        item["height"] = height
    out.append(item)


def _media_variant_key(item):
    try:
        name = Path(urlparse(item.get("url") or "").path).name.lower()
    except Exception:
        name = ""
    if not name:
        return item.get("url") or ""
    return re.sub(r"\.(?:jpe?g|png|webp|gif)$", "", name)


def _media_variant_score(item):
    source = str(item.get("source") or "")
    try:
        host = urlparse(item.get("url") or "").hostname or ""
    except Exception:
        host = ""
    score = 0
    if host == "i.redd.it":
        score += 5
    if source == "url_overridden_by_dest":
        score += 4
    if source == "gallery":
        score += 3
    if source.startswith("preview"):
        score += 2
    if source == "thumbnail":
        score -= 5
    try:
        score += min(1, (int(item.get("width") or 0) * int(item.get("height") or 0)) / 10_000_000)
    except Exception:
        pass
    return score


def _dedupe_media_variants(items):
    best = {}
    order = []
    for item in items:
        key = _media_variant_key(item)
        if key not in best:
            best[key] = item
            order.append(key)
            continue
        if _media_variant_score(item) > _media_variant_score(best[key]):
            best[key] = item
    return [best[k] for k in order]


def extract_reddit_media(d):
    """Return best-effort image URLs from Reddit API/Apify post JSON."""
    out = []
    seen = set()

    preview = d.get("preview") if isinstance(d, dict) else None
    if isinstance(preview, dict):
        for img in preview.get("images") or []:
            src = (img.get("source") or {}) if isinstance(img, dict) else {}
            _push_media(
                out, seen, src.get("url"),
                width=src.get("width"), height=src.get("height"), source="preview",
            )
            variants = img.get("variants") if isinstance(img, dict) else None
            if isinstance(variants, dict):
                for variant_name in ("gif", "mp4"):
                    vsrc = ((variants.get(variant_name) or {}).get("source") or {})
                    _push_media(
                        out, seen, vsrc.get("url"),
                        width=vsrc.get("width"), height=vsrc.get("height"),
                        source=f"preview.{variant_name}",
                    )

    meta = d.get("media_metadata") if isinstance(d, dict) else None
    if isinstance(meta, dict):
        gallery_ids = []
        gallery = d.get("gallery_data")
        if isinstance(gallery, dict):
            gallery_ids = [x.get("media_id") for x in (gallery.get("items") or []) if x.get("media_id")]
        for media_id in gallery_ids or list(meta.keys()):
            m = meta.get(media_id) or {}
            src = m.get("s") or {}
            _push_media(
                out, seen, src.get("u") or src.get("gif") or src.get("mp4"),
                width=src.get("x"), height=src.get("y"), source="gallery",
            )

    for key in ("url_overridden_by_dest", "url", "image", "imageUrl", "thumbnail", "mediaUrl"):
        u = _clean_media_url(d.get(key))
        if u and _looks_like_image_url(u):
            _push_media(out, seen, u, source=key)

    for key in ("body", "body_html", "selftext", "selftext_html"):
        text = d.get(key)
        if not text:
            continue
        for u in re.findall(r"https?://[^\s<>'\")]+", html.unescape(str(text))):
            if _looks_like_image_url(u):
                _push_media(out, seen, u, source=key)

    for key in ("images", "media", "previewImages"):
        arr = d.get(key)
        if isinstance(arr, list):
            for x in arr:
                if isinstance(x, str):
                    if _looks_like_image_url(x):
                        _push_media(out, seen, x, source=key)
                elif isinstance(x, dict):
                    for subkey in ("url", "imageUrl", "src", "source"):
                        u = x.get(subkey)
                        if isinstance(u, dict):
                            u = u.get("url") or u.get("u")
                        if _looks_like_image_url(_clean_media_url(u)):
                            _push_media(out, seen, u, source=key)

    return _dedupe_media_variants(out)


def reddit_raw_meta(d, subreddit, flair):
    media = extract_reddit_media(d)
    return {
        "subreddit": subreddit,
        "flair": flair,
        "post_hint": d.get("post_hint"),
        "is_gallery": bool(d.get("is_gallery") or d.get("gallery_data")),
        "media": media,
    }


# ─── API backend ──────────────────────────────────────────────────────

UA_BROWSER = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def _api_search(query, subreddit, limit, sort, t):
    cookies, cookie_source = load_reddit_cookies()
    emit({"type": "info", "message": f"reddit cookies loaded from {cookie_source} ({len(cookies)} keys)"})

    if subreddit:
        sub = clean_subreddit(subreddit)
        json_url = (
            f"https://www.reddit.com/r/{sub}/search.json?"
            f"q={quote_plus(query)}&restrict_sr=1&sort={sort}&t={t}&limit={limit}"
        )
    else:
        json_url = (
            f"https://www.reddit.com/search.json?"
            f"q={quote_plus(query)}&sort={sort}&t={t}&limit={limit}"
        )

    try:
        r = requests.get(
            json_url,
            headers={"User-Agent": UA_BROWSER, "Accept": "application/json"},
            cookies=cookies,
            timeout=20,
        )
    except Exception as ex:
        raise RuntimeError(f"HTTP error: {ex}")

    if r.status_code != 200:
        raise RuntimeError(f"reddit.com returned HTTP {r.status_code}")

    try:
        data = r.json()
    except Exception as ex:
        raise RuntimeError(f"reddit.com response is not JSON: {ex}")

    children = data.get("data", {}).get("children", [])
    posts = []
    for c in children:
        if c.get("kind") != "t3":
            continue
        d = c.get("data", {})
        posts.append(d)
    return posts


def _emit_via_api(query, subreddit, limit, sort, t):
    posts = _api_search(query, subreddit, limit, sort, t)
    emit({"type": "info", "message": f"api: got {len(posts)} posts"})

    qhash = hashlib.sha1(
        (query + "|" + (subreddit or "") + "|" + sort + "|" + t).encode()
    ).hexdigest()[:8]
    handle = f"q-{qhash}"
    title = query if not subreddit else f"{query} (r/{subreddit})"
    sub_url = (
        f"https://www.reddit.com/r/{clean_subreddit(subreddit)}/search/?q={quote_plus(query)}&restrict_sr=1&sort={sort}&t={t}"
        if subreddit else
        f"https://www.reddit.com/search/?q={quote_plus(query)}&sort={sort}&t={t}"
    )
    emit({
        "type": "entity", "kind": "search",
        "title": title,
        "subreddit": f"r/{subreddit}" if subreddit else None,
        "id": handle, "url": sub_url, "query": query,
    })

    cnt = 0
    for p in posts:
        pid = p.get("id")
        if not pid: continue
        sub_name = p.get("subreddit") or "?"
        permalink = p.get("permalink") or ""
        media = extract_reddit_media(p)
        emit({"type": "item", "data": {
            "external_id": f"post:{pid}",
            "type": "text",
            "url":   ("https://www.reddit.com" + permalink) if permalink else "",
            "title": p.get("title", ""),
            "caption": (p.get("selftext") or "")[:2000],
            "date":  to_iso(p.get("created_utc")),
            "likes": p.get("score") or p.get("ups") or 0,
            "comments": p.get("num_comments") or 0,
            "sender": p.get("author") or "?",
            "has_media": bool(media),
            "raw_meta": reddit_raw_meta(p, f"r/{sub_name}", p.get("link_flair_text")),
            "parent_external_id": None, "depth": 0,
        }})
        cnt += 1

    emit({"type": "page", "loaded": cnt, "limit": limit})
    emit({"type": "done", "items_total": cnt, "cost_usd": 0.0})


# ─── Apify backend ────────────────────────────────────────────────────

APIFY_BASE = "https://api.apify.com/v2"
APIFY_ACTOR = "trudax~reddit-scraper-lite"


def _apify_token():
    tok = cfg.get_apify_token()
    if not tok:
        emit({"type": "error", "message": "Apify token не задан."})
        sys.exit(2)
    return tok


def _apify_run(token, payload, timeout_s=300):
    try:
        r = requests.post(
            f"{APIFY_BASE}/acts/{APIFY_ACTOR}/runs?token={token}",
            json=payload, timeout=20,
        )
    except Exception as ex:
        emit({"type": "error", "message": f"apify start failed: {ex}"}); sys.exit(3)
    if r.status_code >= 300:
        emit({"type": "error", "message": f"apify start HTTP {r.status_code}: {r.text[:300]}"}); sys.exit(3)
    run_id = r.json()["data"]["id"]
    emit({"type": "info", "message": f"apify run: {run_id}"})

    start = time.time()
    while time.time() - start < timeout_s:
        try:
            s = requests.get(f"{APIFY_BASE}/actor-runs/{run_id}?token={token}", timeout=15).json()["data"]
        except Exception:
            time.sleep(5); continue
        st = s.get("status")
        if st in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
            if st != "SUCCEEDED":
                emit({"type": "error", "message": f"apify run {st}"}); sys.exit(4)
            ds = s.get("defaultDatasetId")
            try:
                items = requests.get(f"{APIFY_BASE}/datasets/{ds}/items?token={token}", timeout=30).json()
            except Exception as ex:
                emit({"type": "error", "message": f"apify dataset fetch failed: {ex}"}); sys.exit(5)
            return items if isinstance(items, list) else items.get("items", []), s
        time.sleep(6)
    emit({"type": "error", "message": "apify run timeout"}); sys.exit(6)


def _emit_via_apify(query, subreddit, limit, sort, t):
    token = _apify_token()
    if subreddit:
        sub = clean_subreddit(subreddit)
        search_url = (
            f"https://www.reddit.com/r/{sub}/search/?q={quote_plus(query)}"
            f"&restrict_sr=1&sort={sort}&t={t}"
        )
    else:
        search_url = (
            f"https://www.reddit.com/search/?q={quote_plus(query)}&sort={sort}&t={t}"
        )

    payload = {
        "startUrls": [{"url": search_url}],
        "maxItems":      limit,
        "maxPostCount":  limit,
        "maxComments":   0,
        "maxCommunitiesCount": 0,
        "maxUserCount":        0,
        "sort": sort, "time": t,
        "searchPosts": True, "searchComments": False,
        "searchCommunities": False, "searchUsers": False,
        "proxy": {"useApifyProxy": True},
    }
    items, run = _apify_run(token, payload)
    posts = [x for x in items if x.get("dataType") == "post"]

    qhash = hashlib.sha1(
        (query + "|" + (subreddit or "") + "|" + sort + "|" + t).encode()
    ).hexdigest()[:8]
    handle = f"q-{qhash}"
    title = query if not subreddit else f"{query} (r/{subreddit})"
    emit({
        "type": "entity", "kind": "search",
        "title": title,
        "subreddit": f"r/{subreddit}" if subreddit else None,
        "id": handle, "url": search_url, "query": query,
    })

    cnt = 0
    for p in posts:
        pid = p.get("parsedId") or p.get("id")
        if not pid: continue
        sub_name = p.get("parsedCommunityName") or p.get("communityName") or "?"
        media = extract_reddit_media(p)
        emit({"type": "item", "data": {
            "external_id": f"post:{pid}",
            "type": "text",
            "url": p.get("url") or "",
            "title": p.get("title", ""),
            "caption": (p.get("body") or "")[:2000],
            "date": p.get("createdAt") or to_iso(p.get("created_utc")),
            "likes": p.get("upVotes") or 0,
            "comments": p.get("numberOfComments") or 0,
            "sender": p.get("username") or "?",
            "has_media": bool(media),
            "raw_meta": reddit_raw_meta(p, f"r/{sub_name}", p.get("flair")),
            "parent_external_id": None, "depth": 0,
        }})
        cnt += 1

    cost = run.get("usageTotalUsd") or 0
    emit({"type": "info", "message": f"apify cost: ${cost:.4f}"})
    emit({"type": "page", "loaded": cnt, "limit": limit})
    emit({"type": "done", "items_total": cnt, "cost_usd": float(cost)})


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", help="Поисковый запрос")
    ap.add_argument("--subreddit", default=None)
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--sort", default="relevance",
                    choices=["relevance", "top", "new", "hot", "comments"])
    ap.add_argument("--time", default="year",
                    choices=["all", "year", "month", "week", "day", "hour"])
    ap.add_argument("--backend", choices=["api", "auto", "apify"], default=None)
    args = ap.parse_args()
    args.subreddit = clean_subreddit(args.subreddit)

    backend = str(args.backend or cfg.get("reddit", "backend") or "api").lower()
    if backend not in ("api", "auto", "apify"):
        emit({"type": "info", "message": f"unknown reddit backend '{backend}', using api"})
        backend = "api"
    emit({"type": "info", "message":
          f"search: {args.query}" + (f" in r/{args.subreddit}" if args.subreddit else "")
          + f" (backend={backend})"})

    if backend == "api":
        try:
            _emit_via_api(args.query, args.subreddit, args.limit, args.sort, args.time)
            return
        except RuntimeError as ex:
            emit({"type": "error", "message": f"api backend failed: {ex}"})
            sys.exit(7)

    if backend == "auto":
        try:
            _emit_via_api(args.query, args.subreddit, args.limit, args.sort, args.time)
            return
        except RuntimeError as ex:
            emit({"type": "info", "message": f"api backend failed: {ex}"})
            emit({"type": "info", "message": "fallback → apify"})
            try:
                _emit_via_apify(args.query, args.subreddit, args.limit, args.sort, args.time)
            except SystemExit:
                raise
            except Exception as ex2:
                emit({"type": "error", "message": f"apify fallback also failed: {ex2}"})
                sys.exit(9)
    else:
        _emit_via_apify(args.query, args.subreddit, args.limit, args.sort, args.time)


if __name__ == "__main__":
    main()
