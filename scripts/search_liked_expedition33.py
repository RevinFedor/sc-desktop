#!/usr/bin/env python3
"""Search the authenticated YouTube "Liked videos" playlist without SC Desktop.

The script intentionally does not use SC Desktop's database or IPC. It reads the
signed-in Firefox YouTube session through yt-dlp, then checks only video metadata:
publication date, description and tags. Video and audio files are never downloaded.

All generated data lives under ~/Library/Application Support/sc-desktop/ so a
stopped run can safely continue later.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


PLAYLIST_URL = "https://www.youtube.com/playlist?list=LL"
MIN_YTDLP_VERSION = (2026, 7, 4)
DEFAULT_TERMS = ("expedition", "экспедиция", "clair obscur")
CYRILLIC_WORD_RE = re.compile(r"[А-Яа-яЁё]+")
DEFAULT_DATA_ROOT = Path.home() / "Library" / "Application Support" / "sc-desktop"


class QuietLogger:
    """Keep yt-dlp's worker diagnostics out of the progress display."""

    def debug(self, message: str) -> None:
        return None

    def warning(self, message: str) -> None:
        return None

    def error(self, message: str) -> None:
        return None


def parse_iso_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Дата должна быть в формате ГГГГ-ММ-ДД") from exc


def version_tuple(version: str) -> tuple[int, int, int]:
    numbers = re.findall(r"\d+", version)
    if len(numbers) < 3:
        return (0, 0, 0)
    return tuple(int(part) for part in numbers[:3])


def data_root() -> Path:
    override = os.environ.get("SC_DESKTOP_DATA_DIR")
    return Path(override).expanduser() if override else DEFAULT_DATA_ROOT


def ensure_current_ytdlp(root: Path):
    """Load a playlist-paging-safe yt-dlp copy from SC Desktop's data folder."""
    package_dir = root / "tools" / "liked-videos-search" / "yt-dlp"
    package_dir.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(package_dir))

    def load_version() -> tuple[Any | None, tuple[int, int, int]]:
        try:
            module = importlib.import_module("yt_dlp")
            return module, version_tuple(module.version.__version__)
        except ModuleNotFoundError:
            return None, (0, 0, 0)

    module, installed = load_version()
    if installed >= MIN_YTDLP_VERSION:
        return module

    print("[liked-search] Подготавливаю актуальный yt-dlp для полного списка понравившихся…", flush=True)
    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-cache-dir",
        "--quiet",
        "--target",
        str(package_dir),
        "--upgrade",
        "yt-dlp>=2026.07.04",
    ]
    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "Не удалось установить актуальный yt-dlp. Проверьте интернет и повторите запуск."
        ) from exc

    importlib.invalidate_caches()
    sys.modules.pop("yt_dlp", None)
    sys.modules.pop("yt_dlp.version", None)
    module, installed = load_version()
    if module is None or installed < MIN_YTDLP_VERSION:
        raise RuntimeError("После установки yt-dlp остался слишком старым для полного плейлиста.")
    return module


def ytdlp_options(*, flat: bool = False, ignore_errors: bool = False) -> dict[str, Any]:
    return {
        "cookiesfrombrowser": ("firefox", None, None, None),
        "extract_flat": True if flat else False,
        "ignoreerrors": ignore_errors,
        "noplaylist": not flat,
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "cachedir": False,
        "socket_timeout": 30,
        "retries": 2,
        "extractor_retries": 2,
        "logger": QuietLogger(),
    }


def json_load(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def write_json_atomic(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_progress(path: Path) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                # An interrupted append can leave one incomplete final line.
                continue
            video_id = row.get("id")
            if isinstance(video_id, str):
                rows[video_id] = row
    return rows


def append_progress(stream, row: dict[str, Any]) -> None:
    stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    stream.flush()


def fetch_candidates(YoutubeDL, candidates_path: Path) -> list[dict[str, str]]:
    cached = json_load(candidates_path, None)
    if isinstance(cached, list):
        return cached

    print("[liked-search] Читаю полный список понравившихся роликов…", flush=True)
    with YoutubeDL(ytdlp_options(flat=True, ignore_errors=True)) as downloader:
        playlist = downloader.extract_info(PLAYLIST_URL, download=False)
    if not isinstance(playlist, dict):
        raise RuntimeError("YouTube не вернул список понравившихся. Проверьте вход в Firefox.")

    reported_total = playlist.get("playlist_count")
    entries = playlist.get("entries") or []
    candidates = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        video_id = entry.get("id")
        title = str(entry.get("title") or "")
        url = str(entry.get("url") or (f"https://www.youtube.com/watch?v={video_id}" if video_id else ""))
        if not isinstance(video_id, str) or not CYRILLIC_WORD_RE.search(title):
            continue
        candidates.append({"id": video_id, "title": title, "url": url})

    if reported_total and len(entries) < int(reported_total):
        raise RuntimeError(
            f"Парсер получил только {len(entries)} из {reported_total} понравившихся. "
            "Ничего не проверено: повторите запуск, когда YouTube будет доступен."
        )
    write_json_atomic(candidates_path, candidates)
    print(
        f"[liked-search] Получено {len(entries)} роликов; с русским словом в названии: {len(candidates)}.",
        flush=True,
    )
    return candidates


def published_date(info: dict[str, Any]) -> date | None:
    raw = info.get("upload_date")
    if isinstance(raw, str) and re.fullmatch(r"\d{8}", raw):
        try:
            return datetime.strptime(raw, "%Y%m%d").date()
        except ValueError:
            pass
    timestamp = info.get("timestamp")
    if isinstance(timestamp, (int, float)):
        return datetime.fromtimestamp(timestamp, tz=timezone.utc).date()
    return None


def one_video_result(YoutubeDL, candidate: dict[str, str], start: date, end: date, terms: tuple[str, ...]) -> dict[str, Any]:
    video_id = candidate["id"]
    url = candidate["url"]
    last_error: str | None = None
    for attempt in range(1, 4):
        try:
            with YoutubeDL(ytdlp_options()) as downloader:
                # process=False avoids choosing a media format. The returned page metadata
                # already includes publication date, description and tags.
                info = downloader.extract_info(url, download=False, process=False)
            if not isinstance(info, dict):
                raise RuntimeError("метаданные не получены")

            video_date = published_date(info)
            base = {
                "id": video_id,
                "title": info.get("title") or candidate["title"],
                "url": info.get("webpage_url") or url,
                "published_at": video_date.isoformat() if video_date else None,
            }
            if video_date is None:
                return {**base, "status": "no_date"}
            if not start <= video_date <= end:
                return {**base, "status": "outside_date"}

            description = info.get("description") or ""
            tags = [str(tag) for tag in (info.get("tags") or []) if tag]
            description_folded = description.casefold()
            tags_folded = "\n".join(tags).casefold()
            description_terms = [term for term in terms if term in description_folded]
            tag_terms = [term for term in terms if term in tags_folded]
            matched_terms = sorted(set(description_terms + tag_terms))
            if matched_terms:
                return {
                    **base,
                    "status": "match",
                    "matched_terms": matched_terms,
                    "matched_in": (["description"] if description_terms else []) + (["tags"] if tag_terms else []),
                }
            return {**base, "status": "checked"}
        except Exception as exc:  # yt-dlp produces several implementation-specific exception types
            last_error = str(exc).replace("\n", " ")[:400]
            if "Video unavailable" in last_error or "This video is not available" in last_error:
                return {
                    "id": video_id,
                    "title": candidate["title"],
                    "url": url,
                    "published_at": None,
                    "status": "unavailable",
                    "error": "Видео больше недоступно на YouTube",
                }
            if attempt < 3:
                time.sleep(2 * attempt)

    return {
        "id": video_id,
        "title": candidate["title"],
        "url": url,
        "published_at": None,
        "status": "error",
        "error": last_error or "неизвестная ошибка",
    }


def parse_args() -> argparse.Namespace:
    today = date.today().isoformat()
    parser = argparse.ArgumentParser(
        description="Ищет Expedition/Экспедиция в описаниях и тегах русскоязычных понравившихся YouTube-роликов."
    )
    parser.add_argument("--start-date", type=parse_iso_date, default=date(2025, 5, 1), help="Начало периода, по умолчанию 2025-05-01.")
    parser.add_argument("--end-date", type=parse_iso_date, default=parse_iso_date(today), help=f"Конец периода, по умолчанию сегодня ({today}).")
    parser.add_argument("--workers", type=int, default=5, help="Одновременных проверок, от 1 до 5; по умолчанию 5.")
    parser.add_argument("--term", action="append", help="Искомый текст; можно передать несколько раз. По умолчанию: Expedition, Экспедиция, Clair Obscur.")
    parser.add_argument("--retry-errors", action="store_true", help="При продолжении заново проверить ролики, на которых прежде была ошибка.")
    args = parser.parse_args()
    if not 1 <= args.workers <= 5:
        parser.error("--workers должен быть от 1 до 5")
    if args.start_date > args.end_date:
        parser.error("--start-date не может быть позже --end-date")
    return args


def main() -> int:
    args = parse_args()
    terms = tuple(term.casefold() for term in (args.term or DEFAULT_TERMS) if term.strip())
    if not terms:
        raise RuntimeError("Нужен хотя бы один непустой --term")

    root = data_root()
    scope = f"from-{args.start_date.isoformat()}_to-{args.end_date.isoformat()}_ru-titles"
    run_dir = root / "liked-videos-search" / scope
    run_dir.mkdir(parents=True, exist_ok=True)
    candidates_path = run_dir / "candidates.json"
    progress_path = run_dir / "progress.jsonl"
    result_path = run_dir / "matches.json"
    config_path = run_dir / "run.json"

    YoutubeDL = ensure_current_ytdlp(root).YoutubeDL
    write_json_atomic(config_path, {
        "playlist": PLAYLIST_URL,
        "start_date": args.start_date.isoformat(),
        "end_date": args.end_date.isoformat(),
        "workers": args.workers,
        "terms": list(terms),
        "output": str(result_path),
    })
    candidates = fetch_candidates(YoutubeDL, candidates_path)
    progress = load_progress(progress_path)
    pending = [
        candidate for candidate in candidates
        if candidate["id"] not in progress or (args.retry_errors and progress[candidate["id"]].get("status") == "error")
    ]
    completed_before = len(candidates) - len(pending)
    print(
        f"[liked-search] Проверяю {len(pending)} роликов ({completed_before} уже есть в прогрессе), потоков: {args.workers}.",
        flush=True,
    )

    lock = threading.Lock()
    match_count = sum(row.get("status") == "match" for row in progress.values())
    started = time.monotonic()
    with progress_path.open("a", encoding="utf-8") as progress_stream, ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(one_video_result, YoutubeDL, candidate, args.start_date, args.end_date, terms): candidate
            for candidate in pending
        }
        done_count = 0
        while futures:
            done, _ = wait(futures, return_when=FIRST_COMPLETED)
            for future in done:
                candidate = futures.pop(future)
                try:
                    row = future.result()
                except Exception as exc:
                    row = {
                        "id": candidate["id"],
                        "title": candidate["title"],
                        "url": candidate["url"],
                        "published_at": None,
                        "status": "error",
                        "error": str(exc).replace("\n", " ")[:400],
                    }
                with lock:
                    append_progress(progress_stream, row)
                    progress[row["id"]] = row
                    done_count += 1
                    if row["status"] == "match":
                        match_count += 1
                        print(f"[liked-search] НАЙДЕНО: {row['title']} — {row['url']}", flush=True)
                    if done_count % 25 == 0 or done_count == len(pending):
                        elapsed = max(time.monotonic() - started, 0.1)
                        rate = done_count / elapsed
                        remaining = (len(pending) - done_count) / rate if rate else 0
                        print(
                            f"[liked-search] Готово {done_count}/{len(pending)} · найдено {match_count} · осталось ≈ {round(remaining / 60)} мин.",
                            flush=True,
                        )

    matches = [row for row in progress.values() if row.get("status") == "match"]
    matches.sort(key=lambda row: (row.get("published_at") or "", row.get("title") or ""), reverse=True)
    write_json_atomic(result_path, matches)
    errors = sum(row.get("status") == "error" for row in progress.values())
    unavailable = sum(row.get("status") == "unavailable" for row in progress.values())
    print(
        f"[liked-search] Готово. Совпадений: {len(matches)}. "
        f"Недоступных видео: {unavailable}. Ошибок: {errors}.",
        flush=True,
    )
    print(f"[liked-search] Результат: {result_path}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n[liked-search] Остановлено. Повторите ту же команду — работа продолжится с сохранённого места.", flush=True)
        raise SystemExit(130)
    except Exception as exc:
        print(f"[liked-search] Ошибка: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
