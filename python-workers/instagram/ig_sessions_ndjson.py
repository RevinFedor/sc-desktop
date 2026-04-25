#!/usr/bin/env python3
"""Instagram session inventory for SC Desktop UI.

Emits ndjson events. Two subcommands:

  list
      Look at ~/.config/sc/instagram_session.json (Playwright storage_state)
      and ~/.config/sc/instagram_api_session.json (flat cookies dict). Emit
      one {type:'session', kind:'playwright'|'api', ...} per file plus a
      final {type:'done'}. Each session event tells whether sessionid was
      present (== authorized) and the username from ds_user_id if available.

  delete --kind playwright|api|both
      Remove the requested session file(s). Emits {type:'deleted', kind} or
      {type:'error', message} on failure.

This script never logs in. Login is done by the user via `sc -i --login` in
the terminal.
"""
import sys
import json
import argparse
from pathlib import Path

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


def _read_playwright(path):
    """Returns (authorized, username, error). Playwright storage_state
    has cookies as a list of dicts."""
    try:
        data = json.loads(path.read_text("utf-8"))
        cookies_list = data.get("cookies") or []
        cookies = {c.get("name"): c.get("value") for c in cookies_list if c.get("name")}
        sessionid = cookies.get("sessionid")
        if not sessionid:
            return False, None, "no sessionid cookie"
        return True, _extract_username(cookies), None
    except FileNotFoundError:
        return False, None, "file not found"
    except json.JSONDecodeError as ex:
        return False, None, f"invalid JSON: {ex}"
    except Exception as ex:
        return False, None, f"{type(ex).__name__}: {ex}"


def _read_api(path):
    """Returns (authorized, username, error). API session is a flat dict
    saved by ig_api_core.py — {cookies: {name: value, ...}}."""
    try:
        data = json.loads(path.read_text("utf-8"))
        cookies = data.get("cookies") or {}
        sessionid = cookies.get("sessionid")
        if not sessionid:
            return False, None, "no sessionid cookie"
        return True, _extract_username(cookies), None
    except FileNotFoundError:
        return False, None, "file not found"
    except json.JSONDecodeError as ex:
        return False, None, f"invalid JSON: {ex}"
    except Exception as ex:
        return False, None, f"{type(ex).__name__}: {ex}"


def cmd_list():
    # Playwright session.
    if PLAYWRIGHT_FILE.exists():
        ok, user, err = _read_playwright(PLAYWRIGHT_FILE)
        emit({
            "type": "session",
            "kind": "playwright",
            "path": str(PLAYWRIGHT_FILE),
            "authorized": ok,
            "user_id": user,
            "error": err,
        })
    # Android API session.
    if API_FILE.exists():
        ok, user, err = _read_api(API_FILE)
        emit({
            "type": "session",
            "kind": "api",
            "path": str(API_FILE),
            "authorized": ok,
            "user_id": user,
            "error": err,
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
    sub.add_parser("list")
    p = sub.add_parser("delete")
    p.add_argument("--kind", required=True, choices=("playwright", "api", "both"))
    args = ap.parse_args()
    try:
        if args.cmd == "list":
            cmd_list()
        elif args.cmd == "delete":
            cmd_delete(args.kind)
    except KeyboardInterrupt:
        emit({"type": "error", "message": "interrupted"})
        sys.exit(130)


if __name__ == "__main__":
    main()
