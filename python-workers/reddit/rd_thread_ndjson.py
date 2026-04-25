#!/usr/bin/env python3
"""Reddit thread fetch for SC Desktop UI.

Backends:
  --backend api    (default)  Прямой reddit.com/.../*.json через залогиненные
                              browser cookies. Бесплатно, мгновенно.
                              Если cookies нет/протухли → error без оплаты.
  --backend auto   Сначала api, потом платный Apify fallback.
  --backend apify  Apify trudax~reddit-scraper-lite (fallback).
                   ~$0.20/тред. Использовать если cookies не работают.

Один тред (URL поста) → пост + дерево комментариев.

ndjson contract:
  {"type":"info",  "message":"..."}
  {"type":"entity","kind":"thread","title":"...","subreddit":"r/...","id":"<post_id>","author":"...","url":"..."}
  {"type":"page",  "loaded":N, "limit":L}
  {"type":"item",  "data":{...}}
  {"type":"done",  "items_total":N, "cost_usd":F}
  {"type":"error", "message":"..."}

Item.data shape (одинаковый для обоих backends):
  external_id      "post:<id>" | "comment:<id>"
  type             "text" (для постов) | "comment" (для комментариев)
  url              full reddit URL
  title            заголовок поста (только для постов)
  caption          body / selftext / comment text
  date             ISO 8601
  likes            score (upvotes)
  comments         num_comments (только для постов)
  parent_external_id  "post:<id>" / "comment:<id>" / NULL (только для комментов)
  depth            0 (post) | 1+ (comment depth)
  sender           author username
  has_media        bool (true when raw_meta.media has image URLs)
"""
import sys
import json
import time
import argparse
import platform
import subprocess
import warnings
import re
import html
from pathlib import Path

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
from urllib.parse import urlparse


def emit(ev):
    sys.__stdout__.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")
    sys.__stdout__.flush()


# ─── Helpers ──────────────────────────────────────────────────────────

def normalize_url(url: str) -> str:
    url = url.strip()
    if not url.startswith("http"):
        url = "https://www.reddit.com" + ("/" if not url.startswith("/") else "") + url
    # Убираем query/anchor
    url = re.sub(r"[?#].*$", "", url)
    # Гарантируем trailing slash
    if not url.endswith("/"):
        url += "/"
    return url


def to_iso(unix_ts):
    if not unix_ts:
        return None
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(unix_ts)))
    except Exception:
        return None


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


def reddit_raw_meta(d, subreddit=None, flair=None):
    return {
        "subreddit": subreddit,
        "flair": flair,
        "post_hint": d.get("post_hint") if isinstance(d, dict) else None,
        "is_gallery": bool(isinstance(d, dict) and (d.get("is_gallery") or d.get("gallery_data"))),
        "media": extract_reddit_media(d),
    }


# ─── API backend (reddit.com/*.json + browser cookies) ────────────────

UA_BROWSER = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def _api_fetch_thread(url, max_comments):
    """Fetch via reddit.com JSON. Returns (post, comments_list) or raises."""
    try:
        cookies, cookie_source = load_reddit_cookies()
    except Exception as ex:
        raise RuntimeError(
            f"Не удалось загрузить залогиненные cookies reddit.com: {ex}. "
            "Открой Reddit в поддерживаемом браузере и залогинься, либо явно выбери backend=auto/apify."
        )
    emit({"type": "info", "message": f"reddit cookies loaded from {cookie_source} ({len(cookies)} keys)"})

    json_url = url.rstrip("/") + f".json?limit={max(max_comments, 50)}&depth=10&showmore=false"
    try:
        r = requests.get(
            json_url,
            headers={"User-Agent": UA_BROWSER, "Accept": "application/json"},
            cookies=cookies,
            timeout=20,
            allow_redirects=True,
        )
    except Exception as ex:
        raise RuntimeError(f"HTTP error: {ex}")

    if r.status_code != 200:
        raise RuntimeError(f"reddit.com returned HTTP {r.status_code} (len={len(r.text)})")

    try:
        data = r.json()
    except Exception as ex:
        raise RuntimeError(f"reddit.com response is not JSON: {ex}")

    if not isinstance(data, list) or len(data) < 2:
        raise RuntimeError(f"unexpected JSON shape: {type(data).__name__}")

    post_listing = data[0]["data"]["children"]
    if not post_listing:
        raise RuntimeError("post listing empty")
    post = post_listing[0]["data"]

    # Walk comments tree
    comments = []
    def walk(children, parent_eid, depth):
        for c in children:
            kind = c.get("kind")
            d = c.get("data", {})
            if kind == "more":
                # placeholder for unloaded — пропускаем (не разворачиваем `morechildren`)
                continue
            if kind != "t1":
                continue
            cid = d.get("id")
            if not cid:
                continue
            comments.append({
                "id": cid,
                "parent_eid": parent_eid,
                "depth": depth,
                "body": d.get("body") or "",
                "score": d.get("score") or d.get("ups") or 0,
                "author": d.get("author") or "?",
                "created_utc": d.get("created_utc"),
                "permalink": d.get("permalink"),
                "media": extract_reddit_media(d),
            })
            replies = d.get("replies")
            if replies and isinstance(replies, dict):
                walk(replies["data"]["children"],
                     parent_eid=f"comment:{cid}",
                     depth=depth + 1)

    post_eid = f"post:{post['id']}"
    walk(data[1]["data"]["children"], parent_eid=post_eid, depth=1)

    # Cap at max_comments (DFS-order — первые N топовых веток)
    if len(comments) > max_comments:
        comments = comments[:max_comments]

    return post, comments


def _emit_via_api(url, max_comments):
    """API path: emit entity + items + done. Raises on any failure."""
    post, comments = _api_fetch_thread(url, max_comments)

    pid = post["id"]
    post_eid = f"post:{pid}"
    sub = post.get("subreddit", "?")
    title = post.get("title") or "(без заголовка)"
    author = post.get("author") or "?"

    emit({
        "type": "entity",
        "kind": "thread",
        "title": title,
        "subreddit": f"r/{sub}",
        "id": pid,
        "author": author,
        "url": url,
    })

    # Сам пост
    body = post.get("selftext") or ""
    media = extract_reddit_media(post)
    emit({"type": "item", "data": {
        "external_id": post_eid,
        "type": "text",
        "url":  url,
        "title": title,
        "caption": body,
        "date":  to_iso(post.get("created_utc")),
        "likes": post.get("score") or post.get("ups") or 0,
        "comments": post.get("num_comments") or 0,
        "sender": author,
        "has_media": bool(media),
        "raw_meta": reddit_raw_meta(post, f"r/{sub}", post.get("link_flair_text")),
        "parent_external_id": None,
        "depth": 0,
    }})

    items_total = 1
    for c in comments:
        ceid = f"comment:{c['id']}"
        emit({"type": "item", "data": {
            "external_id": ceid,
            "type": "comment",
            "url":   ("https://www.reddit.com" + c["permalink"]) if c.get("permalink") else "",
            "title": None,
            "caption": c["body"],
            "date":  to_iso(c.get("created_utc")),
            "likes": c["score"],
            "comments": None,
            "sender": c["author"],
            "has_media": bool(c.get("media")),
            "raw_meta": {"media": c.get("media") or []},
            "parent_external_id": c["parent_eid"],
            "depth": c["depth"],
        }})
        items_total += 1

    emit({"type": "page", "loaded": items_total, "limit": items_total})
    emit({"type": "done", "items_total": items_total, "cost_usd": 0.0})


# ─── Apify backend ────────────────────────────────────────────────────

APIFY_BASE = "https://api.apify.com/v2"
APIFY_ACTOR = "trudax~reddit-scraper-lite"


def _apify_token():
    tok = cfg.get_apify_token()
    if not tok:
        emit({"type": "error", "message":
              "Apify token не задан. Открой Library → Instagram → задай токен."})
        sys.exit(2)
    return tok


def _apify_run(token, payload, timeout_s=300):
    try:
        r = requests.post(
            f"{APIFY_BASE}/acts/{APIFY_ACTOR}/runs?token={token}",
            json=payload, timeout=20,
        )
    except Exception as ex:
        emit({"type": "error", "message": f"apify start failed: {ex}"})
        sys.exit(3)
    if r.status_code >= 300:
        emit({"type": "error", "message": f"apify start HTTP {r.status_code}: {r.text[:300]}"})
        sys.exit(3)
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
                emit({"type": "error", "message": f"apify run {st}"})
                sys.exit(4)
            ds = s.get("defaultDatasetId")
            try:
                items = requests.get(
                    f"{APIFY_BASE}/datasets/{ds}/items?token={token}", timeout=30,
                ).json()
            except Exception as ex:
                emit({"type": "error", "message": f"apify dataset fetch failed: {ex}"})
                sys.exit(5)
            return items if isinstance(items, list) else items.get("items", []), s
        time.sleep(6)
    emit({"type": "error", "message": "apify run timeout"})
    sys.exit(6)


def _emit_via_apify(url, max_comments):
    token = _apify_token()
    payload = {
        "startUrls": [{"url": url}],
        "maxItems":      max_comments + 5,
        "maxPostCount":  1,
        "maxComments":   max_comments,
        "maxCommunitiesCount": 0,
        "maxUserCount":        0,
        "sort": "top",
        "time": "all",
        "searchPosts": True, "searchComments": False,
        "searchCommunities": False, "searchUsers": False,
        "proxy": {"useApifyProxy": True},
    }
    items, run = _apify_run(token, payload)
    posts = [x for x in items if x.get("dataType") == "post"]
    comments = [x for x in items if x.get("dataType") == "comment"]
    if not posts:
        emit({"type": "error", "message": "no post in apify dataset"})
        sys.exit(8)

    p = posts[0]
    sub = p.get("parsedCommunityName") or p.get("communityName", "?")
    title = p.get("title", "")[:120] or "(без заголовка)"
    pid = p.get("parsedId") or p.get("id") or "?"
    author = p.get("username") or "?"

    emit({
        "type": "entity", "kind": "thread", "title": title,
        "subreddit": f"r/{sub}", "id": pid, "author": author, "url": url,
    })

    post_eid = f"post:{pid}"
    body = p.get("body") or p.get("html") or ""
    iso_date = p.get("createdAt") or to_iso(p.get("created_utc"))
    media = extract_reddit_media(p)
    emit({"type": "item", "data": {
        "external_id": post_eid, "type": "text",
        "url": p.get("url", url), "title": p.get("title"),
        "caption": body, "date": iso_date,
        "likes": p.get("upVotes") or p.get("score") or 0,
        "comments": p.get("numberOfComments") or 0,
        "sender": author, "has_media": bool(media),
        "raw_meta": reddit_raw_meta(p, f"r/{sub}", p.get("flair")),
        "parent_external_id": None, "depth": 0,
    }})

    # depth via BFS from post_eid
    cmap = {}
    for c in comments:
        cid = c.get("parsedId") or c.get("id")
        if not cid: continue
        parent_raw = (c.get("parentId") or c.get("parent_id") or "").strip()
        if parent_raw.startswith("t3_"):    pe = post_eid
        elif parent_raw.startswith("t1_"):  pe = f"comment:{parent_raw[3:]}"
        else:                                pe = post_eid
        cmap[cid] = {"item": c, "parent_eid": pe}

    depth_map = {post_eid: 0}
    changed = True; iters = 0
    while changed and iters < 30:
        changed = False; iters += 1
        for cid, meta in cmap.items():
            ceid = f"comment:{cid}"
            if ceid in depth_map: continue
            if meta["parent_eid"] in depth_map:
                depth_map[ceid] = depth_map[meta["parent_eid"]] + 1
                changed = True

    items_total = 1
    for c in comments:
        cid = c.get("parsedId") or c.get("id")
        if not cid: continue
        ceid = f"comment:{cid}"
        media = extract_reddit_media(c)
        emit({"type": "item", "data": {
            "external_id": ceid, "type": "comment",
            "url": c.get("url") or c.get("permalink") or "",
            "title": None, "caption": c.get("body") or "",
            "date": c.get("createdAt") or to_iso(c.get("created_utc")),
            "likes": c.get("upVotes") or c.get("score") or 0,
            "comments": None,
            "sender": c.get("username") or c.get("author") or "?",
            "has_media": bool(media),
            "raw_meta": {"media": media},
            "parent_external_id": cmap[cid]["parent_eid"],
            "depth": depth_map.get(ceid, 1),
        }})
        items_total += 1

    cost = run.get("usageTotalUsd") or 0
    emit({"type": "info", "message": f"apify cost: ${cost:.4f}"})
    emit({"type": "page", "loaded": items_total, "limit": items_total})
    emit({"type": "done", "items_total": items_total, "cost_usd": float(cost)})


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", help="Полный URL Reddit-поста")
    ap.add_argument("--max-comments", type=int, default=200)
    ap.add_argument("--backend", choices=["api", "auto", "apify"], default=None,
                    help="api (free cookies, default) | auto (api then apify) | apify")
    args = ap.parse_args()

    backend = str(args.backend or cfg.get("reddit", "backend") or "api").lower()
    if backend not in ("api", "auto", "apify"):
        emit({"type": "info", "message": f"unknown reddit backend '{backend}', using api"})
        backend = "api"
    target_url = normalize_url(args.url)
    emit({"type": "info", "message": f"thread fetch: {target_url} (backend={backend})"})

    if backend == "api":
        try:
            _emit_via_api(target_url, args.max_comments)
            return
        except RuntimeError as ex:
            emit({"type": "error", "message": f"api backend failed: {ex}"})
            sys.exit(7)

    if backend == "auto":
        try:
            _emit_via_api(target_url, args.max_comments)
            return
        except RuntimeError as ex:
            emit({"type": "info", "message": f"api backend failed: {ex}"})
            emit({"type": "info", "message": "fallback → apify"})
            try:
                _emit_via_apify(target_url, args.max_comments)
            except SystemExit:
                raise
            except Exception as ex2:
                emit({"type": "error", "message": f"apify fallback also failed: {ex2}"})
                sys.exit(9)
    else:
        _emit_via_apify(target_url, args.max_comments)


if __name__ == "__main__":
    main()
