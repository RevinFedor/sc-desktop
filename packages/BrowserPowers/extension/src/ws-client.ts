/**
 * FILE: extension/src/ws-client.ts
 * PURPOSE: WebSocket client connecting the extension to the BrowserPowers core.
 *          Handles connection, reconnection, heartbeat, message routing, and capability registration.
 * OWNS: WebSocket lifecycle, capability list for registration.
 * EXPORTS: connect, disconnect, send, isConnected, onMessage
 * DOCS: agent_chat/plan_adr001_v2_2026-05-12.md (Phase 4)
 */

import { getSettings, getEffectivePermissions } from "./storage";
import { isExtensionContext } from "./safety";

type MessageHandler = (msg: any) => void | Promise<void>;

export type ConnectionState = "disconnected" | "connecting" | "connected" | "waiting";

export interface ConnectionStatus {
  state: ConnectionState;
  connected: boolean;
  reconnectAttempts: number;
  authRequired: boolean;
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30_000;
const HEARTBEAT_INTERVAL = 25_000;

let messageHandler: MessageHandler | null = null;
let connectionState: ConnectionState = "disconnected";
let connectPromise: Promise<void> | null = null;
let connectPromiseGeneration = -1;
let connectionGeneration = 0;
let reconnectEnabled = true;
let authRequired = false;

export function onMessage(handler: MessageHandler): void {
  messageHandler = handler;
}

export async function connect(): Promise<void> {
  if (!isExtensionContext()) return;

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    console.log("[bp-ext] Device offline — deferring connection");
    const onOnline = () => {
      window.removeEventListener("online", onOnline);
      connect();
    };
    window.addEventListener("online", onOnline);
    return;
  }

  if (connectPromise && connectPromiseGeneration === connectionGeneration) {
    return connectPromise;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    connectionState = ws.readyState === WebSocket.OPEN ? "connected" : "connecting";
    return;
  }

  if (!reconnectEnabled) {
    reconnectEnabled = true;
  }

  clearReconnectTimer();
  connectionState = "connecting";

  const generation = connectionGeneration;
  connectPromiseGeneration = generation;
  connectPromise = (async () => {
    try {
      const settings = await getSettings();
      const url = settings.coreUrl;

      if (generation !== connectionGeneration || !reconnectEnabled) {
        return;
      }

      console.log(`[bp-ext] Connecting to core at ${url}...`);

      const socket = new WebSocket(url);
      ws = socket;

      socket.onopen = () => {
        if (socket !== ws || generation !== connectionGeneration) {
          try {
            socket.close();
          } catch {
            // ignore stale socket close failures
          }
          return;
        }

        console.log("[bp-ext] Connected to core");
        reconnectAttempts = 0;
        connectionState = "connected";
        clearReconnectTimer();
        startHeartbeat();
        void onConnected();
      };

      socket.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (messageHandler) {
          void messageHandler(msg);
        }
      };

      socket.onclose = () => {
        if (socket !== ws) {
          return;
        }

        stopHeartbeat();
        ws = null;

        if (!reconnectEnabled || generation !== connectionGeneration) {
          connectionState = "disconnected";
          return;
        }

        connectionState = "waiting";
        scheduleReconnect();
      };

      socket.onerror = () => {
        if (socket !== ws || generation !== connectionGeneration) {
          return;
        }
        connectionState = "waiting";
      };
    } catch {
      if (generation === connectionGeneration && reconnectEnabled) {
        connectionState = "waiting";
        scheduleReconnect();
      }
    }
  })().finally(() => {
    if (connectPromiseGeneration === generation) {
      connectPromise = null;
      connectPromiseGeneration = -1;
    }
  });

  return connectPromise;
}

export function disconnect(): void {
  reconnectEnabled = false;
  connectionGeneration++;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopHeartbeat();
  if (ws) {
    const socket = ws;
    ws = null;
    try {
      socket.close();
    } catch {
      // ignore close failures while shutting down
    }
  }
  connectionState = "disconnected";
}

export async function reconnect(): Promise<void> {
  disconnect();
  reconnectEnabled = true;
  reconnectAttempts = 0;
  await connect();
}

export function send(msg: any): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[bp-ext] Dropping message — WebSocket not open");
    return;
  }
  ws.send(JSON.stringify(msg));
}

export function isConnected(): boolean {
  return connectionState === "connected";
}

export function getConnectionStatus(): ConnectionStatus {
  return {
    state: connectionState,
    connected: connectionState === "connected",
    reconnectAttempts,
    authRequired,
  };
}

export function setAuthRequired(required: boolean): void {
  authRequired = required;
}

// ── internal ──

async function onConnected(): Promise<void> {
  const settings = await getSettings();
  const permissions = await getEffectivePermissions();
  const capabilities = getAvailableCapabilities({ permissions });

  // Retrieve previously saved browserId for stable identity across SW restarts
  let savedId: string | undefined;
  try {
    const stored = await chrome.storage.local.get("browserId");
    savedId = stored.browserId as string | undefined;
  } catch { /* first run — no saved ID yet */ }

  // Persistence check: verify the stored browserId is still recognized by the server.
  // If the core restarted (lost state), the server will generate a fresh ID.
  // If the ID was evicted from registry, same — fresh ID on next register.
  // In both cases, the new ID replaces the old one after successful registration.
  if (savedId) {
    console.log(`[bp-ext] Reconnecting with saved browserId: ${savedId}`);
  } else {
    console.log("[bp-ext] No saved browserId — first connection");
  }

  const registerPayload: Record<string, unknown> = {
    name: settings.browserName,
    capabilities,
    permissions,
    browserId: savedId,
  };
  if (settings.authKey) {
    registerPayload.authKey = settings.authKey;
  }
  send({ type: "register", payload: registerPayload });
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    send({ type: "heartbeat" });
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect(): void {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    console.log("[bp-ext] Device offline — skipping reconnect");
    return;
  }
  if (reconnectTimer) return;
  connectionState = "waiting";
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  console.log(`[bp-ext] Waiting to reconnect in ${delay}ms (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ── capabilities ──

interface Capability {
  tool: string;
  description: string;
  group: string;
}

function getAvailableCapabilities(settings: { permissions: Record<string, string> }): Capability[] {
  const all: Capability[] = [
    // Tabs
    { tool: "tabs.list", description: "List all open tabs", group: "tabs" },
    { tool: "tabs.create", description: "Open a new tab", group: "tabs" },
    { tool: "tabs.close", description: "Close a tab", group: "tabs" },
    { tool: "tabs.update", description: "Update a tab (navigate, focus)", group: "tabs" },
    { tool: "tabs.navigate", description: "Navigate to a URL in a new or existing tab", group: "tabs" },
    { tool: "tabs.goBack", description: "Go back in tab history", group: "tabs" },
    { tool: "tabs.goForward", description: "Go forward in tab history", group: "tabs" },

    // Page V2
    { tool: "page.read", description: "Read page content — inspect, text, html, attr, meta, forms, count, select", group: "page.read" },
    { tool: "page.act", description: "Interact with the page — click, fill, check, select, press, scroll, submit, wait", group: "page.act" },
    { tool: "page.js", description: "Execute arbitrary JavaScript on the page (escape hatch)", group: "page.execute" },

    // Screenshots
    { tool: "screenshots.capture", description: "Take a screenshot", group: "screenshots" },

    // History (read vs delete — separate permission groups)
    { tool: "history.search", description: "Search browsing history", group: "history.read" },
    { tool: "history.delete", description: "Delete history entries or wipe all", group: "history.delete" },

    // Bookmarks (read vs modify vs delete — separate permission groups)
    { tool: "bookmarks.list", description: "List bookmarks", group: "bookmarks.read" },
    { tool: "bookmarks.create", description: "Create a bookmark", group: "bookmarks.modify" },
    { tool: "bookmarks.delete", description: "Delete a bookmark", group: "bookmarks.delete" },

    // Downloads
    { tool: "downloads.list", description: "List downloads", group: "downloads" },
    { tool: "downloads.open", description: "Open a downloaded file", group: "downloads" },

    // Network
    { tool: "network.requests", description: "Get network requests", group: "network" },

    // Storage
    { tool: "storage.get", description: "Read local storage", group: "storage" },
    { tool: "storage.set", description: "Write local storage", group: "storage" },

    // Windows
    { tool: "windows.list", description: "List all open browser windows", group: "windows" },
    { tool: "windows.create", description: "Create a new browser window", group: "windows" },
    { tool: "windows.focus", description: "Focus a browser window by ID", group: "windows" },
    { tool: "windows.close", description: "Close a browser window by ID", group: "windows" },

    // Cookies
    { tool: "cookies.get", description: "Get a cookie by name and URL", group: "cookies" },
    { tool: "cookies.set", description: "Set a cookie for a URL", group: "cookies" },
    { tool: "cookies.remove", description: "Remove a cookie by name and URL", group: "cookies" },
    { tool: "cookies.list", description: "List all cookies for a URL", group: "cookies" },
  ];

  return all.filter((c) => settings.permissions[c.group] !== "deny");
}
