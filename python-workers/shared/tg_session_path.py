"""Telegram session-file location helper, shared by every tg_*_ndjson.py script.

In dev (python-workers/telegram/ on disk, writable) sessions historically live next
to the scripts themselves — the original CLI path.  In production-built apps,
electron-builder excludes `*.session` from the bundle (sessions hold the user's
Telegram login token — packing them into a code-signed `.app` is a security
hole, plus the bundle is read-only on macOS).  Without a writable fallback
prod simply has no Telegram flow.

Resolution order:
1. Next to the calling script — `<script_dir>/<name>.session`.  This keeps
   old source-tree sessions readable during migration.
2. User data dir — `~/Library/Application Support/sc-desktop/sessions/telegram/<name>.session`.
   Same root as `library.db` (see `electron/database.js::LIB_ROOT`), so a
   single backup of that directory covers DB + sessions + avatars.

For *enumeration* (tg_sessions_ndjson.py listing every `*.session` for the
picker) we want the directory union, not just the first hit — see
`session_dirs()`.
"""
from pathlib import Path
import os

USER_SESSION_DIR = (
    Path(os.environ.get("SC_DESKTOP_DIR")
         or os.environ.get("MEDIA_INBOX_DIR")
         or (Path.home() / "Library" / "Application Support" / "sc-desktop"))
    / "sessions" / "telegram"
)


def session_dirs(script_dir: Path):
    """Search dirs in priority order. New sessions are written to USER_SESSION_DIR
    by tg_sessions_ndjson.py; the script dir remains a read fallback."""
    return [Path(script_dir), USER_SESSION_DIR]


def resolve_session_path(name: str, script_dir: Path) -> Path:
    """Return the path that exists, or — if neither exists — the user-dir
    candidate so the caller's `if not path.exists()` check fires with a
    meaningful 'create a session' hint instead of a noise path."""
    for d in session_dirs(script_dir):
        p = d / f"{name}.session"
        if p.exists():
            return p
    USER_SESSION_DIR.mkdir(parents=True, exist_ok=True)
    return USER_SESSION_DIR / f"{name}.session"


async def connect_authorized(client, *, session_name=None):
    """Connect a Telethon client WITHOUT the interactive login fallback.

    `client.start()` is convenient on a TTY but a trap when spawned by Electron
    with stdin closed: a de-authorised .session file (logged out, revoked, or
    expired) makes Telethon fall back to prompting "Please enter your phone…"
    on stdout, then crash with `EOFError` and exit 1 — a *blank* stderr, so the
    UI shows the opaque "python exited 1:" with no cause.

    Instead we connect (no login attempt) and check authorisation explicitly.
    Returns (ok, message, code):
      • ok=True  → client connected and ready; message/code are None.
      • ok=False → caller emits {"type":"error","message":message,"code":code}
        and exits. `code` is a machine token the renderer matches on so it
        never has to string-match the human (Russian) message. Codes:
          "session_unauthorized" — .session exists but is logged out/revoked.
          "session_connect_failed" — couldn't reach Telegram at all.
    """
    label = session_name or "session"
    try:
        await client.connect()
    except Exception as ex:
        return (False,
                f"Не удалось подключиться к Telegram: {ex}",
                "session_connect_failed")
    try:
        authorized = await client.is_user_authorized()
    except Exception as ex:
        return (False,
                f"Не удалось проверить авторизацию сессии «{label}»: {ex}",
                "session_connect_failed")
    if not authorized:
        return (False,
                (f"Сессия «{label}» не авторизована — нужно войти заново. "
                 f"Открой настройки Telegram и переавторизуй сессию "
                 f"(или выбери другую активную)."),
                "session_unauthorized")
    return True, None, None
