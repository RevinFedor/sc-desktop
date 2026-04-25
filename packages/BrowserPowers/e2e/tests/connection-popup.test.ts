/**
 * FILE: e2e/tests/connection-popup.test.ts
 * PURPOSE: Prove browser registration and popup connection state in a real browser.
 * OWNS: Connection smoke coverage for core registration and popup UI state.
 * EXPORTS: Connection + popup smoke tests
 * DOCS: agent_chat/plan_e2e_dogfood_2026-05-11.md
 */

import { test, expect } from "../fixtures";

test.describe("Connection and Popup", () => {
  test("registers a browser with core", async ({ page, coreUrl, getBrowserId }) => {
    await page.goto("about:blank");
    await page.evaluate(() => { document.body.innerHTML = "<main>Connection Smoke</main>"; });
    await page.evaluate(() => { document.title = "Connection Smoke"; });

    const browserId = await getBrowserId();
    const response = await fetch(`${coreUrl}/api/browsers`);
    const data = await response.json() as { browsers: Array<{ id: string }> };

    expect(data.browsers.length).toBeGreaterThan(0);
    expect(data.browsers.some((browser) => browser.id === browserId)).toBe(true);
  });

  test("shows connected popup state with no pending approvals", async ({ page, getBrowserId, openPopup }) => {
    await page.goto("about:blank");
    await getBrowserId();

    const popup = await openPopup();

    try {
      if ((await popup.locator("#connection-status").textContent()) !== "Connected") {
        await popup.getByRole("button", { name: "Reconnect" }).click();
      }
      await expect(popup.locator("#connection-status")).toHaveText("Connected");
      await expect(popup.locator("#panel-settings")).toHaveClass(/\bactive\b/);
      await expect(popup.locator("#approval-badge")).toHaveText("0");
      await expect(popup.locator("#approval-badge")).toHaveClass(/\bhidden\b/);
      await expect(popup.locator("#approvals-list")).toContainText("No pending approvals.");
    } finally {
      await popup.close();
    }
  });
});
