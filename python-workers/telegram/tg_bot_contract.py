"""Safe keyboard originals and exact bot reads. No implicit navigation/clicks."""
import asyncio
import base64
import hashlib
import json
from datetime import datetime, timezone
from urllib.parse import urlparse
import re
import unicodedata

from telethon import functions, types, utils


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def safe_tl(value):
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value) if abs(value) > 9007199254740991 else value
    if isinstance(value, bytes):
        return {"encoding": "base64", "value": base64.b64encode(value).decode("ascii")}
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [safe_tl(child) for child in value]
    if isinstance(value, dict):
        return {str(key): safe_tl(child) for key, child in value.items()}
    if hasattr(value, "to_dict"):
        return safe_tl(value.to_dict())
    return str(value)


def keyboard_original(message, *, row_offset=0, max_rows=100, max_bytes=65536):
    markup = getattr(message, "reply_markup", None)
    raw = safe_tl(markup) if markup is not None else None
    canonical = json.dumps(raw, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    peer = getattr(message, "peer_id", None)
    marked = str(utils.get_peer_id(peer)) if peer is not None else None
    text_hash = digest(getattr(message, "message", None) or "")
    binding = {"peer_id": marked, "message_id": message.id,
               "text_sha256": text_hash, "markup_sha256": digest(canonical)}
    binding_hash = digest(json.dumps(binding, sort_keys=True, separators=(",", ":")))
    rows = list(getattr(markup, "rows", None) or [])
    buttons, used, end, blocked_row = [], 0, row_offset, False
    for number, row in enumerate(rows[row_offset:row_offset + max_rows], row_offset):
        converted = []
        for column, button in enumerate(getattr(row, "buttons", None) or []):
            kind = type(button).__name__
            action = {"KeyboardButton": "reply_text", "KeyboardButtonUrl": "url",
                      "KeyboardButtonCallback": "callback"}.get(kind, "unsupported")
            # WebView/Auth/Buy/phone/location/poll/switch-inline are metadata,
            # never treated as generic callback or ordinary URL navigation.
            entry = {"row": number, "column": column, "kind": kind,
                     "action_kind": action, "label": getattr(button, "text", None),
                     "raw": safe_tl(button), "supported_action": action != "unsupported"}
            if action == "url":
                entry["url"] = button.url
            if action == "callback":
                payload = getattr(button, "data", b"") or b""
                entry.update(data_base64=base64.b64encode(payload).decode("ascii"),
                             data_sha256=hashlib.sha256(payload).hexdigest(),
                             requires_password=bool(getattr(button, "requires_password", False)))
                if entry["requires_password"]:
                    entry["supported_action"] = False
            converted.append(entry)
        size = len(json.dumps(converted, ensure_ascii=False).encode("utf-8"))
        if used + size > max_bytes:
            blocked_row = end == row_offset
            break
        buttons.extend(converted)
        used += size
        end = number + 1
    return {"version": 1, "present": markup is not None,
            "kind": type(markup).__name__ if markup is not None else None,
            "binding": binding, "binding_hash": binding_hash,
            "hash_scope": "full_current_markup_and_message_identity",
            "row_offset": row_offset, "total_rows": len(rows),
            "returned_rows": max(0, end - row_offset),
            "total_buttons": sum(len(getattr(row, "buttons", None) or []) for row in rows),
            "buttons": buttons, "next_row_offset": end if end < len(rows) and not blocked_row else None,
            "truncated": end < len(rows), "returned_utf8_bytes": used,
            "blocked_row_too_large": blocked_row,
            "raw_header": {key: value for key, value in (raw or {}).items() if key != "rows"},
            "unsafe_int64_encoding": "decimal_strings", "bytes_encoding": "base64",
            "privacy": "may_contain_private_invites_do_not_publish_or_send_to_external_ai",
            "ui_active_keyboard_proven": False}


class BotContractError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def incoming_bot_message(message, entity):
    if message is None or getattr(message, "out", False) or not getattr(message, "peer_id", None):
        return False
    if str(utils.get_peer_id(message.peer_id)) != str(entity.id):
        return False
    # Check the actual TL from_id, not a cached sender_id that an adapter may
    # have populated before edits. In an incoming private user dialog, omitted
    # from_id is the dialog peer; forward-origin is a separate attribution.
    sender = getattr(message, "from_id", None)
    return sender is None or str(utils.get_peer_id(sender)) == str(entity.id)


async def verified_bot(client, request):
    from tg_send_text_ndjson import strict_entity, normalize_target
    me = await asyncio.wait_for(client.get_me(), timeout=5)
    if str(me.id) != str(request["expected_account_id"]):
        raise BotContractError("bot_account_mismatch", "Selected account changed")
    entity = await strict_entity(client, normalize_target(request["bot"]))
    if str(utils.get_peer_id(entity)) != str(request["expected_peer_id"]):
        raise BotContractError("bot_peer_mismatch", "Bot peer identity changed")
    if not isinstance(entity, types.User) or not getattr(entity, "bot", False):
        raise BotContractError("not_a_bot", "This exact peer is not a Telegram bot")
    return me, entity


async def bot_information(client, request):
    me, entity = await verified_bot(client, request)
    full = await asyncio.wait_for(client(functions.users.GetFullUserRequest(entity)), timeout=15)
    info = getattr(getattr(full, "full_user", None), "bot_info", None)
    commands = getattr(info, "commands", None) if info else None
    menu = getattr(info, "menu_button", None) if info else None
    return {"operation": "bot_info", "account_id": str(me.id),
            "bot": {"peer_id": str(entity.id), "username": entity.username, "is_bot": True},
            "bot_info_available": info is not None,
            "description": getattr(info, "description", None),
            "commands": [{"command": command.command, "description": command.description}
                         for command in commands or []],
            "command_scope": "commands_observed_in_current_user_full_info",
            "menu_button": safe_tl(menu), "menu_kind": type(menu).__name__ if menu else None,
            "read_at": datetime.now(timezone.utc).isoformat(),
            "metadata_sha256": digest(json.dumps(safe_tl(info), sort_keys=True, ensure_ascii=False)),
            "hits": 1, "unique_hits": 1, "truncated": False, "media_downloaded": False}


async def bot_messages(client, request):
    me, entity = await verified_bot(client, request)
    ids = request["message_ids"]
    messages = await asyncio.wait_for(client.get_messages(entity, ids=ids), timeout=15)
    if not isinstance(messages, (list, tuple)):
        messages = [messages]
    by_id = {message.id: message for message in messages if message is not None}
    found, missing = [], []
    for message_id in ids:
        message = by_id.get(message_id)
        if message is None:
            missing.append(message_id)
            continue
        if not incoming_bot_message(message, entity):
            raise BotContractError("bot_message_mismatch", "Requested message is not an incoming message from this bot")
        text = getattr(message, "message", None) or ""
        keyboard = keyboard_original(message, row_offset=request.get("row_offset", 0), max_rows=request.get("max_rows", 100))
        expected = request.get("expected_binding_hashes", {}).get(str(message_id))
        if expected and keyboard["binding_hash"] != expected.lower():
            raise BotContractError("bot_markup_changed", "Current keyboard/message changed between pages")
        found.append({"message_id": message.id, "peer_id": str(entity.id),
                      "account_id": str(me.id), "text": text, "text_sha256": digest(text),
                      "date": message.date.isoformat() if message.date else None,
                      "edit_date": message.edit_date.isoformat() if message.edit_date else None,
                      "entities": safe_tl(getattr(message, "entities", None) or []),
                      "reply_markup": keyboard})
    return {"operation": "bot_messages", "account_id": str(me.id), "peer_id": str(entity.id),
            "messages": found, "requested_message_ids": ids, "missing_message_ids": missing,
            "coverage_scope": "selected_current_messages_only", "historical_version_restored": False,
            "all_selected_messages_found": not missing,
            "hits": len(found), "unique_hits": len(found),
            "truncated": any(row["reply_markup"]["truncated"] for row in found), "media_downloaded": False}


def itkras_link_candidates(read_result):
    """Pure filter: URL buttons only, no callback decoding or link navigation.

    Positive labels are candidate provenance, NOT invite target/membership proof.
    Caller must use the standard read-only invite preview before any join.
    """
    found, excluded, unknown, by_url = [], [], [], {}
    for message in read_result.get("messages", []):
        for button in message.get("reply_markup", {}).get("buttons", []):
            if button.get("action_kind") != "url":
                continue
            label = unicodedata.normalize("NFKC", button.get("label") or "").casefold()
            origin = {"message_id": message["message_id"], "label": button.get("label"),
                      "row": button["row"], "column": button["column"],
                      "binding_hash": message["reply_markup"]["binding_hash"],
                      "text_sha256": message["text_sha256"]}
            if re.search(r"(?:^|\W)(?:ом|om)(?:\W|$)", label):
                excluded.append({**origin, "reason": "om_not_authorized"})
                continue
            if "красавчик" not in label and "itkras" not in label and label != "атк: красавы":
                unknown.append({**origin, "reason": "not_positively_itkras_labelled"})
                continue
            url = button.get("url") or ""
            parsed = urlparse(url)
            host = parsed.netloc.casefold()
            parts = [part for part in parsed.path.split("/") if part]
            target = None
            if parsed.scheme in ("http", "https") and host in ("t.me", "telegram.me") and not parsed.query and not parsed.fragment:
                if len(parts) == 1 and re.fullmatch(r"\+[A-Za-z0-9_-]{4,256}", parts[0]):
                    target = "https://t.me/" + parts[0]
                elif len(parts) == 2 and parts[0] == "joinchat" and re.fullmatch(r"[A-Za-z0-9_-]{4,256}", parts[1]):
                    target = "https://t.me/+" + parts[1]
                elif len(parts) == 1 and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,63}", parts[0]):
                    target = "https://t.me/" + parts[0].lower()
            if target is None:
                unknown.append({**origin, "reason": "not_a_plain_telegram_invite_or_public_chat_target"})
                continue
            if target not in by_url:
                entry = {"target": target, "provenance": [], "status": "available_membership_unchecked",
                         "target_identity_verified": False, "join_authorized_by_label_alone": False}
                by_url[target] = entry
                found.append(entry)
            by_url[target]["provenance"].append(origin)
    return {"links": found, "excluded": excluded, "unknown": unknown,
            "bot_pages_requested": read_result.get("requested_message_ids", []),
            "coverage_complete_for_selected_markup": read_result.get("all_selected_messages_found", False)
                and not read_result.get("truncated", True),
            "membership_or_invite_identity_not_checked": True}
