#!/usr/bin/env python3
"""
Lightweight Instagram API client — pure requests, no browser, no Docker.
Based on reverse-engineered Instagram Private API (Android).
RAM: ~50MB instead of 1GB. Speed: seconds instead of minutes.

Sources: instagrapi (github.com/subzeroid/instagrapi), HH Applicant Tool pattern.
"""

import sys
import os
import json
import time
import random
import hashlib
import uuid
import re
import urllib.parse
from pathlib import Path
from datetime import datetime

import requests

# ─── Constants (from instagrapi config.py) ────────────────────────────────

API_DOMAIN = "i.instagram.com"


def _desktop_output_path(filename):
    root = Path(
        os.environ.get("SC_DESKTOP_DIR")
        or os.environ.get("MEDIA_INBOX_DIR")
        or (Path.home() / "Library" / "Application Support" / "sc-desktop")
    )
    return str(root / "output" / "instagram" / filename)

APP_SETTINGS = {
    "385.0.0.47.74": {
        "app_version": "385.0.0.47.74",
        "version_code": "378906843",
        "bloks_versioning_id": "a8973d49a9cc6a6f65a4997c10216ce2a06f65a517010e64885e92029bb19221",
    },
    "364.0.0.35.86": {
        "app_version": "364.0.0.35.86",
        "version_code": "374010953",
        "bloks_versioning_id": "8ccf54aad76788a6ca03ddfc33afcdcf692f2f5a3ba814ea73d5facba7fa2c2d",
    },
}

USER_AGENT_BASE = (
    "Instagram {app_version} "
    "Android ({android_version}/{android_release}; "
    "{dpi}; {resolution}; {manufacturer}; "
    "{model}; {device}; {cpu}; {locale}; {version_code})"
)

DEVICE_SETTINGS = {
    "android_version": 26,
    "android_release": "8.0.0",
    "dpi": "480dpi",
    "resolution": "1080x1920",
    "manufacturer": "OnePlus",
    "device": "devitron",
    "model": "6T Dev",
    "cpu": "qcom",
}

SESSION_DIR = Path.home() / ".config" / "sc"
SESSION_FILE = SESSION_DIR / "instagram_api_session.json"
PLAYWRIGHT_SESSION = SESSION_DIR / "instagram_session.json"
USER_ID_CACHE = SESSION_DIR / "instagram_user_id_cache.json"


# ─── Helpers ──────────────────────────────────────────────────────────────

def dumps(data):
    """JSON dumps as Instagram requires (no spaces, compact separators)."""
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


def generate_signature(data_str):
    """Generate signed_body for POST requests."""
    return "signed_body=SIGNATURE." + urllib.parse.quote_plus(data_str)


def generate_android_device_id():
    """Generate Android device ID like: android-a1b2c3d4e5f67890."""
    return "android-" + hashlib.sha256(str(time.time()).encode()).hexdigest()[:16]


def generate_uuid():
    """Generate standard UUID v4."""
    return str(uuid.uuid4())


class Colors:
    RED, GREEN, YELLOW, BLUE, CYAN, GRAY, RESET, BOLD = (
        '\033[91m', '\033[92m', '\033[93m', '\033[94m',
        '\033[96m', '\033[90m', '\033[0m', '\033[1m'
    )


def print_info(msg): print(f"{Colors.BLUE}i {msg}{Colors.RESET}")
def print_error(msg): print(f"{Colors.RED}x {msg}{Colors.RESET}")
def print_success(msg): print(f"{Colors.GREEN}+ {msg}{Colors.RESET}")
def print_warn(msg): print(f"{Colors.YELLOW}! {msg}{Colors.RESET}")


# ─── Main Client ──────────────────────────────────────────────────────────

class IGAPIClient:
    """Thin wrapper around Instagram Private API (Android)."""

    def __init__(self, session_cookies=None, timezone_offset=None, skip_session=False):
        """
        Args:
          session_cookies: dict of cookies to load (skips disk lookup).
          timezone_offset: override local tz; defaults to system tz.
          skip_session: do NOT read instagram_*_session.json from disk and
            do NOT auto-save back. Use this when you want a stateless,
            cookies-free client — works for *public* profiles via
            web_profile_info / clips/user/ which need only User-Agent +
            X-IG-App-ID. Setting it True is the SC Desktop default
            (sessions there are opt-in for private profiles only).
        """
        self.session = requests.Session()
        self.session.verify = False  # Avoid SSL warnings
        self.last_json = {}
        self.last_response = None
        self.user_id = None
        self.username = None
        self.skip_session = bool(skip_session)

        # Device & app settings
        app = random.choice(list(APP_SETTINGS.values()))
        self.device = dict(DEVICE_SETTINGS)
        self.device.update(app)
        self.app_version = app["app_version"]
        self.version_code = app["version_code"]
        self.bloks_versioning_id = app["bloks_versioning_id"]

        # Generate UUIDs (consistent per device)
        self.uuid = generate_uuid()
        self.phone_id = generate_uuid()
        self.client_session_id = generate_uuid()
        self.advertising_id = generate_uuid()
        self.android_device_id = generate_android_device_id()
        self.request_id = generate_uuid()
        self.tray_session_id = generate_uuid()

        # Locale / timezone
        self.locale = "en_US"
        self.country = "US"
        self.country_code = 1
        self.timezone_offset = timezone_offset or -(time.timezone)  # Local TZ

        # Cookies
        self.cookies = {}
        self.mid = ""
        self.ig_u_rur = ""
        self.ig_www_claim = "hmac.AR2uidim8es5kYgDiNxY0UG_ZhffFFSt8TGCV5eA1VYYsMNx"

        # Load session
        if session_cookies:
            self._load_cookies(session_cookies)
        elif not self.skip_session:
            self._load_session()

        # Build User-Agent
        self.user_agent = USER_AGENT_BASE.format(**self.device, locale=self.locale)

    def _load_cookies(self, cookies_dict):
        """Load cookies from a dict."""
        self.cookies = cookies_dict
        self.user_id = cookies_dict.get("ds_user_id")
        self.username = cookies_dict.get("ds_user_id")
        self.mid = cookies_dict.get("mid", "")
        self.ig_u_rur = cookies_dict.get("rur", "")

        # Extract user_id from sessionid if ds_user_id is missing
        if not self.user_id and "sessionid" in cookies_dict:
            sid = cookies_dict["sessionid"]
            # sessionid format: "72193855268:token:21:auth"
            parts = sid.split(":")
            if parts and parts[0].isdigit():
                self.user_id = parts[0]
                print_info(f"[session] Extracted user_id {self.user_id} from sessionid")

        # Set session cookies on requests session
        for name, value in cookies_dict.items():
            self.session.cookies.set(name, value, domain=".instagram.com")

    def _load_session(self):
        """Load cookies from existing Playwright session file."""
        # Try API session first
        if SESSION_FILE.exists():
            try:
                with open(SESSION_FILE) as f:
                    data = json.load(f)
                if "cookies" in data:
                    self._load_cookies(data["cookies"])
                    print_success("API session loaded")
                    return
            except Exception:
                pass

        # Fallback: Playwright session
        if PLAYWRIGHT_SESSION.exists():
            try:
                with open(PLAYWRIGHT_SESSION) as f:
                    data = json.load(f)
                cookies_list = data.get("cookies", [])
                cookies_dict = {}
                for c in cookies_list:
                    cookies_dict[c["name"]] = c["value"]
                self._load_cookies(cookies_dict)
                print_success("Playwright session converted")
                # Save as API session for future
                self._save_session()
                return
            except Exception as e:
                print_error(f"Failed to load Playwright session: {e}")

        print_warn("No session found. Use login() first.")

    def _save_session(self):
        """Save cookies as API session (no-op when skip_session=True so a
        stateless caller can't accidentally clobber the user's existing
        login file with empty cookies)."""
        if self.skip_session:
            return
        SESSION_DIR.mkdir(parents=True, exist_ok=True)
        with open(SESSION_FILE, "w") as f:
            json.dump({"cookies": self.cookies}, f, indent=2)

    @property
    def base_headers(self):
        """Build base headers for every request (from instagrapi private.py)."""
        locale = self.locale.replace("-", "_")
        accept_language = ["en-US"]
        lang = locale.replace("_", "-")
        if lang not in accept_language:
            accept_language.insert(0, lang)

        headers = {
            "X-IG-App-Locale": locale,
            "X-IG-Device-Locale": locale,
            "X-IG-Mapped-Locale": locale,
            "X-Pigeon-Session-Id": self.generate_uuid("UFS-", "-1"),
            "X-Pigeon-Rawclienttime": str(round(time.time(), 3)),
            "X-IG-Bandwidth-Speed-KBPS": str(random.randint(2500000, 3000000) / 1000),
            "X-IG-Bandwidth-TotalBytes-B": str(random.randint(5000000, 90000000)),
            "X-IG-Bandwidth-TotalTime-MS": str(random.randint(2000, 9000)),
            "X-IG-App-Startup-Country": self.country.upper(),
            "X-Bloks-Version-Id": self.bloks_versioning_id,
            "X-IG-WWW-Claim": self.ig_www_claim or "0",
            "X-Bloks-Is-Layout-RTL": "false",
            "X-Bloks-Is-Panorama-Enabled": "true",
            "X-IG-Device-ID": self.uuid,
            "X-IG-Family-Device-ID": self.phone_id,
            "X-IG-Android-ID": self.android_device_id,
            "X-IG-Timezone-Offset": str(self.timezone_offset),
            "X-IG-Connection-Type": "WIFI",
            "X-IG-Capabilities": "3brTv10=",
            "X-IG-App-ID": "567067343352427",
            "Priority": "u=3",
            "User-Agent": self.user_agent,
            "Accept-Language": ", ".join(accept_language),
            "X-MID": self.mid,
            "Accept-Encoding": "gzip, deflate",
            "Host": API_DOMAIN,
            "X-FB-HTTP-Engine": "Liger",
            "Connection": "keep-alive",
            "X-FB-Client-IP": "True",
            "X-FB-Server-Cluster": "True",
            "IG-INTENDED-USER-ID": str(self.user_id or 0),
            "X-IG-Nav-Chain": "9MV:self_profile:2,ProfileMediaTabFragment:self_profile:3",
            "X-IG-SALT-IDS": str(random.randint(1061162222, 1061262222)),
        }

        if self.user_id:
            next_year = time.time() + 31536000
            headers.update({
                "IG-U-DS-USER-ID": str(self.user_id),
                "IG-U-RUR": self.ig_u_rur or f"RVA,{self.user_id},{int(next_year)}:01f7f627f9ae4ce2874b2e04463efdb184340968b1b006fa88cb4cc69a942a04201e544c",
            })

        return headers

    @staticmethod
    def generate_uuid(prefix="", suffix=""):
        """Generate UUID with optional prefix/suffix."""
        return f"{prefix}{uuid.uuid4()}{suffix}"

    def _request(self, endpoint, data=None, params=None, method="GET"):
        """Make a private API request."""
        url = f"https://{API_DOMAIN}/api/v1/{endpoint.lstrip('/')}"
        headers = self.base_headers

        if data is not None:
            # POST request
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
            body = generate_signature(dumps(data))
            response = self.session.post(url, data=body, headers=headers, params=params)
        else:
            # GET request
            response = self.session.get(url, headers=headers, params=params)

        self.last_response = response

        try:
            self.last_json = response.json()
        except json.JSONDecodeError:
            self.last_json = {}
            print_error(f"JSON decode error: {response.text[:200]}")
            return None

        # Check for errors
        status = self.last_json.get("status")
        message = self.last_json.get("message", "")

        if status == "fail" and not self.last_json.get("items"):
            error_type = self.last_json.get("error_type", "")
            if "login_required" in message.lower() or error_type == "login_required":
                print_error("Login required. Session may be expired.")
                return None
            elif "challenge_required" in message.lower():
                print_error(f"Challenge required: {message}")
                return None
            elif "rate_limit" in error_type.lower():
                print_error("Rate limited. Wait and retry.")
                return None
            else:
                print_warn(f"API warning: {message} ({error_type})")

        return self.last_json

    # ─── Public Methods ──────────────────────────────────────────────────

    def get_user_id_by_username(self, username):
        """Search for user and get their numeric ID.
        Falls back to web scraping if session is expired."""
        # Try private API first
        result = self._request(
            "users/search/",
            params={"q": username, "count": 1}
        )
        if result:
            users = result.get("users", [])
            if users:
                return str(users[0]["pk"])

        # Fallback: scrape web page
        print_info(f"[search] Private API unavailable, using web scrape...")
        return self._get_user_id_from_web(username)

    def _get_user_id_from_web(self, username):
        """Get user ID by scraping public profile via web_profile_info API."""
        # Check cache first
        cache = self._load_user_id_cache()
        if username.lower() in cache:
            print_info(f"[cache] Found @{username} in cache")
            return cache[username.lower()]

        try:
            url = f"https://www.instagram.com/api/v1/users/web_profile_info/?username={username}"
            headers = {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "X-IG-App-ID": "936619743392459",
                "X-Requested-With": "XMLHttpRequest",
            }
            resp = self.session.get(url, headers=headers, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                user = data.get("data", {}).get("user", {})
                if user:
                    user_id = user.get("id")
                    # Save to cache
                    cache[username.lower()] = user_id
                    self._save_user_id_cache(cache)
                    return user_id
        except Exception as e:
            print_error(f"Web scrape failed: {e}")
        return None

    def _load_user_id_cache(self):
        """Load user_id cache from disk."""
        if USER_ID_CACHE.exists():
            try:
                with open(USER_ID_CACHE) as f:
                    return json.load(f)
            except:
                pass
        return {}

    def _save_user_id_cache(self, cache):
        """Save user_id cache to disk."""
        SESSION_DIR.mkdir(parents=True, exist_ok=True)
        with open(USER_ID_CACHE, "w") as f:
            json.dump(cache, f, indent=2)

    def get_user_info_from_web(self, username):
        """Get user profile info by scraping public profile page."""
        try:
            url = f"https://www.instagram.com/{username}/"
            headers = {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            }
            resp = requests.get(url, headers=headers, timeout=15)

            data = {}
            # Extract follower count
            m = re.search(r'"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)', resp.text)
            if m:
                data["follower_count"] = int(m.group(1))

            # Extract following count
            m = re.search(r'"edge_follow"\s*:\s*\{\s*"count"\s*:\s*(\d+)', resp.text)
            if m:
                data["following_count"] = int(m.group(1))

            # Extract media count
            m = re.search(r'"edge_owner_to_timeline_media"\s*:\s*\{\s*"count"\s*:\s*(\d+)', resp.text)
            if m:
                data["media_count"] = int(m.group(1))

            # Extract user ID
            m = re.search(r'"id"\s*:\s*"(\d+)".*?"username"\s*:\s*"' + re.escape(username) + r'"', resp.text, re.DOTALL)
            if m:
                data["pk"] = m.group(1)

            # Extract full name
            m = re.search(r'"full_name"\s*:\s*"((?:[^"\\]|\\.)*)"', resp.text)
            if m:
                data["full_name"] = m.group(1).encode().decode('unicode_escape')

            # Extract bio
            m = re.search(r'"biography"\s*:\s*"((?:[^"\\]|\\.)*)"', resp.text)
            if m:
                data["biography"] = m.group(1).encode().decode('unicode_escape')

            # Extract profile pic
            m = re.search(r'"profile_pic_url_hd"\s*:\s*"((?:[^"\\]|\\.)*)"', resp.text)
            if m:
                data["profile_pic_url"] = m.group(1).encode().decode('unicode_escape')

            # Extract external URL
            m = re.search(r'"external_url"\s*:\s*"((?:[^"\\]|\\.)*)"', resp.text)
            if m:
                data["external_url"] = m.group(1).encode().decode('unicode_escape')

            if data.get("pk"):
                data["username"] = username
                data["is_private"] = False
                data["is_verified"] = '"is_verified":true' in resp.text
                return data
        except Exception as e:
            print_error(f"Web scrape failed: {e}")
        return None

    def get_user_info(self, user_id):
        """Get full user profile info."""
        result = self._request(f"users/{user_id}/info/")
        if not result:
            return None
        user = result.get("user", {})
        return {
            "pk": str(user.get("pk")),
            "username": user.get("username"),
            "full_name": user.get("full_name"),
            "biography": user.get("biography"),
            "follower_count": user.get("follower_count"),
            "following_count": user.get("following_count"),
            "media_count": user.get("media_count"),
            "is_private": user.get("is_private", False),
            "is_verified": user.get("is_verified", False),
            "external_url": user.get("external_url"),
            "profile_pic_url": user.get("profile_pic_url"),
        }

    def get_user_profile(self, username):
        """Get user profile by username (search + info).
        Falls back to web scraping if API unavailable."""
        user_id = self.get_user_id_by_username(username)
        if not user_id:
            print_info(f"[profile] Falling back to web scrape for @{username}")
            return self.get_user_info_from_web(username)
        return self.get_user_info(user_id)

    def get_user_reels(self, user_id, amount=0, sleep=1.5):
        """
        Get user's reels (reels/clips).
        Returns list of dicts with video_url, caption, date, etc.

        Parameters:
            user_id: Instagram user ID (numeric)
            amount: Max reels to fetch (0 = all, paginated)
            sleep: Delay between pages (seconds, for rate limit safety)
        """
        user_id = str(user_id)
        reels = []
        max_id = ""
        page = 0

        while True:
            page += 1
            data = {
                "target_user_id": user_id,
                "max_id": max_id,
                "page_size": 12,  # Default from Android app
                "include_feed_video": "true",
            }

            print_info(f"[reels] Page {page} (max_id={max_id or 'start'})...")
            result = self._request("clips/user/", data=data)

            if not result:
                break

            items = result.get("items", [])
            if not items:
                break

            for item in items:
                media = item.get("media", item)  # Sometimes nested
                reel = self._extract_reel(media)
                if reel:
                    reels.append(reel)

            # Check pagination
            paging = result.get("paging_info", {})
            has_more = paging.get("more_available", False)
            max_id = paging.get("max_id", "")

            if not has_more or not max_id:
                break

            if amount and len(reels) >= amount:
                reels = reels[:amount]
                break

            time.sleep(sleep + random.uniform(0, 1))

        return reels

    def get_user_reels_by_username(self, username, amount=0, sleep=2):
        """Get user's reels by username (convenience method).
        Falls back to web scraping if API unavailable."""
        user_id = self.get_user_id_by_username(username)
        if not user_id:
            print_error(f"User @{username} not found")
            return []
        return self.get_user_reels(user_id, amount=amount, sleep=sleep)

    def get_media_info_by_shortcode(self, shortcode):
        """Get media info by shortcode (from URL like /reel/ABC123/)."""
        # Convert shortcode to media_id
        media_pk = self._shortcode_to_pk(shortcode)
        result = self._request(
            "media/info/",
            params={"media_id": f"{media_pk}_{self.user_id}"}
        )
        if not result or "items" not in result:
            return None
        return self._extract_reel(result["items"][0])

    def download_video(self, video_url, output_path):
        """Download video from direct CDN URL."""
        print_info(f"[download] {video_url[:80]}...")
        response = self.session.get(video_url, stream=True, timeout=60)
        response.raise_for_status()

        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        total = int(response.headers.get("content-length", 0))
        downloaded = 0

        with open(path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
                downloaded += len(chunk)
                if total and downloaded % (total // 4) < 8192:
                    pct = int(downloaded / total * 100)
                    print_info(f"[download] {pct}%")

        print_success(f"[download] Saved: {path} ({downloaded / 1024 / 1024:.1f} MB)")
        return str(path)

    @staticmethod
    def _extract_reel(media):
        """Extract reel data from API response (based on instagrapi extractors.py)."""
        if not media:
            return None

        # Get video URL (best quality)
        video_url = None
        video_versions = media.get("video_versions", [])
        if video_versions:
            # Sort by resolution, pick highest
            best = sorted(video_versions, key=lambda v: v.get("height", 0) * v.get("width", 0))
            video_url = best[-1].get("url")

        # Get thumbnail
        thumbnail_url = None
        images = media.get("image_versions2", {})
        candidates = images.get("candidates", [])
        if candidates:
            best_img = sorted(candidates, key=lambda i: i.get("height", 0) * i.get("width", 0))
            thumbnail_url = best_img[-1].get("url")

        # Get caption
        caption = ""
        caption_obj = media.get("caption", {})
        if caption_obj:
            caption = caption_obj.get("text", "")

        # Get date
        taken_at = media.get("taken_at")
        date_str = None
        if taken_at:
            date_str = datetime.utcfromtimestamp(taken_at).isoformat() + "Z"

        # Get shortcode
        code = media.get("code", "")
        pk = str(media.get("pk", ""))

        return {
            "pk": pk,
            "shortcode": code,
            "url": f"https://www.instagram.com/reel/{code}/" if code else None,
            "video_url": video_url,
            "thumbnail_url": thumbnail_url,
            "caption": caption,
            "date": date_str,
            "like_count": media.get("like_count", 0),
            "comment_count": media.get("comment_count", 0),
            "play_count": media.get("play_count", media.get("view_count", 0)),
            "width": media.get("original_width", 0),
            "height": media.get("original_height", 0),
            "duration": media.get("video_duration", 0),
            "media_type": media.get("media_type", 2),  # 2 = video
            "product_type": media.get("product_type", "clips"),
        }

    @staticmethod
    def _shortcode_to_pk(shortcode):
        """Convert shortcode (like 'ABC123') to numeric media PK."""
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        shortcode = shortcode.rstrip("/")
        num = 0
        for char in shortcode:
            num = num * 64 + alphabet.index(char)
        return str(num)


# ─── CLI Interface ────────────────────────────────────────────────────────

def cli():
    """Simple CLI for testing."""
    import argparse

    parser = argparse.ArgumentParser(description="Instagram API Client (lightweight)")
    parser.add_argument("command", choices=["profile", "reels", "download", "whoami"],
                        help="Command to run")
    parser.add_argument("target", nargs="?", help="Username or URL")
    parser.add_argument("--amount", type=int, default=0, help="Max reels to fetch (0=all)")
    parser.add_argument("--output", "-o", help="Output directory for downloads")
    args = parser.parse_args()

    client = IGAPIClient()

    if args.command == "whoami":
        # Test: get current user info
        if not client.user_id:
            print_error("No session. Login first via Playwright.")
            sys.exit(1)
        info = client.get_user_info(client.user_id)
        if info:
            fc = info.get('follower_count') or 0
            fwc = info.get('following_count') or 0
            mc = info.get('media_count') or 0
            print(f"🆔 {info['username']} — {info.get('full_name') or ''}")
            print(f"   Followers: {fc:,} | Following: {fwc:,} | Media: {mc:,}")
        else:
            print_error("Failed to get user info")

    elif args.command == "profile":
        if not args.target:
            print_error("Provide username")
            sys.exit(1)
        username = args.target.lstrip("@")
        info = client.get_user_profile(username)
        if info:
            private_tag = "🔒 " if info["is_private"] else ""
            verified_tag = "✅ " if info["is_verified"] else ""
            print(f"📸 {private_tag}{verified_tag}@{info['username']} — {info['full_name']}")
            print(f"   Followers: {info['follower_count']:,}")
            print(f"   Following: {info['following_count']:,}")
            print(f"   Media: {info['media_count']:,}")
            if info.get("biography"):
                print(f"   Bio: {info['biography'][:100]}")
            if info.get("external_url"):
                print(f"   URL: {info['external_url']}")
        else:
            print_error(f"User @{username} not found")

    elif args.command == "reels":
        if not args.target:
            print_error("Provide username")
            sys.exit(1)
        username = args.target.lstrip("@")
        print(f"🎬 Scanning @{username} reels...")
        start = time.time()
        reels = client.get_user_reels_by_username(username, amount=args.amount)
        elapsed = time.time() - start

        if reels:
            print(f"\n✅ Found {len(reels)} reels in {elapsed:.1f}s")
            for i, reel in enumerate(reels[:20], 1):
                duration = f"{reel['duration']:.0f}s" if reel['duration'] else "?"
                views = f"{reel['play_count']:,}" if reel['play_count'] else "0"
                caption = (reel['caption'] or "")[:60]
                print(f"  {i:3d}. {caption:60s} | {duration:>5s} | 👁 {views:>8s} | ❤ {reel['like_count']:,}")
            if len(reels) > 20:
                print(f"  ... and {len(reels) - 20} more")
        else:
            print_warn("No reels found")

    elif args.command == "download":
        if not args.target:
            print_error("Provide reel URL or username")
            sys.exit(1)
        if args.target.startswith("http"):
            # Download by URL
            shortcode = args.target.split("/reel/")[-1].rstrip("/")
            media = client.get_media_info_by_shortcode(shortcode)
            if media and media.get("video_url"):
                output = args.output or _desktop_output_path(f"{media['shortcode']}.mp4")
                client.download_video(media["video_url"], output)
            else:
                print_error("Failed to get media info")
        else:
            # Download first reel from user
            username = args.target.lstrip("@")
            reels = client.get_user_reels_by_username(username, amount=1)
            if reels and reels[0].get("video_url"):
                reel = reels[0]
                output = args.output or _desktop_output_path(f"{reel['shortcode']}.mp4")
                client.download_video(reel["video_url"], output)
            else:
                print_error("No reels found")


if __name__ == "__main__":
    cli()
