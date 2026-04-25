#!/usr/bin/env python3
"""BrowserPowers CLI helper — uses browser NAME directly (REST resolves it)."""
import json, sys, urllib.request, urllib.error, os

CORE = "http://127.0.0.1:4199"
NAME = os.environ.get("BP_BROWSER", "shiny-cutie")

def api_get(path):
    with urllib.request.urlopen(f"{CORE}{path}") as r:
        return json.loads(r.read())

def api_post(path, body, timeout=30):
    req = urllib.request.Request(
        f"{CORE}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def main():
    if len(sys.argv) < 2:
        # List browsers
        browsers = api_get("/api/browsers")["browsers"]
        print(f"Connected browsers ({len(browsers)}):")
        for b in browsers:
            perms = {k:v for k,v in b.get("permissions",{}).items() if v != "allow"}
            print(f"  🖥  {b['name']}  [{b['id'][:8]}...]")
            if perms:
                for k,v in sorted(perms.items()):
                    print(f"      ⏳ {k}: {v}")
        return

    cmd = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("{") else NAME

    if cmd == "exec":
        tool = sys.argv[3] if len(sys.argv) > 3 else sys.argv[2]
        params = json.loads(sys.argv[4]) if len(sys.argv) > 4 else (
                 json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].startswith("{") else {})
        timeout = int(sys.argv[5]) if len(sys.argv) > 5 else 30

        print(f"🚀 {tool} on '{name}'", file=sys.stderr)

        # Use name in URL — REST API now resolves it!
        result = api_post(f"/api/browsers/{name}/execute",
                         {"tool": tool, "params": params}, timeout)

        if result.get("success"):
            data = result.get("data")
            print(json.dumps(data, indent=2, default=str)[:3000])
        else:
            print(f"❌ {result.get('error', 'unknown')}", file=sys.stderr)
            sys.exit(1)

    elif cmd == "approval-test":
        print(f"💫 Testing approval flow on '{name}'...\n")

        # Get permissions
        browsers = api_get("/api/browsers")["browsers"]
        matches = [b for b in browsers if b["name"] == name]
        if not matches:
            print(f"❌ Browser '{name}' not found", file=sys.stderr)
            sys.exit(1)
        perms = matches[0].get("permissions", {})

        print("📋 Permission Profile:")
        for k, v in sorted(perms.items()):
            icon = {"allow": "🟢", "ask": "🟡", "deny": "🔴"}.get(v, "⚪")
            print(f"   {icon} {k}: {v}")

        ask_tools = [k for k, v in perms.items() if v == "ask"]

        # Use name directly in URL
        base = f"/api/browsers/{name}"

        if not ask_tools:
            print(f"\n⚠️  No 'ask' mode permissions left! Everything is already resolved.")
            print(f"   To test approval flow, change a permission back to 'ask' in the popup settings.\n")

        # Test 1: Allow mode
        print(f"\n🟢 Test 1: tabs.list (allow mode)")
        r = api_post(f"{base}/execute", {"tool": "tabs.list", "params": {}}, timeout=10)
        print(f"   {'✅ ok' if r['success'] else '❌ ' + r.get('error','')}")

        # Test 2: Ask mode (if any exist)
        if ask_tools:
            test_tool = f"{ask_tools[0]}.list" if ask_tools[0] in ("downloads",) else ask_tools[0]
            print(f"\n🟡 Test 2: {test_tool} (ask mode — will block for approval)")
            print(f"   ⏳ HTTP request is WAITING for you to approve/deny in the popup...")
            print(f"   ⏳ (60s timeout)")
            try:
                r = api_post(f"{base}/execute", {"tool": test_tool, "params": {}}, timeout=65)
                if r.get("success"):
                    print(f"   ✅ Approved! Result: {json.dumps(r.get('data','ok'), indent=2)[:500]}")
                else:
                    print(f"   ❌ Denied or error: {r.get('error','')}")
            except Exception as e:
                print(f"\n   ⏰ Timed out waiting for approval (60s)")
        else:
            print(f"\n🟡 Test 2: (no ask-mode tools available — skipped)")

        # Test 3: Deny mode
        print(f"\n🔴 Test 3: page.js (deny mode)")
        r = api_post(f"{base}/execute", {"tool": "page.js", "params": {"code": "1+1"}}, timeout=5)
        print(f"   {'✅ Correctly blocked' if not r['success'] else '❌ Should have been blocked!'}")

if __name__ == "__main__":
    main()
