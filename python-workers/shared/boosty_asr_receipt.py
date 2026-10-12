"""Write-ahead paid request receipt. Unknown delivery NEVER means submit again."""
import hashlib
import fcntl
import json
import os
from pathlib import Path


class AsrDeliveryUnknown(RuntimeError):
    pass


def digest_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


class Receipt:
    def __init__(self, path, identity):
        self.path = Path(path)
        self.identity = identity

    def load(self):
        if not self.path.exists():
            return {"identity": self.identity, "state": "not_submitted"}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            raise AsrDeliveryUnknown("ASR receipt unreadable; no paid resubmit") from None
        if data.get("identity") != self.identity:
            raise AsrDeliveryUnknown("ASR receipt belongs to another child; no paid resubmit")
        return data

    def save(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.path.with_suffix(".json.part")
        with temporary.open("w", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump({**data, "identity": self.identity}, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.path)

    def get_or_submit(self, audio_path, submit, get_existing):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.path.with_suffix('.lock').open('a') as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise AsrDeliveryUnknown('Another submission owns this exact child receipt') from None
            return self._locked_get_or_submit(audio_path, submit, get_existing)

    def _locked_get_or_submit(self, audio_path, submit, get_existing):
        data = self.load()
        if data.get("transcript_id"):
            if Path(audio_path).is_file() and data.get("audio_sha256") != digest_file(audio_path):
                raise AsrDeliveryUnknown("Audio changed since paid submission")
            return get_existing(data["transcript_id"])
        if data["state"] != "not_submitted":
            raise AsrDeliveryUnknown("ASR delivery unknown; reconcile the original receipt, never resubmit")
        data.update(state="submit_inflight", audio_sha256=digest_file(audio_path))
        self.save(data)  # MUST be durable BEFORE crossing the provider boundary.
        transcript = submit()
        if not getattr(transcript, "id", None):
            raise AsrDeliveryUnknown("Provider did not confirm transcript ID; no paid retry")
        data.update(state="submitted", transcript_id=transcript.id)
        self.save(data)
        return transcript

    def completed(self, transcript_id, metadata=None):
        data = self.load()
        if data.get("transcript_id") != transcript_id:
            raise AsrDeliveryUnknown("ASR completion does not match receipt")
        self.save({**data, "state": "completed", **({'asr_metadata': metadata} if metadata is not None else {})})

    def bind_saved_pair(self, txt_path, srt_path):
        data = self.load()
        if data.get('state') != 'completed' or not data.get('transcript_id'):
            raise AsrDeliveryUnknown('No matching completed provider transcript for saved files')
        self.save({**data, 'saved_pair': {'txt_sha256': digest_file(txt_path), 'srt_sha256': digest_file(srt_path)}})
