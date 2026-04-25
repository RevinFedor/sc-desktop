import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock fs modules
const mockWriteFile = vi.fn();
const mockReaddir = vi.fn();
const mockUnlink = vi.fn();
const mockStat = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}));

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  readdir: mockReaddir,
  unlink: mockUnlink,
  stat: mockStat,
}));

describe("Screenshot Manager", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockWriteFile.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockUnlink.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ mtimeMs: Date.now() });
  });

  it("saves base64 screenshot data to a PNG file", async () => {
    const { saveScreenshotToTemp } = await import("../../src/screenshot.js");
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    mockExistsSync.mockReturnValueOnce(false); // dir doesn't exist
    const result = await saveScreenshotToTemp(base64, "browser-test-1");

    expect(result).toHaveProperty("filePath");
    expect(result.filePath).toContain("browserpowers-screenshots");
    expect(result.filePath).toContain("browser-test-1");
    expect(result.filePath).toContain(".png");
    expect(mockMkdirSync).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    // Verify it's actually a buffer being written
    expect(mockWriteFile.mock.calls[0][1] instanceof Uint8Array || mockWriteFile.mock.calls[0][1] instanceof Buffer).toBe(true);
  });

  it("cleans up old screenshots (>1 hour) on save", async () => {
    const { saveScreenshotToTemp } = await import("../../src/screenshot.js");
    const oldFile = "old_screenshot.png";
    const base64 = "AAAA";

    mockExistsSync.mockReturnValueOnce(true); // dir exists
    mockReaddir.mockResolvedValueOnce([oldFile]);
    mockStat.mockResolvedValueOnce({ mtimeMs: Date.now() - 2 * 60 * 60 * 1000 }); // 2 hours old

    await saveScreenshotToTemp(base64, "b-1");

    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining(oldFile));
  });

  it("does not clean up recent screenshots (<1 hour)", async () => {
    const { saveScreenshotToTemp } = await import("../../src/screenshot.js");
    const recentFile = "recent_screenshot.png";
    const base64 = "AAAA";

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddir.mockResolvedValueOnce([recentFile]);
    mockStat.mockResolvedValueOnce({ mtimeMs: Date.now() - 30 * 60 * 1000 }); // 30 min old

    await saveScreenshotToTemp(base64, "b-1");

    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("handles cleanup errors gracefully without throwing", async () => {
    const { saveScreenshotToTemp } = await import("../../src/screenshot.js");
    const base64 = "AAAA";

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddir.mockRejectedValueOnce(new Error("Permission denied"));

    await expect(saveScreenshotToTemp(base64, "b-1")).resolves.toHaveProperty("filePath");
  });

  it("cleanupTempScreenshots removes all screenshots", async () => {
    const { cleanupTempScreenshots } = await import("../../src/screenshot.js");

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddir.mockResolvedValueOnce(["shot1.png", "shot2.png"]);

    await cleanupTempScreenshots();

    expect(mockUnlink).toHaveBeenCalledTimes(2);
  });

  it("cleanupTempScreenshots handles missing directory gracefully", async () => {
    const { cleanupTempScreenshots } = await import("../../src/screenshot.js");

    mockExistsSync.mockReturnValueOnce(false);

    await expect(cleanupTempScreenshots()).resolves.toBeUndefined();
    expect(mockReaddir).not.toHaveBeenCalled();
  });
});
