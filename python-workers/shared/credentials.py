import json
import os
from pathlib import Path


SETTINGS_FILE = Path.home() / ".config" / "sc" / "settings.json"


def _load_settings():
    try:
        return json.loads(SETTINGS_FILE.read_text("utf-8"))
    except Exception:
        return {}


def _lookup(settings, *paths):
    for path in paths:
        cur = settings
        ok = True
        for part in path:
            if not isinstance(cur, dict) or part not in cur:
                ok = False
                break
            cur = cur[part]
        if ok and cur is not None:
            value = str(cur).strip()
            if value:
                return value
    return None


def secret(env_name, *settings_paths):
    value = os.environ.get(env_name)
    if value:
        return value.strip()
    settings = _load_settings()
    return _lookup(settings, *settings_paths)


def telegram_credentials():
    settings = _load_settings()
    api_id = os.environ.get("TELEGRAM_API_ID") or _lookup(
        settings,
        ("telegram", "api_id"),
        ("api_keys", "TELEGRAM_API_ID"),
        ("api", "telegram_api_id"),
    )
    api_hash = os.environ.get("TELEGRAM_API_HASH") or _lookup(
        settings,
        ("telegram", "api_hash"),
        ("api_keys", "TELEGRAM_API_HASH"),
        ("api", "telegram_api_hash"),
    )
    if not api_id or not api_hash:
        raise RuntimeError(
            "Telegram API credentials are not configured. Set TELEGRAM_API_ID "
            "and TELEGRAM_API_HASH in env or ~/.config/sc/settings.json."
        )
    try:
        api_id = int(str(api_id).strip())
    except ValueError as exc:
        raise RuntimeError("TELEGRAM_API_ID must be an integer") from exc
    return api_id, str(api_hash).strip()
