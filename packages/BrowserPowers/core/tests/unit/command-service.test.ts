import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({
  randomUUID: () => "fixed-uuid",
}));

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    port: 4199,
    host: "127.0.0.1",
    mcp: { enabled: true, path: "/mcp" },
    rest: { enabled: true, path: "/api" },
    ws: { path: "/ws", heartbeatIntervalMs: 30_000 },
    gates: { defaultPermission: "ask", approvalTimeoutMs: 1000 },
    queue: { maxDepth: 100, defaultTimeoutMs: 120_000 },
    execution: { commandMode: "sync" },
    browsers: {},
    auth: { apiKey: "" },
  }),
}));

vi.mock("../../src/ws-server.js", () => ({
  sendToExtension: vi.fn(),
  broadcastToExtensions: vi.fn(),
}));

describe("Command service approval flow", () => {
  let commandService: typeof import("../../src/command-service/service.js").commandService;
  let registry: typeof import("../../src/registry.js").registry;
  let sendToExtension: typeof import("../../src/ws-server.js").sendToExtension;

  beforeEach(async () => {
    vi.resetModules();
    const [serviceMod, registryMod, wsServerMod] = await Promise.all([
      import("../../src/command-service/service.js"),
      import("../../src/registry.js"),
      import("../../src/ws-server.js"),
    ]);
    commandService = serviceMod.commandService;
    registry = registryMod.registry;
    sendToExtension = wsServerMod.sendToExtension;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a denial error when the user rejects approval", async () => {
    registry.register(
      "b-1",
      "Alpha",
      [{ tool: "page.act", description: "Act on page", group: "page.act" }],
      { "page.act": "ask" },
    );

    const executePromise = commandService.execute("b-1", "page.act", { action: "click" });
    await vi.waitFor(() => expect(sendToExtension).toHaveBeenCalled());
    registry.resolveApproval("b-1:approval:fixed-uuid", false);

    await expect(executePromise).resolves.toMatchObject({
      success: false,
      error: 'Gate: User denied approval for tool group "page.act"',
    });
  });
});
