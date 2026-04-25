---
node_type: architecture
title: BrowserPowers — Browser Extension Architecture
status: active
updated: 2026-06-11
tags: [extension, architecture, wxt, mv3, chrome-extension]
links:
  depends_on: [../overview/product.md, ../spec/spec.md]
  documents: [../../extension/]
  implemented_by: [../../extension/src/]
---

# BrowserPowers — Browser Extension Architecture

## Overview

The browser extension (`extension/`) is a thin bridge that connects a real browser to the BrowserPowers core. It runs as a Manifest V3 service worker, maintains a persistent WebSocket connection to the core, and maps incoming tool commands to `chrome.*` API calls.

**Package name**: `browserpowers-extension`  
**Framework**: [WXT](https://wxt.dev/) (cross-browser extension tooling)  
**Targets**: Chrome MV3 (primary), Firefox (via WXT)  
**Runtime**: Browser extension service worker (not Node.js)  

---

## Scope Boundary

| Direction | Boundary |
|---|---|
| **Owns** | WebSocket connection to core, chrome.* API tool execution, local settings storage, permission profile filtering, shared popup/options UI |
| **Does not own** | Shared config/skills/prompts (lives on core), LLM API calls (routed through core), multi-browser coordination (orchestrated by core) |
| **Boundary interfaces** | Receives `execute` messages from core via WebSocket; sends `result`/`error` responses; user configures via popup/options HTML |
| **External dependencies** | WXT, Chrome Extension APIs (`tabs`, `scripting`, `storage`, `history`, `bookmarks`, `downloads`, `webNavigation`, `contextMenus`, `alarms`) |

---

## Components

### 1. Entry Point (`entrypoints/background.ts`)

The Manifest V3 service worker. Runs when the browser is active.

**Responsibilities**:
- Initialize on extension load: call `connect()` to establish WebSocket
- Listen for incoming WebSocket messages and route them:
  - `registered` — store browser ID in `chrome.storage.local`
  - `execute` — forward to capability router, send result back
  - `heartbeat_ack` — no-op (confirms core received heartbeat)
  - `config_updated` — log, future: apply config changes
  - `request_approval` — store pending approval in `Map<requestId, PendingApproval>`, set badge dot on extension icon via `chrome.action.setBadgeText()`, optionally show a native notification, and start a local UI timeout
- React to `chrome.storage.onChanged` — if persistent settings or session permission overrides change, reconnect with new config
- Keep the service worker alive via `chrome.alarms` (MV3 workaround: 30s heartbeat alarm)
- Expose `chrome.runtime.onMessage` handler for popup/options communication:
  - `getPendingApprovals` — return list of pending approvals to the popup/options surface
  - `approveRequest` / `denyRequest` — send `approval_response` to core, then apply optional session/forever permission updates on the browser side

**Guard**: Calls `isExtensionContext()` before any initialization — returns early if running in Node.js (WXT prepare/build step).

### 2. WebSocket Client (`src/ws-client.ts`)

Manages the entire WebSocket lifecycle independently of the service worker.

**Lifecycle**:

```
connect() → ws.onopen → send register
                         → start heartbeat timer
                         → onMessage handler installed
     → ws.onclose → stop heartbeat
                   → scheduleReconnect (exponential backoff)
     → ws.onerror → scheduleReconnect
```

**Exports**:

| Function | Description |
|---|---|
| `connect()` | Open WebSocket to configured core URL |
| `reconnect()` | Force a fresh connection attempt (used after settings changes / manual reconnect) |
| `disconnect()` | Close WebSocket, clear timers |
| `send(msg)` | Send JSON message to core (no-op if not connected) |
| `isConnected()` | Check if WebSocket is OPEN |
| `getConnectionStatus()` | Return live connection state for the popup/options surface |
| `onMessage(handler)` | Register message handler (called by background.ts) |

**Reconnection backoff**:

| Attempt | Delay |
|---|---|
| 1 | ~1000ms |
| 2 | ~2000ms |
| 3 | ~4000ms |
| 4 | ~8000ms |
| 5 | ~16000ms |
| 6+ | capped at 30000ms |

**Heartbeat**: Sends `{ type: "heartbeat" }` every 25 seconds.

**Registration on connect**: On successful WebSocket open, reads persistent settings plus session permission overrides, builds capability list (filtered by effective permissions), and sends `register` message.

### 3. Capability Router (`src/capability-router.ts`)

The **only module** in the codebase that calls `chrome.*` APIs. Maps tool names to concrete browser API calls. v2 page tools (`page.read`, `page.act`, `page.js`) are dispatched to dedicated v2 modules under `src/v2/`.

**Supported tools**:

| Tool | chrome.* API / Handler | Notes |
|---|---|---|
| `tabs.list` | `chrome.tabs.query()` | Passes params as query info |
| `tabs.create` | `chrome.tabs.create()` | |
| `tabs.close` | `chrome.tabs.remove()` | Closes active tab if no tabId given |
| `tabs.update` | `chrome.tabs.update()` | Navigate, focus, etc. |
| `tabs.navigate` | `chrome.tabs.update()` / `chrome.tabs.create()` | In sync mode, auto-runs compact inspect and includes snapshot in result |
| `page.read` | `src/v2/page-read.ts` → dispatchReadAction | Unified read tool with action dispatch |
| `page.act` | `src/v2/page-act.ts` → dispatchActAction | In sync mode, captures before/after inspect snapshots and computes semantic diff |
| `page.js` | `src/v2/page-js.ts` → dispatchJsAction | JavaScript execution wrapper — gated escape hatch |
| `screenshots.capture` | `chrome.tabs.captureVisibleTab()` | Returns base64 PNG |
| `history.search` | `chrome.history.search()` | |
| `history.delete` | `chrome.history.deleteUrl()` / `deleteAll()` | |
| `bookmarks.list` | `chrome.bookmarks.search()` | |
| `bookmarks.create` | `chrome.bookmarks.create()` | |
| `bookmarks.delete` | `chrome.bookmarks.remove()` / `removeTree()` | |
| `downloads.list` | `chrome.downloads.search()` | |
| `downloads.open` | `chrome.downloads.open()` | |
| `network.requests` | (placeholder) | Returns empty list; requires webRequest collector |
| `storage.get` | `chrome.scripting.executeScript()` | Reads page localStorage |
| `storage.set` | `chrome.scripting.executeScript()` | Writes page localStorage |

**Routing**:

```
routeExecute(request) → execute(tool, params)
  → if tool is "page.read" → dispatchReadAction(action, params, tabId)
  → if tool is "page.act" → dispatchActAction(action, params, tabId)
  → if tool is "page.js" → dispatchJsAction(code, tabId)
  → else → switch(tool) → chrome.* API call
  → return { requestId, success, data } or { requestId, success: false, error }
```

**Execution mode enrichment** (when `commandMode === "sync"`):
- `tabs.navigate`: always runs a compact inspect after page load and includes the snapshot (`{ url, title, anchors }`) in the result
- `page.act` mutation actions: captures inspect before → executes action → captures inspect after → computes semantic diff via `diffSnapshots()` → attaches diff to result data
- Non-mutation actions (`wait_for`, dialog operations) and failed actions skip the diff

### 4. Storage (`src/storage.ts`)

Thin wrapper around `chrome.storage.local` with safe defaults.

**Settings schema** (`chrome.storage.local` key: `settings`):

```typescript
interface ExtensionSettings {
  browserName: string;                     // Default: generated unique name
  coreUrl: string;                         // Default: "ws://127.0.0.1:4199/ws"
  approvalNotificationsEnabled: boolean;   // Default: true
  permissions: Record<string, PermissionLevel>;
  pageSitePermissions: Record<PagePermissionGroup, SitePermissionLists>;  // Site-level page tool overrides
}
```

**Notes**:
- `browserName` is auto-generated on first init (adjective-animal-hex pattern) and persists until the user overrides it
- `pageSitePermissions` tracks per-hostname allow/ask/deny rules for `page.read`, `page.act`, and `page.execute` groups; managed by the approval flow and the site-permissions module
- Session-only permission overrides live separately in `chrome.storage.session`

**Default permissions**:

| Group | Default | Notes |
|---|---|---|
| tabs | allow | |
| page.read | allow | |
| page.act | ask | |
| page.execute | deny | |
| screenshots | allow | |
| history.read | allow | Agents can search history freely |
| history.delete | ask | Deleting history requires approval — prevents silent wipe-all |
| bookmarks.read | allow | Agents can list bookmarks freely |
| bookmarks.modify | ask | Creating bookmarks requires approval |
| bookmarks.delete | ask | Deleting bookmarks requires approval |
| downloads | deny | |
| network | deny | |
| storage | deny | |
| windows | allow | |
| cookies | ask | |

**Exports**:

| Function | Description |
|---|---|
| `getSettings()` | Read from storage or return defaults |
| `saveSettings(partial)` | Merge partial into current settings |
| `resetSettings()` | Restore defaults |
| `getEffectivePermissions()` | Merge persistent permissions with session overrides |
| `saveSessionPermissionOverride(group, perm)` | Store a temporary override in `chrome.storage.session` |
| `clearSessionPermissionOverride(group)` | Remove a session override |
| `getPageSitePermissions()` | Read site-level page permission rules |
| `addSitePattern(group, list, pattern)` | Add a domain pattern (allow/ask/deny) for a page tool group |
| `removeSitePattern(group, list, pattern)` | Remove a domain pattern |

**Safety guard**: All functions return defaults when not in extension context (e.g., during WXT prepare/build).

### 5. Site Permissions (`src/site-permissions.ts`)

Resolves site-pattern permission decisions for page tools (`page.read`, `page.act`, `page.execute`). Enables per-domain allow/ask/deny rules that override the global permission profile for specific websites.

**Exports**:

| Function | Description |
|---|---|
| `normalizeHostname(url)` | Extract and normalize hostname (strip `www.` prefix) |
| `matchDomainPattern(hostname, pattern)` | Match hostname against `*`, exact domain, or `*.domain` wildcard |
| `resolvePagePermission(url, lists)` | Resolve a URL against allow/ask/deny pattern lists; most specific pattern wins, ties resolved to safest (deny > ask > allow) |

Used by `background.ts` during the approval flow: before showing an approval prompt for a page tool, the extension checks site rules for `allow`/`deny` matches and auto-responds, bypassing the user prompt.

### 6. Safety Guard (`src/safety.ts`)

Detects whether the code is running in a real browser extension or in Node.js:

```typescript
export function isExtensionContext(): boolean {
  // Returns false if process.versions.node exists (Node.js)
  // Returns true only if chrome.runtime.id and chrome.storage.local exist
}
```

Used by:
- `background.ts` — guards initialization
- `ws-client.ts` — guards connection
- `storage.ts` — guards storage access

### 7. Readability Extractor (`src/readability.ts`)

Simplified Readability-style content extractor that strips navigation, sidebars, footers, ads, and other boilerplate from page content. Exports `readabilityFunctionBody` — a string body injected into the page via `chrome.scripting.executeScript`.

Returns a `ReadableResult` with `title`, `content`, `excerpt`, `byline`, `length`, and `fallback` flag. Designed to produce clean article text for agent consumption.

> **Status**: Defined and exported but not yet wired into any action handler. Available for future `page.read({ action: "readable" })` or similar content-extraction action.

### 8. Shared Settings Surface (`entrypoints/popup/`, `entrypoints/options/`)

An HTML settings surface rendered in both the popup and the options page.
The same controls and approval queue are intentionally duplicated in both places for convenience;
they share the same backing logic and storage, with only layout differences.

**Tabs**:

| Tab | Content |
|---|---|
| **Settings** | Configuration (Identity, Core URL, Capabilities, Actions) |
| **Approvals** | List of pending tool requests awaiting user approval (badge dot shown on icon when non-empty) |

**Settings tab**:

| Section | Controls |
|---|---|
| **Identity** | Browser name text input, save button |
| **Core Server** | WebSocket URL text input |
| **Approvals** | Native approval notification toggle |
| **Capabilities** | Dropdown per tool group (ALLOW / ASK / DENY) |
| **Actions** | Reconnect button, Reset to Defaults button |

**Approvals tab** (shown when approvals are pending):

| Section | Controls |
|---|---|
| **Pending Requests** | List of tool requests with: originating site/tab, tool name, parameters summary, description |
| **Per-request actions** | Approve Once, Approve Session, Approve Forever, Reject |
| **Empty state** | "No pending approvals" message when queue is empty |

The popup/options surface polls the background service worker every 2 seconds for connection status and refreshes approvals every 2 seconds. If approvals are pending when the surface opens, it lands on the Approvals tab.

**Communication with background**: The popup/options surface communicates with the service worker via `chrome.runtime.sendMessage`:
- `{ type: "getConnectionStatus" }` → returns the live WebSocket state from the background
- `{ type: "reconnectToCore" }` → asks the background to force a reconnect
- `{ type: "getPendingApprovals" }` → returns array of pending approval objects
- `{ type: "approveRequest", requestId, scope }` → scope can be `once`, `session`, or `forever`
- `{ type: "denyRequest", requestId }` → triggers `approval_response { approved: false }` to core
- `approveRequest` with `scope: "session"` stores a session-only allow override; `scope: "forever"` persists the allow override in settings; `scope: "once"` sends approval only

### 9. v2 Page Interaction Modules (`src/v2/`)

The v2 Page Interaction API is implemented by a set of modules under `src/v2/`. These are called from the capability router when `page.read`, `page.act`, or `page.js` tools are dispatched.

| Module | Exports | Responsibility |
|---|---|---|
| `src/v2/action-result.ts` | `performed()`, `alreadyInDesiredState()`, `notPerformed()`, `ambiguous()`, `blocked()`, `anchorStaleError()` | Build ActionResult envelope objects with correct status, error codes, and suggestions |
| `src/v2/target-resolver.ts` | `targetResolverBody` | Injectable string body that resolves structured Target or anchor to a DOM element in page context. Penetrates same-origin iframes and open shadow roots. |
| `src/v2/anchor-manager.ts` | `setAnchors()`, `getAnchor()`, `clearAnchors()`, `clearAllAnchors()` | Per-tab anchor storage with documentId staleness detection. Anchors live in service worker memory only. |
| `src/v2/inspector.ts` | `inspectFunctionBody` | Injectable string body for page inspection — scans interactable elements, penetrates iframes and shadow roots, returns structured anchor data with anchor IDs |
| `src/v2/page-read.ts` | `dispatchReadAction()` | Dispatches read actions (inspect, content, text, html, attr, meta, forms, count, select, console) via `chrome.scripting.executeScript`, stores inspect anchors |
| `src/v2/page-act.ts` | `dispatchActAction()` | Dispatches act actions (click, fill, check, select_option, press, scroll, submit, wait_for) with anchor fast path and structured target resolution |
| `src/v2/page-js.ts` | `dispatchJsAction()` | Executes arbitrary JavaScript on the page via `chrome.scripting.executeScript`, wraps result in ActionResult envelope |
| `src/v2/snapshot-diff.ts` | `diffSnapshots()`, `AnchorSnapshot`, `SnapshotDiff` | Compares two inspect snapshots by semantic key (`role|name|tag|text`), returns added/removed/changed anchors plus top-level url/title changes |

**Architecture notes**:
- `target-resolver.ts` and `inspector.ts` export string bodies that are injected into the page context via `chrome.scripting.executeScript`. They do NOT run in the service worker.
- `action-result.ts`, `anchor-manager.ts`, `page-read.ts`, `page-act.ts`, and `page-js.ts` run in the service worker.
- All action functions return `ActionResult` envelopes from `action-result.ts`.
- Console capture (`page.read({ action: "console" })`) uses a different flow — see §10 below.

---

### 10. Console Capture

Console capture demonstrates the core MV3 challenge with page instrumentation and how BrowserPowers solves it.

#### 10.1 The Problem

Manifest V3 content scripts run in an **isolated world** — they share the DOM with the page but have a separate JavaScript execution context. Overriding `console.log` in the content script only intercepts calls from the content script itself, not from the page's main world. There is no API to retroactively read a page's console history.

Additionally:
- **CSP blocks inline `<script>` tags** injected by content scripts on sites like YouTube.
- **The service worker can suspend** after ~30s of inactivity, losing any state it held.

#### 10.2 The Architecture

```
document_start:
  Content script fires (always alive, never sleeps)
    ├── chrome.runtime.sendMessage({ type: "injectMainWorldConsoleCapture" })
    │     → wakes service worker
    │     → SW: chrome.scripting.executeScript({ world: "MAIN", func: initOverride })
    │       (bypasses CSP — extension privilege)
    │
    └── window.addEventListener("message")
          ← receives entries from MAIN world via postMessage

MAIN world (after init):
  console.log / warn / error / info / debug
    ├── pushes to __bpConsoleBuffer (in-memory fallback)
    ├── window.postMessage({ source: "bp-console", entry: { level, messages, timestamp, stack? } }, "*")
    │     → content script receives → consoleBuffer.push(entry)
    └── calls original console method (preserves normal behavior)

On page.read({ action: "console" }):
  Service worker → chrome.tabs.sendMessage(tabId, "console", { limit, offset })
    → content script returns consoleBuffer.slice(−(offset+limit), −offset)
    → no executeScript round-trip on every query
```

#### 10.3 Key Properties

| Property | Detail |
|---|---|
| **No data loss** | Content script (always alive) holds the buffer. Service worker suspension does not lose entries. |
| **CSP-proof** | `chrome.scripting.executeScript({ world: "MAIN" })` runs with extension privileges, bypassing page CSP. |
| **Fast queries** | Buffer is in the content script's memory — queries are direct `sendMessage` round-trips, not executeScript injections. |
| **Forwarded from MAIN world** | Each console call is `postMessage`'d from MAIN world → isolated world. The buffer in `window.__bpConsoleBuffer` on the MAIN world is a fallback. |
| **Capacity** | Ring buffer of 500 entries (oldest dropped). Cleared on page navigation (new content script instance). |

#### 10.4 Known Limitation

There is a ~1–5ms race window at `document_start`. The content script sends the wake-up message to the service worker asynchronously. Any synchronous inline `<script>` tags in the page's `<head>` that execute before the service worker injects the override will not be captured. This is a fundamental MV3 limitation — no API exists to retroactively read console history. In practice, this affects very few entries: most modern web apps load scripts asynchronously or after the initial HTML parse.

#### 10.5 Implementation Files

| File | Role |
|---|---|
| `entrypoints/background.ts` | Handles `injectMainWorldConsoleCapture` message; injects MAIN world override via `executeScript({ world: "MAIN" })` |
| `entrypoints/content.ts` | Module-scope postMessage listener; buffers entries; handles `console` read action; sends wake-up at document_start |
| `src/v2/page-read.ts` | `consoleRead()` dispatches `sendReadMessage` to content script buffer |

---

## Data Models / Storage

### chrome.storage.local

| Key | Type | Set by |
|---|---|---|
| `settings` | `ExtensionSettings` | Popup/options UI (user), `storage.ts` (defaults) |
| `browserId` | `string` | Core (`registered` message) |

### chrome.storage.session

| Key | Type | Set by |
|---|---|---|
| `sessionPermissionOverrides` | `Record<string, PermissionLevel>` | Background page approval flow |

### ExtensionSettings

```typescript
interface ExtensionSettings {
  browserName: string;
  coreUrl: string;
  approvalNotificationsEnabled: boolean;
  permissions: {
    tabs: "allow" | "ask" | "deny";
    "page.read": "allow" | "ask" | "deny";
    "page.act": "allow" | "ask" | "deny";
    "page.execute": "allow" | "ask" | "deny";
    screenshots: "allow" | "ask" | "deny";
    history: "allow" | "ask" | "deny";
    bookmarks: "allow" | "ask" | "deny";
    downloads: "allow" | "ask" | "deny";
    network: "allow" | "ask" | "deny";
    storage: "allow" | "ask" | "deny";
    windows: "allow" | "ask" | "deny";
    cookies: "allow" | "ask" | "deny";
  };
  pageSitePermissions: Record<PagePermissionGroup, SitePermissionLists>;
}
```

### Capability List

Built dynamically on connect by filtering a static list of all possible capabilities against the current permission profile. Any capability whose group has `deny` is excluded.

---

## Relationships and Flow

### Core → Extension (Tool Execution)

```
Core sends WebSocket execute message
  → background.ts onMessage handler receives it
  → routeExecute(request)
  → execute(tool, params)
  → chrome.* API call (one of 18+ tools)
  → result or error returned
  → background.ts sends result/error back to core via WebSocket
```

### Extension → Core (Registration)

```
Service worker starts → connect()
  → WebSocket opens → build capability list (filtered by permissions)
  → send register { name, capabilities, permissions }
  → receive registered { browserId }
  → store browserId in chrome.storage.local
  → start heartbeat interval
```

---

## Dependencies

### Runtime

| Dependency | Purpose |
|---|---|
| WXT ^0.20 | Build tooling, manifest generation, dev server |
| Chrome Extension APIs | All browser operations |

### Dev

| Dependency | Purpose |
|---|---|
| `@types/chrome` | Type definitions for Chrome APIs |
| `typescript` ^6.0 | Type checking |
| `rimraf` ^6.0 | Clean build artifacts |

### Key Imports Across Extension Source

```
entrypoints/background.ts
  → src/ws-client (connect, reconnect, onMessage, isConnected, getConnectionStatus, send)
  → src/capability-router (routeExecute)
  → src/safety (isExtensionContext)
  → src/storage (getSettings, saveSettings, getPageSitePermissions, addSitePattern)
  → src/site-permissions (normalizeHostname, resolvePagePermission)

entrypoints/popup/main.ts
  → src/storage (getSettings, saveSettings, resetSettings)
  → chrome.runtime.sendMessage (getConnectionStatus, reconnectToCore, approvals)

src/capability-router.ts
  → src/v2/page-read (dispatchReadAction)
  → src/v2/page-act (dispatchActAction)
  → src/v2/page-js (dispatchJsAction)
  → src/v2/snapshot-diff (diffSnapshots — for sync-mode post-action diff)

src/v2/page-read.ts
  → src/v2/inspector (inspectFunctionBody)
  → src/v2/action-result (performed, notPerformed, blocked)
  → src/v2/anchor-manager (setAnchors)

src/v2/page-act.ts
  → src/v2/target-resolver (targetResolverBody)
  → src/v2/anchor-manager (getAnchor)
  → src/v2/action-result (performed, alreadyInDesiredState, notPerformed, ambiguous, blocked)

src/v2/page-js.ts
  → src/v2/action-result (performed, blocked)
  → src/v2/snapshot-diff (diffSnapshots — for post-action diff in sync mode)

src/ws-client.ts
  → src/storage (getSettings, getEffectivePermissions)
  → src/safety (isExtensionContext)

src/storage.ts
  → src/safety (isExtensionContext)

src/site-permissions.ts
  → src/types (PagePermissionGroup, SitePermissionLists)
```

---

## Contracts / Invariants

| Invariant | Description |
|---|---|
| **Single WebSocket connection** | Exactly one WebSocket connection to core per extension instance. Reconnection replaces the old connection. |
| **Permissions are local truth** | The extension's stored permission profile is the source of truth for what capabilities to register. The core's gate is defense in depth, not the primary authority. |
| **No direct LLM calls** | The extension MUST NOT call any LLM API directly. All LLM communication routes through the core. |
| **Heartbeat or die** | If the WebSocket closes, the extension must attempt reconnection until it succeeds or the browser closes. |
| **One background, one popup** | MV3 allows exactly one service worker and one popup instance. The service worker is the long-lived process; the popup is transient. |
| **Guard before action** | Every module that could run in Node.js (WXT prepare/build) must guard itself with `isExtensionContext()`. |

---

## Configuration / Operations

### Build

```bash
# Development
pnpm dev:ext                    # WXT dev server (HMR)
pnpm dev:ext:chrome             # Chrome-specific
pnpm dev:ext:firefox            # Firefox-specific

# Production
pnpm build:ext:chrome           # Build Chrome extension
pnpm build:ext:firefox          # Build Firefox extension
```

### Load in Browser

- **Chrome**: `chrome://extensions` → Developer mode → Load unpacked → select `extension/.output/chrome-mv3-dev/`
- **Firefox**: via WXT Firefox profile or `about:debugging`

### Shared Settings Configuration

The popup and options page provide the same user-facing controls:

| Control | Effect |
|---|---|
| Browser Name | Changes the name sent in `register` message |
| Core URL | Changes the WebSocket endpoint (triggers reconnect) |
| Permission dropdowns | Changes which capabilities are registered; saved immediately |
| Reconnect | Closes existing connection and reconnects |
| Reset to Defaults | Restores all settings to defaults |
| Approvals tab | Shows pending tool requests — each with Approve/Deny buttons |
| Badge | Extension icon shows count of pending approvals (auto-updated by background) |

---

## Design Decisions

| Decision | Rationale | Confidence |
|---|---|---|
| **WXT over raw Manifest** | WXT provides HMR, cross-browser builds, and TypeScript support out of the box. Writing raw manifest.json + build scripts would duplicate WXT's value. | High |
| **WebSocket in service worker** | MV3 service workers are the only persistent script. Popup is transient. WebSocket must live in the background for reliable connection. | High |
| **Exponential backoff reconnect** | Prevents thundering herd on core restart; browser may be offline for seconds or hours. | High |
| **Permissions filter on registration** | Core never even sees denied capabilities — defense in depth. Even if core gate had a bug, the extension wouldn't register sensitive tools. | High |
| **chrome.storage for settings** | No external dependency; survives extension restarts; simple key-value interface. | High |
| **isExtensionContext() guard** | WXT runs TypeScript in Node.js during prepare/build. `chrome` globals don't exist there. Without the guard, imports fail at build time. | High |
| **MV3 alarms for keepalive** | Chrome aggressively terminates service workers after ~30s of inactivity. Alarms wake it up. | Medium (Chrome behavior may change) |

---

## Implementation Pointers

- Entry: `extension/entrypoints/background.ts`
- Popup: `extension/entrypoints/popup/main.ts`, `extension/entrypoints/popup/index.html`, `extension/entrypoints/popup/style.css`
- Options page: `extension/entrypoints/options/main.ts`, `extension/entrypoints/options/index.html`, `extension/entrypoints/options/style.css`
- Shared UI: `extension/src/ui/settings-surface.ts`, `extension/entrypoints/shared/settings-surface.css`
- WebSocket client: `extension/src/ws-client.ts`
- Capability router: `extension/src/capability-router.ts`
- Storage: `extension/src/storage.ts`
- Site permissions: `extension/src/site-permissions.ts`
- Safety: `extension/src/safety.ts`
- Readability: `extension/src/readability.ts`
- Snapshot diff: `extension/src/v2/snapshot-diff.ts`
- Types: `extension/src/types.ts`
- Config: `extension/wxt.config.ts`
