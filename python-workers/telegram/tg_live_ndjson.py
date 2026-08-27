#!/usr/bin/env python3
"""Read-only live Telegram search/context/range worker for SC Desktop.

The request is one JSON object on stdin. Results are NDJSON on stdout so the
Electron job-runner can expose progress, cancellation and a bounded in-memory
result without materialising the chat in library.db. Media bytes are never
downloaded by this worker.
"""

import argparse
import asyncio
import json
import platform
import re
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
from telethon import TelegramClient, functions, types
from telethon.tl.types import PeerChannel, PeerChat, PeerUser


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def fail(message, code="telegram_live_failed"):
    emit({"type": "error", "message": str(message), "code": code})


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
    return (
        getattr(reply, "reply_to_msg_id", None),
        getattr(reply, "reply_to_top_id", None),
        bool(getattr(reply, "forum_topic", False)),
    )


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
        reply_id, top_id, forum_topic = reply_fields(message)
        topic_id = top_id if forum_topic and top_id else None
        if forum_topic and topic_id is None and reply_id:
            topic_id = reply_id
        replies = getattr(message, "replies", None)
        action = getattr(message, "action", None)
        return {
            "chat_id": getattr(self.entity, "id", None),
            "chat_title": entity_title(self.entity),
            "chat_username": getattr(self.entity, "username", None),
            "message_id": getattr(message, "id", None),
            "url": message_link(self.entity, message.id, topic_id),
            "date": message.date.isoformat() if getattr(message, "date", None) else None,
            "text": (getattr(message, "message", None) or "")[: self.caption_chars],
            "sender": await self.sender(message),
            "type": message_type(message),
            "has_media": bool(getattr(message, "media", None)),
            "reply_to_message_id": reply_id,
            "reply_to_top_id": top_id,
            "forum_topic": forum_topic,
            "topic_id": topic_id,
            "replies_count": getattr(replies, "replies", None) if replies else None,
            "reactions": reaction_summary(message),
            "views": getattr(message, "views", None),
            "forwards": getattr(message, "forwards", None),
            "service_action": type(action).__name__ if action is not None else None,
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
    for _ in range(max_depth):
        reply_id, _, _ = reply_fields(current)
        if not reply_id or reply_id in seen:
            break
        parent = await client.get_messages(entity, ids=reply_id)
        if parent is None:
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


async def run(request, session_name):
    api_id, api_hash = telegram_credentials()
    session_path = resolve_session_path(session_name, HERE)
    if not session_path.exists():
        fail(
            f"Session file '{session_path.name}' not found — open Telegram settings and pick or create a session.",
            "session_missing",
        )
        return 4
    client = TelegramClient(
        str(session_path).replace(".session", ""),
        api_id,
        api_hash,
        receive_updates=False,
        catch_up=False,
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
        elif operation == "context":
            result = await run_context(client, request)
        elif operation == "range":
            result = await run_range(client, request)
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
        return asyncio.run(run(request, args.session))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
