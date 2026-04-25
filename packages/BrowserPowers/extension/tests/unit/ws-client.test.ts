import { describe, it, expect, beforeEach, vi } from "vitest";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  url: string;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  send = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "closed", wasClean: true });
  }

  fail(): void {
    this.onerror?.({});
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "unavailable", wasClean: false });
  }
}

// Shared mock state for storage. Mutations to this object are reflected
// in the mocked getSettings() calls because the mock returns the reference.
// Declared BEFORE vi.mock so the factory captures the variable reference.
const mockSettings: Record<string, unknown> = {
  browserName: "test-browser",
  coreUrl: "ws://127.0.0.1:4199/ws",
  authKey: "",
  approvalNotificationsEnabled: true,
  permissions: {} as Record<string, string>,
  pageSitePermissions: {},
};

// Mock storage at the top level so it works across all describe blocks.
// Existing tests (dedup, waiting) need getSettings to return a valid URL.
vi.mock("../../src/storage.js", () => ({
  getSettings: vi.fn(() => Promise.resolve(mockSettings)),
  getEffectivePermissions: vi.fn(() => Promise.resolve({})),
}));

describe("ws-client", () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as any);
    // Prevent ws-client's offline check from trying window.addEventListener
    if (typeof navigator !== "undefined") {
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    }
  });

  it("deduplicates concurrent connect attempts", async () => {
    const { connect } = await import("../../src/ws-client.js");

    await Promise.all([connect(), connect(), connect()]);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("moves to waiting when the socket closes", async () => {
    const { connect, getConnectionStatus } = await import("../../src/ws-client.js");

    await connect();
    expect(getConnectionStatus().state).toBe("connecting");

    MockWebSocket.instances[0].fail();

    expect(getConnectionStatus().state).toBe("waiting");
  });
});

describe("auth", () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as any);
    if (typeof navigator !== "undefined") {
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    }
  });

  it("includes authKey in register payload when set in settings", async () => {
    mockSettings.authKey = "test-key";

    const { connect } = await import("../../src/ws-client.js");
    await connect();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();

    // Simulate the WebSocket opening — triggers onConnected
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen?.({});

    // Wait for the async onConnected to finish and send the register
    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalled();
    });

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe("register");
    expect(sent.payload.authKey).toBe("test-key");
  });

  it("does not include authKey in register when settings have empty authKey", async () => {
    mockSettings.authKey = "";

    const { connect } = await import("../../src/ws-client.js");
    await connect();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();

    ws.readyState = MockWebSocket.OPEN;
    ws.onopen?.({});

    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalled();
    });

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe("register");
    expect(sent.payload.authKey).toBeUndefined();
  });
});
