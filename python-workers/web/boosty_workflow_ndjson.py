#!/usr/bin/env python3
"""SC job-engine account preflight/storage probe. No media, ASR or clipboard."""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from boosty_full_channel import (app_root, storage_config, collect_catalog, ensure_catalog_rows,
                                existing_file, canonicalize_author, decode_auth_cookie)
from shared.boosty_storage import inspect_storage, describe_config
from shared.library_db import open_db


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def account_plan(target):
    """Reuse catalogue identity. Saved full originals survive locked/teaser refresh."""
    author = canonicalize_author(target)
    auth = decode_auth_cookie(os.environ.get("SC_BOOSTY_AUTH_COOKIE", ""))
    entity, posts, videos, coverage = collect_catalog(author, auth, with_summary=True)
    if coverage["remote_eof"] is not True:
        raise RuntimeError("Account feed EOF unconfirmed; no paid selection admitted")
    conn = open_db()
    try:
        with conn:
            source_id = ensure_catalog_rows(conn, entity, posts)
            # Only fill an absent own body with an actually authorized body.
            # Never overwrite a saved full body with a public teaser or empty response.
            for post in posts:
                if post.get("has_access") is True and (post.get("text") or "").strip():
                    conn.execute("UPDATE items SET caption=?,updated_at=unixepoch() WHERE source_id=? AND external_id=? AND COALESCE(caption,'')=''",
                                 (post["text"], source_id, post["external_id"]))
        children, parents, visible = [], [], set()
        for post in posts:
            row = conn.execute("SELECT id,caption FROM items WHERE source_id=? AND external_id=?", (source_id, post["external_id"])).fetchone()
            access = post.get("has_access")
            body = row["caption"] or ""
            parents.append({"item_id": row["id"], "post_id": post["post_id"], "url": post["canonical_url"],
                "has_access": access, "text_state": "saved" if body.strip() else "empty" if access is True else "locked" if access is False else "unknown",
                "text_sha256": hashlib.sha256(body.encode()).hexdigest(), "text_chars": len(body),
                "assets_metadata": post.get('assets_metadata') or [],
                "asset_coverage": 'metadata_only_not_collected'})
            for position, video in enumerate(post.get("videos") or [], 1):
                video_id = str(video.get("video_id") or "")
                if not video_id or video_id in visible:
                    continue
                visible.add(video_id)
                row = conn.execute("SELECT id,transcript_path,media_path FROM items WHERE source_id=? AND external_id=?", (source_id, video_id)).fetchone()
                if row is None:
                    raise RuntimeError("Catalogue child identity was not saved")
                txt = row["transcript_path"]
                srt = str(Path(txt).with_suffix(".srt")) if txt else None
                # Any existing TXT is preserved even if historical SRT is absent:
                # incomplete paired files are an exception, NEVER an ASR replay.
                state = "reused" if existing_file(txt) and existing_file(srt) else "saved_txt_missing_srt" if existing_file(txt) else "missing" if access is True else "locked" if access is False else "unknown"
                if not existing_file(txt) and not re.fullmatch(r'[0-9a-fA-F-]{36}', video_id): state = 'external_reference_not_a_Boosty_player'
                children.append({"item_id": row["id"], "post_id": post["post_id"], "video_id": video_id,
                    "url": post["canonical_url"], "title": video.get("title") or post.get("title"),
                    "author": entity.get("title") or author, "position": video.get("position") or position,
                    "duration_sec": video.get("duration_sec"), "has_access": access, "state": state})
        # Historical hidden children remain discoverable, not removed or declared current-accessible.
        for row in conn.execute("SELECT id,external_id,parent_external_id,transcript_path,url,title,duration_seconds FROM items WHERE source_id=? AND type='boosty_video'", (source_id,)):
            if row["external_id"] not in visible:
                children.append({"item_id": row["id"], "video_id": row["external_id"],
                    "post_id": str(row["parent_external_id"] or "").removeprefix("post:"), "url": row["url"],
                    "title": row["title"], "duration_sec": row["duration_seconds"], "has_access": None,
                    "state": "reused_hidden" if existing_file(row["transcript_path"]) else "unknown_hidden"})
        return {"source_id": source_id, "handle": author, "auth_mode": "account", "checked_at": int(time.time()),
                "catalogue": coverage, "posts": parents, "children": children,
                "entitlement_scope": "observed per-post hasAccess, not a purchased tier assertion",
                "media_downloads": 0, "ASR": 0}
    finally:
        conn.close()


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["plan", "storage", "probe"])
    parser.add_argument("--target")
    parser.add_argument("--config-file")
    args = parser.parse_args(argv)
    try:
        if args.operation == "plan":
            result = account_plan(args.target)
        elif args.operation == "storage":
            result = describe_config({**storage_config(), "library_root": app_root()})
        else:
            config = json.loads(Path(args.config_file).read_text(encoding="utf-8"))
            result = inspect_storage(config, external_mount=config["external_mount"],
                                     expected_volume_uuid=config.get("volume_uuid"), reserve_bytes=config["reserve_bytes"])
        emit({"type": "result", "result": result})
        return 0
    except Exception:
        emit({"type": "error", "code": "BOOSTY_PREFLIGHT_FAILED", "message": "Account/storage preflight failed; no media or ASR started"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
