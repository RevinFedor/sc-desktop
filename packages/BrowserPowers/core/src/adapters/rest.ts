import { Hono } from "hono";
import { commandService } from "../command-service/service.js";
import { loadConfig } from "../config.js";
import { registry } from "../registry.js";
import { disconnectBrowser } from "../ws-server.js";
import type { Capability, PermissionProfile } from "../types.js";

const config = loadConfig();
export const restApp = new Hono();

/**
 * Resolve a browser identifier that may be a UUID or a human-readable name.
 * Tries UUID first, then falls back to name matching (case-sensitive).
 * Returns the resolved UUID or undefined if no match found.
 */
function resolveBrowserId(idOrName: string): string | undefined {
  // 1. Try direct UUID lookup
  if (registry.get(idOrName)) return idOrName;

  // 2. Try name lookup
  const byName = registry.list().find((b) => b.name === idOrName);
  return byName?.id;
}

// ── Browser listing & management ──

// GET /api/browsers — list all connected browsers
restApp.get("/browsers", (c) => {
  const browsers = registry.list().map((b) => ({
    id: b.id,
    name: b.name,
      capabilities: b.capabilities.map((cap: { tool: string }) => cap.tool),
    permissions: b.permissions,
    connectedAt: b.connectedAt,
    lastHeartbeat: b.lastHeartbeat,
  }));
  return c.json({ browsers });
});

// GET /api/browsers/:id — get one browser (accepts UUID or name)
restApp.get("/browsers/:id", (c) => {
  const browserId = resolveBrowserId(c.req.param("id"));
  if (!browserId) return c.json({ error: "Browser not found" }, 404);
  const browser = registry.get(browserId);
  return c.json(browser);
});

// DELETE /api/browsers/:id — disconnect a browser (accepts UUID or name)
restApp.delete("/browsers/:id", async (c) => {
  const browserId = resolveBrowserId(c.req.param("id"));
  if (!browserId) return c.json({ error: "Browser not found" }, 404);
  const disconnected = disconnectBrowser(browserId);
  if (!disconnected) return c.json({ error: "Failed to disconnect browser" }, 500);
  return c.json({ success: true });
});

// GET /api/browsers/:id/capabilities (accepts UUID or name)
restApp.get("/browsers/:id/capabilities", async (c) => {
  const browserId = resolveBrowserId(c.req.param("id"));
  if (!browserId) return c.json({ error: "Browser not found" }, 404);
  const caps = await commandService.getCapabilities(browserId);
  return c.json({ capabilities: caps });
});


// ── Tool execution ──

// POST /api/browsers/:id/execute — execute a tool on one browser (accepts UUID or name)
restApp.post("/browsers/:id/execute", async (c) => {
  try {
    const browserId = resolveBrowserId(c.req.param("id"));
    if (!browserId) return c.json({ success: false, error: "Browser not found" }, 404);
    const { tool, params } = await c.req.json();
    const result = await commandService.execute(browserId, tool, params ?? {});
    return c.json(result);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// POST /api/browsers/:id/execute-async — execute a tool asynchronously (accepts UUID or name)
restApp.post("/browsers/:id/execute-async", async (c) => {
  try {
    const browserId = resolveBrowserId(c.req.param("id"));
    if (!browserId) return c.json({ success: false, error: "Browser not found" }, 404);
    const { tool, params } = await c.req.json();
    const { requestId } = await commandService.executeAsync(browserId, tool, params ?? {});
    return c.json({ requestId, status: "queued" });
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// GET /api/results/:requestId — poll an async result
restApp.get("/results/:requestId", async (c) => {
  try {
    const requestId = c.req.param("requestId");
    const pollResult = await commandService.getResult(requestId);
    return c.json(pollResult);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// POST /api/execute-all — execute a tool on ALL browsers
restApp.post("/execute-all", async (c) => {
  const { tool, params } = await c.req.json();
  const results = await commandService.executeAll(tool, params ?? {});
  return c.json({ results });
});

// POST /api/execute-batch — execute multiple tools across browsers in parallel
restApp.post("/execute-batch", async (c) => {
  const { commands } = await c.req.json();
  const batch: Array<{ browserId: string; tool: string; params: Record<string, unknown> }> =
    (commands as Array<{ browser_id?: string; browserId?: string; tool: string; params?: Record<string, unknown> }>).map((cmd) => ({
      browserId: cmd.browserId ?? cmd.browser_id ?? "",
      tool: cmd.tool,
      params: cmd.params ?? {},
    }));
  const results = await commandService.executeBatch(batch);
  return c.json({ results });
});


// ── Screenshot convenience endpoint ──

// GET /api/browsers/:id/screenshot — take a screenshot (accepts UUID or name)
restApp.get("/browsers/:id/screenshot", async (c) => {
  const browserId = resolveBrowserId(c.req.param("id"));
  if (!browserId) return c.json({ error: "Browser not found" }, 500);
  const result = await commandService.execute(browserId, "screenshots.capture", {});
  if (!result.success) {
    return c.json({ error: result.error }, 500);
  }
  return c.json(result.data);
});


// ── Approvals ──

// GET /api/approvals — list all pending approval requests
restApp.get("/approvals", async (c) => {
  const approvals = registry.listPendingApprovals();
  return c.json({ approvals });
});

// DELETE /api/approvals/:id — cancel a pending approval request
restApp.delete("/approvals/:id", async (c) => {
  const id = c.req.param("id");
  const cancelled = registry.cancelApproval(id);
  if (!cancelled) {
    return c.json({ error: "Approval not found" }, 404);
  }
  return c.json({ success: true, id });
});

// ── Health ──

const startTime = Date.now();

restApp.get("/health", (c) => {
  const browsers = registry.list();
  return c.json({
    status: "ok",
    browsers: browsers.length,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    wsConnected: browsers.length,
  });
});

export default restApp;
