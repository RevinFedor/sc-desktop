import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the config module so auth.ts's loadConfig() returns controlled values.
// auth.ts calls loadConfig() on each invocation, so we can change the return
// value between tests by mutating mockConfig.
const mockConfig = {
  port: 4199,
  host: "127.0.0.1",
  mcp: { enabled: true, path: "/mcp" },
  rest: { enabled: true, path: "/api" },
  ws: { path: "/ws", heartbeatIntervalMs: 30_000 },
  gates: { defaultPermission: "ask" as const, approvalTimeoutMs: 60_000 },
  queue: { maxDepth: 50, defaultTimeoutMs: 120_000 },
  browsers: {} as Record<string, unknown>,
  auth: { apiKey: "" },
};

vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(() => mockConfig),
}));

describe("isAuthRequired", () => {
  let isAuthRequired: typeof import("../../src/auth.js").isAuthRequired;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../src/auth.js");
    isAuthRequired = mod.isAuthRequired;
  });

  it("returns false when apiKey is empty string", () => {
    mockConfig.auth.apiKey = "";
    expect(isAuthRequired()).toBe(false);
  });

  it("returns true when apiKey is non-empty", () => {
    mockConfig.auth.apiKey = "secret";
    expect(isAuthRequired()).toBe(true);
  });
});

describe("validateApiKey", () => {
  let validateApiKey: typeof import("../../src/auth.js").validateApiKey;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../src/auth.js");
    validateApiKey = mod.validateApiKey;
  });

  describe("when auth is disabled (empty key)", () => {
    beforeEach(() => {
      mockConfig.auth.apiKey = "";
    });

    it("returns true for null", () => {
      expect(validateApiKey(null)).toBe(true);
    });

    it("returns true for undefined", () => {
      expect(validateApiKey(undefined)).toBe(true);
    });

    it("returns true for empty string", () => {
      expect(validateApiKey("")).toBe(true);
    });

    it("returns true for any value", () => {
      expect(validateApiKey("anything")).toBe(true);
    });
  });

  describe("when auth is required (key configured)", () => {
    beforeEach(() => {
      mockConfig.auth.apiKey = "secret";
    });

    it("returns false when key is null", () => {
      expect(validateApiKey(null)).toBe(false);
    });

    it("returns false when key is undefined", () => {
      expect(validateApiKey(undefined)).toBe(false);
    });

    it("returns false when key is empty string", () => {
      expect(validateApiKey("")).toBe(false);
    });

    it("returns false when key does not match", () => {
      expect(validateApiKey("wrong")).toBe(false);
    });

    it("returns true when key matches", () => {
      expect(validateApiKey("secret")).toBe(true);
    });
  });
});
