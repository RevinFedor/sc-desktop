#!/usr/bin/env python3
"""Check Apify account balance and recent run costs."""

import json
import urllib.request
import urllib.parse

APIFY_TOKEN = "apify_api_FCDwmpNV7mV3br2zVLibKakzpUWiTU3l6eVD"
BASE_URL = "https://api.apify.com/v2"


def apify_get(path, params=None):
    url = f"{BASE_URL}{path}?token={APIFY_TOKEN}"
    if params:
        url += "&" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def main():
    # Full account dump
    resp = apify_get("/users/me")
    d = resp["data"]
    print("FULL ACCOUNT DATA:")
    print(json.dumps(d, indent=2, ensure_ascii=False))

    # Recent runs
    print("\n\nRECENT RUNS:")
    runs = apify_get("/actor-runs", {"limit": 10, "desc": True})
    for run in runs.get("data", {}).get("items", []):
        print(f"  {run.get('id')} | {run.get('actId')} | status={run.get('status')} | "
              f"usageTotalUsd={run.get('usageTotalUsd')} | "
              f"computeUnits={run.get('stats', {}).get('computeUnits', '?')}")


if __name__ == "__main__":
    main()
