#!/usr/bin/env python3
"""Backfill `parent_external_id` on previously fetched Telegram items.

Older fetches (before reply-graph support) wrote items without the
`parent_external_id` column populated. This script takes a target chat plus
a list of message ids, calls `client.get_messages(entity, ids=[...])` in
batches of 100, and emits one event per resolved message — JS-side runner
applies them as targeted UPDATEs against the `items` table. No re-pagination,
no metadata refresh: only the reply edge is computed.

Events:
  {"type": "info",        "message": "..."}
  {"type": "entity",      ... }                    (echoed once for the runner)
  {"type": "page",        "loaded": K, "limit": N}
  {"type": "item-update", "external_id": "123", "parent_external_id": "120" | None}
  {"type": "error",       "message": "..."}
  {"type": "done",        "items_total": N, "duration_sec": 4.2}

Usage:
  tg_reply_backfill_ndjson.py <target> --ids 100,101,102,...
  tg_reply_backfill_ndjson.py <target> --ids-file /tmp/ids.txt
"""
import sys
import os
import json
import asyncio
import time
import argparse
import platform
import subprocess
from pathlib import Path

# Same Tahoe + Electron workaround as tg_fetch_json.py — telethon imports it
# transitively, so we patch before importing.
if sys.platform == 'darwin':
    _mac_ver = platform.mac_ver()
    if not _mac_ver[0]:
        try:
            r = subprocess.check_output(['/usr/bin/sw_vers', '-productVersion'],
                                        text=True).strip()
        except Exception:
            r = '14.0'
        platform.mac_ver = lambda r=r: (r, ('', '', ''), platform.machine())

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from credentials import telegram_credentials
from library_db import open_db, pending_reply_external_ids
from tg_message_payload import reply_metadata

try:
    TELEGRAM_API_ID, TELEGRAM_API_HASH = telegram_credentials()
except RuntimeError as ex:
    print(json.dumps({"type": "error", "message": str(ex), "code": "telegram_credentials_missing"}), flush=True)
    sys.exit(2)

try:
    from telethon import TelegramClient
    from tg_concurrent_session import telegram_session
    from telethon.tl.types import (
        User, Chat, Channel,
        ReactionEmoji, ReactionCustomEmoji,
    )
except ImportError:
    print(json.dumps({"type": "error", "message": "telethon not installed", "code": "worker_dependency_missing"}), flush=True)
    sys.exit(2)

try:
    from telethon.errors import FloodWaitError
except ImportError:
    FloodWaitError = Exception   # generic catch-all if signature changed


from tg_session_path import resolve_session_path, connect_authorized

def _resolve_session_path(name_override=None):
    # --session из Electron побеждает settings.json — снапшот сессии берётся
    # в момент спавна job'а, см. комментарий в tg_fetch_json.py.
    name = "session2"
    if name_override and isinstance(name_override, str):
        name = name_override
    else:
        settings_path = Path.home() / ".config" / "sc" / "settings.json"
        if settings_path.exists():
            try:
                data = json.loads(settings_path.read_text("utf-8"))
                n = (data.get("telegram") or {}).get("session")
                if n and isinstance(n, str):
                    name = n
            except Exception:
                pass
    return resolve_session_path(name, Path(__file__).parent)


SESSION_PATH = _resolve_session_path()


def _bump_session_busy_timeout(client, timeout_ms=30000):
    """Same trick tg_fetch_json uses. Without this, two Telethon processes
    racing on the same .session file (e.g. fetch running + auto-spawned
    backfill from `tg:index`) instantly hit
    `sqlite3.OperationalError: database is locked` because Telethon's
    SQLiteSession opens without busy_timeout."""
    try:
        sess = getattr(client, "session", None)
        conn = getattr(sess, "_conn", None) if sess else None
        if conn is None:
            return
        conn.execute(f"PRAGMA busy_timeout = {int(timeout_ms)}")
    except Exception:
        pass


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def kind_of(entity):
    if isinstance(entity, User):    return "user"
    if isinstance(entity, Channel): return "channel" if getattr(entity, "broadcast", False) else "group"
    if isinstance(entity, Chat):    return "chat"
    return "unknown"


def _reactions(msg):
    """Same shape as tg_fetch_json.reactions_for. Returns None when Telethon
    didn't expose a reaction list for this concrete message, `[]` for
    "checked, none set", or a populated list otherwise. The Electron updater
    treats the presence of the `reactions` field itself as checked, including
    null, so repeated backfills don't loop forever on messages where Telethon
    consistently returns `msg.reactions is None`."""
    r = getattr(msg, "reactions", None)
    if r is None:
        return None
    out = []
    for rc in (getattr(r, "results", None) or []):
        rk = getattr(rc, "reaction", None)
        n = int(getattr(rc, "count", 0) or 0)
        if isinstance(rk, ReactionEmoji):
            e = getattr(rk, "emoticon", None) or ""
            if e: out.append({"e": e, "n": n})
        elif isinstance(rk, ReactionCustomEmoji):
            doc_id = getattr(rk, "document_id", None)
            if doc_id is not None:
                out.append({"e": f"custom:{doc_id}", "n": n})
    return out


def _reply_target(msg):
    """Same rule as tg_fetch_json._reply_to_for: forum topic-marker
    (reply_to_msg_id == reply_to_top_id) is NOT a real reply."""
    parent = reply_metadata(msg)["parent_external_id"]
    return int(parent) if parent is not None else None


async def run(target, ids):
    t0 = time.time()
    if not SESSION_PATH.exists():
        emit({"type": "error",
              "message": f"Session file '{SESSION_PATH.name}' not found"})
        return 4

    client = TelegramClient(telegram_session(str(SESSION_PATH).replace(".session", "")),
                            TELEGRAM_API_ID, TELEGRAM_API_HASH)
    _bump_session_busy_timeout(client)
    ok, err, code = await connect_authorized(client, session_name=SESSION_PATH.stem)
    if not ok:
        emit({"type": "error", "message": err, "code": code})
        try: await client.disconnect()
        except Exception: pass
        return 4
    try:
        # Resolve entity. Same logic as tg_fetch_json.py: numeric chat_id
        # (came from --resolve-title picker, lives in sources.handle as a bare
        # int like "2165683820") needs the chat in the session's input-entity
        # cache before get_entity(int) works. Warm-up via FULL iter_dialogs
        # walk on cache miss — `break` after the first dialog isn't enough
        # for an account with hundreds of chats: the target may sit deep in
        # the list and Telethon caches dialogs as it walks, not upfront.
        handle = str(target).lstrip("@") if not str(target).startswith("http") else str(target)
        is_numeric = handle.lstrip("-").isdigit()
        try:
            entity = await client.get_entity(int(handle) if is_numeric else handle)
        except Exception as first_ex:
            if is_numeric:
                try:
                    async for _ in client.iter_dialogs():
                        pass
                    entity = await client.get_entity(int(handle))
                except Exception as ex:
                    emit({"type": "error",
                          "message": f"Cannot resolve chat_id {target}: {ex}"})
                    return 2
            else:
                emit({"type": "error",
                      "message": f"Cannot resolve {target}: {first_ex}"})
                return 2

        emit({"type": "entity",
              "kind": kind_of(entity),
              "title": getattr(entity, "title", None) or getattr(entity, "username", None),
              "id": entity.id})

        BATCH = 100
        total = len(ids)
        emit({"type": "info", "message": f"backfilling reply_to for {total} items"})

        processed = 0
        for offset in range(0, total, BATCH):
            chunk = ids[offset:offset + BATCH]
            # get_messages returns None for deleted/inaccessible ids — keep
            # the slot so the caller can mark "checked, no parent" instead of
            # leaving it pending for the next backfill run.
            #
            # FloodWait happens on big chats (>10k items) — Telegram throttles
            # the get_messages stream. Sleep through it and retry the SAME
            # chunk; we only count `processed` after a successful page so the
            # progress bar never goes backwards.
            attempts = 0
            while True:
                try:
                    msgs = await client.get_messages(entity, ids=chunk)
                    break
                except FloodWaitError as ex:
                    wait = int(getattr(ex, "seconds", 0) or 30)
                    attempts += 1
                    emit({"type": "info",
                          "message": f"FloodWait {wait}s on batch offset={offset} attempt={attempts}, sleeping"})
                    if attempts >= 5:
                        # Five FloodWaits in a row on the same chunk — give up
                        # so the runner can record an error rather than hang.
                        emit({"type": "error",
                              "message": f"FloodWait giving up after {attempts} attempts"})
                        return 5
                    await asyncio.sleep(wait + 1)
            for asked_id, msg in zip(chunk, msgs):
                reply_data = reply_metadata(msg)
                rx = _reactions(msg) if msg else None
                emit({
                    "type": "item-update",
                    "external_id": str(asked_id),
                    "parent_external_id": reply_data["parent_external_id"],
                    "raw_meta_patch": {
                        "telegram_reply": reply_data["telegram_reply"],
                        "external_reply": reply_data["external_reply"],
                    },
                    # rx semantics:
                    #   None  → concrete message checked, but Telethon exposed
                    #           no reaction list; caller marks resolved with
                    #           reactions=NULL.
                    #   []    → checked, none set
                    #   [...] → populated
                    "reactions": rx,
                })
            processed += len(chunk)
            emit({"type": "page", "loaded": processed, "limit": total})

        emit({"type": "done",
              "items_total": processed,
              "duration_sec": round(time.time() - t0, 2)})
    finally:
        await client.disconnect()
    return 0


def _parse_ids(args):
    if args.source_id:
        conn = open_db()
        try:
            return pending_reply_external_ids(conn, args.source_id, args.limit)
        finally:
            conn.close()
    if args.ids_file:
        raw = Path(args.ids_file).read_text("utf-8")
    else:
        raw = args.ids or ""
    out = []
    for tok in raw.replace("\n", ",").split(","):
        tok = tok.strip()
        if not tok: continue
        try:
            out.append(int(tok))
        except ValueError:
            emit({"type": "info", "message": f"skip non-int id {tok!r}"})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--ids", help="comma-separated message ids")
    ap.add_argument("--ids-file", help="file with one id per line (or comma-separated)")
    ap.add_argument("--source-id", type=int,
                    help="Read pending message ids from library.db in this subprocess")
    ap.add_argument("--limit", type=int, default=5000,
                    help="Maximum DB-backed IDs (default 5000, max 50000)")
    ap.add_argument("--session", default=None,
                    help="Session name (overrides settings.json) — Electron "
                         "passes its spawn-time snapshot.")
    args = ap.parse_args()

    if args.session:
        global SESSION_PATH
        SESSION_PATH = _resolve_session_path(args.session)

    try:
        ids = _parse_ids(args)
    except Exception as ex:
        emit({"type": "error", "message": f"cannot read pending ids: {ex}"})
        sys.exit(2)
    emit({"type": "backfill-plan", "items_total": len(ids)})
    if not ids:
        emit({"type": "done", "items_total": 0, "duration_sec": 0})
        sys.exit(0)

    sys.exit(asyncio.run(run(args.target, ids)))


if __name__ == "__main__":
    main()
