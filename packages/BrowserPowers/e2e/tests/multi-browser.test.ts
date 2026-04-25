/**
 * FILE: e2e/tests/multi-browser.test.ts
 * PURPOSE: Prove the core can coordinate more than one connected browser.
 * OWNS: Multi-browser connection and execute-all smoke coverage.
 * EXPORTS: Multi-browser smoke test
 * DOCS: agent_chat/plan_e2e_dogfood_2026-05-11.md
 */

import { chromium } from "@playwright/test";
import { test, expect, executeAllTools } from "../fixtures";
import { mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

const EXTENSION_PATH = resolve(__dirname, "..", "..", "extension", ".output", "chrome-mv3");

function extensionArgs(): string[] {
  const normalized = EXTENSION_PATH.replace(/\\/g, "/");
  return [`--disable-extensions-except=${normalized}`, `--load-extension=${normalized}`];
}

test.describe("Multi-browser execution", () => {
  test("connects a second browser and executes across both", async ({ coreUrl, page }) => {
    await page.goto("https://example.com/?bp=multi-main");

    const userDataDir = mkdtempSync(join(tmpdir(), "browserpowers-e2e-"));
    const secondContext = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: extensionArgs(),
      viewport: { width: 1280, height: 720 },
    });
    const secondPage = await secondContext.newPage();
    await secondPage.goto("about:blank");
    await secondPage.bringToFront();

    try {
      await expect.poll(async () => {
        const response = await fetch(`${coreUrl}/api/browsers`);
        const data = await response.json() as { browsers: Array<{ id: string }> };
        return data.browsers.length;
      }, { timeout: 120_000 }).toBeGreaterThanOrEqual(2);

      const result = await executeAllTools<{ browserId: string; success: boolean }>(coreUrl, "tabs.list", {});
      expect(result.results.length).toBeGreaterThanOrEqual(2);
    } finally {
      await secondContext.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
