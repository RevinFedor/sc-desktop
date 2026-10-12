"""Bounded session discovery and local, non-logging interactive Telegram login.

Uses the desktop Telethon/session helpers. Never selects a global active account.
Secrets remain in this process: no argv, JSON event or exception text contains them.
Phone and Telegram code echo on the local TTY; the 2FA password stays hidden.
"""
import asyncio
import contextlib
import getpass
import io
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path


class AccountAuthError(RuntimeError):
    def __init__(self, code, message, *, outcome="failed", session_name=None):
        super().__init__(message)
        self.code, self.outcome, self.session_name = code, outcome, session_name


def profile(user):
    return {key: getattr(user, key, None) for key in ("id", "first_name", "last_name", "username", "phone")}


def public_profile(me):
    if not isinstance(me, dict):
        return None
    out = {key: me.get(key) for key in ("id", "first_name", "last_name", "username", "last_seen") if key in me}
    digits = re.sub(r"\D", "", str(me.get("phone") or ""))
    if digits:
        out["phone_masked"] = "••••" + digits[-4:]
    return out


@contextlib.contextmanager
def quiet_rpc():
    stdout, stderr = sys.stdout, sys.stderr
    try:
        sys.stdout, sys.stderr = io.StringIO(), io.StringIO()
        yield
    finally:
        sys.stdout, sys.stderr = stdout, stderr


async def rpc(awaitable, timeout):
    with quiet_rpc():
        return await asyncio.wait_for(awaitable, timeout)


async def close_client(client, timeout=1):
    if client is not None:
        try:
            await rpc(client.disconnect(), timeout)
        except (Exception, asyncio.CancelledError):
            pass


def session_files(directories):
    seen, paths = set(), []
    for directory in directories:
        if not Path(directory).is_dir():
            continue
        for path in sorted(Path(directory).glob("*.session")):
            if path.name not in seen:
                seen.add(path.name)
                paths.append(path)
    return paths


def configure_client(client):
    # Keep a contested existing session from blocking inventory beyond its RPC
    # deadline. This does not serialize or interrupt a running fetch.
    try:
        conn = getattr(client.session, "_conn", None)
        if conn is not None:
            conn.execute("PRAGMA busy_timeout = 1000")
    except Exception:
        pass


async def inspect_session(path, factory, read_meta, write_meta, *, timeout=6, redact=False):
    cached = read_meta(path) or {}
    row = {"name": path.stem, "path": str(path), "authorized": None,
           "authorization_state": "unknown", "verified_at": None, "me": None,
           "me_cached": public_profile(cached) if redact else cached or None,
           "label": cached.get("label") if isinstance(cached, dict) else None}
    client = None
    async def inspect():
        nonlocal client
        client = factory(path)
        configure_client(client)
        await client.connect()
        authorized = await client.is_user_authorized()
        if not authorized:
            return False, None
        user = await client.get_me()
        if user is None or isinstance(getattr(user, "id", None), bool) or not isinstance(getattr(user, "id", None), int) or user.id <= 0:
            raise AccountAuthError("session_identity_unavailable", "Telegram не подтвердил account ID.", outcome="unknown")
        return True, profile(user)
    try:
        authorized, me = await rpc(inspect(), timeout)
        row.update(authorized=authorized, authorization_state="authorized" if authorized else "unauthorized",
                   verified_at=time.time(), me=public_profile(me) if redact else me)
        if me:
            write_meta(path, me)
            row["me_cached"] = None
            if cached.get("id") != me["id"]:
                row["label"] = None
    except Exception as error:
        row["error_code"] = "session_inventory_timeout" if isinstance(error, asyncio.TimeoutError) else getattr(error, "code", "session_inventory_network_error")
        if type(error).__name__ == "OperationalError":
            row["error_code"] = "session_inventory_busy"
        row["error"] = "Статус авторизации неизвестен: discovery не завершился. Это не отсутствие аккаунта."
    finally:
        await close_client(client)
    return row


async def inventory(paths, factory, read_meta, write_meta, emit, *, timeout=6, total_timeout=25, redact=False):
    started, unknown = time.monotonic(), 0
    for path in paths:
        remaining = total_timeout - (time.monotonic() - started)
        if remaining <= 1:
            cached = read_meta(path) or {}
            row = {"name": path.stem, "path": str(path), "authorized": None,
                   "authorization_state": "unknown", "verified_at": None, "me": None,
                   "me_cached": public_profile(cached) if redact else cached or None,
                   "label": cached.get("label"), "error_code": "session_inventory_deadline",
                   "error": "Общий deadline discovery; отсутствие аккаунта не доказано."}
        else:
            row = await inspect_session(path, factory, read_meta, write_meta, timeout=min(timeout, remaining - 1), redact=redact)
        unknown += row["authorized"] is None
        emit({"type": "session", **row})
    emit({"type": "done", "count": len(paths), "enumeration_complete": True,
          "verification_complete": unknown == 0, "unknown_count": unknown})


def hidden_input(prompt):
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise AccountAuthError("interactive_terminal_required", "Запусти команду сам в локальном терминале, не через AI или pipe.")
    return getpass.getpass(prompt)


def visible_input(prompt):
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise AccountAuthError("interactive_terminal_required", "Запусти команду сам в локальном терминале, не через AI или pipe.")
    return input(prompt)


def reserve_session(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    for _ in range(10):
        path = directory / ("session_" + uuid.uuid4().hex + ".session")
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(descriptor)
            return path
        except FileExistsError:
            continue
    raise AccountAuthError("session_reservation_failed", "Не удалось выделить новую сессию; старые файлы не менялись.")


def remove_owned_session(path):
    # Only the exact newly-reserved UUID, never an existing session or a glob.
    if not re.fullmatch(r"session_[0-9a-f]{32}\.session", Path(path).name):
        raise AccountAuthError("session_cleanup_refused", "Нельзя удалять существующую сессию.")
    for suffix in ("", "-journal", "-wal", "-shm", ".meta.json"):
        try:
            Path(str(path) + suffix).unlink()
        except FileNotFoundError:
            pass


async def interactive_login(*, directory, directories, factory, read_meta, write_meta,
                            label=None, expected_account_id=None, input_reader=visible_input,
                            secret_reader=hidden_input,
                            confirm=None, say=print, timeout=20):
    if label is not None and (not isinstance(label, str) or not label.strip() or len(label) > 120):
        raise AccountAuthError("invalid_account_label", "Название аккаунта должно быть непустым и не длиннее120символов.")
    if expected_account_id is not None and (isinstance(expected_account_id, bool) or not isinstance(expected_account_id, int) or expected_account_id <= 0):
        raise AccountAuthError("invalid_account_id", "Нужен положительный точный account ID.")
    phone = input_reader("Телефон в международном формате (+...): ").strip()
    if not re.fullmatch(r"\+[0-9 ()-]{7,22}", phone):
        raise AccountAuthError("invalid_phone", "Нужен международный телефон с +.")
    phone = "+" + re.sub(r"\D", "", phone)
    existing = session_files(directories)
    # A cached number is used only locally, to verify an already-connected
    # account BEFORE requesting another code. Cached data alone proves nothing.
    for old in existing:
        cached = read_meta(old) or {}
        if re.sub(r"\D", "", str(cached.get("phone") or "")) != phone[1:]:
            continue
        row = await inspect_session(old, factory, read_meta, write_meta, timeout=min(timeout, 6))
        if row["authorized"] is None:
            raise AccountAuthError("existing_account_unknown", "Проверка существующего аккаунта не завершилась; новый код не запрошен.", outcome="unknown", session_name=old.stem)
        if row["authorized"]:
            me = row["me"]
            check_identity(me, expected_account_id)
            confirm_identity(me, label, confirm, say)
            write_meta(old, {**me, **({"label": label.strip()} if label else {})})
            return {"session_name": old.stem, "account_id": me["id"], "me": public_profile(me), "reused": True,
                    "authorized": True, "verified_at": row["verified_at"], "active_changed": False}

    path, client, authorized, uncertain, success = reserve_session(directory), None, False, False, False
    try:
        client = factory(path)
        configure_client(client)
        await rpc(client.connect(), timeout)
        uncertain = True
        sent = await rpc(client.send_code_request(phone), timeout)
        uncertain = False
        say("Код запрошен. Введи его только здесь; AI его не получает.")
        needs_password = False
        for _ in range(5):
            code = input_reader("Telegram-код: ").strip()
            try:
                uncertain = True
                await rpc(client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash), timeout)
                uncertain, authorized = False, True
                break
            except Exception as error:
                kind = type(error).__name__
                if kind == "SessionPasswordNeededError":
                    uncertain, needs_password = False, True
                    break
                if kind == "PhoneCodeInvalidError":
                    uncertain = False
                    say("Код неверный, попробуй ещё раз.")
                    continue
                if kind == "PhoneCodeExpiredError":
                    uncertain = False
                    raise AccountAuthError("code_expired", "Код истёк. Новый код автоматически не запрашивался.")
                raise
        if needs_password:
            for _ in range(5):
                password = secret_reader("2FA-пароль (ввод скрыт): ")
                try:
                    uncertain = True
                    await rpc(client.sign_in(password=password), timeout)
                    uncertain, authorized = False, True
                    break
                except Exception as error:
                    if type(error).__name__ == "PasswordHashInvalidError":
                        uncertain = False
                        say("Пароль неверный, попробуй ещё раз.")
                        continue
                    raise
        if not authorized:
            raise AccountAuthError("attempts_exhausted", "Ввод не подтверждён; старые аккаунты не менялись.")
        user = await rpc(client.get_me(), timeout)
        if user is None:
            raise AccountAuthError("auth_identity_unavailable", "Вход не подтверждён get_me; сохрани имя сессии для проверки.", outcome="unknown", session_name=path.stem)
        me = profile(user)
        check_identity(me, expected_account_id)
        confirm_identity(me, label, confirm, say)
        write_meta(path, {**me, **({"label": label.strip()} if label else {})})
        success = True
        return {"session_name": path.stem, "account_id": me["id"], "me": public_profile(me), "reused": False,
                "authorized": True, "verified_at": time.time(), "active_changed": False}
    except (KeyboardInterrupt, EOFError, asyncio.CancelledError) as error:
        raise AccountAuthError("login_cancelled", "Вход отменён. Старые аккаунты и global active не менялись.",
                               outcome="unknown" if uncertain or authorized else "cancelled", session_name=path.stem if uncertain or authorized else None) from None
    except AccountAuthError as error:
        if (authorized or uncertain) and error.session_name is None:
            error.session_name = path.stem
        raise
    except Exception as error:
        code = "login_network_timeout" if isinstance(error, asyncio.TimeoutError) else "login_network_error"
        if type(error).__name__ == "FloodWaitError":
            code = "login_flood_wait"
        raise AccountAuthError(code, "Сеть/deadline/лимит прервал вход; повтор автоматически не выполнялся.",
                               outcome="unknown" if uncertain or authorized else "failed", session_name=path.stem if uncertain or authorized else None) from None
    finally:
        await close_client(client)
        if not success and not authorized and not uncertain:
            remove_owned_session(path)


def check_identity(me, expected):
    if not isinstance(me.get("id"), int) or isinstance(me.get("id"), bool) or me["id"] <= 0:
        raise AccountAuthError("auth_identity_unavailable", "Telegram не подтвердил account ID.", outcome="unknown")
    if expected is not None and me["id"] != expected:
        raise AccountAuthError("account_id_mismatch", "Введённый аккаунт не совпал с заданным ID; старые сессии не менялись.")


def confirm_identity(me, label, confirm, say):
    title = " ".join(str(me.get(key) or "") for key in ("first_name", "last_name")).strip()
    say(f"Подтверждён account ID {me['id']}: {title}" + (f" @{me['username']}" if me.get("username") else ""))
    if label:
        check = confirm or (lambda prompt: input(prompt).strip().casefold() in ("y", "yes", "д", "да"))
        if not check(f"Это нужный аккаунт для «{label.strip()}»? [y/N]: "):
            raise AccountAuthError("identity_not_confirmed", "Метка не назначена: пользователь не подтвердил аккаунт.")
