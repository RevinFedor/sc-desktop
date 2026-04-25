import type { Permission, PermissionProfile, ToolGroup } from "../types.js";
import { loadConfig } from "../config.js";

/**
 * Gates middleware — checks whether a browser's permission profile
 * allows a given tool operation.
 *
 * Modes:
 *   allow → proceed
 *   deny  → blocked
 *   ask   → needs user approval (WIP — currently returns blocked with ask flag)
 */
export interface GateResult {
  allowed: boolean;
  mode: Permission;
  reason?: string;
}

const TOOL_TO_GROUP: Record<string, ToolGroup> = {
  // ── Browser APIs ──
  "tabs.list": "tabs",
  "tabs.create": "tabs",
  "tabs.close": "tabs",
  "tabs.update": "tabs",
  "tabs.navigate": "tabs",
  "tabs.goBack": "tabs",
  "tabs.goForward": "tabs",
  "screenshots.capture": "screenshots",
  "history.search": "history.read",
  "history.delete": "history.delete",
  "bookmarks.list": "bookmarks.read",
  "bookmarks.create": "bookmarks.modify",
  "bookmarks.delete": "bookmarks.delete",
  "downloads.list": "downloads",
  "downloads.open": "downloads",
  "network.requests": "network",
  "storage.get": "storage",
  "storage.set": "storage",

  // ── Windows ──
  "windows.list": "windows",
  "windows.create": "windows",
  "windows.focus": "windows",
  "windows.close": "windows",

  // ── Cookies ──
  "cookies.get": "cookies",
  "cookies.set": "cookies",
  "cookies.remove": "cookies",
  "cookies.list": "cookies",

  // ── V2 Page tools ──
  "page.read": "page.read",
  "page.act": "page.act",
  "page.js": "page.execute",
};

export function checkGate(
  browserPermissions: PermissionProfile,
  tool: string,
): GateResult {
  const config = loadConfig();
  const group = TOOL_TO_GROUP[tool];

  if (!group) {
    // Unknown tool — allow by default (browser extension declared it as a capability)
    return { allowed: true, mode: "allow" };
  }

  const permission = browserPermissions[group] ?? config.gates.defaultPermission;

  switch (permission) {
    case "allow":
      return { allowed: true, mode: "allow" };
    case "deny":
      return {
        allowed: false,
        mode: "deny",
        reason: `Tool group "${group}" is denied for this browser`,
      };
    case "ask":
      return {
        allowed: false,
        mode: "ask",
        reason: `Tool group "${group}" requires user approval`,
      };
    default:
      return {
        allowed: false,
        mode: "deny",
        reason: `Unknown permission: ${permission}`,
      };
  }
}
