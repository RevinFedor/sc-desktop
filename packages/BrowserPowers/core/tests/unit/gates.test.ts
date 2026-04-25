import { describe, it, expect, beforeEach, vi } from "vitest";

describe("checkGate", () => {
  let checkGate: typeof import("../../src/gates/middleware.js").checkGate;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../src/gates/middleware.js");
    checkGate = mod.checkGate;
  });

  it('returns allowed=true when permission is "allow"', () => {
    const result = checkGate({ tabs: "allow" }, "tabs.list");
    expect(result.allowed).toBe(true);
    expect(result.mode).toBe("allow");
  });

  it('returns allowed=false with mode "deny" when permission is "deny"', () => {
    const result = checkGate({ tabs: "deny" }, "tabs.list");
    expect(result.allowed).toBe(false);
    expect(result.mode).toBe("deny");
  });

  it('returns allowed=false with mode "ask" when permission is "ask"', () => {
    const result = checkGate({ screenshots: "ask" }, "screenshots.capture");
    expect(result.allowed).toBe(false);
    expect(result.mode).toBe("ask");
  });

  it("allows unknown tools (not in TOOL_TO_GROUP mapping)", () => {
    // Unknown tools are allowed by default (the extension declared it as a capability)
    const result = checkGate({}, "nonexistent.tool");
    expect(result.allowed).toBe(true);
    expect(result.mode).toBe("allow");
  });

  it("maps tool names to correct groups (page.act → page.act)", () => {
    const result = checkGate({ "page.act": "deny" }, "page.act");
    expect(result.allowed).toBe(false);
  });

  it("maps tool names to correct groups (page.read → page.read)", () => {
    const result = checkGate({ "page.read": "deny" }, "page.read");
    expect(result.allowed).toBe(false);
  });

  it("falls back to default permission (ask) when group has no explicit permission in profile", () => {
    // Tools in known groups with no explicit permission fall back to config default ("ask")
    const result = checkGate({}, "tabs.list");
    expect(result.allowed).toBe(false);
    expect(result.mode).toBe("ask");
  });
});
