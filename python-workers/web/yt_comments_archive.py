"""Structured originals for explicit comments-only jobs; no subtitle/audio work.

Legacy UI TXT remains a presentation format. This archive is evidence: comment
identity, its own author, parent and timestamps stay separate from channel speech.
An extractor's successful exit is NOT a Telegram-style proven remote EOF.
"""
import hashlib
import json
import os
from pathlib import Path


VERSION = 1


def build_archive(data, *, video_id, expected_channel_id, sort, limit,
                  include_replies, warnings=None):
    if data.get("id") != video_id or data.get("channel_id") != expected_channel_id:
        raise ValueError("comments video/channel identity mismatch")
    comments = data.get("comments")
    if comments is None:
        comments = []
    if not isinstance(comments, list):
        raise ValueError("comments must be an array")
    rows, seen, conflicts, unidentified = [], {}, [], []
    for index, raw in enumerate(comments):
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str) or not raw["id"]:
            unidentified.append(index)
            continue
        comment_id = raw["id"]
        parent = raw.get("parent")
        row = {
            "comment_id": comment_id,
            "parent_comment_id": None if parent in (None, "root") else str(parent),
            "author": raw.get("author"),
            "author_id": raw.get("author_id"),
            "author_url": raw.get("author_url"),
            "author_is_uploader": raw.get("author_is_uploader"),
            "text": raw.get("text") or "",
            "published_at": raw.get("timestamp"),
            "edited_at": raw.get("modified_timestamp"),
            "time_text": raw.get("time_text"),
            "like_count": raw.get("like_count"),
            "is_pinned": raw.get("is_pinned"),
            "raw": raw,
        }
        if comment_id in seen:
            if seen[comment_id] != row:
                conflicts.append(comment_id)
            continue
        seen[comment_id] = row
        rows.append(row)
    missing_parents = sorted({row["parent_comment_id"] for row in rows
                              if row["parent_comment_id"] and row["parent_comment_id"] not in seen})
    return {
        "version": VERSION,
        "video_id": video_id,
        "video_url": f"https://www.youtube.com/watch?v={video_id}",
        "channel_id": expected_channel_id,
        "channel_title": data.get("channel") or data.get("uploader"),
        "title": data.get("title"),
        "params": {"sort": sort, "limit": limit, "include_replies": bool(include_replies)},
        "comments": rows,
        # Preserve ALL raw entries, including ones that cannot be cited by ID.
        "raw_comments": comments,
        "report": {
            "all_requested": limit == 0 and bool(include_replies),
            "producer_finished": True,
            "remote_eof": None,
            "eof_proof": "not_exposed_by_yt_dlp_cli",
            "disposition": "saved_unverified" if rows else "empty_or_disabled_unverified",
            "raw_count": len(comments), "unique_count": len(rows),
            "top_count": sum(row["parent_comment_id"] is None for row in rows),
            "reply_count": sum(row["parent_comment_id"] is not None for row in rows),
            "missing_parent_ids": missing_parents,
            "duplicate_conflicts": conflicts, "unidentified_indices": unidentified,
            "warnings": list(warnings or []),
            "remote_reported_count": data.get("comment_count"),
        },
    }


def write_archive(filename, archive):
    path = Path(filename)
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(archive, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    with temporary.open("wb") as output:
        output.write(encoded)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    return hashlib.sha256(encoded).hexdigest()
