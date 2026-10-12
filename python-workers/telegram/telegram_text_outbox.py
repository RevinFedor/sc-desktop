"""Durable one-message receipts. No message bodies or Telethon auth in this DB.

The request lock spans network I/O. A committed dispatching row is never sent
again, even after a crash. SQLite serializes reservation across MCP processes.
"""
import fcntl
import hashlib
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


class SendError(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code = code
        self.details = details


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def payload_hash(request):
    payload = {key: request[key] for key in (
        "session", "target", "expected_account_id", "expected_peer_id", "text",
    )}
    # Existing plain-send receipts retain their exact pre-reply hash.
    payload.update({key: request[key] for key in ("reply_to_message_id", "topic_id") if key in request})
    return digest(json.dumps(payload, ensure_ascii=False, sort_keys=True))


class TextOutbox:
    def __init__(self, root):
        self.root = Path(root) / "telegram-outbox"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.locks = self.root / "locks"
        self.locks.mkdir(exist_ok=True, mode=0o700)
        path = self.root / "receipts.sqlite3"
        self.db = sqlite3.connect(str(path), timeout=30, isolation_level=None)
        os.chmod(path, 0o600)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA busy_timeout=30000")
        self.db.execute("""CREATE TABLE IF NOT EXISTS receipts (
            request_id TEXT PRIMARY KEY,
            payload_hash TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            state TEXT NOT NULL,
            record_json TEXT NOT NULL
        )""")
        self.db.execute("CREATE INDEX IF NOT EXISTS receipts_fingerprint ON receipts(fingerprint, state)")

    def close(self):
        self.db.close()

    def get(self, request_id):
        row = self.db.execute("SELECT record_json FROM receipts WHERE request_id=?", (request_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def reserve(self, request):
        rid = request["request_id"]
        fields = [
            request["expected_account_id"], request["expected_peer_id"], request["text"],
        ]
        if "reply_to_message_id" in request:
            fields.append([request["reply_to_message_id"], request.get("topic_id")])
        fingerprint = digest(json.dumps(fields, ensure_ascii=False))
        self.db.execute("BEGIN IMMEDIATE")
        try:
            previous = self.get(rid)
            if previous:
                if previous["payload_hash"] != payload_hash(request):
                    raise SendError("idempotency_conflict", "This request_id belongs to a different payload. Nothing sent.")
                self.db.execute("COMMIT")
                return previous
            pending = self.db.execute(
                "SELECT request_id FROM receipts WHERE fingerprint=? AND state IN ('prepared','dispatching','acknowledged','unknown') LIMIT 1",
                (fingerprint,),
            ).fetchone()
            if pending:
                raise SendError("unresolved_previous_send", "An identical delivery is unresolved. Inspect the original request_id; do not create a new key.",
                                original_request_id=pending[0])
            record = {
                "request_id": rid, "payload_hash": payload_hash(request), "fingerprint": fingerprint,
                "session": request["session"], "target": request["target"],
                "account_id": request["expected_account_id"], "peer_id": request["expected_peer_id"],
                "text_sha256": digest(request["text"]), "text_chars": len(request["text"]),
                "random_id": str(secrets.randbits(63) or 1), "state": "prepared",
                "created_at": time.time(), "message_id": None,
            }
            record.update({key: request[key] for key in ("reply_to_message_id", "topic_id") if key in request})
            self.db.execute("INSERT INTO receipts VALUES (?,?,?,?,?)", (
                rid, record["payload_hash"], fingerprint, record["state"], json.dumps(record),
            ))
            self.db.execute("COMMIT")
            return record
        except BaseException:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise

    def update(self, request_id, **changes):
        # Called only while the request flock is held, including ACK callbacks.
        self.db.execute("BEGIN IMMEDIATE")
        try:
            record = self.get(request_id)
            if record is None:
                raise SendError("request_not_found", "Delivery receipt not found")
            record.update(changes, updated_at=time.time())
            self.db.execute("UPDATE receipts SET state=?,record_json=? WHERE request_id=?", (
                record["state"], json.dumps(record), request_id,
            ))
            self.db.execute("COMMIT")
            return record
        except BaseException:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise

    @contextmanager
    def lock(self, request_id):
        # Never unlink lock files: another process may already have one open.
        fd = os.open(str(self.locks / (digest(request_id) + ".lock")), os.O_CREAT | os.O_RDWR, 0o600)
        acquired = False
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError:
                pass
            yield acquired
        finally:
            if acquired:
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def public_receipt(record, *, busy=False):
    state = record["state"]
    return {
        "ok": state == "delivered",
        "delivered": state == "delivered",
        "state": "in_progress" if busy else state,
        **{key: record.get(key) for key in (
            "request_id", "session", "account_id", "peer_id", "recipient", "text_chars",
            "message_id", "code", "error", "retry_after_seconds", "verified_at",
            "candidate_message_ids",
        )},
        **{key: record[key] for key in ("reply_to_message_id", "topic_id") if key in record},
        "retry_instruction": "Use the same request_id and identical payload, or telegram_send_text_status. Never resend an unresolved attempt under a new key.",
    }
