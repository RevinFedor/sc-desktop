"""Scoped ASR checkpoint inspection/adoption through the desktop job runner.

No Telegram connection, download, upload, transcription creation or deletion.
Only a positively identified existing Soniox file can resolve a lost upload ACK.
An empty inventory never resets an uncertain checkpoint.
"""
from __future__ import annotations
import hashlib
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "shared"))
from soniox_utils import get_soniox_key, http_json
from tg_voice_policy import VoiceCache

def failure(code, message):
    error = RuntimeError(message)
    error.code = code
    raise error

def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def peer_identity(marked):
    text = str(marked)
    if re.fullmatch(r"-100[1-9]\d*", text):
        return ["channel", int(text[4:])]
    if re.fullmatch(r"-[1-9]\d*", text):
        return ["chat", -int(text)]
    if re.fullmatch(r"[1-9]\d*", text):
        return ["user", int(text)]
    failure("invalid_asr_scope", "A canonical marked peer is required")

def records_for(directory, peer, message_ids):
    root = Path(directory)
    if root.is_symlink():
        failure("invalid_asr_scope", "Checkpoint directory must not be a symlink")
    selected = {int(x): [] for x in message_ids}
    if not root.exists():
        return selected
    for file in root.iterdir():
        if not re.fullmatch(r"[0-9a-f]{64}\.json", file.name):
            continue
        if file.is_symlink() or not file.is_file() or file.stat().st_size > 8*1024*1024:
            failure("asr_checkpoint_unreadable", "Checkpoint type/size is unsafe")
        try:
            value = json.loads(file.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            failure("asr_checkpoint_unreadable", "Checkpoint cannot be safely inspected")
        identity = value.get("identity") if isinstance(value, dict) else None
        if not isinstance(identity, dict) or identity.get("peer") != peer or identity.get("message_id") not in selected:
            continue
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        if value.get("version") != 1 or digest != file.stem:
            failure("asr_checkpoint_identity_mismatch", "Checkpoint fingerprint does not match its identity")
        selected[identity["message_id"]].append({"file":file, "value":value, "fingerprint":fingerprint(value)})
    return selected

def list_provider_files(key, request=http_json):
    found, cursor, seen = [], None, set()
    for _ in range(100):
        query = {"limit":100}
        if cursor:
            query["cursor"] = cursor
        page = request("https://api.soniox.com/v1/files?"+urlencode(query), key=key, timeout=20)
        if not isinstance(page.get("files"), list):
            failure("provider_inventory_invalid", "Soniox files response has no list")
        found.extend(page["files"])
        cursor = page.get("next_page_cursor")
        if not cursor:
            return found
        if not isinstance(cursor, str) or cursor in seen:
            failure("provider_inventory_invalid", "Nonmonotonic provider cursor")
        seen.add(cursor)
    failure("provider_inventory_incomplete", "Provider file enumeration ceiling reached")

def matches_for(record, files, started, finished):
    value = record["value"]
    digest, size = record["file"].stem, value["identity"].get("size")
    matches = []
    for item in files:
        if not isinstance(item, dict):
            continue
        filename = item.get("filename")
        if not isinstance(filename, str) or not re.fullmatch(re.escape(digest)+r"\.(ogg|oga|opus|mp3|wav|m4a|aac|flac|aiff|weba)", filename, re.I):
            continue
        try:
            created = datetime.fromisoformat(item["created_at"].replace("Z", "+00:00")).timestamp()
        except (KeyError, ValueError, TypeError):
            continue
        if isinstance(size, int) and item.get("size") == size and started-120 <= created <= finished+120:
            matches.append({k:item.get(k) for k in ("id","filename","size","created_at")})
    return matches

def inspect(request, provider_request=http_json):
    peer = peer_identity(request["expected_peer_id"])
    ids = request.get("message_ids")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 5000 or any(type(x) is not int or x<1 for x in ids):
        failure("invalid_asr_scope", "Explicit original message IDs are required")
    records = records_for(request["state_dir"], peer, ids)
    originally_blocked = set(request.get("originally_blocked_ids") or [])
    files, provider_error, provider_checked = [], None, False
    if request.get("provider_inventory", True) and any(len(v)==1 and v[0]["value"].get("state")=="uploading" and not v[0]["value"].get("file_id") for v in records.values()):
        provider_checked = True
        try:
            key = get_soniox_key()
            if not key:
                failure("provider_key_unavailable", "Configured Soniox key is unavailable")
            files = list_provider_files(key, provider_request)
        except Exception as error:
            provider_error = getattr(error, "code", None) or type(error).__name__
    items = []
    for mid, candidates in records.items():
        item = {"message_id":mid, "state":"not_started", "unknown":mid in originally_blocked}
        if len(candidates)>1:
            item.update(state="ambiguous_identity", unknown=True)
        elif candidates:
            record, value = candidates[0], candidates[0]["value"]
            state = value.get("state")
            unknown = state not in ("uploading","uploaded","creating","processing","completed") or (state in ("uploading","uploaded") and not value.get("file_id") and not value.get("transcription_id")) or (state in ("creating","processing") and not value.get("transcription_id")) or (value.get("engine") not in (None,"soniox") and state!="completed")
            if mid in originally_blocked and not (state=="completed" or value.get("file_id") or value.get("transcription_id")):
                unknown = True
            item.update(state=state, unknown=bool(unknown), engine=value.get("engine"), checkpoint_hash=record["fingerprint"],
                        has_file_id=bool(value.get("file_id")), has_transcription_id=bool(value.get("transcription_id")),
                        completed=state=="completed", no_speech=state=="completed" and not str(value.get("text") or "").strip())
            if state=="uploading" and not value.get("file_id"):
                item["matching_files"] = matches_for(record, files, request["started_at"], request["finished_at"])
        elif mid in originally_blocked:
            item["state"] = "missing_uncertain_checkpoint"
        items.append(item)
    return {"ok":True, "operation":"inspect", "peer":peer, "items":items,
            "blocked_message_ids":[i["message_id"] for i in items if i["unknown"]],
            "safe_message_ids":[i["message_id"] for i in items if not i["unknown"]],
            "provider_inventory_checked":provider_checked,
            "provider_inventory_complete":provider_checked and provider_error is None,
            "provider_inventory_error":provider_error,
            "empty_inventory_does_not_authorize_retry":True}

def adopt_file(request, provider_request=http_json):
    mid = request.get("message_id")
    if mid not in request.get("message_ids", []):
        failure("invalid_asr_scope", "Adoption target is not in the original scope")
    records = records_for(request["state_dir"], peer_identity(request["expected_peer_id"]), [mid])[mid]
    if len(records)!=1:
        failure("asr_checkpoint_ambiguous", "Exactly one original checkpoint is required")
    record, value = records[0], records[0]["value"]
    audit = value.get("upload_ack_reconciliation") or {}
    if value.get("file_id")==request.get("file_id") and audit.get("original_checkpoint_hash")==request.get("expected_checkpoint_hash"):
        return {"ok":True,"operation":"adopt_file","message_id":mid,"idempotent":True,"checkpoint_hash":record["fingerprint"]}
    if record["fingerprint"] != request.get("expected_checkpoint_hash"):
        failure("asr_checkpoint_changed", "Checkpoint changed; inspect again")
    if value.get("state")!="uploading" or value.get("file_id") or value.get("transcription_id") or value.get("engine")!="soniox":
        failure("asr_adoption_not_allowed", "Only an uncertain Soniox upload can adopt a verified existing file")
    files = list_provider_files(get_soniox_key(), provider_request)
    matches = matches_for(record, files, request["started_at"], request["finished_at"])
    if len(matches)!=1 or matches[0].get("id")!=request.get("file_id"):
        failure("asr_file_not_uniquely_verified", "Provider file must uniquely match fingerprint, size and original attempt time")
    cache = VoiceCache(record["file"], record["file"].with_suffix(""), value["identity"], "soniox")
    if fingerprint(cache.load()) != record["fingerprint"]:
        failure("asr_checkpoint_changed", "Checkpoint changed during provider verification")
    cache.save({**value,"state":"uploaded","file_id":matches[0]["id"],"upload_ack_reconciliation":{
        "original_checkpoint_hash":record["fingerprint"],"file":matches[0],"original_request_id":request["original_request_id"]}})
    return {"ok":True,"operation":"adopt_file","message_id":mid,"idempotent":False,"checkpoint_hash":fingerprint(cache.load())}

def main():
    try:
        request = json.load(sys.stdin)
        if request.get("action", "inspect") not in ("inspect", "adopt_file"):
            failure("invalid_asr_action", "Unknown ASR checkpoint action")
        result = adopt_file(request) if request.get("action")=="adopt_file" else inspect(request)
        print(json.dumps({"type":"result","result":result}), flush=True)
        print(json.dumps({"type":"done"}), flush=True)
    except Exception as error:
        print(json.dumps({"type":"error","code":getattr(error,"code",None) or "asr_recovery_failed","message":str(error)[:500]}), flush=True)
        return 1
    return 0

if __name__=="__main__":
    sys.exit(main())
