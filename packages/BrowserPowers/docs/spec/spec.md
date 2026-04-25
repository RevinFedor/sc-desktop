---
node_type: spec
title: BrowserPowers — Behavioral Specification
status: active
updated: 2026-06-11
tags: [spec, websocket, mcp, rest-api, cli, permissions, configuration, auth]
links:
  depends_on: [../overview/product.md, ../reference/glossary.md]
  implemented_by: [../../core/src/, ../../extension/src/]
---

# BrowserPowers — Behavioral Specification

## Abstract

BrowserPowers is a client-server system for multi-browser AI agent control. A Node.js core server hosts MCP, REST, and CLI interfaces. Lightweight browser extensions connect to the core via WebSocket and execute browser operations on demand. The core routes agent commands to the appropriate browser, enforces permission gates, and provides a unified observability layer.

---

## Introduction

Existing browser automation tools (Playwright, Puppeteer, Selenium) create ephemeral, headless browser sessions. They cannot control a user's real, persistent browser with its logged-in sessions, extensions, cookies, and local state.

BrowserPowers solves this by making each real browser a first-class participant. A thin extension in each browser connects to a central core server. Agents interact with the core via standard protocols (MCP, HTTP, CLI) — the core forwards commands to the appropriate browser extension, which executes them against the real `chrome.*` APIs.

---

## Scope

### In Scope

- Core server that exposes MCP, REST, and CLI interfaces for browser control
- Browser extension for Chrome (and Firefox via WXT) that connects to the core and executes browser API calls
- WebSocket protocol for real-time core↔extension communication
- Permission gate system per tool group per browser (allow, deny, ask)
- Browser registry — tracking connected browsers, their capabilities, and health
- Configuration via local YAML file (~/.config/browserpowers/config.yaml)
- LLM call routing through core (proxy pattern, not local LLM)
- Headless core agent mode (shared agent logic, no browser UI required)

### Out of Scope

- Ephemeral browser creation (no Playwright/Puppeteer-style browser spawning)
- Cloud-hosted browser farm
- Graphical observability dashboard (configuration file only)
- Native browser automation without extension (no CDP/DevTools Protocol directly)
- Standalone LLM inference (core routes to external LLM APIs only)

---

## Terminology

| Term | Definition |
|---|---|
| **Core** | The central Node.js server that hosts interfaces and orchestrates commands |
| **Extension** | The browser extension installed in each real browser, connecting to core via WebSocket |
| **Browser ID** | UUID assigned by the core when an extension registers; used to address commands |
| **Capability** | A single tool a browser exposes (e.g. `tabs.list`, `page.content`) |
| **Tool Group** | A category of related capabilities (e.g. `tabs`, `page.read`, `page.act`, `page.execute`, `screenshots`, `history`) |
| **Permission Profile** | A per-browser map of tool group → permission level |
| **Gate** | The middleware that checks a permission profile before allowing tool execution |
| **Registry** | In-memory store of all connected browsers and pending requests |
| **MCP** | Model Context Protocol — the primary agent-facing interface |
| **Command Service** | Unified internal interface that all adapters (MCP, REST, CLI) call into |

---

## Normative Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## System Model

### Actors

| Actor | Role |
|---|---|
| **Human user** | Configures browsers, sets permissions, interacts via popup or options page |
| **AI agent** | External process (Claude Desktop, Cursor, coding agent) that commands browsers via MCP/REST/CLI |
| **Core** | Coordinates commands, enforces gates, provides observability |
| **Browser Extension** | Executes browser API calls, enforces local permissions, maintains WebSocket |

### Top-Level Interfaces

| Interface | Transport | Audience |
|---|---|---|
| MCP | HTTP (streamable) | AI agents |
| REST | HTTP | Scripts, manual testing |
| CLI | stdio | Terminal users |
| WebSocket | WS | Extension ↔ Core |

### States: Browser Lifecycle

```
┌──────────┐      register()      ┌──────────────┐
│  OFFLINE  │ ──────────────────►  │  CONNECTED   │
└──────────┘                       └──────┬───────┘
       ▲                                  │ heartbeat timeout
       │    WebSocket close               │ or ws.close()
       └──────────────────────────────────┘
```

---

## Conformance

A conforming BrowserPowers implementation MUST:

1. Implement the WebSocket protocol as specified in § Behavioral Specification — WebSocket Protocol
2. Provide MCP tools as specified in § Behavioral Specification — MCP Tools
3. Enforce permission gates before executing any browser tool
4. Maintain a browser registry with heartbeat-based staleness detection
5. Accept configuration from `~/.config/browserpowers/config.yaml`

A conforming browser extension MUST:

1. Connect to the core via WebSocket on initialization
2. Register its capabilities and permission profile on connection
3. Execute incoming tool requests against the real browser APIs
4. Maintain a heartbeat at least every 30 seconds
5. Auto-reconnect on disconnection with exponential backoff

---

## Behavioral Specification

### 1. WebSocket Protocol

#### 1.1 Transport

- **Protocol**: WebSocket (RFC 6455)
- **Path**: `/ws` (configurable)
- **Port**: 4199 (configurable)
- **Encoding**: All messages are UTF-8 JSON

#### 1.2 Message Format

Every message is a JSON object with a `type` field and a `payload` field:

```json
{ "type": "<message_type>", "payload": { ... } }
```

#### 1.3 Extension → Core Messages

##### register

Sent by the extension immediately after WebSocket connection is established.

```json
{
  "type": "register",
  "payload": {
    "name": "Work Chrome",
    "capabilities": [
      { "tool": "tabs.list", "description": "List all open tabs", "group": "tabs" },
      { "tool": "tabs.create", "description": "Open a new tab", "group": "tabs" }
    ],
    "permissions": {
      "tabs": "allow",
      "page.read": "allow",
      "page.act": "ask",
      "page.execute": "deny",
      "screenshots": "allow",
      "history": "deny",
      "bookmarks": "deny",
      "downloads": "deny",
      "network": "deny",
      "storage": "deny"
    }
  }
}
```

**Register payload fields:**

| Field | Type | Description |
|---|---|---|
| `name` | string | Human-readable browser name |
| `capabilities` | Capability[] | Tools this browser exposes |
| `permissions` | PermissionProfile | Per-group permission levels |
| `authKey` | string (optional) | API key for servers with authentication enabled |
| `browserId` | string (optional) | Previously assigned browser ID for reconnection |

The core MUST respond with a `registered` message containing the assigned `browserId`.

##### result

Sent by the extension after successfully executing a tool.

```json
{
  "type": "result",
  "payload": {
    "requestId": "<uuid>",
    "data": { ... }
  }
}
```

##### error

Sent by the extension after failing to execute a tool.

```json
{
  "type": "error",
  "payload": {
    "requestId": "<uuid>",
    "message": "Error description"
  }
}
```

##### heartbeat

Sent periodically by the extension to signal it is still alive.

```json
{ "type": "heartbeat" }
```

MUST be sent at least every 25 seconds. The core MUST respond with `heartbeat_ack`.

##### approval_response

Sent by the extension in response to a `request_approval` from the core. Indicates whether the user approved or denied the requested tool execution.

```json
{
  "type": "approval_response",
  "payload": {
    "requestId": "<uuid>",
    "approved": true
  }
}
```

- `approved: true` → the core MUST proceed with `execute` using the same `requestId`
- `approved: false` → the core MUST return an error to the original caller with `"User denied approval"`
- The extension MUST send exactly one `approval_response` per `request_approval` request
- If no response is received within the approval timeout (default 60 seconds), the core MUST auto-deny and return a timeout-specific error distinct from a user rejection

#### 1.4 Core → Extension Messages

##### registered

Sent in response to `register`.

```json
{
  "type": "registered",
  "payload": {
    "browserId": "<uuid>"
  }
}
```

##### auth_required

Sent by the core when the extension's register message is missing or has an invalid API key, and the core requires authentication.

```json
{
  "type": "auth_required",
  "payload": {
    "message": "API key required for this server"
  }
}
```

The extension MUST close the WebSocket upon receiving this message and surface the authentication requirement to the user. The extension SHOULD provide a field in its settings UI for the user to enter the API key, then reconnect.

##### execute

Sent by the core to command the extension to perform a tool call.

```json
{
  "type": "execute",
  "payload": {
    "requestId": "<uuid>",
    "tool": "tabs.create",
    "params": { "url": "https://example.com" }
  }
}
```

The extension MUST respond with either `result` or `error` using the same `requestId`.

##### heartbeat_ack

Sent in response to `heartbeat`.

```json
{ "type": "heartbeat_ack" }
```

##### request_approval

Sent by the core when a tool execution is blocked by an `ask` permission gate. Instead of returning an error, the core asks the extension to request user approval.

```json
{
  "type": "request_approval",
  "payload": {
    "requestId": "<uuid>",
    "tool": "page.act",
    "params": { "action": "click", "target": { "role": "button", "name": "Submit" } },
    "description": "Agent wants to click button 'Submit'"
  }
}
```

- The extension MUST store the request and signal the user (e.g., by setting a badge on the extension icon)
- The extension MUST respond with either `approval_response` (approved) or `approval_response` (denied)
- The `description` field is a human-readable summary generated by the core for display in the popup or options page
- If the user does not respond within the approval timeout, the core auto-denies with a timeout-specific error distinct from user rejection
- The extension SHOULD present four actions to the user: `Approve Once`, `Approve Session`, `Approve Forever`, and `Reject`
- `Approve Session` and `Approve Forever` MAY update browser-side permission settings before sending `approval_response { approved: true }`; the wire-level response remains boolean-only

##### config_updated

Sent by the core to push configuration changes to the extension.

```json
{
  "type": "config_updated",
  "payload": {
    "tabs": "allow",
    "history": "deny"
  }
}
```

#### 1.5 Request Lifecycle

Tools execute sequentially per browser (one at a time). When a browser is busy processing a request, subsequent requests for the same browser are queued and drained in FIFO order. This ensures predictable ordering and prevents race conditions between concurrent agent requests.

There are two request lifecycle paths: direct execution (tools whose gate resolves to `allow`) and approval-gated execution (tools whose gate resolves to `ask`).

##### 1.5.1 Direct Execution (gate: allow)

```
Core                              Extension
  │                                    │
  │──── execute(requestId, tool) ────►│
  │                                    │── executes chrome.* API
  │                                    │
  │◄─── result(requestId, data) ──────│  (on success)
  │◄─── error(requestId, msg) ────────│  (on failure)
```

##### 1.5.2 Approval-Gated Execution (gate: ask)

```
Core                         Extension                User
  │                               │                     │
  │── request_approval(id,tool)─►│                     │
  │                               │── setBadge(count)  │
  │                               │                     │
  │                               │◄── open popup/options surface ─│
  │                               │── get pending ─────│
  │                               │── show approvals ──│
  │                               │                     │
  │                               │◄── approve/deny ───│
  │                               │                     │
  │◄── approval_response(id,ok)──│                     │
  │                               │                     │
  │── execute(id, tool) ────────►│ (if approved)       │
  │◄── result(id, data) ────────│                     │
```

##### 1.5.3 Rules

- The core generates a `requestId` (format: `${browserId}:${uuid}`)
- The extension MUST echo the same `requestId` in its response (both `result`/`error` and `approval_response`)
- The core MUST timeout direct execution requests after a configurable period (default 120 seconds via `queue.defaultTimeoutMs` or overridden per-call via `timeout_ms`)
- The core MUST timeout approval-gated requests after a configurable period (default 60 seconds via `gates.approvalTimeoutMs`)
- On timeout, the core MUST return a timeout-specific error to the caller; user rejection and timeout MUST be distinguishable

#### 1.6 Heartbeat and Staleness

- Extensions MUST send `heartbeat` at least every 25 seconds
- Core MUST respond with `heartbeat_ack`
- Core MUST track `lastHeartbeat` per browser
- If a browser's last heartbeat exceeds 60 seconds (2 × heartbeat interval), the core MUST:
  1. Close the WebSocket connection
  2. Remove the browser from the registry
  3. Reject any pending requests for that browser with a "disconnected" error

#### 1.7 Reconnection

Extensions SHOULD implement exponential backoff reconnection:

| Attempt | Delay |
|---|---|
| 1 | ~1s |
| 2 | ~2s |
| 3 | ~4s |
| 4 | ~8s |
| 5+ | capped at 30s |

On reconnect, the extension MUST send a fresh `register` message.

---

### 2. MCP Tools

The core exposes a Model Context Protocol (MCP) server at `/mcp` (configurable) using streamable HTTP transport. The server registers 11 tools: `browsers`, `screenshot`, `tabs`, `execute_all`, `execute_batch`, `page_read`, `page_act`, `page_js`, `cookies`, `windows`, and `help`.

#### 2.1 Tool: `browsers`

| Property | Value |
|---|---|
| Description | List all connected browsers with capabilities, status, and active tab info |
| Input | `{ summary?: boolean }` |
| Output | Formatted text listing each browser with ID, name, capabilities, and status |

The `summary` flag returns a condensed view with fewer fields.

#### 2.2 Tool: `screenshot`

| Property | Value |
|---|---|
| Description | Capture a screenshot of the active tab |
| Input | `{ browser_id: string }` or `{ browser_name: string }` |
| Output | On success: file path where the PNG was saved |
| Error | Returns `isError: true` with error message |

Screenshots are saved as temporary PNG files. Old screenshot files (>1 hour) are cleaned up automatically on each new screenshot.

#### 2.3 Tool: `tabs`

| Property | Value |
|---|---|
| Description | List and navigate browser tabs. Use `action` to choose the operation. |
| Input | `{ browser_id: string, action: "list" | "navigate" | "goBack" | "goForward" | "close", url?: string, tab_id?: number, limit?: number, offset?: number, wait_until?: string, timeout_ms?: number, snapshot?: boolean }` |
| Output | Tab list for `list`, navigation result for `navigate`/`goBack`/`goForward`, confirmation for `close` |

**Actions:**
- `list` — List all open tabs, with optional `limit` (default 100) and `offset` (default 0)
- `navigate` — Navigate to a URL. If `tab_id` is provided, navigates an existing tab in-place; otherwise creates a new tab. `wait_until` controls load timing (`none`, `domcontentloaded`, `complete`; default `complete`). `snapshot: true` runs a compact inspect after navigation.
- `goBack` — Navigate back in tab history
- `goForward` — Navigate forward in tab history
- `close` — Close a tab

This tool consolidates the legacy `browser_navigate` and `browser_list_tabs` tools.

#### 2.4 Tool: `execute_all`

| Property | Value |
|---|---|
| Description | Execute a tool on ALL connected browsers simultaneously |
| Input | `{ tool: string, params?: object }` |
| Output | Array of results, one per browser |

Results are collected via `Promise.allSettled` — individual failures do not block other browsers.

#### 2.5 Tool: `execute_batch`

| Property | Value |
|---|---|
| Description | Execute multiple tools across browsers in parallel |
| Input | `{ commands: [{ browser_id?: string, browser_name?: string, tool: string, params?: object }] }` |
| Output | Array of per-item results in the same order as input commands |

Each command specifies a target browser (by ID or name) and a tool with optional parameters.

#### 2.6 Tool: `page_read`

Page Read is the unified tool for extracting information from a loaded page without mutating it. It uses an `action` discriminator to select the specific read operation. Gated behind the `page.read` permission group.

| Property | Value |
|---|---|
| Description | Read page content without mutating it. Use `action` to specify what to read. |
| Input | `{ browser_id: string, action: string, target?: Target, limit?: number, include_hidden?: boolean, name?: string }` |
| Output | ActionResult envelope with `data` containing read results |

**Read actions:**

###### `action: "inspect"`

Page inspection — discovers interactable elements and assigns lightweight anchor IDs for fast follow-up actions.

| Field | Type | Description |
|---|---|---|
| `target` | Target (optional) | Scope inspection to a specific area |
| `limit` | number | Max anchors to return (default 50) |
| `include_hidden` | boolean | Include hidden/off-screen elements (default false) |

**Output**: `data` contains `{ url, title, documentId, anchors: [{ anchor, role?, name?, label?, placeholder?, text?, tag, type?, visible, enabled?, checked?, selected?, target }] }`

Anchors are stored in the anchor manager for the current tab and document epoch. See §2.15 Inspect Anchors for lifecycle rules.

The extension MUST scan the page (and same-origin iframes + open shadow roots) for interactable elements, assign anchor IDs (`a1`, `a2`, ...), and return structured anchor data.

###### `action: "content"`

Full page text content.

| Field | Type | Description |
|---|---|---|
| `target` | Target (optional) | If `target.css` is provided, returns text of matching element; otherwise returns `document.body.innerText` |

**Output**: `data` contains `{ content: string }`

###### `action: "text"`

Text content of elements matching a CSS selector.

| Field | Type | Description |
|---|---|---|
| `target` | Target (required) | `target.css` is used as the CSS selector |
| `limit` | number | Max results (default 50) |

**Output**: `data` contains `{ texts: string[] }` — one trimmed entry per matching element, limited by `limit`.

###### `action: "html"`

outerHTML of elements matching a CSS selector.

| Field | Type | Description |
|---|---|---|
| `target` | Target (required) | `target.css` is used as the CSS selector |
| `limit` | number | Max results (default 10) |

**Output**: `data` contains `{ html: string[] }`

###### `action: "attr"`

Get an attribute value from an element matching a CSS selector.

| Field | Type | Description |
|---|---|---|
| `target` | Target (required) | `target.css` is used as the CSS selector |
| `name` | string | Attribute name to read |

**Output**: `data` contains `{ name: string, value: string | null }`

###### `action: "meta"`

Page metadata — title, description, Open Graph tags, canonical URL, language, author.

**Input**: No target needed. Returns metadata from `<title>`, `<meta name="description">`, Open Graph `<meta property="og:*">` tags, `<link rel="canonical">`, `<html lang>`, and `<meta name="author">`.

**Output**: `data` contains `{ title, description?, ogTitle?, ogDescription?, ogImage?, canonicalUrl?, language?, author? }`

###### `action: "forms"`

List all forms on the page with structured field data.

| Field | Type | Description |
|---|---|---|
| `limit` | number | Max forms to return (default 20) |

**Output**: `data` contains `{ forms: [{ id?, name?, action?, method, fields: [{ name, type, required, disabled, placeholder?, options? }] }] }`, limited by `limit`.

For `<select>` elements, `options` contains `{ value, text, selected }`.

###### `action: "count"`

Count how many elements match a CSS selector.

| Field | Type | Description |
|---|---|---|
| `target` | Target (required) | `target.css` is used as the CSS selector |

**Output**: `data` contains `{ count: number }`

###### `action: "select"`

Get the currently selected text on the page.

**Input**: No target needed.

**Output**: `data` contains `{ selectedText: string }` (empty string if nothing selected)

Aliased as `browser_select` for backward compatibility.

###### `action: "console"`

Retrieve captured console output from the page. Intercepts `console.log`, `console.warn`, `console.error`, `console.info`, `console.debug`, uncaught exceptions (`window.onerror`), and unhandled promise rejections (`unhandledrejection`). Entries are buffered in memory (max 500) and returned on demand.

**Architecture note**: MV3 content scripts run in an isolated world — overriding `console.log` there does NOT intercept the page's console calls. Instead, the service worker injects a console override into the page's MAIN world via `chrome.scripting.executeScript({ world: "MAIN" })`. Each captured entry is forwarded to the content script via `window.postMessage`, where it is buffered. This means:
- The capture works on all pages regardless of Content Security Policy (CSP).
- The buffer survives service worker suspension because the content script is always alive.
- There is a ~1–5ms race window at page load: synchronous inline `<script>` tags that execute before the service worker injects the override may not be captured. This is a fundamental MV3 limitation — no API exists to retroactively read console history.

| Field | Type | Description |
|---|---|---|
| `limit` | number | Max entries to return from the end of the buffer (default 50) |
| `offset` | number | Skip N entries from the end (default 0) |

**Output**: `data` contains `{ entries: [{ level, messages[], timestamp, stack? }], totalCount: number }`

#### 2.7 Tool: `page_act`

Page Act is the unified tool for interacting with or mutating page elements. It uses an `action` discriminator to select the specific operation. Gated behind the `page.act` permission group.

| Property | Value |
|---|---|
| Description | Interact with or mutate the page. Use `action` to specify what to do. |
| Input | `{ browser_id: string, action: string, target?: Target, anchor?: string, value?: string, checked?: boolean, key?: string, direction?: string, amount?: number, timeout_ms?: number }` |
| Output | ActionResult envelope |

**Target resolution order** (see §2.14 Structured Target for details):
1. `anchor` (fast path — pre-resolved from inspect)
2. `target` (structured object with `css`, `text`, `role`, `label`, `placeholder`, `testId`)

**Action implementations:**

###### `action: "click"`

Click the element matching the target or anchor.

| Field | Type | Description |
|---|---|---|
| `target` | Target (optional) | Structured target for the element to click |
| `anchor` | string (optional) | Anchor ID from inspect (preferred fast path) |

The extension MUST find the element via anchor or target resolution, then call `.click()` on the matched `HTMLElement`. If the element is disabled, MUST return `not_performed`. If multiple elements match for critical actions (click, submit, check), MUST return `ambiguous` with `errorCode: "AMBIGUOUS_TARGET"`.

###### `action: "fill"`

Set a form field's value programmatically (no keystroke simulation).

| Field | Type | Description |
|---|---|---|
| `target` | Target (optional) | Structured target for the field |
| `anchor` | string (optional) | Anchor ID from inspect |
| `value` | string (required) | Value to set |

The extension MUST set the element's `value` directly and dispatch `input` and `change` events.

###### `action: "check"`

Toggle a checkbox or radio input.

| Field | Type | Description |
|---|---|---|
| `target` | Target (optional) | Structured target for the checkbox/radio |
| `anchor` | string (optional) | Anchor ID from inspect |
| `checked` | boolean (optional) | Desired checked state. If omitted, toggles from current state. |

The extension MUST set `el.checked` and dispatch a `change` event.

###### `action: "select_option"`

Select an option in a `<select>` element by value or label.

| Field | Type | Description |
|---|---|---|
| `target` | Target (optional) | Structured target for the `<select>` element |
| `anchor` | string (optional) | Anchor ID from inspect |
| `value` | string (optional) | Option value to select |
| `label` | string (optional) | Option display text to select (used if value not found) |

The extension MUST find the `<select>` element, then find the `<option>` whose `value` or `textContent` matches (checked in that order), set `option.selected = true`, and dispatch a `change` event. At least one of `value` or `label` MUST be provided.

###### `action: "press"`

Press a keyboard key on a focused element.

| Field | Type | Description |
|---|---|---|
| `target` | Target (optional) | Structured target for the element (will be focused) |
| `anchor` | string (optional) | Anchor ID from inspect |
| `key` | string (required) | Key to press (e.g. `"Enter"`, `"Tab"`, `"Escape"`) |

The extension MUST focus the element, then dispatch `keydown`, `keypress`, and `keyup` KeyboardEvents with the specified key.

###### `action: "scroll"`

Scroll the page or to a specific element.

| Field | Type | Description |
|---|---|---|
| `target` | Target (optional) | Structured target (required for `direction: "to_element"`) |
| `anchor` | string (optional) | Anchor ID from inspect |
| `direction` | string | `"up"`, `"down"`, or `"to_element"` (default: `"down"`) |
| `amount` | number (optional) | Scroll amount in pixels (default: one viewport height) |

- `direction: "up"` / `"down"`: Scrolls `window` by `amount` pixels.
- `direction: "to_element"`: Scrolls the target element into view using `scrollIntoView({ behavior: "smooth", block: "center" })`.

###### `action: "submit"`

Submit a form.

| Field | Type | Description |
|---|---|---|
| `target` | Target (optional) | Structured target for the form or a child element |
| `anchor` | string (optional) | Anchor ID from inspect |

The extension MUST find the form element (or the closest form ancestor if target matches a child) and call `.submit()`. If no form is found, returns `not_performed`.

###### `action: "wait_for"`

Wait for an element to appear, or for a timeout.

| Field | Type | Description |
|---|---|---|
| `target` | Target (optional) | Structured target (uses `target.css` as selector) |
| `anchor` | string (optional) | Anchor ID from inspect |
| `timeout_ms` | number (optional) | Max wait time in ms (default 5000) |

If a selector or anchor is provided, the extension MUST poll `document.querySelector(selector)` at 100ms intervals until a match is found or `timeout_ms` elapses. If neither is provided, the extension MUST simply wait `timeout_ms` milliseconds.

#### 2.8 Tool: `page_js`

| Property | Value |
|---|---|
| Description | Execute arbitrary JavaScript code on the page — gated escape hatch. Use only when `page_read` and `page_act` cannot express the task. |
| Input | `{ browser_id: string, code: string }` |
| Output | ActionResult envelope with `data.result` containing the return value of the executed code (which must be JSON-serializable) |

> **Security**: This tool is gated behind the `page.execute` permission group (the old group name is preserved for backward compatibility). It MUST NOT be accessible if `page.execute` is set to `deny` or `ask` (without approval). It is intentionally the highest-risk tool in the system. The MCP tool name is `page_js`; internally it dispatches as tool `page.js` which maps to permission group `page.execute`.

#### 2.9 Tool: `cookies`

| Property | Value |
|---|---|
| Description | Manage browser cookies. Supports get, set, remove, and list operations via the `action` parameter. |
| Input | `{ browser_id: string, action: "get" | "set" | "remove" | "list", url: string, name?: string, value?: string }` |
| Output | Cookie data for `get`, confirmation for `set`/`remove`, cookie list for `list` |

**Actions:**
- `get` — Get a cookie by name and URL
- `set` — Set a cookie value for a given name and URL
- `remove` — Remove a cookie by name and URL
- `list` — List all cookies for a given URL

#### 2.10 Tool: `windows`

| Property | Value |
|---|---|
| Description | Manage browser windows. Supports list, create, focus, and close operations via the `action` parameter. |
| Input | `{ browser_id: string, action: "list" | "create" | "focus" | "close", url?: string, window_id?: number }` |
| Output | Window list for `list`, success confirmation for `create`/`focus`/`close` |

**Actions:**
- `list` — List all open windows with tab counts
- `create` — Create a new window, optionally with a URL
- `focus` — Focus a window by ID
- `close` — Close a window by ID

#### 2.11 Tool: `help`

| Property | Value |
|---|---|
| Description | Get the full system reference — capability summary, workflow guides, tool relationships, and how everything fits together |
| Input | `{ topic?: string }` |
| Output | Formatted reference text |

Available topics: `navigation`, `anchors`, `gates`. If no topic is provided, the complete system reference is returned.

#### 2.12 Legacy Aliases

The following legacy MCP tools are preserved for backward compatibility but internally dispatch via their modern equivalents:

##### `browser_list`

| Property | Value |
|---|---|
| Description | List all connected browsers (legacy alias — use `browsers` instead) |
| Input | `{}` |
| Output | JSON array of browser objects |

Internally dispatches as `browsers`.

##### `browser_navigate`

| Property | Value |
|---|---|
| Description | Navigate a browser tab to a URL (legacy alias — use `tabs` with `action: "navigate"` instead) |
| Input | `{ browser_id: string, url: string }` |
| Output | Tool execution result |

Internally dispatches as `tabs` with `action: "navigate"`.

##### `browser_screenshot`

| Property | Value |
|---|---|
| Description | Capture a screenshot of the active tab (legacy alias — use `screenshot` instead) |
| Input | `{ browser_id: string }` |
| Output | On success: `image/png` content with base64 data |

Internally dispatches as `screenshot`.

##### `browser_get_content`

| Property | Value |
|---|---|
| Description | Get text content of the current page (legacy alias — use `page_read` with `action: "content"` instead) |
| Input | `{ browser_id: string, selector?: string }` |
| Output | Page text content, or content of the element matching `selector` if provided |

Internally dispatches as `page.read({ action: "content", target: selector ? { css: selector } : undefined })`.

##### `browser_select`

| Property | Value |
|---|---|
| Description | Get the currently selected text (legacy alias — use `page_read` with `action: "select"` instead) |
| Input | `{ browser_id: string }` |
| Output | Selected text, or empty string if nothing selected |

Internally dispatches as `page.read({ action: "select" })`.

##### `browser_list_tabs`

| Property | Value |
|---|---|
| Description | List all open tabs in a browser (legacy alias — use `tabs` with `action: "list"` instead) |
| Input | `{ browser_id: string, limit?: number, offset?: number }` |
| Output | Array of tab objects |

Internally dispatches as `tabs` with `action: "list"`.

##### `browser_execute_all`

| Property | Value |
|---|---|
| Description | Execute a tool on ALL connected browsers simultaneously (legacy alias — use `execute_all` instead) |
| Input | `{ tool: string, params?: object }` |
| Output | Array of results, one per browser |

Internally dispatches as `execute_all`.

##### `page_screenshot`

| Property | Value |
|---|---|
| Description | Capture a screenshot of the visible tab — alias under the page API surface (legacy alias — use `screenshot` instead) |
| Input | `{ browser_id: string }` |
| Output | On success: file path where the PNG was saved |

Internally dispatches as `screenshot`.

---

#### 2.13 ActionResult Envelope

Every v2 page interaction tool (`page_read`, `page_act`, `page_js`) returns results in a standard ActionResult envelope. This gives agents clear, structured feedback for every operation.

#### Envelope Shape

```typescript
interface ActionResult {
  success: boolean;
  status: "performed" | "already_in_desired_state" | "not_performed" | "ambiguous" | "blocked";
  action: string;
  message: string;
  targetSummary?: string;
  evidence?: Record<string, unknown>;
  errorCode?: string;
  recoverable?: boolean;
  suggestions?: string[];
  data?: Record<string, unknown>;
}
```

#### Status Semantics

| Status | `success` | Meaning |
|---|---|---|
| `performed` | `true` | The action was executed successfully |
| `already_in_desired_state` | `true` | The action was skipped because the desired state already exists (e.g., checkbox already checked) |
| `not_performed` | `false` | The action could not be performed (e.g., element not found) |
| `ambiguous` | `false` | The action was refused because the target matched multiple elements and the system could not safely choose |
| `blocked` | `false` | The action was blocked (e.g., stale anchor, JavaScript error, security restriction) |

#### Fields

| Field | Always present? | Description |
|---|---|---|
| `success` | Yes | High-level success/failure indicator |
| `status` | Yes | Exact outcome class for programmatic branching |
| `action` | Yes | The action that was attempted (e.g. `"click"`, `"inspect"`) |
| `message` | Yes | Human- and agent-readable description of what happened |
| `targetSummary` | No | Description of what was targeted (anchor ID, CSS selector, semantic target) |
| `evidence` | No | Structured data supporting the outcome (e.g., `matchedCount`, `tag`, `text`) |
| `errorCode` | No | Machine-readable error code for branching (e.g., `AMBIGUOUS_TARGET`, `ANCHOR_STALE`, `JS_EXECUTION_ERROR`) |
| `recoverable` | No | Whether the agent should retry or use an alternative approach |
| `suggestions` | No | Suggested next steps when something fails or is ambiguous |
| `data` | No | Structured payloads (e.g., inspect results, page content) |

#### Known Error Codes

| Code | Meaning |
|---|---|
| `AMBIGUOUS_TARGET` | Multiple elements matched; action aborted to avoid ambiguity |
| `ANCHOR_STALE` | The anchor ID is no longer valid (page changed or navigated) |
| `TARGET_NOT_FOUND` | No element matched the given target |
| `JS_EXECUTION_ERROR` | The JavaScript code failed to execute |
| `MISSING_PARAM` | A required parameter was not provided |

#### Example: Success

```json
{
  "success": true,
  "status": "performed",
  "action": "click",
  "message": "Clicked button 'Save'",
  "targetSummary": "anchor=a1 role=button name=Save",
  "evidence": { "matchedCount": 1, "tag": "button", "text": "Save" }
}
```

#### Example: Ambiguous

```json
{
  "success": false,
  "status": "ambiguous",
  "action": "click",
  "message": "Found 3 matching 'Save' buttons; action aborted",
  "errorCode": "AMBIGUOUS_TARGET",
  "recoverable": true,
  "suggestions": [
    "Run page.read with action=inspect to choose an anchor",
    "Refine the target with a label, testId, or CSS selector"
  ]
}
```

#### Example: Stale Anchor

```json
{
  "success": false,
  "status": "blocked",
  "action": "click",
  "message": "Anchor a1 is no longer valid (stale)",
  "errorCode": "ANCHOR_STALE",
  "recoverable": true,
  "suggestions": [
    "Run page.read with action=inspect to get fresh anchors",
    "Use a semantic target (css, text, role) instead of the stale anchor"
  ]
}
```

---

#### 2.14 Structured Target

Page operations accept a structured target object instead of raw CSS selectors alone. This gives agents safer, more semantic ways to identify elements.

#### Target Shape

```typescript
type Target =
  | { css: string }
  | { text: string }
  | { role: string; name?: string }
  | { label: string }
  | { placeholder: string }
  | { testId: string };
```

#### Resolution Order

When resolving a target to a DOM element, the system tries properties in this order:

1. **`anchor`** (fast path) — pre-resolved CSS selector from inspect anchors. Always preferred when available.
2. **`target.css`** — explicit CSS selector. Direct `document.querySelectorAll()`.
3. **`target.role`** — ARIA role matching (`[role="..." ]`) optionally filtered by `target.name` (aria-label, text content, or value).
4. **`target.label`** — aria-label and aria-labelledby attribute matching.
5. **`target.placeholder`** — placeholder attribute matching.
6. **`target.text`** — text-content substring matching on clickable/focusable elements (`button`, `a`, `input`, `select`, `textarea`, `[role="button"]`, etc.).
7. **`target.testId`** — `data-testid` attribute matching.

#### Ambiguity Handling

- If a target matches exactly one element, the action proceeds.
- If a target matches multiple elements for critical actions (`click`, `submit`, `check`), the action MUST fail with `ambiguous` status and `errorCode: "AMBIGUOUS_TARGET"`.
- For non-critical actions (`fill`, `scroll`, `press`), the first matching element is used.

#### Target + Fields

Operations MAY combine multiple fields in one target object. For example, `{ role: "button", name: "Save" }` first matches by role, then filters by accessible name. When `target.role` and `target.name` are both present, the system:
1. Finds all elements with the matching role.
2. Filters to those whose aria-label, textContent, or value matches `name`.

#### Target Examples

| Target | Matches |
|---|---|
| `{ css: "#submit-btn" }` | Element with id `submit-btn` (explicit CSS) |
| `{ text: "Save" }` | Clickable element containing text "Save" |
| `{ role: "button", name: "Submit" }` | Button with aria-label or text "Submit" |
| `{ label: "Email" }` | Element with aria-label "Email" |
| `{ placeholder: "Enter email" }` | Input with placeholder "Enter email" |
| `{ testId: "login-button" }` | Element with `data-testid="login-button"` |

#### Frame and Shadow DOM Penetration

The target resolver penetrates:
- **Same-origin iframes**: queries are forwarded into `iframe.contentDocument` when accessible.
- **Open shadow roots**: elements inside open shadow roots are included in query results.

Cross-origin iframes are NOT penetrated (security boundary).

---

#### 2.15 Inspect Anchors

Inspect anchors are lightweight, ephemeral references to elements discovered during `page.read({ action: "inspect" })`. They enable fast follow-up actions without repeating target resolution.

#### Anchor Shape

Each anchor in an inspect response contains:

| Field | Description |
|---|---|
| `anchor` | Anchor ID string, e.g. `"a1"`, `"a2"` |
| `role` | ARIA role or tag name |
| `name` | Accessible name (aria-label or text) |
| `label` | aria-label value |
| `placeholder` | placeholder value |
| `text` | Truncated text content (max 100 chars) |
| `tag` | HTML tag name |
| `type` | Input type (for `<input>` elements) |
| `visible` | Whether the element is visible/rendered |
| `enabled` | Whether the element is interactive (not disabled) |
| `checked` | Checked state (for checkboxes/radios) |
| `selected` | Selected state (for `<option>` elements) |
| `target` | Reusable Target object for this element |

#### Anchor Lifecycle

| Event | Effect on Anchors |
|---|---|
| `inspect` called | New anchors generated for current document; previous anchors for this tab are replaced |
| Page navigation | All anchors for the tab are cleared |
| Tab closed | All anchors for the tab are cleared |
| Anchor used in action | No change — anchors persist until invalidated |
| Stale anchor used | Action returns `blocked` with `errorCode: "ANCHOR_STALE"` |

#### Anchor Storage

Anchors are stored per-tab in the extension's service worker memory (not persisted to disk). Each anchor stores:
- The resolved CSS selector for fast lookup
- The `documentId` from the inspect that created it
- The tab ID

#### Staleness Detection

An anchor is considered stale if:
1. The tab has been navigated to a new page (tab anchors cleared).
2. The document epoch has changed (documentId mismatch between the stored anchor and the current inspect session).
3. The anchor's CSS selector no longer matches any element on the page.

When an anchor is stale, the system returns:
```json
{
  "success": false,
  "status": "blocked",
  "errorCode": "ANCHOR_STALE",
  "recoverable": true,
  "suggestions": [
    "Run page.read with action=inspect again",
    "Use a semantic target instead of the stale anchor"
  ]
}
```

#### Preferred Targeting Order

1. **`anchor`** — fastest, least ambiguous; use when available from a recent inspect.
2. **Semantic `target`** — safer than raw CSS; use `role`, `label`, `text`, `testId`.
3. **Raw `css`** — explicit fallback when semantic targeting is insufficient.
4. **`page.js`** — escape hatch only when structured targeting cannot express the task.

---

### 3. REST API

Base path: `/api` (configurable)

#### 3.1 Browser Listing

```
GET /api/browsers
→ 200 { browsers: [{ id, name, capabilities, permissions, connectedAt, lastHeartbeat }] }

GET /api/browsers/:id
→ 200 { id, name, ... }
→ 404 { error: "Browser not found" }
```

#### 3.2 Capabilities

```
GET /api/browsers/:id/capabilities
→ 200 { capabilities: ["tabs.list", "tabs.create", ...] }
```

#### 3.3 Tool Execution

```
POST /api/browsers/:id/execute
Body: { tool: string, params?: object }
→ 200 { browserId, tool, success: boolean, data?, error? }
→ 500 { success: false, error: string }
```

#### 3.4 Execute on All

```
POST /api/execute-all
Body: { tool: string, params?: object }
→ 200 { results: [{ browserId, tool, success, data?, error? }, ...] }
```

#### 3.5 Screenshot Convenience

```
GET /api/browsers/:id/screenshot
→ 200 { base64, format }
→ 500 { error: string }
```

#### 3.6 Health

```
GET /api/health
→ 200 { status: "ok", browsers: <count>, uptime: <seconds> }
```

#### 3.7 CORS

The REST API MUST allow all origins via CORS (`Access-Control-Allow-Origin: *`) to support browser extension and MCP client access.

---

### 4. CLI

The CLI is available via `browserpowers <command>` (or `pnpm run cli -- <command>` during development).

> **Dev mode**: Use `pnpm run cli -- <command>` instead of `browserpowers <command>`.
> For full production installation, see the install script at `scripts/install.mjs`.

#### 4.1 Commands

| Command | Description |
|---|---|
| `list` | List all connected browsers |
| `navigate <browserId> <url>` | Navigate to URL |
| `screenshot <browserId> [filepath]` | Take screenshot, optionally save to file |
| `content <browserId> [selector]` | Get page content (legacy — uses v2 dispatch internally) |
| `select <browserId>` | Get selected text (legacy — uses v2 dispatch internally) |
| `page read <browserId> <action> [params...]` | Execute a page read action |
| `page act <browserId> <action> [params...]` | Execute a page act action |
| `page js <browserId> <code>` | Execute JavaScript on the page |
| `tabs <browserId>` | List tabs |
| `exec <browserId> <tool> [params...]` | Execute any tool with JSON params |
| `exec-all <tool> [params...]` | Execute a tool on all browsers |
| `init` | Run the first-time setup wizard — creates config interactively |
| `mcp-config [--client claude|cursor|generic]` | Generate MCP client configuration snippet |

#### 4.2 CLI vs Server Mode

```
browserpowers serve       # Start the server (default)
browserpowers cli <cmd>   # Run a single CLI command and exit
browserpowers <cmd>       # Implicit CLI mode (auto-detected)
```

If the first argument is not `serve` or `start`, the CLI assumes CLI mode and runs the command directly.

---

### 5. Permission Gates

#### 5.1 Tool Groups and Mapping

Each tool maps to exactly one tool group. Tool groups are organized into two conceptual surfaces: **Browser APIs** (operating on the browser shell — tabs, history, bookmarks, etc.) and **Page APIs** (operating on content loaded inside a tab).

##### 5.1.1 Browser API Tool Groups

These groups control access to browser-level data and operations. They are each independently gated.

| Tool | Group | Description |
|---|---|---|
| `tabs.list`, `tabs.create`, `tabs.close`, `tabs.update` | `tabs` | Tab management |
| `screenshots.capture` | `screenshots` | Visible tab capture (gated independently from page tools) |
| `history.search` | `history.read` | Browsing history read access (default: allow) |
| `history.delete` | `history.delete` | Browsing history delete access (default: ask — prevents silent wipe-all) |
| `bookmarks.list` | `bookmarks.read` | Bookmark read access (default: allow) |
| `bookmarks.create` | `bookmarks.modify` | Bookmark create access (default: ask) |
| `bookmarks.delete` | `bookmarks.delete` | Bookmark delete access (default: ask — prevents accidental deletion) |
| `downloads.list`, `downloads.open` | `downloads` | Download management |
| `network.requests` | `network` | Network request observation |
| `storage.get`, `storage.set` | `storage` | Page-localStorage access |
| `windows.list`, `windows.create`, `windows.focus`, `windows.close` | `windows` | Browser window management |
| `cookies.get`, `cookies.set`, `cookies.remove`, `cookies.list` | `cookies` | HTTP cookie access |

##### 5.1.2 Page API Tool Groups

Page tools are organized into three tool families (v2 API), each gated behind its own permission group. All page tools are implemented under the hood via `chrome.scripting.executeScript`, but the permission gate is on the **declared intent** (what the agent asked for), not the implementation mechanism.

| Tool (internal) | MCP Tool | Group | Risk | Description |
|---|---|---|---|---|
| `page.read` | `page_read` | `page.read` | Low | Unified read tool — action dispatch for inspect, content, text, html, attr, meta, forms, count, select |
| `page.act` | `page_act` | `page.act` | Medium | Unified act tool — action dispatch for click, fill, check, select_option, press, scroll, submit, wait_for |
| `page.js` | `page_js` | `page.execute` | High | Execute arbitrary JavaScript — gated escape hatch (permission group name preserved as `page.execute` for backward compatibility) |

> **Design rationale**: Instead of ~30 individual page tools, v2 collapses them into three tool families (`page.read`, `page.act`, `page.js`) with action dispatch. This reduces MCP surface area while preserving granular behavior. The permission model remains on the tool family level — `page.read` for read-only operations, `page.act` for mutations, `page.execute` for arbitrary code. This allows the user to allow safe reads (`page.read: allow`), permit controlled interaction (`page.act: ask`), while denying arbitrary code execution (`page.execute: deny`). Actions inside each family are not individually gated — the permission is on the tool family, not the action.

> **Backward compatibility**: The legacy MCP aliases `browser_get_content`, `browser_select`, and `browser_screenshot` remain available. `browser_get_content` and `browser_select` now internally dispatch via `page.read({ action: "content" })` and `page.read({ action: "select" })` respectively. `browser_screenshot` maps to `screenshots.capture` (unchanged).

#### 5.2 Permission Levels

| Level | Behavior |
|---|---|
| `allow` | Tool execution proceeds immediately |
| `deny` | Tool execution is blocked; error returned with reason |
| `ask` | Tool execution is paused; core sends `request_approval` to the extension. Extension sets a badge on its icon. User opens the popup or options page and approves or denies the request. On approval, the core executes the tool. On denial or timeout (60s), an error is returned to the caller. |

#### 5.3 Resolution Order

1. If the browser has a permission set for the tool's group, use that
2. Otherwise, use the default permission from core config (`gates.defaultPermission`)
3. If no default is set, use `ask`

#### 5.4 Site-Level Page Permissions

For page tools (`page.read`, `page.act`, `page.execute`), the extension supports per-domain permission overrides that are checked before the global permission profile.

**Site rules** are stored in the extension's `chrome.storage.local` under `pageSitePermissions` and structured as allow/ask/deny lists of domain patterns for each page tool group:

```typescript
type PagePermissionGroup = "page.read" | "page.act" | "page.execute";

interface SitePermissionLists {
  allow: string[];   // e.g. ["*"] for all sites, ["example.com"] for specific
  ask: string[];     // e.g. ["*"] default fallback for unlisted sites
  deny: string[];    // e.g. ["evil.com"]
}
```

**Pattern matching** supports three forms:
- `*` — matches all domains
- `example.com` — exact domain match (after stripping `www.` prefix)
- `*.example.com` — matches domain and all subdomains

**Resolution rules**:
1. Find all patterns in allow/ask/deny lists that match the URL's hostname
2. Pick the most specific match (exact > wildcard > `*`)
3. If equally specific matches conflict, the safest decision wins: deny > ask > allow
4. If no pattern matches, the global permission profile (per §5.1) is used

**Default site rules** at first run:
| Group | Allow | Ask | Deny |
|---|---|---|---|
| `page.read` | `["*"]` | `[]` | `[]` |
| `page.act` | `[]` | `["*"]` | `[]` |
| `page.execute` | `[]` | `["*"]` | `[]` |

The approval flow (`scope: "session"` / `scope: "forever"`) adds matching site patterns when the user approves a page tool request with session or permanent scope. The extension checks site rules before showing an approval prompt — if a matching allow/deny rule exists, it auto-responds without user interaction.

#### 5.5 Unknown Tools

If a tool is not in the mapping table (i.e. it has no known group), the gate MUST allow execution by default. Unknown tools are assumed to be declared capabilities by the extension.

---

### 6. Configuration

#### 6.1 File Location

`~/.config/browserpowers/config.yaml`

Created automatically on first run with default values.

#### 6.2 Schema

```yaml
# Server
port: 4199
host: "127.0.0.1"

# Authentication
auth:
  apiKey: ""          # API key for REST/MCP/WS access. Empty = no auth required.

# MCP endpoint
mcp:
  enabled: true
  path: "/mcp"

# REST API endpoint
rest:
  enabled: true
  path: "/api"

# WebSocket endpoint
ws:
  path: "/ws"
  heartbeatIntervalMs: 30000

# Permission gates
gates:
  defaultPermission: "ask"
  approvalTimeoutMs: 60000  # How long to wait for user approval before auto-denying

# Queue
queue:
  maxDepth: 50       # Max queued requests per browser (reject beyond this)
  defaultTimeoutMs: 120000  # Per-request timeout (can be overridden per call)

# Pre-registered browser configs
browsers:
  # Browser ID (optional — generated on connection for unlisted browsers):
  example-browser-id:
    name: "Work Chrome"
    permissions:
      tabs: allow
      page.read: allow
      page.act: ask
      page.execute: deny
      history.read: allow
      history.delete: ask
      bookmarks.read: allow
      bookmarks.modify: ask
      bookmarks.delete: ask
```

#### 6.3 Config Merging

If a config file exists, it is merged (deep merge) over the default config. Nested sections (`mcp`, `rest`, `ws`, `gates`) are merged deeply. Missing keys fall back to defaults.

---

### 7. Browser Registry

#### 7.1 In-Memory Storage

The core maintains an in-memory registry of all connected browsers. This state is NOT persisted — on core restart, all browsers must reconnect and re-register.

#### 7.2 Registry Entry

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Assigned on registration |
| `name` | string | User-assigned human name |
| `capabilities` | Capability[] | Tools this browser exposes |
| `permissions` | PermissionProfile | Per-group permission settings |
| `connectedAt` | timestamp | When registration occurred |
| `lastHeartbeat` | timestamp | Last heartbeat received |

#### 7.3 Pending Requests

The registry tracks pending tool execution requests with:

- Associated browser ID
- Resolve/reject callbacks
- 30-second timeout timer

If a browser disconnects, all its pending requests MUST be rejected with `"Browser <id> disconnected"`.

---

### 8. Extension Configuration

#### 8.1 Extension Settings

Stored in `chrome.storage.local` under key `settings`:

| Field | Default | Description |
|---|---|---|
| `browserName` | generated unique name | Human-readable name (generated on first init until user overrides it) |
| `coreUrl` | `"ws://127.0.0.1:4199/ws"` | Core WebSocket URL |
| `approvalNotificationsEnabled` | `true` | Show native approval notifications for pending requests |
| `permissions` | see below | Per-group permission levels |

> The same settings and approvals UI is exposed in both the popup and the options page.
> The surfaces are intentionally duplicated for convenience; both read and write the same stored state,
> and only the layout differs between the compact popup and the larger page.

#### 8.2 Default Permissions

```json
{
  "tabs": "allow",
  "page.read": "allow",
  "page.act": "ask",
  "page.execute": "deny",
  "screenshots": "allow",
  "history.read": "allow",
  "history.delete": "ask",
  "bookmarks.read": "allow",
  "bookmarks.modify": "ask",
  "bookmarks.delete": "ask",
  "downloads": "deny",
  "network": "deny",
  "storage": "deny",
  "windows": "allow",
  "cookies": "ask"
}
```

#### 8.3 Capability Filtering

When building the registration message, the extension MUST filter capabilities: any tool whose group has permission `deny` is excluded from the capability list sent to the core. This ensures the core never even sees tools the user has denied.

---

## Data and State Model

### Core State (in-memory, not persisted)

```
Map<browserId, Browser>  — active connections
Map<requestId, PendingRequest>  — requests awaiting extension response
```

### Extension State (persisted in chrome.storage.local)

```
settings -> { browserName, coreUrl, permissions }
browserId -> string  (assigned by core, stored locally)
```

### Configuration (persisted in ~/.config/browserpowers/config.yaml)

```
ServerConfig { port, host, mcp, rest, ws, gates, browsers }
```

---

## Error Handling and Edge Cases

### Connection Failures

| Scenario | Behavior |
|---|---|
| Core unreachable on extension start | Exponential backoff reconnect (1s → 30s cap) |
| Core shuts down while extension connected | Extension detects WebSocket close, begins reconnection |
| Extension disconnects unexpectedly | Core marks browser offline, rejects pending requests |
| Multiple extensions with same name | Allowed — each gets a unique browser ID |

### Tool Execution Errors

| Scenario | Behavior |
|---|---|
| Browser not found | Return `{ success: false, error: "Browser not found" }` |
| Permission denied | Return `{ success: false, error: "Gate: ... (mode: deny)" }` |
| Tool not in capabilities | Return `{ success: false, error: "Tool not in browser's capabilities" }` |
| Extension does not respond | Return timeout error after 30s |
| Malformed JSON from extension | Return `{ type: "error", payload: { message: "Invalid JSON" } }` |

### Edge Cases

| Edge Case | Handling |
|---|---|
| Config file missing | Created with defaults on first server start |
| Config file invalid YAML | Error logged, server falls back to defaults |
| Port already in use | Node.js `EADDRINUSE` error — server fails to start |
| Browser reconnects rapidly | Each connection is fresh; old browser ID is abandoned |
| Heartbeat delayed but within limit | OK — only triggers cleanup after 2× interval |
| Multiple MCP clients | Each gets a separate session via streamable HTTP transport |

---

## Security Considerations

1. **Localhost-only by default.** The core binds to `127.0.0.1:4199` — not exposed to the network. For remote access, the user must explicitly configure `host` and consider SSH tunneling or a VPN.

2. **Permission gates are the security model.** They are enforced at two levels:
   - **Core side**: the Command Service checks the gate before sending any execute command
   - **Extension side**: the extension filters denied capabilities from registration (defense in depth)

3. **Optional API key authentication.** When `auth.apiKey` is set in the configuration, all WebSocket, REST, and MCP connections require the key. REST and MCP accept the key via `Authorization: Bearer <key>` or `X-API-Key: <key>` headers. The browser extension sends the key in its `register` message. The CLI always bypasses authentication. When `auth.apiKey` is empty (default), no authentication is required — suitable for localhost-only deployments.

4. **Sensitive browser data.** History and bookmarks are **read-allowed, write-ask** by default: agents can search history and list bookmarks without approval, but deleting entries or creating bookmarks requires user approval. Downloads are denied by default. The user can tune each group independently in the extension settings.

5. **Code execution risk.** The `page.execute` tool allows arbitrary JavaScript execution in the browser tab. This is gated behind the `page` permission group. Only browsers with `page: allow` can execute JS.

---

## References

### Normative References

- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) — Key words for use in RFCs to Indicate Requirement Levels
- [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455) — The WebSocket Protocol
- [Model Context Protocol](https://modelcontextprotocol.io/) — MCP Specification

### Informative References

- [WXT](https://wxt.dev/) — Next-gen browser extension framework
- [Hono](https://hono.dev/) — Ultralight web framework
- [Commander.js](https://github.com/tj/commander.js) — CLI framework

---

### 9. Authentication

#### 9.1 Overview

Authentication is OPTIONAL. By default, the core server does not require authentication (`auth.apiKey` is empty).

When `auth.apiKey` is set to a non-empty value, all non-CLI interfaces require the API key:

| Interface | Auth mechanism |
|---|---|
| REST | `Authorization: Bearer <key>` or `X-API-Key: <key>` header |
| MCP | `Authorization: Bearer <key>` or `X-API-Key: <key>` header |
| WebSocket | `authKey` field in the `register` message |
| CLI | No auth required (local process) |

#### 9.2 Configuration

```yaml
auth:
  apiKey: ""    # Set to a secret value to enable authentication
```

Default: empty string (auth disabled). The health endpoint (`/api/health`) and server root (`/`) remain publicly accessible regardless of auth configuration.

#### 9.3 WebSocket Auth Flow

```
Extension                     Core (auth.apiKey = "secret")
  │                              │
  │── register(+ authKey) ─────►│  checks authKey
  │                              │  → valid: proceed with registered
  │                              │  → invalid: send auth_required + close
  │                              │
  │◄── registered ──────────────│  (on success)
  │◄── auth_required + close ───│  (on failure)
```

#### 9.4 Extension Integration

The browser extension includes an optional API Key field in its settings UI under the Core Server section. When the extension connects to a core that requires authentication:

1. Extension sends `register` without `authKey` (or wrong key)
2. Core responds with `auth_required` and closes the WebSocket
3. Extension detects the authentication failure and surfaces "API key required" in its connection status
4. User enters the API key in the extension settings
5. Extension reconnects with the key included in the `register` payload
6. Core validates the key and proceeds with normal registration

---

### 10. Execution Modes

#### 10.1 Overview

Every browser has a `commandMode` setting: `sync` (default) or `async`. This determines how tool execution results are delivered to callers. The mode is set per-browser in the config (`execution.commandMode`) and can be overridden per-request via the `mode` parameter on MCP tools or the `--async` flag on the CLI.

#### 10.2 Synchronous Mode (Default)

In synchronous mode, tool execution blocks until the result is received from the browser extension:

```
Caller → execute(browserId, tool, params) → wait → ToolResult
```

The caller receives the full result in a single response. Additionally, sync mode enriches certain operations:

- **Navigate**: After navigation completes, a compact page inspect is automatically run and the snapshot (URL, title, anchors) is included in the response. No separate `snapshot` flag is needed.
- **Page Act**: For mutation actions (click, fill, check, select_option, press, scroll, submit, type, smart_click, fill_form, drag, dblclick, hover), the system captures a before/after inspect snapshot, computes a diff by semantic element identity, and includes the diff in the response. The diff shows what anchors were added, removed, or changed (visibility, enabled state, text, etc.) — giving the agent immediate feedback on what the action did to the page.

Sync mode is the recommended mode for MCP agents because it minimizes round-trips: one call, one rich response.

#### 10.3 Asynchronous Mode

In asynchronous mode, tool execution is fire-and-forget:

```
Caller → executeAsync(browserId, tool, params) → { requestId }
Caller → getResult(requestId) → { status: "pending" | "complete" | "error", result? }
```

The `executeAsync` method enqueues the request and returns immediately with a `requestId`. The caller can poll `getResult(requestId)` at any time. Completed results are held for 5 minutes, then auto-purged.

Async mode is useful for:
- CLI scripting where you don't want to block the terminal
- Long-running operations where the caller wants to do other work
- Batch operations where you fire many commands and collect results later

**Limitation**: Async mode rejects tools gated with `ask` permission — user approval cannot be handled asynchronously.

#### 10.4 Interface Support

| Interface | Sync | Async |
|---|---|---|
| MCP | Default. Add `mode: "async"` to any tool call. | Returns `⏳ Queued as <requestId>. Poll GET /api/results/<requestId>`. |
| REST | `POST /browsers/:id/execute` | `POST /browsers/:id/execute-async` → `GET /results/:requestId` |
| CLI | Default for all commands. | `--async` global flag on all commands. |
| WebSocket | `execute` message includes `commandMode` field. | Extension does not distinguish — always executes and returns result; mode only affects how core delivers to caller. |

#### 10.5 Auto-Snapshot and Post-Action Diff (Sync Mode Only)

**Navigate auto-snapshot**: When `commandMode` is `sync`, `tabs.navigate` automatically runs a compact inspect (limit=30 elements) after page load completes. The response includes `{ tabId, navigated, url, elapsed_ms, snapshot: { url, title, documentId, anchors: [...] } }`. The manual `snapshot` parameter is still accepted but redundant.

**Post-action diff**: When `commandMode` is `sync`, mutation actions in `page.act` capture the page state before and after the action, then compute a diff:

```json
{
  "diff": {
    "urlChanged": false,
    "titleChanged": false,
    "documentIdChanged": false,
    "anchorsAdded": [{ "role": "alert", "name": "Success", ... }],
    "anchorsRemoved": [],
    "anchorsChanged": [
      { "key": "button|Submit|button|Submit", "changes": { "enabled": { "from": true, "to": false } } }
    ]
  }
}
```

Elements are matched across snapshots by **semantic key**: `${role ?? tag}|${name ?? ""}|${tag}|${text ?? ""}`. This survives page mutations that change DOM structure or CSS paths as long as the semantic identity remains stable. The diff detects field-level changes: `visible`, `enabled`, `checked`, `selected`, and `text`.

Non-mutation actions (`wait_for`, `dialog_override`, `dialog_respond`, `upload`) skip the diff. Failed actions skip the post-inspect entirely.
