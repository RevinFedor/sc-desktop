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
    from telethon import TelegramClient, errors, functions, utils
    from tg_concurrent_session import telegram_session
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


def album_groups(paths):
    """Keep order and avoid a singleton tail (11 -> 9+2, 21 -> 10+9+2)."""
    remaining = list(paths)
    groups = []
    while remaining:
        count = 9 if len(remaining) == 11 else min(10, len(remaining))
        groups.append(remaining[:count])
        remaining = remaining[count:]
    return groups


def validate_album(album, images, files):
    if album is None:
        return None
    if not isinstance(album, dict) or set(album) - {"paths", "mode", "caption"}:
        raise ValueError("album must contain only paths, mode and caption")
    if album.get("mode") not in ("photo", "document"):
        raise ValueError("album.mode must explicitly be photo or document")
    paths = album.get("paths")
    if not isinstance(paths, list) or not 2 <= len(paths) <= 50:
        raise ValueError("album.paths must contain 2–50 files")
    if any(not isinstance(p, str) or not p.strip() for p in paths):
        raise ValueError("Every album path must be a nonempty local file path")
    if images or files:
        raise ValueError("album cannot be combined with images/files; use separate calls")
    if not isinstance(album.get("caption", ""), str):
        raise ValueError("album.caption must be plain text")
    if album["mode"] == "photo" and any(not utils.is_image(p) for p in paths):
        raise ValueError("photo albums accept image files only; use document for original files")
    return {"paths": paths, "mode": album["mode"], "caption": album.get("caption", "")}


async def account_limits(client, me):
    # config lengths are Unicode codepoints, not UTF-8 bytes or UTF-16 units.
    config = await client(functions.help.GetConfigRequest())
    caption_limit = int(config.caption_length_max)
    source = "help.getConfig.caption_length_max"
    if getattr(me, "premium", False):
        app_config = await client(functions.help.GetAppConfigRequest(hash=0))
        values = getattr(getattr(app_config, "config", None), "value", [])
        for entry in values:
            if entry.key == "caption_length_limit_premium":
                caption_limit = int(entry.value.value)
                source = "help.getAppConfig.caption_length_limit_premium"
                break
    return {
        "album_max_files": 10,
        "caption_max_chars": caption_limit,
        "message_max_chars": min(4096, int(config.message_length_max)),
        "caption_limit_source": source,
        "premium": bool(getattr(me, "premium", False)),
    }


def attachment_receipt(msg, path, **extra):
    file = getattr(msg, "file", None)
    return {
        "message_id": getattr(msg, "id", None),
        "message_ids": [getattr(msg, "id", None)],
        # Telegram IDs are int64; a JS number would silently lose precision.
        "grouped_id": str(msg.grouped_id) if getattr(msg, "grouped_id", None) is not None else None,
        "caption": getattr(msg, "message", "") or "",
        "date": _message_date(msg),
        "path": path,
        "name": getattr(file, "name", None),
        "bytes": getattr(file, "size", None),
        "mime_type": getattr(file, "mime_type", None),
        "media_kind": "document" if getattr(msg, "document", None) else "photo" if getattr(msg, "photo", None) else None,
        "local_bytes": Path(path).stat().st_size,
        **extra,
    }


class DeliveryVerificationError(Exception):
    pass


async def verify_album(client, messages, paths, mode, caption):
    ids = [getattr(msg, "id", None) for msg in messages]
    if len(ids) != len(paths) or not all(ids):
        raise DeliveryVerificationError("Incomplete Telegram ACK; inspect Saved Messages before retrying")
    live = await client.get_messages("me", ids=ids)
    if len(live) != len(paths) or any(not m or getattr(m, "id", None) != mid for m, mid in zip(live, ids)):
        raise DeliveryVerificationError("Could not read back all delivered messages; do not resend blindly")
    receipts = [attachment_receipt(m, p) for m, p in zip(live, paths)]
    groups = {r["grouped_id"] for r in receipts}
    if len(groups) != 1 or None in groups:
        raise DeliveryVerificationError("Telegram did not return a single media group")
    if ids != sorted(ids):
        raise DeliveryVerificationError("Telegram returned a different file order")
    for index, receipt in enumerate(receipts):
        if receipt["caption"] != (caption if index == 0 else ""):
            raise DeliveryVerificationError("Caption read-back differs from the requested plain text")
        if receipt["media_kind"] != mode:
            raise DeliveryVerificationError("Delivered media type differs from the selected mode")
        if mode == "document" and (receipt["name"] != Path(paths[index]).name or receipt["bytes"] != receipt["local_bytes"]):
            raise DeliveryVerificationError("Delivered document name/size differs from the local original")
    return receipts


async def send_saved(text="", images=None, files=None, session=None, silent=False, album=None):
    text = "" if text is None else str(text)
    images = images or []
    files = files or []
    try:
        album = validate_album(album, images, files)
    except ValueError as ex:
        emit({"type": "error", "message": str(ex), "code": "invalid_album"})
        return 2
    if not text.strip() and not images and not files and not album:
        emit({
            "type": "error",
            "message": "Text, images, files, or album are required.",
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
    album_paths = _validate_local_files(album["paths"], "Album file") if album else []
    if album_paths is None:
        return 2
    groups = album_groups(album_paths)

    try:
        api_id, api_hash = telegram_credentials()
    except RuntimeError as ex:
        emit({"type": "error", "message": str(ex), "code": "telegram_credentials_missing"})
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
        telegram_session(str(session_path).replace(".session", "")),
        api_id,
        api_hash,
        flood_sleep_threshold=0,
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
    in_flight = False
    current_album = None
    limits = None
    try:
        if album:
            me = await client.get_me()
            limits = await account_limits(client, me)
            caption = album["caption"]
            if len(caption) > limits["caption_max_chars"] or len(text) > limits["message_max_chars"]:
                emit({
                    "type": "error", "code": "caption_too_long" if len(caption) > limits["caption_max_chars"] else "text_too_long",
                    "message": "Content exceeds this account's Telegram limit. Nothing sent. Shorten the caption or send the full explanation in separate text messages; it will not be truncated.",
                    "caption_chars": len(caption), "text_chars": len(text), "limits": limits,
                    "sent": 0, "session": session_path.stem,
                })
                return 2
            emit({
                "type": "preflight", "session": session_path.stem,
                "target": "saved_messages", "account": {"id": me.id, "username": me.username},
                "mode": album["mode"], "groups": [len(group) for group in groups],
                "caption_chars": len(caption), "limits": limits,
            })
        if text:
            in_flight = True
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
            in_flight = False

        for p in image_paths:
            in_flight = True
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
            in_flight = False

        for p in file_paths:
            in_flight = True
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
            in_flight = False

        for album_index, paths in enumerate(groups):
            current_album = album_index + 1
            # One list -> one SendMultiMediaRequest, with one caption only.
            # force_document=True bypasses Telethon's photo conversion entirely.
            in_flight = True
            messages = await client.send_file(
                "me", paths,
                caption=[album["caption"]] + [""] * (len(paths) - 1),
                force_document=album["mode"] == "document",
                parse_mode=None,
                silent=bool(silent),
            )
            if not isinstance(messages, (list, tuple)):
                messages = [messages] if messages else []
            # Preserve the ACK before read-back so partial results survive a
            # later error. Never automatically replay a send after an error.
            for index, (msg, p) in enumerate(zip(messages, paths)):
                if msg is None:
                    continue
                sent_total += 1
                emit({
                    "type": "sent", "kind": "image" if album["mode"] == "photo" else "file",
                    "target": "saved_messages", "session": session_path.stem,
                    "album_index": current_album, "index_in_album": index + 1,
                    "silent": bool(silent), **attachment_receipt(msg, p),
                })
            in_flight = False
            verified = await verify_album(client, messages, paths, album["mode"], album["caption"])
            emit({
                "type": "album_verified", "album_index": current_album,
                "mode": album["mode"], "grouped_id": verified[0]["grouped_id"],
                "caption": album["caption"], "messages": verified,
                "verification": "telegram_read_back",
            })

        emit({
            "type": "done",
            "target": "saved_messages",
            "session": session_path.stem,
            "sent": sent_total,
            "text": 1 if text else 0,
            "images": len(image_paths) + (len(album_paths) if album and album["mode"] == "photo" else 0),
            "files": len(file_paths) + (len(album_paths) if album and album["mode"] == "document" else 0),
            "albums": len(groups),
            "limits": limits,
        })
        return 0
    except Exception as ex:
        uncertain = in_flight and not isinstance(ex, errors.RPCError)
        emit({
            "type": "error",
            "message": f"{type(ex).__name__}: {ex}",
            "code": "telegram_flood_wait" if isinstance(ex, errors.FloodWaitError) else "delivery_verification_failed" if isinstance(ex, DeliveryVerificationError) else "delivery_unknown" if uncertain else "send_failed",
            "session": session_path.stem,
            "sent": sent_total,
            "album_index": current_album,
            "delivery_uncertain": uncertain or isinstance(ex, DeliveryVerificationError),
            "retry_after_seconds": ex.seconds if isinstance(ex, errors.FloodWaitError) else None,
            "retry_advice": "Inspect Saved Messages and the returned sent receipts before retrying. Already delivered files are not rolled back.",
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
    parser.add_argument("--album-json", default=None)
    parser.add_argument("--session", default=None)
    parser.add_argument("--silent", action="store_true")
    args = parser.parse_args()
    try:
        album = json.loads(args.album_json) if args.album_json is not None else None
    except (ValueError, TypeError) as ex:
        emit({"type": "error", "code": "invalid_album", "message": str(ex)})
        return 2
    return asyncio.run(send_saved(
        args.text,
        images=args.image,
        files=args.file,
        session=args.session,
        silent=args.silent,
        album=album,
    ))


if __name__ == "__main__":
    sys.exit(main())
