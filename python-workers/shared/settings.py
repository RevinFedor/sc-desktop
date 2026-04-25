"""Settings storage for sc CLI.

Reads/writes ~/.config/sc/settings.json with per-platform defaults.
All platform cores import from here instead of hardcoding values.
"""
import json
import os
from pathlib import Path

SETTINGS_DIR = Path.home() / ".config" / "sc"
SETTINGS_FILE = SETTINGS_DIR / "settings.json"


def _app_root():
    return Path(
        os.environ.get("SC_DESKTOP_DIR")
        or os.environ.get("MEDIA_INBOX_DIR")
        or (Path.home() / "Library" / "Application Support" / "sc-desktop")
    )

DEFAULTS = {
    "global": {
        "output_dir": str(_app_root() / "output"),
        "max_cost_per_session": None,
    },
    "instagram": {
        "backend": "auto",          # auto | api | browser | apify
        "viewport": "1920x1080",    # for browser backend
        "apify_token": None,
        "download_videos": False,   # save mp4 alongside transcript
    },
    "telegram": {
        "model": "gemini-2.5-flash",
        "engine": "gemini",         # gemini | assemblyai
        "max_preview_items": 30,
    },
    "youtube": {
        "preferred_lang": "ru",
        "engine": "gemini",         # gemini | assemblyai
        "video_codec": "h264",      # h264 | av1
    },
    "tiktok": {
        "preferred_engine": "tikwm",  # tikwm | yt-dlp
    },
    "reddit": {
        "backend": "api",   # api (browser cookies, free) | auto (api→apify) | apify
    },
    "api_keys": {
        "GEMINI_API_KEY": None,
        "ASSEMBLYAI_API_KEY": None,
        "OPENAI_API_KEY": None,
        "TELEGRAM_API_ID": None,
        "TELEGRAM_API_HASH": None,
    },
}


def _deep_merge(base, override):
    """Recursive dict merge — override wins, but missing keys come from base."""
    result = dict(base)
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def load():
    """Load settings.json merged with DEFAULTS. Always returns full structure."""
    if not SETTINGS_FILE.exists():
        return json.loads(json.dumps(DEFAULTS))
    try:
        with open(SETTINGS_FILE) as f:
            user = json.load(f)
        return _deep_merge(DEFAULTS, user)
    except (json.JSONDecodeError, OSError):
        return json.loads(json.dumps(DEFAULTS))


def save(settings):
    """Write settings to disk. Only saves keys that differ from DEFAULTS."""
    SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)


def get(platform, key, default=None):
    """Convenience accessor: settings.get('instagram', 'backend')."""
    s = load()
    return s.get(platform, {}).get(key, default)


def set_value(platform, key, value):
    """Update one key and persist."""
    s = load()
    if platform not in s:
        s[platform] = {}
    s[platform][key] = value
    save(s)
    return s


def get_apify_token():
    """Return Apify token from settings.json, falling back to ~/.config/sc/apify_token."""
    tok = get("instagram", "apify_token")
    if tok:
        return tok
    legacy = SETTINGS_DIR / "apify_token"
    if legacy.exists():
        try:
            return legacy.read_text().strip() or None
        except OSError:
            return None
    return None


def get_api_key(name):
    """Return a shared API key from env or settings.json."""
    import os

    value = os.environ.get(name)
    if value:
        return value.strip()
    keys = load().get("api_keys", {})
    value = keys.get(name)
    return str(value).strip() if value else None
