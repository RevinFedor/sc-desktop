import { describe, it, expect, beforeEach, vi } from "vitest";

describe("capability-router", () => {
  let routeExecute: typeof import("../../src/capability-router.js").routeExecute;

  beforeEach(async () => {
    vi.resetModules();

    // Ensure chrome mocks are still active
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        onMessage: { addListener: vi.fn() },
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        query: vi.fn().mockResolvedValue([
          { id: 1, url: "https://example.com", title: "Example" },
        ]),
        create: vi.fn().mockResolvedValue({ id: 2 }),
        update: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue(undefined),
        captureVisibleTab: vi.fn().mockResolvedValue("data:image/png;base64,abc"),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: "hello" }]),
      },
      windows: {
        getAll: vi.fn().mockResolvedValue([
          { id: 1, type: "normal", state: "normal" },
        ]),
      },
      cookies: {
        get: vi.fn().mockResolvedValue({ name: "test", value: "val" }),
        getAll: vi.fn().mockResolvedValue([{ name: "test", value: "val" }]),
      },
      storage: {
        local: { get: vi.fn(), set: vi.fn() },
      },
      action: {
        setBadgeText: vi.fn(),
        setBadgeBackgroundColor: vi.fn(),
      },
      webRequest: {
        onBeforeRequest: { addListener: vi.fn() },
        onCompleted: { addListener: vi.fn() },
      },
    } as any);

    // Bypass isExtensionContext
    vi.stubGlobal("process", {
      ...process,
      versions: { ...process.versions, node: undefined },
    });
  });

  it("tabs.list returns paginated tab results", async () => {
    const { routeExecute } = await import("../../src/capability-router.js");
    const result = await routeExecute({
      requestId: "test-1",
      tool: "tabs.list",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("tabs");
    expect(Array.isArray(result.data.tabs)).toBe(true);
    expect(result.data.tabs).toHaveLength(1);
    expect(result.data).toHaveProperty("totalCount", 1);
  });

  it("screenshots.capture returns base64 image", async () => {
    const { routeExecute } = await import("../../src/capability-router.js");
    const result = await routeExecute({
      requestId: "test-3",
      tool: "screenshots.capture",
      params: {},
    });
    expect(result.success).toBe(true);
    // The implementation returns { base64, format: "png" }
    expect(result.data).toHaveProperty("base64");
    expect(result.data).toHaveProperty("format", "png");
  });

  it("returns error for unknown tool", async () => {
    const { routeExecute } = await import("../../src/capability-router.js");
    const result = await routeExecute({
      requestId: "test-4",
      tool: "nonexistent.tool",
      params: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("cookies.get returns a cookie", async () => {
    const { routeExecute } = await import("../../src/capability-router.js");
    const result = await routeExecute({
      requestId: "test-5",
      tool: "cookies.get",
      params: { url: "https://example.com", name: "test" },
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("name", "test");
    expect(result.data).toHaveProperty("value", "val");
  });
});
