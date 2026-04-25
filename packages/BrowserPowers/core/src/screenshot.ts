/**
 * FILE: core/src/screenshot.ts
 * PURPOSE: Save base64 screenshot data to temp files on the core filesystem.
 *          Intercepts screenshot results in the MCP handler to return file paths.
 * OWNS: Screenshot file lifecycle — save, cleanup on shutdown.
 * EXPORTS: saveScreenshotToTemp, cleanupTempScreenshots
 * DOCS: .agents/reports/plan_medium-low_2026-05-27.md (#016)
 */

import { mkdirSync, existsSync } from "node:fs";
import { writeFile, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCREENSHOT_DIR = join(tmpdir(), "browserpowers-screenshots");

function ensureDir(): void {
  if (!existsSync(SCREENSHOT_DIR)) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

/**
 * Decode base64 screenshot data and write to a temp PNG file.
 * Returns the absolute file path.
 */
export async function saveScreenshotToTemp(base64: string, browserId: string): Promise<{ filePath: string }> {
  ensureDir();

  // Auto-rotate: delete screenshots older than 1 hour
  const MAX_AGE_MS = 60 * 60 * 1000;
  try {
    const files = await readdir(SCREENSHOT_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = join(SCREENSHOT_DIR, file);
      try {
        const st = await stat(filePath);
        if (now - st.mtimeMs > MAX_AGE_MS) {
          await unlink(filePath);
        }
      } catch { /* skip individual file errors */ }
    }
  } catch { /* skip directory errors */ }

  const filename = `screenshot_${browserId}_${Date.now()}.png`;
  const filePath = join(SCREENSHOT_DIR, filename);
  const buffer = Buffer.from(base64, "base64");
  await writeFile(filePath, buffer);
  console.log(`[screenshot] Saved screenshot to ${filePath}`);
  return { filePath };
}

/**
 * Remove all screenshot files from the temp directory.
 * Called during graceful shutdown.
 */
export async function cleanupTempScreenshots(): Promise<void> {
  try {
    if (existsSync(SCREENSHOT_DIR)) {
      const files = await readdir(SCREENSHOT_DIR);
      for (const file of files) {
        try {
          await unlink(join(SCREENSHOT_DIR, file));
        } catch {
          // Ignore per-file cleanup errors
        }
      }
      console.log(`[screenshot] Cleaned up ${SCREENSHOT_DIR}`);
    }
  } catch {
    // Ignore directory-level errors
  }
}
