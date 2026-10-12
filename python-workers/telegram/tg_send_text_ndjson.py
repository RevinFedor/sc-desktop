#!/usr/bin/env python3
"""Resolve a peer, send ONE plain message, or reconcile a durable receipt."""
import asyncio
import json
import logging
import os
import re
import sys
import time
import hashlib
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "shared"))

# Reuse the existing worker's macOS-spawn workaround and session lock setup.
from tg_send_saved_ndjson import _bump_session_busy_timeout
from credentials import telegram_credentials
from tg_session_path import resolve_session_path, connect_authorized
from telegram_text_outbox import TextOutbox, SendError, digest, public_receipt
from telethon import TelegramClient, errors, functions, types, utils
from tg_concurrent_session import telegram_session


def normalize_target(value):
    if not isinstance(value, str) or not value.strip():
        raise SendError("invalid_recipient", "Use one @username, t.me/username, or marked numeric peer ID")
    target = value.strip()
    if re.fullmatch(r"-?[1-9][0-9]*", target):
        return str(int(target))
    if target.startswith(("https://", "http://", "t.me/")):
        parsed = urlparse(target if "://" in target else "https://" + target)
        if parsed.netloc.lower() != "t.me" or parsed.query or parsed.fragment:
            raise SendError("invalid_recipient", "Use a chat username link without a message, query or invite")
        target = "@" + parsed.path.strip("/")
    if re.fullmatch(r"@[A-Za-z][A-Za-z0-9_]{3,31}", target):
        return target.lower()
    raise SendError("ambiguous_recipient", "Display names, lists and invite links are not recipient identities. Use @username or marked peer ID; no auto-join.")


def normalize_request(raw):
    if not isinstance(raw, dict):
        raise SendError("invalid_request", "Expected one object")
    operation = raw.get("operation")
    common = {"operation", "session", "target"}
    allowed = common if operation == "resolve" else {"operation", "request_id"} if operation == "status" else common | {
        "request_id", "expected_account_id", "expected_peer_id", "text", "confirm", "reply_to_message_id", "topic_id",
    }
    if operation not in ("resolve", "send", "status") or set(raw) - allowed:
        raise SendError("invalid_request", "Unknown operation or parameter; only one-shot plain text is supported")
    out = dict(raw)
    if operation != "status":
        if not isinstance(raw.get("session"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", raw["session"]):
            raise SendError("session_required", "Pass an exact Telegram session name; no active-session or fuzzy account fallback")
        out["target"] = normalize_target(raw.get("target"))
    if operation != "resolve":
        if not isinstance(raw.get("request_id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", raw["request_id"]):
            raise SendError("request_id_required", "request_id must be a stable 1–128 character key")
    if operation == "send":
        if raw.get("confirm") is not True:
            raise SendError("confirmation_required", "confirm:true is required for a user-authorized message")
        for key in ("expected_account_id", "expected_peer_id"):
            value = raw.get(key)
            if isinstance(value, bool) or not re.fullmatch(r"-?[1-9][0-9]*", str(value)):
                raise SendError("identity_required", key + " must be the ID returned by telegram_resolve_recipient")
            out[key] = str(int(value))
        text = raw.get("text")
        if not isinstance(text, str) or not text.strip():
            raise SendError("text_required", "One nonempty plain-text message is required")
        if len(text) > 4096:
            raise SendError("text_too_long", "Maximum 4096 Unicode characters; nothing sent. No splitting.")
        try:
            text.encode("utf-8")
        except UnicodeEncodeError:
            raise SendError("invalid_text", "Text must contain valid Unicode")
        for key in ("reply_to_message_id", "topic_id"):
            if key in raw and (isinstance(raw[key], bool) or not isinstance(raw[key], int)
                               or not 1 <= raw[key] <= 2147483647):
                raise SendError("invalid_reply", key + " must be a positive Telegram message ID")
        if "topic_id" in raw and "reply_to_message_id" not in raw:
            raise SendError("invalid_reply", "topic_id requires reply_to_message_id")
    return out


async def strict_entity(client, target):
    try:
        if target.startswith("@"):
            # get_entity(username) performs a fresh ResolveUsernameRequest.
            return await client.get_entity(target)
        marked_id = int(target)
        raw_id, peer_type = utils.resolve_id(marked_id)
        try:
            entity = await client.get_entity(peer_type(raw_id))
        except ValueError:
            entity = None
            async for dialog in client.iter_dialogs():
                if utils.get_peer_id(dialog.entity) == marked_id:
                    entity = await client.get_entity(dialog.entity)
                    break
        if entity is None or utils.get_peer_id(entity) != marked_id:
            raise ValueError("peer not found")
        return entity
    except ValueError:
        raise SendError("recipient_not_found", "The exact peer cannot be resolved in this session; nothing sent")


def peer_summary(entity):
    if not isinstance(entity, (types.User, types.Chat, types.Channel)) or getattr(entity, "deleted", False):
        raise SendError("invalid_recipient", "Peer is unavailable or unsupported")
    kind = "user" if isinstance(entity, types.User) else "group" if isinstance(entity, types.Chat) else "supergroup" if entity.megagroup else "channel"
    return {
        "peer_id": str(utils.get_peer_id(entity)), "type": kind,
        "title": getattr(entity, "title", None) or " ".join(p for p in [getattr(entity, "first_name", None), getattr(entity, "last_name", None)] if p),
        "username": getattr(entity, "username", None),
    }


async def connect_client(session):
    session_path = resolve_session_path(session, HERE)
    if not session_path.is_file():
        raise SendError("session_missing", "Exact session file was not found")
    api_id, api_hash = telegram_credentials()
    client = TelegramClient(telegram_session(str(session_path.with_suffix(""))), api_id, api_hash,
                            request_retries=0, connection_retries=0,
                            flood_sleep_threshold=0, raise_last_call_error=True,
                            auto_reconnect=False, timeout=15)
    _bump_session_busy_timeout(client)
    ok, _message, code = await connect_authorized(client, session_name=session)
    if not ok:
        await client.disconnect()
        raise SendError(code, "Could not authorize the selected Telegram session; nothing sent")
    return client


async def identities(client, request, *, recovery=False):
    me = await client.get_me()
    account_id = str(me.id)
    expected = request.get("expected_account_id", request.get("account_id"))
    if expected and account_id != expected:
        raise SendError("account_mismatch", "Session is authorized as a different account; nothing sent", actual_account_id=account_id)
    # Recovery is pinned to the stored numeric peer, never a reassigned username.
    entity = await strict_entity(client, request["peer_id"] if recovery else request["target"])
    summary = peer_summary(entity)
    expected_peer = request.get("expected_peer_id", request.get("peer_id"))
    if expected_peer and summary["peer_id"] != expected_peer:
        raise SendError("recipient_mismatch", "Resolved peer differs from the confirmed recipient; nothing sent", actual_peer=summary)
    return me, entity, summary


def mapped_message_id(result, random_id):
    if isinstance(result, types.UpdateShortSentMessage):
        return result.id
    updates = getattr(result, "updates", [])
    for update in updates:
        if isinstance(update, types.UpdateMessageID) and update.random_id == random_id:
            return update.id
    return None


def message_topic(message):
    header = getattr(message, "reply_to", None)
    if header and getattr(header, "reply_to_top_id", None):
        return header.reply_to_top_id
    if header and getattr(header, "forum_topic", False):
        return getattr(header, "reply_to_msg_id", None)
    if isinstance(getattr(message, "action", None), types.MessageActionTopicCreate):
        return message.id
    return None


async def verified_reply(client, entity, request):
    parent_id = request.get("reply_to_message_id")
    if parent_id is None:
        return None
    parent = await client.get_messages(entity, ids=parent_id)
    if (not parent or parent.id != parent_id or not getattr(parent, "peer_id", None)
            or str(utils.get_peer_id(parent.peer_id)) != request["expected_peer_id"]):
        raise SendError("reply_target_unavailable", "Reply parent is missing from the confirmed peer; nothing sent")
    topic_id = request.get("topic_id")
    if getattr(entity, "forum", False):
        if topic_id is None or message_topic(parent) != topic_id:
            raise SendError("reply_topic_mismatch", "Reply parent does not prove the requested forum topic; nothing sent")
    elif topic_id is not None:
        raise SendError("reply_topic_mismatch", "The confirmed peer is not a forum; nothing sent")
    return types.InputReplyToMessage(reply_to_msg_id=parent_id, top_msg_id=topic_id)


def is_our_message(message, record):
    header = getattr(message, "reply_to", None)
    if record.get("reply_to_message_id") is not None:
        if not header or getattr(header, "reply_to_msg_id", None) != record["reply_to_message_id"]:
            return False
        other_peer = getattr(header, "reply_to_peer_id", None)
        if other_peer and str(utils.get_peer_id(other_peer)) != record["peer_id"]:
            return False
        if record.get("topic_id") is not None and message_topic(message) != record["topic_id"]:
            return False
    return bool(message and getattr(message, "out", False)
                and getattr(message, "peer_id", None)
                and str(utils.get_peer_id(message.peer_id)) == record["peer_id"]
                and digest(getattr(message, "message", "") or "") == record["text_sha256"])


async def reconcile(client, entity, box, record):
    rid = record["request_id"]
    if record.get("message_id"):
        message = await client.get_messages(entity, ids=record["message_id"])
        if is_our_message(message, record) and message.id == record["message_id"]:
            return box.update(rid, state="delivered", code=None, error=None,
                              verified_at=time.time(), candidate_message_ids=[])
        return box.update(rid, state="unknown", code="readback_mismatch",
                          error="Recorded message ID did not pass peer/text/reply/topic read-back. No resend.")
    # Matching text alone cannot prove random_id ownership. Return candidate IDs
    # for investigation, but never claim delivery or permission to resend.
    messages = await client.get_messages(entity, min_id=record.get("baseline_id", 0), limit=100)
    candidates = [m.id for m in messages if is_our_message(m, record)]
    return box.update(rid, state="unknown", code="delivery_unknown",
                      error="Telegram ACK/message ID unavailable. History candidates are not delivery proof; no resend.",
                      candidate_message_ids=candidates)


def error_info(error):
    if isinstance(error, SendError):
        return {"code": error.code, "error": str(error), **error.details}
    if isinstance(error, (errors.FloodWaitError, errors.SlowModeWaitError)):
        return {"code": "telegram_flood_wait", "error": "Telegram requires waiting; no automatic retry.", "retry_after_seconds": error.seconds}
    name = type(error).__name__
    code = {
        "ChatWriteForbiddenError": "write_forbidden", "ChatSendPlainForbiddenError": "write_forbidden",
        "UserBannedInChannelError": "write_forbidden", "UserIsBlockedError": "write_forbidden",
        "ChatAdminRequiredError": "write_forbidden", "ChannelPrivateError": "write_forbidden",
        "PeerFloodError": "telegram_send_limit", "MessageTooLongError": "text_too_long",
        "UsernameInvalidError": "invalid_recipient", "UsernameNotOccupiedError": "recipient_not_found",
        "UserPrivacyRestrictedError": "write_forbidden", "StarsPaymentRequiredError": "payment_required",
    }.get(name, "telegram_rpc_error" if isinstance(error, errors.RPCError) else "telegram_unavailable")
    # Exception strings can embed requests/text. Only expose class and our code.
    return {"code": code, "error": name + "; no automatic retry"}


async def run_request(raw, *, root=None, client_factory=connect_client):
    request = normalize_request(raw)
    if request["operation"] == "resolve":
        client = await client_factory(request["session"])
        try:
            me, _entity, recipient = await identities(client, request)
            result = {"ok": True, "delivered": False, "state": "resolved", "session": request["session"],
                      "account": {"id": str(me.id), "username": me.username}, "recipient": recipient}
            if isinstance(_entity, types.User) and getattr(_entity, "bot", False):
                # Additive BOT metadata only. Resolve never implicitly reads DM
                # history, presses a button or navigates any advertised URL.
                try:
                    from tg_bot_contract import bot_information
                    result["bot_info"] = await bot_information(client, {
                        "bot": request["target"], "expected_account_id": str(me.id),
                        "expected_peer_id": recipient["peer_id"],
                    })
                    result["bot_info"]["reader"] = {"version": "bot-info-v1",
                        "worker_path": str(Path(__file__).resolve()),
                        "worker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
                except Exception as error:
                    result["bot_info_error"] = {"code": getattr(error, "code", "bot_info_unavailable"), "error": type(error).__name__}
            return result
        finally:
            await client.disconnect()

    root = root or os.environ.get("SC_DESKTOP_DIR") or os.environ.get("MEDIA_INBOX_DIR") or Path.home() / "Library/Application Support/sc-desktop"
    box = TextOutbox(root)
    try:
        record = box.reserve(request) if request["operation"] == "send" else box.get(request["request_id"])
        if record is None:
            raise SendError("request_not_found", "No receipt exists for this request_id")
        if record["state"] in ("delivered", "rejected"):
            return public_receipt(record)
        with box.lock(record["request_id"]) as acquired:
            record = box.get(record["request_id"])
            if not acquired:
                return public_receipt(record, busy=record["state"] not in ("delivered", "rejected"))
            if record["state"] in ("delivered", "rejected"):
                return public_receipt(record)
            if request["operation"] == "status" and record["state"] == "prepared":
                return public_receipt(record)  # read-only status never starts a send
            client = None
            try:
                client = await client_factory(record["session"])
                if record["state"] != "prepared":
                    _me, entity, _recipient = await identities(client, record, recovery=True)
                    return public_receipt(await reconcile(client, entity, box, record))
                _me, entity, recipient = await identities(client, request)
                config = await client(functions.help.GetConfigRequest())
                if len(request["text"]) > min(4096, int(config.message_length_max)):
                    raise SendError("text_too_long", "Text exceeds the live Telegram message limit; no splitting, nothing sent")
                if getattr(entity, "left", False) or getattr(entity, "deactivated", False):
                    raise SendError("not_a_member", "Not a member of this chat; no automatic join")
                reply = await verified_reply(client, entity, request)
                baseline = await client.get_messages(entity, limit=1)
                record = box.update(record["request_id"], state="dispatching", recipient=recipient,
                                    baseline_id=baseline[0].id if baseline else 0, dispatched_at=time.time())
                # This is the ONLY send call. No send_message helper (which can
                # split), no retry loop, no paid-floodskip or paid Stars allowance.
                result = await client(functions.messages.SendMessageRequest(
                    peer=entity, message=request["text"], random_id=int(record["random_id"]),
                    no_webpage=True, entities=[], clear_draft=False,
                    reply_to=reply,
                ))
                mid = mapped_message_id(result, int(record["random_id"]))
                if mid:
                    record = box.update(record["request_id"], state="acknowledged", message_id=mid)
                return public_receipt(await reconcile(client, entity, box, record))
            except Exception as error:
                record = box.get(record["request_id"])
                before_send = record["state"] == "prepared"
                definite_rejection = (record["state"] == "dispatching" and isinstance(error, errors.RPCError)
                                      and getattr(error, "code", 500) < 500
                                      and not isinstance(error, errors.RandomIdDuplicateError))
                record = box.update(record["request_id"], state="rejected" if before_send or definite_rejection else "unknown",
                                    **error_info(error))
                return public_receipt(record)
            finally:
                if client:
                    await client.disconnect()
    finally:
        box.close()


async def main():
    # No message text on argv or logs, including third-party debug logging.
    logging.getLogger("telethon").setLevel(logging.CRITICAL)
    try:
        raw = json.loads(sys.stdin.read())
        result = await asyncio.wait_for(run_request(raw), timeout=45)
    except asyncio.TimeoutError:
        result = {"ok": False, "delivered": False, "state": "unknown", "code": "operation_timeout",
                  "error": "Read the original request_id with telegram_send_text_status. Do not resend under a new key."}
    except Exception as error:
        result = {"ok": False, "delivered": False, **error_info(error)}
    print(json.dumps({"type": "result", "result": result}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
