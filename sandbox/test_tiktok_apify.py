#!/usr/bin/env python3
"""
Sandbox: Test Apify actors for TikTok
- List available TikTok actors
- Check pricing/capabilities
- Test channel listing (get videos from a channel)
- Test subtitle/audio extraction

Usage:
    python3 test_tiktok_apify.py
    python3 test_tiktok_apify.py --channel @someuser
    python3 test_tiktok_apify.py --video https://www.tiktok.com/@user/video/123
"""

import sys
import os
import json
import time
import argparse
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
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def apify_post(path, body):
    url = f"{BASE_URL}{path}?token={APIFY_TOKEN}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def run_actor_and_wait(actor_id, input_data, timeout_s=120):
    """Run an actor synchronously and return results."""
    print(f"\n▶ Running actor: {actor_id}")
    print(f"  Input: {json.dumps(input_data, ensure_ascii=False, indent=2)}")

    # Start run
    resp = apify_post(f"/acts/{actor_id}/runs", input_data)
    run_id = resp["data"]["id"]
    print(f"  Run ID: {run_id}")

    # Poll until done
    start = time.time()
    while time.time() - start < timeout_s:
        status_resp = apify_get(f"/acts/{actor_id}/runs/{run_id}")
        status = status_resp["data"]["status"]
        print(f"  Status: {status} ({int(time.time()-start)}s)")
        if status in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
            break
        time.sleep(5)

    if status != "SUCCEEDED":
        print(f"  ❌ Run ended with status: {status}")
        return None, resp["data"]

    # Get results
    dataset_id = status_resp["data"]["defaultDatasetId"]
    items_resp = apify_get(f"/datasets/{dataset_id}/items", {"limit": 20})
    items = items_resp.get("items", [])
    usage = status_resp["data"].get("usageTotalUsd", "?")
    print(f"  ✅ Done. Items: {len(items)}, Cost: ${usage}")
    return items, status_resp["data"]


def check_account():
    print("=" * 60)
    print("APIFY ACCOUNT INFO")
    print("=" * 60)
    resp = apify_get("/users/me")
    d = resp["data"]
    print(f"  Username: {d.get('username')}")
    print(f"  Plan: {d.get('plan', {}).get('id', '?')}")
    limits = d.get("limits", {})
    print(f"  Monthly usage: ${d.get('monthlyUsageUsd', '?')}")
    print(f"  Available credits: ${d.get('availableCredits', {}).get('usd', '?')}")


def search_tiktok_actors():
    print("\n" + "=" * 60)
    print("SEARCHING TIKTOK ACTORS ON APIFY STORE")
    print("=" * 60)

    resp = apify_get("/store", {"search": "tiktok", "category": "SOCIAL_MEDIA", "limit": 20})
    actors = resp.get("data", {}).get("items", [])

    if not actors:
        # try different structure
        actors = resp.get("items", [])

    print(f"\nFound {len(actors)} actors:")
    for a in actors[:15]:
        name = a.get("name") or a.get("title", "?")
        actor_id = a.get("id") or a.get("actorId", "?")
        price = a.get("currentPricingInfo", {})
        monthly = price.get("monthlyFlatFee", 0)
        per_run = price.get("pricePerDatasetItem", 0)
        desc = a.get("description", "")[:80]
        print(f"\n  [{actor_id}]")
        print(f"  Name: {name}")
        print(f"  Price: ${monthly}/mo flat + ${per_run}/item")
        print(f"  Desc: {desc}...")

    return actors


def test_channel_listing(channel_handle: str):
    """Test getting videos from a TikTok channel."""
    print("\n" + "=" * 60)
    print(f"TEST: CHANNEL LISTING — {channel_handle}")
    print("=" * 60)

    # Most popular TikTok channel scrapers
    actors_to_try = [
        {
            "id": "clockworks/tiktok-scraper",
            "input": {
                "profiles": [channel_handle],
                "resultsPerPage": 10,
                "shouldDownloadVideos": False,
                "shouldDownloadCovers": False,
            },
        },
        {
            "id": "apify/tiktok-scraper",
            "input": {
                "profiles": [channel_handle],
                "resultsPerPage": 10,
            },
        },
    ]

    for actor in actors_to_try:
        try:
            items, run_data = run_actor_and_wait(actor["id"], actor["input"], timeout_s=90)
            if items:
                print(f"\n  Sample item keys: {list(items[0].keys())[:15]}")
                first = items[0]
                print(f"  Title: {first.get('text', first.get('description', '?'))[:80]}")
                print(f"  Author: {first.get('authorMeta', {}).get('name', first.get('author', '?'))}")
                print(f"  Video URL: {first.get('videoUrl', first.get('webVideoUrl', '?'))[:80]}")
                print(f"  Music: {first.get('musicMeta', {}).get('musicName', '?')}")
                print(f"  Plays: {first.get('playCount', first.get('stats', {}).get('playCount', '?'))}")
                return items
        except urllib.error.HTTPError as e:
            print(f"  HTTP {e.code}: {e.read().decode()[:200]}")
        except Exception as ex:
            print(f"  Error: {ex}")

    return None


def test_video_subtitles(video_url: str):
    """Test extracting subtitles/audio from a single TikTok video."""
    print("\n" + "=" * 60)
    print(f"TEST: VIDEO SUBTITLES/AUDIO — {video_url}")
    print("=" * 60)

    # Try clockworks scraper with single video URL
    actor_id = "clockworks/tiktok-scraper"
    input_data = {
        "postURLs": [video_url],
        "shouldDownloadVideos": False,
        "shouldDownloadSlideshowImages": False,
        "shouldDownloadCovers": False,
    }

    try:
        items, run_data = run_actor_and_wait(actor_id, input_data, timeout_s=60)
        if items:
            item = items[0]
            print(f"\n  All fields: {json.dumps(item, ensure_ascii=False, indent=2)[:3000]}")
        return items
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as ex:
        print(f"  Error: {ex}")
    return None


def main():
    parser = argparse.ArgumentParser(description="Test Apify TikTok capabilities")
    parser.add_argument("--channel", help="TikTok channel handle, e.g. @someuser")
    parser.add_argument("--video", help="TikTok video URL")
    parser.add_argument("--search-only", action="store_true", help="Only list available actors")
    args = parser.parse_args()

    check_account()
    search_tiktok_actors()

    if args.search_only:
        return

    if args.channel:
        test_channel_listing(args.channel)
    elif args.video:
        test_video_subtitles(args.video)
    else:
        print("\n" + "=" * 60)
        print("TIP: Run with --channel @username to test channel listing")
        print("     Run with --video <url> to test single video extraction")
        print("     Run with --search-only to just list available actors")
        print("=" * 60)


if __name__ == "__main__":
    main()
