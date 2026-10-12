#!/usr/bin/env python3
"""Live Telegram read, media, membership and discovery worker.

The request is one JSON object on stdin. Results are NDJSON on stdout so the
Electron job-runner can expose progress, cancellation and a bounded in-memory
result without materialising message history in library.db. Search/context/range
never download media; attachment/transcription download one selected file;
join/leave mutate membership only after an explicit confirmed MCP request.
"""

import argparse
import asyncio
import hashlib
import json
import platform
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

if sys.platform == "darwin" and not platform.mac_ver()[0]:
    try:
        _release = subprocess.check_output(
            ["/usr/bin/sw_vers", "-productVersion"], text=True
        ).strip()
    except Exception:
        _release = "14.0"
    platform.mac_ver = lambda: (_release, ("", "", ""), platform.machine())

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "shared"))

from credentials import telegram_credentials
from tg_session_path import connect_authorized, resolve_session_path
from tg_message_payload import forward_metadata, message_media, reply_metadata
from tg_attachment_cache import (
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_TEXT_CHARS,
    cleanup_current_process_parts,
    materialize_message_attachment,
    write_attachment_transcript,
)
from soniox_utils import transcribe_file as transcribe_soniox_file
from telethon import TelegramClient, errors, functions, types
from telethon.extensions import markdown
from telethon.utils import get_peer_id
from tg_concurrent_session import telegram_session
from telethon.tl.types import PeerChannel, PeerChat, PeerUser
from tg_bot_contract import keyboard_original, bot_information, bot_messages

SELECTED_ORIGINAL_ACCOUNT_TIMEOUT_SECONDS = 5.0


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def fail(message, code="telegram_live_failed", **extra):
    emit({"type": "error", "message": str(message), "code": code, **extra})


def bump_busy_timeout(client, timeout_ms=30000):
    try:
        session = getattr(client, "session", None)
        conn = getattr(session, "_conn", None) if session else None
        if conn is not None:
            conn.execute(f"PRAGMA busy_timeout = {int(timeout_ms)}")
    except Exception:
        pass


def normalized_title(value):
    return " ".join(str(value or "").casefold().split())


def parse_message_url(value):
    raw = str(value or "").strip()
    if not raw:
        return None
    if not re.match(r"^https?://", raw, re.I):
        return None
    parsed = urlparse(raw)
    host = parsed.netloc.casefold().split(":", 1)[0]
    if host not in {"t.me", "telegram.me", "www.t.me", "www.telegram.me"}:
        return None
    segments = [segment for segment in parsed.path.split("/") if segment]
    if len(segments) < 2:
        return None
    message_segment = segments[-1]
    if not message_segment.isdigit():
        return None
    message_id = int(message_segment)
    if segments[0].casefold() == "c":
        if len(segments) < 3 or not segments[1].isdigit():
            return None
        topic_id = int(segments[-2]) if len(segments) >= 4 and segments[-2].isdigit() else None
        return {
            "chat": segments[1],
            "chat_key": f"c:{segments[1]}",
            "message_id": message_id,
            "topic_id": topic_id,
        }
    handle = segments[0].lstrip("@")
    topic_id = int(segments[-2]) if len(segments) >= 3 and segments[-2].isdigit() else None
    return {
        "chat": handle,
        "chat_key": f"u:{handle.casefold()}",
        "message_id": message_id,
        "topic_id": topic_id,
    }


def parse_membership_target(value):
    """Parse a public username/chat link or Telegram invite link."""
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("target is required")
    candidate = raw
    if re.match(r"^(?:www\.)?(?:t|telegram)\.me/", candidate, re.I):
        candidate = "https://" + candidate
    if re.match(r"^https?://", candidate, re.I):
        parsed = urlparse(candidate)
        host = parsed.netloc.casefold().split(":", 1)[0]
        if host not in {"t.me", "telegram.me", "www.t.me", "www.telegram.me"}:
            raise ValueError("target must be a t.me link or @username")
        segments = [segment for segment in parsed.path.split("/") if segment]
        if not segments:
            raise ValueError("Telegram link has no chat or invite target")
        first = segments[0]
        if first.startswith("+"):
            invite_hash = first[1:]
            if not re.fullmatch(r"[A-Za-z0-9_-]{4,256}", invite_hash):
                raise ValueError("invalid Telegram invite hash")
            return {"kind": "invite", "invite_hash": invite_hash, "target": raw}
        if first.casefold() == "joinchat":
            if len(segments) < 2 or not re.fullmatch(r"[A-Za-z0-9_-]{4,256}", segments[1]):
                raise ValueError("invalid Telegram joinchat link")
            return {"kind": "invite", "invite_hash": segments[1], "target": raw}
        if first.casefold() == "s" and len(segments) >= 2:
            first = segments[1]
        if first.casefold() == "c":
            raise ValueError("t.me/c links do not contain an invite hash; pass @username or an invite link")
        username = first.lstrip("@")
    else:
        username = raw.lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9_]{3,64}", username):
        raise ValueError("invalid Telegram public username")
    return {"kind": "public", "username": username, "target": raw}


def chat_target_from_value(value):
    parsed = parse_message_url(value)
    if parsed:
        return parsed["chat"]
    return str(value or "").strip()


async def resolve_entity(client, raw_target):
    target = chat_target_from_value(raw_target).lstrip("@")
    if not target:
        raise ValueError("chat is required")

    numeric = target.lstrip("-").isdigit()
    numeric_id = None
    if numeric:
        numeric_text = target[4:] if target.startswith("-100") else target.lstrip("-")
        numeric_id = int(numeric_text)
        for peer in (PeerChannel(numeric_id), PeerChat(numeric_id), PeerUser(numeric_id)):
            try:
                return await client.get_entity(peer)
            except Exception:
                pass
    else:
        try:
            return await client.get_entity(target)
        except Exception:
            pass

    needle = normalized_title(target)
    exact = []
    fuzzy = []
    async for dialog in client.iter_dialogs():
        entity = dialog.entity
        entity_id = getattr(entity, "id", None)
        username = getattr(entity, "username", None)
        title = dialog.name or getattr(entity, "title", None) or ""
        if numeric_id is not None and int(entity_id or 0) == numeric_id:
            return entity
        values = {normalized_title(title), normalized_title(username)}
        if needle in values:
            exact.append(entity)
        elif needle and any(needle in value for value in values if value):
            fuzzy.append(entity)
    if len(exact) == 1:
        return exact[0]
    if not exact and len(fuzzy) == 1:
        return fuzzy[0]
    if len(exact) > 1 or len(fuzzy) > 1:
        candidates = exact or fuzzy
        names = [
            getattr(entity, "title", None)
            or getattr(entity, "first_name", None)
            or getattr(entity, "username", None)
            or str(getattr(entity, "id", "?"))
            for entity in candidates[:8]
        ]
        raise ValueError(f"chat title is ambiguous: {', '.join(names)}")
    raise ValueError(f"cannot resolve Telegram chat: {raw_target}")


def entity_kind(entity):
    if isinstance(entity, types.User):
        return "user"
    if isinstance(entity, types.Chat):
        return "chat"
    if isinstance(entity, types.Channel):
        return "group" if getattr(entity, "megagroup", False) else "channel"
    return "unknown"


def entity_title(entity):
    if isinstance(entity, types.User):
        return " ".join(
            part for part in [getattr(entity, "first_name", None), getattr(entity, "last_name", None)]
            if part
        ) or getattr(entity, "username", None) or str(entity.id)
    return getattr(entity, "title", None) or getattr(entity, "username", None) or str(entity.id)


def chat_ref(entity):
    return {
        "id": getattr(entity, "id", None),
        "title": entity_title(entity),
        "username": getattr(entity, "username", None),
        "kind": entity_kind(entity),
        "forum": bool(getattr(entity, "forum", False)),
    }


def membership_type(entity):
    if isinstance(entity, types.Channel):
        return "supergroup" if getattr(entity, "megagroup", False) else "channel"
    if isinstance(entity, types.Chat):
        return "group"
    return "unknown"


def membership_source_kind(entity):
    if isinstance(entity, types.Channel):
        return "group" if getattr(entity, "megagroup", False) else "channel"
    if isinstance(entity, types.Chat):
        return "chat"
    return "unknown"


async def membership_chat_ref(client, entity, *, include_full=True):
    participants = getattr(entity, "participants_count", None)
    linked_chat_id = None
    has_discussion = False if isinstance(entity, types.Chat) else None
    if include_full and isinstance(entity, types.Channel):
        try:
            full = await client(functions.channels.GetFullChannelRequest(entity))
            full_chat = getattr(full, "full_chat", None)
            participants = getattr(full_chat, "participants_count", None) or participants
            linked_chat_id = getattr(full_chat, "linked_chat_id", None)
            has_discussion = bool(linked_chat_id)
        except Exception:
            # Joining/leaving already succeeded; missing optional counters must
            # not turn that external mutation into a reported failure.
            pass
    username = getattr(entity, "username", None)
    return {
        "id": getattr(entity, "id", None),
        "title": entity_title(entity),
        "username": username,
        "type": membership_type(entity),
        "source_kind": membership_source_kind(entity),
        "participants_count": participants,
        "has_discussion": has_discussion,
        "linked_discussion_id": linked_chat_id,
        "public": bool(username),
        "member": not bool(getattr(entity, "left", False)),
        "url": f"https://t.me/{username}" if username else None,
    }


def invite_preview_ref(invite):
    if isinstance(invite, types.ChatInviteAlready):
        return None
    if getattr(invite, "megagroup", False):
        chat_type = "supergroup"
    elif getattr(invite, "broadcast", False) or getattr(invite, "channel", False):
        chat_type = "channel"
    else:
        chat_type = "group"
    return {
        "id": None,
        "title": getattr(invite, "title", None),
        "username": None,
        "type": chat_type,
        "source_kind": "group" if chat_type == "supergroup" else ("channel" if chat_type == "channel" else "chat"),
        "participants_count": getattr(invite, "participants_count", None),
        "has_discussion": None,
        "linked_discussion_id": None,
        "public": False,
        "member": False,
        "url": None,
    }


def chat_from_updates(updates):
    chats = list(getattr(updates, "chats", None) or [])
    for entity in chats:
        if isinstance(entity, (types.Channel, types.Chat)):
            return entity
    return None


def telegram_error_payload(error):
    if isinstance(error, errors.FloodWaitError):
        seconds = int(getattr(error, "seconds", 0) or 0)
        return {
            "message": f"Telegram rate limit: retry after {seconds} seconds",
            "code": "telegram_flood_wait",
            "retry_after_seconds": seconds,
        }
    if isinstance(error, errors.ChannelsTooMuchError):
        return {
            "message": "Telegram account has reached its joined chats/channels limit",
            "code": "telegram_join_limit_reached",
        }
    if isinstance(error, (errors.InviteHashExpiredError, errors.InviteHashInvalidError)):
        return {
            "message": "Telegram invite link is invalid or expired",
            "code": "telegram_invite_invalid",
        }
    if isinstance(error, (errors.UsernameInvalidError, errors.UsernameNotOccupiedError)):
        return {
            "message": "Telegram public chat username was not found",
            "code": "telegram_public_chat_not_found",
        }
    if isinstance(error, errors.UserCreatorError):
        return {
            "message": "Telegram does not allow the creator to leave this chat",
            "code": "telegram_leave_forbidden",
        }
    if isinstance(error, errors.ChannelPrivateError):
        return {
            "message": "Telegram chat is private or the selected account no longer has access",
            "code": "telegram_chat_private",
        }
    return None


def message_link(entity, message_id, topic_id=None):
    username = getattr(entity, "username", None)
    if username:
        if topic_id and int(topic_id) > 1:
            return f"https://t.me/{username}/{int(topic_id)}/{int(message_id)}"
        return f"https://t.me/{username}/{int(message_id)}"
    if isinstance(entity, types.Channel):
        if topic_id and int(topic_id) > 1:
            return f"https://t.me/c/{entity.id}/{int(topic_id)}/{int(message_id)}"
        return f"https://t.me/c/{entity.id}/{int(message_id)}"
    return None


def reply_fields(message):
    reply = getattr(message, "reply_to", None)
    if not reply:
        return None, None, False
    metadata = reply_metadata(message)
    parent = metadata["parent_external_id"]
    scope = metadata["telegram_reply"]["scope"]
    # A top/root ID in another peer is not a local GetReplies/GetMessages ID.
    local_top = getattr(reply, "reply_to_top_id", None) if scope in ("same_peer", "topic_anchor", "none") else None
    return int(parent) if parent is not None else None, local_top, bool(getattr(reply, "forum_topic", False))


def message_type(message):
    media = getattr(message, "media", None)
    if isinstance(media, types.MessageMediaPhoto):
        return "photo"
    if isinstance(media, types.MessageMediaPoll):
        return "poll"
    if isinstance(media, types.MessageMediaGeo):
        return "geo"
    if isinstance(media, types.MessageMediaContact):
        return "contact"
    document = getattr(media, "document", None)
    if document is not None:
        for attribute in getattr(document, "attributes", []) or []:
            if isinstance(attribute, types.DocumentAttributeAudio):
                return "voice" if getattr(attribute, "voice", False) else "audio"
            if isinstance(attribute, types.DocumentAttributeVideo):
                return "video_note" if getattr(attribute, "round_message", False) else "video"
            if isinstance(attribute, types.DocumentAttributeAnimated):
                return "gif"
        return "document"
    if getattr(message, "action", None) is not None:
        return "other"
    return "text"


def reaction_summary(message):
    reactions = getattr(message, "reactions", None)
    rows = getattr(reactions, "results", None) if reactions else None
    if not rows:
        return None
    top = []
    total = 0
    for row in rows:
        count = int(getattr(row, "count", 0) or 0)
        total += count
        reaction = getattr(row, "reaction", None)
        if isinstance(reaction, types.ReactionEmoji):
            emoji = reaction.emoticon
        elif isinstance(reaction, types.ReactionCustomEmoji):
            emoji = f"custom:{reaction.document_id}"
        else:
            emoji = type(reaction).__name__ if reaction is not None else "unknown"
        top.append({"e": emoji, "n": count})
    top.sort(key=lambda row: row["n"], reverse=True)
    return {"total": total, "top": top[:8]}


class MessageFormatter:
    def __init__(self, client, entity, caption_chars):
        self.client = client
        self.entity = entity
        self.caption_chars = max(100, min(8000, int(caption_chars or 1200)))
        self.sender_cache = {}
        self.sender_entities = {}

    def seed_entities(self, entities):
        for entity in entities or []:
            entity_id = getattr(entity, "id", None)
            if entity_id is not None:
                self.sender_entities[int(entity_id)] = entity

    async def sender(self, message):
        sender_id = getattr(message, "sender_id", None)
        if sender_id is None:
            return None
        if sender_id in self.sender_cache:
            return self.sender_cache[sender_id]
        entity = self.sender_entities.get(int(sender_id)) or getattr(message, "sender", None)
        if entity is None:
            try:
                entity = await message.get_sender()
            except Exception:
                entity = None
        if entity is None and getattr(message, "from_id", None) is not None:
            try:
                entity = await self.client.get_entity(message.from_id)
            except Exception:
                entity = None
        if isinstance(entity, types.User):
            name = " ".join(
                part for part in [getattr(entity, "first_name", None), getattr(entity, "last_name", None)]
                if part
            ) or getattr(entity, "username", None) or str(sender_id)
        else:
            name = getattr(entity, "title", None) or getattr(entity, "username", None) or str(sender_id)
        result = {
            "id": sender_id,
            "name": name,
            "username": getattr(entity, "username", None) if entity is not None else None,
        }
        self.sender_cache[sender_id] = result
        return result

    async def format(self, message):
        reply_data = reply_metadata(message)
        reply_id, top_id, forum_topic = reply_fields(message)
        topic_id = top_id if forum_topic and top_id else None
        if forum_topic and topic_id is None and reply_id:
            topic_id = reply_id
        replies = getattr(message, "replies", None)
        action = getattr(message, "action", None)
        kind = message_type(message)
        text = getattr(message, "message", None) or ""
        preview = text[: self.caption_chars]
        return {
            "chat_id": getattr(self.entity, "id", None),
            "chat_title": entity_title(self.entity),
            "chat_username": getattr(self.entity, "username", None),
            "message_id": getattr(message, "id", None),
            "url": message_link(self.entity, message.id, topic_id),
            "date": message.date.isoformat() if getattr(message, "date", None) else None,
            "edit_date": message.edit_date.isoformat() if getattr(message, "edit_date", None) else None,
            "text": preview,
            "text_total_chars": len(text),
            "text_returned_chars": len(preview),
            "text_truncated": len(preview) < len(text),
            "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "text_offset_unit": "unicode_codepoints",
            "sender": await self.sender(message),
            "type": kind,
            "has_media": bool(getattr(message, "media", None)),
            "media": message_media(message, kind),
            "forward": forward_metadata(message),
            "telegram_reply": reply_data["telegram_reply"],
            "external_reply": reply_data["external_reply"],
            "reply_to_message_id": reply_id,
            "reply_to_top_id": top_id,
            "forum_topic": forum_topic,
            "topic_id": topic_id,
            "replies_count": getattr(replies, "replies", None) if replies else None,
            "reactions": reaction_summary(message),
            "views": getattr(message, "views", None),
            "forwards": getattr(message, "forwards", None),
            "service_action": type(action).__name__ if action is not None else None,
            "reply_markup": keyboard_original(message),
        }


def original_text_representation(text, source):
    """Hash the unsliced representation, without normalization or UTF-16 offsets."""
    encoded = text.encode("utf-8")
    return {
        "source": source,
        "text": text,
        "total_chars": len(text),
        "returned_chars": len(text),
        "offset_unit": "unicode_codepoints",
        "utf16_units": len(text.encode("utf-16-le")) // 2,
        "utf8_bytes": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "hash_encoding": "utf-8",
        "truncated": False,
    }


def json_safe_telegram_entity(value):
    """Preserve TL int64 IDs through Electron's JavaScript JSON.parse boundary."""
    if isinstance(value, int) and abs(value) > 9007199254740991:
        return str(value)
    if isinstance(value, dict):
        return {key: json_safe_telegram_entity(child) for key, child in value.items()}
    if isinstance(value, list):
        return [json_safe_telegram_entity(child) for child in value]
    return value


async def selected_message_original(client, message, formatted):
    """One live hit only; bounded hit/root/neighbor fields keep their old limits.

    A fresh read proves the current Telegram body, not a lost historical edit.
    Entities use Telegram UTF-16 offsets and are separate from native text.
    """
    # Optional proof must not turn an otherwise readable legacy context into an
    # error. Consumers requiring account proof reject an unavailable receipt.
    account_id = None
    account_error = None
    try:
        account = await asyncio.wait_for(
            client.get_me(), timeout=SELECTED_ORIGINAL_ACCOUNT_TIMEOUT_SECONDS
        )
        account_id = getattr(account, "id", None)
    except Exception as error:
        account_error = type(error).__name__
    native = getattr(message, "message", None) or ""
    entities = getattr(message, "entities", None) or []
    rendered = markdown.unparse(native, entities)
    worker_path = Path(__file__).resolve()
    return {
        "version": 1,
        "read_at": datetime.now(timezone.utc).isoformat(),
        "current_version_only": True,
        "historical_version_restored": False,
        "account_id": account_id,
        "account_verification": {
            "status": "fresh_get_me" if account_id is not None else "unavailable",
            "error_code": account_error,
        },
        "peer": reply_metadata(message)["telegram_reply"]["source_peer"],
        "marked_peer_id": get_peer_id(message.peer_id),
        "message_id": message.id,
        "sender": formatted["sender"],
        "date": formatted["date"],
        "edit_date": formatted["edit_date"],
        "type": formatted["type"],
        "native": original_text_representation(native, "telegram.message.message"),
        "markdown": original_text_representation(
            rendered, "telethon.extensions.markdown.unparse(message.message, message.entities)"
        ),
        "entities": [json_safe_telegram_entity(entity.to_dict()) for entity in entities],
        "entity_offset_unit": "utf16_code_units",
        "entity_int_encoding": "unsafe_int64_as_decimal_strings",
        "reply_markup": keyboard_original(message),
        "reader": {
            "version": "selected-original-v1",
            "worker_path": str(worker_path),
            "worker_sha256": hashlib.sha256(worker_path.read_bytes()).hexdigest(),
        },
    }


def parse_date(value, *, end_of_day=False):
    if value is None or value == "":
        return None
    text = str(value).strip()
    formats = (
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%d.%m.%Y %H:%M:%S",
        "%d.%m.%Y %H:%M",
        "%d.%m.%Y",
        "%d.%m.%y",
    )
    parsed = None
    for fmt in formats:
        try:
            parsed = datetime.strptime(text, fmt)
            break
        except ValueError:
            continue
    if parsed is None:
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(f"bad date: {value}") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if end_of_day and len(text) <= 10:
        parsed = parsed.replace(hour=23, minute=59, second=59)
    return parsed


def search_filter(name):
    key = str(name or "all").casefold()
    mapping = {
        "all": types.InputMessagesFilterEmpty,
        "photos": types.InputMessagesFilterPhotos,
        "videos": types.InputMessagesFilterVideo,
        "photo_video": types.InputMessagesFilterPhotoVideo,
        "documents": types.InputMessagesFilterDocument,
        "voice": types.InputMessagesFilterVoice,
        "audio": types.InputMessagesFilterMusic,
        "music": types.InputMessagesFilterMusic,
        "links": types.InputMessagesFilterUrl,
        "polls": types.InputMessagesFilterPoll,
        "gifs": types.InputMessagesFilterGif,
    }
    cls = mapping.get(key)
    if cls is None:
        raise ValueError(f"unsupported media_filter: {name}")
    return cls()


async def run_search(client, request):
    searches = request.get("searches") or []
    concurrency = max(1, min(5, int(request.get("concurrency") or 3)))
    max_candidates = max(1, min(500, int(request.get("max_candidates") or 250)))
    caption_chars = int(request.get("caption_chars") or 1200)
    entities = {}
    input_peers = {}
    formatters = {}
    for search in searches:
        target = str(search.get("chat") or "")
        if target not in entities:
            entity = await resolve_entity(client, target)
            entities[target] = entity
            input_peers[target] = await client.get_input_entity(entity)
            formatters[target] = MessageFormatter(client, entity, caption_chars)
            emit({"type": "entity", "chat": chat_ref(entity)})

    semaphore = asyncio.Semaphore(concurrency)
    completed = 0
    running_hits = 0
    progress_lock = asyncio.Lock()

    async def one(index, search):
        nonlocal completed, running_hits
        async with semaphore:
            target = str(search.get("chat") or "")
            entity = entities[target]
            peer = input_peers[target]
            sender_peer = None
            if search.get("sender"):
                sender_entity = await resolve_entity(client, search["sender"])
                sender_peer = await client.get_input_entity(sender_entity)
            started = time.perf_counter()
            response = await client(functions.messages.SearchRequest(
                peer=peer,
                q=str(search.get("query") or ""),
                filter=search_filter(search.get("media_filter")),
                min_date=parse_date(search.get("date_from")),
                max_date=parse_date(search.get("date_to"), end_of_day=True),
                offset_id=int(search.get("offset_id") or 0),
                add_offset=0,
                limit=max(1, min(100, int(search.get("limit") or 20))),
                max_id=0,
                min_id=0,
                hash=0,
                from_id=sender_peer,
                top_msg_id=int(search["topic_id"]) if search.get("topic_id") else None,
            ))
            raw_messages = [
                message for message in (getattr(response, "messages", None) or [])
                if getattr(message, "id", None) is not None
            ]
            formatters[target].seed_entities(
                [*(getattr(response, "users", None) or []), *(getattr(response, "chats", None) or [])]
            )
            formatted = []
            for rank, message in enumerate(raw_messages, 1):
                row = await formatters[target].format(message)
                row["_rank"] = rank
                formatted.append(row)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            ids = [int(row["message_id"]) for row in formatted if row.get("message_id")]
            total = int(getattr(response, "count", len(formatted)) or len(formatted))
            async with progress_lock:
                completed += 1
                running_hits += len(formatted)
                emit({
                    "type": "progress",
                    "stage": "searching",
                    "done": completed,
                    "total": len(searches),
                    "hits": running_hits,
                })
            return {
                "index": index,
                "chat": chat_ref(entity),
                "query": str(search.get("query") or ""),
                "total": total,
                "returned": len(formatted),
                "elapsed_ms": elapsed_ms,
                "next_offset_id": min(ids) if ids and len(formatted) >= int(search.get("limit") or 20) else None,
                "messages": formatted,
            }

    pages = await asyncio.gather(*(one(index, search) for index, search in enumerate(searches)))
    deduped = {}
    order = []
    hits = 0
    summaries = []
    for page in sorted(pages, key=lambda row: row["index"]):
        hits += page["returned"]
        summaries.append({key: value for key, value in page.items() if key != "messages"})
        for row in page["messages"]:
            key = f"{row['chat_id']}:{row['message_id']}"
            match = {
                "search_index": page["index"],
                "query": page["query"],
                "rank": row.pop("_rank", None),
            }
            if key not in deduped:
                row["matches"] = [match]
                deduped[key] = row
                order.append(key)
            else:
                deduped[key]["matches"].append(match)
    truncated = len(order) > max_candidates
    order = order[:max_candidates]
    messages = [deduped[key] for key in order]
    return {
        "operation": "search",
        "searches": summaries,
        "messages": messages,
        "hits": hits,
        "unique_hits": len(messages),
        "truncated": truncated,
        "media_downloaded": False,
    }


async def ancestor_chain(client, entity, hit, max_depth):
    ancestors = []
    seen = {hit.id}
    current = hit
    current_peer = reply_metadata(hit)["telegram_reply"]["source_peer"]
    for _ in range(max_depth):
        reply_id, _, _ = reply_fields(current)
        if not reply_id or reply_id in seen:
            break
        parent = await client.get_messages(entity, ids=reply_id)
        if parent is None:
            break
        parent_peer = reply_metadata(parent)["telegram_reply"]["source_peer"]
        if current_peer is not None and parent_peer is not None and parent_peer != current_peer:
            break
        ancestors.append(parent)
        seen.add(parent.id)
        current = parent
    ancestors.reverse()
    return ancestors


async def run_context(client, request):
    parsed = parse_message_url(request.get("url")) if request.get("url") else None
    target = request.get("chat") or (parsed and parsed["chat"])
    message_id = request.get("message_id") or (parsed and parsed["message_id"])
    if not target or not message_id:
        raise ValueError("context requires url or chat + message_id")
    entity = await resolve_entity(client, target)
    emit({"type": "entity", "chat": chat_ref(entity)})
    hit = await client.get_messages(entity, ids=int(message_id))
    if hit is None:
        raise ValueError(f"Telegram message not found: {message_id}")
    formatter = MessageFormatter(client, entity, request.get("caption_chars") or 8000)
    before_count = max(0, min(100, int(request.get("before") or 0)))
    after_count = max(0, min(100, int(request.get("after") or 0)))
    max_depth = max(0, min(50, int(request.get("max_depth") or 0)))
    max_replies = max(0, min(500, int(request.get("max_replies") or 0)))
    reply_id, top_id, _ = reply_fields(hit)
    replies_meta = getattr(hit, "replies", None)
    root_id = int(top_id or (hit.id if getattr(replies_meta, "replies", 0) else (reply_id or hit.id)))

    async def older():
        if before_count <= 0:
            return []
        rows = await client.get_messages(entity, limit=before_count, offset_id=hit.id)
        return list(reversed([row for row in rows if row is not None and row.id != hit.id]))

    async def newer():
        if after_count <= 0:
            return []
        rows = await client.get_messages(
            entity, limit=after_count, min_id=hit.id, reverse=True
        )
        return [row for row in rows if row is not None and row.id != hit.id]

    async def replies():
        if max_replies <= 0:
            return [], False
        rows = []
        async for row in client.iter_messages(entity, reply_to=root_id, limit=max_replies + 1):
            if row.id != root_id:
                rows.append(row)
        truncated = len(rows) > max_replies
        rows = rows[:max_replies]
        rows.reverse()
        return rows, truncated

    ancestors_task = asyncio.create_task(ancestor_chain(client, entity, hit, max_depth))
    older_task = asyncio.create_task(older())
    newer_task = asyncio.create_task(newer())
    replies_task = asyncio.create_task(replies())
    ancestors, before_rows, after_rows, reply_result = await asyncio.gather(
        ancestors_task, older_task, newer_task, replies_task
    )
    reply_rows, replies_truncated = reply_result
    root = hit if root_id == hit.id else await client.get_messages(entity, ids=root_id)

    async def formatted(rows):
        return [await formatter.format(row) for row in rows if row is not None]

    hit_row = await formatter.format(hit)
    selected_original = await selected_message_original(client, hit, hit_row)
    root_row = await formatter.format(root) if root is not None else None
    ancestors_rows = await formatted(ancestors)
    before_formatted = await formatted(before_rows)
    after_formatted = await formatted(after_rows)
    replies_formatted = await formatted(reply_rows)

    merged = {}
    for row in [*ancestors_rows, *before_formatted, hit_row, *after_formatted, *replies_formatted]:
        merged[row["message_id"]] = row
    conversation = sorted(
        merged.values(),
        key=lambda row: (row.get("date") or "", int(row.get("message_id") or 0)),
    )
    return {
        "operation": "context",
        "chat": chat_ref(entity),
        "hit": hit_row,
        "selected_original": selected_original,
        "root": root_row,
        "ancestors": ancestors_rows,
        "descendants": replies_formatted,
        "neighbors": {
            "before": before_formatted,
            "after": after_formatted,
        },
        "conversation": conversation,
        "replies_truncated": replies_truncated,
        "media_downloaded": False,
        "hits": 1,
        "unique_hits": len(conversation),
        "truncated": replies_truncated,
    }


async def run_range(client, request):
    from_ref = parse_message_url(request.get("from_url")) if request.get("from_url") else None
    to_ref = parse_message_url(request.get("to_url")) if request.get("to_url") else None
    if from_ref and to_ref and from_ref["chat_key"] != to_ref["chat_key"]:
        raise ValueError("range endpoints belong to different Telegram chats")
    target = request.get("chat") or (from_ref and from_ref["chat"]) or (to_ref and to_ref["chat"])
    from_id = request.get("from_id") or (from_ref and from_ref["message_id"])
    to_id = request.get("to_id") or (to_ref and to_ref["message_id"])
    if not target or not from_id or not to_id:
        raise ValueError("range requires from_url + to_url or chat + from_id + to_id")
    low, high = sorted((int(from_id), int(to_id)))
    requested_count = high - low + 1
    max_messages = max(1, min(5000, int(request.get("max_messages") or 1000)))
    if requested_count > max_messages:
        raise ValueError(
            f"Telegram range has {requested_count} ids; max_messages is {max_messages}"
        )
    entity = await resolve_entity(client, target)
    emit({"type": "entity", "chat": chat_ref(entity)})
    formatter = MessageFormatter(client, entity, request.get("caption_chars") or 8000)
    messages = []
    ids = list(range(low, high + 1))
    chunk_size = 100
    for start in range(0, len(ids), chunk_size):
        chunk = ids[start : start + chunk_size]
        rows = await client.get_messages(entity, ids=chunk)
        for row in rows or []:
            if row is not None:
                messages.append(await formatter.format(row))
        emit({
            "type": "progress",
            "stage": "reading_range",
            "done": min(start + len(chunk), len(ids)),
            "total": len(ids),
            "hits": len(messages),
            "unique_hits": len(messages),
        })
    messages.sort(key=lambda row: int(row.get("message_id") or 0))
    found_ids = {int(row["message_id"]) for row in messages}
    missing = [message_id for message_id in ids if message_id not in found_ids]
    return {
        "operation": "range",
        "chat": chat_ref(entity),
        "from_id": low,
        "to_id": high,
        "requested": requested_count,
        "returned": len(messages),
        "missing_ids": missing,
        "messages": messages,
        "hits": len(messages),
        "unique_hits": len(messages),
        "truncated": False,
        "media_downloaded": False,
    }


async def run_attachment(client, request):
    parsed = parse_message_url(request.get("url")) if request.get("url") else None
    target = request.get("chat") or (parsed and parsed["chat"])
    message_id = request.get("message_id") or (parsed and parsed["message_id"])
    if not target or not message_id:
        raise ValueError("attachment requires url or chat + message_id")

    entity = await resolve_entity(client, target)
    emit({"type": "entity", "chat": chat_ref(entity)})
    emit({
        "type": "progress",
        "stage": "resolving_attachment",
        "done": 0,
        "total": 1,
        "hits": 0,
        "unique_hits": 0,
    })
    message = await client.get_messages(entity, ids=int(message_id))
    if message is None:
        raise ValueError(f"Telegram message not found: {message_id}")

    formatter = MessageFormatter(client, entity, request.get("caption_chars") or 8000)
    formatted = await formatter.format(message)
    media = formatted.get("media") or []
    if not media:
        return {
            "operation": "attachment",
            "chat": chat_ref(entity),
            "message": formatted,
            "attachment_found": False,
            "attachment": None,
            "file_path": None,
            "media_downloaded": False,
            "limitation": "message has no downloadable file attachment",
            "hits": 1,
            "unique_hits": 1,
            "truncated": False,
        }

    last_progress = {"at": 0.0}

    def on_download_progress(current, total):
        now = time.monotonic()
        if current < total and now - last_progress["at"] < 0.25:
            return
        last_progress["at"] = now
        emit({
            "type": "progress",
            "stage": "downloading_attachment",
            "done": 0,
            "total": 1,
            "hits": 1,
            "unique_hits": 1,
            "bytes_done": int(current or 0),
            "bytes_total": int(total or media[0].get("bytes") or 0),
            "file_name": media[0].get("file_name"),
        })

    attachment = await materialize_message_attachment(
        message,
        chat_id=getattr(entity, "id", 0),
        message_id=int(message_id),
        attachment=media[0],
        max_bytes=int(request.get("max_bytes") or DEFAULT_MAX_BYTES),
        max_text_chars=int(request.get("max_text_chars") or DEFAULT_MAX_TEXT_CHARS),
        progress_callback=on_download_progress,
    )
    emit({
        "type": "progress",
        "stage": "reading_attachment",
        "done": 1,
        "total": 1,
        "hits": 1,
        "unique_hits": 1,
        "bytes_done": int(attachment.get("bytes") or 0) if attachment.get("file_path") else 0,
        "bytes_total": int(attachment.get("bytes") or 0),
        "file_name": attachment.get("file_name"),
    })
    extraction = attachment.get("extraction") or {}
    return {
        "operation": "attachment",
        "chat": chat_ref(entity),
        "message": formatted,
        "attachment_found": True,
        "attachment": attachment,
        "file_path": attachment.get("file_path"),
        "media_downloaded": bool(attachment.get("file_path")),
        "limitation": extraction.get("limitation"),
        "hits": 1,
        "unique_hits": 1,
        "truncated": bool(extraction.get("truncated")),
    }


def _trim_transcript(text, max_chars):
    body = str(text or "").replace("\x00", "").strip()
    limit = max(1, min(1_000_000, int(max_chars or DEFAULT_MAX_TEXT_CHARS)))
    if len(body) <= limit:
        return body, False
    return body[:limit] + "\n\n[транскрипт обрезан безопасным лимитом MCP]", True


async def run_transcribe(client, request):
    parsed = parse_message_url(request.get("url")) if request.get("url") else None
    target = request.get("chat") or (parsed and parsed["chat"])
    message_id = request.get("message_id") or (parsed and parsed["message_id"])
    if not target or not message_id:
        raise ValueError("transcribe requires url or chat + message_id")

    entity = await resolve_entity(client, target)
    emit({"type": "entity", "chat": chat_ref(entity)})
    emit({
        "type": "progress",
        "stage": "resolving_transcription",
        "done": 0,
        "total": 1,
        "hits": 0,
        "unique_hits": 0,
    })
    message = await client.get_messages(entity, ids=int(message_id))
    if message is None:
        raise ValueError(f"Telegram message not found: {message_id}")

    formatter = MessageFormatter(client, entity, request.get("caption_chars") or 8000)
    formatted = await formatter.format(message)
    media = formatted.get("media") or []
    message_kind = str(formatted.get("type") or "")
    media_kind = str((media[0] if media else {}).get("kind") or "")
    if not media or message_kind not in {"voice", "audio", "video", "video_note"}:
        raise ValueError(
            f"Telegram message {message_id} is {message_kind or media_kind or 'not media'}, "
            "not voice/audio/video"
        )

    last_progress = {"at": 0.0}

    def on_download_progress(current, total):
        now = time.monotonic()
        if current < total and now - last_progress["at"] < 0.25:
            return
        last_progress["at"] = now
        emit({
            "type": "progress",
            "stage": "downloading_attachment",
            "done": 0,
            "total": 1,
            "hits": 1,
            "unique_hits": 1,
            "bytes_done": int(current or 0),
            "bytes_total": int(total or media[0].get("bytes") or 0),
            "file_name": media[0].get("file_name"),
        })

    attachment = await materialize_message_attachment(
        message,
        chat_id=getattr(entity, "id", 0),
        message_id=int(message_id),
        attachment=media[0],
        max_bytes=int(request.get("max_bytes") or DEFAULT_MAX_BYTES),
        max_text_chars=int(request.get("max_text_chars") or DEFAULT_MAX_TEXT_CHARS),
        progress_callback=on_download_progress,
    )
    audio_path = attachment.get("file_path")
    if not audio_path:
        extraction = attachment.get("extraction") or {}
        return {
            "operation": "transcribe",
            "chat": chat_ref(entity),
            "message": formatted,
            "attachment_found": True,
            "attachment": attachment,
            "file_path": None,
            "transcript_path": None,
            "transcription": {
                "status": "blocked",
                "engine": "soniox",
                "model": "stt-async-v5",
                "text": None,
                "chars": 0,
                "returned_chars": 0,
                "truncated": False,
                "limitation": extraction.get("limitation") or "attachment was not downloaded",
            },
            "media_downloaded": False,
            "limitation": extraction.get("limitation") or "attachment was not downloaded",
            "hits": 1,
            "unique_hits": 1,
            "truncated": False,
        }

    def on_soniox_progress(stage, **extra):
        stage_name = {
            "uploading": "uploading_soniox",
            "processing": "transcribing_soniox",
            "fetching": "fetching_transcript",
        }.get(stage, "transcribing_soniox")
        emit({
            "type": "progress",
            "stage": stage_name,
            "done": 0,
            "total": 1,
            "hits": 1,
            "unique_hits": 1,
            "bytes_done": int(attachment.get("bytes") or 0),
            "bytes_total": int(attachment.get("bytes") or 0),
            "file_name": attachment.get("file_name"),
            "provider": "soniox",
            **extra,
        })

    sender = formatted.get("sender") or {}
    context_general = [
        {"key": "source", "value": "Telegram"},
        {"key": "chat", "value": entity_title(entity)},
    ]
    if sender.get("name"):
        context_general.append({"key": "sender", "value": sender["name"]})
    context_text = str(request.get("context") or formatted.get("text") or "").strip()
    transcript, error, details = transcribe_soniox_file(
        audio_path,
        language_hints=request.get("language_hints") or ["ru", "en"],
        context_text=context_text or None,
        context_general=context_general,
        client_reference_id=f"sc-desktop-telegram-{getattr(entity, 'id', 0)}-{int(message_id)}",
        progress_callback=on_soniox_progress,
    )
    if error or not transcript:
        raise RuntimeError(error or "Soniox returned an empty transcript")

    transcript_path = write_attachment_transcript(
        audio_path,
        transcript,
        engine="soniox",
    )
    returned_text, truncated = _trim_transcript(
        transcript,
        request.get("max_text_chars") or DEFAULT_MAX_TEXT_CHARS,
    )
    emit({
        "type": "progress",
        "stage": "reading_transcript",
        "done": 1,
        "total": 1,
        "hits": 1,
        "unique_hits": 1,
        "bytes_done": int(attachment.get("bytes") or 0),
        "bytes_total": int(attachment.get("bytes") or 0),
        "file_name": attachment.get("file_name"),
        "provider": "soniox",
    })
    return {
        "operation": "transcribe",
        "chat": chat_ref(entity),
        "message": formatted,
        "attachment_found": True,
        "attachment": attachment,
        "file_path": audio_path,
        "transcript_path": transcript_path,
        "transcription": {
            "status": "transcribed",
            "engine": "soniox",
            "model": details.get("model") or "stt-async-v5",
            "text": returned_text,
            "chars": len(transcript),
            "returned_chars": len(returned_text),
            "token_count": int(details.get("token_count") or 0),
            "truncated": truncated,
            "limitation": (
                "full transcript is available at transcript_path"
                if truncated else None
            ),
        },
        "media_downloaded": True,
        "limitation": (
            "full transcript is available at transcript_path"
            if truncated else None
        ),
        "hits": 1,
        "unique_hits": 1,
        "truncated": truncated,
    }


def _peer_key(value):
    if isinstance(value, (types.PeerChannel, types.Channel)):
        return ("channel", int(getattr(value, "channel_id", None) or value.id))
    if isinstance(value, (types.PeerChat, types.Chat)):
        return ("chat", int(getattr(value, "chat_id", None) or value.id))
    return None


async def run_public_search(client, request):
    query = str(request.get("query") or "").strip()
    if not query:
        raise ValueError("public_search requires query")
    limit = max(1, min(50, int(request.get("limit") or 20)))
    emit({
        "type": "progress",
        "stage": "searching_public_chats",
        "done": 0,
        "total": 1,
        "hits": 0,
        "unique_hits": 0,
    })
    response = await client(functions.contacts.SearchRequest(q=query, limit=limit))
    entities = {
        key: entity
        for entity in (getattr(response, "chats", None) or [])
        if (key := _peer_key(entity)) is not None
    }
    my_keys = {
        key for peer in (getattr(response, "my_results", None) or [])
        if (key := _peer_key(peer)) is not None
    }
    ordered_keys = []
    for peer in [
        *(getattr(response, "my_results", None) or []),
        *(getattr(response, "results", None) or []),
    ]:
        key = _peer_key(peer)
        if key is not None and key not in ordered_keys:
            ordered_keys.append(key)
    for key in entities:
        if key not in ordered_keys:
            ordered_keys.append(key)

    found = []
    for key in ordered_keys:
        entity = entities.get(key)
        if not isinstance(entity, types.Channel):
            continue
        if not getattr(entity, "username", None):
            continue
        row = await membership_chat_ref(client, entity, include_full=False)
        row["already_member"] = key in my_keys or not bool(getattr(entity, "left", False))
        row["result_scope"] = "my_chats" if key in my_keys else "global"
        found.append(row)
        if len(found) >= limit:
            break
    emit({
        "type": "progress",
        "stage": "searching_public_chats",
        "done": 1,
        "total": 1,
        "hits": len(found),
        "unique_hits": len(found),
    })
    return {
        "operation": "public_search",
        "query": query,
        "returned": len(found),
        "chats": found,
        "hits": len(found),
        "unique_hits": len(found),
        "truncated": len(found) >= limit,
        "media_downloaded": False,
    }


async def run_join(client, request):
    if request.get("confirm") is not True:
        raise ValueError("join requires confirm=true")
    parsed = parse_membership_target(request.get("target"))
    emit({
        "type": "progress",
        "stage": "resolving_membership",
        "done": 0,
        "total": 1,
        "hits": 0,
        "unique_hits": 0,
    })
    entity = None
    already_member = False
    request_sent = False
    preview = None
    if parsed["kind"] == "invite":
        checked = await client(functions.messages.CheckChatInviteRequest(parsed["invite_hash"]))
        if isinstance(checked, types.ChatInviteAlready):
            entity = checked.chat
            already_member = True
        else:
            preview = invite_preview_ref(checked)
            try:
                emit({
                    "type": "progress",
                    "stage": "updating_membership",
                    "done": 0,
                    "total": 1,
                    "hits": 1,
                    "unique_hits": 1,
                })
                updates = await client(functions.messages.ImportChatInviteRequest(parsed["invite_hash"]))
                entity = chat_from_updates(updates)
                if entity is None:
                    checked = await client(functions.messages.CheckChatInviteRequest(parsed["invite_hash"]))
                    if isinstance(checked, types.ChatInviteAlready):
                        entity = checked.chat
            except errors.UserAlreadyParticipantError:
                checked = await client(functions.messages.CheckChatInviteRequest(parsed["invite_hash"]))
                if isinstance(checked, types.ChatInviteAlready):
                    entity = checked.chat
                    already_member = True
                else:
                    raise
            except errors.InviteRequestSentError:
                request_sent = True
    else:
        entity = await client.get_entity(parsed["username"])
        if not isinstance(entity, types.Channel):
            raise ValueError("target resolves to a user, not a Telegram group or channel")
        already_member = not bool(getattr(entity, "left", False))
        if not already_member:
            try:
                emit({
                    "type": "progress",
                    "stage": "updating_membership",
                    "done": 0,
                    "total": 1,
                    "hits": 1,
                    "unique_hits": 1,
                })
                updates = await client(functions.channels.JoinChannelRequest(entity))
                entity = chat_from_updates(updates) or entity
            except errors.UserAlreadyParticipantError:
                already_member = True
            except errors.InviteRequestSentError:
                request_sent = True

    if request_sent:
        chat = await membership_chat_ref(client, entity, include_full=False) if entity else preview
        return {
            "operation": "join",
            "target": parsed["target"],
            "status": "request_sent",
            "joined": False,
            "already_member": False,
            "request_sent": True,
            "chat": chat,
            "ready_for_fetch": False,
            "hits": 1,
            "unique_hits": 1,
            "truncated": False,
            "media_downloaded": False,
        }
    if entity is None:
        raise RuntimeError("Telegram join returned no chat entity")
    try:
        entity = await client.get_entity(entity)
    except Exception:
        pass
    chat = await membership_chat_ref(client, entity)
    chat["member"] = True
    emit({"type": "entity", "chat": chat})
    emit({
        "type": "progress",
        "stage": "membership_updated",
        "done": 1,
        "total": 1,
        "hits": 1,
        "unique_hits": 1,
    })
    return {
        "operation": "join",
        "target": parsed["target"],
        "status": "already_member" if already_member else "joined",
        "joined": True,
        "already_member": already_member,
        "request_sent": False,
        "chat": chat,
        "ready_for_fetch": True,
        "hits": 1,
        "unique_hits": 1,
        "truncated": False,
        "media_downloaded": False,
    }


async def run_membership_info(client, request):
    from tg_bot_contract import BotContractError, safe_tl
    me = await asyncio.wait_for(client.get_me(), timeout=5)
    if str(me.id) != str(request["expected_account_id"]):
        raise BotContractError("membership_account_mismatch", "Selected membership account changed")
    parsed = parse_membership_target(request["target"])
    if parsed["kind"] == "invite":
        checked = await client(functions.messages.CheckChatInviteRequest(parsed["invite_hash"]))
        member = isinstance(checked, types.ChatInviteAlready)
        chat = await membership_chat_ref(client, checked.chat, include_full=False) if member else invite_preview_ref(checked)
        approval = bool(getattr(checked, "request_needed", False))
        payment = getattr(checked, "subscription_pricing", None) is not None
    else:
        entity = await client.get_entity(parsed["username"])
        if not isinstance(entity, (types.Channel, types.Chat)):
            raise ValueError("Target is not a group/channel; no join performed")
        chat = await membership_chat_ref(client, entity, include_full=False)
        member, approval, payment = chat["member"], bool(getattr(entity, "join_request", False)), False
    return {"operation": "membership_info", "account_id": str(me.id), "chat": safe_tl(chat),
            "status": "already_member" if member else "available_membership_unchecked",
            "member": member, "request_needed": approval, "request_submitted": None,
            "payment_required": payment, "ready_for_fetch": member,
            "membership_mutated": False, "hits": 1, "unique_hits": 1,
            "media_downloaded": False, "truncated": False}


async def run_leave(client, request):
    if request.get("confirm") is not True:
        raise ValueError("leave requires confirm=true")
    parsed = parse_membership_target(request.get("target"))
    emit({
        "type": "progress",
        "stage": "resolving_membership",
        "done": 0,
        "total": 1,
        "hits": 0,
        "unique_hits": 0,
    })
    entity = None
    preview = None
    if parsed["kind"] == "invite":
        checked = await client(functions.messages.CheckChatInviteRequest(parsed["invite_hash"]))
        if isinstance(checked, types.ChatInviteAlready):
            entity = checked.chat
        else:
            preview = invite_preview_ref(checked)
    else:
        entity = await client.get_entity(parsed["username"])
        if not isinstance(entity, (types.Channel, types.Chat)):
            raise ValueError("target resolves to a user, not a Telegram group or channel")

    already_left = entity is None or bool(getattr(entity, "left", False))
    if already_left:
        chat = preview or (await membership_chat_ref(client, entity, include_full=False) if entity else None)
        if chat:
            chat["member"] = False
        return {
            "operation": "leave",
            "target": parsed["target"],
            "status": "already_left",
            "left": True,
            "already_left": True,
            "chat": chat,
            "ready_for_fetch": False,
            "hits": 1,
            "unique_hits": 1,
            "truncated": False,
            "media_downloaded": False,
        }

    chat = await membership_chat_ref(client, entity)
    emit({"type": "entity", "chat": chat})
    emit({
        "type": "progress",
        "stage": "updating_membership",
        "done": 0,
        "total": 1,
        "hits": 1,
        "unique_hits": 1,
    })
    try:
        if isinstance(entity, types.Channel):
            await client(functions.channels.LeaveChannelRequest(entity))
        else:
            await client(functions.messages.DeleteChatUserRequest(
                chat_id=entity.id,
                user_id=types.InputUserSelf(),
                revoke_history=False,
            ))
    except errors.UserNotParticipantError:
        already_left = True
    chat["member"] = False
    emit({
        "type": "progress",
        "stage": "membership_updated",
        "done": 1,
        "total": 1,
        "hits": 1,
        "unique_hits": 1,
    })
    return {
        "operation": "leave",
        "target": parsed["target"],
        "status": "already_left" if already_left else "left",
        "left": True,
        "already_left": already_left,
        "chat": chat,
        "ready_for_fetch": False,
        "hits": 1,
        "unique_hits": 1,
        "truncated": False,
        "media_downloaded": False,
    }


async def run(request, session_name):
    api_id, api_hash = telegram_credentials()
    session_path = resolve_session_path(session_name, HERE)
    if not session_path.exists():
        fail(
            f"Session file '{session_path.name}' not found — open Telegram settings and pick or create a session.",
            "session_missing",
        )
        return 4
    one_shot_mutation = request.get("operation") in ("bot_action", "folder_merge", "bot_join")
    client = TelegramClient(
        telegram_session(str(session_path).replace(".session", "")),
        api_id,
        api_hash,
        receive_updates=False,
        catch_up=False,
        **({"request_retries": 0, "connection_retries": 0, "flood_sleep_threshold": 0,
            "raise_last_call_error": True, "auto_reconnect": False, "timeout": 15} if one_shot_mutation else {}),
    )
    bump_busy_timeout(client)
    ok, message, code = await connect_authorized(client, session_name=session_path.stem)
    if not ok:
        fail(message, code)
        try:
            await client.disconnect()
        except Exception:
            pass
        return 4
    started = time.perf_counter()
    operation = str(request.get("operation") or "")
    total_steps = len(request.get("searches") or []) if operation == "search" else 1
    emit({"type": "started", "operation": operation, "total_steps": total_steps})
    try:
        if operation == "search":
            result = await run_search(client, request)
        elif operation == "public_search":
            result = await run_public_search(client, request)
        elif operation == "context":
            result = await run_context(client, request)
        elif operation == "range":
            result = await run_range(client, request)
        elif operation == "bot_info":
            result = await bot_information(client, request)
        elif operation == "bot_messages":
            result = await bot_messages(client, request)
        elif operation in ("bot_action", "bot_action_status"):
            from tg_bot_actions import run_bot_action
            import os
            root = os.environ.get("SC_DESKTOP_DIR") or os.environ.get("MEDIA_INBOX_DIR") or Path.home() / "Library/Application Support/sc-desktop"
            result = await run_bot_action(client, request, root, emit)
        elif operation == "folder_read":
            from tg_folder_merge import folder_read
            result = await folder_read(client, request)
        elif operation in ("bot_join", "bot_join_status"):
            from tg_bot_join import run_bot_join
            import os
            root = os.environ.get("SC_DESKTOP_DIR") or os.environ.get("MEDIA_INBOX_DIR") or Path.home() / "Library/Application Support/sc-desktop"
            result = await run_bot_join(client, request, root, emit)
        elif operation in ("folder_merge", "folder_merge_status"):
            from tg_folder_merge import run_folder_merge
            import os
            root = os.environ.get("SC_DESKTOP_DIR") or os.environ.get("MEDIA_INBOX_DIR") or Path.home() / "Library/Application Support/sc-desktop"
            result = await run_folder_merge(client, request, root, emit)
        elif operation == "attachment":
            result = await run_attachment(client, request)
        elif operation == "transcribe":
            result = await run_transcribe(client, request)
        elif operation == "join":
            result = await run_join(client, request)
        elif operation == "membership_info":
            result = await run_membership_info(client, request)
        elif operation == "leave":
            result = await run_leave(client, request)
        else:
            raise ValueError(f"unsupported operation: {operation}")
        emit({"type": "result", "result": result})
        emit({
            "type": "done",
            "operation": operation,
            "hits": result.get("hits", 0),
            "unique_hits": result.get("unique_hits", 0),
            "duration_ms": round((time.perf_counter() - started) * 1000),
        })
        return 0
    except asyncio.CancelledError:
        raise
    except Exception as error:
        failure = telegram_error_payload(error)
        if failure:
            message = failure.pop("message")
            code = failure.pop("code")
            fail(message, code, **failure)
            return 3
        if operation.startswith(("bot_", "folder_")) or operation == "membership_info":
            fail(type(error).__name__, getattr(error, "code", "telegram_bot_failed"))
            return 3
        fail(f"{type(error).__name__}: {error}")
        return 2
    finally:
        await client.disconnect()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", default="session2")
    args = parser.parse_args()
    try:
        raw = sys.stdin.read()
        request = json.loads(raw or "{}")
    except Exception as error:
        fail(f"bad request JSON: {error}", "bad_request")
        return 2
    try:
        def handle_term(_signum, _frame):
            cleanup_current_process_parts()
            raise KeyboardInterrupt()

        signal.signal(signal.SIGTERM, handle_term)
        return asyncio.run(run(request, args.session))
    except KeyboardInterrupt:
        cleanup_current_process_parts()
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
