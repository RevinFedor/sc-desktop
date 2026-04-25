#!/usr/bin/env python3
"""
Test: Reddit JSON через залогиненные Firefox cookies.

Запуск:
    1. Залогиниться в Reddit в Firefox (вручную)
    2. python3 test_reddit_cookie.py

Покажет: статус, размер ответа, и если 200 — заголовок поста + первые 5 комментов.
"""
import sys
import browser_cookie3
import requests
import json

# Тестовый URL — реальный пост
TEST_URL = "https://www.reddit.com/r/webscraping/comments/1nu9d0r/crawlee_for_python_v10_is_live/.json?limit=20&depth=10"

print(f"Loading Firefox cookies for reddit.com...")
try:
    cj = browser_cookie3.firefox(domain_name="reddit.com")
    cookies_dict = {c.name: c.value for c in cj}
    print(f"  Found cookies: {list(cookies_dict.keys())}")
    print(f"  Has reddit_session: {bool(cookies_dict.get('reddit_session'))}")
    print(f"  Has token_v2: {bool(cookies_dict.get('token_v2'))}")
    print(f"  Has session_tracker: {bool(cookies_dict.get('session_tracker'))}")
    print(f"  Total cookies: {len(cookies_dict)}")
except Exception as e:
    print(f"  ERROR loading cookies: {e}")
    sys.exit(1)

if not cookies_dict:
    print("No cookies found — открой Firefox и залогинься в reddit.com")
    sys.exit(2)

print(f"\nFetching: {TEST_URL}")
headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
}

try:
    r = requests.get(TEST_URL, headers=headers, cookies=cookies_dict, timeout=15, allow_redirects=True)
    print(f"  Status: {r.status_code}")
    print(f"  Body size: {len(r.text)} bytes")
    print(f"  Final URL: {r.url}")

    if r.status_code != 200:
        print(f"\n  Response (first 500 chars):\n  {r.text[:500]}")
        sys.exit(3)

    data = r.json()
    print(f"\n  Type: {type(data).__name__}, length: {len(data)}")

    # Reddit returns [post_listing, comments_listing]
    post = data[0]["data"]["children"][0]["data"]
    print(f"\n=== POST ===")
    print(f"  Title: {post['title']}")
    print(f"  Score: {post['score']}, Comments: {post['num_comments']}")
    print(f"  Author: u/{post['author']}")
    print(f"  Subreddit: r/{post['subreddit']}")

    print(f"\n=== TOP COMMENTS ===")
    for i, c in enumerate(data[1]["data"]["children"][:5]):
        if c["kind"] == "more":
            print(f"  [more: {c['data']['count']} comments]")
            continue
        d = c["data"]
        body = (d.get("body") or "").replace("\n", " ")[:120]
        print(f"  {i+1}. ↑{d.get('score')} u/{d.get('author')}: {body}")

    print(f"\n✅ ОТЛИЧНО — Reddit JSON открывается через залогиненные cookies, можем убрать Apify!")
except Exception as e:
    print(f"  ERROR: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(4)
