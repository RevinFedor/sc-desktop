#!/usr/bin/env python3
"""Small, secret-safe Boosty API helpers shared by desktop workers.

The public functions deliberately strip ``playerUrls`` and every other signed
media URL before data crosses the Python -> Electron NDJSON boundary.  The
browser auth cookie is decoded only inside the worker process and is never
included in an event or an error message.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


API_ROOT = "https://api.boosty.to/v1"
BOOSTY_HOSTS = {"boosty.to", "www.boosty.to"}
UUID_RE = r"[0-9a-fA-F-]{36}"


class BoostyApiError(RuntimeError):
    def __init__(self, message, *, status=None, code=None):
        super().__init__(message)
        self.status = status
        self.code = code


def decode_auth_cookie(cookie_value):
    """Return the bearer token embedded in Boosty's percent-encoded cookie."""
    try:
        payload = json.loads(urllib.parse.unquote(str(cookie_value or "")))
        token = payload.get("accessToken")
    except Exception as exc:
        raise BoostyApiError("Некорректная авторизация Boosty в браузере") from exc
    if not isinstance(token, str) or not token:
        raise BoostyApiError("В авторизации Boosty нет access token")
    return token


def api_get(path, token=None, params=None, timeout=45):
    url = API_ROOT + path
    if params:
        clean = {key: value for key, value in params.items() if value is not None}
        if clean:
            url += "?" + urllib.parse.urlencode(clean, doseq=True)
    headers = {
        "Accept": "application/json",
        "User-Agent": "SC-Desktop/1.0",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        code = None
        description = None
        try:
            payload = json.loads(exc.read().decode("utf-8", errors="replace"))
            code = payload.get("error") or payload.get("code")
            description = payload.get("error_description") or payload.get("message")
        except Exception:
            pass
        if exc.code in (401, 403):
            message = "Boosty не подтвердил доступ текущего аккаунта"
        elif exc.code == 404:
            message = "Страница Boosty не найдена"
        else:
            message = description or f"Boosty API ответил HTTP {exc.code}"
        raise BoostyApiError(message, status=exc.code, code=code) from exc
    except urllib.error.URLError as exc:
        raise BoostyApiError("Не удалось связаться с Boosty") from exc


def canonicalize_author(raw):
    text = str(raw or "").strip()
    if not text:
        raise ValueError("Не указан автор Boosty")
    if not text.startswith(("http://", "https://")):
        handle = text.lstrip("@").strip("/")
    else:
        parsed = urllib.parse.urlparse(text)
        if (parsed.hostname or "").lower() not in BOOSTY_HOSTS:
            raise ValueError("Нужна ссылка с boosty.to")
        handle = urllib.parse.unquote(parsed.path.split("/")[1]) if len(parsed.path.split("/")) > 1 else ""
    if not handle or "/" in handle:
        raise ValueError("Не удалось определить автора Boosty")
    return handle


def canonicalize_post_url(raw_url):
    """Return author/post plus an optional video selected by ``layer``."""
    text = str(raw_url or "").strip()
    try:
        parsed = urllib.parse.urlparse(text)
    except Exception as exc:
        raise ValueError("Некорректная ссылка Boosty") from exc
    if (parsed.hostname or "").lower() not in BOOSTY_HOSTS:
        raise ValueError("Нужна ссылка с boosty.to")

    layer = urllib.parse.parse_qs(parsed.query).get("layer", [None])[0]
    if layer:
        match = re.fullmatch(rf"video:([^:]+):({UUID_RE}):({UUID_RE})", layer)
        if match:
            author, post_id, video_id = match.groups()
            author = urllib.parse.unquote(author)
            quoted = urllib.parse.quote(author, safe="._-")
            return {
                "canonical_url": f"https://boosty.to/{quoted}/posts/{post_id.lower()}",
                "author": author,
                "post_id": post_id.lower(),
                "video_id": video_id.lower(),
            }

    match = re.fullmatch(rf"/([^/]+)/posts/({UUID_RE})/?", parsed.path)
    if match:
        author, post_id = match.groups()
        author = urllib.parse.unquote(author)
        quoted = urllib.parse.quote(author, safe="._-")
        return {
            "canonical_url": f"https://boosty.to/{quoted}/posts/{post_id.lower()}",
            "author": author,
            "post_id": post_id.lower(),
            "video_id": None,
        }
    if "/purchase/" in parsed.path:
        raise ValueError("В purchase-ссылке нет параметра layer с ID видео")
    raise ValueError("Нужна ссылка на пост Boosty или на конкретное видео")


def profile(author, token=None):
    raw = api_get(f"/blog/{urllib.parse.quote(author, safe='._-')}", token)
    owner = raw.get("owner") if isinstance(raw.get("owner"), dict) else {}
    subscription = raw.get("subscription") if isinstance(raw.get("subscription"), dict) else None
    counts = raw.get("count") if isinstance(raw.get("count"), dict) else {}
    return {
        "author_handle": raw.get("blogUrl") or author,
        "author_id": str(owner.get("id")) if owner.get("id") is not None else None,
        "title": raw.get("title") or owner.get("name") or author,
        "owner_name": owner.get("name"),
        "avatar_url": owner.get("avatarUrl"),
        "cover_url": raw.get("coverUrl"),
        "posts_count": _int_or_none(counts.get("posts")),
        "subscribers_count": _int_or_none(counts.get("subscribers")),
        "subscription": _safe_level(subscription),
        "subscription_kind": raw.get("subscriptionKind"),
        "canonical_url": f"https://boosty.to/{urllib.parse.quote(raw.get('blogUrl') or author, safe='._-')}",
    }


def fetch_post(author, post_id, token=None):
    raw = api_get(
        f"/blog/{urllib.parse.quote(author, safe='._-')}/post/{urllib.parse.quote(post_id, safe='-')}",
        token,
    )
    return normalize_post(raw, author)


def iter_posts(author, token=None, *, order="desc", limit=0, from_ts=None, to_ts=None,
               tags_ids=None, is_only_allowed=False, page_size=300):
    """Yield ``(posts, extra)`` pages using Boosty's opaque cursor."""
    order = "asc" if order == "asc" else "desc"
    remaining = max(0, int(limit or 0))
    page_size = max(1, min(300, int(page_size or 300)))
    cursor = None
    while True:
        request_limit = min(page_size, remaining) if remaining else page_size
        params = {
            "limit": request_limit,
            "offset": cursor,
            "comments_limit": 0,
            "reply_limit": 0,
            "order": order,
            "from_ts": from_ts,
            "to_ts": to_ts,
            "tags_ids": ",".join(str(v) for v in (tags_ids or [])) or None,
            "is_only_allowed": "true" if is_only_allowed else None,
        }
        payload = api_get(
            f"/blog/{urllib.parse.quote(author, safe='._-')}/post/",
            token,
            params,
            timeout=60,
        )
        rows = payload.get("data") if isinstance(payload, dict) else []
        rows = rows if isinstance(rows, list) else []
        if remaining:
            rows = rows[:remaining]
        normalized = [normalize_post(row, author) for row in rows if isinstance(row, dict)]
        extra = payload.get("extra") if isinstance(payload, dict) else {}
        extra = extra if isinstance(extra, dict) else {}
        yield normalized, {
            "offset": extra.get("offset"),
            "is_last": bool(extra.get("isLast")),
        }
        if remaining:
            remaining -= len(normalized)
            if remaining <= 0:
                break
        next_cursor = extra.get("offset")
        if extra.get("isLast") or not next_cursor or next_cursor == cursor or not rows:
            break
        cursor = next_cursor


def fetch_tags(author, token=None):
    payload = api_get(
        f"/blog/{urllib.parse.quote(author, safe='._-')}/post/tag/",
        token,
    )
    rows = payload.get("data") if isinstance(payload, dict) else []
    return [
        {"id": row.get("id"), "title": row.get("title"), "count": row.get("count")}
        for row in (rows or []) if isinstance(row, dict)
    ]


def normalize_post(raw, author):
    post_id = str(raw.get("id") or "")
    has_access = raw.get("hasAccess") is True
    data = raw.get("data") if isinstance(raw.get("data"), list) else []
    teaser = raw.get("teaser") if isinstance(raw.get("teaser"), list) else []
    counters = {}
    for item in raw.get("contentCounters") or []:
        if isinstance(item, dict) and item.get("type"):
            counters[str(item["type"])] = int(item.get("count") or 0)

    videos = []
    for position, item in enumerate(data, 1):
        if not isinstance(item, dict) or item.get("type") not in ("ok_video", "video"):
            continue
        videos.append(normalize_video(item, post_id, author, position))

    declared_video_count = int(counters.get("ok_video", 0)) + int(counters.get("video", 0))
    video_count = max(len(videos), declared_video_count)
    text = extract_text(data)
    if not text:
        text = extract_text(teaser)
    image_url = first_image_url(data) or first_image_url(teaser)
    if not image_url and videos:
        image_url = videos[0].get("thumbnail_url")

    return {
        "post_id": post_id,
        "external_id": "post:" + post_id,
        "canonical_url": f"https://boosty.to/{urllib.parse.quote(author, safe='._-')}/posts/{post_id}",
        "title": raw.get("title") or "Пост Boosty",
        "text": text,
        "created_at": _int_or_none(raw.get("createdAt")),
        "publish_time": _int_or_none(raw.get("publishTime")),
        "updated_at": _int_or_none(raw.get("updatedAt")),
        "has_access": has_access,
        "is_deleted": bool(raw.get("isDeleted")),
        "is_blocked": bool(raw.get("isBlocked")),
        "is_published": raw.get("isPublished") is not False,
        "is_waiting_video": bool(raw.get("isWaitingVideo")),
        "is_pinned": bool(raw.get("isPinned")),
        "price": raw.get("price"),
        "currency_prices": _safe_dict(raw.get("currencyPrices")),
        "subscription_level": _safe_level(raw.get("subscriptionLevel")),
        "tags": [
            {"id": tag.get("id"), "title": tag.get("title")}
            for tag in (raw.get("tags") or []) if isinstance(tag, dict)
        ],
        "content_counters": counters,
        "video_count": video_count,
        "videos": videos,
        "thumbnail_url": image_url,
        "likes": _int_or_none((raw.get("count") or {}).get("likes") if isinstance(raw.get("count"), dict) else None),
        "comments": _int_or_none((raw.get("count") or {}).get("comments") if isinstance(raw.get("count"), dict) else None),
    }


def normalize_video(item, post_id, author, position=1):
    kind = str(item.get("type") or "video")
    external_url = item.get("url") if kind == "video" else None
    video_id = str(item.get("id") or "")
    if not video_id:
        digest = hashlib.sha256(str(external_url or f"{post_id}:{position}").encode()).hexdigest()[:24]
        video_id = "external-" + digest
    preview = item.get("preview") or item.get("defaultPreview")
    return {
        "video_id": video_id,
        "kind": kind,
        "position": position,
        "title": item.get("title") or "Видео Boosty",
        "duration_sec": _int_or_none(item.get("duration")),
        "width": _int_or_none(item.get("width")),
        "height": _int_or_none(item.get("height")),
        "views": _int_or_none(item.get("viewsCounter")),
        "thumbnail_url": preview if isinstance(preview, str) else None,
        "external_url": external_url if isinstance(external_url, str) else None,
        "post_id": post_id,
        "post_external_id": "post:" + post_id,
        "canonical_url": f"https://boosty.to/{urllib.parse.quote(author, safe='._-')}/posts/{post_id}",
    }


def extract_text(items):
    parts = []
    for item in items or []:
        if not isinstance(item, dict) or item.get("type") != "text":
            continue
        content = item.get("content")
        value = ""
        if isinstance(content, str):
            try:
                decoded = json.loads(content)
                if isinstance(decoded, list) and decoded:
                    value = decoded[0] if isinstance(decoded[0], str) else ""
                elif isinstance(decoded, str):
                    value = decoded
            except Exception:
                value = content
        value = html.unescape(re.sub(r"<[^>]+>", "", value or "")).strip()
        if value:
            parts.append(value)
    return "\n".join(parts)


def first_image_url(items):
    for item in items or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "image" and isinstance(item.get("url"), str):
            return item["url"]
        if item.get("type") == "ok_video":
            value = item.get("preview") or item.get("defaultPreview")
            if isinstance(value, str):
                return value
    return None


def download_thumbnail(url, output_root, author, external_id, timeout=30):
    """Cache a compact preview under the common library root.

    Boosty's image endpoint returns source-size PNG files (often 1--4 MB)
    even for a tiny card.  Keeping those originals made a 106-post catalog
    occupy hundreds of megabytes, so the cache stores a bounded WebP instead.
    """
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return None
    root = Path(output_root) / _slug(author, 70)
    root.mkdir(parents=True, exist_ok=True)
    stem = _slug(external_id.replace(":", "_"), 90)
    existing = next((p for p in root.glob(stem + ".*") if p.is_file() and p.stat().st_size > 0), None)
    if existing:
        return str(existing)
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "image/*"})
    source = None
    temporary = None
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            source = root / (stem + ".source.part")
            total = 0
            with source.open("wb") as handle:
                while True:
                    chunk = response.read(128 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > 24 * 1024 * 1024:
                        raise ValueError("thumbnail is unexpectedly large")
                    handle.write(chunk)
            if source.stat().st_size <= 0:
                source.unlink(missing_ok=True)
                return None

            from PIL import Image, ImageOps

            target = root / (stem + ".webp")
            temporary = root / (stem + ".webp.part")
            with Image.open(source) as original:
                image = ImageOps.exif_transpose(original).convert("RGB")
                image.thumbnail((512, 512), Image.Resampling.LANCZOS)
                image.save(temporary, format="WEBP", quality=78, method=4)
            source.unlink(missing_ok=True)
            source = None
            if temporary.stat().st_size <= 0:
                temporary.unlink(missing_ok=True)
                return None
            os.replace(temporary, target)
            temporary = None
            return str(target)
    except Exception:
        try:
            if source is not None:
                source.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        except Exception:
            pass
        return None


def _safe_level(value):
    if not isinstance(value, dict):
        return None
    return {
        "id": value.get("id"),
        "name": value.get("name"),
        "price": value.get("price"),
        "currency_prices": _safe_dict(value.get("currencyPrices")),
    }


def _safe_dict(value):
    return dict(value) if isinstance(value, dict) else {}


def _int_or_none(value):
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _slug(value, max_len=90):
    clean = re.sub(r"[^\w\s-]", "", str(value or ""), flags=re.UNICODE).strip()
    clean = re.sub(r"\s+", "_", clean)
    return clean[:max_len] or "boosty"
