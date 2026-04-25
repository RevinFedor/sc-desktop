#!/usr/bin/env python3
"""
Test: get channel videos via TikWM, download full video audio track.
Usage: python3 test_tiktok_full_audio.py <channel_url_or_handle>
"""

import sys
import json
import subprocess
import os
import time
import urllib.request
import urllib.parse

TIKWM_API = "https://www.tikwm.com/api/"
TIKWM_LIST = "https://www.tikwm.com/api/user/posts"


def tikwm_get(endpoint, params):
    url = endpoint + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def get_channel_videos(handle, count=5):
    """Get recent videos from a channel via TikWM."""
    handle = handle.lstrip("@")
    print(f"Fetching channel: @{handle}")

    # First get user info to get uid
    resp = tikwm_get(TIKWM_API, {"url": f"https://www.tiktok.com/@{handle}"})
    print(f"User lookup: code={resp.get('code')}, msg={resp.get('msg', '')}")

    # Try direct user posts endpoint
    resp2 = tikwm_get(TIKWM_LIST, {
        "unique_id": handle,
        "count": count,
        "cursor": 0,
    })
    print(f"Posts lookup: code={resp2.get('code')}, msg={resp2.get('msg', '')}")

    if resp2.get("code") == 0:
        videos = resp2["data"].get("videos", [])
        print(f"Got {len(videos)} videos")
        return videos

    return []


def get_single_video(url):
    """Get video info for a single URL."""
    resp = tikwm_get(TIKWM_API, {"url": url, "hd": 1})
    if resp.get("code") == 0:
        return resp["data"]
    print(f"Error: {resp.get('msg')}")
    return None


def download_video_audio(play_url, out_path):
    """Download video and extract audio track with ffmpeg."""
    # Download video
    tmp_mp4 = out_path + ".tmp.mp4"
    print(f"  Downloading video...")
    req = urllib.request.Request(play_url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp, open(tmp_mp4, "wb") as f:
        size = 0
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            f.write(chunk)
            size += len(chunk)
    print(f"  Downloaded: {size/1024:.0f} KB")

    # Extract audio
    print(f"  Extracting audio track...")
    cmd = ["ffmpeg", "-y", "-i", tmp_mp4, "-vn", "-acodec", "aac", "-ar", "16000", "-ac", "1", out_path]
    result = subprocess.run(cmd, capture_output=True)
    os.remove(tmp_mp4)

    if result.returncode == 0:
        size = os.path.getsize(out_path)
        print(f"  Audio saved: {out_path} ({size/1024:.0f} KB)")
        return True
    else:
        print(f"  ffmpeg error: {result.stderr.decode()[-300:]}")
        return False


def probe_audio(path):
    """Show audio info."""
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", path],
        capture_output=True
    )
    d = json.loads(result.stdout)
    for s in d.get("streams", []):
        print(f"  codec={s['codec_name']}, duration={float(s.get('duration',0)):.1f}s, "
              f"rate={s.get('sample_rate')}Hz, channels={s.get('channels')}, "
              f"bitrate={int(s.get('bit_rate',0))//1000}kbps")


def main():
    channel_url = sys.argv[1] if len(sys.argv) > 1 else "https://www.tiktok.com/@wamprlz"
    handle = channel_url.split("@")[-1].split("?")[0].strip("/")

    print("=" * 60)
    print(f"Channel: @{handle}")
    print("=" * 60)

    videos = get_channel_videos(handle, count=5)

    if not videos:
        print("No videos from channel listing. Trying yt-dlp fallback...")
        # yt-dlp fallback for channel
        result = subprocess.run(
            ["yt-dlp", "--flat-playlist", "--dump-json",
             "--cookies-from-browser", "firefox",
             "-I", "1:3",
             f"https://www.tiktok.com/@{handle}"],
            capture_output=True, text=True, timeout=60
        )
        for line in result.stdout.strip().split("\n")[:3]:
            if line:
                try:
                    v = json.loads(line)
                    videos.append({"id": v.get("id"), "title": v.get("title", ""), "play": v.get("url", ""), "_ytdlp": True})
                except:
                    pass
        print(f"yt-dlp found: {len(videos)} videos")

    if not videos:
        print("No videos found")
        return

    print(f"\nFirst {min(3,len(videos))} videos:")
    for v in videos[:3]:
        title = v.get("title", v.get("text", v.get("desc", "?")))[:60]
        vid_id = v.get("video_id", v.get("id", "?"))
        play_url = v.get("play", "")
        duration = v.get("duration", "?")
        create = v.get("create_time", "")
        print(f"  [{vid_id}] {title}")
        print(f"    duration={duration}s, created={create}")
        print(f"    play_url={'yes' if play_url else 'NO'}")

    # Download audio from first video
    print("\n" + "=" * 60)
    print("Downloading audio from first video...")
    print("=" * 60)

    first = videos[0]
    play_url = first.get("play", "")

    if not play_url and not first.get("_ytdlp"):
        # Get detailed info
        vid_url = f"https://www.tiktok.com/@{handle}/video/{first.get('video_id', first.get('id'))}"
        print(f"Fetching video detail: {vid_url}")
        detail = get_single_video(vid_url)
        if detail:
            play_url = detail.get("play", "")
            print(f"play_url from detail: {play_url[:80] if play_url else 'NONE'}")
            print(f"music_url: {str(detail.get('music',''))[:80]}")
            print(f"All keys: {list(detail.keys())}")

    if play_url:
        out_path = f"/Users/fedor/Desktop/sc-desktop/sandbox/tiktok_audio_{first.get('video_id', first.get('id', 'test'))}.m4a"
        t0 = time.time()
        ok = download_video_audio(play_url, out_path)
        if ok:
            probe_audio(out_path)
            print(f"  Total time: {time.time()-t0:.1f}s")
            print(f"\nReady for Gemini transcription: {out_path}")
    else:
        print("No play_url available — yt-dlp needed for actual download")
        # Show what yt-dlp would do
        print("\nyt-dlp test (metadata only, no download):")
        vid_url = f"https://www.tiktok.com/@{handle}/video/{first.get('video_id', first.get('id'))}"
        result = subprocess.run(
            ["yt-dlp", "--dump-json", "--cookies-from-browser", "firefox", vid_url],
            capture_output=True, text=True, timeout=30
        )
        if result.stdout:
            d = json.loads(result.stdout.split("\n")[0])
            print(f"  title: {d.get('title','?')[:60]}")
            print(f"  duration: {d.get('duration')}s")
            formats = d.get("formats", [])
            audio_fmts = [f for f in formats if f.get("vcodec") == "none"]
            print(f"  audio formats: {len(audio_fmts)}")
            for f in audio_fmts[:3]:
                print(f"    ext={f.get('ext')}, abr={f.get('abr')}, url={'yes' if f.get('url') else 'no'}")


if __name__ == "__main__":
    main()
