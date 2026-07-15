#!/usr/bin/env python3
"""Interactive Instagram login for SC Desktop.

Opens a headed Chrome window via Playwright, waits until Instagram sets
`sessionid`, then saves both session formats used by the desktop app:

  ~/.config/sc/instagram_session.json      Playwright storage_state
  ~/.config/sc/instagram_api_session.json  cookies + persistent Android device
"""
import argparse
import contextlib
import io
import json
import sys
import time
from pathlib import Path

SESSION_DIR = Path.home() / ".config" / "sc"
PLAYWRIGHT_FILE = SESSION_DIR / "instagram_session.json"
API_FILE = SESSION_DIR / "instagram_api_session.json"


def emit(ev):
    sys.stdout.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def _flat_cookies(cookies):
    return {c.get("name"): c.get("value") for c in cookies if c.get("name")}


def _save_api_session(cookies):
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from ig_api_core import IGAPIClient
        client = IGAPIClient()
        client._load_cookies(_flat_cookies(cookies))
        client._save_session()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout-sec", type=int, default=600)
    ap.add_argument("--channel", default="chrome", help="Playwright channel, default: chrome")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
        from ig_sessions_ndjson import _network_check
    except Exception as ex:
        emit({
            "type": "error",
            "code": "playwright_missing",
            "message": (
                "Playwright не установлен в .venv. Выполни: "
                "cd ~/Desktop/sc-desktop && .venv/bin/python -m pip install -r python-workers/requirements.txt"
            ),
            "detail": f"{type(ex).__name__}: {ex}",
        })
        sys.exit(2)

    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    emit({"type": "start", "message": "opening Instagram login window"})

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel=args.channel, headless=False)
            context_kwargs = {}
            if PLAYWRIGHT_FILE.exists():
                context_kwargs["storage_state"] = str(PLAYWRIGHT_FILE)
            context = browser.new_context(**context_kwargs)
            page = context.new_page()
            page.goto("https://www.instagram.com/accounts/login/", wait_until="domcontentloaded")
            emit({"type": "opened", "url": page.url})

            deadline = time.time() + max(1, args.timeout_sec)
            last_report = 0
            last_wait_message = None
            one_tap_attempted = False
            cookies = []
            while time.time() < deadline:
                if not one_tap_attempted:
                    for label in ("Продолжить", "Continue"):
                        button = page.get_by_text(label, exact=True)
                        if button.count() > 0 and button.first.is_visible():
                            button.first.click()
                            one_tap_attempted = True
                            emit({"type": "one_tap", "message": "continuing saved Instagram account"})
                            break
                cookies = context.cookies("https://www.instagram.com")
                flat = _flat_cookies(cookies)
                now = time.time()
                if now - last_report >= 5:
                    health = _network_check(flat) if flat.get("sessionid") else None
                    if health and health.get("ok"):
                        for label in ("Сохранить данные", "Сохранить", "Save info", "Save"):
                            action = page.get_by_text(label, exact=True)
                            if action.count() > 0 and action.first.is_visible():
                                action.first.click()
                                emit({"type": "save_login", "message": "saved Instagram login in browser session"})
                                page.wait_for_timeout(500)
                                break
                        context.storage_state(path=str(PLAYWRIGHT_FILE))
                        _save_api_session(cookies)
                        emit({
                            "type": "logged_in",
                            "user_id": flat.get("ds_user_id") or flat.get("sessionid", "").split(":", 1)[0],
                            "username": health.get("username"),
                            "playwright_path": str(PLAYWRIGHT_FILE),
                            "api_path": str(API_FILE),
                        })
                        browser.close()
                        emit({"type": "done"})
                        return
                    wait_message = health.get("message") if health else (
                        "manual credentials required" if one_tap_attempted
                        else "waiting for Instagram login"
                    )
                    if wait_message != last_wait_message or now - last_report >= 30:
                        emit({"type": "waiting", "message": wait_message})
                        last_wait_message = wait_message
                    last_report = now
                page.wait_for_timeout(1000)

            emit({"type": "error", "code": "login_timeout", "message": "Instagram login timeout"})
            browser.close()
            sys.exit(3)
    except Exception as ex:
        emit({"type": "error", "code": "login_failed", "message": f"{type(ex).__name__}: {ex}"})
        sys.exit(1)


if __name__ == "__main__":
    main()
