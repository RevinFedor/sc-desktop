/**
 * chrome.storage wrapper for extension settings.
 * Safely guards against non-extension environments (Node/WXT prepare).
 */

import type { ExtensionSettings, PagePermissionGroup, SitePermissionLists } from "./types";
import { isExtensionContext } from "./safety";

const SESSION_PERMISSION_OVERRIDES_KEY = "sessionPermissionOverrides";

const ADJECTIVES = [
  "brisk",
  "gentle",
  "lucky",
  "quiet",
  "nimble",
  "bright",
  "swift",
  "calm",
];

const ANIMALS = [
  "otter",
  "panda",
  "falcon",
  "lynx",
  "fox",
  "raven",
  "gecko",
  "walrus",
];

function randomItem(values: string[]): string {
  const index = Math.floor(Math.random() * values.length);
  return values[index] ?? values[0]!;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(2);
  globalThis.crypto?.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const PAGE_SITE_PERMISSIONS_KEY = "pageSitePermissions";

function createDefaultPageSitePermissions(): Record<PagePermissionGroup, SitePermissionLists> {
  return {
    "page.read": { allow: ["*"], ask: [], deny: [] },
    "page.act": { allow: [], ask: ["*"], deny: [] },
    "page.execute": { allow: [], ask: [], deny: ["*"] },
  };
}

function createDefaultSettings(): ExtensionSettings {
  return {
    browserName: `${randomItem(ADJECTIVES)}-${randomItem(ANIMALS)}-${randomSuffix()}`,
    coreUrl: "ws://127.0.0.1:4199/ws",
    authKey: "",
    approvalNotificationsEnabled: true,
    permissions: {
      tabs: "allow",
      "page.read": "allow",
      "page.act": "ask",
      "page.execute": "ask",
      screenshots: "allow",
      "history.read": "allow",
      "history.delete": "ask",
      "bookmarks.read": "allow",
      "bookmarks.modify": "ask",
      "bookmarks.delete": "ask",
      downloads: "deny",
      network: "deny",
      storage: "deny",
      windows: "allow",
      cookies: "ask",
    },
    pageSitePermissions: createDefaultPageSitePermissions(),
  };
}

async function readStoredSettings(): Promise<ExtensionSettings | undefined> {
  if (!isExtensionContext()) return undefined;
  const result = await chrome.storage.local.get("settings");
  return result.settings as ExtensionSettings | undefined;
}

async function readSessionPermissionOverrides(): Promise<Record<string, string>> {
  if (!isExtensionContext()) return {};
  const result = await chrome.storage.session.get(SESSION_PERMISSION_OVERRIDES_KEY);
  return (result[SESSION_PERMISSION_OVERRIDES_KEY] as Record<string, string> | undefined) ?? {};
}

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await readStoredSettings();
  if (stored) return stored;

  const defaults = createDefaultSettings();
  if (isExtensionContext()) {
    await chrome.storage.local.set({ settings: defaults });
  }
  return defaults;
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  if (!isExtensionContext()) return;
  const current = (await readStoredSettings()) ?? createDefaultSettings();
  const merged: ExtensionSettings = {
    ...current,
    ...settings,
    permissions: {
      ...current.permissions,
      ...(settings.permissions ?? {}),
    },
  };
  await chrome.storage.local.set({ settings: merged });
}

export async function resetSettings(): Promise<void> {
  if (!isExtensionContext()) return;
  const defaults = createDefaultSettings();
  defaults.pageSitePermissions = createDefaultPageSitePermissions();
  await chrome.storage.local.set({ settings: defaults });
}

export async function getEffectivePermissions(): Promise<Record<string, string>> {
  const settings = await getSettings();
  const overrides = await readSessionPermissionOverrides();
  return { ...settings.permissions, ...overrides };
}

export async function saveSessionPermissionOverride(
  group: string,
  permission: string,
): Promise<void> {
  if (!isExtensionContext()) return;
  const current = await readSessionPermissionOverrides();
  current[group] = permission;
  await chrome.storage.session.set({ [SESSION_PERMISSION_OVERRIDES_KEY]: current });
}

export async function clearSessionPermissionOverride(group: string): Promise<void> {
  if (!isExtensionContext()) return;
  const current = await readSessionPermissionOverrides();
  delete current[group];
  await chrome.storage.session.set({ [SESSION_PERMISSION_OVERRIDES_KEY]: current });
}

export async function clearAllSessionPermissionOverrides(): Promise<void> {
  if (!isExtensionContext()) return;
  await chrome.storage.session.set({ [SESSION_PERMISSION_OVERRIDES_KEY]: {} });
}

export async function getPageSitePermissions(): Promise<Record<PagePermissionGroup, SitePermissionLists>> {
  const settings = await getSettings();
  return settings.pageSitePermissions ?? createDefaultPageSitePermissions();
}

export async function savePageSitePermissions(
  pageSitePermissions: Record<PagePermissionGroup, SitePermissionLists>,
): Promise<void> {
  await saveSettings({ pageSitePermissions });
}

export async function addSitePattern(
  group: PagePermissionGroup,
  list: "allow" | "ask" | "deny",
  pattern: string,
): Promise<void> {
  const current = await getPageSitePermissions();
  const groupPerms = current[group] ?? { allow: [], ask: [], deny: [] };
  if (!groupPerms[list].includes(pattern)) {
    groupPerms[list] = [...groupPerms[list], pattern];
  }
  current[group] = groupPerms;
  await savePageSitePermissions(current);
}

export async function removeSitePattern(
  group: PagePermissionGroup,
  list: "allow" | "ask" | "deny",
  pattern: string,
): Promise<void> {
  const current = await getPageSitePermissions();
  const groupPerms = current[group];
  if (groupPerms) {
    groupPerms[list] = groupPerms[list].filter((p) => p !== pattern);
    current[group] = groupPerms;
    await savePageSitePermissions(current);
  }
}
