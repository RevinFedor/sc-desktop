"""Exact-account ITKras -> ВУ union, through the Desktop live job worker.

No removal, login, join, payment, media or folder-order RPC. A durable
dispatching intent precedes UpdateDialogFilter; unknown is read-back only.
"""
import asyncio
import copy
import json
import re
import time
import unicodedata
import itertools
from pathlib import Path

from telethon import functions, types, utils
from telegram_text_outbox import TextOutbox, SendError, digest
from tg_bot_contract import safe_tl, BotContractError

TITLE = "ВУ"


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def filter_hash(folder):
    # Serialized TL normalizes absent/false flags without dropping fields.
    return digest(bytes(folder).hex())


def filters_hash(folders):
    return digest(canonical([filter_hash(folder) for folder in folders]))


def title(folder):
    value = getattr(folder, "title", "")
    return value if isinstance(value, str) else getattr(value, "text", "")


def peer_id(peer):
    return str(utils.get_peer_id(peer))


async def current_account(client, request):
    me = await asyncio.wait_for(client.get_me(), 5)
    if not me or str(me.id) != str(request["expected_account_id"]):
        raise BotContractError("folder_account_mismatch", "Fresh account identity does not match; no active-account fallback")
    return me


async def current_filters(client):
    result = await asyncio.wait_for(client(functions.messages.GetDialogFiltersRequest()), 15)
    folders = result if isinstance(result, list) else getattr(result, "filters", None)
    if not isinstance(folders, list):
        raise BotContractError("folder_inventory_invalid", "Upstream folder inventory is not complete/readable")
    return folders


def itkras_title(value):
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return (normalized == "атк: красавы" or bool(re.search(r"красавчик|itkrasavchik", normalized))) and not re.search(r"(?:^|\W)(?:ом|om)(?:\W|$)", normalized)


def eligible_folder_title(value):
    # The original ВУ already contains these Geek communities. Folder union
    # requires fresh membership; this predicate is never used by bot joining.
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return itkras_title(value) or normalized in {"no geeks are welcome", "you look like a geek"}


async def confirmed_groups(client, requested):
    """Resolve raw/marked IDs by actual TL entity, not by guessed -100 prefix.

    A complete metadata dialog inventory is required. Deadline/ceiling is an
    unknown inventory, never 'account/chat absent'. It sends no messages.
    """
    matches = [[] for _ in requested]

    async def scan():
        count = 0
        async for dialog in client.iter_dialogs(limit=None, ignore_migrated=True):
            count += 1
            if count > 10000:
                raise BotContractError("folder_dialog_inventory_incomplete", "Dialog inventory ceiling reached; no absence claim")
            entity = dialog.entity
            raw = str(getattr(entity, "id", ""))
            marked = peer_id(entity)
            for index, wanted in enumerate(requested):
                if wanted["chat_id"] not in (raw, marked):
                    continue
                actual_title = getattr(entity, "title", "")
                is_group = isinstance(entity, types.Chat) or (isinstance(entity, types.Channel) and bool(entity.megagroup))
                member = is_group and not any(bool(getattr(entity, field, False)) for field in ("left", "kicked", "deactivated"))
                matches[index].append((entity, actual_title, member, marked))
    try:
        await asyncio.wait_for(scan(), 30)
    except asyncio.TimeoutError:
        raise BotContractError("folder_dialog_inventory_timeout", "Dialog inventory deadline; state is unknown, not chat/account absence")
    output = []
    for wanted, found in zip(requested, matches):
        exact = [entry for entry in found if entry[1] == wanted["expected_title"]]
        if not exact and not found and wanted["chat_id"].startswith('-'):
            # Freshly joined basic groups may be addressable yet absent from
            # GetDialogs. Only an explicit marked PeerChat is eligible here;
            # title and self membership must be proved by GetFullChat.
            raw_id, namespace = utils.resolve_id(int(wanted["chat_id"]))
            if namespace is types.PeerChat:
                try:
                    entity = await asyncio.wait_for(client.get_entity(types.PeerChat(raw_id)), 10)
                    full = await asyncio.wait_for(client(functions.messages.GetFullChatRequest(chat_id=raw_id)), 10)
                    me = await asyncio.wait_for(client.get_me(), 5)
                    participants = getattr(full.full_chat, 'participants', None)
                    rows = list(getattr(participants, 'participants', []) or [])
                    self_row = getattr(participants, 'self_participant', None)
                    if self_row is not None: rows.append(self_row)
                    own = any(getattr(p, 'user_id', None) == me.id for p in rows)
                    member = own and isinstance(entity, types.Chat) and not any(bool(getattr(entity, f, False)) for f in ('left', 'kicked', 'deactivated'))
                    if entity.title == wanted['expected_title'] and member:
                        exact = [(entity, entity.title, True, peer_id(entity))]
                except Exception:
                    pass  # Missing proof is unknown, never permission to join.
        if len(exact) != 1:
            raise BotContractError("folder_group_identity_unproven", "Chat ID/title is missing, changed or ambiguous in a complete current inventory")
        entity, actual_title, member, marked = exact[0]
        if not member or not eligible_folder_title(actual_title):
            raise BotContractError("folder_group_not_confirmed_itkras_member", "Only current ITKras group members are eligible; pending requests/OM/users/channels are not")
        output.append({"peer": utils.get_input_peer(entity), "peer_id": marked, "title": actual_title,
                       "member": True, "kind": "chat" if isinstance(entity, types.Chat) else "megagroup"})
    return output


async def folder_read(client, request):
    await current_account(client, request)
    groups = await confirmed_groups(client, request.get("chats", [])) if request.get("chats") else []
    folders = await current_filters(client)
    return {"operation": "folder_read", "account_id": str(request["expected_account_id"]),
            "session": request["session"], "title": TITLE, "verified_at": time.time(),
            "inventory_complete": True, "snapshot_hash": filters_hash(folders),
            "matching_folder_ids": [f.id for f in folders if title(f) == TITLE],
            "filters": [{"id": getattr(f, "id", 0), "title": title(f), "hash": filter_hash(f),
                         "original": safe_tl(f)} for f in folders],
            "confirmed_members": [{k: v for k, v in g.items() if k != "peer"} for g in groups]}


def merge_plan(folders, groups):
    matching = [f for f in folders if title(f) == TITLE]
    if len(matching) > 1:
        raise BotContractError("folder_title_ambiguous", "Multiple exact ВУ folders; no arbitrary list index")
    if matching:
        original = matching[0]
        if not isinstance(original, (types.DialogFilter, types.DialogFilterChatlist)):
            raise BotContractError("folder_type_unsupported", "Unknown upstream TL filter; no lossy replacement")
        merged = copy.deepcopy(original)
        created = False
    else:
        used = {getattr(f, "id", 0) for f in folders}
        # Default/all-chats IDs are reserved. Telegram still enforces account limits.
        available = next((i for i in range(2, 256) if i not in used), None)
        if available is None:
            raise BotContractError("folder_no_unused_id", "No unoccupied custom filter ID")
        merged = types.DialogFilter(available, types.TextWithEntities(TITLE, []), [], [], [])
        original, created = None, True
    excluded = {peer_id(p) for p in getattr(merged, "exclude_peers", [])}
    conflicts = [g["peer_id"] for g in groups if g["peer_id"] in excluded]
    if conflicts:
        raise BotContractError("folder_existing_exclusion_conflict", "An authorized chat is explicitly excluded; preserve exclusion and report conflict")
    included = {peer_id(p) for p in merged.include_peers + merged.pinned_peers}
    added = []
    for group in groups:
        if group["peer_id"] not in included:
            merged.include_peers.append(group["peer"])
            included.add(group["peer_id"])
            added.append(group["peer_id"])
    return original, merged, created, added


class FolderOutbox(TextOutbox):
    def __init__(self, root):
        super().__init__(Path(root) / "telegram-folder-actions")

    def reserve(self, request):
        payload = digest(canonical(request))
        # Any unresolved mutation of this account/title fences all new keys,
        # including an altered chat set/session alias.
        fingerprint = digest(canonical([request["expected_account_id"], TITLE]))
        self.db.execute("BEGIN IMMEDIATE")
        try:
            existing = self.get(request["request_id"])
            if existing:
                if existing["payload_hash"] != payload:
                    raise SendError("folder_idempotency_conflict", "Original folder intent differs; nothing repeated")
                self.db.execute("COMMIT")
                return existing
            pending = self.db.execute("SELECT request_id FROM receipts WHERE fingerprint=? AND state IN ('prepared','dispatching','unknown') LIMIT 1", (fingerprint,)).fetchone()
            if pending:
                raise SendError("folder_previous_outcome_unknown", "Read original folder receipt, no new-key overwrite", original_request_id=pending[0])
            record = {"request_id": request["request_id"], "payload_hash": payload, "fingerprint": fingerprint,
                      "state": "prepared", "request": request, "created_at": time.time()}
            self.db.execute("INSERT INTO receipts VALUES(?,?,?,?,?)", (request["request_id"], payload, fingerprint, "prepared", canonical(record)))
            self.db.execute("COMMIT")
            return record
        except BaseException:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise


def receipt(record, busy=False):
    verified = record["state"] == "verified"
    return {"operation": "folder_merge_status", "request_id": record["request_id"],
            "state": "in_progress" if busy else record["state"], "ok": verified and not busy,
            "account_id": record["request"]["expected_account_id"], "session": record["request"]["session"],
            "title": TITLE, "outcome_unknown": record["state"] in ("dispatching", "unknown"),
            "membership_scope": "confirmed ITKras groups and original Geek communities; no join", "removals": 0,
            # Proposed IDs/counts stay inside durable intent until actual read-back.
            **({k: record[k] for k in ("folder_id", "added_peer_ids", "include_count", "pinned_count", "explicit_peer_count", "server_normalized_pinned_duplicates", "confirmed_members", "verified_at", "readback_hash", "other_filters_unchanged") if k in record} if verified else {}),
            **{k: record[k] for k in ("code", "error", "readback_diagnostic") if k in record},
            "sc_refresh_required": verified, "sc_materialized_verified": False,
            "next": "After verified upstream read-back, run telegram_refresh_folders for this exact session and inspect telegram_folder_state. Unknown: only read this original receipt; never replay UpdateDialogFilter."}


async def reconcile(client, box, record):
    try:
        await current_account(client, record["request"])
        folders = await current_filters(client)
        target = [f for f in folders if getattr(f, "id", None) == record["proposed_id"]]
        others = [filter_hash(f) for f in folders if getattr(f, "id", None) != record["proposed_id"]]
        matches = len(target) == 1 and filter_hash(target[0]) == record["expected_after_hash"]
        normalized_pinned = False
        repositioned_added = False
        compatible_additions = False
        peer_variants = [target[0]] if len(target) == 1 else []
        if len(target) == 1 and not matches:
            # Legacy intent may duplicate a pinned peer in include_peers.
            # Telegram removes that duplicate. Reconstruct the exact saved
            # wire proposal for proof only, NEVER send another folder RPC.
            actual = target[0]
            pinned_ids = {peer_id(p) for p in actual.pinned_peers}
            added = record.get("planned_added", [])
            peers = {peer_id(p): p for p in actual.include_peers + actual.pinned_peers}
            if added and all(p in peers for p in added):
                proposal = copy.deepcopy(actual)
                proposal.include_peers = [p for p in proposal.include_peers if peer_id(p) not in added]
                proposal.include_peers.extend(peers[p] for p in added)
                matches = filter_hash(proposal) == record["expected_after_hash"]
                normalized_pinned = matches and any(p in pinned_ids for p in added)
                repositioned_added = matches and not normalized_pinned
        if len(target) == 1 and not matches and others == record["other_hashes"]:
            # Another client can add peers after this RPC. Preserve that edit:
            # prove that removing only extra included peers reconstructs the
            # EXACT saved proposal (including pinned/order/flags/other fields).
            # No peer is removed on Telegram; this is bounded GET-only proof.
            protected = set(record.get('planned_added', []))
            removable = [i for i, p in enumerate(target[0].include_peers) if peer_id(p) not in protected]
            trials = 0
            for count in range(1, min(3, len(removable)) + 1):
                for indices in itertools.combinations(removable, count):
                    trials += 1
                    if trials > 2000: break
                    for variant in peer_variants:
                        proposal = copy.deepcopy(variant); deleted = set(indices)
                        proposal.include_peers = [p for i, p in enumerate(proposal.include_peers) if i not in deleted]
                        if filter_hash(proposal) == record['expected_after_hash']:
                            matches = True; compatible_additions = True; break
                    if matches: break
                if matches or trials > 2000: break
        if matches and others == record["other_hashes"]:
            return box.update(record["request_id"], state="verified", folder_id=target[0].id,
                              include_count=len(target[0].include_peers),
                              added_peer_ids=[p for p in record["planned_added"] if not normalized_pinned or p not in {peer_id(x) for x in target[0].pinned_peers}],
                              pinned_count=len(target[0].pinned_peers),
                              explicit_peer_count=len({peer_id(p) for p in target[0].include_peers + target[0].pinned_peers}),
                              server_normalized_pinned_duplicates=normalized_pinned,
                              server_repositioned_added_peers=repositioned_added,
                              compatible_concurrent_additions=compatible_additions,
                              confirmed_members=record["planned_members"], other_filters_unchanged=True,
                              verified_at=time.time(), readback_hash=filter_hash(target[0]), code=None, error=None)
        return box.update(record["request_id"], state="unknown", code="folder_readback_mismatch", error="No rollback/replay; current state differs from saved intent",
            readback_diagnostic={'target_hash_matches': matches, 'other_hashes_match': others == record['other_hashes'],
                'expected_after_hash': record['expected_after_hash'], 'actual_target_hash': filter_hash(target[0]) if len(target)==1 else None,
                'planned_added': record.get('planned_added'), 'expected_others': record['other_hashes'], 'actual_others': others})
    except Exception as error:
        return box.update(record["request_id"], state="unknown", code="folder_readback_unavailable", error=type(error).__name__)


async def run_folder_merge(client, request, root, emit_progress=lambda event: None):
    if request["title"] != TITLE:
        raise BotContractError("folder_scope_invalid", "Only exact Cyrillic ВУ is authorized")
    box = FolderOutbox(root)
    try:
        status = request["operation"] == "folder_merge_status"
        if status:
            record = box.get(request["request_id"])
            if not record:
                raise BotContractError("folder_request_not_found", "Original folder request not found")
            if (request["expected_account_id"] != record["request"]["expected_account_id"]
                    or request["session"] != record["request"]["session"]):
                raise BotContractError("folder_receipt_identity_mismatch", "Original account/session differs")
        else:
            if request.get("confirm") is not True or request.get("purpose") != "itkras_vu":
                raise BotContractError("folder_confirmation_required", "Only explicitly authorized ITKras union is supported")
            record = box.reserve(request)
        with box.lock(record["fingerprint"]) as acquired:
            record = box.get(record["request_id"])
            if not acquired:
                return receipt(record, busy=True)
            if record["state"] in ("dispatching", "unknown"):
                return receipt(await reconcile(client, box, record))
            if status or record["state"] != "prepared":
                return receipt(record)
            try:
                await current_account(client, request)
                groups = await confirmed_groups(client, request["chats"])
                folders = await current_filters(client)
                if filters_hash(folders) != request["expected_snapshot_hash"]:
                    raise BotContractError("folder_snapshot_changed", "Fresh filters differ from selected snapshot; no overwrite")
                original, merged, created, added = merge_plan(folders, groups)
                if not groups or (created and not merged.include_peers):
                    raise BotContractError("folder_no_confirmed_groups", "An empty folder is not this task")
                await current_account(client, request)
                # Last read immediately before intent/RPC catches edits during identity checks.
                latest = await current_filters(client)
                if filters_hash(latest) != request["expected_snapshot_hash"]:
                    raise BotContractError("folder_snapshot_changed", "Concurrent folder edit; nothing overwritten")
                record = box.update(record["request_id"], proposed_id=merged.id, expected_after_hash=filter_hash(merged),
                                    other_hashes=[filter_hash(f) for f in folders if getattr(f, "id", None) != merged.id],
                                    planned_added=added, planned_members=[{k: v for k, v in g.items() if k != "peer"} for g in groups])
            except Exception as error:
                return receipt(box.update(record["request_id"], state="rejected", code=getattr(error, "code", "folder_preflight_failed"), error=type(error).__name__))
            if original is None or filter_hash(original) != filter_hash(merged):
                # fsynced journal precedes RPC. SDK retries are disabled by the live worker.
                record = box.update(record["request_id"], state="dispatching", dispatched_at=time.time())
                emit_progress({"type": "progress", "stage": "dispatching_folder_update", "done": 0, "total": 1})
                try:
                    await asyncio.wait_for(client(functions.messages.UpdateDialogFilterRequest(id=merged.id, filter=merged)), 15)
                except Exception as error:
                    record = box.update(record["request_id"], state="unknown", code="folder_update_outcome_unknown", error=type(error).__name__)
            # Even a no-op must prove upstream state, not report cached includes.
            return receipt(await reconcile(client, box, record))
    finally:
        box.close()
