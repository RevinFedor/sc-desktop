import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/ws-server.js", () => ({
  tryDrain: vi.fn(),
}));

describe("Registry", () => {
  let registry: typeof import("../../src/registry.js").registry;
  let tryDrain: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../src/registry.js");
    registry = mod.registry;
    tryDrain = (await import("../../src/ws-server.js")).tryDrain as ReturnType<typeof vi.fn>;
    tryDrain.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers a browser and returns its id", () => {
    const browser = registry.register(
      "browser-1",
      "Test Browser",
      [{ tool: "tabs.list", description: "List tabs", group: "tabs" }],
      {}
    );
    expect(browser.id).toBe("browser-1");
    expect(browser.name).toBe("Test Browser");
    expect(browser.capabilities).toHaveLength(1);
  });

  it("lists registered browsers", () => {
    registry.register("b-1", "Alpha", [], {});
    registry.register("b-2", "Beta", [], {});
    expect(registry.list()).toHaveLength(2);
  });

  it("unregisters a browser and removes it from list", () => {
    registry.register("b-1", "Alpha", [], {});
    registry.unregister("b-1");
    expect(registry.list()).toHaveLength(0);
  });

  it("updates heartbeat on ping", () => {
    registry.register("b-1", "Alpha", [], {});
    const before = registry.list()[0].lastHeartbeat;
    registry.heartbeat("b-1");
    const after = registry.list()[0].lastHeartbeat;
    // lastHeartbeat is a number (Date.now()), not a Date object
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("sends command to a browser and resolves result", async () => {
    registry.register("b-1", "Alpha", [], {});

    // enqueue generates requestId internally; use it for resolveRequest
    const { requestId, promise } = registry.enqueue("b-1", "tabs.list", {}, 1000);

    // Simulate extension sending result back
    registry.resolveRequest(requestId, {
      browserId: "b-1",
      tool: "tabs.list",
      success: true,
      data: ["tab1"],
    });

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.data).toEqual(["tab1"]);
  });

  it("rejects a pending request via rejectRequest", async () => {
    // enqueue does not validate browserId directly — validation
    // happens at the command-service layer. Test rejectRequest instead.
    const { requestId, promise } = registry.enqueue("b-1", "test.tool", {}, 1000);
    registry.rejectRequest(requestId, new Error("Rejected by test"));
    await expect(promise).rejects.toThrow("Rejected by test");
  });

  it("queues and resolves approval", async () => {
    registry.register("b-1", "Alpha", [], {});
    // queueApproval takes (browserId, requestId, tool, params, timeoutMs)
    const approvalPromise = registry.queueApproval("b-1", "apr-1", "screenshots.capture", {}, 1000);

    registry.resolveApproval("apr-1", true);

    const approved = await approvalPromise;
    expect(approved).toBe(true);
  });

  it("rejects approval on deny", async () => {
    registry.register("b-1", "Alpha", [], {});
    const approvalPromise = registry.queueApproval("b-1", "apr-2", "screenshots.capture", {}, 1000);

    registry.resolveApproval("apr-2", false);

    const approved = await approvalPromise;
    expect(approved).toBe(false);
  });

  it("cleans up pending approvals on unregister", async () => {
    registry.register("b-1", "Alpha", [], {});
    // requestId must start with browserId for unregister to find it
    // (unregister checks: requestId.startsWith(browserId))
    const promise = registry.queueApproval("b-1", "b-1:apr-3", "screenshots.capture", {}, 1000);

    registry.unregister("b-1");

    // The approval promise should reject because the cleanup rejects it
    await expect(promise).rejects.toThrow();
  });

  it("rejects approvals with a timeout error when no response arrives", async () => {
    vi.useFakeTimers();
    registry.register("b-1", "Alpha", [], {});

    const promise = registry.queueApproval("b-1", "b-1:apr-timeout", "screenshots.capture", {}, 1000);
    const assertion = expect(promise).rejects.toMatchObject({
      name: "ApprovalTimeoutError",
      message: "Approval request b-1:apr-timeout timed out after 1000ms",
    });

    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
  });

  it("drains the next queued request after a timeout", async () => {
    vi.useFakeTimers();
    registry.register("b-1", "Alpha", [], {});

    const first = registry.enqueue("b-1", "tabs.list", {}, 10);
    const second = registry.enqueue("b-1", "tabs.create", {}, 1_000);
    const firstAssertion = expect(first.promise).rejects.toThrow("timed out");

    await vi.advanceTimersByTimeAsync(10);

    await firstAssertion;
    expect(registry.queuedCount("b-1")).toBe(1);
    expect(tryDrain).toHaveBeenCalledWith("b-1");

    // Keep the second request from timing out during this test.
    registry.rejectRequest(second.requestId, new Error("cleanup"));
    await expect(second.promise).rejects.toThrow("cleanup");
  });

  it("rejects active and queued requests on disconnect", async () => {
    registry.register("b-1", "Alpha", [], {});

    const first = registry.enqueue("b-1", "tabs.list", {}, 1000);
    const second = registry.enqueue("b-1", "tabs.create", {}, 1000);

    // Simulate the first request already being sent to the browser.
    registry.dequeue("b-1");

    registry.rejectAllForBrowser("b-1", new Error("Browser disconnected"));

    await expect(first.promise).rejects.toThrow("Browser disconnected");
    await expect(second.promise).rejects.toThrow("Browser disconnected");
  });
});
