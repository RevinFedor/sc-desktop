#!/usr/bin/env python3
"""Streaming Telegram fetcher for the SC Desktop UI.

Emits one JSON object per line ('ndjson'). The Electron main process
spawns this and forwards each line to the renderer.

Events:
  {"type": "info",     "message": "..."}
  {"type": "entity",   "kind": "user|channel|chat|group", "title": "...", "username": "...", "id": 123}
  {"type": "page",     "loaded": 100, "limit": 500}
  {"type": "item",     "data": {id, date, text, type, sender, has_media, duration, ...}}
  {"type": "warning",  "code": "no_new_messages|empty_result", "message": "..."}
  {"type": "error",    "message": "...", "code": "optional_machine_code"}
  {"type": "done",     "items_total": N, "duration_sec": 4.2}

`warning` is NON-fatal: the job still completes `done`. It exists to turn an
otherwise-mute «готово · 0 items» outcome into a plain «ничего не найдено».
The message is always neutral — an empty result is never «wrong target»
(personal chats ARE parseable). The renderer surfaces it in amber.

Usage:
  tg_fetch_json.py <target> --mode last_n --limit 500
  tg_fetch_json.py <target> --mode all
  tg_fetch_json.py <target> --mode from_date --date "01.01.26 12:00"
  tg_fetch_json.py <target> --mode single --url https://t.me/x/100
"""
import sys
import os
import json
import asyncio
import time
import argparse
import platform
import subprocess
from pathlib import Path
from datetime import datetime

# --- macOS Tahoe + Electron spawn workaround --------------------------------
# When this script is launched as a child of Electron's helper process,
# platform.mac_ver() can return ('', '', '') because the SystemVersion plist
# isn't reachable from the sandboxed env. telethon/crypto/libssl.py then
# blows up on `release.split('.')`. Patch it before importing telethon.
if sys.platform == 'darwin':
    _mac_ver = platform.mac_ver()
    if not _mac_ver[0]:
        try:
            r = subprocess.check_output(['/usr/bin/sw_vers', '-productVersion'],
                                        text=True).strip()
        except Exception:
            r = '14.0'    # safe modern fallback
        platform.mac_ver = lambda r=r: (r, ('', '', ''), platform.machine())
# ---------------------------------------------------------------------------

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from credentials import telegram_credentials
from library_db import open_db, missing_comment_post_ids, processed_external_ids_by_kind

try:
    TELEGRAM_API_ID, TELEGRAM_API_HASH = telegram_credentials()
except RuntimeError as ex:
    print(json.dumps({"type": "error", "message": str(ex), "code": "telegram_credentials_missing"}), flush=True)
    sys.exit(2)


# Where avatars live on disk. Same root as library.db so a single backup
# captures everything, and the protocol handler in Electron resolves
# 'sc-asset://avatars/...' relative to LIB_ROOT.
def _lib_root():
    override = os.environ.get("SC_DESKTOP_DIR") or os.environ.get("MEDIA_INBOX_DIR")
    if override:
        return Path(override)
    return Path.home() / "Library" / "Application Support" / "sc-desktop"


def _avatar_path_for(entity_id):
    p = _lib_root() / "avatars" / "telegram" / f"{entity_id}.jpg"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p

try:
    from telethon import TelegramClient
    from telethon.tl.types import (
        User, Chat, Channel,
        MessageMediaDocument, MessageMediaPhoto, MessageMediaPoll,
        ReactionEmoji, ReactionCustomEmoji,
    )
except ImportError:
    print(json.dumps({"type": "error", "message": "telethon not installed", "code": "worker_dependency_missing"}), flush=True)
    sys.exit(2)

# Forum topics moved between Telethon versions:
#   1.42+ → telethon.tl.functions.messages.GetForumTopicsRequest
#   older → telethon.tl.functions.channels.GetForumTopicsRequest (or absent)
# Keep this optional — chats without topics work fine without it.
GetForumTopicsRequest = None
try:
    from telethon.tl.functions.messages import GetForumTopicsRequest
except ImportError:
    try:
        from telethon.tl.functions.channels import GetForumTopicsRequest
    except ImportError:
        pass

# Channel comments: live in a linked discussion group, not the channel itself.
# GetDiscussionMessageRequest resolves a channel msg → linked-chat-msg pair so
# we can iter_messages(reply_to=...) over the actual comment thread.
try:
    from telethon.tl.functions.messages import GetDiscussionMessageRequest
except ImportError:
    GetDiscussionMessageRequest = None
try:
    from telethon.tl.functions.channels import GetFullChannelRequest
except ImportError:
    GetFullChannelRequest = None
try:
    from telethon.errors import FloodWaitError
except ImportError:
    FloodWaitError = Exception   # fall through to generic catch


# Active session is read from ~/.config/sc/settings.json::telegram.session
# (shared with the CLI tools).  Defaults to 'session2' if the key is missing.
# Resolution = dev (next to script) → prod (user data dir). See
# shared/tg_session_path.py for rationale.
#
# RACE: Electron снимает имя сессии в момент спавна (job.tg_session), а этот
# модуль читал settings.json заново при импорте — окно ~0.5-1 сек, в котором
# быстрое переключение сессии в UI давало расхождение «job записан за session A,
# Python реально ходил session B». Поэтому job-runner теперь передаёт явный
# --session из своего снапшота; чтение settings.json — только fallback для
# ручных запусков из терминала.
from tg_session_path import resolve_session_path, connect_authorized

def _resolve_session_path(name_override=None):
    name = "session2"
    if name_override and isinstance(name_override, str):
        name = name_override
    else:
        settings_path = Path.home() / ".config" / "sc" / "settings.json"
        if settings_path.exists():
            try:
                data = json.loads(settings_path.read_text("utf-8"))
                n = (data.get("telegram") or {}).get("session")
                if n and isinstance(n, str):
                    name = n
            except Exception:
                pass
    return resolve_session_path(name, Path(__file__).parent)


SESSION_PATH = _resolve_session_path()


def _bump_session_busy_timeout(client, timeout_ms=30000):
    """Telethon's default SQLiteSession opens the .session file without
    busy_timeout, so two Python processes (e.g. running fetch + concurrent
    --preview-only or --resolve-title) instantly hit
    'sqlite3.OperationalError: database is locked'. Setting a 30s busy
    timeout makes the second connection wait for the first one to release
    the write lock instead of bailing.
    """
    try:
        sess = getattr(client, "session", None)
        conn = getattr(sess, "_conn", None) if sess else None
        if conn is None:
            return
        conn.execute(f"PRAGMA busy_timeout = {int(timeout_ms)}")
    except Exception:
        pass


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


# Access failures that describe the peer itself rather than the network or
# the Telegram session.  Electron persists this machine code on the saved
# source and pauses background pulls until a manual/live probe succeeds.
# Keep the human message free to evolve; JS never matches its text.
_SOURCE_UNAVAILABLE_ERROR_NAMES = {
    "ChannelPrivateError",
    "ChannelInvalidError",
    "ChannelPublicGroupNaError",
    "ChatAdminRequiredError",
    "InputUserDeactivatedError",
    "PeerIdInvalidError",
    "UserBannedInChannelError",
    "UserDeactivatedError",
}


def _source_unavailable_code(ex, numeric_missing=False):
    if type(ex).__name__ in _SOURCE_UNAVAILABLE_ERROR_NAMES:
        return "telegram_source_unavailable"
    # After a *complete* iter_dialogs walk, ValueError from get_entity(int)
    # means this stable id is not present for the bound account.  A ValueError
    # on an arbitrary username is deliberately not classified this way — the
    # username may simply have been renamed.
    if numeric_missing and isinstance(ex, ValueError):
        return "telegram_source_unavailable"
    return None


def _emit_source_resolution_error(target, ex, numeric_missing=False):
    code = _source_unavailable_code(ex, numeric_missing=numeric_missing)
    if code:
        emit({
            "type": "error",
            "code": code,
            "message": (
                f"Telegram больше не отдаёт сохранённый чат {target} выбранному аккаунту. "
                f"Он удалён, стал приватным или аккаунт потерял доступ "
                f"({type(ex).__name__}: {ex})."
            ),
        })
    else:
        emit({"type": "error",
              "message": f"Cannot resolve chat_id {target}: {type(ex).__name__}: {ex}"})


# Sets of msg_id (as strings) that already have transcribe_status='done' in
# the desktop SQLite DB. Populated from --skip-processed-file at startup; if
# the flag is omitted (or the file is missing) the sets stay empty and every
# voice/photo/pdf is re-processed. process_media() checks membership BEFORE
# touching Telegram or the AI provider — saves bandwidth, AAI minutes, and
# Gemini quota on re-fetches.
_SKIP_VOICE = {}   # {msg_id_str: engine_str}
_SKIP_PHOTO = {}
_SKIP_PDF = {}


def _should_skip_processed(skip_map, msg_id, engine):
    """Decide whether the given msg_id should be skipped.

    Skip when (a) the msg has been processed before AND either:
      - the previous engine matches the requested one (same caption block
        would be produced again — pure waste), or
      - we don't know which engine processed it (legacy rows from before
        transcribe_engine started being persisted; treat as skipped to avoid
        rerunning blindly — user can override via «парсить заново» toggle).

    Re-runs with a *different* known engine are intentional: appendItemTranscript
    appends a second caption block keyed by engine name so the user can
    compare AAI vs Gemini side by side.
    """
    key = str(msg_id)
    if key not in skip_map:
        return False
    prev = skip_map[key] or ''
    if not prev:
        return True  # legacy row, no engine info → don't waste a re-run
    return prev == engine


def classify(msg):
    # Telethon properties for media-typed messages — checked in priority order
    # because a single message can match multiple (e.g. a sticker is also a
    # document; a video note is also a video). Sticker takes precedence over
    # generic document so the user sees «стикер» not «документ» in the type
    # breakdown.
    if msg.voice:        return "voice"
    if getattr(msg, "sticker", None):  return "sticker"
    if msg.video:        return "video"
    if msg.audio:        return "audio"
    if msg.photo:        return "photo"
    if getattr(msg, "gif", None):      return "gif"
    if msg.document:     return "document"
    if isinstance(getattr(msg, "media", None), MessageMediaPoll):
        return "poll"
    # ServiceMessage: pinned/joined/title-changed/etc. Telethon exposes
    # them as Message instances with `action` set and no text; counting
    # them as their own bucket keeps `other` rare and meaningful.
    if getattr(msg, "action", None):   return "service"
    if msg.text:         return "text"
    # Anything left really is unknown territory — keep the bucket but at
    # this point it should be a single-digit count even on big chats.
    return "other"


def reactions_for(msg):
    """Serialise msg.reactions into a compact list [{e, n}, …].

    - ReactionEmoji   → e = emoticon string ('👍')
    - ReactionCustomEmoji → e = 'custom:<document_id>' (rare)
    - other shapes    → skip silently

    Returns:
      None  when Telethon exposed no concrete reaction list for this message
      []    when reactions were checked and none are set
      [...] populated list otherwise

    The ndjson event includes the `reactions` key even when this returns
    None; Electron treats key presence as "checked" and stores NULL with
    reactions_resolved=1.
    """
    r = getattr(msg, "reactions", None)
    if r is None:
        # Telethon didn't return a reaction list for this message (common for
        # ordinary messages with no visible reactions, and some service rows).
        return None
    results = list(getattr(r, "results", None) or [])
    out = []
    for rc in results:
        rk = getattr(rc, "reaction", None)
        n = int(getattr(rc, "count", 0) or 0)
        if isinstance(rk, ReactionEmoji):
            emoji = getattr(rk, "emoticon", None) or ""
            if emoji:
                out.append({"e": emoji, "n": n})
        elif isinstance(rk, ReactionCustomEmoji):
            doc_id = getattr(rk, "document_id", None)
            if doc_id is not None:
                out.append({"e": f"custom:{doc_id}", "n": n})
        # other reaction kinds — skip
    return out


def render_poll(msg):
    """Build a human-readable text block for a poll/quiz message.

    Output format (matches assemble.js / copy panel expectations — body lives
    in caption, label `[📊 Опрос]` is added by assemble.js via TYPE_TAG):

        Куда едем в субботу?
        ▢ Парк Победы — 12
        ▣ Эрмитаж — 27
        ▢ Дома — 4

    Quiz: correct option marked with ▣, others ▢. Anonymous polls hide vote
    counts (Telegram doesn't return them); closed polls keep counts. Returns
    empty string if msg is not a poll or telethon shape is unexpected.
    """
    media = getattr(msg, "media", None)
    if not isinstance(media, MessageMediaPoll):
        return ""
    poll = getattr(media, "poll", None)
    results = getattr(media, "results", None)
    if poll is None:
        return ""
    q_obj = getattr(poll, "question", None)
    question = getattr(q_obj, "text", q_obj) if q_obj is not None else ""
    is_quiz = bool(getattr(poll, "quiz", False))
    is_public = bool(getattr(poll, "public_voters", False))
    is_closed = bool(getattr(poll, "closed", False))
    answers = list(getattr(poll, "answers", []) or [])
    res_list = list(getattr(results, "results", None) or []) if results else []
    res_by_opt = {}
    for r in res_list:
        opt = getattr(r, "option", None)
        if opt is not None:
            res_by_opt[bytes(opt)] = r
    show_counts = bool(res_list)  # anonymous closed polls return empty results
    lines = []
    if question:
        lines.append(str(question))
    for ans in answers:
        a_text_obj = getattr(ans, "text", "")
        a_text = getattr(a_text_obj, "text", a_text_obj) or ""
        opt_key = getattr(ans, "option", None)
        r = res_by_opt.get(bytes(opt_key)) if opt_key is not None else None
        is_correct = bool(r and getattr(r, "correct", False))
        marker = "▣" if (is_quiz and is_correct) else "▢"
        if show_counts and r is not None:
            voters = int(getattr(r, "voters", 0) or 0)
            lines.append(f"{marker} {a_text} — {voters}")
        else:
            lines.append(f"{marker} {a_text}")
    suffix_bits = []
    if not is_public and not show_counts:
        suffix_bits.append("анонимный")
    if is_closed:
        suffix_bits.append("завершён")
    if suffix_bits:
        lines.append(f"({', '.join(suffix_bits)})")
    return "\n".join(lines).strip()


# Lazy gemini_utils import — single-message and batch loops both call this
# at most once per message, but the import itself is heavy (probes API keys,
# starts gemini SDK). Cache the module reference after first hit.
_GEMINI_MOD = None


def _make_gemini_client(*, requires_real_key=True):
    """Construct a GeminiClient, ensuring a real API key when needed.

    GeminiClient.__init__ loads from env/settings, so we
    instantiate first and *then* validate. AssemblyAI-only flows accept
    an empty/placeholder key — no real Gemini RPC will be made.
    """
    global _GEMINI_MOD
    if _GEMINI_MOD is None:
        sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
        import gemini_utils  # noqa: WPS433  (lazy by design)
        _GEMINI_MOD = gemini_utils
    gc = _GEMINI_MOD.GeminiClient()
    if requires_real_key:
        key = (gc.api_key or "").strip()
        if not key or key == "unused-by-assemblyai":
            raise RuntimeError(
                "GEMINI_API_KEY not found — Gemini transcription / vision / "
                "PDF extraction won't work. Set it in env or ~/.config/sc/settings.json."
            )
    elif not (gc.api_key or "").strip():
        # AssemblyAI path still needs *some* string downstream.
        gc.api_key = "unused-by-assemblyai"
    return gc


def _probe_audio(file_path):
    """Return (has_audio: bool, duration_sec: float|None) for `file_path`.

    Telegram «video» messages are commonly silent screen captures, GIF-style
    animations, or stickers re-encoded as mp4/webm — they have a video track
    but no audio. AssemblyAI rejects them with 'No audio stream found in the
    file' and we count it as an error in media_phase.errors. ffprobe answers
    both questions locally in <50ms, so we ask before paying the round-trip
    and surface duration to the UI from stage=downloading onward (instead of
    waiting until AAI returns it on stage=queued).

    Failure cases (ffprobe missing, corrupt container, timeout) → return
    (True, None): assume audio is present so we don't skip real files, but
    no duration. Caller decides whether to show "?".
    """
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error",
             "-show_entries", "stream=codec_type:format=duration",
             "-of", "default=nw=1", str(file_path)],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            return True, None
        out = r.stdout or ""
        has_audio = "codec_type=audio" in out
        dur = None
        for line in out.splitlines():
            if line.startswith("duration="):
                try:
                    raw = line.split("=", 1)[1].strip()
                    if raw and raw not in ("N/A", "0"):
                        dur = round(float(raw), 1)
                except Exception:
                    pass
                break
        return has_audio, dur
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
        return True, None


def _has_audio_stream(file_path):
    """Backwards-compatible thin wrapper. Prefer _probe_audio for new code."""
    has_audio, _ = _probe_audio(file_path)
    return has_audio


def _emit_media_skipped(*, kind, msg_id, reason):
    """Skip event — message had media of the right type but we deliberately
    didn't process it. Different from `media-error` (counts toward errors)
    and from a missing event (renderer thinks nothing happened). Treated as
    a no-op terminal: increments `total` only, neither done nor errors."""
    emit({"type": "media-skipped", "kind": kind, "msg_id": msg_id, "reason": reason})


def _emit_media_progress(*, kind, msg_id, stage, engine=None, **extra):
    """Single source of truth for AI-processing progress events.

    All three media kinds (voice/photo/pdf) emit through the same `media-progress`
    event so the renderer can render them uniformly and the job-runner can
    aggregate counters by `kind`. We still emit legacy aliases for one release
    cycle in case any consumer caches the old names; they go away once the
    desktop side is verified on prod.
    """
    payload = {
        "type":   "media-progress",
        "kind":   kind,         # 'voice' | 'photo' | 'pdf'
        "msg_id": msg_id,
        "stage":  stage,
    }
    if engine is not None:
        payload["engine"] = engine
    payload.update(extra)
    emit(payload)


def _emit_media_error(*, kind, msg_id, message):
    emit({"type": "media-error", "kind": kind, "msg_id": msg_id, "message": message})


async def process_media(msg, msg_type, *,
                        transcribe_engine=None,
                        process_voice=False,
                        process_photo=False,
                        process_docs=False):
    """Run AI processing on a single message's media.

    Emits its own ndjson events tied to msg.id so the job-runner can attach
    them back to the right item row. Returns silently when the message has
    no media or the user didn't opt-in to that type.

    Progress events (downloading / uploading / queued / transcribing /
    describing / extracting / completed) all go through `media-progress`
    with a `kind` discriminator. Successful results are still per-kind
    finals (`transcript` / `photo-text` / `pdf-text`) — they carry text
    payloads and have distinct downstream handlers (caption replay, .txt
    export, etc.). Errors share `media-error`.

    The three opt-in flags are independent: a fetch can ask for voice but
    not docs, etc. Engine is shared across voice/video transcription.
    """
    if not msg.media:
        return

    # ── Voice / audio (also routes video here when process_voice=True) ──
    is_audio = msg_type in ("voice", "audio")
    is_video = msg_type == "video"
    if process_voice and transcribe_engine and (is_audio or is_video):
        if _should_skip_processed(_SKIP_VOICE, msg.id, transcribe_engine):
            _emit_media_skipped(kind="voice", msg_id=msg.id,
                                reason=f"уже обработано · {transcribe_engine}")
            return
        tmp_path = None
        try:
            # Telethon also exposes an attribute `duration` on voice/audio
            # messages (in seconds, integer). Use it as a pre-download hint
            # so the UI shows «аудио 0:42» from the very first event, even
            # before ffprobe has anything to chew on. ffprobe's float reading
            # supersedes it after download.
            tg_duration = None
            try:
                doc = getattr(msg.media, "document", None)
                if doc:
                    for attr in (doc.attributes or []):
                        d = getattr(attr, "duration", None)
                        if d:
                            tg_duration = float(d); break
            except Exception:
                pass
            _emit_media_progress(kind="voice", msg_id=msg.id,
                                 stage="downloading", engine=transcribe_engine,
                                 audio_duration_sec=tg_duration)
            tmp_path = await msg.download_media(file=f"/tmp/tg_media_{msg.id}")
            if not tmp_path or not os.path.exists(tmp_path):
                raise RuntimeError("download_media returned no path")
            # Pre-flight: silent video (mp4/webm screencast, animation
            # without audio track) → AAI returns "No audio stream found".
            # Cheap to detect locally, expensive to ask the API. Skipping
            # also keeps the user's media_phase.errors counter honest —
            # those weren't *errors*, the file just had no audio to read.
            has_audio, probed_dur = _probe_audio(tmp_path)
            if is_video and not has_audio:
                _emit_media_skipped(kind="voice", msg_id=msg.id,
                                    reason="no audio track (silent video)")
                return  # finally below cleans tmp_path
            # ffprobe duration overrides the Telethon hint when available
            # (more accurate — Telethon rounds to integer seconds).
            duration_sec = probed_dur if probed_dur is not None else tg_duration
            # AssemblyAI route doesn't touch Gemini at all — accept placeholder
            # key. Gemini route obviously needs a real one.
            gc = _make_gemini_client(requires_real_key=transcribe_engine != "assemblyai")

            def _progress(stage, **kw):
                # AAI fills audio_duration_sec on `queued` from its own
                # probe. For other stages we inject the locally-probed value
                # so the UI can show duration from the very first tick.
                if "audio_duration_sec" not in kw and duration_sec is not None:
                    kw["audio_duration_sec"] = duration_sec
                _emit_media_progress(kind="voice", msg_id=msg.id, stage=stage,
                                     engine=transcribe_engine,
                                     audio_path=tmp_path, **kw)

            if transcribe_engine != "assemblyai":
                _emit_media_progress(kind="voice", msg_id=msg.id,
                                     stage="transcribing",
                                     engine=transcribe_engine,
                                     audio_path=tmp_path,
                                     audio_duration_sec=duration_sec)

            text, err = gc.transcribe_audio(
                tmp_path,
                engine=transcribe_engine,
                progress_cb=_progress if transcribe_engine == "assemblyai" else None,
            )
            if err:
                raise RuntimeError(err)
            emit({"type": "transcript",
                  "msg_id": msg.id,
                  "engine": transcribe_engine,
                  "text": text or ""})
        except Exception as ex:
            _emit_media_error(kind="voice", msg_id=msg.id,
                              message=f"{type(ex).__name__}: {ex}")
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try: os.remove(tmp_path)
                except Exception: pass
        return

    # ── Photo (Gemini Vision describe_image) ──
    if process_photo and msg_type == "photo":
        if _should_skip_processed(_SKIP_PHOTO, msg.id, "gemini-vision"):
            _emit_media_skipped(kind="photo", msg_id=msg.id,
                                reason="уже обработано")
            return
        tmp_path = None
        try:
            _emit_media_progress(kind="photo", msg_id=msg.id, stage="downloading")
            tmp_path = await msg.download_media(file=f"/tmp/tg_photo_{msg.id}")
            if not tmp_path or not os.path.exists(tmp_path):
                raise RuntimeError("download_media returned no path")
            gc = _make_gemini_client(requires_real_key=True)
            _emit_media_progress(kind="photo", msg_id=msg.id, stage="describing")
            text, err = gc.describe_image(tmp_path)
            if err:
                raise RuntimeError(err)
            emit({"type": "photo-text",
                  "msg_id": msg.id,
                  "engine": "gemini-vision",
                  "text": text or ""})
        except Exception as ex:
            _emit_media_error(kind="photo", msg_id=msg.id,
                              message=f"{type(ex).__name__}: {ex}")
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try: os.remove(tmp_path)
                except Exception: pass
        return

    # ── Document / PDF (Gemini extract_pdf) ──
    # Telethon's "document" bucket is broad: PDFs, DOCX, archives, even
    # generic videos and audio that didn't match the voice/audio detectors.
    # We only know how to handle PDF reliably — sniff mime first and skip
    # otherwise (with a benign info event so the UI doesn't show a scary
    # error for an unsupported type).
    if process_docs and msg_type == "document":
        if _should_skip_processed(_SKIP_PDF, msg.id, "gemini"):
            _emit_media_skipped(kind="pdf", msg_id=msg.id,
                                reason="уже обработано")
            return
        mime = (getattr(msg.media, "document", None)
                and getattr(msg.media.document, "mime_type", None)) or ""
        # Telegram returns 'application/pdf' for PDFs; everything else falls
        # outside Gemini's PDF extractor.
        if "pdf" not in mime.lower():
            emit({"type": "doc-skipped",
                  "msg_id": msg.id,
                  "mime":   mime or "unknown",
                  "reason": "non-PDF document — only PDFs are supported"})
            return
        tmp_path = None
        try:
            _emit_media_progress(kind="pdf", msg_id=msg.id, stage="downloading")
            tmp_path = await msg.download_media(file=f"/tmp/tg_doc_{msg.id}")
            if not tmp_path or not os.path.exists(tmp_path):
                raise RuntimeError("download_media returned no path")
            gc = _make_gemini_client(requires_real_key=True)
            _emit_media_progress(kind="pdf", msg_id=msg.id, stage="extracting")
            text, err = gc.extract_pdf(tmp_path)
            if err:
                raise RuntimeError(err)
            emit({"type": "pdf-text",
                  "msg_id": msg.id,
                  "engine": "gemini",
                  "text": text or ""})
        except Exception as ex:
            _emit_media_error(kind="pdf", msg_id=msg.id,
                              message=f"{type(ex).__name__}: {ex}")
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try: os.remove(tmp_path)
                except Exception: pass
        return


def kind_of(entity):
    if isinstance(entity, User):
        return "user"
    if isinstance(entity, Channel):
        return "channel" if getattr(entity, "broadcast", False) else "group"
    if isinstance(entity, Chat):
        return "chat"
    return "unknown"


def title_of(entity):
    return (
        getattr(entity, "title", None)
        or " ".join(filter(None, [getattr(entity, "first_name", None), getattr(entity, "last_name", None)]))
        or getattr(entity, "username", None)
        or "?"
    )


def _normalize_title(s):
    """Lenient form for title matching: lowercased, whitespace-collapsed,
    and surrounding punctuation/quotes stripped. Catches everyday cases
    like Telegram showing `«Берсерки едут в Амстердам»` (guillemets) when
    the user typed the bare phrase. We only strip *surrounding* punctuation
    (not interior) so titles like `Чат | EBASH` still match exactly."""
    if not s: return ""
    t = " ".join(s.split()).casefold()
    # Strip a small, ambiguous punctuation set from both ends.
    return t.strip(' \t\n«»“”‘’\'"`()[]{}.,;:!?-—–')


async def _resolve_via_dialog_walk(client, needle):
    """Last-resort entity resolution: scan iter_dialogs() looking for a chat
    whose title matches `needle` (lenient via _normalize_title). Returns the
    entity or None.

    Why this exists: get_entity('bari_s_patrikovv') fails with
    UsernameNotOccupied when the chat is *private* (no public @handle), even
    if a private chat with that exact title is in the user's dialog list.
    The detect.js heuristic can't tell `bari_s_patrikovv` apart from a real
    Telegram handle — both are slug-shaped — so the user lands here. Walk
    the dialogs as a fallback before declaring the entity unresolvable.

    Cost: 30-60s on accounts with thousands of dialogs (Telethon cannot do
    server-side title search for private chats). We only pay this cost when
    the public-handle path has already failed. Emit `resolve_progress` every
    100 dialogs scanned so the renderer can show «просмотрено N…» instead of
    a silent spinner — same contract as the dedicated `resolve_title` mode."""
    target = _normalize_title(needle)
    if not target:
        return None
    scanned = 0
    async for d in client.iter_dialogs():
        scanned += 1
        if scanned % 100 == 0:
            emit({"type": "resolve_progress", "scanned": scanned})
        if _normalize_title(d.name or "") == target:
            return d.entity
    return None


async def resolve_title(text, fuzzy=False, limit=50):
    """One-shot mode: walk iter_dialogs(), emit one chat_candidate per
    title-equivalent dialog (lenient: punctuation/quote-tolerant). Used by
    paste-flow when user types a free-text chat name that has no @username/URL
    (e.g. "Чат | EBASH" or `Берсерки едут в Амстердам` for `«…»` chat).
    Emits `resolve_progress` every 100 dialogs scanned so the UI can show
    "просмотрено N…" instead of an opaque spinner. Exits 0 on 0 matches —
    UI decides how to render that."""
    if not SESSION_PATH.exists():
        emit({"type": "error",
              "message": f"Session file '{SESSION_PATH.name}' not found — open Telegram settings and pick or create a session."})
        return 4
    client = TelegramClient(str(SESSION_PATH).replace(".session", ""),
                            TELEGRAM_API_ID, TELEGRAM_API_HASH)
    _bump_session_busy_timeout(client)
    ok, err, code = await connect_authorized(client, session_name=SESSION_PATH.stem)
    if not ok:
        emit({"type": "error", "message": err, "code": code})
        try: await client.disconnect()
        except Exception: pass
        return 4

    needle = _normalize_title(str(text or "").lstrip("@"))
    matches = 0
    scanned = 0
    try:
        async for d in client.iter_dialogs():
            scanned += 1
            if scanned % 100 == 0:
                emit({"type": "resolve_progress", "scanned": scanned})
            t = " ".join((d.name or "").split())
            title_norm = _normalize_title(t)
            ent = d.entity
            username_norm = _normalize_title(getattr(ent, "username", None))
            ent_id = getattr(ent, "id", None)
            id_matches = ent_id is not None and needle in {str(ent_id), f"-100{ent_id}"}
            if fuzzy:
                if not needle or (needle not in title_norm and needle not in username_norm and not id_matches):
                    continue
            elif title_norm != needle and username_norm != needle and not id_matches:
                continue
            last_at = None
            if d.date:
                try: last_at = d.date.isoformat()
                except Exception: last_at = None
            members = (getattr(ent, "participants_count", None)
                       or getattr(d, "participants_count", None))
            emit({
                "type": "chat_candidate",
                "chat_id":       ent.id,
                "title":         t,
                "kind":          kind_of(ent),
                "username":      getattr(ent, "username", None),
                "members":       members,
                "last_message_at": last_at,
            })
            matches += 1
            if limit and matches >= limit:
                break
    finally:
        emit({"type": "resolve_done", "matches": matches, "scanned": scanned,
              "fuzzy": bool(fuzzy)})
        await client.disconnect()
    return 0


async def _resolve_linked_chat(client, entity):
    """Return (linked_chat_id, has_discussion). For non-channel entities (or
    channels without a linked discussion group) returns (None, False).
    GetFullChannelRequest is the only authoritative source — `linked_chat_id`
    is part of `full_chat`, not the regular Channel object."""
    if GetFullChannelRequest is None:
        return None, False
    if not getattr(entity, "broadcast", False) and not getattr(entity, "megagroup", False):
        return None, False
    try:
        full = await client(GetFullChannelRequest(entity))
        linked = getattr(full.full_chat, "linked_chat_id", None)
        if linked:
            return linked, True
        return None, False
    except Exception as ex:
        emit({"type": "info", "message": f"linked_chat lookup failed: {ex}"})
        return None, False


async def _fetch_comments_for_post(client, channel, linked_chat, post_id,
                                   per_post_limit, sender_label_fn):
    """Walk the discussion thread of `post_id` in `linked_chat`. Returns list
    of {comment_id, parent_comment_id, sender, text, date, post_external_id}.
    `per_post_limit=0` means no limit. One FloodWait retry; on second failure
    re-raises so the caller can mark this post as errored.
    """
    out = []
    try:
        # Get the discussion-message id for this post — this is the root of
        # the thread inside `linked_chat`, used as `reply_to`.
        disc = await client(GetDiscussionMessageRequest(channel, post_id))
        # disc.messages[0].id is the thread root in linked_chat.
        if not disc.messages:
            return out
        thread_root = disc.messages[0].id
    except Exception as ex:
        # Some posts have no discussion (admin disabled, post too old, etc.).
        # Treat as "no comments", not error.
        emit({"type": "info",
              "message": f"discussion lookup for post {post_id} failed: {ex}"})
        return out

    iter_kwargs = {"entity": linked_chat, "reply_to": thread_root}
    if per_post_limit and per_post_limit > 0:
        iter_kwargs["limit"] = per_post_limit

    attempt = 0
    while True:
        try:
            async for cmt in client.iter_messages(**iter_kwargs):
                # Skip the thread root itself (Telegram echoes it).
                if cmt.id == thread_root:
                    continue
                rt = getattr(cmt, "reply_to", None)
                parent = None
                if rt:
                    rid = getattr(rt, "reply_to_msg_id", None)
                    # If the reply target is the thread root, treat as
                    # top-level — this is just "comment to the post".
                    if rid and rid != thread_root:
                        parent = rid
                out.append({
                    "post_external_id": str(post_id),
                    "comment_id":       cmt.id,
                    "parent_comment_id": parent,
                    "sender":           await sender_label_fn(cmt),
                    "text":             (cmt.text or "")[:8000],
                    "date":             int(cmt.date.timestamp()) if cmt.date else None,
                })
            return out
        except FloodWaitError as ex:
            wait = int(getattr(ex, "seconds", 0) or 5)
            attempt += 1
            if attempt > 1:
                # Don't loop forever; bubble up as a per-post error.
                raise
            emit({"type": "info",
                  "message": f"FloodWait {wait}s on post {post_id}, retrying once"})
            await asyncio.sleep(wait + 1)
            out = []  # restart the iteration
            continue


async def run(target, mode, limit, date_str, url, since_msgid=0, preview_only=False,
              transcribe_engine=None, transcribe_lang="ru",
              process_voice=False, process_photo=False, process_docs=False,
              process_polls=False,
              include_comments=False, comments_limit=0,
              comments_only_post_ids=None,
              media_only_msg_ids=None,
              message_ids=None,
              topic_ids=None,
              date_to_str=None):
    t0 = time.time()
    if not SESSION_PATH.exists():
        emit({"type": "error",
              "message": f"Session file '{SESSION_PATH.name}' not found — open Telegram settings and pick or create a session."})
        sys.exit(4)
    client = TelegramClient(str(SESSION_PATH).replace(".session", ""),
                            TELEGRAM_API_ID, TELEGRAM_API_HASH)
    _bump_session_busy_timeout(client)
    ok, err, code = await connect_authorized(client, session_name=SESSION_PATH.stem)
    if not ok:
        emit({"type": "error", "message": err, "code": code})
        try: await client.disconnect()
        except Exception: pass
        sys.exit(4)

    # Resolve entity. If target is a numeric chat_id (came from --resolve-title
    # picker), get_entity(int) needs the chat in the session's input-entity
    # cache. Warm it up with iter_dialogs() if direct resolve fails — same
    # session file means iter_dialogs in the resolve script already cached it,
    # but a fresh session reuse may have missed.
    handle = target.lstrip("@") if not target.startswith("http") else target
    is_numeric = handle.lstrip("-").isdigit()
    try:
        entity = await client.get_entity(int(handle) if is_numeric else handle)
    except Exception as first_ex:
        if is_numeric:
            try:
                async for _ in client.iter_dialogs():
                    pass
            except Exception as walk_ex:
                _emit_source_resolution_error(target, walk_ex)
                await client.disconnect()
                return 2
            try:
                entity = await client.get_entity(int(handle))
            except Exception as ex:
                _emit_source_resolution_error(target, ex, numeric_missing=True)
                await client.disconnect()
                return 2
        else:
            # Public-handle resolve failed (UsernameNotOccupied / UsernameInvalid /
            # similar). Fall back to scanning the user's own dialogs — `handle`
            # might literally be the *title* of a private chat, not a public
            # username. detect.js can't distinguish a real handle from a
            # slug-shaped chat title, so this fallback is what makes
            # paste-flow forgiving for private-only chats.
            entity = await _resolve_via_dialog_walk(client, handle)
            if entity is None:
                emit({"type": "error", "message": f"Cannot resolve {target}: {first_ex}"})
                await client.disconnect()
                return 2

    # Download profile photo once per source. Cheap (one extra round-trip)
    # and idempotent — overwrites the same JPG on every fetch so a chat
    # icon update propagates. Failures are non-fatal: emit avatar_path=None
    # and let the UI fall back to initials.
    avatar_rel = None
    try:
        if getattr(entity, "photo", None):
            ap = _avatar_path_for(entity.id)
            saved = await client.download_profile_photo(entity, file=str(ap))
            if saved:
                avatar_rel = str(Path(saved).relative_to(_lib_root()))
    except Exception as ex:
        emit({"type": "info", "message": f"avatar download failed: {ex}"})

    is_forum = bool(getattr(entity, "forum", False))
    # Detect linked discussion group up-front so the renderer can grey out
    # the «Комментарии» checkbox immediately on form mount, not after the
    # first fetch finishes.
    linked_chat_id, has_discussion = await _resolve_linked_chat(client, entity)

    emit({
        "type": "entity",
        "kind": kind_of(entity),
        "id": entity.id,
        "title": title_of(entity),
        "username": getattr(entity, "username", None),
        "avatar_path": avatar_rel,
        "forum": is_forum,
        "has_discussion": has_discussion,
    })

    # Forum supergroups can have many topics. Resolve their id→title map up
    # front so every item we emit can carry a topic_title without a
    # per-message API hit. Telethon doesn't expose a high-level helper —
    # GetForumTopicsRequest with offset_id=0/limit=100 returns the first
    # page; for chats with > 100 topics we'd paginate via offset_id, but
    # that's rare enough that we accept "topic_id known, title null" for
    # the long tail.
    topic_titles = {}
    if is_forum and GetForumTopicsRequest is not None:
        try:
            res = await client(GetForumTopicsRequest(
                peer=entity, offset_date=None,
                offset_id=0, offset_topic=0, limit=100,
            ))
            for t in res.topics:
                tid = getattr(t, "id", None)
                title = getattr(t, "title", None)
                if tid is not None and title:
                    topic_titles[tid] = title
                    emit({"type": "topic", "id": tid, "title": title,
                          "icon_emoji": getattr(t, "icon_emoji_id", None) and str(t.icon_emoji_id)
                                        or None})
            emit({"type": "info", "message": f"forum topics: {len(topic_titles)}"})
        except Exception as ex:
            emit({"type": "info", "message": f"forum topics fetch failed: {ex}"})

    def _topic_for(msg):
        """Return (topic_id, topic_title) for a message, or (None, None) for
        non-forum chats. General topic in a forum surfaces as topic_id=1
        (Telegram's reserved 'General' top_msg_id) — we keep it explicit so
        the UI can show it as its own chip."""
        if not is_forum:
            return None, None
        rt = getattr(msg, "reply_to", None)
        # forum_topic flag means "this message belongs to a topic"
        # reply_to_top_id = id of the topic root message
        # If reply_to_msg_id == reply_to_top_id, the user replied to the
        # topic itself (post directly in the topic, not in a thread).
        if rt and getattr(rt, "forum_topic", False):
            tid = getattr(rt, "reply_to_top_id", None) or getattr(rt, "reply_to_msg_id", None)
        else:
            tid = 1   # Telegram reserves msg_id=1 for the General topic
        return tid, topic_titles.get(tid)

    def _reply_to_for(msg):
        """Return msg_id of the message this one replies to, or None.

        Forum-topic membership uses the same reply_to.* fields, so we must
        not treat «this message belongs to topic X» as «replies to message
        X». Rule: if reply_to_msg_id == reply_to_top_id, it's the topic
        marker — no real reply target. Channel comments (which arrive in
        post_comments table, not items) skip this code path entirely."""
        rt = getattr(msg, "reply_to", None)
        if not rt:
            return None
        rid = getattr(rt, "reply_to_msg_id", None)
        top = getattr(rt, "reply_to_top_id", None)
        if not rid:
            return None
        if top and rid == top:
            return None
        return rid

    me = await client.get_me()
    sender_names = {me.id: "Я"}

    async def sender_label(msg):
        sid = msg.sender_id
        if not sid:
            return None
        if sid in sender_names:
            return sender_names[sid]
        try:
            s = await msg.get_sender()
            name = getattr(s, "first_name", None) or getattr(s, "title", None) or str(sid)
            sender_names[sid] = name
            return name
        except Exception:
            return str(sid)

    # Mode → iter_messages kwargs
    kwargs = {"entity": entity, "reverse": False}
    # Optional upper-bound on message.date — set by the from_date branch when
    # --date-to is also passed. Filtered in the consume loop below.
    date_to_cutoff = None
    parsed_from_date = None
    if mode == "last_n":
        kwargs["limit"] = limit
        # Skip-dupes path: caller passes --since-msgid pointing at the
        # highest external_id we already cached. Telethon honours min_id
        # alongside limit — server returns up to N messages with id>min_id,
        # not the chat tail. So "последние 500" of a 30k-cached source
        # delivers 500 truly NEW messages, not 500 dupes the UPSERT would
        # silently drop. UI presents this as the «пропускать дубли» toggle
        # next to the N input; off → kwargs stays as-is (legacy tail).
        if since_msgid and since_msgid > 0:
            kwargs["min_id"] = since_msgid
            emit({"type": "info",
                  "message": f"last_n with min_id={since_msgid} (skip dupes)"})
    elif mode == "sync_new":
        # Pull only messages newer than the highest msg_id we already cached.
        # If the caller didn't pass --since-msgid (or it's 0 = empty source),
        # fall back to last_n=200 — gives us the most recent slice without
        # tearing through the whole history.
        if since_msgid and since_msgid > 0:
            kwargs["min_id"] = since_msgid
            emit({"type": "info", "message": f"sync_new: min_id={since_msgid}"})
        else:
            kwargs["limit"] = limit or 200
            emit({"type": "info", "message": "sync_new without since_msgid → last_n fallback"})
    elif mode == "all":
        pass
    elif mode == "from_date":
        if not date_str:
            emit({"type": "error", "message": "from_date requires --date"})
            await client.disconnect()
            return 2
        # Accept (in priority): full "dd.mm.yy HH:MM" / "dd.mm.yyyy HH:MM",
        # then date-only "dd.mm.yy" / "dd.mm.yyyy" (assumed 00:00).
        # ISO "yyyy-mm-dd" tolerated too — it's what users paste from anywhere.
        def _parse_user_date(s):
            for fmt in ("%d.%m.%y %H:%M:%S", "%d.%m.%Y %H:%M:%S",
                        "%Y-%m-%d %H:%M:%S",
                        "%d.%m.%y %H:%M", "%d.%m.%Y %H:%M",
                        "%d.%m.%y",       "%d.%m.%Y",
                        "%Y-%m-%d %H:%M", "%Y-%m-%d"):
                try:
                    return datetime.strptime(s.strip(), fmt)
                except Exception:
                    continue
            return None
        parsed = _parse_user_date(date_str)
        if parsed is None:
            emit({"type": "error",
                  "message": f"Bad date {date_str!r}: ожидаю «01.01.26», «01.01.2026» или «01.01.2026 12:00»"})
            await client.disconnect()
            return 2
        parsed_from_date = parsed
        kwargs["offset_date"] = parsed
        kwargs["reverse"] = True
        if limit:
            kwargs["limit"] = limit
        # Optional upper bound: when --date-to is set, the iteration walks
        # forward from `parsed` in reverse=True order until it crosses the
        # upper bound. Telethon has no native max_date, so we filter in the
        # consume loop (see `date_to_cutoff` below).
        if date_to_str:
            parsed_to = _parse_user_date(date_to_str)
            if parsed_to is None:
                emit({"type": "error",
                      "message": f"Bad --date-to {date_to_str!r}"})
                await client.disconnect()
                return 2
            # End-of-day: user types «до 01.02.26» meaning the whole day,
            # not midnight. Add 86399s only when the value parsed to a date
            # without explicit HH:MM (heuristic: time was zero).
            if parsed_to.hour == 0 and parsed_to.minute == 0:
                parsed_to = parsed_to.replace(hour=23, minute=59, second=59)
            date_to_cutoff = parsed_to
    elif mode == "single":
        if not url:
            emit({"type": "error", "message": "single requires --url"})
            await client.disconnect()
            return 2
        # parse t.me/<chan>/<id>, t.me/<chan>/<topic>/<id>, t.me/c/<internal>/<id>,
        # t.me/c/<internal>/<topic>/<id>. Tail trims `?thread=…`, `?single`,
        # `?comment=…` and trailing slash.
        clean_url = url.split("?", 1)[0].rstrip("/")
        path_segs = clean_url.split("/")
        mid = None
        for seg in reversed(path_segs):
            if seg.isdigit():
                mid = int(seg)
                break
        if mid is None:
            emit({"type": "error", "message": f"Cannot parse message id from {url}"})
            await client.disconnect()
            return 2
        msg = await client.get_messages(entity, ids=mid)
        if not msg:
            emit({"type": "error", "message": "Message not found"})
            await client.disconnect()
            return 2
        topic_id, topic_title = _topic_for(msg)
        msg_type = classify(msg)
        reply_to = _reply_to_for(msg)
        body_text = (msg.text or "")[:8000]
        if msg_type == "poll":
            body_text = render_poll(msg)[:8000] if process_polls else ""
        rx = reactions_for(msg)
        item_data = {
            "id": msg.id,
            "date": msg.date.isoformat() if msg.date else None,
            "type": msg_type,
            "text": body_text,
            "sender": await sender_label(msg),
            "has_media": bool(msg.media),
            "topic_id": topic_id,
            "topic_title": topic_title,
            "parent_external_id": str(reply_to) if reply_to else None,
            "reactions": rx,
        }
        emit({"type": "item", "data": item_data})

        # Single-message: legacy contract was "engine present → transcribe
        # voice/audio only". We preserve that — if process_voice/photo/docs
        # weren't explicitly set, force voice on so old TelegramSingleMessageForm
        # callers don't change behaviour. New callers (TelegramConfigForm,
        # TelegramScreen) pass the flags explicitly.
        if transcribe_engine and not (process_voice or process_photo or process_docs):
            process_voice = True
        await process_media(
            msg, msg_type,
            transcribe_engine=transcribe_engine,
            process_voice=process_voice,
            process_photo=process_photo,
            process_docs=process_docs,
        )

        # ── Single-message comments side-fetch ───────────────────────────
        # Mirrors the channel-mode comments pass below, but scoped to this
        # one msg.id. Without this branch the user sees "0 комментов" even
        # on posts that clearly have a discussion thread — because the main
        # loop never ran, fetched_post_ids stayed empty, and the comments
        # block at the end of run() was a no-op.
        comments_collected = 0
        comments_post_errors = 0
        if include_comments and has_discussion and linked_chat_id is not None \
                and GetDiscussionMessageRequest is not None:
            try:
                linked = await client.get_entity(linked_chat_id)
            except Exception as ex:
                emit({"type": "info",
                      "message": f"linked chat resolve failed: {ex}"})
                linked = None
            if linked is not None:
                try:
                    rows = await _fetch_comments_for_post(
                        client, entity, linked, msg.id,
                        comments_limit, sender_label,
                    )
                except Exception as ex:
                    comments_post_errors += 1
                    emit({"type": "comment_error",
                          "post_id": msg.id, "message": str(ex)})
                    rows = []
                if rows:
                    comments_collected += len(rows)
                    emit({"type": "comments",
                          "post_id":  msg.id,
                          "comments": rows})
                emit({"type": "comments_progress",
                      "posts_done":         1,
                      "posts_total":        1,
                      "comments_collected": comments_collected})

        emit({"type": "done",
              "items_total":          1,
              "comments_collected":   comments_collected,
              "comments_post_errors": comments_post_errors,
              "duration_sec":         round(time.time() - t0, 2)})
        await client.disconnect()
        return 0
    elif mode == "id_list":
        # Explicit persistence hand-off from telegram_live_* MCP tools. Fetch
        # exactly the selected Telegram message ids, emit the same item
        # protocol as an ordinary chat fetch, and let Electron's existing
        # finalizer UPSERT them into library.db. No surrounding history is
        # materialised and media AI remains opt-in through the usual flags.
        if not message_ids:
            emit({"type": "error", "message": "id_list requires --message-ids"})
            await client.disconnect()
            return 2
        saved = 0
        ids = list(dict.fromkeys(int(value) for value in message_ids if int(value) > 0))
        for start in range(0, len(ids), 100):
            chunk = ids[start:start + 100]
            try:
                rows = await client.get_messages(entity, ids=chunk)
            except Exception as ex:
                emit({"type": "error", "message": f"get_messages failed: {ex}"})
                await client.disconnect()
                return 2
            for msg in rows or []:
                if msg is None:
                    continue
                topic_id, topic_title = _topic_for(msg)
                msg_type = classify(msg)
                reply_to = _reply_to_for(msg)
                body_text = (msg.text or "")[:8000]
                if msg_type == "poll":
                    body_text = render_poll(msg)[:8000] if process_polls else ""
                duration = 0
                if msg.media and hasattr(msg.media, "document") and msg.media.document:
                    for attr in msg.media.document.attributes:
                        if hasattr(attr, "duration"):
                            duration = attr.duration
                            break
                emit({
                    "type": "item",
                    "data": {
                        "id": msg.id,
                        "date": msg.date.isoformat() if msg.date else None,
                        "type": msg_type,
                        "text": body_text,
                        "sender": await sender_label(msg),
                        "has_media": bool(msg.media),
                        "duration": duration,
                        "topic_id": topic_id,
                        "topic_title": topic_title,
                        "parent_external_id": str(reply_to) if reply_to else None,
                        "reactions": reactions_for(msg),
                    },
                })
                if process_voice or process_photo or process_docs:
                    await process_media(
                        msg, msg_type,
                        transcribe_engine=transcribe_engine,
                        process_voice=process_voice,
                        process_photo=process_photo,
                        process_docs=process_docs,
                    )
                saved += 1
            emit({"type": "page", "loaded": min(start + len(chunk), len(ids)), "limit": len(ids)})
        if saved == 0:
            emit({"type": "warning", "code": "empty_result", "message": "Выбранные сообщения недоступны или были удалены."})
        emit({
            "type": "done",
            "items_total": saved,
            "duration_sec": round(time.time() - t0, 2),
        })
        await client.disconnect()
        return 0
    elif mode == "media_only":
        # On-demand re-processing of a fixed set of ALREADY-SAVED messages.
        # The desktop user ticked specific voice/photo/doc rows in ChatView
        # and pressed «перевести». We do NOT walk iter_messages — we fetch
        # exactly those msg_ids by id and run process_media() on each, reusing
        # the same media-progress / transcript / photo-text / pdf-text events
        # (each carries msg_id) that batch fetch emits. job-runner stashes the
        # results and replays them into the items' captions via
        # appendItemTranscript on close — identical to the batch path.
        #
        # No skip-processed gate here: the user explicitly asked to (re)process
        # these IDs, possibly with a different engine. That intent is the whole
        # point of the button, so we always process.
        if not media_only_msg_ids:
            emit({"type": "error", "message": "media_only requires --media-only-msg-ids"})
            await client.disconnect()
            return 2
        # get_messages accepts a list of ids and returns them in the same order
        # (None for any id Telegram couldn't return — deleted / out of range).
        try:
            msgs = await client.get_messages(entity, ids=list(media_only_msg_ids))
        except Exception as ex:
            emit({"type": "error", "message": f"get_messages failed: {ex}"})
            await client.disconnect()
            return 2
        processed = 0
        for msg in (msgs or []):
            if msg is None:
                continue
            msg_type = classify(msg)
            try:
                await process_media(
                    msg, msg_type,
                    transcribe_engine=transcribe_engine,
                    process_voice=process_voice,
                    process_photo=process_photo,
                    process_docs=process_docs,
                )
                processed += 1
            except Exception as ex:
                # process_media already emits media-error for its own failures;
                # this catches anything escaping it so one bad msg doesn't abort
                # the whole batch.
                emit({"type": "media-error",
                      "kind": "voice", "msg_id": msg.id, "message": str(ex)})
        emit({"type": "done",
              "items_total":  processed,
              "duration_sec": round(time.time() - t0, 2)})
        await client.disconnect()
        return 0
    else:
        emit({"type": "error", "message": f"Unknown mode: {mode}"})
        await client.disconnect()
        return 2

    count = 0
    PAGE = 100

    # Preview mode aggregates only — no per-item events, no FTS, no DB write.
    type_counts = {}
    sender_counts = {}
    total_voice_seconds = 0
    total_video_seconds = 0
    date_min = None
    date_max = None
    # IDs of fetched posts → fed into the comments-pass below if include_comments=True.
    # In comments_only mode this is pre-populated from CLI args and the
    # iter_messages loop is skipped entirely.
    fetched_post_ids = []
    comments_only = bool(comments_only_post_ids)
    if comments_only:
        fetched_post_ids = list(comments_only_post_ids)
        emit({"type": "info",
              "message": f"comments_only: skipping messages fetch, "
                         f"running comments pass over {len(fetched_post_ids)} posts"})

    if not comments_only:
        # Body of the message-processing loop — extracted because we run it
        # either once (no topic filter) or N times (one per chosen forum
        # topic). `count` is shared across iterations so the page-progress
        # event reflects total fetched, not per-topic.
        nonlocal_count = {"v": 0}

        async def _consume_iter(iter_kwargs):
            nonlocal date_min, date_max, total_voice_seconds, total_video_seconds
            async for msg in client.iter_messages(**iter_kwargs):
                # Upper-bound filter (--date-to). Iteration is reverse=True
                # (oldest → newest), so once a message is past the cutoff
                # everything after it is too — break early.
                if date_to_cutoff is not None and msg.date is not None:
                    msg_naive = msg.date.replace(tzinfo=None)
                    if msg_naive > date_to_cutoff:
                        break

                duration = 0
                if msg.media and hasattr(msg.media, "document") and msg.media.document:
                    for attr in msg.media.document.attributes:
                        if hasattr(attr, "duration"):
                            duration = attr.duration
                            break

                msg_type = classify(msg)

                if preview_only:
                    type_counts[msg_type] = type_counts.get(msg_type, 0) + 1
                    sender = await sender_label(msg) or "(unknown)"
                    sender_counts[sender] = sender_counts.get(sender, 0) + 1
                    if msg.date:
                        ts = msg.date.timestamp()
                        if date_min is None or ts < date_min: date_min = ts
                        if date_max is None or ts > date_max: date_max = ts
                    if msg_type == "voice": total_voice_seconds += duration or 0
                    if msg_type == "video": total_video_seconds += duration or 0
                else:
                    topic_id, topic_title = _topic_for(msg)
                    reply_to = _reply_to_for(msg)
                    body_text = (msg.text or "")[:8000]
                    if msg_type == "poll":
                        body_text = render_poll(msg)[:8000] if process_polls else ""
                    rx = reactions_for(msg)
                    emit({
                        "type": "item",
                        "data": {
                            "id": msg.id,
                            "date": msg.date.isoformat() if msg.date else None,
                            "type": msg_type,
                            "text": body_text,
                            "sender": await sender_label(msg),
                            "has_media": bool(msg.media),
                            "duration": duration,
                            "topic_id": topic_id,
                            "topic_title": topic_title,
                            "parent_external_id": str(reply_to) if reply_to else None,
                            "reactions": rx,
                        }
                    })
                    if process_voice or process_photo or process_docs:
                        await process_media(
                            msg, msg_type,
                            transcribe_engine=transcribe_engine,
                            process_voice=process_voice,
                            process_photo=process_photo,
                            process_docs=process_docs,
                        )
                    if include_comments and has_discussion:
                        fetched_post_ids.append(msg.id)
                nonlocal_count["v"] += 1
                if nonlocal_count["v"] % PAGE == 0:
                    emit({"type": "page", "loaded": nonlocal_count["v"], "limit": limit})

        if topic_ids:
            # Forum topic filter: server-side filtering via reply_to=top_msg_id.
            # We iterate topics sequentially because Telegram floods harder when
            # many GetReplies fire in parallel. Each topic gets its own copy of
            # `kwargs` (we don't want one topic's cursor leaking into another's
            # iter — Telethon mutates internally). Caps from `--limit` apply
            # PER TOPIC, not in total — that matches user expectation
            # ("последние 200 в каждой выбранной теме").
            for tid in topic_ids:
                tkw = dict(kwargs)
                tkw["reply_to"] = int(tid)
                emit({"type": "info",
                      "message": f"topic={tid}: starting iter_messages"})
                try:
                    await _consume_iter(tkw)
                except Exception as ex:
                    emit({"type": "info",
                          "message": f"topic={tid} failed: {type(ex).__name__}: {ex}"})
        else:
            await _consume_iter(kwargs)

        count = nonlocal_count["v"]

    # ── Optional comments pass ───────────────────────────────────────────
    # After main fetch (or directly in comments_only mode), walk fetched
    # posts and pull discussion-thread messages. Sequential — Telegram
    # rate-limits parallel calls hard. Progress: every 10 posts.
    comments_collected = 0
    comments_post_errors = 0
    if (include_comments or comments_only) and has_discussion and fetched_post_ids \
       and not preview_only and GetDiscussionMessageRequest is not None \
       and linked_chat_id is not None:
        try:
            linked = await client.get_entity(linked_chat_id)
        except Exception as ex:
            emit({"type": "info",
                  "message": f"linked chat resolve failed: {ex}"})
            linked = None
        if linked is not None:
            posts_total = len(fetched_post_ids)
            for i, pid in enumerate(fetched_post_ids, 1):
                try:
                    rows = await _fetch_comments_for_post(
                        client, entity, linked, pid,
                        comments_limit, sender_label,
                    )
                except Exception as ex:
                    comments_post_errors += 1
                    emit({"type": "comment_error",
                          "post_id": pid, "message": str(ex)})
                    rows = []
                if rows:
                    comments_collected += len(rows)
                    # Emit as a batched event so the runner can do one
                    # bulkInsertComments per post instead of N inserts.
                    emit({"type": "comments",
                          "post_id":  pid,
                          "comments": rows})
                if i % 10 == 0 or i == posts_total:
                    emit({"type": "comments_progress",
                          "posts_done":         i,
                          "posts_total":        posts_total,
                          "comments_collected": comments_collected})

    if preview_only:
        # Sort senders by count desc, top 10
        top_senders = sorted(sender_counts.items(), key=lambda x: -x[1])[:10]
        emit({
            "type": "preview_summary",
            "items_total":      count,
            "type_counts":      type_counts,
            "senders":          [{"name": n, "count": c} for n, c in top_senders],
            "total_senders":    len(sender_counts),
            "date_min":         date_min,
            "date_max":         date_max,
            "voice_seconds":    total_voice_seconds,
            "video_seconds":    total_video_seconds,
        })

    # ── Empty-result diagnostics ─────────────────────────────────────────
    # A fetch that finishes with 0 items and NO error is the single most
    # confusing outcome in the UI: «готово · 0» with nothing said about why.
    # We emit a non-fatal `warning` so the job carries a plain «ничего не
    # найдено» instead of a mute success.
    #
    # IMPORTANT framing: a 0 here is NEVER «wrong target». Personal chats ARE
    # parseable — iter_messages on a User returns your private DM history with
    # that person. @bakaevvv came back empty simply because that DM history has
    # 0 messages, exactly like an empty channel would. So the message must be
    # neutral («nothing found»), never «this is a personal account, not a
    # channel» — that older wording read as an error the user caused, which it
    # isn't. We only specialise the *hint* (where to look), not the verdict.
    #
    # `code` is a machine token the renderer matches on (never string-matches
    # the Russian text — same contract as the error `code`). Only the real
    # message-fetch path warns; preview / comments-only have their own UIs and
    # a 0 there means something different.
    if not preview_only and not comments_only and count == 0:
        ent_kind = kind_of(entity)
        uname = getattr(entity, "username", None)
        label = ("@" + uname) if uname else title_of(entity)
        if mode == "from_date" and parsed_from_date is not None and parsed_from_date > datetime.now():
            emit({
                "type": "warning",
                "code": "future_date",
                "message": (
                    f"Ничего не найдено: дата начала {parsed_from_date.strftime('%d.%m.%Y')} "
                    f"ещё не наступила (сегодня {datetime.now().strftime('%d.%m.%Y')}). "
                    f"Диапазон из будущего для {label} всегда вернёт 0 сообщений."
                ),
            })
        elif since_msgid and since_msgid > 0:
            emit({
                "type": "warning",
                "code": "no_new_messages",
                "message": (
                    f"Ничего не найдено: 0 новых сообщений с прошлого парсинга "
                    f"(режим «пропускать дубли» тянет только то, что новее "
                    f"id={since_msgid})."
                ),
            })
        elif ent_kind == "user":
            # Neutral verdict + a soft hint that this was a personal dialog,
            # so an empty result is expected when you've never written to them.
            emit({
                "type": "warning",
                "code": "empty_result",
                "message": (
                    f"Ничего не найдено: в личной переписке с {label} нет "
                    f"сообщений."
                ),
            })
        else:
            emit({
                "type": "warning",
                "code": "empty_result",
                "message": (
                    f"Ничего не найдено: {label} не отдал ни одного сообщения "
                    f"(чат пуст, либо выбранные фильтры — тип, дата, тема — "
                    f"всё отсеяли)."
                ),
            })

    emit({
        "type": "done",
        "items_total":         count,
        "comments_collected":  comments_collected,
        "comments_post_errors": comments_post_errors,
        "duration_sec":        round(time.time() - t0, 2),
    })
    await client.disconnect()
    return 0


def main():
    global SESSION_PATH, _SKIP_VOICE, _SKIP_PHOTO, _SKIP_PDF
    parser = argparse.ArgumentParser()
    parser.add_argument("target", nargs="?", default=None,
                        help="@username, chat_id, or URL (omit when --resolve-title)")
    parser.add_argument("--mode", required=False,
                        choices=["last_n", "all", "from_date", "single", "sync_new",
                                 "id_list", "media_only"])
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--date", default=None)
    parser.add_argument("--date-to", default=None,
                        help="Optional upper bound for from_date mode. "
                             "Same formats as --date. End-of-day applied "
                             "when no HH:MM is given.")
    parser.add_argument("--url", default=None)
    parser.add_argument("--since-msgid", type=int, default=0,
                        help="For sync_new: only fetch messages with id > N")
    parser.add_argument("--preview-only", action="store_true",
                        help="Walk the range without emitting items; "
                             "produce one aggregate summary at the end")
    parser.add_argument("--resolve-title", default=None,
                        help="One-shot: list chats whose title equals this string "
                             "(case-insensitive exact). Skips fetch entirely.")
    parser.add_argument("--resolve-fuzzy", action="store_true",
                        help="For --resolve-title, match dialogs whose normalized "
                             "title contains the query instead of exact equality.")
    parser.add_argument("--resolve-limit", type=int, default=50,
                        help="For --resolve-title --resolve-fuzzy, stop after N "
                             "candidates. Default 50.")
    # Single-message voice transcription (mode=single only). Default off
    # → metadata-only fetch (fast). Engine: 'assemblyai' (long-form, robust)
    # or 'gemini' (cheap, chunked).
    parser.add_argument("--transcribe-engine", default=None,
                        choices=["assemblyai", "gemini"],
                        help="Engine for voice/audio/video transcription. "
                             "Without --process-voice this only kicks in for "
                             "single-message mode (legacy compat).")
    parser.add_argument("--transcribe-lang", default="ru")
    # Per-type opt-ins for batch fetches. Single-message mode infers
    # process_voice=True from a bare --transcribe-engine for backwards
    # compatibility with TelegramSingleMessageForm.
    parser.add_argument("--process-voice", action="store_true",
                        help="Transcribe voice/audio/video items via "
                             "--transcribe-engine")
    parser.add_argument("--process-photo", action="store_true",
                        help="Describe photos via Gemini Vision")
    parser.add_argument("--process-docs", action="store_true",
                        help="Extract text from PDFs (and other docs Gemini "
                             "supports) via gemini extract_pdf")
    parser.add_argument("--process-polls", action="store_true",
                        help="Save poll/quiz body (question + options + votes) "
                             "into caption. Without this flag polls land as "
                             "metadata-only rows.")
    parser.add_argument("--skip-processed-file", default=None,
                        help="Path to a JSON file with {voice:[id,...], "
                             "photo:[...], pdf:[...]} of items that already "
                             "have transcribe_status='done' in the desktop DB. "
                             "Matching msg_ids skip download+AI and emit "
                             "media-skipped(reason='already processed').")
    parser.add_argument("--skip-processed-source-id", type=int, default=None,
                        help="Load already-processed media IDs directly from "
                             "library.db inside this subprocess. Preferred by "
                             "Electron because large ID maps never cross main.")
    # Telegram channel comments. include-comments: do a second pass over each
    # fetched post and pull its discussion-thread messages. comments-limit:
    # max comments per post (0 = no limit). comments-only-post-ids: comma-list
    # of channel msg_ids — skip the messages fetch entirely, only do the
    # comments pass over these existing posts.
    parser.add_argument("--topic-ids", default=None,
                        help="Comma-separated forum top_msg_ids; iter_messages "
                             "runs once per topic with reply_to=tid (server-side "
                             "filter). Empty/omitted = full chat.")
    parser.add_argument("--include-comments", action="store_true",
                        help="Also fetch comments for each post via the "
                             "channel's linked discussion group")
    parser.add_argument("--comments-limit", type=int, default=0,
                        help="Max comments per post; 0 = no limit")
    parser.add_argument("--comments-only-post-ids", default=None,
                        help="Comma-separated channel msg_ids; runs only the "
                             "comments pass over these existing posts")
    parser.add_argument("--comments-only-source-id", type=int, default=None,
                        help="Read posts missing comments directly from library.db; "
                             "avoids huge argv/IPC payloads for long channels")
    parser.add_argument("--media-only-msg-ids", default=None,
                        help="Comma-separated msg_ids of ALREADY-SAVED messages "
                             "to (re)process media for on demand (mode=media_only). "
                             "Fetches exactly these by id and runs process_media() "
                             "on each — no iter_messages walk.")
    parser.add_argument("--message-ids", default=None,
                        help="Comma-separated Telegram message ids for mode=id_list. "
                             "Fetches and saves exactly these messages.")
    parser.add_argument("--session", default=None,
                        help="Session name to use (overrides settings.json). "
                             "Electron passes the snapshot taken at job spawn so "
                             "switching the active session mid-job can't retarget "
                             "an in-flight fetch.")
    args = parser.parse_args()

    if args.session:
        SESSION_PATH = _resolve_session_path(args.session)

    # Pre-populate the "already processed" sets from the desktop DB if a file
    # was passed. process_media() will consult these BEFORE downloading and
    # emit media-skipped(reason='already processed') instead of paying the
    # AAI/Gemini round-trip again. Set membership is O(1), so even chats with
    # tens of thousands of saved items don't slow down per-msg checks.
    if args.skip_processed_file:
        try:
            with open(args.skip_processed_file, "r", encoding="utf-8") as f:
                payload = json.load(f) or {}
            def _coerce(v):
                if isinstance(v, dict):
                    return {str(k): str(e or '') for k, e in v.items()}
                if isinstance(v, list):
                    return {str(x): '' for x in v}
                return {}
            _SKIP_VOICE = _coerce(payload.get("voice"))
            _SKIP_PHOTO = _coerce(payload.get("photo"))
            _SKIP_PDF   = _coerce(payload.get("pdf"))
            emit({"type": "info",
                  "message": f"skip-processed loaded: voice={len(_SKIP_VOICE)} "
                             f"photo={len(_SKIP_PHOTO)} pdf={len(_SKIP_PDF)}"})
        except Exception as ex:
            emit({"type": "info",
                  "message": f"skip-processed file unreadable: {ex}"})
    elif args.skip_processed_source_id:
        conn = None
        try:
            conn = open_db()
            payload = processed_external_ids_by_kind(
                conn, args.skip_processed_source_id
            )
            _SKIP_VOICE = payload["voice"]
            _SKIP_PHOTO = payload["photo"]
            _SKIP_PDF = payload["pdf"]
            emit({"type": "info",
                  "message": f"skip-processed loaded from DB: "
                             f"voice={len(_SKIP_VOICE)} "
                             f"photo={len(_SKIP_PHOTO)} pdf={len(_SKIP_PDF)}"})
        except Exception as ex:
            emit({"type": "info",
                  "message": f"skip-processed DB lookup failed: {ex}"})
        finally:
            if conn is not None:
                conn.close()

    try:
        if args.resolve_title is not None:
            rc = asyncio.run(resolve_title(args.resolve_title,
                                           fuzzy=args.resolve_fuzzy,
                                           limit=args.resolve_limit))
            sys.exit(rc)
        if not args.target or not args.mode:
            emit({"type": "error", "message": "target and --mode are required"})
            sys.exit(2)
        post_ids = None
        if args.comments_only_source_id:
            conn = None
            try:
                conn = open_db()
                post_ids = missing_comment_post_ids(conn, args.comments_only_source_id)
                emit({"type": "info", "message": f"comments-only loaded from DB: {len(post_ids)} posts"})
            except Exception as ex:
                emit({"type": "error", "message": f"Cannot read comments-only posts: {ex}"})
                sys.exit(2)
            finally:
                if conn is not None:
                    conn.close()
        elif args.comments_only_post_ids:
            try:
                post_ids = [int(x.strip()) for x in args.comments_only_post_ids.split(",") if x.strip()]
            except Exception as ex:
                emit({"type": "error",
                      "message": f"Bad --comments-only-post-ids: {ex}"})
                sys.exit(2)
        if args.comments_only_source_id and not post_ids:
            emit({"type": "done", "items_total": 0, "comments_collected": 0,
                  "comments_post_errors": 0, "duration_sec": 0})
            sys.exit(0)
        media_msg_ids = None
        if args.media_only_msg_ids:
            try:
                media_msg_ids = [int(x.strip()) for x in args.media_only_msg_ids.split(",") if x.strip()]
            except Exception as ex:
                emit({"type": "error",
                      "message": f"Bad --media-only-msg-ids: {ex}"})
                sys.exit(2)
        selected_message_ids = None
        if args.message_ids:
            try:
                selected_message_ids = [int(x.strip()) for x in args.message_ids.split(",") if x.strip()]
            except Exception as ex:
                emit({"type": "error", "message": f"Bad --message-ids: {ex}"})
                sys.exit(2)
        topic_ids_arg = None
        if args.topic_ids:
            try:
                topic_ids_arg = [int(x.strip()) for x in args.topic_ids.split(",") if x.strip()]
            except Exception as ex:
                emit({"type": "error",
                      "message": f"Bad --topic-ids: {ex}"})
                sys.exit(2)
        rc = asyncio.run(run(args.target, args.mode, args.limit or None,
                             args.date, args.url, args.since_msgid,
                             args.preview_only,
                             transcribe_engine=args.transcribe_engine,
                             transcribe_lang=args.transcribe_lang,
                             process_voice=args.process_voice,
                             process_photo=args.process_photo,
                             process_docs=args.process_docs,
                             process_polls=args.process_polls,
                             include_comments=args.include_comments,
                             comments_limit=args.comments_limit,
                             comments_only_post_ids=post_ids,
                             media_only_msg_ids=media_msg_ids,
                             message_ids=selected_message_ids,
                             topic_ids=topic_ids_arg,
                             date_to_str=args.date_to))
        sys.exit(rc)
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(130)
    except Exception as ex:
        event = {"type": "error", "message": f"{type(ex).__name__}: {ex}"}
        code = _source_unavailable_code(ex)
        if code:
            event["code"] = code
            event["message"] = (
                "Telegram больше не отдаёт этот сохранённый чат выбранному аккаунту. "
                "Он удалён, стал приватным или аккаунт потерял доступ "
                f"({type(ex).__name__}: {ex})."
            )
        emit(event)
        sys.exit(1)


if __name__ == "__main__":
    main()
