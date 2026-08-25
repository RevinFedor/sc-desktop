#!/usr/bin/env python3
"""Human-facing standalone runner for ``sc -b <boosty-url>``.

The Electron app is not required.  For a few seconds this process owns the
existing loopback bridge port and asks the installed SC browser extension for
the user's Boosty auth cookie.  The value is passed only through the child
process environment to boosty_single_ndjson.py and is never logged or stored.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional


BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 53127
EXTENSION_ID = "phnlfhkblebijojjnnlbcbklijgcijgf"
EXTENSION_ORIGIN = "chrome-extension://" + EXTENSION_ID
MAX_AUTH_BODY_BYTES = 64 * 1024
LOCAL_AUTH_TOKEN_PATH = Path(
    os.environ.get("SC_DESKTOP_NOTIFICATION_TOKEN_PATH")
    or Path(
        os.environ.get("SC_DESKTOP_DIR")
        or os.environ.get("MEDIA_INBOX_DIR")
        or (Path.home() / "Library" / "Application Support" / "sc-desktop")
    ) / "notification-bridge-token"
)


class AuthState:
    def __init__(self) -> None:
        self.request_id = str(uuid.uuid4())
        self.event = threading.Event()
        self.lock = threading.Lock()
        self.command_delivered = False
        self.auth: Optional[Dict[str, Any]] = None
        self.error: Optional[str] = None

    def take_command(self):
        with self.lock:
            if self.command_delivered or self.event.is_set():
                return []
            self.command_delivered = True
            return [{
                "cmd": "boosty_auth",
                "requestId": self.request_id,
                "ts": int(time.time() * 1000),
            }]

    def finish(self, auth, error=None):
        with self.lock:
            if self.event.is_set():
                return
            value = auth.get("value") if isinstance(auth, dict) else None
            if isinstance(value, str) and value:
                self.auth = {
                    "value": value,
                    "expirationDate": auth.get("expirationDate"),
                }
            else:
                self.error = str(error or "В браузере нет активной авторизации Boosty")
            self.event.set()


def _handler_for(state):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SCBoostyBridge/1"

        def log_message(self, _format, *_args):
            # Request lines could become noisy and are not useful to the user.
            return

        def _cors(self):
            origin = self.headers.get("Origin", "")
            if origin == EXTENSION_ORIGIN:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-SC-Extension-Id")
            self.send_header("Access-Control-Max-Age", "60")
            if origin == EXTENSION_ORIGIN:
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def _json(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/healthz":
                self._json(200, {"ok": True, "version": 1})
                return
            if path == "/bridge-commands":
                self._json(200, {"items": state.take_command()})
                return
            self._json(404, {"error": "not found"})

        def do_POST(self):
            path = self.path.split("?", 1)[0]
            if path != "/boosty-auth-state":
                self._json(404, {"error": "not found"})
                return
            if self.headers.get("X-SC-Extension-Id") != EXTENSION_ID:
                self._json(403, {"ok": False, "error": "extension required"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_AUTH_BODY_BYTES:
                self._json(413, {"ok": False, "error": "bad body"})
                return
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                self._json(400, {"ok": False, "error": "bad json"})
                return
            if str(body.get("requestId") or "") != state.request_id:
                self._json(404, {"ok": False, "error": "request expired"})
                return
            state.finish(body.get("auth"), body.get("error"))
            self._json(200, {"ok": True})

    return Handler


class AuthServer(ThreadingHTTPServer):
    daemon_threads = True


def request_browser_auth(timeout_sec):
    state = AuthState()
    try:
        server = AuthServer((BRIDGE_HOST, BRIDGE_PORT), _handler_for(state))
    except OSError:
        return request_running_desktop_auth(timeout_sec)

    thread = threading.Thread(target=server.serve_forever, name="boosty-auth-bridge", daemon=True)
    thread.start()
    try:
        if not state.event.wait(timeout_sec):
            raise RuntimeError(
                "Расширение SC не ответило. Откройте браузер с установленным расширением и повторите."
            )
        if not state.auth:
            raise RuntimeError(state.error or "В браузере нет активной авторизации Boosty")
        return state.auth
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def request_running_desktop_auth(timeout_sec):
    try:
        token = LOCAL_AUTH_TOKEN_PATH.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RuntimeError(
            "SC Desktop уже занимает порт авторизации, но локальный токен недоступен. "
            "Перезапустите обновлённый SC Desktop или закройте его и повторите."
        ) from exc
    request = urllib.request.Request(
        "http://127.0.0.1:53127/boosty-auth-request",
        data=b"{}",
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=max(3.0, timeout_sec + 3.0)) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise RuntimeError(
                "Запущена старая версия SC Desktop без CLI-моста Boosty. "
                "Перезапустите обновлённое приложение или закройте его."
            ) from exc
        raise RuntimeError(f"SC Desktop не отдал авторизацию Boosty (HTTP {exc.code})") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("Не удалось запросить авторизацию у запущенного SC Desktop") from exc
    auth = payload.get("auth") if isinstance(payload, dict) else None
    if not isinstance(auth, dict) or not isinstance(auth.get("value"), str) or not auth["value"]:
        raise RuntimeError("SC Desktop не получил активную авторизацию Boosty из браузера")
    return {
        "value": auth["value"],
        "expirationDate": auth.get("expirationDate"),
    }


def human_bytes(value):
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return "0 Б"
    units = ["Б", "КБ", "МБ", "ГБ"]
    unit = units[0]
    for unit in units:
        if abs(number) < 1024 or unit == units[-1]:
            break
        number /= 1024
    digits = 0 if unit in {"Б", "КБ"} else 1
    return ("{:,.%df} {}" % digits).format(number, unit).replace(",", " ")


def human_duration(value):
    seconds = max(0, int(value or 0))
    hours, rest = divmod(seconds, 3600)
    minutes, seconds = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"


class Console:
    def __init__(self):
        self.tty = sys.stdout.isatty()
        self.progress_active = False
        self.last_plain_bucket = -1
        self.last_plain_status_bucket = -1
        self.current_item_index = 1
        self.current_items_total = 1
        self.saved_items = []

    def line(self, text=""):
        if self.progress_active and self.tty:
            sys.stdout.write("\r\033[2K")
            self.progress_active = False
        print(text, flush=True)

    def update_item(self, event):
        try:
            self.current_item_index = int(event.get("item_index") or self.current_item_index)
            self.current_items_total = int(event.get("items_total") or self.current_items_total)
        except (TypeError, ValueError):
            pass

    def item_prefix(self, event=None):
        if event:
            self.update_item(event)
        if self.current_items_total > 1:
            return f"[{self.current_item_index}/{self.current_items_total}] "
        return ""

    def progress(self, event):
        prefix = self.item_prefix(event)
        percent = event.get("percent")
        downloaded = human_bytes(event.get("downloaded_bytes"))
        total_value = event.get("total_bytes")
        total = human_bytes(total_value) if total_value else "?"
        speed_value = event.get("speed_bps")
        speed = (human_bytes(speed_value) + "/с") if speed_value else "—"
        eta_value = event.get("eta_sec")
        eta = (human_duration(eta_value) if eta_value is not None else "—")
        pct = f"{float(percent):5.1f}%" if percent is not None else "  ... "
        message = f"{prefix}Скачивание аудио: {pct}  {downloaded} / {total}  {speed}  осталось {eta}"
        if self.tty:
            sys.stdout.write("\r\033[2K" + message)
            sys.stdout.flush()
            self.progress_active = True
            return
        bucket = int(float(percent or 0) // 10) if percent is not None else 0
        if bucket != self.last_plain_bucket:
            self.last_plain_bucket = bucket
            self.line(message)

    def finish_progress(self):
        if self.progress_active:
            sys.stdout.write("\r\033[2K")
            sys.stdout.flush()
            self.progress_active = False

    def status(self, text, elapsed_sec=0, event=None):
        message = self.item_prefix(event) + text
        if self.tty:
            sys.stdout.write("\r\033[2K" + message)
            sys.stdout.flush()
            self.progress_active = True
            return
        bucket = int(elapsed_sec or 0) // 15
        if bucket != self.last_plain_status_bucket:
            self.last_plain_status_bucket = bucket
            self.line(message)

    def add_saved(self, event):
        self.update_item(event)
        video_id = str(event.get("video_id") or "")
        if video_id:
            self.saved_items = [
                saved for saved in self.saved_items
                if str(saved.get("video_id") or "") != video_id
            ]
        self.saved_items.append(dict(event))


def show_event(console, event):
    kind = event.get("type")
    if kind == "auth_ready":
        console.line("Авторизация Boosty получена.")
    elif kind == "batch_start":
        console.update_item({"item_index": 1, "items_total": event.get("items_total")})
        total = int(event.get("items_total") or 0)
        if total > 1:
            console.line(f"В посте {total} видео — обработаю все по очереди.")
    elif kind == "item_start":
        console.finish_progress()
        console.update_item(event)
        console.last_plain_bucket = -1
        console.last_plain_status_bucket = -1
        if console.current_items_total > 1:
            title = event.get("title") or "Видео Boosty"
            duration = human_duration(event.get("duration_sec"))
            console.line(f"{console.item_prefix()}Видео: {title} · {duration}")
    elif kind == "metadata":
        console.update_item(event)
        if console.current_items_total <= 1:
            title = event.get("title") or "Видео Boosty"
            author = event.get("author") or event.get("author_handle") or ""
            duration = human_duration(event.get("duration_sec"))
            console.line(f"{title} · {author} · {duration}")
    elif kind == "item_cached":
        prefix = console.item_prefix(event)
        console.line(f"{prefix}Уже готово — пропускаю скачивание и AssemblyAI.")
    elif kind == "download_progress":
        console.progress(event)
    elif kind == "download_processing":
        console.finish_progress()
        console.line(console.item_prefix(event) + "Собираю готовый MP3…")
    elif kind == "download_done":
        console.finish_progress()
        label = "Аудио уже скачано" if event.get("reused") else "Аудио готово"
        console.line(
            f"{console.item_prefix(event)}{label}: {human_bytes(event.get('audio_bytes'))}"
        )
    elif kind == "transcribe_start":
        console.line(console.item_prefix(event) + "Отправляю аудио в AssemblyAI…")
    elif kind == "transcribe_progress":
        stage = event.get("stage")
        if stage == "uploading":
            console.line(console.item_prefix(event) + "AssemblyAI: загружаю файл…")
        elif stage == "queued":
            console.line(console.item_prefix(event) + "AssemblyAI: файл принят, жду обработку…")
        elif stage == "transcribing":
            elapsed = human_duration(event.get("elapsed_sec"))
            console.status(
                f"AssemblyAI: распознаёт речь · прошло {elapsed}",
                event.get("elapsed_sec"),
                event,
            )
        elif stage == "completed":
            console.line(console.item_prefix(event) + "AssemblyAI: транскрибация готова.")
    elif kind == "transcribe_done":
        chars = f"{int(event.get('chars') or 0):,}".replace(",", " ")
        console.line(f"{console.item_prefix(event)}Текст готов: {chars} символов")
    elif kind == "saved":
        console.add_saved(event)
    elif kind == "item_error":
        console.finish_progress()
        console.line(
            f"{console.item_prefix(event)}Ошибка: "
            + str(event.get("message") or "неизвестная ошибка")
        )
    elif kind == "error":
        console.finish_progress()
        console.line("Ошибка: " + str(event.get("message") or "неизвестная ошибка"))


def app_root():
    configured = os.environ.get("SC_DESKTOP_DIR") or os.environ.get("MEDIA_INBOX_DIR")
    return Path(configured) if configured else Path.home() / "Library" / "Application Support" / "sc-desktop"


def find_existing_result(canonical):
    from boosty_single_ndjson import safe_slug

    storage = app_root()
    workers_root = str(Path(__file__).resolve().parents[1])
    if workers_root not in sys.path:
        sys.path.insert(0, workers_root)
    try:
        from shared.settings import load as load_settings
        configured_audio = (load_settings().get("boosty") or {}).get("audio_dir")
    except Exception:
        configured_audio = None
    author_dir = storage / "transcripts" / "boosty" / safe_slug(canonical["author"], 60)
    audio_root = Path(os.path.expanduser(str(configured_audio))).resolve() if configured_audio else storage / "media" / "boosty"
    audio_dir = (
        audio_root / safe_slug(canonical["author"], 60) / canonical["post_id"]
    )
    if not author_dir.is_dir() or not audio_dir.is_dir():
        return None

    matches = []
    pattern = canonical["post_id"] + "__*.txt"
    for text_path in sorted(author_dir.glob(pattern), key=lambda path: path.stat().st_mtime, reverse=True):
        parts = text_path.stem.split("__", 2)
        if len(parts) != 3:
            continue
        video_id = parts[1]
        if canonical.get("video_id") and video_id.lower() != canonical["video_id"].lower():
            continue
        srt_path = text_path.with_suffix(".srt")
        audio_path = audio_dir / ("__".join(parts[1:]) + ".mp3")
        if not all(path.is_file() and path.stat().st_size > 0 for path in (text_path, srt_path, audio_path)):
            continue
        matches.append({
            "audio_path": audio_path,
            "file_path": text_path,
            "srt_path": srt_path,
            "audio_bytes": audio_path.stat().st_size,
        })
    if canonical.get("video_id"):
        return matches[0] if matches else None
    return matches[0] if len(matches) == 1 else None


def show_existing(result):
    print("Уже готово — повторно не скачиваю и не списываю деньги AssemblyAI:", flush=True)
    print("  Аудио: " + str(result["audio_path"]), flush=True)
    print("  Текст:  " + str(result["file_path"]), flush=True)
    print("  Титры:  " + str(result["srt_path"]), flush=True)
    print("  Размер:  " + human_bytes(result["audio_bytes"]), flush=True)


def run_worker(url, auth, metadata_only=False, force=False):
    root = Path(__file__).resolve().parents[2]
    worker = Path(__file__).with_name("boosty_single_ndjson.py")
    storage = app_root()
    workers_root = str(root / "python-workers")
    if workers_root not in sys.path:
        sys.path.insert(0, workers_root)
    try:
        from shared.settings import load as load_settings
        configured_audio = (load_settings().get("boosty") or {}).get("audio_dir")
    except Exception:
        configured_audio = None
    audio_dir = Path(os.path.expanduser(str(configured_audio))).resolve() if configured_audio else storage / "media" / "boosty"
    command = [
        sys.executable,
        str(worker),
        url,
        "--media-dir", str(audio_dir),
        "--transcript-dir", str(storage / "transcripts" / "boosty"),
        "--work-dir", str(storage / "tmp" / "boosty"),
    ]
    if metadata_only:
        command.append("--metadata-only")
    if force:
        command.append("--force-download")

    try:
        from shared.settings import get_api_key
        api_key = get_api_key("ASSEMBLYAI_API_KEY")
    except Exception:
        api_key = None

    child_env = os.environ.copy()
    child_env["SC_BOOSTY_AUTH_COOKIE"] = auth["value"]
    if auth.get("expirationDate") is not None:
        child_env["SC_BOOSTY_AUTH_EXPIRES"] = str(auth["expirationDate"])
    if api_key and not child_env.get("ASSEMBLYAI_API_KEY"):
        child_env["ASSEMBLYAI_API_KEY"] = api_key

    console = Console()
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=child_env,
        start_new_session=True,
    )
    child_env.pop("SC_BOOSTY_AUTH_COOKIE", None)
    auth["value"] = ""
    try:
        for raw_line in process.stdout:
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            show_event(console, event)
        stderr = process.stderr.read() if process.stderr else ""
        code = process.wait()
    except KeyboardInterrupt:
        console.finish_progress()
        console.line("Останавливаю…")
        try:
            os.killpg(process.pid, signal.SIGINT)
            process.wait(timeout=10)
        except Exception:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except Exception:
                pass
        console.line("Остановлено. Незавершённый файл удалён.")
        return 130

    console.finish_progress()
    if console.saved_items:
        saved_items = sorted(
            console.saved_items,
            key=lambda item: int(item.get("item_index") or 1),
        )
        console.line("")
        if len(saved_items) > 1:
            console.line(f"Готово: {len(saved_items)} видео")
        else:
            console.line("Готово:")
        for index, saved in enumerate(saved_items, start=1):
            prefix = f"[{index}/{len(saved_items)}] " if len(saved_items) > 1 else ""
            title = saved.get("title") or "Видео Boosty"
            console.line(f"{prefix}{title}")
            console.line("  Аудио: " + str(saved.get("audio_path") or "—"))
            console.line("  Текст:  " + str(saved.get("file_path") or "—"))
            console.line("  Титры:  " + str(saved.get("srt_path") or "—"))
            console.line("  Размер:  " + human_bytes(saved.get("audio_bytes")))
    if code != 0 and stderr.strip():
        console.line("Python worker завершился с ошибкой.")
    return code


def is_channel_url(value):
    from urllib.parse import urlparse

    parsed = urlparse(value if "://" in value else "https://" + value)
    parts = [part for part in parsed.path.split("/") if part]
    return parsed.netloc.lower().removeprefix("www.") == "boosty.to" and len(parts) == 1


def run_catalog(url, auth, limit=0, order="desc", only_allowed=False):
    from boosty_api import canonicalize_author
    from boosty_single_ndjson import safe_slug

    author = canonicalize_author(url)
    limit = max(0, int(limit or 0))
    order = "asc" if order == "asc" else "desc"
    worker = Path(__file__).with_name("boosty_catalog_ndjson.py")
    command = [
        sys.executable,
        str(worker),
        url,
        "--limit", str(limit),
        "--order", order,
    ]
    if only_allowed:
        command.append("--only-allowed")

    child_env = os.environ.copy()
    child_env["SC_BOOSTY_AUTH_COOKIE"] = auth["value"]
    if auth.get("expirationDate") is not None:
        child_env["SC_BOOSTY_AUTH_EXPIRES"] = str(auth["expirationDate"])
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=child_env,
        start_new_session=True,
    )
    child_env.pop("SC_BOOSTY_AUTH_COOKIE", None)
    auth["value"] = ""
    entity = None
    posts = []
    summary = None
    failure = None
    try:
        for raw_line in process.stdout:
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            kind = event.get("type")
            if kind == "entity":
                entity = event
                print(f"Автор: {event.get('title') or author} · @{event.get('author_handle') or author}", flush=True)
            elif kind == "post" and isinstance(event.get("data"), dict):
                posts.append(event["data"])
            elif kind == "page":
                loaded = int(event.get("loaded") or len(posts))
                total = event.get("remote_total")
                suffix = f" из {int(total)}" if total else ""
                print(f"Получено постов: {loaded}{suffix}", flush=True)
            elif kind == "done":
                summary = event
            elif kind == "error":
                failure = event.get("message") or "Не удалось получить каталог Boosty"
        stderr = process.stderr.read() if process.stderr else ""
        code = process.wait()
    except KeyboardInterrupt:
        try:
            os.killpg(process.pid, signal.SIGINT)
            process.wait(timeout=10)
        except Exception:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except Exception:
                pass
        print("Остановлено. Каталог не перезаписан.", flush=True)
        return 130

    if code != 0 or failure or not entity or summary is None:
        print("Ошибка: " + str(failure or stderr.strip() or f"worker exited {code}"), file=sys.stderr, flush=True)
        return code or 4

    summary = dict(summary)
    if only_allowed:
        summary["catalog_complete"] = False

    output_dir = app_root() / "catalogs" / "boosty"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / (safe_slug(author, 70) + ".json")
    temporary = output_path.with_suffix(".json.part")
    payload = {
        "fetched_at": int(time.time()),
        "query": {
            "limit": limit,
            "order": order,
            "only_allowed": bool(only_allowed),
        },
        "entity": entity,
        "posts": posts,
        "summary": summary,
    }
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, output_path)
    print("", flush=True)
    print(
        f"Готово: {int(summary.get('posts_total') or len(posts))} постов · "
        f"{int(summary.get('videos_total') or 0)} видео",
        flush=True,
    )
    print("Каталог: " + str(output_path), flush=True)
    if summary.get("catalog_complete"):
        print("Охват: вся доступная лента", flush=True)
    elif only_allowed:
        print("Охват: только посты, доступные текущему аккаунту", flush=True)
    elif limit:
        print(f"Охват: ограничен {int(limit)} постами", flush=True)
    return 0


def main(argv):
    parser = argparse.ArgumentParser(
        prog="sc -b",
        description=(
            "Для поста: скачать все доступные видео как MP3 и получить TXT + SRT. "
            "Для ссылки автора: сохранить каталог постов без скачивания видео."
        ),
    )
    parser.add_argument(
        "url",
        help="ссылка boosty.to на автора, весь пост или purchase-ссылка одного видео",
    )
    parser.add_argument("--auth-timeout", type=float, default=20.0, help=argparse.SUPPRESS)
    parser.add_argument("--metadata-only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--force", action="store_true", help="перескачать и транскрибировать заново")
    parser.add_argument("--limit", type=int, default=0, help="для автора: максимум постов; 0 = вся лента")
    parser.add_argument("--oldest-first", action="store_true", help="для автора: запрашивать от старых к новым")
    parser.add_argument("--only-allowed", action="store_true", help="для автора: только доступные посты")
    args = parser.parse_args(argv)

    channel = is_channel_url(args.url)
    try:
        if channel:
            from boosty_api import canonicalize_author
            canonicalize_author(args.url)
            canonical = None
        else:
            from boosty_single_ndjson import canonicalize_boosty_url
            canonical = canonicalize_boosty_url(args.url)
    except Exception as exc:
        print("Ошибка: " + str(exc), file=sys.stderr, flush=True)
        return 2

    if canonical and not args.metadata_only and not args.force:
        existing = find_existing_result(canonical)
        if existing:
            show_existing(existing)
            return 0

    print("Получаю авторизацию Boosty из браузера…", flush=True)
    try:
        auth = request_browser_auth(max(3.0, args.auth_timeout))
    except Exception as exc:
        print("Ошибка: " + str(exc), file=sys.stderr, flush=True)
        return 3
    if channel:
        return run_catalog(
            args.url,
            auth,
            limit=args.limit,
            order="asc" if args.oldest_first else "desc",
            only_allowed=args.only_allowed,
        )
    return run_worker(
        args.url,
        auth,
        metadata_only=args.metadata_only,
        force=args.force,
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
