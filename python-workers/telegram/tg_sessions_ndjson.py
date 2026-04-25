#!/usr/bin/env python3
"""Telegram session manager for SC Desktop UI.

Emits ndjson events. Supports three modes:

  --list
      Enumerate *.session files in this directory, validate each (does it
      authorize?), and emit one {type:'session', ...} per file plus a final
      {type:'done'}. Each session carries `me` (live identity, null if dead)
      and `me_cached` (last-known identity from the .meta.json sidecar, used
      to label a revoked session). Authorized sessions refresh their sidecar.

  --login-start --phone +XXXXXXXXX [--name <session_name>]
      Send a login code to the phone, emit {type:'code_sent', phone_code_hash}.
      The session file is created on the next step.

  --login-finish --phone +X --hash X --code X [--password X] [--name X]
      Complete sign-in, emit {type:'logged_in', me:{...}, session_name} or
      {type:'2fa_needed'} if a password is required and wasn't supplied.

Common events:
  {"type": "info",  "message": "..."}
  {"type": "error", "message": "..."}
"""
import sys
import os
import io
import json
import re
import time
import asyncio
import argparse
import platform
import contextlib
import subprocess
from pathlib import Path

# macOS Tahoe + Electron spawn workaround (see tg_fetch_json.py).
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
from credentials import telegram_credentials

try:
    TELEGRAM_API_ID, TELEGRAM_API_HASH = telegram_credentials()
except RuntimeError as ex:
    sys.stdout.write(json.dumps({"type": "error", "message": str(ex), "code": "telegram_credentials_missing"}) + "\n")
    sys.stdout.flush()
    sys.exit(2)
# In production HERE points to a code-signed read-only bundle path —
# `.app/Contents/Resources/python-workers/telegram/`. We can't write new sessions
# there, and electron-builder also strips existing `*.session` from the
# bundle (security: tokens). Writes always go to USER_SESSION_DIR. Reads/
# enumeration union both paths so dev sessions (next to source) keep working.
from tg_session_path import USER_SESSION_DIR, session_dirs
USER_SESSION_DIR.mkdir(parents=True, exist_ok=True)

try:
    from telethon import TelegramClient, errors
except ImportError:
    sys.stdout.write(json.dumps({"type": "error", "message": "telethon not installed"}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def emit(ev):
    sys.stdout.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


@contextlib.contextmanager
def silenced():
    """Swallow noisy stdout/stderr from telethon/SSL libs — ndjson contract
    requires emit() to be the only stdout writer."""
    saved_out, saved_err = sys.stdout, sys.stderr
    try:
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        yield
    finally:
        sys.stdout = saved_out
        sys.stderr = saved_err


def session_name_from_path(p):
    return p.stem


# ─── identity cache (meta sidecar) ─────────────────────────────────────────
# A `.session` file can be revoked server-side (logout elsewhere, terminated
# session, expired). Once that happens Telethon can't get_me() — so the UI
# loses the account's phone/@handle and shows a faceless «не авторизована»
# with no way to tell WHICH account died. We fix that by caching the identity
# in a sidecar JSON next to the session whenever we DO have a live get_me().
# On a later dead listing we surface it as `me_cached` so the row still reads
# «Имя · @tag · +phone (отозвана)». The sidecar holds no secrets — just the
# public profile fields the UI already shows; the auth_key never leaves the
# .session itself.

def _meta_path(session_path: Path) -> Path:
    # session file is "<name>.session" → meta is "<name>.session.meta.json",
    # so it travels with the session and our delete-glob catches it.
    return Path(str(session_path) + ".meta.json")


def _me_dict(user):
    return {
        "id":         user.id,
        "first_name": user.first_name,
        "last_name":  user.last_name,
        "username":   user.username,
        "phone":      user.phone,
    }


def _write_session_meta(session_path: Path, me: dict):
    """Persist last-known identity beside the session. Best-effort: a failure
    here must never break list/login (the session itself is the source of
    truth; meta is only a convenience for dead-session display)."""
    try:
        data = dict(me or {})
        data["last_seen"] = int(time.time())
        _meta_path(session_path).write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def _read_session_meta(session_path: Path):
    try:
        p = _meta_path(session_path)
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return None


def _delete_session_files(directory: Path, name: str) -> bool:
    """Remove a session and ALL its siblings (journal/wal/shm + meta sidecar).
    Returns True if the main .session existed and was removed."""
    removed = False
    main = directory / f"{name}.session"
    if main.exists():
        try:
            main.unlink()
            removed = True
        except Exception:
            pass
    for suffix in ("-journal", "-wal", "-shm", ".meta.json"):
        sib = directory / f"{name}.session{suffix}"
        if sib.exists():
            try:
                sib.unlink()
            except Exception:
                pass
    return removed


# ─── modes ───────────────────────────────────────────────────────────────

async def cmd_list():
    # Enumerate from both dev (HERE) and prod (USER_SESSION_DIR). Same-named
    # session in both — first one wins so the dev workflow (edit-session-in-
    # place) is unaffected.
    seen = set()
    sessions = []
    for d in session_dirs(HERE):
        if not d.exists():
            continue
        for p in sorted(d.glob("*.session")):
            if p.name.endswith("-journal"):
                continue
            if p.name in seen:
                continue
            seen.add(p.name)
            sessions.append(p)
    for path in sessions:
        name = session_name_from_path(path)
        try:
            client = TelegramClient(str(path).replace(".session", ""),
                                    TELEGRAM_API_ID, TELEGRAM_API_HASH)
            with silenced():
                await client.connect()
                authorized = await client.is_user_authorized()
                me = None
                if authorized:
                    user = await client.get_me()
                    if user:
                        me = _me_dict(user)
                await client.disconnect()
            if authorized and me:
                # Refresh the identity cache so a future revoke still shows
                # who this was.
                _write_session_meta(path, me)
            # Dead session → fall back to the last-known identity so the UI
            # can render «Имя · @tag · +phone (отозвана)» instead of a faceless
            # row. `me_cached` is advisory (may be stale); `me` stays null so
            # the renderer never confuses cached with live.
            me_cached = None if authorized else _read_session_meta(path)
            emit({"type": "session", "name": name, "path": str(path),
                  "authorized": authorized, "me": me, "me_cached": me_cached})
        except Exception as ex:
            emit({"type": "session", "name": name, "path": str(path),
                  "authorized": False, "me": None,
                  "me_cached": _read_session_meta(path),
                  "error": f"{type(ex).__name__}: {ex}"})
    emit({"type": "done", "count": len(sessions)})


async def cmd_login_start(phone, name):
    # Sanitize the session name → safe filename, fall back to phone digits.
    safe = re.sub(r"[^\w.-]+", "_", name).strip("_") if name else None
    if not safe:
        safe = "session_" + re.sub(r"\D", "", phone)[-7:]

    # New sessions always go to USER_SESSION_DIR — HERE is read-only in prod
    # bundle. Telethon will create `<safe>.session` there.
    path = USER_SESSION_DIR / safe
    client = TelegramClient(str(path), TELEGRAM_API_ID, TELEGRAM_API_HASH)
    try:
        with silenced():
            await client.connect()
            sent = await client.send_code_request(phone)
        emit({
            "type": "code_sent",
            "phone": phone,
            "phone_code_hash": sent.phone_code_hash,
            "session_name": safe,
        })
    except errors.PhoneNumberInvalidError:
        emit({"type": "error", "message": "Phone number invalid"})
    except errors.FloodWaitError as ex:
        emit({"type": "error", "message": f"Flood wait — try again in {ex.seconds}s"})
    except Exception as ex:
        emit({"type": "error", "message": f"{type(ex).__name__}: {ex}"})
    finally:
        with silenced():
            try: await client.disconnect()
            except Exception: pass


async def _reap_dead_duplicates(keep_name: str, account_id: int):
    """After a successful (re)login, remove OTHER session files that belong to
    the same Telegram account (matched by cached identity id) but are now dead
    (revoked / unauthorized). This is what makes a re-login *replace* a dead
    session instead of accumulating a faceless duplicate row.

    Conservative on purpose:
      • only touches sessions whose cached meta id == this account's id,
      • and ONLY if they fail is_user_authorized() right now (never nukes a
        still-live parallel session of the same account — the user may
        legitimately keep two live logins),
      • never the just-created `keep_name`.
    Writes go to USER_SESSION_DIR (where login created the file); we also scan
    dev HERE so a stale dev-path zombie of the same account gets cleaned.
    Returns a list of reaped session names (for the emit + UI toast)."""
    reaped = []
    for d in session_dirs(HERE):
        if not d.exists():
            continue
        for p in sorted(d.glob("*.session")):
            name = session_name_from_path(p)
            if name == keep_name:
                continue
            meta = _read_session_meta(p)
            if not meta or meta.get("id") != account_id:
                continue
            # Same account by cached id — verify it's actually dead before
            # removing. A live parallel session is left untouched.
            try:
                c = TelegramClient(str(p).replace(".session", ""),
                                   TELEGRAM_API_ID, TELEGRAM_API_HASH)
                with silenced():
                    await c.connect()
                    still_alive = await c.is_user_authorized()
                    await c.disconnect()
            except Exception:
                still_alive = False
            if not still_alive:
                if _delete_session_files(d, name):
                    reaped.append(name)
    return reaped


async def cmd_login_finish(phone, code_hash, code, password, name):
    safe = name or "session_" + re.sub(r"\D", "", phone)[-7:]
    path = USER_SESSION_DIR / safe
    client = TelegramClient(str(path), TELEGRAM_API_ID, TELEGRAM_API_HASH)
    try:
        with silenced():
            await client.connect()
        try:
            with silenced():
                await client.sign_in(phone=phone, code=code, phone_code_hash=code_hash)
        except errors.SessionPasswordNeededError:
            if not password:
                emit({"type": "2fa_needed"})
                return
            with silenced():
                await client.sign_in(password=password)
        except errors.PhoneCodeInvalidError:
            emit({"type": "error", "message": "Code is invalid"})
            return
        except errors.PhoneCodeExpiredError:
            emit({"type": "error", "message": "Code expired — request a new one"})
            return

        with silenced():
            user = await client.get_me()
        if user:
            me = _me_dict(user)
            # Cache identity beside the freshly-created session so a future
            # revoke still surfaces who this was.
            _write_session_meta(USER_SESSION_DIR / f"{safe}.session", me)
            # Re-login housekeeping: this same account may already exist under
            # a DIFFERENT session file that's now dead (revoked). Reap those
            # zombies so a re-login replaces the dead session instead of
            # piling up a third faceless row. Disconnect first so the just-
            # written session isn't itself probed mid-flight.
            with silenced():
                try: await client.disconnect()
                except Exception: pass
            reaped = await _reap_dead_duplicates(keep_name=safe, account_id=user.id)
            emit({"type": "logged_in", "session_name": safe, "me": me,
                  "reaped": reaped})
        else:
            emit({"type": "error", "message": "sign-in returned no user"})
    except Exception as ex:
        emit({"type": "error", "message": f"{type(ex).__name__}: {ex}"})
    finally:
        with silenced():
            try: await client.disconnect()
            except Exception: pass


# ─── entrypoint ──────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")

    p = sub.add_parser("login-start")
    p.add_argument("--phone", required=True)
    p.add_argument("--name")

    p = sub.add_parser("login-finish")
    p.add_argument("--phone", required=True)
    p.add_argument("--hash",  required=True)
    p.add_argument("--code",  required=True)
    p.add_argument("--password")
    p.add_argument("--name")

    p = sub.add_parser("delete")
    p.add_argument("--name", required=True)

    args = ap.parse_args()
    try:
        if args.cmd == "list":
            asyncio.run(cmd_list())
        elif args.cmd == "login-start":
            asyncio.run(cmd_login_start(args.phone, args.name))
        elif args.cmd == "login-finish":
            asyncio.run(cmd_login_finish(args.phone, args.hash, args.code, args.password, args.name))
        elif args.cmd == "delete":
            # Look in both dirs — a session may have been created by an
            # older dev install (HERE) and we still want delete-from-UI to
            # work. Wipe wherever we found it (incl. meta sidecar); if none —
            # error.
            removed = False
            for d in session_dirs(HERE):
                if _delete_session_files(d, args.name):
                    removed = True
            if not removed:
                emit({"type": "error", "message": "session file not found"})
                sys.exit(2)
            emit({"type": "deleted", "name": args.name})
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(130)


if __name__ == "__main__":
    main()
