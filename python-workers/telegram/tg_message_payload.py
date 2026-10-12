"""JSON-safe Telegram message metadata shared by fetch and live workers.

Telegram returns the attachment on the same Message object even when the
message was forwarded.  Historically our workers reduced that object to
``text + has_media`` and therefore threw away the only useful description of
the file (name, MIME type, size, dimensions, and forward origin).

This module deliberately serialises metadata only.  It never exposes access
hashes/file references and never downloads bytes; an explicit media-processing
path decides whether a concrete attachment should be downloaded.
"""

from __future__ import annotations

from pathlib import Path


TEXT_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024
TEXT_DOCUMENT_MAX_CHARS = 1_000_000

_TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".rst", ".adoc", ".log",
    ".json", ".jsonl", ".ndjson", ".csv", ".tsv",
    ".xml", ".html", ".htm", ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".py", ".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".less",
    ".sql", ".sh", ".zsh", ".bash", ".fish", ".ps1",
    ".c", ".h", ".cc", ".cpp", ".hpp", ".m", ".mm",
    ".java", ".kt", ".kts", ".go", ".rs", ".rb", ".php", ".swift",
    ".env", ".gitignore", ".dockerignore",
}

_TEXT_MIME_TYPES = {
    "application/json",
    "application/ld+json",
    "application/x-ndjson",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
    "application/javascript",
    "application/sql",
}


def _iso(value):
    return value.isoformat() if value is not None and hasattr(value, "isoformat") else None


def _entity_ref(entity):
    if entity is None:
        return None
    class_name = type(entity).__name__.lower()
    if "user" in class_name:
        kind = "user"
        name = " ".join(
            part for part in (
                getattr(entity, "first_name", None),
                getattr(entity, "last_name", None),
            ) if part
        )
    elif "channel" in class_name:
        kind = "channel"
        name = getattr(entity, "title", None) or ""
    elif "chat" in class_name:
        kind = "chat"
        name = getattr(entity, "title", None) or ""
    else:
        kind = class_name or "unknown"
        name = getattr(entity, "title", None) or getattr(entity, "first_name", None) or ""
    username = getattr(entity, "username", None)
    entity_id = getattr(entity, "id", None)
    return {
        "id": entity_id,
        "kind": kind,
        "name": name or username or (str(entity_id) if entity_id is not None else None),
        "username": username,
    }


def _peer_ref(peer):
    if peer is None:
        return None
    for attr, kind in (("user_id", "user"), ("channel_id", "channel"), ("chat_id", "chat")):
        value = getattr(peer, attr, None)
        if value is not None:
            return {"id": value, "kind": kind}
    return None


def reply_metadata(message):
    """Keep reply peer identity; a remote message ID is not a local parent.

    A missing reply_to_peer_id means the message's own peer in Telegram's
    protocol. An explicit peer must be compared by BOTH kind and ID. Access
    hashes/file references are deliberately never included.
    """
    source = _peer_ref(getattr(message, "peer_id", None)) if message is not None else None
    header = getattr(message, "reply_to", None) if message is not None else None
    rid = getattr(header, "reply_to_msg_id", None) if header is not None else None
    explicit_peer = getattr(header, "reply_to_peer_id", None) if header is not None else None
    target = _peer_ref(explicit_peer) if explicit_peer is not None else source
    packet = {
        "version": 1,
        "source_peer": source,
        "target_peer": target,
        "message_id": rid,
        "scope": "unavailable" if message is None else "none",
    }
    result = {"parent_external_id": None, "telegram_reply": packet, "external_reply": None}
    if not rid:
        return result
    if explicit_peer is not None and (source is None or target is None):
        packet["scope"] = "unknown"
        return result
    if explicit_peer is not None and source != target:
        packet["scope"] = "external_peer"
        external = {"peer": target, "message_id": rid}
        quote = getattr(header, "quote_text", None)
        if quote is not None:
            external["quote_text"] = quote
        quote_offset = getattr(header, "quote_offset", None)
        if quote_offset is not None:
            external["quote_offset"] = quote_offset
            external["quote_offset_unit"] = "utf16_code_units"
        result["external_reply"] = external
        return result
    top = getattr(header, "reply_to_top_id", None)
    if top and rid == top:
        packet["scope"] = "topic_anchor"
        return result
    packet["scope"] = "same_peer"
    result["parent_external_id"] = str(rid)
    return result


def forward_metadata(message):
    """Return compact forward provenance, or ``None`` for an original message."""
    raw = getattr(message, "fwd_from", None)
    custom = getattr(message, "forward", None)
    if raw is None and custom is None:
        return None

    source = None
    if custom is not None:
        source = _entity_ref(getattr(custom, "sender", None))
        if source is None:
            source = _entity_ref(getattr(custom, "chat", None))
    from_name = getattr(raw, "from_name", None) if raw is not None else None
    if source is None and from_name:
        source = {"id": None, "kind": "hidden", "name": from_name, "username": None}

    return {
        "date": _iso(
            getattr(custom, "date", None)
            or (getattr(raw, "date", None) if raw is not None else None)
        ),
        "source": source,
        "from_peer": _peer_ref(getattr(raw, "from_id", None)) if raw is not None else None,
        "from_name": from_name,
        "channel_post": getattr(raw, "channel_post", None) if raw is not None else None,
        "post_author": getattr(raw, "post_author", None) if raw is not None else None,
        "saved_from_peer": _peer_ref(getattr(raw, "saved_from_peer", None)) if raw is not None else None,
        "saved_from_message_id": getattr(raw, "saved_from_msg_id", None) if raw is not None else None,
        "imported": bool(getattr(raw, "imported", False)) if raw is not None else False,
    }


def attachment_metadata(message, message_kind=None):
    """Return one downloadable attachment description, or ``None``.

    Telegram albums are represented as several messages sharing ``grouped_id``;
    each Message still carries at most one media file, hence a single object is
    sufficient here and callers expose it as ``media: [attachment]``.
    """
    media = getattr(message, "media", None)
    if media is None:
        return None
    file = getattr(message, "file", None)
    photo = getattr(message, "photo", None)
    document = getattr(message, "document", None)
    if file is None and photo is None and document is None:
        return None

    name = getattr(file, "name", None) if file is not None else None
    mime = getattr(file, "mime_type", None) if file is not None else None
    size = getattr(file, "size", None) if file is not None else None
    width = getattr(file, "width", None) if file is not None else None
    height = getattr(file, "height", None) if file is not None else None
    duration = getattr(file, "duration", None) if file is not None else None
    return {
        "kind": message_kind or "file",
        "file_name": name,
        "content_type": mime or None,
        "bytes": int(size) if size is not None else None,
        "width": int(width) if width is not None else None,
        "height": int(height) if height is not None else None,
        "duration_seconds": float(duration) if duration is not None else None,
        "media_type": type(media).__name__,
        "grouped_id": str(getattr(message, "grouped_id", None)) if getattr(message, "grouped_id", None) is not None else None,
        "spoiler": bool(getattr(media, "spoiler", False)),
    }


def message_media(message, message_kind=None):
    attachment = attachment_metadata(message, message_kind)
    return [attachment] if attachment is not None else []


def item_raw_meta(item):
    """Build the DB raw_meta object from a worker item payload."""
    media = item.get("media") if isinstance(item, dict) else None
    forward = item.get("forward") if isinstance(item, dict) else None
    out = {}
    if isinstance(media, list) and media:
        out["media"] = media
    if isinstance(forward, dict):
        out["forward"] = forward
    if isinstance(item.get("telegram_reply"), dict):
        out["telegram_reply"] = item["telegram_reply"]
    if "external_reply" in item and (item["external_reply"] is None or isinstance(item["external_reply"], dict)):
        out["external_reply"] = item["external_reply"]
    return out or None


def is_pdf_attachment(attachment):
    if not isinstance(attachment, dict):
        return False
    mime = str(attachment.get("content_type") or "").split(";", 1)[0].strip().lower()
    name = str(attachment.get("file_name") or "")
    return mime == "application/pdf" or Path(name).suffix.lower() == ".pdf"


def is_text_attachment(attachment):
    if not isinstance(attachment, dict):
        return False
    mime = str(attachment.get("content_type") or "").split(";", 1)[0].strip().lower()
    name = str(attachment.get("file_name") or "")
    suffix = Path(name).suffix.lower()
    basename = Path(name).name.lower()
    return (
        mime.startswith("text/")
        or mime in _TEXT_MIME_TYPES
        or suffix in _TEXT_EXTENSIONS
        or basename in {"dockerfile", "makefile", "readme", "license"}
    )


def read_text_attachment(path, *, max_bytes=TEXT_DOCUMENT_MAX_BYTES, max_chars=TEXT_DOCUMENT_MAX_CHARS):
    """Decode a bounded text attachment and return ``(text, truncated)``."""
    file_path = Path(path)
    with file_path.open("rb") as handle:
        raw = handle.read(max_bytes + 1)
    truncated = len(raw) > max_bytes
    raw = raw[:max_bytes]

    if raw.startswith((b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")):
        text = raw.decode("utf-32", errors="replace")
    elif raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = raw.decode("utf-16", errors="replace")
    else:
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            try:
                from charset_normalizer import from_bytes
                best = from_bytes(raw).best()
                text = str(best) if best is not None else raw.decode("utf-8", errors="replace")
            except Exception:
                text = raw.decode("utf-8", errors="replace")

    if len(text) > max_chars:
        text = text[:max_chars]
        truncated = True
    text = text.replace("\x00", "").strip()
    if truncated:
        text += "\n\n[файл обрезан безопасным лимитом парсера]"
    return text, truncated
