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
    fetch_public_tiers,
    iter_posts,
    profile,
)


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def public_catalog(args):
    """Anonymous metadata only: no cookie reads, bodies, binary requests or ASR."""
    started = int(time.time())
    posts, seen = [], set()
    fetched = duplicates = pages = invalid = 0
    continuation = None
    remote_eof = False
    stop = "tiers_only" if args.tiers_only else "not_started"
    tiers = {"status": "not_checked", "tiers": [], "complete": False, "next_id": None}
    exit_code = 0
    try:
        author = canonicalize_author(args.target)
        entity = profile(author)
        emit({"type": "entity", **{k: entity.get(k) for k in (
            "author_handle", "author_id", "title", "owner_name", "posts_count",
            "subscribers_count", "canonical_url")}, "auth_mode": "public", "metadata_only": True})
        if not args.tiers_only:
            tags = [int(v) for v in args.tags.split(",") if v.strip().isdigit()]
            for rows, extra in iter_posts(author, order=args.order, limit=args.limit,
                    from_ts=args.from_ts, to_ts=args.to_ts, tags_ids=tags,
                    is_only_allowed=args.only_allowed, page_size=args.page_size,
                    metadata_only=True, max_pages=args.max_pages):
                pages += 1
                fetched += int(extra.get("raw_rows") or 0)
                invalid += int(extra.get("invalid_rows") or 0)
                for post in rows:
                    if not post.get("post_id"):
                        continue
                    if post["post_id"] in seen:
                        duplicates += 1
                        continue
                    seen.add(post["post_id"])
                    posts.append(post)
                    emit({"type": "post", "data": post})
                remote_eof = extra.get("is_last") is True
                continuation = extra.get("offset")
                stop = extra.get("stop_reason") or "continuing"
                emit({"type": "page", "loaded": len(posts), "fetched": fetched,
                      "duplicates": duplicates, "page": pages,
                      "invalid_rows": invalid,
                      "input_cursor": extra.get("input_cursor"), "next_cursor": continuation,
                      "is_last": extra.get("is_last"), "stop_reason": stop,
                      "remote_total": entity.get("posts_count"),
                      "oldest_at": min((p.get("publish_time") or p.get("created_at") or 0
                                        for p in posts), default=None)})
        try:
            tiers = fetch_public_tiers(author)
        except BoostyApiError as exc:
            tiers = {"status": "unavailable", "tiers": [], "complete": False,
                     "next_id": None, "http_status": exc.status, "stop_reason": "tiers_http_error"}
        emit({"type": "tiers", **tiers})
    except BoostyApiError as exc:
        exit_code = 4
        stop = "rate_limited" if exc.status == 429 else "http_error"
        emit({"type": "error", "code": f"boosty_http_{exc.status or 'failed'}",
              "message": "Не удалось прочитать публичные метаданные Boosty",
              "http_status": exc.status})
    except KeyboardInterrupt:
        exit_code, stop = 130, "cancelled"
    except Exception:
        exit_code, stop = 4, "metadata_error"
        emit({"type": "error", "code": "boosty_public_metadata_failed",
              "message": "Не удалось прочитать публичные метаданные Boosty"})
    unfiltered = (not args.limit and not args.from_ts and not args.to_ts
                  and not args.tags and not args.only_allowed and not args.tiers_only)
    emit({"type": "done", "auth_mode": "public", "metadata_only": True,
          "posts_total": len(posts), "fetched": fetched, "duplicates": duplicates,
          "pages": pages, "invalid_rows": invalid, "remote_eof": remote_eof, "next_cursor": continuation,
          "stop_reason": "invalid_metadata_rows" if invalid and exit_code == 0 else stop,
          "catalog_complete": bool(unfiltered and remote_eof and exit_code == 0 and not invalid),
          "video_posts": sum(p.get("video_count", 0) > 0 for p in posts),
          "videos_total": sum(int(p.get("declared_video_count") or 0) for p in posts),
          "visible_videos": sum(len(p.get("videos") or []) for p in posts),
          "accessible_posts": sum(p.get("has_access") is True for p in posts),
          "tiers": tiers, "started_at": started, "checked_at": int(time.time()),
          "duration_sec": round(time.time() - started, 2)})
    return exit_code


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
    parser.add_argument("--auth-mode", choices=("account", "public"), default="account")
    parser.add_argument("--page-size", type=int, default=100)
    parser.add_argument("--max-pages", type=int, default=1000)
    parser.add_argument("--tiers-only", action="store_true")
    args = parser.parse_args(argv)

    if args.auth_mode == "public":
        if args.post:
            emit({"type": "error", "code": "boosty_public_author_required", "message": "Нужна ссылка автора"})
            return 3
        return public_catalog(args)

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
