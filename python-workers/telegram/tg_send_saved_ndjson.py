#!/usr/bin/env python3
"""Send text and local attachments to Telegram Saved Messages.

This worker intentionally has no chat/target argument. The only destination is
Telethon's "me" peer, which Telegram renders as Saved Messages / Избранное.
"""
import sys
import json
import asyncio
import argparse
import platform
import subprocess
from pathlib import Path

# Same macOS / Electron-spawn workaround as the other Telegram workers.
if sys.platform == "darwin":
    _mac_ver = platform.mac_ver()
    if not _mac_ver[0]:
        try:
            r = subprocess.check_output(
                ["/usr/bin/sw_vers", "-productVersion"],
                text=True,
            ).strip()
        except Exception:
            r = "14.0"
        platform.mac_ver = lambda r=r: (r, ("", "", ""), platform.machine())

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "shared"))

from credentials import telegram_credentials
from tg_session_path import resolve_session_path, connect_authorized

try:
    TELEGRAM_API_ID, TELEGRAM_API_HASH = telegram_credentials()
except RuntimeError as ex:
    print(json.dumps({
        "type": "error",
        "message": str(ex),
        "code": "telegram_credentials_missing",
    }, ensure_ascii=False), flush=True)
    sys.exit(2)

try:
    from telethon import TelegramClient
except ImportError as ex:
    print(json.dumps({
        "type": "error",
        "message": f"telethon import failed: {ex}",
        "code": "worker_dependency_missing",
    }, ensure_ascii=False), flush=True)
    sys.exit(2)


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def _resolve_session_path(name_override=None):
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
    return resolve_session_path(name, HERE)


def _bump_session_busy_timeout(client, timeout_ms=30000):
    try:
        sess = getattr(client, "session", None)
        conn = getattr(sess, "_conn", None) if sess else None
        if conn is not None:
            conn.execute(f"PRAGMA busy_timeout = {int(timeout_ms)}")
    except Exception:
        pass


def _expand_local_path(raw):
    return Path(str(raw)).expanduser()


def _validate_local_files(paths, label):
    out = []
    for raw in paths or []:
        p = _expand_local_path(raw)
        if not p.exists():
            emit({
                "type": "error",
                "message": f"{label} not found: {p}",
                "code": "attachment_not_found",
                "path": str(p),
            })
            return None
        if not p.is_file():
            emit({
                "type": "error",
                "message": f"{label} is not a file: {p}",
                "code": "attachment_not_file",
                "path": str(p),
            })
            return None
        out.append(str(p))
    return out


def _message_ids(result):
    if isinstance(result, (list, tuple)):
        return [getattr(m, "id", None) for m in result]
    return [getattr(result, "id", None)]


def _message_date(result):
    msg = result[0] if isinstance(result, (list, tuple)) and result else result
    dt = getattr(msg, "date", None)
    return dt.isoformat() if dt else None


async def send_saved(text="", images=None, files=None, session=None, silent=False):
    text = "" if text is None else str(text)
    images = images or []
    files = files or []
    if not text.strip() and not images and not files:
        emit({
            "type": "error",
            "message": "Text, images, or files are required.",
            "code": "content_required",
        })
        return 2
    if not text.strip():
        text = ""

    if text and len(text) > 4096:
        emit({
            "type": "error",
            "message": "Telegram message is too long: maximum is 4096 characters.",
            "code": "text_too_long",
            "chars": len(text),
            "max_chars": 4096,
        })
        return 2

    image_paths = _validate_local_files(images, "Image")
    if image_paths is None:
        return 2
    file_paths = _validate_local_files(files, "File")
    if file_paths is None:
        return 2

    session_path = _resolve_session_path(session)
    if not session_path.exists():
        emit({
            "type": "error",
            "message": (
                f"Session file '{session_path.name}' not found — open Telegram "
                "settings and pick or create a session."
            ),
            "code": "session_missing",
            "session": session_path.stem,
        })
        return 4

    client = TelegramClient(
        str(session_path).replace(".session", ""),
        TELEGRAM_API_ID,
        TELEGRAM_API_HASH,
    )
    _bump_session_busy_timeout(client)
    ok, err, code = await connect_authorized(client, session_name=session_path.stem)
    if not ok:
        emit({"type": "error", "message": err, "code": code, "session": session_path.stem})
        try:
            await client.disconnect()
        except Exception:
            pass
        return 4

    sent_total = 0
    try:
        if text:
            msg = await client.send_message(
                "me",
                text,
                parse_mode=None,
                silent=bool(silent),
            )
            sent_total += 1
            emit({
                "type": "sent",
                "kind": "text",
                "target": "saved_messages",
                "session": session_path.stem,
                "message_id": getattr(msg, "id", None),
                "date": getattr(msg, "date", None).isoformat() if getattr(msg, "date", None) else None,
                "chars": len(text),
                "silent": bool(silent),
            })

        for p in image_paths:
            msg = await client.send_file(
                "me",
                p,
                force_document=False,
                parse_mode=None,
                silent=bool(silent),
            )
            sent_total += 1
            emit({
                "type": "sent",
                "kind": "image",
                "target": "saved_messages",
                "session": session_path.stem,
                "message_id": _message_ids(msg)[0],
                "message_ids": _message_ids(msg),
                "date": _message_date(msg),
                "path": p,
                "silent": bool(silent),
            })

        for p in file_paths:
            msg = await client.send_file(
                "me",
                p,
                force_document=True,
                parse_mode=None,
                silent=bool(silent),
            )
            sent_total += 1
            emit({
                "type": "sent",
                "kind": "file",
                "target": "saved_messages",
                "session": session_path.stem,
                "message_id": _message_ids(msg)[0],
                "message_ids": _message_ids(msg),
                "date": _message_date(msg),
                "path": p,
                "silent": bool(silent),
            })

        emit({
            "type": "done",
            "target": "saved_messages",
            "session": session_path.stem,
            "sent": sent_total,
            "text": 1 if text else 0,
            "images": len(image_paths),
            "files": len(file_paths),
        })
        return 0
    except Exception as ex:
        emit({
            "type": "error",
            "message": f"{type(ex).__name__}: {ex}",
            "code": "send_failed",
            "session": session_path.stem,
        })
        return 1
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default="")
    parser.add_argument("--image", action="append", default=[])
    parser.add_argument("--file", action="append", default=[])
    parser.add_argument("--session", default=None)
    parser.add_argument("--silent", action="store_true")
    args = parser.parse_args()
    return asyncio.run(send_saved(
        args.text,
        images=args.image,
        files=args.file,
        session=args.session,
        silent=args.silent,
    ))


if __name__ == "__main__":
    sys.exit(main())
