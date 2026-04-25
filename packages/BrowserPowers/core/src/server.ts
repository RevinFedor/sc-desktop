import { Hono } from "hono";
import { restApp } from "./adapters/rest.js";
import { mountMcpServer } from "./adapters/mcp.js";
import { loadConfig } from "./config.js";
import { registry } from "./registry.js";
import { isAuthRequired, validateApiKey } from "./auth.js";

const config = loadConfig();

/**
 * Allowed origins for HTTP requests (REST + MCP).
 *
 * Security: blocks web pages from accessing the core's internal API.
 * Only the following origins are allowed:
 *   - No Origin header (CLI, curl, desktop apps)
 *   - chrome-extension://* (Chrome extension background/popup)
 *   - moz-extension://* (Firefox extension background/popup)
 *   - http://localhost:* / http://127.0.0.1:* (local dev tools)
 */
function isOriginAllowed(origin: string | null): boolean {
  if (!origin || origin === "null") return true;

  try {
    const url = new URL(origin);
    const proto = url.protocol;

    // Browser extensions
    if (proto === "chrome-extension:" || proto === "moz-extension:") return true;

    // Localhost only (HTTP/S)
    if (proto === "http:" || proto === "https:") {
      return url.hostname === "localhost" || url.hostname === "127.0.0.1";
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Main Hono app.
 * Mounts REST routes and MCP endpoint.
 * WebSocket is handled separately (upgrade on the raw HTTP server).
 */
export function createApp(): Hono {
  const app = new Hono();

  // Auth middleware — guards REST + MCP routes (WS has its own check)
  // Placed before the origin guard so 401 takes priority over 403.
  app.use("*", async (c, next) => {
    // Skip auth for health check, root, and CORS preflight
    if (c.req.path === "/" || c.req.path === "/api/health" || c.req.method === "OPTIONS") {
      return next();
    }
    if (!isAuthRequired()) return next();

    // Try Authorization: Bearer <key> first, then X-API-Key
    const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
    const apiKey = bearer || c.req.header("X-API-Key");

    if (!validateApiKey(apiKey)) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ error: "Unauthorized — valid API key required" }, 401);
    }

    await next();
  });

  // Origin guard — block web pages from calling the core's internal API
  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");

    if (origin && !isOriginAllowed(origin)) {
      return c.json({ error: "Origin not allowed" }, 403);
    }

    // Set permissive CORS only for known-safe origins
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin);
    } else {
      c.header("Access-Control-Allow-Origin", "*");
    }
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version");
    c.header("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate");
    c.header("Vary", "Origin");

    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    await next();
  });

  // Content-Security-Policy middleware
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  });

  // Health check at root
  app.get("/", (c) => {
    const browsers = registry.list();
    return c.json({
      name: "browserpowers",
      version: "1.0.0",
      docs: "https://github.com/lirrensi/BrowserPowers",
      ws: {
        connected: browsers.length,
      },
    });
  });

  // Mount REST API
  if (config.rest.enabled) {
    app.route(config.rest.path, restApp);
    console.log(`[rest] REST API at http://localhost:${config.port}${config.rest.path}`);
  }

  // Mount MCP endpoint
  mountMcpServer(app);

  return app;
}
