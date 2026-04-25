#!/usr/bin/env python3
"""Get details on specific TikTok actors: pricing, schema, capabilities."""

import json
import urllib.request
import urllib.parse

APIFY_TOKEN = "apify_api_FCDwmpNV7mV3br2zVLibKakzpUWiTU3l6eVD"
BASE_URL = "https://api.apify.com/v2"

# IDs from search results
ACTORS_OF_INTEREST = {
    "GdWCkxBtKWOsKjdch": "tiktok-scraper (main)",
    "naqsZgh7DhGajnD5z": "tiktok-api (lowest-cost mobile API)",
    "gE6MpI4jJF4h5mahj": "best-tiktok-ai-transcript-extractor",
    "OtzYfK1ndEGdwWFKQ": "free-tiktok-scraper",
    "0FXVyOXXEmdGcV88a": "tiktok-profile-scraper",
    "S5h7zRLfKFEr8pdj7": "tiktok-video-scraper",
    "BDec00yAmCm1QbMEI": "tiktok-comments-scraper",
}


def apify_get(path, params=None):
    url = f"{BASE_URL}{path}?token={APIFY_TOKEN}"
    if params:
        url += "&" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def get_actor_details(actor_id, label):
    print(f"\n{'='*60}")
    print(f"ACTOR: {label}")
    print(f"ID: {actor_id}")
    print("=" * 60)

    try:
        resp = apify_get(f"/acts/{actor_id}")
        d = resp.get("data", resp)

        name = d.get("name", "?")
        username = d.get("username", "?")
        title = d.get("title", "?")
        desc = d.get("description", "")[:200]

        print(f"  Full name: {username}/{name}")
        print(f"  Title: {title}")
        print(f"  Description: {desc}...")

        # Pricing
        pricing = d.get("currentPricingInfo", {})
        if pricing:
            ptype = pricing.get("pricingModel", "?")
            flat = pricing.get("monthlyFlatFee", 0)
            per_item = pricing.get("pricePerDatasetItem", 0)
            per_compute = pricing.get("pricePerCpu", 0)
            print(f"  Pricing model: {ptype}")
            print(f"  Monthly flat: ${flat}")
            print(f"  Per dataset item: ${per_item}")
            print(f"  Per CPU unit: ${per_compute}")
        else:
            print("  Pricing: (not available via API)")

        # Stats
        stats = d.get("stats", {})
        runs = stats.get("totalRuns", "?")
        users = stats.get("totalUsers", "?")
        print(f"  Total runs: {runs}, Users: {users}")

        # Input schema (to understand what channels/videos it accepts)
        input_schema = d.get("inputSchema")
        if input_schema:
            if isinstance(input_schema, str):
                try:
                    schema = json.loads(input_schema)
                except Exception:
                    schema = {}
            else:
                schema = input_schema

            props = schema.get("properties", {})
            print(f"  Input fields ({len(props)}):")
            for k, v in list(props.items())[:15]:
                vtype = v.get("type", "?")
                vtitle = v.get("title", k)
                vdesc = v.get("description", "")[:60]
                print(f"    - {k} ({vtype}): {vtitle} — {vdesc}")

    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as ex:
        print(f"  Error: {ex}")


def main():
    for actor_id, label in ACTORS_OF_INTEREST.items():
        get_actor_details(actor_id, label)


if __name__ == "__main__":
    main()
