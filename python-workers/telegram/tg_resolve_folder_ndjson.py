#!/usr/bin/env python3
"""Resolve a Telegram folder ("dialog filter") by name.

Telegram's own client lets the user organise chats into folders ("папки").
The list lives server-side as a `DialogFilter` object — we ask Telethon for
all of them via GetDialogFiltersRequest, find the one whose title matches,
and emit one ndjson event per chat inside.

Events:
  {"type": "folder_candidate", "filter_id": int, "title": str,
                                "include_count": int}
  {"type": "folder",           "filter_id": int, "title": str,
                                "chats": [{handle, title, kind, members,
                                           tg_id, avatar_path}]}
  {"type": "info",             "message": str}
  {"type": "error",            "message": str}
  {"type": "done",             "matches": int}

Usage:
  tg_resolve_folder_ndjson.py "events"
  tg_resolve_folder_ndjson.py --filter-id 7      # re-resolve known folder
  tg_resolve_folder_ndjson.py --all              # expand every named folder
"""
import sys
import os
import json
import asyncio
import argparse
import platform
import subprocess
from pathlib import Path

# Same Tahoe / Electron-spawn workaround as tg_fetch_json.py — must run before
# any telethon import, otherwise platform.mac_ver() returns ('','','') and
# telethon's libssl probe blows up on `release.split('.')`.
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

try:
    TELEGRAM_API_ID, TELEGRAM_API_HASH = telegram_credentials()
except RuntimeError as ex:
    print(json.dumps({"type": "error", "message": str(ex), "code": "telegram_credentials_missing"}), flush=True)
    sys.exit(2)

try:
    from telethon import TelegramClient
    from telethon.tl.functions.messages import GetDialogFiltersRequest
    from telethon.tl.types import (
        User, Chat, Channel,
        InputPeerChannel, InputPeerChat, InputPeerUser,
    )
except ImportError as ex:
    print(json.dumps({"type": "error",
                      "message": f"telethon import failed: {ex}",
                      "code": "worker_dependency_missing"}), flush=True)
    sys.exit(2)


def _lib_root():
    override = os.environ.get("SC_DESKTOP_DIR") or os.environ.get("MEDIA_INBOX_DIR")
    if override:
        return Path(override)
    return Path.home() / "Library" / "Application Support" / "sc-desktop"


def _avatar_path_for(entity_id):
    p = _lib_root() / "avatars" / "telegram" / f"{entity_id}.jpg"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


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
    if isinstance(entity, User):
        return "user"
    if isinstance(entity, Channel):
        return "channel" if getattr(entity, "broadcast", False) else "group"
    if isinstance(entity, Chat):
        return "chat"
    return "unknown"


def title_of(entity):
    return (
        getattr(entity, "title", None)
        or " ".join(filter(None, [getattr(entity, "first_name", None),
                                   getattr(entity, "last_name", None)]))
        or getattr(entity, "username", None)
        or "?"
    )


def _normalize(s):
    """Lenient match: lowercased, whitespace-collapsed, surrounding emoji /
    quotes / punctuation stripped. Catches '😑events' typed as 'events' and
    '«events»' typed bare. Inner punctuation (e.g. 'work | personal') stays."""
    if not s:
        return ""
    t = " ".join(s.split()).casefold()
    return t.strip(' \t\n«»“”‘’\'"`()[]{}.,;:!?-—–😑😀🙂🤖📂🔥✨🎯⭐')


def _filter_title(f):
    """DialogFilter has `title` either as a plain string (legacy) or a
    `TextWithEntities` object (~Telethon 1.36+). Normalise to str."""
    t = getattr(f, "title", None)
    if t is None:
        return ""
    if isinstance(t, str):
        return t
    return getattr(t, "text", None) or str(t)


def _filter_id(f):
    """Same deal — DialogFilter.id may be a plain int or wrapped on newer
    schemas. Be defensive."""
    return int(getattr(f, "id", 0) or 0)


async def _peer_to_handle(client, peer):
    """Convert an InputPeer* (what DialogFilter.include_peers returns) into
    something we can pass back to UI as a stable identity. For channels and
    chats we want the @username when public, otherwise -100<id> (Telethon's
    canonical numeric id form). User peers (single-user "chats") are kept
    as numeric ids — they're usually noise inside event-papers but we don't
    want to silently drop them either.
    """
    try:
        ent = await client.get_entity(peer)
    except Exception as ex:
        emit({"type": "info",
              "message": f"peer resolve failed: {type(peer).__name__} → {ex}"})
        return None

    username = getattr(ent, "username", None)
    if username:
        handle = username
    elif isinstance(ent, Channel):
        # private channel / supergroup — Telethon's numeric form
        handle = f"-100{ent.id}"
    elif isinstance(ent, Chat):
        handle = f"-{ent.id}"
    elif isinstance(ent, User):
        handle = str(ent.id)
    else:
        handle = str(getattr(ent, "id", "?"))

    # Avatar — same idempotent download trick as tg_fetch_json.py.
    avatar_rel = None
    try:
        if getattr(ent, "photo", None):
            ap = _avatar_path_for(ent.id)
            saved = await client.download_profile_photo(ent, file=str(ap))
            if saved:
                try:
                    avatar_rel = str(Path(saved).relative_to(_lib_root()))
                except Exception:
                    avatar_rel = None
    except Exception:
        pass

    members = (getattr(ent, "participants_count", None)
               or getattr(ent, "members_count", None))

    return {
        "handle":       handle,
        "title":        title_of(ent),
        "kind":         kind_of(ent),
        "members":      members,
        "tg_id":        getattr(ent, "id", None),
        "username":     username or None,
        "avatar_path":  avatar_rel,
        "is_channel":   isinstance(ent, Channel) and bool(getattr(ent, "broadcast", False)),
        "is_group":     isinstance(ent, Channel) and bool(getattr(ent, "megagroup", False))
                        or isinstance(ent, Chat),
    }


async def _expand_filter(client, f):
    """Walk a DialogFilter's include_peers and emit one `folder` event with
    the resolved chats. Same shape regardless of how the caller targeted it
    (by name, by filter_id, or via --all sweep)."""
    fid = _filter_id(f)
    ftitle = _filter_title(f)
    chats = []
    for peer in list(getattr(f, "include_peers", []) or []):
        row = await _peer_to_handle(client, peer)
        if row is not None:
            chats.append(row)
    emit({"type":      "folder",
          "filter_id": fid,
          "title":     ftitle,
          "chats":     chats})


async def main(name, filter_id_hint, sweep_all):
    if not SESSION_PATH.exists():
        emit({"type": "error",
              "message": f"Session file '{SESSION_PATH.name}' not found — open Telegram settings and pick or create a session."})
        return 4

    client = TelegramClient(str(SESSION_PATH).replace(".session", ""),
                            TELEGRAM_API_ID, TELEGRAM_API_HASH)
    _bump_session_busy_timeout(client)
    ok, err, code = await connect_authorized(client, session_name=SESSION_PATH.stem)
    if not ok:
        emit({"type": "error", "message": err, "code": code})
        try: await client.disconnect()
        except Exception: pass
        return 4

    matches = 0
    try:
        # GetDialogFiltersRequest may return a bare list (older Telethon) or
        # a DialogFilters object with `.filters` (newer). Cover both shapes.
        res = await client(GetDialogFiltersRequest())
        filters = res if isinstance(res, list) else getattr(res, "filters", res)

        target_id = int(filter_id_hint) if filter_id_hint is not None else None
        needle = _normalize(name) if name else None

        # Pre-emit folder_candidate for every non-default filter so the UI
        # can offer a picker if the typed name is ambiguous (rare). The
        # default "All chats" filter has no title and is skipped — never
        # something the user means by "events".
        candidates = []
        for f in filters:
            fid = _filter_id(f)
            ftitle = _filter_title(f)
            if not ftitle:
                continue   # default / unsorted bucket
            include_count = len(getattr(f, "include_peers", []) or [])
            candidates.append((f, fid, ftitle, include_count))
            emit({"type": "folder_candidate",
                  "filter_id":     fid,
                  "title":         ftitle,
                  "include_count": include_count})

        if sweep_all:
            # Refresh sweep — expand every named filter so the UI can re-sync
            # membership for everything in one shot. Sequential, since each
            # _peer_to_handle does its own get_entity round-trip and Telegram
            # rate-limits parallel calls hard.
            for f, _fid, _ftitle, _cnt in candidates:
                await _expand_filter(client, f)
                matches += 1
        else:
            # Pick which folder to expand:
            #   1. exact filter_id match (re-resolve flow)
            #   2. lenient title match
            #   3. nothing — UI shows picker / error from candidates above
            chosen = None
            for f, fid, ftitle, _cnt in candidates:
                if target_id is not None and fid == target_id:
                    chosen = f
                    break
            if chosen is None and needle:
                for f, fid, ftitle, _cnt in candidates:
                    if _normalize(ftitle) == needle:
                        chosen = f
                        break

            if chosen is None:
                emit({"type": "info",
                      "message": f"no folder matched: name={name!r} filter_id={filter_id_hint}"})
            else:
                await _expand_filter(client, chosen)
                matches = 1
    finally:
        emit({"type": "done", "matches": matches})
        await client.disconnect()
    return 0


def cli():
    parser = argparse.ArgumentParser()
    parser.add_argument("name", nargs="?", default=None,
                        help="Folder name as shown in the Telegram client")
    parser.add_argument("--filter-id", type=int, default=None,
                        help="Re-resolve a folder by its known DialogFilter.id")
    parser.add_argument("--all", action="store_true", dest="sweep_all",
                        help="Expand every named DialogFilter — used by the "
                             "Refresh button on TelegramScreen to re-sync all "
                             "folder memberships in one shot.")
    parser.add_argument("--session", default=None,
                        help="Session name (overrides settings.json) — Electron "
                             "passes its spawn-time snapshot.")
    args = parser.parse_args()

    if args.session:
        global SESSION_PATH
        SESSION_PATH = _resolve_session_path(args.session)

    if args.name is None and args.filter_id is None and not args.sweep_all:
        emit({"type": "error",
              "message": "either name, --filter-id, or --all is required"})
        sys.exit(2)

    try:
        rc = asyncio.run(main(args.name, args.filter_id, args.sweep_all))
        sys.exit(rc)
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(130)
    except Exception as ex:
        emit({"type": "error",
              "message": f"{type(ex).__name__}: {ex}"})
        sys.exit(1)


if __name__ == "__main__":
    cli()
