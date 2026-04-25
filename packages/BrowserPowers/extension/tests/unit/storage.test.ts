import { describe, it, expect, beforeEach, vi } from "vitest";

describe("storage", () => {
  beforeEach(async () => {
    vi.resetModules();

    // Mock chrome.storage with controlled returns
    const mockStorageData: Record<string, any> = {};

    vi.stubGlobal("chrome", {
      runtime: { id: "test-id", onMessage: { addListener: vi.fn() }, sendMessage: vi.fn() },
      storage: {
        local: {
          get: vi.fn().mockImplementation(async (keys) => {
            if (keys === "settings") {
              return mockStorageData.settings
                ? { settings: mockStorageData.settings }
                : {};
            }
            return {};
          }),
          set: vi.fn().mockImplementation(async (data) => {
            Object.assign(mockStorageData, data);
          }),
        },
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), openPopup: vi.fn(), setIcon: vi.fn() },
      notifications: { create: vi.fn(), clear: vi.fn(), onClicked: { addListener: vi.fn() }, onClosed: { addListener: vi.fn() } },
      tabs: { query: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
      scripting: { executeScript: vi.fn() },
      windows: { getAll: vi.fn() },
      cookies: { getAll: vi.fn() },
    } as any);

    // Bypass isExtensionContext
    vi.stubGlobal("process", {
      ...process,
      versions: { ...process.versions, node: undefined },
    });
  });

  it("getSettings returns defaults when no stored settings", async () => {
    const { getSettings } = await import("../../src/storage.js");
    const settings = await getSettings();
    expect(settings.browserName).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    expect(settings.coreUrl).toBe("ws://127.0.0.1:4199/ws");
    expect(settings.approvalNotificationsEnabled).toBe(true);
    expect(settings.permissions.tabs).toBe("allow");
    expect(settings.permissions.cookies).toBe("ask");
    expect(settings.pageSitePermissions).toBeDefined();
    expect(settings.pageSitePermissions["page.read"]).toEqual({ allow: ["*"], ask: [], deny: [] });
    expect(settings.pageSitePermissions["page.act"]).toEqual({ allow: [], ask: ["*"], deny: [] });
    expect(settings.pageSitePermissions["page.execute"]).toEqual({ allow: [], ask: [], deny: ["*"] });
  });

  it("saveSettings merges with existing settings", async () => {
    const { getSettings, saveSettings } = await import("../../src/storage.js");
    await saveSettings({ browserName: "Custom Name" });
    const settings = await getSettings();
    expect(settings.browserName).toBe("Custom Name");
    // Other defaults should still be intact
    expect(settings.coreUrl).toBe("ws://127.0.0.1:4199/ws");
  });

  it("resetSettings restores defaults", async () => {
    const { getSettings, saveSettings, resetSettings } = await import("../../src/storage.js");
    await saveSettings({ browserName: "Custom Name" });
    await resetSettings();
    const settings = await getSettings();
    expect(settings.browserName).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    expect(settings.approvalNotificationsEnabled).toBe(true);
  });

  it("settings contain all expected permission groups", async () => {
    const { getSettings } = await import("../../src/storage.js");
    const settings = await getSettings();
    const expectedPermissions = [
      "tabs", "page.read", "page.act", "page.execute",
      "screenshots", "history.read", "history.delete",
      "bookmarks.read", "bookmarks.modify", "bookmarks.delete",
      "downloads", "network", "storage", "windows", "cookies",
    ];
    for (const perm of expectedPermissions) {
      expect(settings.permissions).toHaveProperty(perm);
    }
  });

  it("default permissions match expected security posture", async () => {
    const { getSettings } = await import("../../src/storage.js");
    const settings = await getSettings();
    const perms = settings.permissions;

    // These should be "allow" by default
    expect(perms.tabs).toBe("allow");
    expect(perms["page.read"]).toBe("allow");
    expect(perms.screenshots).toBe("allow");
    expect(perms["history.read"]).toBe("allow");
    expect(perms["bookmarks.read"]).toBe("allow");
    expect(perms.windows).toBe("allow");

    // These should be "deny" by default (sensitive / risk of data loss)
    expect(perms.downloads).toBe("deny");
    expect(perms.network).toBe("deny");
    expect(perms.storage).toBe("deny");

    // These should be "ask" by default (user should decide)
    expect(perms["page.act"]).toBe("ask");
    expect(perms["page.execute"]).toBe("ask");
    expect(perms["history.delete"]).toBe("ask");
    expect(perms["bookmarks.modify"]).toBe("ask");
    expect(perms["bookmarks.delete"]).toBe("ask");
    expect(perms.cookies).toBe("ask");
  });

  it("merges session permission overrides into effective permissions", async () => {
    const { getEffectivePermissions } = await import("../../src/storage.js");
    (chrome.storage.session.get as any).mockResolvedValueOnce({ sessionPermissionOverrides: { "page.act": "allow" } });
    const perms = await getEffectivePermissions();
    expect(perms["page.act"]).toBe("allow");
  });

  it("addSitePattern adds a pattern and deduplicates", async () => {
    const { addSitePattern, getPageSitePermissions } = await import("../../src/storage.js");
    await addSitePattern("page.read", "allow", "github.com");
    const perms = await getPageSitePermissions();
    expect(perms["page.read"].allow).toContain("github.com");
    // Adding same pattern again should not duplicate
    await addSitePattern("page.read", "allow", "github.com");
    const perms2 = await getPageSitePermissions();
    expect(perms2["page.read"].allow.filter((p: string) => p === "github.com")).toHaveLength(1);
  });
});
