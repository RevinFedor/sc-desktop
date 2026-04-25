/**
 * FILE: e2e/tests/capability-smoke.test.ts
 * PURPOSE: Prove the main read, act, screenshot, cookie, and window flows end-to-end.
 * OWNS: Synthetic-page smoke coverage for the extension capability router.
 * EXPORTS: Capability smoke test suite
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

async function runApprovedTool<T>(
  browserId: string,
  executeBrowserTool: <U = unknown>(browserId: string, tool: string, params?: Record<string, unknown>) => Promise<{ success: boolean; data?: U }>,
  openPopup: () => Promise<import("@playwright/test").Page>,
  tool: string,
  params: Record<string, unknown>,
): Promise<{ success: boolean; data?: T }> {
  const requestPromise = executeBrowserTool<T>(browserId, tool, params);
  const popup = await openPopup();
  try {
    await popup.getByRole("button", { name: "Approvals" }).click();
    await expect(popup.locator("#approval-badge")).toHaveText("1");
    await popup.getByRole("button", { name: "Approve" }).click();
    const result = await requestPromise;
    expect(result.success).toBe(true);
    return result;
  } finally {
    await popup.close();
  }
}

async function loadReadPage(page: Page): Promise<void> {
  await page.goto("https://example.com/?bp=read-smoke");
  await page.evaluate(() => {
    document.head.innerHTML = "";
    const title = document.createElement("title");
    title.textContent = "Read Smoke";
    document.head.appendChild(title);
    const metaCharset = document.createElement("meta");
    metaCharset.setAttribute("charset", "UTF-8");
    document.head.appendChild(metaCharset);
    const metaDescription = document.createElement("meta");
    metaDescription.setAttribute("name", "description");
    metaDescription.setAttribute("content", "Synthetic description");
    document.head.appendChild(metaDescription);
    const ogTitle = document.createElement("meta");
    ogTitle.setAttribute("property", "og:title");
    ogTitle.setAttribute("content", "OG Read Smoke");
    document.head.appendChild(ogTitle);
    const ogDescription = document.createElement("meta");
    ogDescription.setAttribute("property", "og:description");
    ogDescription.setAttribute("content", "OG description");
    document.head.appendChild(ogDescription);
    const ogImage = document.createElement("meta");
    ogImage.setAttribute("property", "og:image");
    ogImage.setAttribute("content", "https://example.com/image.png");
    document.head.appendChild(ogImage);
    const author = document.createElement("meta");
    author.setAttribute("name", "author");
    author.setAttribute("content", "BrowserPowers");
    document.head.appendChild(author);
    const canonical = document.createElement("link");
    canonical.setAttribute("rel", "canonical");
    canonical.setAttribute("href", "https://example.com/read-smoke");
    document.head.appendChild(canonical);
    document.body.innerHTML = `
      <main>
        <h1>Read Smoke</h1>
        <p id="intro">Paragraph text for the content reader.</p>
        <form id="sample-form" name="sample-form" action="https://example.com/submit" method="post">
          <label for="full-name">Full name</label>
          <input id="full-name" name="fullName" placeholder="Ada" required />
          <label for="topic">Topic</label>
          <select id="topic" name="topic">
            <option value="alpha">Alpha</option>
            <option value="beta" selected>Beta</option>
          </select>
          <textarea id="notes" name="notes" placeholder="Notes"></textarea>
          <button id="submit-btn" type="submit">Submit</button>
        </form>
      </main>
    `;
    document.title = "Read Smoke";
  });
}

async function loadActPage(page: Page): Promise<void> {
  await page.goto("https://example.com/?bp=act-smoke");
  await page.evaluate(() => {
    document.body.innerHTML = `
      <input id="name" name="name" value="" />
      <select id="mode" name="mode">
        <option value="one">One</option>
        <option value="two">Two</option>
      </select>
      <input id="flag" type="checkbox" name="flag" />
      <button id="save">Save</button>
      <div id="status">idle</div>
      <div id="watch-target"><span>initial</span></div>
    `;
    document.getElementById("save")?.addEventListener("click", () => {
      const status = document.getElementById("status");
      if (status) status.textContent = "saved";
    });
    document.title = "Act Smoke";
  });
}

test.describe("Capability smoke", () => {
  test("page read helpers reflect a synthetic document", async ({ page, getBrowserId, executeBrowserTool }) => {
    await loadReadPage(page);
    await page.bringToFront();

    const browserId = await getBrowserId();
    const tabId = await resolveActiveTabId(browserId, executeBrowserTool, page.url());

    const meta = await executeBrowserTool<Record<string, unknown>>(browserId, "page.meta", { tabId });
    expect(meta.success).toBe(true);
    expect(meta.data).toMatchObject({
      title: "Read Smoke",
      canonicalUrl: "https://example.com/read-smoke",
      language: "en",
    });

    const content = await executeBrowserTool<{ content: string }>(browserId, "page.content", { tabId });
    expect(content.success).toBe(true);
    expect(content.data?.content).toContain("Paragraph text for the content reader.");

    const forms = await executeBrowserTool<{ forms: Array<Record<string, unknown>> }>(browserId, "page.forms", { tabId });
    expect(forms.success).toBe(true);
    expect(forms.data?.forms).toHaveLength(1);
    expect(forms.data?.forms[0]).toMatchObject({
      id: "sample-form",
      name: "sample-form",
      action: expect.stringContaining("/submit"),
      method: "POST",
    });

    const ready = await executeBrowserTool<Record<string, unknown>>(browserId, "page.ready", { tabId, timeout_ms: 1000 });
    expect(ready.success).toBe(true);
    expect(ready.data).toMatchObject({ ready: true });
  });

  test("page act helpers mutate the form and report a watched change", async ({ page, getBrowserId, executeBrowserTool, openPopup }) => {
    await loadActPage(page);
    await page.bringToFront();

    const browserId = await getBrowserId();
    const tabId = await resolveActiveTabId(browserId, executeBrowserTool, page.url());

    await runApprovedTool(browserId, executeBrowserTool, openPopup, "page.fill", { selector: "#name", value: "Ada", tabId });
    await expect(page.locator("#name")).toHaveValue("Ada");

    await runApprovedTool(browserId, executeBrowserTool, openPopup, "page.select_option", { selector: "#mode", value: "two", tabId });
    await expect(page.locator("#mode")).toHaveValue("two");

    await runApprovedTool(browserId, executeBrowserTool, openPopup, "page.check", { selector: "#flag", tabId });
    await expect(page.locator("#flag")).toBeChecked();

    await runApprovedTool(browserId, executeBrowserTool, openPopup, "page.smart_click", { text: "Save", tabId });
    await expect(page.locator("#status")).toHaveText("saved");

    const watchPromise = executeBrowserTool<{ mutations: Array<Record<string, unknown>>; count: number }>(browserId, "page.watch", {
      tabId,
      selector: "#watch-target",
      timeout_ms: 1000,
    });
    await page.evaluate(() => {
      window.setTimeout(() => {
        const target = document.getElementById("watch-target");
        if (!target) return;
        const item = document.createElement("span");
        item.textContent = "mutated";
        target.appendChild(item);
      }, 100);
    });

    const watch = await watchPromise;
    expect(watch.success).toBe(true);
    expect(watch.data?.count).toBeGreaterThan(0);
    expect(watch.data?.mutations.length).toBeGreaterThan(0);
  });

  test("screenshots, cookies, and windows round-trip", async ({ page, getBrowserId, executeBrowserTool, openPopup }) => {
    await page.goto("https://example.com");
    await page.goto("https://example.com/?bp=ops-smoke");
    const browserId = await getBrowserId();
    const tabId = await resolveActiveTabId(browserId, executeBrowserTool, page.url());

    const screenshot = await executeBrowserTool<{ base64: string; format: string }>(browserId, "screenshots.capture", { tabId });
    expect(screenshot.success).toBe(true);
    expect(screenshot.data?.format).toBe("png");
    expect(screenshot.data?.base64.length).toBeGreaterThan(0);

    const cookieUrl = "https://example.com";
    const cookieName = "bp-e2e-cookie";

    const setCookie = await runApprovedTool(browserId, executeBrowserTool, openPopup, "cookies.set", { url: cookieUrl, name: cookieName, value: "value-1" });
    expect(setCookie.data).toMatchObject({ name: cookieName, value: "value-1" });

    const getCookie = await runApprovedTool(browserId, executeBrowserTool, openPopup, "cookies.get", { url: cookieUrl, name: cookieName });
    expect(getCookie.data).toMatchObject({ name: cookieName, value: "value-1" });

    const listCookies = await runApprovedTool<{ name: string; value: string }[]>(browserId, executeBrowserTool, openPopup, "cookies.list", { url: cookieUrl });
    expect(listCookies.data?.some((cookie) => cookie.name === cookieName)).toBe(true);

    const removeCookie = await runApprovedTool(browserId, executeBrowserTool, openPopup, "cookies.remove", { url: cookieUrl, name: cookieName });
    expect(removeCookie.success).toBe(true);

    const afterRemove = await runApprovedTool<{ name: string; value: string }[]>(browserId, executeBrowserTool, openPopup, "cookies.list", { url: cookieUrl });
    expect(afterRemove.data?.some((cookie) => cookie.name === cookieName)).toBe(false);

    const createdWindow = await executeBrowserTool<{ id?: number }>(browserId, "windows.create", { url: "about:blank" });
    expect(createdWindow.success).toBe(true);
    expect(createdWindow.data?.id).toBeDefined();

    const windowId = createdWindow.data?.id;
    if (windowId === undefined) throw new Error("Expected window.create to return an id");
    const listWindows = await executeBrowserTool<Array<{ id?: number }>>(browserId, "windows.list", {});
    expect(listWindows.success).toBe(true);
    expect(listWindows.data?.some((window) => window.id === windowId)).toBe(true);

    const focusWindow = await executeBrowserTool(browserId, "windows.focus", { window_id: windowId });
    expect(focusWindow.success).toBe(true);

    const closeWindow = await executeBrowserTool(browserId, "windows.close", { window_id: windowId });
    expect(closeWindow.success).toBe(true);
  });
});
