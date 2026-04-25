#!/usr/bin/env python3
"""
Actually run a TikTok actor and see what comes back.
Tests:
  1. clockworks/free-tiktok-scraper — channel listing (free, 22M runs)
  2. sian.agency/best-tiktok-ai-transcript-extractor — single video transcript

Usage:
    python3 test_tiktok_run.py channel @username
    python3 test_tiktok_run.py video <tiktok_url>
    python3 test_tiktok_run.py schema        # just show input schemas, no runs
"""

import sys
import json
import time
import urllib.request
import urllib.parse
import urllib.error

APIFY_TOKEN = "apify_api_FCDwmpNV7mV3br2zVLibKakzpUWiTU3l6eVD"
BASE_URL = "https://api.apify.com/v2"


def apify_get(path, params=None):
    url = f"{BASE_URL}{path}?token={APIFY_TOKEN}"
    if params:
        url += "&" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def apify_post(path, body):
    url = f"{BASE_URL}{path}?token={APIFY_TOKEN}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def wait_for_run(actor_id, run_id, timeout_s=180):
    start = time.time()
    while time.time() - start < timeout_s:
        resp = apify_get(f"/acts/{actor_id}/runs/{run_id}")
        status = resp["data"]["status"]
        elapsed = int(time.time() - start)
        print(f"  [{elapsed}s] Status: {status}", flush=True)
        if status in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
            return resp["data"]
        time.sleep(5)
    return None


def get_dataset_items(dataset_id, limit=5):
    resp = apify_get(f"/datasets/{dataset_id}/items", {"limit": limit})
    if isinstance(resp, list):
        return resp
    return resp.get("items", [])


def show_schema(actor_id):
    resp = apify_get(f"/acts/{actor_id}")
    d = resp.get("data", {})
    schema_raw = d.get("inputSchema")
    if not schema_raw:
        print("  No input schema available")
        return
    schema = json.loads(schema_raw) if isinstance(schema_raw, str) else schema_raw
    props = schema.get("properties", {})
    required = schema.get("required", [])
    print(f"  Required fields: {required}")
    print(f"  All fields ({len(props)}):")
    for k, v in props.items():
        t = v.get("type", "?")
        desc = v.get("description", v.get("title", ""))[:80]
        default = v.get("default", "")
        req_mark = " *" if k in required else ""
        print(f"    {k}{req_mark} ({t}): {desc}  [default: {default}]")


def test_channel(handle: str):
    """Get first 5 videos from a TikTok channel using free-tiktok-scraper."""
    actor = "clockworks~free-tiktok-scraper"
    actor_raw = "OtzYfK1ndEGdwWFKQ"

    print(f"\n{'='*60}")
    print(f"TEST: Channel listing — {handle}")
    print(f"Actor: clockworks/free-tiktok-scraper")
    print("=" * 60)

    # First show schema
    print("\n--- Input Schema ---")
    show_schema(actor_raw)

    print(f"\n--- Running for {handle}, limit=5 ---")

    input_data = {
        "profiles": [handle.lstrip("@")],
        "resultsPerPage": 5,
        "maxProfilesPerQuery": 1,
        "shouldDownloadVideos": False,
        "shouldDownloadCovers": False,
        "shouldDownloadSubtitles": False,
        "shouldDownloadSlideshowImages": False,
    }

    try:
        run_resp = apify_post(f"/acts/{actor_raw}/runs", input_data)
        run_id = run_resp["data"]["id"]
        print(f"  Run started: {run_id}")

        run_data = wait_for_run(actor_raw, run_id)
        if not run_data:
            print("  Timed out")
            return

        status = run_data["status"]
        cost = run_data.get("usageTotalUsd", "?")
        print(f"\n  Status: {status}, Cost: ${cost}")

        if status == "SUCCEEDED":
            dataset_id = run_data["defaultDatasetId"]
            items = get_dataset_items(dataset_id, limit=5)
            print(f"\n  Got {len(items)} videos. First video:")
            if items:
                item = items[0]
                # Show relevant fields
                fields = [
                    "id", "text", "createTime", "createTimeISO",
                    "authorMeta", "videoMeta", "musicMeta",
                    "playCount", "diggCount", "commentCount", "shareCount",
                    "downloadAddr", "videoUrl", "webVideoUrl",
                ]
                for f in fields:
                    val = item.get(f)
                    if val is not None:
                        if isinstance(val, dict):
                            print(f"    {f}: {json.dumps(val, ensure_ascii=False)[:120]}")
                        elif isinstance(val, str) and len(val) > 100:
                            print(f"    {f}: {val[:100]}...")
                        else:
                            print(f"    {f}: {val}")

                print(f"\n  All available keys: {sorted(item.keys())}")
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:500]}")
    except Exception as ex:
        import traceback
        traceback.print_exc()


def test_transcript(video_url: str):
    """Get transcript for a single TikTok video."""
    actor_raw = "gE6MpI4jJF4h5mahj"

    print(f"\n{'='*60}")
    print(f"TEST: Video transcript — {video_url}")
    print(f"Actor: sian.agency/best-tiktok-ai-transcript-extractor")
    print("=" * 60)

    print("\n--- Input Schema ---")
    show_schema(actor_raw)

    print(f"\n--- Running for {video_url} ---")

    input_data = {
        "videoUrls": [video_url],
    }

    try:
        run_resp = apify_post(f"/acts/{actor_raw}/runs", input_data)
        run_id = run_resp["data"]["id"]
        print(f"  Run started: {run_id}")

        run_data = wait_for_run(actor_raw, run_id)
        if not run_data:
            print("  Timed out")
            return

        status = run_data["status"]
        cost = run_data.get("usageTotalUsd", "?")
        print(f"\n  Status: {status}, Cost: ${cost}")

        if status == "SUCCEEDED":
            dataset_id = run_data["defaultDatasetId"]
            items = get_dataset_items(dataset_id, limit=1)
            if items:
                item = items[0]
                print(f"\n  All keys: {sorted(item.keys())}")
                # Show transcript specifically
                for k in ["transcript", "srt", "vtt", "segments", "text", "subtitles", "captions"]:
                    if k in item:
                        val = item[k]
                        if isinstance(val, str):
                            print(f"\n  [{k}] ({len(val)} chars):\n  {val[:500]}")
                        else:
                            print(f"\n  [{k}]: {json.dumps(val, ensure_ascii=False)[:500]}")
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:500]}")
    except Exception as ex:
        import traceback
        traceback.print_exc()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "schema"
    arg = sys.argv[2] if len(sys.argv) > 2 else None

    if cmd == "channel":
        if not arg:
            print("Usage: python3 test_tiktok_run.py channel @username")
            sys.exit(1)
        test_channel(arg)
    elif cmd == "video":
        if not arg:
            print("Usage: python3 test_tiktok_run.py video <url>")
            sys.exit(1)
        test_transcript(arg)
    elif cmd == "schema":
        for actor_id, label in [
            ("OtzYfK1ndEGdwWFKQ", "free-tiktok-scraper"),
            ("GdWCkxBtKWOsKjdch", "tiktok-scraper"),
            ("gE6MpI4jJF4h5mahj", "transcript-extractor"),
            ("naqsZgh7DhGajnD5z", "tiktok-api (scraptik)"),
        ]:
            print(f"\n{'='*60}")
            print(f"Schema: {label} ({actor_id})")
            print("=" * 60)
            show_schema(actor_id)
    else:
        print("Commands: schema | channel @user | video <url>")


if __name__ == "__main__":
    main()
