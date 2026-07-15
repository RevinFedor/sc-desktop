#!/usr/bin/env python3
"""Instagram session inventory for SC Desktop UI.

Emits ndjson events. Two subcommands:

  list
      Look at ~/.config/sc/instagram_session.json (Playwright storage_state)
      and ~/.config/sc/instagram_api_session.json (flat cookies dict). Emit
      one {type:'session', kind:'playwright'|'api', ...} per file plus a
      final {type:'done'}. Add --check to verify the cookie against Instagram.

  delete --kind playwright|api|both
      Remove the requested session file(s). Emits {type:'deleted', kind} or
      {type:'error', message} on failure.

This script never logs in. Login is done by ig_login_ndjson.py.
"""
import sys
import json
import argparse
import contextlib
import io
import time
from pathlib import Path

import requests

SESSION_DIR = Path.home() / ".config" / "sc"
PLAYWRIGHT_FILE = SESSION_DIR / "instagram_session.json"
API_FILE        = SESSION_DIR / "instagram_api_session.json"


def emit(ev):
    sys.stdout.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def _extract_username(cookies):
    # ds_user_id holds the numeric user id; for the username we'd need to
    # call the API. Return the numeric id as a stand-in display label so the
    # UI has *something* to show without a network round-trip.
    if not cookies:
        return None
    return cookies.get("ds_user_id") or None


def _network_check(cookies):
    if not cookies or not cookies.get("sessionid"):
        return {
            "status": "missing",
            "ok": False,
            "message": "no sessionid cookie",
        }
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "X-IG-App-ID": "936619743392459",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://www.instagram.com/accounts/edit/",
    }
    try:
        r = requests.get(
            "https://www.instagram.com/api/v1/accounts/edit/web_form_data/",
            headers=headers,
            cookies=cookies,
            timeout=15,
            allow_redirects=False,
        )
    except Exception as ex:
        return {
            "status": "error",
            "ok": False,
            "message": f"{type(ex).__name__}: {ex}",
        }

    content_type = r.headers.get("content-type", "")
    if r.status_code != 200:
        return {
            "status": "invalid",
            "ok": False,
            "http_status": r.status_code,
            "message": f"HTTP {r.status_code}",
        }
    if "application/json" not in content_type:
        return {
            "status": "invalid",
            "ok": False,
            "http_status": r.status_code,
            "message": "Instagram returned login page, not session JSON",
        }
    try:
        data = r.json()
    except Exception as ex:
        return {
            "status": "invalid",
            "ok": False,
            "http_status": r.status_code,
            "message": f"invalid JSON: {ex}",
        }

    form = data.get("form_data") or {}
    username = form.get("username") or data.get("username")
    if data.get("status") == "ok" and (username or form):
        return {
            "status": "valid",
            "ok": True,
            "http_status": r.status_code,
            "username": username,
            "message": "session accepted",
        }
    return {
        "status": "invalid",
        "ok": False,
        "http_status": r.status_code,
        "message": data.get("message") or "session JSON did not include account data",
    }


def _android_network_check():
    """Verify the API file against a real authenticated Android endpoint."""
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            from ig_api_core import IGAPIClient
            client = IGAPIClient()
            payload = client._request("discover/media_metadata/", params={"media_id": "1"}) \
                if client.user_id else None
    except Exception as ex:
        return {
            "status": "error",
            "ok": False,
            "message": f"{type(ex).__name__}: {ex}",
        }

    response = getattr(client, "last_response", None)
    http_status = getattr(response, "status_code", None)
    payload = payload if isinstance(payload, dict) else (
        client.last_json if isinstance(client.last_json, dict) else {}
    )
    if http_status == 200 and payload.get("status") == "ok":
        web_health = _network_check(client.cookies)
        return {
            "status": "valid",
            "ok": True,
            "http_status": http_status,
            "username": web_health.get("username") if web_health.get("ok") else None,
            "message": "Android API session accepted",
        }
    return {
        "status": "invalid",
        "ok": False,
        "http_status": http_status,
        "message": payload.get("message") or payload.get("error_type")
                   or (f"HTTP {http_status}" if http_status else "empty Android API response"),
    }


def _file_meta(path):
    try:
        st = path.stat()
        return {
            "mtime": int(st.st_mtime),
            "age_days": round((time.time() - st.st_mtime) / 86400, 1),
        }
    except Exception:
        return {}


def _read_playwright(path, check=False):
    """Returns (authorized, username, error). Playwright storage_state
    has cookies as a list of dicts."""
    try:
        data = json.loads(path.read_text("utf-8"))
        cookies_list = data.get("cookies") or []
        cookies = {c.get("name"): c.get("value") for c in cookies_list if c.get("name")}
        sessionid = cookies.get("sessionid")
        if not sessionid:
            return False, None, "no sessionid cookie", {}
        health = _network_check(cookies) if check else {"status": "unchecked", "ok": None}
        return True, _extract_username(cookies), None, health
    except FileNotFoundError:
        return False, None, "file not found", {}
    except json.JSONDecodeError as ex:
        return False, None, f"invalid JSON: {ex}", {}
    except Exception as ex:
        return False, None, f"{type(ex).__name__}: {ex}", {}


def _read_api(path, check=False):
    """Returns (authorized, username, error) for cookies + device state."""
    try:
        data = json.loads(path.read_text("utf-8"))
        cookies = data.get("cookies") or {}
        sessionid = cookies.get("sessionid")
        if not sessionid:
            return False, None, "no sessionid cookie", {}
        health = _android_network_check() if check else {"status": "unchecked", "ok": None}
        return True, _extract_username(cookies), None, health
    except FileNotFoundError:
        return False, None, "file not found", {}
    except json.JSONDecodeError as ex:
        return False, None, f"invalid JSON: {ex}", {}
    except Exception as ex:
        return False, None, f"{type(ex).__name__}: {ex}", {}


def cmd_list(check=False):
    # Playwright session.
    if PLAYWRIGHT_FILE.exists():
        ok, user, err, health = _read_playwright(PLAYWRIGHT_FILE, check=check)
        emit({
            "type": "session",
            "kind": "playwright",
            "path": str(PLAYWRIGHT_FILE),
            "authorized": ok,
            "user_id": user,
            "error": err,
            "health": health,
            **_file_meta(PLAYWRIGHT_FILE),
        })
    # Android API session.
    if API_FILE.exists():
        ok, user, err, health = _read_api(API_FILE, check=check)
        emit({
            "type": "session",
            "kind": "api",
            "path": str(API_FILE),
            "authorized": ok,
            "user_id": user,
            "error": err,
            "health": health,
            **_file_meta(API_FILE),
        })
    emit({"type": "done"})


def cmd_delete(kind):
    targets = []
    if kind in ("playwright", "both"):
        targets.append(("playwright", PLAYWRIGHT_FILE))
    if kind in ("api", "both"):
        targets.append(("api", API_FILE))
    if not targets:
        emit({"type": "error", "message": f"unknown kind: {kind}"})
        sys.exit(2)

    removed = []
    for k, path in targets:
        if path.exists():
            try:
                path.unlink()
                removed.append(k)
            except Exception as ex:
                emit({"type": "error", "message": f"{type(ex).__name__}: {ex}"})
                sys.exit(2)
    emit({"type": "deleted", "kinds": removed})


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_list = sub.add_parser("list")
    p_list.add_argument("--check", action="store_true")
    p = sub.add_parser("delete")
    p.add_argument("--kind", required=True, choices=("playwright", "api", "both"))
    args = ap.parse_args()
    try:
        if args.cmd == "list":
            cmd_list(check=args.check)
        elif args.cmd == "delete":
            cmd_delete(args.kind)
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(130)


if __name__ == "__main__":
    main()
