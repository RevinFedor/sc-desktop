import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import type { Server } from "node:http";
import { getRandomPort } from "../setup";

// Shared mock config — used by ALL tests in this file because createWsServer
// and the register handler both call loadConfig(). Mutations to this object
// are visible to every call because the mock returns the same reference.
const mockConfig = {
  port: 4199,
  host: "127.0.0.1",
  mcp: { enabled: true, path: "/mcp" },
  rest: { enabled: true, path: "/api" },
  ws: { path: "/ws", heartbeatIntervalMs: 30_000 },
  gates: { defaultPermission: "ask" as const, approvalTimeoutMs: 60_000 },
  queue: { maxDepth: 50, defaultTimeoutMs: 120_000 },
  execution: { commandMode: "sync" as const },
  browsers: {} as Record<string, unknown>,
  auth: { apiKey: "" },
};

vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(() => mockConfig),
}));

describe("WebSocket Server + Registry Integration", () => {
  let httpServer: Server;
  let port: number;
  let wsUrl: string;

  beforeEach(async () => {
    vi.resetModules();
    port = await getRandomPort();
    wsUrl = `ws://127.0.0.1:${port}/ws`;

    // Create HTTP server with WS
    const { createServer } = await import("node:http");
    httpServer = createServer();
    const { createWsServer } = await import("../../src/ws-server.js");
    createWsServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  });

  afterEach(() => {
    httpServer.close();
    httpServer.closeAllListeners?.();
  });

  it("accepts WebSocket connections", async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.close();
        resolve();
      });
      ws.on("error", reject);
    });
  });

  it("registers a browser and receives registered response", async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    ws.send(
      JSON.stringify({
        type: "register",
        payload: {
          name: "Test Browser",
          capabilities: [
            { tool: "tabs.list", description: "List tabs", group: "tabs" },
          ],
          permissions: {},
        },
      })
    );

    const raw = await new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(data.toString()));
    });
    const msg = JSON.parse(raw);
    expect(msg.type).toBe("registered");
    expect(msg.payload.browserId).toBeDefined();

    // Verify registry has the browser
    const { registry } = await import("../../src/registry.js");
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].name).toBe("Test Browser");

    ws.close();
  });

  it("sends execute command to registered browser and receives result back", async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    // Register browser
    ws.send(
      JSON.stringify({
        type: "register",
        payload: {
          name: "Exec Browser",
          capabilities: [
            { tool: "tabs.list", description: "", group: "tabs" },
          ],
          permissions: {},
        },
      })
    );

    // Wait for registered response to get browserId
    const regRaw = await new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(data.toString()));
    });
    const regMsg = JSON.parse(regRaw);
    const browserId: string = regMsg.payload.browserId;

    // Simulate what command-service does: call sendToExtension + queueRequest
    const { sendToExtension } = await import("../../src/ws-server.js");
    sendToExtension(browserId, {
      type: "execute",
      payload: {
        requestId: "integ-test-1",
        tool: "tabs.list",
        params: {},
      },
    });

    // The extension (this WS client) receives the execute command:
    const cmdRaw = await new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(data.toString()));
    });
    const cmdMsg = JSON.parse(cmdRaw);
    expect(cmdMsg.type).toBe("execute");
    expect(cmdMsg.payload.tool).toBe("tabs.list");
    expect(cmdMsg.payload.requestId).toBe("integ-test-1");

    // Send result back as if we were the extension
    ws.send(
      JSON.stringify({
        type: "result",
        payload: {
          requestId: cmdMsg.payload.requestId,
          data: [{ id: 1, url: "about:blank" }],
        },
      })
    );

    // Verify the result was resolved through the registry
    const { registry } = await import("../../src/registry.js");
    // The result was already consumed — the resolveRequest happened
    // in the ws-server message handler. There's no more message to
    // receive. Confirm the browser is still registered.
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].name).toBe("Exec Browser");

    ws.close();
  });

  it("keeps a fresh reconnect after the old socket closes", async () => {
    const ws1 = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws1.on("open", () => resolve()));

    const ws1Closed = new Promise<void>((resolve) => ws1.once("close", () => resolve()));

    ws1.send(
      JSON.stringify({
        type: "register",
        payload: {
          name: "Original Browser",
          capabilities: [{ tool: "tabs.list", description: "List tabs", group: "tabs" }],
          permissions: {},
        },
      })
    );

    const reg1Raw = await new Promise<string>((resolve) => {
      ws1.once("message", (data) => resolve(data.toString()));
    });
    const browserId: string = JSON.parse(reg1Raw).payload.browserId;

    const ws2 = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws2.on("open", () => resolve()));

    ws2.send(
      JSON.stringify({
        type: "register",
        payload: {
          name: "Reconnect Browser",
          browserId,
          capabilities: [{ tool: "tabs.list", description: "List tabs", group: "tabs" }],
          permissions: {},
        },
      })
    );

    const reg2Raw = await new Promise<string>((resolve) => {
      ws2.once("message", (data) => resolve(data.toString()));
    });
    expect(JSON.parse(reg2Raw).payload.browserId).toBe(browserId);

    await ws1Closed;

    const { sendToExtension } = await import("../../src/ws-server.js");
    sendToExtension(browserId, {
      type: "execute",
      payload: {
        requestId: "reconnect-test-1",
        tool: "tabs.list",
        params: {},
      },
    });

    const cmdRaw = await new Promise<string>((resolve) => {
      ws2.once("message", (data) => resolve(data.toString()));
    });
    const cmdMsg = JSON.parse(cmdRaw);
    expect(cmdMsg.type).toBe("execute");
    expect(cmdMsg.payload.requestId).toBe("reconnect-test-1");

    ws2.close();
  });
});

describe("WS Auth", () => {
  let httpServer: Server;
  let port: number;
  let wsUrl: string;

  beforeEach(async () => {
    vi.resetModules();
    port = await getRandomPort();
    wsUrl = `ws://127.0.0.1:${port}/ws`;

    const { createServer } = await import("node:http");
    httpServer = createServer();
    const { createWsServer } = await import("../../src/ws-server.js");
    createWsServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  });

  afterEach(() => {
    httpServer.close();
    httpServer.closeAllListeners?.();
    // Reset auth to disabled for next test
    mockConfig.auth.apiKey = "";
  });

  it("rejects register without authKey when auth is required", async () => {
    mockConfig.auth.apiKey = "test-key";

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const closePromise = new Promise<void>((resolve) => ws.once("close", () => resolve()));

    ws.send(
      JSON.stringify({
        type: "register",
        payload: {
          name: "Test Browser",
          capabilities: [{ tool: "tabs.list", description: "List tabs", group: "tabs" }],
          permissions: {},
        },
      })
    );

    // Must receive auth_required before close
    const raw = await new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(data.toString()));
    });
    const msg = JSON.parse(raw);
    expect(msg.type).toBe("auth_required");
    expect(msg.payload.message).toBe("Authentication failed");

    await closePromise;
  });

  it("rejects register with wrong authKey when auth is required", async () => {
    mockConfig.auth.apiKey = "test-key";

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const closePromise = new Promise<void>((resolve) => ws.once("close", () => resolve()));

    ws.send(
      JSON.stringify({
        type: "register",
        payload: {
          name: "Test Browser",
          capabilities: [{ tool: "tabs.list", description: "List tabs", group: "tabs" }],
          permissions: {},
          authKey: "wrong-key",
        },
      })
    );

    const raw = await new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(data.toString()));
    });
    const msg = JSON.parse(raw);
    expect(msg.type).toBe("auth_required");
    expect(msg.payload.message).toBe("Authentication failed");

    await closePromise;
  });

  it("accepts register with correct authKey", async () => {
    mockConfig.auth.apiKey = "test-key";

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    ws.send(
      JSON.stringify({
        type: "register",
        payload: {
          name: "Auth Browser",
          capabilities: [{ tool: "tabs.list", description: "List tabs", group: "tabs" }],
          permissions: {},
          authKey: "test-key",
        },
      })
    );

    const raw = await new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(data.toString()));
    });
    const msg = JSON.parse(raw);
    expect(msg.type).toBe("registered");
    expect(msg.payload.browserId).toBeDefined();

    // Verify the browser was actually registered in the registry
    const { registry } = await import("../../src/registry.js");
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].name).toBe("Auth Browser");

    ws.close();
  });

  it("accepts register without authKey when auth is disabled", async () => {
    // mockConfig.auth.apiKey is already "" from afterEach reset
    // Explicitly set it anyway for clarity
    mockConfig.auth.apiKey = "";

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    ws.send(
      JSON.stringify({
        type: "register",
        payload: {
          name: "No-Auth Browser",
          capabilities: [{ tool: "tabs.list", description: "List tabs", group: "tabs" }],
          permissions: {},
        },
      })
    );

    const raw = await new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(data.toString()));
    });
    const msg = JSON.parse(raw);
    expect(msg.type).toBe("registered");
    expect(msg.payload.browserId).toBeDefined();

    // Browser is actually in the registry
    const { registry } = await import("../../src/registry.js");
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].name).toBe("No-Auth Browser");

    ws.close();
  });
});
