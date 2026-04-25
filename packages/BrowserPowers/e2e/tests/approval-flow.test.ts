/**
 * FILE: e2e/tests/approval-flow.test.ts
 * PURPOSE: Prove popup-mediated approval and denial for ask-mode page clicks.
 * OWNS: End-to-end coverage for the real approval queue and popup actions.
 * EXPORTS: Approval Flow test suite
 * DOCS: agent_chat/plan_e2e_dogfood_2026-05-11.md
 */

import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

async function resolveActiveTabId(
  browserId: string,
  executeBrowserTool: <T = unknown>(browserId: string, tool: string, params?: Record<string, unknown>) => Promise<{ success: boolean; data?: T }>,
  identifier: string,
): Promise<number> {
  const activeTabs = await executeBrowserTool<Array<{ id?: number; active?: boolean; title?: string; url?: string }>>(browserId, "tabs.list", {
    active: true,
    currentWindow: true,
  });
  const activeTab = activeTabs.data?.find((entry) => typeof entry.id === "number");
  if (activeTab?.id) return activeTab.id;

  const tabs = await executeBrowserTool<Array<{ id?: number; active?: boolean; title?: string; url?: string }>>(browserId, "tabs.list", {});
  const tab = tabs.data?.find((entry: any) => (
    entry.title === identifier ||
    (typeof entry.url === "string" && entry.url.includes(identifier))
  ) && typeof entry.id === "number")
    ?? tabs.data?.find((entry) => entry.active && typeof entry.id === "number")
    ?? tabs.data?.find((entry) => typeof entry.id === "number");
  if (!tab?.id) throw new Error("No active tab found");
  return tab.id;
}

async function loadClickablePage(page: Page): Promise<void> {
  await page.goto("https://example.com/?bp=approval-flow");
  await page.evaluate(() => {
    document.body.innerHTML = `
      <button id="target" data-state="start">Start</button>
    `;
    const target = document.getElementById("target");
    target?.addEventListener("click", () => {
      target.textContent = "Clicked";
      target.dataset.state = "clicked";
    });
    document.title = "Approval Flow";
  });
}

test.describe("Approval Flow", () => {
  test("approve path completes the click", async ({ page, getBrowserId, openPopup, executeBrowserTool }) => {
    await loadClickablePage(page);
    await page.bringToFront();

    const browserId = await getBrowserId();
    const tabId = await resolveActiveTabId(browserId, executeBrowserTool, page.url());
    const executePromise = executeBrowserTool(browserId, "page.click", { selector: "#target", tabId });
    const popup = await openPopup();

    try {
      await popup.getByRole("button", { name: "Approvals" }).click();
      await expect(popup.locator("#approval-badge")).toHaveText("1");
      await expect(popup.locator(".approval-item", { hasText: "page.click" })).toBeVisible();

      await popup.getByRole("button", { name: "Approve" }).click();

      const result = await executePromise;
      expect(result.success).toBe(true);
      await expect(page.locator("#target")).toHaveText("Clicked");
      await expect(page.locator("#target")).toHaveAttribute("data-state", "clicked");
    } finally {
      await popup.close();
    }
  });

  test("deny path leaves the page unchanged", async ({ page, getBrowserId, openPopup, executeBrowserTool }) => {
    await loadClickablePage(page);
    await page.bringToFront();

    const browserId = await getBrowserId();
    const tabId = await resolveActiveTabId(browserId, executeBrowserTool, page.url());
    const executePromise = executeBrowserTool(browserId, "page.click", { selector: "#target", tabId });
    const popup = await openPopup();

    try {
      await popup.getByRole("button", { name: "Approvals" }).click();
      await expect(popup.locator("#approval-badge")).toHaveText("1");
      await expect(popup.locator(".approval-item", { hasText: "page.click" })).toBeVisible();

      await popup.getByRole("button", { name: "Deny" }).click();

      const result = await executePromise;
      expect(result.success).toBe(false);
      await expect(page.locator("#target")).toHaveText("Start");
      await expect(page.locator("#target")).toHaveAttribute("data-state", "start");
    } finally {
      await popup.close();
    }
  });
});
