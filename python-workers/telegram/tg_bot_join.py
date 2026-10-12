"""At-most-once join of ONE current ITKras URL button from the exact bot.

Existing generic join/leave flows are unchanged. No callback/menu resend and
no authority to approve requests, join OM, subscribe or pay.
"""
import asyncio
import math
import time
from pathlib import Path

from telethon import errors, functions
from telegram_text_outbox import TextOutbox, SendError, digest
from tg_bot_actions import canonical
from tg_bot_contract import verified_bot, bot_messages, itkras_link_candidates, BotContractError
from tg_folder_merge import itkras_title


class JoinOutbox(TextOutbox):
    def __init__(self, root):
        super().__init__(Path(root) / "telegram-bot-joins")

    def reserve(self, request, target):
        payload = digest(canonical(request))
        # Canonical target, not page number/label/alias, fences unknown re-joins.
        fingerprint = digest(canonical([request["expected_account_id"], target]))
        self.db.execute("BEGIN IMMEDIATE")
        try:
            old = self.get(request["request_id"])
            if old:
                if old["payload_hash"] != payload:
                    raise SendError("join_idempotency_conflict", "Original join intent differs")
                self.db.execute("COMMIT")
                return old
            pending = self.db.execute("SELECT request_id FROM receipts WHERE fingerprint=? AND state IN ('prepared','dispatching','unknown','request_sent') LIMIT 1", (fingerprint,)).fetchone()
            if pending:
                raise SendError("join_previous_outcome_unresolved", "Original join/request must be reconciled without new key", original_request_id=pending[0])
            record = {"request_id": request["request_id"], "payload_hash": payload, "fingerprint": fingerprint,
                      "state": "prepared", "request": request, "target": target, "created_at": time.time()}
            self.db.execute("INSERT INTO receipts VALUES(?,?,?,?,?)", (request["request_id"], payload, fingerprint, "prepared", canonical(record)))
            self.db.execute("COMMIT")
            return record
        except BaseException:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise


async def preview(client, request, target):
    from tg_live_ndjson import parse_membership_target, run_membership_info
    result = await asyncio.wait_for(run_membership_info(client, {"target": target,
        "expected_account_id": request["expected_account_id"]}), 20)
    chat = result["chat"]
    if (chat.get("title") != request["expected_chat_title"] or not itkras_title(chat.get("title") or "")
            or chat.get("type") not in ("group", "supergroup") or result["payment_required"]):
        raise BotContractError("join_not_confirmed_itkras_group", "Fresh invite/public identity is outside the exact authorized ITKras group; payment/OM/channel blocked")
    return result, parse_membership_target(target)


async def selected_target(client, request):
    result = await bot_messages(client, {**request, "message_ids": [request["message_id"]],
        "expected_binding_hashes": {str(request["message_id"]): request["expected_binding_hash"]}})
    candidates = itkras_link_candidates(result)
    for candidate in candidates["links"]:
        if any(origin["row"] == request["row"] and origin["column"] == request["column"]
               and origin["label"] == request["expected_action_label"] for origin in candidate["provenance"]):
            return candidate["target"]
    raise BotContractError("join_button_not_authorized_url", "Selected exact button is not a positive ITKras URL; no callback decoding/navigation")


def receipt(record, busy=False):
    state = record["state"]
    joined = state in ("joined", "already_member") and not busy
    return {"operation": "join", "request_id": record["request_id"],
            "account_id": record["request"]["expected_account_id"], "session": record["request"]["session"],
            "bot_peer_id": record["request"]["expected_peer_id"], "status": "in_progress" if busy else state,
            "state": "in_progress" if busy else state, "ok": joined or state == "request_sent",
            "joined": joined, "already_member": state == "already_member", "request_sent": state == "request_sent",
            "outcome_unknown": state in ("dispatching", "unknown"), "ready_for_fetch": joined,
            "admin_approval_claimed": False, "media_downloaded": False,
            "chat": record.get("chat"), "verified_at": record.get("verified_at"),
            "target_sha256": digest(record["target"]), "hits": int(joined or state == "request_sent"), "unique_hits": int(joined),
            "retry_after_seconds": max(0, math.ceil(record.get("retry_not_before", 0) - time.time())),
            "retry_not_before": record.get("retry_not_before"),
            **{key: record[key] for key in ("code", "error") if key in record},
            "next": "Unknown/pending: read ORIGINAL request only. No repeat ImportChatInvite/JoinChannel or admin approval. Fetch/folder only after fresh member proof."}


def rate_limited(box, record, error):
    # An authoritative 420 rejects this RPC; it is not a lost mutation ACK.
    seconds = max(1, int(error.seconds))
    return receipt(box.update(record["request_id"], state="prepared", code="telegram_flood_wait",
        error="Telegram rate limit", retry_not_before=time.time() + seconds,
        previous_rpc_rejected_without_membership_change=True))


async def reconcile(client, box, record):
    try:
        result, _parsed = await preview(client, record["request"], record["target"])
        if result["member"]:
            return box.update(record["request_id"], state="already_member" if record.get("member_before") else "joined",
                              chat=result["chat"], verified_at=time.time(), code=None, error=None)
        # request_needed is NOT evidence that a request was submitted.
        if record["state"] == "request_sent":
            return box.update(record["request_id"], chat=result["chat"], checked_at=time.time())
        return box.update(record["request_id"], state="unknown", code="join_membership_unconfirmed", error="No current membership and no proven request ACK; never resend")
    except Exception as error:
        return box.update(record["request_id"], state="request_sent" if record["state"] == "request_sent" else "unknown",
                          code="join_readback_unavailable", error=type(error).__name__)


async def run_bot_join(client, request, root, emit_progress=lambda event: None):
    box = JoinOutbox(root)
    try:
        status = request["operation"] == "bot_join_status"
        record = box.get(request["request_id"])
        if status and not record:
            raise BotContractError("join_request_not_found", "Original join receipt missing")
        if record:
            if any(request[key] != record["request"][key] for key in ("session", "expected_account_id", "expected_peer_id", "bot")):
                raise BotContractError("join_receipt_identity_mismatch", "Exact original account/bot/session differs")
            if not status and digest(canonical(request)) != record["payload_hash"]:
                raise BotContractError("join_idempotency_conflict", "Original join intent differs")
        if not record:
            if request.get("confirm") is not True or request.get("purpose") != "join_itkras":
                raise BotContractError("join_confirmation_required", "Explicit confirmed ITKras group join only")
            target = await selected_target(client, request)
            result, _parsed = await preview(client, request, target)
            record = box.reserve(request, target)
        with box.lock(record["fingerprint"]) as acquired:
            record = box.get(record["request_id"])
            if not acquired:
                return receipt(record, busy=True)
            if record["state"] in ("dispatching", "unknown", "request_sent"):
                return receipt(await reconcile(client, box, record))
            if status or record["state"] != "prepared":
                return receipt(record)
            if record.get("retry_not_before", 0) > time.time():
                return receipt(record)
            try:
                # Recheck exact current bot button and account/group before dispatch.
                await verified_bot(client, request)
                if await selected_target(client, request) != record["target"]:
                    raise BotContractError("join_target_changed", "Current button target differs from saved intent")
                before, parsed = await preview(client, request, record["target"])
                if before["member"]:
                    return receipt(box.update(record["request_id"], state="already_member", member_before=True, chat=before["chat"], verified_at=time.time()))
            except errors.FloodWaitError as error:
                return rate_limited(box, record, error)
            except Exception as error:
                return receipt(box.update(record["request_id"], state="rejected", code=getattr(error, "code", "join_preflight_failed"), error=type(error).__name__))
            record = box.update(record["request_id"], state="dispatching", member_before=False, dispatched_at=time.time())
            emit_progress({"type": "progress", "stage": "updating_membership", "done": 0, "total": 1})
            try:
                if parsed["kind"] == "invite":
                    await asyncio.wait_for(client(functions.messages.ImportChatInviteRequest(parsed["invite_hash"])), 20)
                else:
                    entity = await asyncio.wait_for(client.get_input_entity(parsed["username"]), 10)
                    await asyncio.wait_for(client(functions.channels.JoinChannelRequest(entity)), 20)
            except errors.InviteRequestSentError:
                record = box.update(record["request_id"], state="request_sent", chat=before["chat"], request_ack_at=time.time())
            except errors.UserAlreadyParticipantError:
                pass  # Still require current membership read-back.
            except errors.FloodWaitError as error:
                return rate_limited(box, record, error)
            except Exception as error:
                record = box.update(record["request_id"], state="unknown", code="join_outcome_unknown", error=type(error).__name__)
            return receipt(await reconcile(client, box, record))
    finally:
        box.close()
