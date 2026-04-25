/**
 * FILE: e2e/fixtures.ts
 * PURPOSE: Share deterministic Playwright helpers for BrowserPowers e2e tests.
 * OWNS: Core URL, browser lookup, popup access, and REST execution helpers.
 * EXPORTS: test, expect, waitForBrowserId, waitForExtensionServiceWorker, readPopupUrl, openExtensionPopup, executeBrowserTool, executeAllTools
 * DOCS: agent_chat/plan_e2e_dogfood_2026-05-11.md, playwright.config.ts, e2e/setup.ts
 */

import { chromium, test as base, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

export { expect } from "@playwright/test";

const CORE_URL = "http://127.0.0.1:4199";
const EXTENSION_ORIGIN = "chrome-extension://";
const EXTENSION_PATH = resolve(process.cwd(), "extension", ".output", "chrome-mv3");

type ExecuteResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

async function jsonFetch<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  return response.json() as Promise<T>;
}

/** Wait until a browser is connected to core, then return its ID. */
export async function waitForBrowserId(baseUrl: string, timeoutMs = 60_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const data = await jsonFetch<{ browsers: Array<{ id: string }> }>(`${baseUrl}/api/browsers`, {
        method: "GET",
      });
      if (data.browsers.length > 0) {
        return data.browsers[data.browsers.length - 1].id;
      }
    } catch {
      // Core REST API not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No browser connected to core after ${timeoutMs}ms`);
}

/** Wait for the extension service worker and return it. */
export async function waitForExtensionServiceWorker(context: BrowserContext, timeoutMs = 60_000): Promise<Worker> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const existing = context.serviceWorkers().find((worker) => worker.url().startsWith(EXTENSION_ORIGIN));
    if (existing) return existing;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Extension service worker was not available after ${timeoutMs}ms`);
}

/** Read popup.html via chrome.runtime.getURL from the service worker. */
export async function readPopupUrl(worker: Worker): Promise<string> {
  return await worker.evaluate(() => chrome.runtime.getURL("popup.html"));
}

/** Open the extension popup and wait for it to finish loading. */
export async function openExtensionPopup(context: BrowserContext, popupUrl: string): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await popup.waitForLoadState("domcontentloaded");
  return popup;
}

/** POST /api/browsers/:id/execute and return the parsed JSON result. */
export async function executeBrowserTool<T = unknown>(
  baseUrl: string,
  browserId: string,
  tool: string,
  params: Record<string, unknown> = {},
): Promise<ExecuteResponse<T>> {
  return await jsonFetch<ExecuteResponse<T>>(`${baseUrl}/api/browsers/${browserId}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, params }),
  });
}

/** POST /api/execute-all and return the parsed JSON result. */
export async function executeAllTools<T = unknown>(
  baseUrl: string,
  tool: string,
  params: Record<string, unknown> = {},
): Promise<{ results: T[] }> {
  return await jsonFetch<{ results: T[] }>(`${baseUrl}/api/execute-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, params }),
  });
}

type TestFixtures = {
  context: BrowserContext;
  page: Page;
  coreUrl: string;
  getBrowserId: () => Promise<string>;
  openPopup: () => Promise<Page>;
  executeBrowserTool: <T = unknown>(browserId: string, tool: string, params?: Record<string, unknown>) => Promise<ExecuteResponse<T>>;
  executeAllTools: <T = unknown>(tool: string, params?: Record<string, unknown>) => Promise<{ results: T[] }>;
};

export const test = base.extend<TestFixtures>({
  context: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), "browserpowers-e2e-"));
    const normalized = EXTENSION_PATH.replace(/\\/g, "/");
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: !!process.env.CI || !!process.env.HEADLESS,
      viewport: { width: 1280, height: 720 },
      args: [`--disable-extensions-except=${normalized}`, `--load-extension=${normalized}`],
    });

    try {
      await use(context);
    } finally {
      await context.close();
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Retry after a short delay (Windows file locks)
        setTimeout(() => {
          try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
        }, 100);
      }
    }
  },
  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? await context.newPage();
    await use(page);
  },
  coreUrl: CORE_URL,
  getBrowserId: async ({}, use) => {
    await use(async () => {
      const start = Date.now();
      while (Date.now() - start < 60_000) {
        try {
          const response = await fetch(`${CORE_URL}/api/browsers`, { method: "GET" });
          const data = await response.json() as { browsers: Array<{ id: string }> };
          if (data.browsers.length > 0) {
            return data.browsers[data.browsers.length - 1].id;
          }
        } catch {
          // Core REST API not ready yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("browser was not registered with core");
    });
  },
  openPopup: async ({ context }, use) => {
    await use(async () => {
      const worker = await waitForExtensionServiceWorker(context);
      const popupUrl = await readPopupUrl(worker);
      return await openExtensionPopup(context, popupUrl);
    });
  },
  executeBrowserTool: async ({ coreUrl }, use) => {
    await use(async (browserId, tool, params = {}) => executeBrowserTool(coreUrl, browserId, tool, params));
  },
  executeAllTools: async ({ coreUrl }, use) => {
    await use(async (tool, params = {}) => executeAllTools(coreUrl, tool, params));
  },
});
