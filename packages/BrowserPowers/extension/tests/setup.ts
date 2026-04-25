import { vi } from "vitest";

/**
 * Minimal chrome.* API mock for extension unit tests.
 * Covers all APIs used by the extension source code.
 * Add more mocks as needed for additional test coverage.
 */
const mockChrome = {
  runtime: {
    id: "test-extension-id",
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
  tabs: {
    query: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 1 }),
    update: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    captureVisibleTab: vi.fn().mockResolvedValue("data:image/png;base64,fake"),
    get: vi.fn().mockResolvedValue({ id: 1, url: "about:blank" }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
  scripting: {
    executeScript: vi.fn().mockResolvedValue([{ result: null }]),
    insertCSS: vi.fn().mockResolvedValue(undefined),
  },
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
    openPopup: vi.fn().mockResolvedValue(undefined),
    setIcon: vi.fn().mockResolvedValue(undefined),
  },
  notifications: {
    create: vi.fn().mockResolvedValue("notification-id"),
    clear: vi.fn().mockResolvedValue(true),
    onClicked: { addListener: vi.fn() },
    onClosed: { addListener: vi.fn() },
  },
  alarms: {
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
  windows: {
    getAll: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 1 }),
    update: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    getCurrent: vi.fn().mockResolvedValue({ id: 1 }),
  },
  cookies: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({}),
    getAll: vi.fn().mockResolvedValue([]),
  },
  history: {
    search: vi.fn().mockResolvedValue([]),
    deleteUrl: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
  },
  bookmarks: {
    search: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    removeTree: vi.fn().mockResolvedValue(undefined),
  },
  downloads: {
    search: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue(undefined),
  },
  i18n: {
    getMessage: vi.fn().mockReturnValue(""),
  },
};

// Make chrome.* available globally (bypasses isExtensionContext guard)
vi.stubGlobal("chrome", mockChrome);

// Clear process.versions.node to bypass isExtensionContext() guard
// This makes storage.ts and safety.ts think we're in a real extension context
const originalVersions = process.versions;
vi.stubGlobal("process", {
  ...process,
  versions: {
    ...originalVersions,
    node: undefined, // This is set to undefined to match extension behavior
  },
});

export { mockChrome };
