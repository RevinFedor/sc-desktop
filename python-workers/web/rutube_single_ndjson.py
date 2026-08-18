#!/usr/bin/env python3
"""One-shot Rutube transcript worker.

Stage 1 checks Rutube/yt-dlp subtitles and exits without spending money when
they are missing. Stage 2 is started explicitly with --ai and downloads the
lowest-bandwidth playable stream before sending its audio to the selected
transcription provider.

Stdout is NDJSON only. Human-readable diagnostics belong on stderr.
"""

from __future__ import annotations

import argparse
import html
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


SHARED_DIR = Path(__file__).resolve().parents[1] / "shared"
if str(SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(SHARED_DIR))


RUTUBE_ID_RE = re.compile(
    r"https?://(?:www\.)?rutube\.ru/"
    r"(?:(?:live/)?video(?:/private)?|(?:play/)?embed)/"
    r"(?P<id>[0-9a-z]{32})(?:[/?#]|$)",
    re.IGNORECASE,
)


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class silenced:
    """Keep libraries and provider SDKs from corrupting the NDJSON stream."""

    def __enter__(self):
        self.stdout = sys.stdout
        self.stderr = sys.stderr
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        return self

    def __exit__(self, *_args):
        sys.stdout = self.stdout
        sys.stderr = self.stderr


def extract_rutube_id(url: str) -> str | None:
    match = RUTUBE_ID_RE.search(str(url or "").strip())
    return match.group("id").lower() if match else None


def _run(command: list[str], timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )


def fetch_metadata(url: str, attempts: int = 3) -> tuple[dict | None, str | None]:
    command = [
        "yt-dlp",
        "--no-update",
        "--dump-single-json",
        "--no-playlist",
        "--skip-download",
        "--no-warnings",
        url,
    ]
    last_error = "unknown error"
    for attempt in range(max(1, attempts)):
        if attempt:
            time.sleep(0.8 * attempt)
        try:
            result = _run(command, timeout=60)
        except subprocess.TimeoutExpired:
            last_error = "yt-dlp timeout (>60s)"
            continue
        except Exception as exc:  # pragma: no cover - defensive process edge
            last_error = f"{type(exc).__name__}: {exc}"
            continue
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").strip()
            last_error = f"yt-dlp exit {result.returncode}: {tail[-300:]}"
            continue
        first_line = (result.stdout or "").strip().splitlines()
        if not first_line:
            last_error = "yt-dlp returned empty metadata"
            continue
        try:
            raw = json.loads(first_line[0])
        except json.JSONDecodeError as exc:
            last_error = f"invalid yt-dlp JSON: {exc}"
            continue
        return {
            "id": str(raw.get("id") or extract_rutube_id(url) or ""),
            "title": raw.get("title") or "Видео Rutube",
            "duration_sec": int(raw.get("duration") or 0),
            "channel": raw.get("channel") or raw.get("uploader") or "",
            "webpage_url": raw.get("webpage_url") or url,
            "thumbnail_url": raw.get("thumbnail") or None,
        }, None
    return None, last_error


def clean_srt(content: str, with_timestamps: bool = False) -> str:
    """Convert ordinary or auto-generated SRT into compact readable text."""
    result: list[str] = []
    normalized = str(content or "").replace("\r\n", "\n").replace("\r", "\n")
    for block in re.split(r"\n\s*\n", normalized):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        if lines[0].isdigit():
            lines = lines[1:]
        if not lines:
            continue
        timing = lines[0] if "-->" in lines[0] else None
        if timing:
            lines = lines[1:]
        if not lines:
            continue
        text = " ".join(lines)
        text = html.unescape(re.sub(r"<[^>]+>", "", text)).strip()
        text = re.sub(r"\s+", " ", text)
        if not text:
            continue
        if with_timestamps and timing:
            start = timing.split("-->", 1)[0].strip().replace(",", ".")
            start = start.split(".", 1)[0]
            line = f"[{start}] {text}"
        else:
            line = text
        if not result or result[-1] != line:
            result.append(line)
    return "\n".join(result)


def fetch_subtitles(url: str, preferred_lang: str, with_timestamps: bool) -> tuple[str | None, str | None]:
    languages = []
    for language in (preferred_lang, "ru", "en"):
        if language and language not in languages:
            languages.append(language)

    for language in languages:
        with tempfile.TemporaryDirectory(prefix="sc-rutube-subs-") as temp_dir:
            template = str(Path(temp_dir) / "subtitle.%(ext)s")
            command = [
                "yt-dlp",
                "--no-update",
                "--no-playlist",
                "--skip-download",
                "--write-subs",
                "--write-auto-subs",
                "--sub-langs", language,
                "--convert-subs", "srt",
                "--no-warnings",
                "-o", template,
                url,
            ]
            try:
                _run(command, timeout=120)
            except subprocess.TimeoutExpired:
                continue
            subtitle_files = sorted(Path(temp_dir).glob("*.srt"))
            for subtitle_file in subtitle_files:
                try:
                    body = clean_srt(
                        subtitle_file.read_text(encoding="utf-8-sig"),
                        with_timestamps=with_timestamps,
                    )
                except (OSError, UnicodeError):
                    continue
                if body.strip():
                    return body, language
    return None, None


def safe_slug(value: str, max_len: int = 80) -> str:
    value = re.sub(r"[^\w\s-]", "", value or "").strip()
    value = re.sub(r"\s+", "_", value)
    return value[:max_len] or "video"


def write_transcript(
    out_dir: str,
    meta: dict,
    body: str,
    *,
    lang: str | None = None,
    with_timestamps: bool = False,
    engine: str | None = None,
) -> str:
    root = Path(out_dir)
    root.mkdir(parents=True, exist_ok=True)
    file_path = root / f"{meta['id']}__{safe_slug(meta['title'])}.txt"
    header = [f"# {meta['title']}"]
    if meta.get("channel"):
        header.append(f"channel: {meta['channel']}")
    header.append(f"url: {meta['webpage_url']}")
    header.append(f"source: {'ai:' + engine if engine else 'subs'}")
    if lang:
        header.append(f"lang: {lang}")
    if with_timestamps:
        header.append("timestamps: yes")
    file_path.write_text("\n".join(header) + "\n\n" + body, encoding="utf-8")
    return str(file_path)


def stage_subtitles(url: str, lang: str, with_timestamps: bool, out_dir: str, meta: dict) -> str | None:
    emit({"type": "subs_racing"})
    body, actual_lang = fetch_subtitles(url, lang, with_timestamps)
    if not body:
        return None
    emit({
        "type": "subs_found",
        "lang": actual_lang or lang,
        "with_ts": bool(with_timestamps),
        "chars": len(body),
    })
    emit({"type": "save_start", "kind": "subs"})
    file_path = write_transcript(
        out_dir,
        meta,
        body,
        lang=actual_lang or lang,
        with_timestamps=with_timestamps,
    )
    emit({"type": "saved", "file_path": file_path, "kind": "subs", "chars": len(body)})
    return file_path


def stage_ai(url: str, engine: str, out_dir: str, meta: dict) -> str | None:
    emit({"type": "audio_download_start", "engine": engine})
    with tempfile.TemporaryDirectory(prefix="sc-rutube-audio-") as temp_dir:
        template = str(Path(temp_dir) / "audio.%(ext)s")
        command = [
            "yt-dlp",
            "--no-update",
            "--no-playlist",
            "-f", "worst[acodec!=none]/worst",
            "-x",
            "--audio-format", "mp3",
            "--audio-quality", "9",
            "--no-warnings",
            "-o", template,
            url,
        ]
        try:
            result = _run(command, timeout=1200)
        except subprocess.TimeoutExpired:
            emit({"type": "error", "message": "yt-dlp timeout (>20m)"})
            return None
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").strip()
            emit({"type": "error", "message": f"yt-dlp failed: {tail[-300:]}"})
            return None
        audio_files = sorted(Path(temp_dir).glob("audio.*"))
        audio_file = next((item for item in audio_files if item.is_file()), None)
        if not audio_file:
            emit({"type": "error", "message": "audio file missing after download"})
            return None

        emit({
            "type": "audio_download_done",
            "engine": engine,
            "bytes": audio_file.stat().st_size,
        })
        emit({"type": "transcribe_start", "engine": engine})
        try:
            with silenced():
                import gemini_utils

                client = gemini_utils.GeminiClient()
                body, error = client.transcribe_audio(str(audio_file), engine=engine)
                cost = client.calculate_cost() if engine == "gemini" else 0.0
        except Exception as exc:
            emit({"type": "error", "message": f"transcribe crashed: {type(exc).__name__}: {exc}"})
            return None
        if error or not body:
            emit({"type": "error", "message": f"transcribe failed: {error or 'empty result'}"})
            return None

    rounded_cost = round(float(cost or 0), 6)
    emit({
        "type": "transcribe_done",
        "engine": engine,
        "chars": len(body),
        "cost_usd": rounded_cost,
    })
    emit({"type": "save_start", "kind": "ai"})
    file_path = write_transcript(out_dir, meta, body, engine=engine)
    emit({
        "type": "saved",
        "file_path": file_path,
        "kind": "ai",
        "chars": len(body),
        "cost_usd": rounded_cost,
    })
    return file_path


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--lang", default="ru")
    parser.add_argument("--with-ts", action="store_true")
    parser.add_argument("--ai", action="store_true")
    parser.add_argument("--engine", default="gemini", choices=("gemini", "assemblyai"))
    args = parser.parse_args(argv)

    started = time.time()
    video_id = extract_rutube_id(args.url)
    if not video_id:
        emit({"type": "error", "message": "Не удалось распознать ссылку Rutube"})
        return 2

    emit({"type": "metadata_start"})
    meta, meta_error = fetch_metadata(args.url)
    if not meta or not meta.get("id"):
        emit({"type": "error", "message": f"Не удалось прочитать Rutube: {meta_error or 'нет метаданных'}"})
        return 3
    emit({
        "type": "video",
        "video_id": meta["id"],
        "title": meta["title"],
        "duration_sec": meta["duration_sec"],
        "channel": meta["channel"],
        "thumbnail_url": meta.get("thumbnail_url"),
        "url": meta["webpage_url"],
    })

    if not args.ai:
        file_path = stage_subtitles(args.url, args.lang, args.with_ts, args.out_dir, meta)
        if file_path:
            emit({"type": "done", "duration_sec": round(time.time() - started, 2)})
            return 0
        duration = meta.get("duration_sec") or 0
        estimate = round((duration / 3600.0) * 0.0125, 4) if duration else 0.005
        emit({"type": "subs_missing", "duration_sec": duration, "est_cost_usd": estimate})
        emit({"type": "done", "duration_sec": round(time.time() - started, 2)})
        return 0

    file_path = stage_ai(args.url, args.engine, args.out_dir, meta)
    emit({"type": "done", "duration_sec": round(time.time() - started, 2)})
    return 0 if file_path else 4


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        raise SystemExit(130)
    except Exception as exc:  # pragma: no cover - last-resort NDJSON guard
        emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        raise SystemExit(1)
