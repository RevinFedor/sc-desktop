#!/usr/bin/env python3
"""Build a small local thumbnail cache without delaying Boosty catalog reads."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import signal
import sys
from pathlib import Path

from boosty_api import download_thumbnail


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--prune", action="store_true")
    args = parser.parse_args(argv)

    payload = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    author = str(payload.get("author") or "boosty")
    items = [row for row in (payload.get("items") or []) if isinstance(row, dict)]

    # Several video rows frequently point to the same preview. Download it
    # once and let every matching database row reference the same small file.
    by_url = {}
    for row in items:
        url = row.get("url")
        external_id = row.get("external_id")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")) or not external_id:
            continue
        by_url.setdefault(url, []).append(str(external_id))

    def one(entry):
        url, external_ids = entry
        cache_id = "preview-" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]
        path = download_thumbnail(url, args.output_dir, author, cache_id)
        return external_ids, path

    cached = 0
    kept = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for external_ids, path in pool.map(one, by_url.items()):
            if not path:
                continue
            kept.add(str(Path(path).resolve()))
            for external_id in external_ids:
                cached += 1
                emit({"type": "thumbnail", "external_id": external_id, "path": path})

    removed = 0
    if args.prune:
        author_dir = Path(args.output_dir) / _slug(author, 70)
        if author_dir.is_dir():
            for candidate in author_dir.iterdir():
                if not candidate.is_file() or candidate.name.endswith(".part"):
                    continue
                if str(candidate.resolve()) in kept:
                    continue
                try:
                    candidate.unlink()
                    removed += 1
                except OSError:
                    pass

    emit({
        "type": "done",
        "requested": len(items),
        "unique": len(by_url),
        "cached": cached,
        "removed": removed,
    })
    return 0


def _slug(value, limit):
    clean = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(value or ""))
    return clean.strip("._-")[:limit] or "boosty"


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        emit({"type": "error", "code": "cancelled", "message": "Кэширование обложек остановлено"})
        sys.exit(130)
