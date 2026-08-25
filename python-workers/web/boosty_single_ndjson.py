#!/usr/bin/env python3
"""Download one accessible Boosty video, keep its audio, and transcribe it.

Authentication is supplied by the caller through ``SC_BOOSTY_AUTH_COOKIE``.
Electron and the standalone ``sc -b`` command both obtain it from the user's
live browser session through the SC extension.  It is never written to job
metadata or NDJSON.  A short-lived mode-0600 Netscape cookie file is used only
because yt-dlp's Boosty extractor expects a cookie jar.

Events are deliberately small and contain no signed media URLs:
  auth_ready, metadata, download_progress, download_done,
  transcribe_start, transcribe_progress, transcribe_done, saved, done, error.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path


_REAL_STDOUT = sys.stdout
_ACTIVE_TEMP_DIR = None
_ACTIVE_PROCESS = None


def emit(event):
    _REAL_STDOUT.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    _REAL_STDOUT.flush()


def emit_item(event, context=None):
    payload = dict(event)
    if context:
        payload.update(context)
    emit(payload)


@contextlib.contextmanager
def silenced():
    saved_out, saved_err = sys.stdout, sys.stderr
    try:
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        yield
    finally:
        sys.stdout = saved_out
        sys.stderr = saved_err


def safe_slug(value, max_len=90):
    value = re.sub(r"[^\w\s-]", "", value or "", flags=re.UNICODE).strip()
    value = re.sub(r"\s+", "_", value)
    return value[:max_len] or "boosty_video"


def canonicalize_boosty_url(raw_url):
    """Return canonical post URL plus optional selected player video id.

    Supported inputs:
      /<author>/posts/<post UUID>
      /<author>/purchase/<purchase id>?layer=video:<author>:<post>:<video>
      /<author>?layer=video:<author>:<post>:<video>
    """
    text = str(raw_url or "").strip()
    try:
        parsed = urllib.parse.urlparse(text)
    except Exception as exc:
        raise ValueError("Некорректная ссылка Boosty") from exc

    host = (parsed.hostname or "").lower()
    if host not in {"boosty.to", "www.boosty.to"}:
        raise ValueError("Нужна ссылка с boosty.to")

    layer = urllib.parse.parse_qs(parsed.query).get("layer", [None])[0]
    if layer:
        match = re.fullmatch(
            r"video:([^:]+):([0-9a-fA-F-]{36}):([0-9a-fA-F-]{36})",
            layer,
        )
        if match:
            author, post_id, video_id = match.groups()
            author = urllib.parse.quote(urllib.parse.unquote(author), safe="._-")
            return {
                "canonical_url": f"https://boosty.to/{author}/posts/{post_id.lower()}",
                "author": urllib.parse.unquote(author),
                "post_id": post_id.lower(),
                "video_id": video_id.lower(),
            }

    match = re.fullmatch(
        r"/([^/]+)/posts/([0-9a-fA-F-]{36})/?",
        parsed.path,
    )
    if match:
        author, post_id = match.groups()
        author_decoded = urllib.parse.unquote(author)
        author_quoted = urllib.parse.quote(author_decoded, safe="._-")
        return {
            "canonical_url": f"https://boosty.to/{author_quoted}/posts/{post_id.lower()}",
            "author": author_decoded,
            "post_id": post_id.lower(),
            "video_id": None,
        }

    if "/purchase/" in parsed.path:
        raise ValueError("В purchase-ссылке нет параметра layer с ID видео")
    raise ValueError("Нужна ссылка на пост Boosty или на покупку конкретного видео")


def redact_error(message):
    text = str(message or "")
    text = re.sub(r"https?://[^\s]+", "[url]", text)
    return text[-1200:]


def write_cookie_file(directory, cookie_value, expiration=None):
    expiry = int(expiration or (time.time() + 86400))
    path = Path(directory) / "boosty-cookies.txt"
    line = ".boosty.to\tTRUE\t/\tTRUE\t{}\tauth\t{}\n".format(
        expiry,
        str(cookie_value).replace("\r", "").replace("\n", ""),
    )
    path.write_text("# Netscape HTTP Cookie File\n" + line, encoding="utf-8")
    os.chmod(path, 0o600)
    return path


def select_videos(info, requested_video_id):
    entries = [entry for entry in (info.get("entries") or []) if entry]
    if not entries:
        return [(info, 1, 1)]
    if requested_video_id:
        for index, entry in enumerate(entries, start=1):
            if str(entry.get("id") or "").lower() == requested_video_id.lower():
                return [(entry, index, len(entries))]
        raise RuntimeError("Указанное видео не найдено внутри поста Boosty")
    return [
        (entry, index, len(entries))
        for index, entry in enumerate(entries, start=1)
    ]


def describe_video(canonical, info, selected, playlist_index, playlist_count):
    video_id = str(selected.get("id") or canonical.get("video_id") or canonical["post_id"])
    title = str(selected.get("title") or info.get("title") or "Boosty video")
    uploader = str(
        selected.get("uploader")
        or selected.get("channel")
        or info.get("uploader")
        or canonical["author"]
    )
    duration = selected.get("duration") or info.get("duration") or 0
    return {
        "canonical_url": canonical["canonical_url"],
        "post_id": canonical["post_id"],
        "video_id": video_id,
        "title": title,
        "author": uploader,
        "author_handle": canonical["author"],
        "duration_sec": int(round(float(duration or 0))),
        "thumbnail": selected.get("thumbnail") or info.get("thumbnail") or None,
        "playlist_index": playlist_index,
        "playlist_count": playlist_count,
    }


def yt_dlp_binary():
    executable = shutil.which("yt-dlp")
    if not executable:
        raise RuntimeError("yt-dlp не найден. Установите его через brew install yt-dlp")
    return executable


def load_metadata(canonical_url, cookie_path):
    result = subprocess.run(
        [
            yt_dlp_binary(),
            "--cookies", str(cookie_path),
            "--dump-single-json",
            "--skip-download",
            "--no-warnings",
            "--no-color",
            canonical_url,
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"yt-dlp exited {result.returncode}"
        raise RuntimeError(redact_error(detail))
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("yt-dlp вернул некорректную метадату Boosty") from exc


def optional_number(value, *, integer=False):
    if value in (None, "", "NA", "N/A", "null", "None"):
        return None
    try:
        number = float(value)
        return int(number) if integer else number
    except (TypeError, ValueError):
        return None


def _move_finished_file(source, target):
    """Move a completed file atomically, including across mounted volumes."""
    source = Path(source)
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(source, target)
        return target
    except OSError:
        temporary = target.with_name(target.name + ".part")
        temporary.unlink(missing_ok=True)
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
        source.unlink(missing_ok=True)
        return target


def _existing_video_path(video_root, canonical, descriptor):
    if not video_root:
        return None
    directory = Path(video_root) / safe_slug(canonical["author"], 60) / canonical["post_id"]
    stem = f"{safe_slug(descriptor['video_id'], 50)}__{safe_slug(descriptor['title'])}"
    candidates = sorted(
        (
            path for path in directory.glob(stem + ".*")
            if path.is_file()
            and path.stat().st_size > 0
            and path.suffix.lower() not in {".mp3", ".srt", ".txt", ".part", ".ytdl"}
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def _extract_audio(video_path, audio_path):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg не найден — не удалось извлечь MP3 из видео")
    audio_path = Path(audio_path)
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = audio_path.with_name(audio_path.stem + ".part.mp3")
    temporary.unlink(missing_ok=True)
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video_path), "-vn", "-codec:a", "libmp3lame",
        "-b:a", "96k", str(temporary),
    ]
    global _ACTIVE_PROCESS
    process = subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    _ACTIVE_PROCESS = process
    try:
        _stdout, stderr = process.communicate()
    finally:
        _ACTIVE_PROCESS = None
    if process.returncode != 0 or not temporary.is_file() or temporary.stat().st_size <= 0:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(redact_error((stderr or "ffmpeg не создал MP3").strip()))
    os.replace(temporary, audio_path)
    return audio_path


def download_audio(
    canonical,
    descriptor,
    media_root,
    cookie_path,
    work_dir,
    item_context=None,
    force_download=False,
    save_video=False,
    video_root=None,
):
    video_id = descriptor["video_id"]
    title = descriptor["title"]
    uploader = descriptor["author"]
    duration = descriptor["duration_sec"]
    thumbnail = descriptor["thumbnail"]
    playlist_index = descriptor["playlist_index"]
    playlist_count = descriptor["playlist_count"]

    emit_item({"type": "metadata", **descriptor}, item_context)

    final_dir = Path(media_root) / safe_slug(canonical["author"], 60) / canonical["post_id"]
    final_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{safe_slug(video_id, 50)}__{safe_slug(title)}"
    final_audio_path = final_dir / (stem + ".mp3")
    existing_video = None if force_download else _existing_video_path(video_root, canonical, descriptor)
    audio_ready = not force_download and final_audio_path.is_file() and final_audio_path.stat().st_size > 0
    video_ready = not save_video or existing_video is not None
    if audio_ready and video_ready:
        emit_item({
            "type": "download_done",
            "audio_path": str(final_audio_path),
            "audio_bytes": final_audio_path.stat().st_size,
            "video_path": str(existing_video) if existing_video else None,
            "video_bytes": existing_video.stat().st_size if existing_video else None,
            "duration_sec": int(round(float(duration or 0))),
            "reused": True,
        }, item_context)
        return {
            "audio_path": final_audio_path,
            "audio_bytes": final_audio_path.stat().st_size,
            "duration_sec": int(round(float(duration or 0))),
            "video_id": video_id,
            "title": title,
            "author": uploader,
            "thumbnail": thumbnail,
            "reused": True,
            "video_path": existing_video,
            "video_bytes": existing_video.stat().st_size if existing_video else None,
        }

    if save_video and existing_video is not None and not audio_ready:
        emit_item({"type": "download_processing"}, item_context)
        _extract_audio(existing_video, final_audio_path)
        emit_item({
            "type": "download_done",
            "audio_path": str(final_audio_path),
            "audio_bytes": final_audio_path.stat().st_size,
            "video_path": str(existing_video),
            "video_bytes": existing_video.stat().st_size,
            "duration_sec": int(round(float(duration or 0))),
            "reused": True,
        }, item_context)
        return {
            "audio_path": final_audio_path,
            "audio_bytes": final_audio_path.stat().st_size,
            "duration_sec": int(round(float(duration or 0))),
            "video_id": video_id,
            "title": title,
            "author": uploader,
            "thumbnail": thumbnail,
            "reused": True,
            "video_path": existing_video,
            "video_bytes": existing_video.stat().st_size,
        }

    staging_dir = Path(work_dir) / "download"
    staging_dir.mkdir(parents=True, exist_ok=True)
    outtmpl = str(staging_dir / (stem + ".%(ext)s"))
    progress_template = (
        "download:__SC_PROGRESS__%(progress.downloaded_bytes)s|"
        "%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|"
        "%(progress.speed)s|%(progress.eta)s|"
        "%(progress.fragment_index)s|%(progress.fragment_count)s"
    )
    command = [
        yt_dlp_binary(),
        "--cookies", str(cookie_path),
        "--output", outtmpl,
        "--force-overwrites",
        "--newline",
        "--quiet",
        "--progress",
        "--no-warnings",
        "--no-color",
        "--progress-template", progress_template,
        "--print", "after_move:__SC_FILE__%(filepath)s",
    ]
    if save_video:
        command.extend([
            "--format", (
                "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/"
                "best[height<=1080][ext=mp4]/"
                "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"
            ),
            "--merge-output-format", "mp4",
        ])
    else:
        command.extend([
            "--format", "bestaudio/best",
            "--extract-audio",
            "--audio-format", "mp3",
            "--audio-quality", "96K",
        ])
    if playlist_count > 1:
        command.extend(["--playlist-items", str(playlist_index)])
    command.append(canonical["canonical_url"])

    global _ACTIVE_PROCESS
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    _ACTIVE_PROCESS = process
    last_emit = 0.0
    reported_path = None
    stderr_text = ""
    try:
        for raw_line in process.stdout:
            line = raw_line.strip()
            if line.startswith("__SC_FILE__"):
                reported_path = line[len("__SC_FILE__"):].strip()
                continue
            marker = "__SC_PROGRESS__"
            if marker not in line:
                continue
            fields = line.split(marker, 1)[1].split("|")
            if len(fields) < 7:
                continue
            now = time.monotonic()
            if now - last_emit < 0.25:
                continue
            last_emit = now
            downloaded = optional_number(fields[0], integer=True) or 0
            total = optional_number(fields[1], integer=True) or optional_number(fields[2], integer=True)
            speed = optional_number(fields[3], integer=True)
            eta = optional_number(fields[4], integer=True)
            fragment_index = optional_number(fields[5], integer=True)
            fragment_count = optional_number(fields[6], integer=True)
            percent = round(downloaded * 100 / total, 1) if total and total > 0 else None
            emit_item({
                "type": "download_progress",
                "downloaded_bytes": downloaded,
                "total_bytes": total,
                "percent": percent,
                "speed_bps": speed,
                "eta_sec": eta,
                "fragment_index": fragment_index,
                "fragment_count": fragment_count,
            }, item_context)
        if process.stderr:
            stderr_text = process.stderr.read()
        code = process.wait()
    finally:
        _ACTIVE_PROCESS = None
    if code != 0:
        raise RuntimeError(redact_error(stderr_text.strip() or f"yt-dlp exited {code}"))
    emit_item({"type": "download_processing"}, item_context)

    downloaded_path = Path(reported_path) if reported_path else staging_dir / (stem + ".mp3")
    if not downloaded_path.exists():
        candidates = sorted(staging_dir.glob(stem + ".*"), key=lambda p: p.stat().st_mtime, reverse=True)
        downloaded_path = next((p for p in candidates if p.is_file() and not p.name.endswith(".part")), None)
    if not downloaded_path or not Path(downloaded_path).exists():
        raise RuntimeError("yt-dlp завершился без готового медиафайла")

    downloaded_path = Path(downloaded_path)
    video_path = existing_video
    if save_video:
        video_dir = Path(video_root) / safe_slug(canonical["author"], 60) / canonical["post_id"]
        video_suffix = downloaded_path.suffix.lower() or ".mp4"
        video_path = _move_finished_file(downloaded_path, video_dir / (stem + video_suffix))
        if not audio_ready:
            _extract_audio(video_path, final_audio_path)
    else:
        final_audio_path = final_dir / (stem + downloaded_path.suffix.lower())
        _move_finished_file(downloaded_path, final_audio_path)

    audio_path = final_audio_path
    emit_item({
        "type": "download_done",
        "audio_path": str(audio_path),
        "audio_bytes": audio_path.stat().st_size,
        "video_path": str(video_path) if video_path else None,
        "video_bytes": video_path.stat().st_size if video_path else None,
        "duration_sec": int(round(float(duration or 0))),
    }, item_context)
    return {
        "audio_path": audio_path,
        "audio_bytes": audio_path.stat().st_size,
        "duration_sec": int(round(float(duration or 0))),
        "video_id": video_id,
        "title": title,
        "author": uploader,
        "thumbnail": thumbnail,
        "reused": False,
        "video_path": video_path,
        "video_bytes": video_path.stat().st_size if video_path else None,
    }


def transcribe_assemblyai(audio_path, item_context=None):
    key = (os.environ.get("ASSEMBLYAI_API_KEY") or "").strip()
    if not key:
        # Direct Python/CLI launches do not pass through Electron's worker env,
        # so use the same shared settings file as the rest of the SC runtime.
        workers_root = str(Path(__file__).resolve().parents[1])
        if workers_root not in sys.path:
            sys.path.insert(0, workers_root)
        try:
            from shared.settings import get_api_key
            key = (get_api_key("ASSEMBLYAI_API_KEY") or "").strip()
        except Exception:
            key = ""
    if not key:
        raise RuntimeError("ASSEMBLYAI_API_KEY не настроен")
    try:
        import assemblyai as aai
        from assemblyai import api as aai_api
    except ImportError as exc:
        raise RuntimeError("assemblyai package не установлен") from exc

    aai.settings.api_key = key
    aai.settings.http_timeout = 600.0
    aai.settings.polling_interval = 5.0
    config = aai.TranscriptionConfig(language_detection=True)
    config.speech_models = ["universal-2"]
    transcriber = aai.Transcriber()

    emit_item({"type": "transcribe_start", "engine": "assemblyai"}, item_context)
    emit_item(
        {"type": "transcribe_progress", "engine": "assemblyai", "stage": "uploading"},
        item_context,
    )
    transcript = transcriber.submit(str(audio_path), config=config)
    audio_duration_sec = None
    try:
        if transcript.audio_duration:
            audio_duration_sec = round(transcript.audio_duration / 1000.0, 1)
    except Exception:
        pass
    emit_item({
        "type": "transcribe_progress",
        "engine": "assemblyai",
        "stage": "queued",
        "transcript_id": transcript.id,
        "audio_duration_sec": audio_duration_sec,
    }, item_context)
    started = time.time()
    transcript_client = transcript._client
    while True:
        # Transcript.get_by_id() sounds like a single fetch but the SDK
        # actually blocks and polls until completion. Fetch one response
        # ourselves so callers receive real queued/processing progress.
        response = aai_api.get_transcript(
            client=transcript_client.http_client,
            transcript_id=transcript.id,
        )
        transcript = aai.Transcript.from_response(
            client=transcript_client,
            response=response,
        )
        if transcript.status == aai.TranscriptStatus.completed:
            emit_item(
                {"type": "transcribe_progress", "engine": "assemblyai", "stage": "completed"},
                item_context,
            )
            break
        if transcript.status == aai.TranscriptStatus.error:
            raise RuntimeError("AssemblyAI: " + str(transcript.error or "ошибка транскрибации"))
        raw_status = str(transcript.status)
        status = raw_status.split(".")[-1].lower() if "." in raw_status else raw_status
        emit_item({
            "type": "transcribe_progress",
            "engine": "assemblyai",
            "stage": "transcribing",
            "aai_status": status,
            "elapsed_sec": int(time.time() - started),
            "audio_duration_sec": audio_duration_sec,
        }, item_context)
        time.sleep(2)

    text = (transcript.text or "").strip()
    if not text:
        raise RuntimeError("AssemblyAI вернул пустой текст")
    try:
        srt = transcript.export_subtitles_srt()
    except Exception:
        srt = None
    emit_item(
        {"type": "transcribe_done", "engine": "assemblyai", "chars": len(text), "cost_usd": 0},
        item_context,
    )
    return text, srt


def result_paths(transcript_root, canonical, media):
    out_dir = Path(transcript_root) / safe_slug(canonical["author"], 60)
    stem = f"{canonical['post_id']}__{safe_slug(media['video_id'], 50)}__{safe_slug(media['title'])}"
    return out_dir / (stem + ".txt"), out_dir / (stem + ".srt")


def completed_result(media_root, transcript_root, canonical, descriptor, video_root=None, require_video=False):
    media_dir = Path(media_root) / safe_slug(canonical["author"], 60) / canonical["post_id"]
    audio_stem = f"{safe_slug(descriptor['video_id'], 50)}__{safe_slug(descriptor['title'])}"
    audio_path = media_dir / (audio_stem + ".mp3")
    text_path, srt_path = result_paths(transcript_root, canonical, descriptor)
    paths = (audio_path, text_path, srt_path)
    if not all(path.is_file() and path.stat().st_size > 0 for path in paths):
        return None
    video_path = _existing_video_path(video_root, canonical, descriptor)
    if require_video and video_path is None:
        return None
    try:
        chars = len(text_path.read_text(encoding="utf-8"))
    except Exception:
        chars = 0
    return {
        "file_path": str(text_path),
        "srt_path": str(srt_path),
        "audio_path": str(audio_path),
        "audio_bytes": audio_path.stat().st_size,
        "video_path": str(video_path) if video_path else None,
        "video_bytes": video_path.stat().st_size if video_path else None,
        "duration_sec": descriptor["duration_sec"],
        "chars": chars,
        "kind": "cached",
        "cached": True,
        "video_id": descriptor["video_id"],
        "title": descriptor["title"],
    }


def write_results(transcript_root, canonical, media, text, srt):
    text_path, expected_srt_path = result_paths(transcript_root, canonical, media)
    text_path.parent.mkdir(parents=True, exist_ok=True)
    header = [
        f"# {media['title']}",
        f"author: {media['author']}",
        f"url: {canonical['canonical_url']}",
        "source: boosty",
        "transcription: assemblyai",
    ]
    text_path.write_text("\n".join(header) + "\n\n" + text, encoding="utf-8")
    srt_path = None
    if srt:
        srt_path = expected_srt_path
        srt_path.write_text(srt, encoding="utf-8")
    return text_path, srt_path


def _handle_signal(_signum, _frame):
    process = _ACTIVE_PROCESS
    if process and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except Exception:
            try:
                process.terminate()
            except Exception:
                pass
    raise KeyboardInterrupt()


def load_selection_groups(file_path):
    try:
        payload = json.loads(Path(file_path).read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError("Не удалось прочитать список видео Boosty") from exc
    rows = payload.get("items") if isinstance(payload, dict) else payload
    if not isinstance(rows, list) or not rows:
        raise ValueError("Список видео Boosty пуст")
    groups = {}
    for row in rows:
        if not isinstance(row, dict) or not row.get("url"):
            raise ValueError("В списке Boosty есть видео без ссылки на пост")
        canonical = canonicalize_boosty_url(row["url"])
        video_id = row.get("video_id") or canonical.get("video_id")
        request = {
            "video_id": str(video_id).lower() if video_id else None,
            "position": int(row["position"]) if row.get("position") else None,
            "title": row.get("title") or None,
            "audio_path": row.get("audio_path") or None,
            "video_path": row.get("video_path") or None,
            "duration_sec": row.get("duration_sec") or None,
            "author": row.get("author") or canonical.get("author"),
        }
        key = canonical["canonical_url"]
        if key not in groups:
            groups[key] = {"canonical": canonical, "requests": []}
        groups[key]["requests"].append(request)
    return list(groups.values())


def select_requested_videos(info, requests):
    entries = [entry for entry in (info.get("entries") or []) if entry]
    if not entries:
        entries = [info]
    if not requests or any(not r.get("video_id") and not r.get("position") for r in requests):
        return [(entry, index, len(entries)) for index, entry in enumerate(entries, start=1)], []

    selected = []
    errors = []
    used = set()
    for request in requests:
        match = None
        match_index = None
        requested_id = str(request.get("video_id") or "").lower()
        if requested_id:
            for index, entry in enumerate(entries, start=1):
                if str(entry.get("id") or "").lower() == requested_id:
                    match, match_index = entry, index
                    break
        position = request.get("position")
        if match is None and position and 1 <= int(position) <= len(entries):
            match_index = int(position)
            match = entries[match_index - 1]
        if match is None:
            errors.append({
                "video_id": requested_id or None,
                "title": request.get("title") or "Видео Boosty",
                "message": "Выбранное видео больше не найдено внутри поста Boosty",
            })
            continue
        identity = str(match.get("id") or match_index)
        if identity in used:
            continue
        used.add(identity)
        selected.append((match, match_index, len(entries)))
    return selected, errors


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("url", nargs="?")
    parser.add_argument("--media-dir", required=True)
    parser.add_argument("--transcript-dir", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--selection-file", help=argparse.SUPPRESS)
    parser.add_argument("--download-only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--save-video", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--video-dir", help=argparse.SUPPRESS)
    parser.add_argument("--force-download", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--metadata-only", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.save_video and not args.video_dir:
        raise ValueError("Для сохранения видео нужна --video-dir")

    started = time.time()
    if not args.url and not args.selection_file:
        raise ValueError("Нужна ссылка Boosty или список выбранных видео")
    if args.selection_file:
        groups = load_selection_groups(args.selection_file)
    else:
        canonical = canonicalize_boosty_url(args.url)
        groups = [{
            "canonical": canonical,
            "requests": [{"video_id": canonical.get("video_id"), "position": None, "title": None}],
        }]
    cookie = (os.environ.get("SC_BOOSTY_AUTH_COOKIE") or "").strip()
    if not cookie:
        emit({"type": "error", "code": "boosty_auth_missing", "message": "Не найдена авторизация Boosty в браузере"})
        return 3

    expiration = os.environ.get("SC_BOOSTY_AUTH_EXPIRES")
    Path(args.work_dir).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="boosty-", dir=args.work_dir) as temp_dir:
        global _ACTIVE_TEMP_DIR
        _ACTIVE_TEMP_DIR = temp_dir
        cookie_path = write_cookie_file(temp_dir, cookie, expiration)
        emit({"type": "auth_ready"})
        try:
            plan = []
            for group in groups:
                canonical = group["canonical"]
                requests = group["requests"]
                local_requests = [
                    request for request in requests
                    if request.get("audio_path")
                    and Path(request["audio_path"]).is_file()
                    and Path(request["audio_path"]).stat().st_size > 0
                    and (
                        not args.save_video
                        or (
                            request.get("video_path")
                            and Path(request["video_path"]).is_file()
                            and Path(request["video_path"]).stat().st_size > 0
                        )
                    )
                ]
                remote_requests = [request for request in requests if request not in local_requests]
                for request in local_requests:
                    selected = {
                        "id": request.get("video_id"),
                        "title": request.get("title") or "Видео Boosty",
                        "duration": request.get("duration_sec") or 0,
                        "uploader": request.get("author") or canonical.get("author"),
                    }
                    plan.append({
                        "canonical": canonical,
                        "info": selected,
                        "selected": selected,
                        "playlist_index": request.get("position") or 1,
                        "playlist_count": max(1, len(requests)),
                        "existing_audio_path": request.get("audio_path"),
                        "existing_video_path": request.get("video_path"),
                    })
                if not remote_requests:
                    continue
                try:
                    info = load_metadata(canonical["canonical_url"], cookie_path)
                    selections, selection_errors = select_requested_videos(info, remote_requests)
                    for selected, playlist_index, playlist_count in selections:
                        plan.append({
                            "canonical": canonical,
                            "info": info,
                            "selected": selected,
                            "playlist_index": playlist_index,
                            "playlist_count": playlist_count,
                        })
                    for failure in selection_errors:
                        plan.append({"canonical": canonical, "error": failure})
                except Exception as metadata_exc:
                    message = redact_error(metadata_exc)
                    error_requests = remote_requests or [{"video_id": None, "title": None}]
                    for request in error_requests:
                        plan.append({
                            "canonical": canonical,
                            "error": {
                                "video_id": request.get("video_id"),
                                "title": request.get("title") or "Видео Boosty",
                                "message": message,
                            },
                        })

            items_total = len(plan)
            emit({
                "type": "batch_start",
                "items_total": items_total,
                "posts_total": len(groups),
                "mode": "batch" if args.selection_file else (
                    "single" if groups[0]["canonical"].get("video_id") else "post"
                ),
                "download_only": args.download_only,
            })

            if args.metadata_only:
                # Kept for non-billing integration checks. The normal desktop
                # route never passes this flag.
                for item_index, item in enumerate(plan, start=1):
                    if item.get("error"):
                        failure = item["error"]
                        emit_item({
                            "type": "item_error",
                            "title": failure.get("title"),
                            "message": failure.get("message"),
                        }, {
                            "item_index": item_index,
                            "items_total": items_total,
                            "video_id": failure.get("video_id"),
                        })
                        continue
                    descriptor = describe_video(
                        item["canonical"], item["info"], item["selected"],
                        item["playlist_index"], item["playlist_count"],
                    )
                    context = {
                        "item_index": item_index,
                        "items_total": items_total,
                        "video_id": descriptor["video_id"],
                    }
                    emit_item({
                        "type": "item_start",
                        "title": descriptor["title"],
                        "duration_sec": descriptor["duration_sec"],
                    }, context)
                    emit_item({"type": "metadata", **descriptor}, context)
                    emit_item({"type": "item_done", "metadata_only": True}, context)
                emit({
                    "type": "done",
                    "metadata_only": True,
                    "items_total": items_total,
                    "items_done": items_total,
                    "duration_sec": round(time.time() - started, 2),
                })
                return 0

            saved_results = []
            item_errors = []
            cached_items = 0
            for item_index, item in enumerate(plan, start=1):
                if item.get("error"):
                    failure = item["error"]
                    context = {
                        "item_index": item_index,
                        "items_total": items_total,
                        "video_id": failure.get("video_id"),
                    }
                    item_errors.append({**context, "message": failure.get("message")})
                    emit_item({
                        "type": "item_error",
                        "title": failure.get("title"),
                        "message": failure.get("message"),
                    }, context)
                    continue
                canonical = item["canonical"]
                descriptor = describe_video(
                    canonical, item["info"], item["selected"],
                    item["playlist_index"], item["playlist_count"],
                )
                context = {
                    "item_index": item_index,
                    "items_total": items_total,
                    "video_id": descriptor["video_id"],
                }
                emit_item({
                    "type": "item_start",
                    "title": descriptor["title"],
                    "duration_sec": descriptor["duration_sec"],
                }, context)

                existing = None if args.force_download else completed_result(
                    args.media_dir,
                    args.transcript_dir,
                    canonical,
                    descriptor,
                    video_root=args.video_dir,
                    require_video=args.save_video,
                )
                if existing:
                    emit_item({"type": "metadata", **descriptor}, context)
                    emit_item({
                        "type": "item_cached",
                        "title": descriptor["title"],
                        "audio_bytes": existing["audio_bytes"],
                    }, context)
                    emit_item({"type": "saved", **existing}, context)
                    emit_item({"type": "item_done", "cached": True}, context)
                    saved_results.append(existing)
                    cached_items += 1
                    continue

                try:
                    if item.get("existing_audio_path"):
                        audio_path = Path(item["existing_audio_path"])
                        emit_item({"type": "metadata", **descriptor}, context)
                        emit_item({
                            "type": "download_done",
                            "audio_path": str(audio_path),
                            "audio_bytes": audio_path.stat().st_size,
                            "duration_sec": descriptor["duration_sec"],
                            "reused": True,
                        }, context)
                        media = {
                            "audio_path": audio_path,
                            "audio_bytes": audio_path.stat().st_size,
                            "duration_sec": descriptor["duration_sec"],
                            "video_id": descriptor["video_id"],
                            "title": descriptor["title"],
                            "author": descriptor["author"],
                            "thumbnail": descriptor["thumbnail"],
                            "reused": True,
                            "video_path": Path(item["existing_video_path"]) if item.get("existing_video_path") else None,
                            "video_bytes": Path(item["existing_video_path"]).stat().st_size if item.get("existing_video_path") else None,
                        }
                    else:
                        media = download_audio(
                            canonical,
                            descriptor,
                            args.media_dir,
                            cookie_path,
                            temp_dir,
                            item_context=context,
                            force_download=args.force_download,
                            save_video=args.save_video,
                            video_root=args.video_dir,
                        )
                    if args.download_only:
                        saved = {
                            "audio_path": str(media["audio_path"]),
                            "audio_bytes": media["audio_bytes"],
                            "video_path": str(media["video_path"]) if media.get("video_path") else None,
                            "video_bytes": media.get("video_bytes"),
                            "duration_sec": media["duration_sec"],
                            "video_id": media["video_id"],
                            "title": media["title"],
                            "cached": bool(media.get("reused")),
                        }
                        emit_item({"type": "audio_saved", **saved}, context)
                        emit_item({"type": "item_done", **saved}, context)
                        saved_results.append(saved)
                        if media.get("reused"):
                            cached_items += 1
                        continue
                    text, srt = transcribe_assemblyai(
                        media["audio_path"],
                        item_context=context,
                    )
                    text_path, srt_path = write_results(
                        args.transcript_dir,
                        canonical,
                        media,
                        text,
                        srt,
                    )
                    saved = {
                        "file_path": str(text_path),
                        "srt_path": str(srt_path) if srt_path else None,
                        "audio_path": str(media["audio_path"]),
                        "audio_bytes": media["audio_bytes"],
                        "video_path": str(media["video_path"]) if media.get("video_path") else None,
                        "video_bytes": media.get("video_bytes"),
                        "duration_sec": media["duration_sec"],
                        "chars": len(text),
                        "kind": "ai",
                        "cached": False,
                        "video_id": media["video_id"],
                        "title": media["title"],
                    }
                    emit_item({"type": "saved", **saved}, context)
                    emit_item({"type": "item_done", "cached": False}, context)
                    saved_results.append(saved)
                except Exception as item_exc:
                    message = redact_error(item_exc)
                    item_errors.append({
                        "item_index": item_index,
                        "video_id": descriptor["video_id"],
                        "message": message,
                    })
                    emit_item({
                        "type": "item_error",
                        "title": descriptor["title"],
                        "message": message,
                    }, context)

            if item_errors and (not args.selection_file or not saved_results):
                first_error = item_errors[0]["message"]
                emit({
                    "type": "error",
                    "code": "boosty_partial_failed" if saved_results else "boosty_failed",
                    "message": (
                        f"Не удалось обработать {len(item_errors)} из {items_total} видео: "
                        f"{first_error}"
                    ),
                    "items_total": items_total,
                    "items_done": len(saved_results),
                    "items_failed": len(item_errors),
                })
                return 4

            emit({
                "type": "done",
                "items_total": items_total,
                "items_done": len(saved_results),
                "items_failed": len(item_errors),
                "cached_items": cached_items,
                "download_only": args.download_only,
                "duration_sec": round(time.time() - started, 2),
            })
            return 0
        except Exception as exc:
            message = redact_error(exc)
            lower = message.lower()
            code = "boosty_access_required" if (
                "requires a subscription" in lower
                or "login required" in lower
                or "subscription" in lower
                or "доступ" in lower
            ) else "boosty_failed"
            emit({"type": "error", "code": code, "message": message})
            return 4
        finally:
            _ACTIVE_TEMP_DIR = None


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        emit({"type": "error", "code": "cancelled", "message": "Остановлено пользователем"})
        sys.exit(130)
    except Exception as exc:
        emit({"type": "error", "code": "boosty_failed", "message": redact_error(exc)})
        sys.exit(1)
