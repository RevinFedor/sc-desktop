/**
 * FILE: extension/src/ui/settings-surface.ts
 * PURPOSE: Bootstrap the shared popup and options settings surface.
 * OWNS: Wiring the browser identity, core URL, capability permissions, reconnect/reset, and approvals UI.
 * EXPORTS: bootstrapSettingsSurface() — initializes the shared settings/approvals experience in the current document.
 * DOCS: agent_chat/plan_ui_approval_flow_2026-05-10.md
 */

import type { SitePermissionLists, PagePermissionGroup } from "../types";
import {
  clearAllSessionPermissionOverrides,
  clearSessionPermissionOverride,
  getEffectivePermissions,
  getPageSitePermissions,
  getSettings,
  resetSettings,
  savePageSitePermissions,
  saveSettings,
  removeSitePattern,
} from "../storage";

type SurfaceMode = "popup" | "options";
type ConnectionState = "disconnected" | "connecting" | "connected" | "waiting";

interface ConnectionStatus {
  state: ConnectionState;
  connected: boolean;
  reconnectAttempts: number;
  authRequired?: boolean;
}

interface ApprovalItem {
  requestId: string;
  tool: string;
  params: Record<string, unknown>;
  description: string;
  group: string;
  title?: string;
  url?: string;
}

const CAP_GROUPS = [
  { id: "tabs", label: "Tab Management", desc: "List, create, close tabs" },
  { id: "screenshots", label: "Screenshots", desc: "Capture visible tab as image" },
  { id: "history.read", label: "History — Read", desc: "Search browsing history" },
  { id: "history.delete", label: "History — Delete", desc: "Wipe history entries" },
  { id: "bookmarks.read", label: "Bookmarks — Read", desc: "List bookmarks" },
  { id: "bookmarks.modify", label: "Bookmarks — Modify", desc: "Create bookmarks" },
  { id: "bookmarks.delete", label: "Bookmarks — Delete", desc: "Remove bookmarks" },
  { id: "downloads", label: "Downloads", desc: "List and open downloads" },
  { id: "network", label: "Network Requests", desc: "Access network activity" },
  { id: "storage", label: "Local Storage", desc: "Read/write localStorage" },
  { id: "windows", label: "Windows", desc: "List, create, focus, close browser windows" },
  { id: "cookies", label: "Cookies", desc: "Read, write, and delete HTTP cookies" },
] as const;

const PAGE_CAP_GROUPS: Array<{ id: PagePermissionGroup; label: string; desc: string }> = [
  { id: "page.read", label: "Page Read", desc: "Read content, metadata, find elements" },
  { id: "page.act", label: "Page Actions", desc: "Click, type, scroll, fill forms" },
  { id: "page.execute", label: "Execute JS", desc: "Run arbitrary JavaScript on page" },
];

const PERMISSION_OPTIONS = ["allow", "ask", "deny"] as const;

export function bootstrapSettingsSurface(mode: SurfaceMode = "popup"): void {
  void init(mode).catch((error) => {
    console.error("[bp-ext] Failed to bootstrap settings surface:", error);
  });
}

async function init(mode: SurfaceMode): Promise<void> {
  document.body.classList.toggle("options-page", mode === "options");

  const statusEl = byId("connection-status");
  const nameInput = byId<HTMLInputElement>("browser-name");
  const coreUrlInput = byId<HTMLInputElement>("core-url");
  const approvalNotificationsInput = byId<HTMLInputElement>("approval-notifications");
  const capsList = byId("capabilities-list");
  const saveNameBtn = byId<HTMLButtonElement>("save-name");
  const reconnectBtn = byId<HTMLButtonElement>("reconnect");
  const resetBtn = byId<HTMLButtonElement>("reset");
  const approvalsListEl = byId("approvals-list");
  const tabSettings = byId<HTMLButtonElement>("tab-settings");
  const tabApprovals = byId<HTMLButtonElement>("tab-approvals");
  const panelSettings = byId("panel-settings");
  const panelApprovals = byId("panel-approvals");
  const approvalBadge = byId("approval-badge");

  const settings = await getSettings();
  const effectivePermissions = await getEffectivePermissions();

  nameInput.value = settings.browserName;
  coreUrlInput.value = settings.coreUrl;
  const authKeyInput = byId<HTMLInputElement>("auth-key");
  authKeyInput.value = settings.authKey ?? "";
  authKeyInput.addEventListener("change", () => { void saveAuthKey(authKeyInput); });
  approvalNotificationsInput.checked = settings.approvalNotificationsEnabled;

  renderCapabilities(capsList, effectivePermissions);
  const pageCapsContainer = byId("page-capabilities-list");
  renderPageCapabilities(pageCapsContainer);
  void loadPageCapabilities(pageCapsContainer);
  void updateStatus(statusEl);

  coreUrlInput.addEventListener("change", () => { void saveCoreUrl(coreUrlInput); });
  approvalNotificationsInput.addEventListener("change", () => { void saveApprovalNotifications(approvalNotificationsInput); });
  saveNameBtn.addEventListener("click", () => { void saveName(nameInput); });
  reconnectBtn.addEventListener("click", () => { void reconnect(statusEl); });
  resetBtn.addEventListener("click", () => {
    void reset({
      statusEl,
      nameInput,
      coreUrlInput,
      approvalNotificationsInput,
      capsList,
      approvalBadge,
      approvalsListEl,
    });
  });

  tabSettings.addEventListener("click", () => switchTab("settings", tabSettings, tabApprovals, panelSettings, panelApprovals, approvalsListEl, approvalBadge, capsList));
  tabApprovals.addEventListener("click", () => switchTab("approvals", tabSettings, tabApprovals, panelSettings, panelApprovals, approvalsListEl, approvalBadge, capsList));

  setInterval(() => { void updateStatus(statusEl); }, 2000);

  const pending = await renderApprovals(approvalsListEl, approvalBadge, capsList);
  if (pending.length > 0) {
    switchTab("approvals", tabSettings, tabApprovals, panelSettings, panelApprovals, approvalsListEl, approvalBadge, capsList);
  }

  setInterval(() => { void renderApprovals(approvalsListEl, approvalBadge, capsList); }, 2000);
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required element: #${id}`);
  }
  return el as T;
}

function renderCapabilities(container: HTMLElement, permissions: Record<string, string>): void {
  container.innerHTML = "";

  for (const group of CAP_GROUPS) {
    const current = permissions[group.id] ?? "ask";

    const row = document.createElement("div");
    row.className = "cap-row";

    const info = document.createElement("div");
    info.className = "cap-info";
    info.innerHTML = `<strong>${group.label}</strong><small>${group.desc}</small>`;

    const select = document.createElement("select");
    select.dataset.group = group.id;
    for (const opt of PERMISSION_OPTIONS) {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = opt.toUpperCase();
      if (opt === current) option.selected = true;
      select.appendChild(option);
    }

    select.addEventListener("change", () => {
      const val = select.value;
      void (async () => {
        const currentSettings = await getSettings();
        await clearSessionPermissionOverride(group.id);
        await saveSettings({ permissions: { ...currentSettings.permissions, [group.id]: val } });
      })();
      select.className = `perm-${val}`;
    });

    select.className = `perm-${current}`;
    row.appendChild(info);
    row.appendChild(select);
    container.appendChild(row);
  }
}

function renderPageCapabilities(container: HTMLElement): void {
  container.innerHTML = "";

  for (const group of PAGE_CAP_GROUPS) {
    const section = document.createElement("div");
    section.className = "page-cap-section";
    section.dataset.group = group.id;

    const heading = document.createElement("h3");
    heading.textContent = group.label;
    section.appendChild(heading);

    const desc = document.createElement("p");
    desc.className = "hint";
    desc.textContent = group.desc;
    section.appendChild(desc);

    for (const listName of ["allow", "ask", "deny"] as const) {
      const label = document.createElement("label");
      label.textContent = listName.charAt(0).toUpperCase() + listName.slice(1);
      label.className = `site-list-label site-list-${listName}`;

      const textarea = document.createElement("textarea");
      textarea.className = "site-pattern-ta";
      textarea.dataset.group = group.id;
      textarea.dataset.list = listName;
      textarea.rows = 2;
      textarea.placeholder = listName === "allow" ? "*" : "";

      // Debounced save
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      textarea.addEventListener("input", () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          void savePagePatternsFromTextarea(textarea);
        }, 600);
      });

      section.appendChild(label);
      section.appendChild(textarea);
    }

    container.appendChild(section);
  }
}

async function savePagePatternsFromTextarea(textarea: HTMLTextAreaElement): Promise<void> {
  const group = textarea.dataset.group as PagePermissionGroup;
  const list = textarea.dataset.list as "allow" | "ask" | "deny";
  const patterns = textarea.value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const current = await getPageSitePermissions();
  const groupPerms = current[group] ?? { allow: [], ask: [], deny: [] };
  // Rebuild ALL THREE lists from all textareas in this section
  const section = textarea.closest(".page-cap-section");
  if (section) {
    const tas = section.querySelectorAll<HTMLTextAreaElement>("textarea.site-pattern-ta");
    for (const ta of tas) {
      const g = ta.dataset.group as PagePermissionGroup;
      const l = ta.dataset.list as "allow" | "ask" | "deny";
      const patterns = ta.value
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (!current[g]) current[g] = { allow: [], ask: [], deny: [] };
      current[g][l] = patterns;
    }
  }

  await savePageSitePermissions(current);
}

async function loadPageCapabilities(container: HTMLElement): Promise<void> {
  const pageSites = await getPageSitePermissions();
  const tas = container.querySelectorAll<HTMLTextAreaElement>("textarea.site-pattern-ta");
  for (const ta of tas) {
    const group = ta.dataset.group as PagePermissionGroup;
    const list = ta.dataset.list as "allow" | "ask" | "deny";
    const groupPerms = pageSites[group];
    if (groupPerms) {
      ta.value = (groupPerms[list] ?? []).join("\n");
    }
  }
}

async function updateStatus(statusEl: HTMLElement): Promise<void> {
  try {
    const status = await chrome.runtime.sendMessage({ type: "getConnectionStatus" }) as ConnectionStatus | undefined;

    if (status?.authRequired) {
      statusEl.textContent = "API key required";
      statusEl.className = "status disconnected";
      return;
    }

    switch (status?.state) {
      case "connected":
        statusEl.textContent = "Connected";
        statusEl.className = "status connected";
        return;
      case "connecting":
        statusEl.textContent = "Connecting...";
        statusEl.className = "status connecting";
        return;
      case "waiting":
        statusEl.textContent = "Waiting to reconnect...";
        statusEl.className = "status connecting";
        return;
      default:
        statusEl.textContent = "Disconnected";
        statusEl.className = "status disconnected";
    }
  } catch {
    statusEl.textContent = "Disconnected";
    statusEl.className = "status disconnected";
  }
}

async function saveName(nameInput: HTMLInputElement): Promise<void> {
  await saveSettings({ browserName: nameInput.value });
  nameInput.style.borderColor = "#22c55e";
  setTimeout(() => { nameInput.style.borderColor = ""; }, 1500);
}

async function saveCoreUrl(coreUrlInput: HTMLInputElement): Promise<void> {
  await saveSettings({ coreUrl: coreUrlInput.value });
}

async function saveAuthKey(authKeyInput: HTMLInputElement): Promise<void> {
  await saveSettings({ authKey: authKeyInput.value });
}

async function saveApprovalNotifications(approvalNotificationsInput: HTMLInputElement): Promise<void> {
  await saveSettings({ approvalNotificationsEnabled: approvalNotificationsInput.checked });
}

async function reconnect(statusEl: HTMLElement): Promise<void> {
  statusEl.textContent = "Connecting...";
  statusEl.className = "status connecting";
  await chrome.runtime.sendMessage({ type: "reconnectToCore" });
  void updateStatus(statusEl);
}

async function reset(args: {
  statusEl: HTMLElement;
  nameInput: HTMLInputElement;
  coreUrlInput: HTMLInputElement;
  approvalNotificationsInput: HTMLInputElement;
  capsList: HTMLElement;
  approvalBadge: HTMLElement;
  approvalsListEl: HTMLElement;
}): Promise<void> {
  if (!confirm("Reset all settings to defaults?")) return;

  await clearAllSessionPermissionOverrides();
  await resetSettings();

  const settings = await getSettings();
  args.nameInput.value = settings.browserName;
  args.coreUrlInput.value = settings.coreUrl;
  args.approvalNotificationsInput.checked = settings.approvalNotificationsEnabled;
  const authKeyInput = byId<HTMLInputElement>("auth-key");
  authKeyInput.value = settings.authKey ?? "";
  renderCapabilities(args.capsList, await getEffectivePermissions());
  const pageCapsContainer = byId("page-capabilities-list");
  renderPageCapabilities(pageCapsContainer);
  void loadPageCapabilities(pageCapsContainer);
  await renderApprovals(args.approvalsListEl, args.approvalBadge, args.capsList);
  void updateStatus(args.statusEl);
}

function switchTab(
  tab: "settings" | "approvals",
  tabSettings: HTMLButtonElement,
  tabApprovals: HTMLButtonElement,
  panelSettings: HTMLElement,
  panelApprovals: HTMLElement,
  approvalsListEl: HTMLElement,
  approvalBadge: HTMLElement,
  capsList: HTMLElement,
): void {
  tabSettings.classList.toggle("active", tab === "settings");
  tabApprovals.classList.toggle("active", tab === "approvals");
  panelSettings.classList.toggle("active", tab === "settings");
  panelApprovals.classList.toggle("active", tab === "approvals");

  if (tab === "approvals") {
    void renderApprovals(approvalsListEl, approvalBadge, capsList);
  }
}

async function renderApprovals(
  approvalsListEl: HTMLElement,
  approvalBadge: HTMLElement,
  capsList: HTMLElement,
): Promise<ApprovalItem[]> {
  const pending = await chrome.runtime.sendMessage({ type: "getPendingApprovals" }) as ApprovalItem[] | undefined;

  if (!pending || pending.length === 0) {
    approvalsListEl.innerHTML = '<p class="empty-state">No pending approvals.</p>';
    approvalBadge.classList.add("hidden");
    approvalBadge.textContent = "0";
    return [];
  }

  approvalBadge.classList.remove("hidden");
  approvalBadge.textContent = String(pending.length);

  approvalsListEl.innerHTML = pending.map((item) => `
    <div class="approval-item" data-request-id="${item.requestId}">
      <div class="approval-site">${escapeHtml(item.title || item.url || item.group)}</div>
      <div class="tool-name">${escapeHtml(item.tool)}</div>
      <div class="tool-desc">${escapeHtml(item.description)}</div>
      <div class="tool-params">${escapeHtml(JSON.stringify(item.params, null, 2))}</div>
      <div class="approval-actions">
        <button class="btn-approve-once" data-action="approve-once" data-request-id="${item.requestId}">Approve Once</button>
        <button class="btn-approve-session" data-action="approve-session" data-request-id="${item.requestId}">Approve Session</button>
        <button class="btn-approve-forever" data-action="approve-forever" data-request-id="${item.requestId}">Approve Forever</button>
        <button class="btn-deny" data-action="deny" data-request-id="${item.requestId}">Reject</button>
      </div>
    </div>
  `).join("");

  approvalsListEl.querySelectorAll("[data-action='approve-once']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const requestId = (btn as HTMLElement).dataset.requestId!;
      await chrome.runtime.sendMessage({ type: "approveRequest", requestId, scope: "once" });
      void renderApprovals(approvalsListEl, approvalBadge, capsList);
    });
  });

  approvalsListEl.querySelectorAll("[data-action='approve-session']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const requestId = (btn as HTMLElement).dataset.requestId!;
      await chrome.runtime.sendMessage({ type: "approveRequest", requestId, scope: "session" });
      void renderApprovals(approvalsListEl, approvalBadge, capsList);
    });
  });

  approvalsListEl.querySelectorAll("[data-action='approve-forever']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const requestId = (btn as HTMLElement).dataset.requestId!;
      await chrome.runtime.sendMessage({ type: "approveRequest", requestId, scope: "forever" });
      void renderApprovals(approvalsListEl, approvalBadge, capsList);
      renderCapabilities(capsList, await getEffectivePermissions());
    });
  });

  approvalsListEl.querySelectorAll(".btn-deny").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const requestId = (btn as HTMLElement).dataset.requestId!;
      await chrome.runtime.sendMessage({ type: "denyRequest", requestId });
      void renderApprovals(approvalsListEl, approvalBadge, capsList);
    });
  });

  return pending;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
