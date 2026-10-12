"""Optional job-local voice policy. No auth or network; metadata is never removed."""
import hashlib
import json
import math
import os
import shutil
import tempfile
from pathlib import Path


class MediaStorageError(RuntimeError):
    code = "media_storage_unavailable"


class UnknownMediaDelivery(RuntimeError):
    code = "media_delivery_unknown"


def fatal_media_error(error):
    return isinstance(error, (MediaStorageError, UnknownMediaDelivery)) or getattr(error, "code", None) in (
        "media_delivery_unknown", "media_storage_unavailable",
    )


def known_duration(message):
    candidates = [getattr(getattr(message, "file", None), "duration", None)]
    document = getattr(getattr(message, "media", None), "document", None)
    candidates += [getattr(attr, "duration", None) for attr in (getattr(document, "attributes", None) or [])]
    for value in candidates:
        if isinstance(value, bool):
            continue
        try:
            number = float(value)
        except (ValueError, TypeError):
            continue
        if math.isfinite(number) and number > 0:
            return number
    return None


def checked_directory(directory, min_free_bytes=0):
    path = Path(directory)
    if not path.is_absolute() or path == Path("/"):
        raise MediaStorageError("media cache must be an absolute owned directory")
    # An unplugged volume can leave a same-named ordinary directory. Never
    # silently write large media onto the system disk in that case.
    if len(path.parts) >= 3 and path.parts[1] == "Volumes":
        volume = Path(*path.parts[:3])
        if not volume.is_mount():
            raise MediaStorageError("selected media volume is not mounted")
        try:
            path.resolve().relative_to(volume.resolve())
        except (ValueError, OSError) as error:
            raise MediaStorageError("selected external cache escapes its mounted volume") from error
    try:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not path.is_dir() or not os.access(path, os.W_OK):
            raise OSError("directory is not writable")
        if shutil.disk_usage(path).free < min_free_bytes:
            raise OSError("insufficient free space for selected media cache")
    except OSError as error:
        raise MediaStorageError(str(error)) from error
    return path


def media_directory_fence(directory, min_free_bytes=0):
    path = checked_directory(directory, min_free_bytes)
    volume = Path(*path.parts[:3]) if len(path.parts) >= 3 and path.parts[1] == "Volumes" else None
    if volume is not None:
        try:
            stat = volume.stat()
            if path.resolve().stat().st_dev != stat.st_dev:
                raise MediaStorageError("external cache is not on the selected media volume")
        except OSError as error:
            raise MediaStorageError("selected external media volume is no longer available") from error
        return path, (str(volume), stat.st_dev, stat.st_ino)
    return path, None


def verify_media_directory_fence(directory, fence, min_free_bytes=0):
    path, current = media_directory_fence(directory, min_free_bytes)
    if current != fence:
        raise MediaStorageError("selected media mount changed before download")
    return path


class VoicePolicy:
    def __init__(self, *, kinds=None, max_seconds=None, cache_dir=None,
                 state_dir=None, reuse_existing=False, min_free_bytes=268435456):
        self.kinds = tuple(kinds) if kinds is not None else ("voice", "audio", "video")
        if not self.kinds or any(kind not in ("voice", "audio", "video") for kind in self.kinds):
            raise ValueError("voice_types must contain voice/audio/video")
        if max_seconds is not None and (isinstance(max_seconds, bool) or not math.isfinite(max_seconds) or max_seconds <= 0):
            raise ValueError("voice_max_duration_sec must be positive")
        self.max_seconds = max_seconds
        self.cache_dir, self.state_dir = cache_dir, state_dir
        self.reuse_existing = bool(reuse_existing)
        if isinstance(min_free_bytes, bool) or not isinstance(min_free_bytes, int) or min_free_bytes < 0:
            raise ValueError("media_min_free_bytes must be a nonnegative integer")
        self.min_free_bytes = min_free_bytes

    def decision(self, message, kind):
        duration = known_duration(message)
        if kind not in self.kinds:
            return "type_not_allowed", duration
        if self.max_seconds is not None:
            if duration is None:
                return "unknown_duration", None
            if duration > self.max_seconds:
                return "duration_limit", duration
        return None, duration

    def cache(self, message, engine):
        if not self.state_dir:
            return None
        peer = getattr(message, "peer_id", None)
        namespace = next(((kind, getattr(peer, attr, None)) for kind, attr in
                          (("channel", "channel_id"), ("chat", "chat_id"), ("user", "user_id"))
                          if getattr(peer, attr, None) is not None), ("unknown", None))
        document = getattr(getattr(message, "media", None), "document", None)
        identity = {"peer": namespace, "message_id": message.id,
                    "document_id": str(getattr(document, "id", "unknown")),
                    "size": getattr(getattr(message, "file", None), "size", None)}
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        state_root = checked_directory(self.state_dir, 1048576)
        media_root = Path(self.cache_dir or str(state_root / "media"))
        return VoiceCache(state_root / (digest + ".json"), media_root / digest, identity, engine)


class VoiceCache:
    def __init__(self, state_path, download_path, identity, engine):
        self.path, self.download_path = Path(state_path), Path(download_path)
        self.identity, self.engine = identity, engine

    def load(self):
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (ValueError, OSError) as error:
            raise UnknownMediaDelivery("media checkpoint cannot be read; outcome must be recovered before another provider call") from error
        if not isinstance(value, dict) or value.get("version") != 1:
            raise UnknownMediaDelivery("media checkpoint format is unknown")
        if value.get("identity") != json.loads(json.dumps(self.identity)):
            raise UnknownMediaDelivery("media checkpoint identity mismatch")
        return value

    def save(self, value):
        value = {**value, "version": 1, "identity": self.identity, "engine": value.get("engine", self.engine)}
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            descriptor, temporary = tempfile.mkstemp(prefix=".media-", dir=self.path.parent)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(value, output, ensure_ascii=False)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        except OSError as error:
            raise MediaStorageError("could not persist durable media checkpoint: " + str(error)) from error
        finally:
            if temporary and os.path.exists(temporary):
                try: os.unlink(temporary)
                except OSError: pass

    def completed(self):
        value = self.load()
        return value if value.get("state") == "completed" else None


class FetchTraversalCache:
    """Durable snapshot identity, NOT an acknowledgement of library commits.

    A process restart replays metadata from the same frozen head. The cursor is
    used only for in-process FloodWait continuation; ASR checkpoints avoid paid
    repeats during replay even if the desktop lost a metadata event/commit ACK.
    """
    def __init__(self, directory, request_id, account_id, peer):
        root = checked_directory(directory, 1048576)
        identity = {"request_id": request_id, "account_id": account_id, "peer": peer}
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        self.cache = VoiceCache(root / ("fetch-" + digest + ".json"), root / "unused", identity, "traversal")

    def load(self):
        return self.cache.load()

    def save(self, value):
        self.cache.save({**value, "restart_policy": "replay_metadata_from_frozen_head"})
