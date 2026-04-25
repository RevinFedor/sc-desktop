/**
 * Service Worker — keeps the WebSocket alive and handles tool execution.
 * This is the bridge between the BrowserPowers core and this browser's chrome.* APIs.
 */

import { connect, reconnect, onMessage, isConnected, send, getConnectionStatus, disconnect } from "../src/ws-client";
import { routeExecute, type ExecuteRequest } from "../src/capability-router";
import { isExtensionContext } from "../src/safety";
import { getSettings, saveSettings, saveSessionPermissionOverride, clearSessionPermissionOverride, getPageSitePermissions, addSitePattern } from "../src/storage";
import { normalizeHostname, resolvePagePermission } from "../src/site-permissions";

interface PendingApproval {
  requestId: string;
  tool: string;
  params: Record<string, unknown>;
  description: string;
  group: string;
  title?: string;
  url?: string;
  notificationId: string;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_UI_MS = 60_000;
const APPROVAL_NOTIFICATION_PREFIX = "bp-approval:";

/** FIFO queue for sequential WebSocket message processing */
const messageQueue: any[] = [];
let processingMessage = false;

export default {
  main(): void {
    // Only run in actual browser extension context
    if (!isExtensionContext()) return;

    init();
  },
};

async function processNextMessage(): Promise<void> {
  if (processingMessage) return;
  processingMessage = true;
  try {
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      try {
        await handleCoreMessage(msg);
      } catch (err) {
        console.error(`[bp-ext] Error handling core message (${msg?.type ?? "unknown"}):`, (err as Error).message);
        // Continue processing remaining messages — don't let one bad message deadlock the queue
      }
    }
  } finally {
    processingMessage = false;
  }
}

async function handleCoreMessage(msg: any): Promise<void> {
  switch (msg.type) {
    case "registered": {
        const browserId = msg.payload.browserId as string;
        console.log(`[bp-ext] Registered as browser: ${browserId}`);
        chrome.storage.local.set({ browserId });
        break;
      }

      case "execute": {
        const req = msg.payload as ExecuteRequest;
        console.log(`[bp-ext] Executing: ${req.tool} (${req.requestId})`);
        const result = await routeExecute(req);
        send({
          type: result.success ? "result" : "error",
          payload: result.success
            ? { requestId: result.requestId, data: result.data }
            : { requestId: result.requestId, message: result.error },
        });
        break;
      }

      case "heartbeat_ack": {
        break;
      }

      case "config_updated": {
        console.log("[bp-ext] Config updated from core:", msg.payload);
        break;
      }

      case "auth_required": {
        console.warn("[bp-ext] Core requires API key — disconnecting");
        disconnect();
        const { setAuthRequired } = await import("../src/ws-client.js");
        setAuthRequired(true);
        break;
      }

      case "request_approval": {
        const { requestId, tool, params, description } = msg.payload;
        console.log(`[bp-ext] Approval requested: ${tool} (${requestId})`);

        // ── Site-pattern check ──
        // Only relevant for page tools. Check if site rules already cover this.
        const isPageTool = tool === "page.read" || tool === "page.act" || tool === "page.js";
        const { title, url } = await getActiveTabContext();
        if (isPageTool && url) {
          const pageSites = await getPageSitePermissions();
          const groupKey = tool === "page.js" ? "page.execute" : (tool as any);
          const lists = pageSites[groupKey];
          if (lists) {
            const decision = resolvePagePermission(url, lists);
            if (decision === "allow") {
              console.log(`[bp-ext] Site rule auto-approves ${tool} on ${url}`);
              send({ type: "approval_response", payload: { requestId, approved: true } });
              updateBadge();
              return;
            }
            if (decision === "deny") {
              console.log(`[bp-ext] Site rule denies ${tool} on ${url}`);
              send({ type: "approval_response", payload: { requestId, approved: false } });
              updateBadge();
              return;
            }
            // decision === "ask" → fall through to normal prompt
          }
        }

        const group = resolvePermissionGroup(tool);
        const notificationId = `${APPROVAL_NOTIFICATION_PREFIX}${requestId}`;

        const timeoutTimer = setTimeout(async () => {
          // Notify core that this approval timed out on the extension side
          // This prevents the core from accepting a late user response after timeout
          send({ type: "approval_response", payload: { requestId, approved: false, timed_out: true } });
          await dismissPendingApproval(requestId, { keepNotification: false });
        }, APPROVAL_TIMEOUT_UI_MS);

        pendingApprovals.set(requestId, {
          requestId,
          tool,
          params,
          description,
          group,
          title,
          url,
          notificationId,
          timeoutTimer,
        });
        updateBadge();
        const settings = await getSettings();
        if (settings.approvalNotificationsEnabled) {
          void createApprovalNotification({ requestId, tool, description, title, url, notificationId });
        }
        break;
      }

      default:
        console.warn("[bp-ext] Unknown message:", msg.type);
    }
}

function init(): void {
  // Connect when service worker starts
  connect();

  // Register MAIN world console capture script via registerContentScripts
  // (different Chrome internal code path than executeScript — works where
  // executeScript({ world: "MAIN" }) silently fails).
  chrome.scripting.registerContentScripts([{
    id: "bp-main-console-capture",
    matches: ["<all_urls>"],
    js: ["capture.js"],
    world: "MAIN",
    runAt: "document_start",
  }]).catch(() => {
    // Already registered — expected on SW restart
  });

  // MV3 service worker stability: re-check connection on browser startup
  // (fires when the browser fully restarts, not on service worker wake)
  chrome.runtime.onStartup?.addListener(() => {
    console.log("[bp-ext] Browser startup detected, verifying connection...");
    if (!isConnected()) {
      void reconnect();
    }
  });

  // Graceful WS close before service worker suspends (MV3)
  // The disconnect sends a best-effort frame; if the SW suspends mid-send, the
  // core will detect the stale connection via heartbeat timeout.
  chrome.runtime.onSuspend?.addListener(() => {
    console.log("[bp-ext] Service worker suspending, closing WebSocket...");
    disconnect();
  });

  // Update onMessage to use FIFO queue
  onMessage((msg: any) => {
    messageQueue.push(msg);
    // Fire-and-forget: processNextMessage handles its own errors internally
    processNextMessage().catch((err) => {
      console.error("[bp-ext] processNextMessage unexpected rejection:", (err as Error).message);
    });
  });

  // Reconnect when storage changes (user updated settings in popup)
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.settings) {
      console.log("[bp-ext] Settings changed, reconnecting...");
      void reconnect();
    }

    if (namespace === "session" && changes.sessionPermissionOverrides) {
      console.log("[bp-ext] Session permissions changed, reconnecting...");
      void reconnect();
    }
  });

  chrome.notifications.onClicked.addListener((notificationId) => {
    if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return;
    void chrome.action.openPopup?.();
  });

  // Keep service worker alive via chrome.alarms (MV3 workaround)
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") {
      chrome.storage.local.get("browserId");
      if (!isConnected()) {
        connect();
      }
    }
  });

  // Listen for messages from the popup
  chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    switch (message.type) {
      case "getConnectionStatus": {
        sendResponse(getConnectionStatus());
        break;
      }

      case "reconnectToCore": {
        void reconnect();
        sendResponse({ success: true });
        break;
      }

      case "getPendingApprovals": {
        sendResponse(Array.from(pendingApprovals.values()));
        break;
      }

      case "approveRequest": {
        const requestId = message.requestId as string;
        const scope = (message.scope ?? "once") as "once" | "session" | "forever";
        const approval = pendingApprovals.get(requestId);
        if (approval) {
          void handleApprovalDecision(approval, scope);
        }
        sendResponse({ success: !!approval });
        break;
      }

      case "approveRequestOnce": {
        const requestId = message.requestId as string;
        const approval = pendingApprovals.get(requestId);
        if (approval) {
          void handleApprovalDecision(approval, "once");
        }
        sendResponse({ success: !!approval });
        break;
      }

      case "approveRequestSession": {
        const requestId = message.requestId as string;
        const approval = pendingApprovals.get(requestId);
        if (approval) {
          void handleApprovalDecision(approval, "session");
        }
        sendResponse({ success: !!approval });
        break;
      }

      case "approveRequestForever": {
        const requestId = message.requestId as string;
        const approval = pendingApprovals.get(requestId);
        if (approval) {
          void handleApprovalDecision(approval, "forever");
        }
        sendResponse({ success: !!approval });
        break;
      }

      case "denyRequest": {
        const requestId = message.requestId as string;
        const approval = pendingApprovals.get(requestId);
        if (approval) {
          void handleRejection(approval);
        }
        sendResponse({ success: !!approval });
        break;
      }

      default:
        return false; // not handled
    }
    return true; // keep channel open for async response
  });
}

function updateBadge(): void {
  const count = pendingApprovals.size;
  if (count > 0) {
    chrome.action.setBadgeText({ text: "•" });
    chrome.action.setBadgeBackgroundColor({ color: "#eab308" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function resolvePermissionGroup(tool: string): string {
  // V2 page tools
  if (tool === "page.js") return "page.execute";
  if (tool.startsWith("page.")) return tool;

  // Browser API tools — map to their granular permission group
  switch (tool) {
    case "history.search": return "history.read";
    case "history.delete": return "history.delete";
    case "bookmarks.list": return "bookmarks.read";
    case "bookmarks.create": return "bookmarks.modify";
    case "bookmarks.delete": return "bookmarks.delete";
  }

  // Fallback: first segment of dotted name (e.g. "tabs.list" → "tabs")
  return tool.split(".")[0] ?? tool;
}

async function getActiveTabContext(): Promise<{ title?: string; url?: string }> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = tabs[0];
    if (!active) return {};
    return { title: active.title, url: active.url };
  } catch {
    return {};
  }
}

function buildNotificationIconUrl(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" fill="none"><rect width="128" height="128" rx="28" fill="#1a1a25"/><circle cx="64" cy="64" r="34" fill="#a78bfa"/><path d="M46 58h36v12H46z" fill="#0f0f14"/><path d="M54 48h20v8H54z" fill="#0f0f14"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function createApprovalNotification(approval: PendingApproval): Promise<void> {
  try {
    await chrome.notifications.create(approval.notificationId, {
      type: "basic",
      iconUrl: buildNotificationIconUrl(),
      title: `Approval needed: ${approval.tool}`,
      message: [approval.description, approval.url ?? approval.title ?? ""].filter(Boolean).join("\n"),
      priority: 2,
      requireInteraction: true,
    });
  } catch (err) {
    console.warn("[bp-ext] Failed to create approval notification:", (err as Error).message);
  }
}

async function dismissPendingApproval(
  requestId: string,
  options: { keepNotification: boolean },
): Promise<void> {
  const approval = pendingApprovals.get(requestId);
  if (!approval) return;

  clearTimeout(approval.timeoutTimer);
  pendingApprovals.delete(requestId);
  updateBadge();

  if (!options.keepNotification) {
    try {
      await chrome.notifications.clear(approval.notificationId);
    } catch {
      // ignore
    }
  }
}

async function handleApprovalDecision(
  approval: PendingApproval,
  scope: "once" | "session" | "forever",
): Promise<void> {
  send({ type: "approval_response", payload: { requestId: approval.requestId, approved: true } });
  await dismissPendingApproval(approval.requestId, { keepNotification: false });

  const isPageTool =
    approval.tool === "page.read" || approval.tool === "page.act" || approval.tool === "page.js";

  if (scope === "once") {
    // No persistence needed
    return;
  }

  if (isPageTool && approval.url) {
    const hostname = normalizeHostname(approval.url);
    if (!hostname) return;

    if (scope === "session") {
      // Save to session storage for site rule
      await addSitePattern(
        approval.group as any,
        "allow",
        hostname,
      );
      // Also set session override so core doesn't re-ask
      await saveSessionPermissionOverride(approval.group, "allow");
    }

    if (scope === "forever") {
      await addSitePattern(
        approval.group as any,
        "allow",
        hostname,
      );
      await clearSessionPermissionOverride(approval.group);
      await saveSettings({
        permissions: {
          ...(await getSettings()).permissions,
          [approval.group]: "allow",
        },
      });
    }
    return;
  }

  // Fallback for non-page tools (existing behavior)
  if (scope === "session") {
    await saveSessionPermissionOverride(approval.group, "allow");
    return;
  }

  if (scope === "forever") {
    await clearSessionPermissionOverride(approval.group);
    const settings = await getSettings();
    await saveSettings({
      permissions: {
        ...settings.permissions,
        [approval.group]: "allow",
      },
    });
  }
}

async function handleRejection(approval: PendingApproval): Promise<void> {
  send({ type: "approval_response", payload: { requestId: approval.requestId, approved: false } });
  await dismissPendingApproval(approval.requestId, { keepNotification: false });
}
