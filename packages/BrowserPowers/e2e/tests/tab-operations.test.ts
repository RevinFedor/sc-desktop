import { test, expect } from "../fixtures";

test.describe("Tab Operations", () => {
  test("tabs.list via REST API returns array of tabs", async ({
    coreUrl,
    getBrowserId,
    page,
  }) => {
    // 1. Open a tab
    await page.goto("about:blank");
    await page.evaluate(() => { document.body.innerHTML = "<main>Tab Operations Smoke</main>"; });
    await page.evaluate(() => { document.title = "Tab Operations Smoke"; });

    // 2. Wait for the extension to register with core and get its ID
    const browserId = await getBrowserId();

    // 3. Send execute command via REST API
    const res = await fetch(`${coreUrl}/api/browsers/${browserId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "tabs.list",
        params: {},
      }),
    });

    const result = await res.json();

    // 4. Assert the result
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test("unknown tool returns error", async ({ coreUrl, getBrowserId, page }) => {
    await page.goto("about:blank");

    const browserId = await getBrowserId();

    const res = await fetch(`${coreUrl}/api/browsers/${browserId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "nonexistent.tool",
        params: {},
      }),
    });

    const result = await res.json();
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
