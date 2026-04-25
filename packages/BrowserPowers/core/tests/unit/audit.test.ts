import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock fs modules before importing audit
const mockAppendFile = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockRenameSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  renameSync: mockRenameSync,
  statSync: mockStatSync,
}));

vi.mock("node:fs/promises", () => ({
  appendFile: mockAppendFile,
}));

describe("Audit Log", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Default: audit dir doesn't exist yet
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({ size: 0 });
    mockAppendFile.mockResolvedValue(undefined);
  });

  it("writes a JSONL entry to the audit file", async () => {
    const { logAudit } = await import("../../src/audit.js");
    mockExistsSync.mockReturnValueOnce(true); // dir exists

    await logAudit({ browserId: "b-1", tool: "tabs.list", result: { success: true } });

    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const callArg = mockAppendFile.mock.calls[0][1] as string;
    expect(callArg).toContain('"browserId":"b-1"');
    expect(callArg).toContain('"tool":"tabs.list"');
    expect(callArg).toContain('"_t"');
    expect(callArg.endsWith("\n")).toBe(true);
  });

  it("creates the audit directory on first write", async () => {
    const { logAudit } = await import("../../src/audit.js");
    // existsSync returns false the first time (dir doesn't exist)
    mockExistsSync.mockReturnValueOnce(false);

    await logAudit({ tool: "test" });

    expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining("audit"), { recursive: true });
  });

  it("rotates file when exceeding 10MB", async () => {
    // Simulate: dir exists, current audit file exists and is already 10MB+
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 11 * 1024 * 1024 }); // > 10MB

    const { logAudit } = await import("../../src/audit.js");

    // First call: getCurrentFile sets currentSize from statSync (11MB)
    await logAudit({ tool: "test" });

    // Second call: rotateIfNeeded sees currentSize >= MAX_FILE_SIZE and rotates
    await logAudit({ tool: "test2" });

    expect(mockRenameSync).toHaveBeenCalledTimes(1);
    expect(mockAppendFile).toHaveBeenCalledTimes(2);
  });

  it("getAuditDir returns the configured directory path", async () => {
    const { getAuditDir } = await import("../../src/audit.js");
    const dir = getAuditDir();
    expect(dir).toContain("browserpowers");
    expect(dir).toContain("audit");
  });

  it("handles write errors gracefully without throwing", async () => {
    const { logAudit } = await import("../../src/audit.js");
    mockExistsSync.mockReturnValueOnce(true);
    mockAppendFile.mockRejectedValueOnce(new Error("Disk full"));

    // Should not throw
    await expect(logAudit({ tool: "test" })).resolves.toBeUndefined();
  });

  it("enriches entries with a timestamp", async () => {
    const { logAudit } = await import("../../src/audit.js");
    mockExistsSync.mockReturnValueOnce(true);

    await logAudit({ browserId: "b-1" });

    const written = mockAppendFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed).toHaveProperty("_t");
    expect(typeof parsed._t).toBe("string");
    expect(parsed.browserId).toBe("b-1");
  });
});
