"""Scoped read-groups bot actions. Durable at-most-once callback dispatch.

Telegram callback RPC has no random_id. Unknown dispatch is NEVER resent.
Text commands/reply buttons reuse the existing stable-random-id text sender.
"""
import asyncio
import json
import re
import time
import unicodedata
from pathlib import Path

from telethon import functions, utils
from telegram_text_outbox import TextOutbox, SendError, digest
from tg_bot_contract import verified_bot, bot_information, keyboard_original, incoming_bot_message, BotContractError


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


class BotOutbox(TextOutbox):
    def __init__(self, root):
        # Separate namespace: do not reinterpret old plain-send receipts/hashes.
        super().__init__(Path(root) / "telegram-bot-actions")

    def reserve(self, request):
        key = request["request_id"]
        payload_hash = digest(canonical(request))
        identity = [request["expected_account_id"], request["expected_peer_id"], request["action"],
                    request.get("command"), request.get("expected_action_label")]
        fingerprint = digest(canonical(identity))
        self.db.execute("BEGIN IMMEDIATE")
        try:
            old = self.get(key)
            if old:
                if old["payload_hash"] != payload_hash:
                    raise SendError("bot_idempotency_conflict", "Original bot intent differs; nothing resent")
                self.db.execute("COMMIT")
                return old
            unresolved = self.db.execute("SELECT request_id FROM receipts WHERE fingerprint=? AND state IN ('prepared','routing_text','dispatching','unknown') LIMIT 1", (fingerprint,)).fetchone()
            if unresolved:
                raise SendError("bot_previous_outcome_unknown", "Read the original bot request; do not create another key", original_request_id=unresolved[0])
            record = {"request_id": key, "payload_hash": payload_hash, "fingerprint": fingerprint,
                      "state": "prepared", "request": request, "created_at": time.time(),
                      "account_id": request["expected_account_id"], "peer_id": request["expected_peer_id"],
                      "text_request_id": "bottext-" + digest(key)}
            self.db.execute("INSERT INTO receipts VALUES(?,?,?,?,?)", (key, payload_hash, fingerprint, "prepared", canonical(record)))
            self.db.execute("COMMIT")
            return record
        except BaseException:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise


def receipt(record, *, busy=False):
    state = record["state"]
    return {"operation": "bot_action_status", "request_id": record["request_id"],
            "state": "in_progress" if busy else state, "account_id": record["account_id"],
            "peer_id": record["peer_id"], "session": record["request"]["session"],
            "ok": state in ("text_delivered", "callback_acknowledged", "url_returned"),
            "outcome_unknown": state in ("dispatching", "routing_text", "unknown"),
            "effect_verified": False, "bot_reply_or_membership_not_proven": True,
            **{key: record[key] for key in ("message_id", "callback_answer", "url", "code", "error", "verified_at") if key in record},
            "retry_instruction": "Read this original request_id. An unknown callback is never sent again; callback ACK is not membership proof."}


def read_groups_label(label):
    value = unicodedata.normalize("NFKC", label).casefold()
    if re.search(r"подпис|оплат|платеж|платёж|купить|payment|subscribe|subscription|logout|log out|notification|настро|уведом|settings", value):
        raise BotContractError("bot_action_outside_scope", "Payment/subscription/settings/notification/logout actions are not allowed")
    if re.search(r"(?:^|\W)(?:ом|om)(?:\W|$)", value):
        raise BotContractError("bot_action_outside_scope", "OM community actions are not authorized")
    if not re.search(r"доступн.*групп|available.*group|красавчик|инсайдер|insider", value):
        raise BotContractError("bot_action_not_group_discovery", "Only a positively identified group-discovery button is supported")


async def action_preflight(client, request):
    _me, entity = await verified_bot(client, request)
    if request["action"] == "command":
        command = request["command"]
        if not re.fullmatch(r"/[a-z][a-z0-9_]{0,31}", command):
            raise BotContractError("bot_command_invalid", "One exact slash command is required")
        if re.search(r"buy|pay|subscrib|subscription|logout|setting|notification", command):
            raise BotContractError("bot_action_outside_scope", "Advertised does not authorize payment/settings/logout/notification commands")
        if command not in ("/start", "/unban", "/help") and "group" not in command:
            raise BotContractError("bot_action_outside_scope", "This command is outside group discovery")
        info = await bot_information(client, request)
        advertised = command[1:] in {entry["command"] for entry in info["commands"]}
        proof_id = request.get("command_source_message_id")
        if not advertised and proof_id is not None:
            original = await client.get_messages(entity, ids=proof_id)
            if (not incoming_bot_message(original, entity)
                    or digest(original.message or "") != request.get("expected_command_source_sha256")):
                raise BotContractError("bot_command_source_changed", "Bot command source no longer matches its observed original")
            advertised = bool(re.search(r"(?<!\w)" + re.escape(command) + r"(?![a-z0-9_])", original.message or ""))
        if not advertised:
            raise BotContractError("bot_command_not_advertised", "The exact bot did not advertise this command; nothing sent")
        return {"kind": "text", "text": command, "entity": entity}
    message = await client.get_messages(entity, ids=request["message_id"])
    if not incoming_bot_message(message, entity):
        raise BotContractError("bot_message_mismatch", "Selected button is not an incoming message from the exact bot")
    keyboard = keyboard_original(message)
    if keyboard["binding_hash"] != request["expected_binding_hash"]:
        raise BotContractError("bot_markup_changed", "Keyboard/message changed; reread before choosing an action")
    rows = list(getattr(message.reply_markup, "rows", None) or [])
    try:
        button = rows[request["row"]].buttons[request["column"]]
    except (IndexError, TypeError):
        raise BotContractError("bot_button_missing", "Selected row/column does not exist")
    label = getattr(button, "text", None) or ""
    if label != request["expected_action_label"]:
        raise BotContractError("bot_button_label_changed", "Exact button label no longer matches")
    kind = type(button).__name__
    if kind == "KeyboardButtonUrl":
        # Reading a URL is NOT browser navigation, joining or an activation.
        return {"kind": "url", "url": button.url, "entity": entity}
    read_groups_label(label)
    if kind == "KeyboardButton":
        return {"kind": "text", "text": label, "entity": entity}
    if kind != "KeyboardButtonCallback" or getattr(button, "requires_password", False):
        raise BotContractError("bot_button_unsupported", "No Buy/WebView/Auth/contact/location/game/2FA button execution")
    return {"kind": "callback", "data": button.data, "entity": entity, "message_id": message.id}


async def run_bot_action(client, request, root, emit_progress=lambda event: None):
    from tg_send_text_ndjson import run_request as send_text
    box = BotOutbox(root)
    try:
        if request["operation"] == "bot_action_status":
            record = box.get(request["request_id"])
            if record is None:
                raise BotContractError("bot_request_not_found", "No bot action receipt with this request_id")
            if (str(request["expected_account_id"]) != record["account_id"]
                    or str(request["expected_peer_id"]) != record["peer_id"]
                    or request["session"] != record["request"]["session"]
                    or request["bot"] != record["request"]["bot"]):
                raise BotContractError("bot_receipt_identity_mismatch", "Bot receipt identity does not match")
        else:
            if request.get("confirm") is not True or request.get("purpose") != "read_groups":
                raise BotContractError("bot_confirmation_required", "Only explicitly confirmed group discovery is supported")
            record = box.reserve(request)
        with box.lock(record["request_id"]) as acquired:
            record = box.get(record["request_id"])
            if not acquired:
                return receipt(record, busy=True)
            if record["state"] in ("routing_text", "unknown") and record.get("text_dispatch"):
                async def current(_session):
                    return client
                text_result = await send_text({"operation": "status", "request_id": record["text_request_id"]}, root=root, client_factory=current)
                if text_result.get("delivered"):
                    record = box.update(record["request_id"], state="text_delivered", message_id=text_result["message_id"], verified_at=text_result["verified_at"])
                return receipt(record)
            if record["state"] != "prepared" or request["operation"] == "bot_action_status":
                # No callback retry/reconciliation by guessing a subsequent edit.
                return receipt(record)
            try:
                chosen = await asyncio.wait_for(action_preflight(client, request), timeout=20)
            except Exception as error:
                record = box.update(record["request_id"], state="rejected", code=getattr(error, "code", "bot_preflight_failed"), error=type(error).__name__)
                return receipt(record)
            if chosen["kind"] == "url":
                return receipt(box.update(record["request_id"], state="url_returned", url=chosen["url"]))
            if chosen["kind"] == "text":
                record = box.update(record["request_id"], state="routing_text", text_dispatch=True)
                emit_progress({"type": "progress", "stage": "dispatching_bot_action", "done": 0, "total": 1})
                async def current(_session):
                    return client
                try:
                    result = await asyncio.wait_for(send_text({
                        "operation": "send", "request_id": record["text_request_id"],
                        "session": request["session"], "target": request["expected_peer_id"],
                        "expected_account_id": request["expected_account_id"], "expected_peer_id": request["expected_peer_id"],
                        "text": chosen["text"], "confirm": True,
                    }, root=root, client_factory=current), timeout=30)
                    record = box.update(record["request_id"], state="text_delivered" if result.get("delivered") else "unknown",
                                        **{key: result[key] for key in ("message_id", "verified_at", "code", "error") if result.get(key) is not None})
                except Exception as error:
                    record = box.update(record["request_id"], state="unknown", code="bot_text_outcome_unknown", error=type(error).__name__)
                return receipt(record)
            # Callback answer has NO random_id/idempotency key in Telegram.
            record = box.update(record["request_id"], state="dispatching", dispatched_at=time.time())
            emit_progress({"type": "progress", "stage": "dispatching_bot_action", "done": 0, "total": 1})
            try:
                result = await asyncio.wait_for(client(functions.messages.GetBotCallbackAnswerRequest(
                    peer=chosen["entity"], msg_id=chosen["message_id"], data=chosen["data"],
                )), timeout=20)
                answer = {"message": getattr(result, "message", None), "url": getattr(result, "url", None),
                          "alert": bool(getattr(result, "alert", False)), "cache_time": getattr(result, "cache_time", None)}
                record = box.update(record["request_id"], state="callback_acknowledged", callback_answer=answer, verified_at=time.time())
            except Exception as error:
                # Even BOT_RESPONSE_TIMEOUT/4xx may be after bot-side execution.
                record = box.update(record["request_id"], state="unknown", code="bot_callback_outcome_unknown", error=type(error).__name__)
            return receipt(record)
    finally:
        box.close()
