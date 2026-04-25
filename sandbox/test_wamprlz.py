#!/usr/bin/env python3
"""
Full test: @wamprlz channel
1. Apify free-tiktok-scraper — get video list
2. TikWM API — get play URL for first video
3. Download video, extract audio with ffmpeg
"""

import json, time, subprocess, os, urllib.request, urllib.parse

APIFY_TOKEN = "apify_api_FCDwmpNV7mV3br2zVLibKakzpUWiTU3l6eVD"
BASE_URL = "https://api.apify.com/v2"
TIKWM = "https://www.tikwm.com/api/"


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
    req = urllib.request.Request(url, data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def wait_run(actor_id, run_id, timeout=120):
    start = time.time()
    while time.time() - start < timeout:
        d = apify_get(f"/acts/{actor_id}/runs/{run_id}")["data"]
        status = d["status"]
        print(f"  [{int(time.time()-start)}s] {status}", flush=True)
        if status in ("SUCCEEDED", "FAILED", "ABORTED"):
            return d
        time.sleep(5)


def tikwm_video(url):
    req = urllib.request.Request(
        f"{TIKWM}?url={urllib.parse.quote(url)}&hd=1",
        headers={"User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


# ── Step 1: list channel via Apify ──────────────────────────────────────────
print("STEP 1: Apify channel listing @wamprlz")
actor_id = "OtzYfK1ndEGdwWFKQ"
run = apify_post(f"/acts/{actor_id}/runs", {
    "profiles": ["wamprlz"],
    "resultsPerPage": 5,
    "shouldDownloadVideos": False,
    "shouldDownloadCovers": False,
})
run_id = run["data"]["id"]
print(f"Run: {run_id}")
run_data = wait_run(actor_id, run_id)

cost = run_data.get("usageTotalUsd", "?")
print(f"Cost: ${cost}")

dataset_id = run_data["defaultDatasetId"]
resp = apify_get(f"/datasets/{dataset_id}/items", {"limit": 5})
videos = resp if isinstance(resp, list) else resp.get("items", [])
print(f"Got {len(videos)} videos\n")

for v in videos:
    title = v.get("text", "?")[:60]
    vid_id = v.get("id", "?")
    web_url = v.get("webVideoUrl", "?")
    plays = v.get("playCount", "?")
    dt = v.get("createTimeISO", "?")
    print(f"  [{dt[:10]}] {title}")
    print(f"    id={vid_id}, plays={plays}")
    print(f"    url={web_url}")

if not videos:
    print("No videos, stopping")
    exit(1)

# ── Step 2: get play URL via TikWM ──────────────────────────────────────────
print("\nSTEP 2: TikWM — get play URL for first video")
first = videos[0]
video_url = first.get("webVideoUrl")
print(f"Video: {video_url}")

resp = tikwm_video(video_url)
print(f"TikWM code: {resp.get('code')}, msg: {resp.get('msg','')}")

if resp.get("code") != 0:
    print("TikWM failed")
    exit(1)

d = resp["data"]
play_url = d.get("play", "")
music_url = d.get("music", "")
duration = d.get("duration", "?")
title = d.get("title", "?")[:60]

print(f"Title: {title}")
print(f"Duration: {duration}s")
print(f"play_url: {'OK' if play_url else 'MISSING'} — {play_url[:80]}")
print(f"music_url: {'OK' if music_url else 'MISSING'} — {music_url[:80]}")
print(f"All keys: {sorted(d.keys())}")

# ── Step 3: download video, extract audio ───────────────────────────────────
print("\nSTEP 3: Download video + extract audio")

tmp_mp4 = "/Users/fedor/Desktop/sc-desktop/sandbox/tmp_tiktok.mp4"
out_m4a = "/Users/fedor/Desktop/sc-desktop/sandbox/wamprlz_audio.m4a"

t0 = time.time()
req = urllib.request.Request(play_url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=60) as resp, open(tmp_mp4, "wb") as f:
    size = 0
    while True:
        chunk = resp.read(65536)
        if not chunk: break
        f.write(chunk)
        size += len(chunk)

print(f"Video downloaded: {size/1024:.0f} KB in {time.time()-t0:.1f}s")

# Extract audio: 16kHz mono for Gemini
t1 = time.time()
result = subprocess.run(
    ["ffmpeg", "-y", "-i", tmp_mp4, "-vn", "-acodec", "aac", "-ar", "16000", "-ac", "1", out_m4a],
    capture_output=True
)
os.remove(tmp_mp4)

if result.returncode == 0:
    asize = os.path.getsize(out_m4a)
    print(f"Audio extracted: {asize/1024:.0f} KB in {time.time()-t1:.1f}s")

    # Probe
    pr = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", out_m4a],
        capture_output=True
    )
    info = json.loads(pr.stdout)["streams"][0]
    print(f"Audio: codec={info['codec_name']}, duration={float(info.get('duration',0)):.1f}s, "
          f"{info.get('sample_rate')}Hz, {info.get('channels')}ch, "
          f"{int(info.get('bit_rate',0))//1000}kbps")

    print(f"\nTotal pipeline: {time.time()-t0:.1f}s, ready for Gemini: {out_m4a}")
else:
    print(f"ffmpeg error: {result.stderr.decode()[-200:]}")
