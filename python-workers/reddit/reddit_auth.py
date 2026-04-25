"""Cookie loading for Reddit JSON endpoints.

Reddit blocks anonymous .json scraping, but the same endpoints work with a
logged-in browser session. Keep this helper small and side-effect free: callers
decide whether failing auth should stop or fall back to a paid backend.
"""
import contextlib
import io
import os
import sys


AUTH_COOKIE_NAMES = ("reddit_session", "token_v2")

DEFAULT_BROWSERS = (
    "firefox",
    "chrome",
    "chromium",
    "brave",
    "arc",
    "edge",
    "opera",
    "opera_gx",
    "vivaldi",
    "safari",
)


@contextlib.contextmanager
def _silenced():
    saved_out, saved_err = sys.stdout, sys.stderr
    try:
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        yield
    finally:
        sys.stdout = saved_out
        sys.stderr = saved_err


def _has_auth(cookies):
    return any(cookies.get(name) for name in AUTH_COOKIE_NAMES)


def _parse_cookie_header(header):
    cookies = {}
    for part in (header or "").split(";"):
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        name = name.strip()
        if name:
            cookies[name] = value.strip()
    return cookies


def _browser_order():
    raw = os.environ.get("SC_REDDIT_COOKIE_BROWSERS", "")
    names = [x.strip().lower() for x in raw.split(",") if x.strip()] or list(DEFAULT_BROWSERS)
    seen = set()
    ordered = []
    for name in names:
        if name not in seen:
            ordered.append(name)
            seen.add(name)
    return ordered


def load_reddit_cookies():
    """Return (cookies, source_label) for a logged-in Reddit browser session.

    Supports an explicit SC_REDDIT_COOKIE_HEADER for tests/bridge integrations,
    then falls back to browser_cookie3-supported local browsers.
    """
    attempts = []

    header = os.environ.get("SC_REDDIT_COOKIE_HEADER")
    if header:
        cookies = _parse_cookie_header(header)
        if _has_auth(cookies):
            return cookies, "env:SC_REDDIT_COOKIE_HEADER"
        attempts.append("env:SC_REDDIT_COOKIE_HEADER: missing reddit_session/token_v2")

    try:
        with _silenced():
            import browser_cookie3
    except Exception as ex:
        raise RuntimeError(f"browser_cookie3 import failed: {ex}")

    for name in _browser_order():
        fn = getattr(browser_cookie3, name, None)
        if not callable(fn):
            attempts.append(f"{name}: unsupported by browser_cookie3")
            continue
        try:
            with _silenced():
                cj = fn(domain_name="reddit.com")
            cookies = {c.name: c.value for c in cj}
        except Exception as ex:
            attempts.append(f"{name}: {type(ex).__name__}: {str(ex)[:140]}")
            continue
        if _has_auth(cookies):
            return cookies, name
        attempts.append(f"{name}: {len(cookies)} cookies, no auth")

    raise RuntimeError(
        "No logged-in reddit.com cookies found. "
        "Tried: " + "; ".join(attempts)
    )
