import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { CoreToExt, ExtToCore } from "./types.js";
import { registry } from "./registry.js";
import { loadConfig } from "./config.js";
import { isAuthRequired, validateApiKey } from "./auth.js";

/** Active WebSocket connections: browserId → WebSocket */
const connections = new Map<string, WebSocket>();

/** Guard against concurrent drain loops for the same browser.
 *  Prevents two callers (result handler, scheduleDrain, register handler)
 *  from dequeueing and sending to the same browser simultaneously. */
const draining = new Set<string>();

function isActiveConnection(browserId: string, ws: WebSocket): boolean {
  return connections.get(browserId) === ws;
}

/**
 * Allowed origins for WebSocket connections.
 *
 * Blocks web pages from opening a WS connection to the core.
 * Only the following origins are allowed:
 *   - chrome-extension://* (Chrome extension background worker)
 *   - moz-extension://* (Firefox extension background worker)
 *   - No Origin header (desktop MCP clients, CLI WS tools)
 */
function isWsOriginAllowed(origin: string | null | undefined): boolean {
  if (!origin) return true;
  if (origin === "null") return true;

  try {
    const url = new URL(origin);
    const proto = url.protocol;
    if (proto === "chrome-extension:" || proto === "moz-extension:") return true;
    return false;
  } catch {
    return false;
  }
}

export function createWsServer(httpServer: Server): WebSocketServer {
  const config = loadConfig();
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade manually so we can use the same HTTP server as Hono
  httpServer.on("upgrade", (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (url.pathname.toLowerCase() !== config.ws.path.toLowerCase()) {
      socket.destroy();
      return;
    }

    // Origin check for WebSocket — prevents web pages from connecting
    const origin = request.headers.origin;
    if (!isWsOriginAllowed(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  // Heartbeat to detect stale connections
  // Only closes the WebSocket — the onclose handler handles cleanup
  // (connections.delete + registry.rejectAllForBrowser) via isActiveConnection guard,
  // which prevents racing with a reconnected connection.
  const heartbeatInterval = setInterval(() => {
    const stale = registry.findStale(config.ws.heartbeatIntervalMs * 2);
    for (const browser of stale) {
      console.log(`[ws] Browser "${browser.name}" (${browser.id}) timed out, removing`);
      const ws = connections.get(browser.id);
      if (!ws || !isActiveConnection(browser.id, ws)) continue;
      ws.close();
    }
  }, config.ws.heartbeatIntervalMs);

  wss.on("close", () => clearInterval(heartbeatInterval));

  // Handle new connections
  wss.on("connection", (ws: WebSocket) => {
    let browserId: string | null = null;

    ws.on("message", (raw) => {
      let msg: ExtToCore;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", payload: { message: "Invalid JSON" } }));
        return;
      }

      switch (msg.type) {
        case "register": {
          const { name, capabilities, permissions, browserId: savedId, commandMode } = msg.payload;

          // Validate browser name
          if (typeof name !== "string" || !name.trim()) {
            ws.send(JSON.stringify({ type: "error", payload: { message: "Registration requires a non-empty browser name" } }));
            ws.close();
            return;
          }
          if (name.length > 256) {
            ws.send(JSON.stringify({ type: "error", payload: { message: "Browser name too long (max 256 characters)" } }));
            ws.close();
            return;
          }

          // Auth check (optional — only when configured)
          if (isAuthRequired()) {
            const authKey = (msg.payload as any).authKey as string | undefined;
            if (!validateApiKey(authKey)) {
              const reply: CoreToExt = {
                type: "auth_required",
                payload: { message: "Authentication failed" },
              };
              ws.send(JSON.stringify(reply));
              ws.close();
              return;
            }
          }

          // Reuse stable ID if provided (service worker reconnect), otherwise generate new
          browserId = savedId || randomUUID();

          // If reusing an ID, clean up any stale connection/registry entry first
          if (savedId) {
            const oldWs = connections.get(savedId);
            if (oldWs && oldWs !== ws) {
              try { oldWs.close(); } catch { /* ignore */ }
            }
            connections.delete(savedId);
            // NOTE: intentionally NOT calling registry.unregister() here —
            // unregister() calls rejectAllForBrowser() which destroys queued
            // items. On reconnect the browser is the same; we only need to
            // update the WebSocket reference via register() below.
          }

          registry.register(browserId, name, capabilities, permissions, commandMode);
          connections.set(browserId, ws);

          // Start draining any queued items for this browser
          tryDrain(browserId);

          const reply: CoreToExt = {
            type: "registered",
            payload: { browserId },
          };
          ws.send(JSON.stringify(reply));
          console.log(`[ws] Browser "${name}" registered as ${browserId}${savedId ? " (reused)" : " (new)"}, caps: ${capabilities.map(c => c.tool).join(", ")}`);
          break;
        }

        case "result": {
          const { requestId, data } = msg.payload;
          registry.resolveRequest(requestId, {
            browserId: browserId ?? "unknown",
            tool: "unknown",
            success: true,
            data,
          });
          // After resolving, try to drain next queued item
          if (browserId) tryDrain(browserId);
          break;
        }

        case "error": {
          const { requestId, message } = msg.payload;
          registry.rejectRequest(requestId, new Error(message));
          if (browserId) tryDrain(browserId);
          break;
        }

        case "approval_response": {
          if (browserId && !isActiveConnection(browserId, ws)) {
            console.warn(`[ws] Ignoring approval_response from stale connection for ${browserId}`);
            break;
          }
          const { requestId, approved, timed_out } = msg.payload;
          if (timed_out) {
            // Extension auto-rejected because its own timeout fired before the user acted.
            // Core may have already timed out too — this is just a late ack.
            console.log(`[ws] Extension auto-rejected approval ${requestId} (timed_out)`);
          }
          registry.resolveApproval(requestId, approved);
          console.log(`[ws] Approval response for ${requestId}: ${approved ? "approved" : "denied"}${timed_out ? " (extension timed out)" : ""}`);
          break;
        }

        case "heartbeat": {
          if (browserId) {
            if (!isActiveConnection(browserId, ws)) {
              console.warn(`[ws] Ignoring heartbeat from stale connection for ${browserId}`);
              break;
            }
            registry.heartbeat(browserId);
            ws.send(JSON.stringify({ type: "heartbeat_ack" } satisfies CoreToExt));
          }
          break;
        }

        default:
          console.warn(`[ws] Unknown message type from ${browserId}:`, msg);
      }
    });

    ws.on("close", () => {
      if (browserId) {
        if (!isActiveConnection(browserId, ws)) {
          console.log(`[ws] Ignoring stale close for ${browserId}`);
          return;
        }

        console.log(`[ws] Browser ${browserId} disconnected`);
        connections.delete(browserId);
        // Unregister removes the browser from the list AND rejects all pending
        // queued requests and approvals — keeps the browser list accurate
        registry.unregister(browserId);
      }
    });

    ws.on("error", (err) => {
      console.error(`[ws] Error on ${browserId}:`, err.message);
    });
  });

  console.log(`[ws] WebSocket server ready at ws://localhost:${config.port}${config.ws.path}`);
  return wss;
}

/**
 * Send a message to a specific browser extension.
 * Throws if the browser is not connected.
 */
export function sendToExtension(browserId: string, message: CoreToExt): void {
  const ws = connections.get(browserId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error(`Browser ${browserId} is not connected`);
  }
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Socket can transition to CLOSING between readyState check and send()
    throw new Error(`Browser ${browserId} send failed (socket closed)`);
  }
}

/**
 * Broadcast a message to all connected browsers.
 */
export function broadcastToExtensions(message: CoreToExt): void {
  for (const [, ws] of connections) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    } catch {
      // Socket can be in CLOSING state — ignore
    }
  }
}

/**
 * Disconnect a browser by closing its WebSocket connection.
 * The onclose handler will clean up registry entries.
 */
export function disconnectBrowser(browserId: string): boolean {
  const ws = connections.get(browserId);
  if (!ws) return false;
  try {
    ws.close();
    connections.delete(browserId);
    registry.unregister(browserId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to send the next queued item to a browser.
 * Only sends if: browser is connected, not busy, not already draining, and queue is non-empty.
 * Sends at most ONE item per call. The draining flag is released when the browser
 * responds with result/error, triggering the next drain cycle.
 *
 * Guarded by `draining` set to prevent concurrent drains from multiple callers
 * (result handler, scheduleDrain, register handler can all fire simultaneously).
 */
export function tryDrain(browserId: string): void {
  // Guard: prevent concurrent drain loops
  if (draining.has(browserId)) return;
  draining.add(browserId);

  // Use microtask to ensure we're not holding the drain lock while sending
  queueMicrotask(() => {
    const ws = connections.get(browserId);
    const isBusy = registry.isBusy(browserId);
    // Re-check after microtask — browser state may have changed
    if (!ws || ws.readyState !== WebSocket.OPEN || isBusy) {
      draining.delete(browserId);
      return;
    }

    const item = registry.dequeue(browserId);
    if (!item) {
      draining.delete(browserId);
      return;
    }

    registry.setBusy(browserId);
    const browser = registry.get(browserId);
    ws.send(JSON.stringify({
      type: "execute",
      payload: {
        requestId: item.requestId,
        tool: item.tool,
        params: item.params,
        commandMode: browser?.commandMode ?? "sync",
      },
    } satisfies CoreToExt));

    // Don't remove from draining here — the next drain cycle is triggered
    // by the result/error handler when the browser responds.
    // But if no response comes, the timeout will reject the request
    // and scheduleDrain() will call tryDrain() again.
    // We need to release the drain guard so the next cycle can proceed.
    draining.delete(browserId);
  });
}
