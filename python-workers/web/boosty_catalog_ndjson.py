#!/usr/bin/env python3
"""Enumerate a Boosty author or one post through the first-party JSON API."""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time

from boosty_api import (
    BoostyApiError,
    canonicalize_author,
    canonicalize_post_url,
    decode_auth_cookie,
    fetch_post,
    fetch_tags,
    iter_posts,
    profile,
)


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("target")
    parser.add_argument("--limit", type=int, default=0, help="0 = whole feed")
    parser.add_argument("--order", choices=("asc", "desc"), default="desc")
    parser.add_argument("--from-ts", type=int)
    parser.add_argument("--to-ts", type=int)
    parser.add_argument("--tags", default="")
    parser.add_argument("--only-allowed", action="store_true")
    parser.add_argument("--thumbnail-dir")
    parser.add_argument("--post", action="store_true", help="target is a post/purchase URL")
    args = parser.parse_args(argv)

    cookie = (os.environ.get("SC_BOOSTY_AUTH_COOKIE") or "").strip()
    if not cookie:
        emit({"type": "error", "code": "boosty_auth_missing", "message": "Не найдена авторизация Boosty в браузере"})
        return 3
    try:
        token = decode_auth_cookie(cookie)
        if args.post:
            canonical = canonicalize_post_url(args.target)
            author = canonical["author"]
        else:
            author = canonicalize_author(args.target)
            canonical = None

        started = time.monotonic()
        entity = profile(author, token)
        emit({"type": "entity", **entity})

        posts = []
        reached_end = bool(canonical)
        if canonical:
            post = fetch_post(author, canonical["post_id"], token)
            posts.append(post)
            emit({"type": "post", "data": post})
            emit({"type": "page", "loaded": 1, "remote_total": 1, "is_last": True,
                  "oldest_at": post.get("publish_time") or post.get("created_at")})
        else:
            loaded = 0
            tags = [int(v) for v in args.tags.split(",") if v.strip().isdigit()]
            for page, extra in iter_posts(
                author,
                token,
                order=args.order,
                limit=args.limit,
                from_ts=args.from_ts,
                to_ts=args.to_ts,
                tags_ids=tags,
                is_only_allowed=args.only_allowed,
            ):
                reached_end = bool(extra.get("is_last"))
                for post in page:
                    posts.append(post)
                    loaded += 1
                    emit({"type": "post", "data": post})
                oldest = min(
                    (p.get("publish_time") or p.get("created_at") for p in posts
                     if p.get("publish_time") or p.get("created_at")),
                    default=None,
                )
                emit({
                    "type": "page",
                    "loaded": loaded,
                    "remote_total": entity.get("posts_count"),
                    "is_last": extra.get("is_last"),
                    "has_more": not extra.get("is_last"),
                    "oldest_at": oldest,
                })

        try:
            tag_rows = fetch_tags(author, token)
        except Exception:
            tag_rows = []
        accessible = sum(1 for p in posts if p.get("has_access"))
        video_posts = sum(1 for p in posts if p.get("video_count", 0) > 0)
        videos = sum(int(p.get("video_count") or 0) for p in posts)
        emit({
            "type": "done",
            "items_total": len(posts),
            "posts_total": len(posts),
            "accessible_posts": accessible,
            "video_posts": video_posts,
            "videos_total": videos,
            # The profile counter may include scheduled/otherwise hidden posts.
            # The feed cursor is the authoritative proof that its visible tail
            # was reached; comparing counts would mark a complete catalog as
            # partial for those authors.
            "catalog_complete": bool(canonical) or (args.limit <= 0 and reached_end),
            "tags": tag_rows,
            "duration_sec": round(time.monotonic() - started, 2),
        })
        return 0
    except BoostyApiError as exc:
        emit({"type": "error", "code": exc.code or "boosty_api_failed", "message": str(exc)})
        return 4
    except Exception as exc:
        emit({"type": "error", "code": "boosty_catalog_failed", "message": str(exc)})
        return 4


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        emit({"type": "error", "code": "cancelled", "message": "Остановлено пользователем"})
        sys.exit(130)
