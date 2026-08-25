#!/usr/bin/env python3
"""Resumable whole-author Boosty pipeline.

The default path is deliberately audio-only: fetch the 96 Kbit/s MP3, send it
to AssemblyAI, persist TXT/SRT, checkpoint, then advance to the next video.
Full-video archiving is an explicit ``--with-video`` opt-in.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKERS_ROOT = HERE.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
if str(WORKERS_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKERS_ROOT))

from boosty_api import canonicalize_author, decode_auth_cookie, iter_posts, profile
from boosty_cli import Console, request_browser_auth, show_event
from boosty_single_ndjson import safe_slug
from shared import settings as shared_settings
from shared.library_db import open_db, set_item_transcript, upsert_item, upsert_source


GIB = 1024 ** 3
AUDIO_BITRATE = 96_000
# boosty_single_ndjson.py explicitly requests AssemblyAI Universal-2.
DEFAULT_AAI_PRICE_PER_HOUR = 0.15
_ACTIVE_CHILD = None


def app_root():
    return Path(
        os.environ.get("SC_DESKTOP_DIR")
        or os.environ.get("MEDIA_INBOX_DIR")
        or (Path.home() / "Library" / "Application Support" / "sc-desktop")
    )


def expand_path(value, fallback):
    text = str(value or "").strip()
    if not text:
        return Path(fallback)
    return Path(os.path.expanduser(text)).resolve()


def storage_config(with_video=False):
    raw = shared_settings.load().get("boosty") or {}
    root = app_root()
    return {
        "audio_dir": expand_path(raw.get("audio_dir"), root / "media" / "boosty"),
        "video_dir": expand_path(raw.get("video_dir"), root / "videos" / "boosty"),
        "transcript_dir": root / "transcripts" / "boosty",
        "work_dir": root / "tmp" / "boosty",
        "save_video": bool(with_video),
    }


def nearest_existing(path):
    current = Path(path).resolve()
    while not current.exists() and current.parent != current:
        current = current.parent
    return current


def disk_snapshot(path):
    resolved = Path(path).resolve()
    parts = resolved.parts
    if len(parts) >= 3 and parts[0] == "/" and parts[1] == "Volumes":
        mount = Path("/Volumes") / parts[2]
        if not mount.is_dir():
            raise RuntimeError(f"Внешний диск не подключён: {mount}")
    probe = nearest_existing(path)
    usage = shutil.disk_usage(probe)
    return {"probe": str(probe), "free": usage.free, "total": usage.total}


def human_bytes(value):
    number = float(value or 0)
    for unit in ("Б", "КБ", "МБ", "ГБ", "ТБ"):
        if number < 1024 or unit == "ТБ":
            digits = 0 if unit == "Б" else 1
            return f"{number:.{digits}f} {unit}"
        number /= 1024
    return f"{number:.1f} ТБ"


def human_hours(seconds):
    hours = float(seconds or 0) / 3600
    return f"{hours:.1f} ч"


def estimate_plan(videos, price_per_hour=DEFAULT_AAI_PRICE_PER_HOUR):
    duration = sum(float(row.get("duration_sec") or 0) for row in videos)
    audio_bytes = int(duration * AUDIO_BITRATE / 8 * 1.08)
    hours = duration / 3600
    # Async throughput varies with upload speed and provider load. This range
    # is intentionally conservative for a sequential one-file-at-a-time run.
    wall_min = max(1.0, hours * 0.05 + len(videos) * 0.10 / 60)
    wall_max = max(wall_min, hours * 0.15 + len(videos) * 0.50 / 60)
    return {
        "videos": len(videos),
        "duration_sec": duration,
        "audio_bytes": audio_bytes,
        "wall_hours_min": wall_min,
        "wall_hours_max": wall_max,
        "estimated_cost_usd": hours * float(price_per_hour),
    }


def atomic_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


@contextlib.contextmanager
def exclusive_run(lock_path):
    """Prevent two whole-channel workers from charging for the same items."""
    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+", encoding="utf-8")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError(
                "Полный Boosty-прогон уже запущен в другом терминале. "
                "Остановите его или дождитесь завершения."
            ) from exc
        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()) + "\n")
        handle.flush()
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except Exception:
            pass
        handle.close()


def stop_active_child():
    process = _ACTIVE_CHILD
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGINT)
    except Exception:
        try:
            process.terminate()
        except Exception:
            pass


def handle_parent_signal(_signum, _frame):
    stop_active_child()
    raise KeyboardInterrupt()


def load_json(path, fallback):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else fallback
    except Exception:
        return fallback


def collect_catalog(author, token):
    entity = profile(author, token)
    posts = []
    for page, _extra in iter_posts(author, token, limit=0, order="desc"):
        posts.extend(page)
    videos = []
    for post in posts:
        if post.get("has_access") is not True:
            continue
        for position, video in enumerate(post.get("videos") or [], start=1):
            videos.append({
                "url": post.get("canonical_url"),
                "post_id": post.get("post_id"),
                "post_title": post.get("title"),
                "post_published_at": post.get("publish_time") or post.get("created_at"),
                "video_id": str(video.get("video_id") or ""),
                "position": video.get("position") or position,
                "title": video.get("title") or post.get("title") or "Видео Boosty",
                "duration_sec": video.get("duration_sec") or 0,
                "author": entity.get("title") or author,
            })
    return entity, posts, videos


def ensure_catalog_rows(conn, entity, posts):
    handle = entity.get("author_handle")
    existing_source = conn.execute(
        "SELECT id FROM sources WHERE platform='boosty' AND (external_id=? OR handle=?) ORDER BY external_id IS NOT NULL DESC LIMIT 1",
        (entity.get("author_id"), handle),
    ).fetchone()
    if existing_source:
        source_id = existing_source["id"]
        # Preserve the richer meta_json written by the desktop catalog job.
        conn.execute(
            "UPDATE sources SET handle=?, display_name=COALESCE(?, display_name), external_id=COALESCE(?, external_id), avatar_url=COALESCE(?, avatar_url) WHERE id=?",
            (handle, entity.get("title"), entity.get("author_id"), entity.get("avatar_url"), source_id),
        )
    else:
        source_id = upsert_source(
            conn,
            platform="boosty",
            handle=handle,
            display_name=entity.get("title"),
            external_id=entity.get("author_id"),
            avatar_url=entity.get("avatar_url"),
            meta={"canonical_url": entity.get("canonical_url")},
            mark_synced=False,
        )
    meta_row = conn.execute("SELECT meta_json FROM sources WHERE id=?", (source_id,)).fetchone()
    try:
        source_meta = json.loads(meta_row["meta_json"] or "{}") if meta_row else {}
    except Exception:
        source_meta = {}
    source_meta.update({
        "canonical_url": entity.get("canonical_url"),
        "posts_remote_count": entity.get("posts_count"),
        "subscribers_count": entity.get("subscribers_count"),
        "subscription": entity.get("subscription"),
        "subscription_kind": entity.get("subscription_kind"),
        "catalog_complete": True,
        "catalog_posts_count": len(posts),
        "catalog_video_posts_count": sum(1 for post in posts if int(post.get("video_count") or 0) > 0),
        "catalog_videos_count": sum(int(post.get("video_count") or 0) for post in posts),
        "catalog_accessible_posts": sum(1 for post in posts if post.get("has_access") is True),
        "catalog_checked_at": int(time.time()),
    })
    conn.execute(
        "UPDATE sources SET meta_json=?, last_synced_at=unixepoch() WHERE id=?",
        (json.dumps(source_meta, ensure_ascii=False), source_id),
    )
    for post in posts:
        post_external_id = str(post.get("external_id") or f"post:{post.get('post_id')}")
        parent = conn.execute(
            "SELECT id FROM items WHERE source_id=? AND external_id=?",
            (source_id, post_external_id),
        ).fetchone()
        if parent is None:
            parent_id = upsert_item(
                conn,
                source_id=source_id,
                external_id=post_external_id,
                type="boosty_post",
                url=post.get("canonical_url"),
                title=post.get("title"),
                caption=post.get("text"),
                published_at=post.get("publish_time") or post.get("created_at"),
                raw_meta={
                    "platform": "boosty",
                    "entity_kind": "post",
                    "post_id": post.get("post_id"),
                    "access_state": "accessible" if post.get("has_access") else "locked",
                    "video_count": post.get("video_count") or 0,
                },
            )
            conn.execute("UPDATE items SET has_media=? WHERE id=?", (1 if post.get("video_count") else 0, parent_id))
        for video in post.get("videos") or []:
            video_id = str(video.get("video_id") or "")
            if not video_id:
                continue
            child = conn.execute(
                "SELECT id FROM items WHERE source_id=? AND external_id=?",
                (source_id, video_id),
            ).fetchone()
            if child is None:
                child_id = upsert_item(
                    conn,
                    source_id=source_id,
                    external_id=video_id,
                    type="boosty_video",
                    url=video.get("canonical_url") or post.get("canonical_url"),
                    title=video.get("title") or post.get("title"),
                    published_at=post.get("publish_time") or post.get("created_at"),
                    duration_seconds=video.get("duration_sec"),
                    views=video.get("views"),
                    raw_meta={
                        "platform": "boosty",
                        "entity_kind": "video",
                        "post_id": post.get("post_id"),
                        "position": video.get("position"),
                        "access_state": "accessible",
                    },
                )
                conn.execute(
                    "UPDATE items SET parent_external_id=?, depth=1, has_media=1 WHERE id=?",
                    (post_external_id, child_id),
                )
    return source_id


def existing_file(value):
    try:
        path = Path(value)
        return path.is_file() and path.stat().st_size > 0
    except Exception:
        return False


def remaining_selection(conn, source_id, videos, mode, save_video):
    result = []
    for video in videos:
        row = conn.execute(
            "SELECT media_path, video_path, transcript_path FROM items WHERE source_id=? AND external_id=?",
            (source_id, video["video_id"]),
        ).fetchone()
        ready = False
        if row:
            if mode == "download":
                ready = existing_file(row["media_path"]) and (not save_video or existing_file(row["video_path"]))
            else:
                ready = existing_file(row["transcript_path"]) and (not save_video or existing_file(row["video_path"]))
            if existing_file(row["media_path"]):
                video["audio_path"] = row["media_path"]
            if existing_file(row["video_path"]):
                video["video_path"] = row["video_path"]
        if not ready:
            result.append(video)
    return result


def persist_event(conn, source_id, event):
    video_id = str(event.get("video_id") or "")
    if not video_id:
        return
    row = conn.execute(
        "SELECT id FROM items WHERE source_id=? AND external_id=?",
        (source_id, video_id),
    ).fetchone()
    if not row:
        return
    if event.get("audio_path"):
        conn.execute(
            "UPDATE items SET media_path=?, download_status='done', download_error=NULL, updated_at=unixepoch() WHERE id=?",
            (event["audio_path"], row["id"]),
        )
    if event.get("video_path"):
        conn.execute(
            "UPDATE items SET video_path=?, updated_at=unixepoch() WHERE id=?",
            (event["video_path"], row["id"]),
        )
    transcript_path = event.get("file_path")
    if transcript_path and existing_file(transcript_path):
        try:
            text = Path(transcript_path).read_text(encoding="utf-8")
        except Exception:
            text = None
        set_item_transcript(
            conn,
            row["id"],
            transcript_path=transcript_path,
            transcript_text=text,
            engine="assemblyai",
            cost_usd=event.get("cost_usd"),
        )


def run_worker(selection, auth, config, mode, force, state_path, source_id, conn):
    config["work_dir"].mkdir(parents=True, exist_ok=True)
    selection_path = config["work_dir"] / f"full-{safe_slug(selection[0]['author'], 60)}.selection.json"
    atomic_json(selection_path, {"items": selection})
    command = [
        sys.executable,
        str(HERE / "boosty_single_ndjson.py"),
        "--selection-file", str(selection_path),
        "--media-dir", str(config["audio_dir"]),
        "--transcript-dir", str(config["transcript_dir"]),
        "--work-dir", str(config["work_dir"]),
    ]
    if mode == "download":
        command.append("--download-only")
    if force:
        command.append("--force-download")
    if config["save_video"]:
        command.extend(["--save-video", "--video-dir", str(config["video_dir"])])

    env = os.environ.copy()
    env["SC_BOOSTY_AUTH_COOKIE"] = auth["value"]
    if auth.get("expirationDate") is not None:
        env["SC_BOOSTY_AUTH_EXPIRES"] = str(auth["expirationDate"])
    key = shared_settings.get_api_key("ASSEMBLYAI_API_KEY")
    if key and not env.get("ASSEMBLYAI_API_KEY"):
        env["ASSEMBLYAI_API_KEY"] = key

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=env,
        start_new_session=True,
    )
    global _ACTIVE_CHILD
    _ACTIVE_CHILD = process
    env.pop("SC_BOOSTY_AUTH_COOKIE", None)
    auth["value"] = ""
    console = Console()
    state = load_json(state_path, {"completed": {}, "errors": {}})
    try:
        for raw_line in process.stdout:
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            show_event(console, event)
            kind = event.get("type")
            if kind in {"saved", "audio_saved"}:
                persist_event(conn, source_id, event)
                state["completed"][str(event.get("video_id"))] = {
                    "at": int(time.time()),
                    "audio_path": event.get("audio_path"),
                    "video_path": event.get("video_path"),
                    "file_path": event.get("file_path"),
                }
                state["errors"].pop(str(event.get("video_id")), None)
                atomic_json(state_path, state)
            elif kind == "item_error":
                state["errors"][str(event.get("video_id"))] = {
                    "at": int(time.time()),
                    "message": event.get("message"),
                }
                atomic_json(state_path, state)
        stderr = process.stderr.read() if process.stderr else ""
        code = process.wait()
    except KeyboardInterrupt:
        stop_active_child()
        try:
            process.wait(timeout=15)
        except Exception:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except Exception:
                pass
        return 130
    finally:
        _ACTIVE_CHILD = None
        console.finish_progress()
    if code != 0 and stderr.strip():
        print("Worker: " + stderr.strip()[-800:], file=sys.stderr)
    return code


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="sc boosty-all",
        description="Последовательно скачать аудио всех видео автора Boosty и расшифровать через AssemblyAI.",
    )
    parser.add_argument("url", help="ссылка вида https://boosty.to/<автор>")
    parser.add_argument("--plan", action="store_true", help="только показать объём, время и свободное место")
    parser.add_argument("--yes", action="store_true", help="не спрашивать подтверждение перед платным запуском")
    parser.add_argument("--download-only", action="store_true", help="скачать аудио без AssemblyAI")
    parser.add_argument("--with-video", action="store_true", help="также архивировать видео до 1080p")
    parser.add_argument("--force", action="store_true", help="не пропускать уже готовые файлы")
    parser.add_argument("--min-free-gb", type=float, default=5.0, help="резерв свободного места после загрузки")
    parser.add_argument("--aai-price", type=float, default=DEFAULT_AAI_PRICE_PER_HOUR, help="цена AssemblyAI за час для оценки")
    parser.add_argument("--auth-timeout", type=float, default=20.0, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    author = canonicalize_author(args.url)
    print("Получаю авторизацию Boosty из браузера…", flush=True)
    auth = request_browser_auth(max(3.0, args.auth_timeout))
    token = decode_auth_cookie(auth["value"])
    entity, posts, videos = collect_catalog(author, token)
    config = storage_config(with_video=args.with_video)
    conn = open_db()
    source_id = ensure_catalog_rows(conn, entity, posts)
    mode = "download" if args.download_only else "transcribe"
    remaining = videos if args.force else remaining_selection(conn, source_id, videos, mode, args.with_video)
    plan = estimate_plan(remaining, args.aai_price)
    disk = disk_snapshot(config["audio_dir"])
    required = plan["audio_bytes"] + int(max(0, args.min_free_gb) * GIB)

    print(f"Автор: {entity.get('title') or author} · @{entity.get('author_handle') or author}")
    print(f"Каталог: {len(posts)} постов · {len(videos)} видео · доступно текущему аккаунту")
    print(f"Осталось: {plan['videos']} видео · {human_hours(plan['duration_sec'])}")
    print(f"Аудио 96 Кбит/с: примерно {human_bytes(plan['audio_bytes'])}")
    print(f"Папка аудио: {config['audio_dir']}")
    print(f"Свободно: {human_bytes(disk['free'])} · резерв после запуска: {args.min_free_gb:.1f} ГБ")
    if not args.download_only:
        print(f"AssemblyAI: ориентир ${plan['estimated_cost_usd']:.2f} при ${args.aai_price:.2f}/ч")
        print(f"Время последовательного прогона: ориентировочно {plan['wall_hours_min']:.1f}–{plan['wall_hours_max']:.1f} ч")
    if args.with_video:
        print(f"Видео: ВКЛЮЧЕНО · папка {config['video_dir']}")
        print("Размер видео заранее не гарантируется; для всего канала нужен отдельный большой запас.")
    else:
        print("Видео: выключено — основной быстрый audio-only поток")

    if plan["videos"] == 0:
        print("Всё уже готово — запускать нечего.")
        return 0
    if disk["free"] < required:
        print(
            f"Недостаточно места: нужно около {human_bytes(required)}, доступно {human_bytes(disk['free'])}.",
            file=sys.stderr,
        )
        return 5
    if args.plan:
        return 0
    if not args.yes:
        answer = input("Запустить последовательную обработку? [y/N] ").strip().lower()
        if answer not in {"y", "yes", "д", "да"}:
            print("Отменено.")
            return 0

    state_path = config["work_dir"] / f"full-{safe_slug(author, 60)}.state.json"
    started = time.time()
    with exclusive_run(state_path.with_suffix(".lock")):
        code = run_worker(remaining, auth, config, mode, args.force, state_path, source_id, conn)
    elapsed = time.time() - started
    print(f"Завершено за {human_hours(elapsed)} · checkpoint: {state_path}")
    if code == 130:
        print("Остановлено. Повтор той же команды продолжит с готовых файлов.")
    return code


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, handle_parent_signal)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, handle_parent_signal)
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Остановлено пользователем.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print("Ошибка: " + str(exc), file=sys.stderr)
        raise SystemExit(4)
