---
node_type: architecture
title: BrowserPowers — Core Server Architecture
status: active
updated: 2026-06-11
tags: [core, architecture, nodejs, hono, websocket]
links:
  depends_on: [../overview/product.md, ../spec/spec.md]
  documents: [../../core/]
  implemented_by: [../../core/src/]
---

# BrowserPowers — Core Server Architecture

## Overview

The core server (`core/`) is a Node.js process that hosts four interfaces (MCP, REST, CLI, WebSocket) connected through a unified Command Service. It is the central coordination point: it routes agent commands to connected browser extensions, enforces permission gates, and provides observability.

**Package name**: `browserpowers`  
**Entry point**: `src/index.ts`  
**Runtime**: Node.js >= 18  
**Framework**: Hono (HTTP), ws (WebSocket), Commander (CLI), MCP SDK  

---

## Scope Boundary

| Direction | Boundary |
|---|---|
| **Owns** | HTTP server, WebSocket server, MCP server, CLI interface, browser registry, permission gates, configuration |
| **Does not own** | Browser API execution (delegated to extension), local browser state (history, settings), chat history (lives in extension) |
| **Boundary interfaces** | Receives WebSocket connections from browser extensions; receives MCP/REST/CLI calls from agents; sends commands to extensions over WebSocket |
| **External dependencies** | `hono`, `ws`, `commander`, `@modelcontextprotocol/sdk`, `zod`, `yaml` |

---

## Components

### 1. Entry Point (`src/index.ts`)

Determines the run mode:

- **Serve mode** (default): starts the HTTP+WebSocket server
- **CLI mode**: runs a single command via Commander and exits

In serve mode, it creates a raw Node.js HTTP server and attaches both the Hono app (for REST + MCP) and the WebSocket server to it. This avoids port conflicts and allows the WebSocket upgrade to share the same port.

### 2. Server (`src/server.ts`)

Creates the Hono application with:

- **CORS middleware**: allows all origins (required for MCP streamable HTTP and extension access)
- **Health endpoint** (`GET /`): returns server name, version, docs link
- **REST API mount** (at `/api`): delegation to `adapters/rest.ts`
- **MCP server mount** (at `/mcp`): delegation to `adapters/mcp.ts`

### 3. WebSocket Server (`src/ws-server.ts`)

Manages all browser extension connections:

- Listens on a configurable path (default `/ws`)
- Uses HTTP upgrade interception (shares the same HTTP server as Hono)
- Maintains an in-memory `Map<browserId, WebSocket>` for active connections
- Handles message types: `register`, `result`, `error`, `heartbeat`, `approval_response`
- Sends message types: `execute`, `request_approval`, `config_updated`
- Broadcast utility (`sendToExtension`, `broadcastToExtensions`) for pushing commands to browsers
- Heartbeat interval: checks for stale connections every 30s, removes browsers with no heartbeat for >60s

### 4. Registry (`src/registry.ts`)

Singleton that maintains the state of all connected browsers:

- `Map<browserId, Browser>` — registered browsers
- `Map<requestId, QueuedItem>` — tool execution requests awaiting extension response (fast lookup)
- `Map<browserId, string[]>` — per-browser ordered FIFO queues of request IDs
- `Set<browserId>` — currently busy browsers (one in-flight at a time)
- `Map<requestId, PendingApproval>` — requests awaiting user approval (gate: ask)
- `Map<requestId, ToolResult>` — completed results (async mode, 5-min TTL)
- Methods: `register`, `unregister`, `heartbeat`, `list`, `get`, `enqueue`, `dequeue`, `resolveRequest`, `rejectRequest`, `rejectAllForBrowser`, `setBusy`, `clearBusy`, `isBusy`, `queuedCount`, `findStale`, `queueApproval`, `resolveApproval`, `storeResult`, `getResult`
- Requests are enqueued per-browser and drained via `tryDrain()` in the WebSocket server on register/result/error
- Browser busy flag prevents concurrent execution — only one request at a time per browser
- On browser disconnect, all queued + pending execution and approval requests for that browser are rejected via `rejectAllForBrowser()`

### 5. Gate Middleware (`src/gates/middleware.ts`)

Enforces permission profiles before tool execution:

- Maps each tool name to a tool group via a static lookup table
- Resolves the permission level (browser profile → config default)
- Returns gate result: `{ allowed, mode, reason? }`
- Modes: `allow` → proceed, `deny` → blocked, `ask` → trigger approval flow

### 6. Command Service (`src/command-service/service.ts`)

The **single implementation** of all browser operations. All three adapters (REST, MCP, CLI) call into this:

- `listBrowsers()` — returns all connected browsers with capabilities
- `execute(browserId, tool, params)` — sends a command to one browser, waits for result (sync)
- `executeAsync(browserId, tool, params)` — fire-and-forget: enqueues command, returns `{ requestId }` immediately (async)
- `getResult(requestId)` — polls for a completed async result; returns `{ status: "pending" | "complete" | "error", result? }`
- `executeAll(tool, params)` — sends a command to all browsers, collects all results
- `getCapabilities(browserId)` — returns a browser's available tools
- `isConnected(browserId)` — checks if a browser is connected

The flow for `execute`:

1. **Lookup** browser in registry
2. **Gate check** permissions
   - If `deny`: return error immediately
   - If `ask`: enter **approval flow** (see below)
3. **Capability check** that the tool is declared
4. **Enqueue** request in registry (`registry.enqueue()`) with configurable timeout (default 120s, from `timeout_ms` param or `queue.defaultTimeoutMs`)
5. **Drain** — call `tryDrain(browserId)` which dequeues and sends the next item if browser is connected and not busy
6. **Wait** for result or error (via the Promise returned by `enqueue`)
7. **Return** result to caller

The WebSocket server's `tryDrain()` function sends the next queued item to the browser, sets the busy flag, and after each result/error calls `tryDrain()` again to process the next item in the queue. This creates a sequential pipeline: each browser processes requests one at a time in FIFO order. The `execute` WebSocket message now includes the browser's `commandMode` field so the extension can decide whether to enrich responses (auto-snapshot on navigate, post-action diff on page.act).

### 6b. Execution Modes

Every browser carries a `commandMode` setting (`"sync"` | `"async"`, default `"sync"`). This is set in the config (`execution.commandMode`) and stored in the registry per-browser. The mode can be overridden per-request via MCP's `mode` parameter, REST's `/execute-async` endpoint, or CLI's `--async` flag.

**Sync mode** (default): `execute()` blocks until the extension returns a result. For `tabs.navigate`, the extension auto-includes a compact page inspect snapshot in the response. For `page.act` mutation actions, the extension captures before/after snapshots and computes a semantic diff showing what changed.

**Async mode**: `executeAsync()` enqueues the request and returns `{ requestId }` immediately. The caller polls `getResult(requestId)` for the result. Completed results are held in the registry for 5 minutes then auto-purged. Async mode rejects `ask`-gated tools (user approval cannot be handled asynchronously).

### 6c. Snapshot Diff (`core/src/snapshot-diff.ts`)

A utility that compares two page inspect snapshots by **semantic key** (`${role ?? tag}|${name ?? ""}|${tag}|${text ?? ""}`) rather than by anchor ID (which is regenerated every inspect). Returns `{ urlChanged, titleChanged, anchorsAdded, anchorsRemoved, anchorsChanged }`. Used by the extension to produce post-action diffs in sync mode. A matching copy lives in `extension/src/v2/snapshot-diff.ts` for use in the service worker context.

The approval flow when gate returns `ask`:

1. **Send** `request_approval` to extension via WebSocket with `{ requestId, tool, params, description }`
2. **Queue approval** in registry (60s timeout)
3. **Wait** for `approval_response` from extension
4. On **approved**: proceed to step 3 (capability check → execute)
5. On **denied**: return `{ success: false, error: "User denied approval" }`
6. On **timeout**: return a timeout-specific error distinct from rejection

### 7. Configuration (`src/config.ts`)

- File location: `~/.config/browserpowers/config.yaml`
- Auto-created with defaults on first run
- Loaded on startup, cached in memory
- Config sections: server (port, host), mcp, rest, ws, gates (including `approvalTimeoutMs`), browsers

### 8. REST Adapter (`src/adapters/rest.ts`)

HonoRouter exposing:

| Method | Path | Description |
|---|---|---|
| GET | `/browsers` | List all connected browsers |
| GET | `/browsers/:id` | Get specific browser |
| GET | `/browsers/:id/capabilities` | Get browser capabilities |
| POST | `/browsers/:id/execute` | Execute a tool on one browser (sync) |
| POST | `/browsers/:id/execute-async` | Execute a tool on one browser (async, returns requestId) |
| POST | `/execute-all` | Execute a tool on all browsers |
| GET | `/browsers/:id/screenshot` | Screenshot convenience endpoint |
| GET | `/results/:requestId` | Poll for async execution result |
| GET | `/health` | Server health |

### 9. MCP Adapter (`src/adapters/mcp.ts`)

Model Context Protocol server using streamable HTTP transport:

**Browser-level tools** (11 tools total):
- `browsers` — list connected browsers (replaces `browser_list`)
- `screenshot` — capture screenshot (replaces `browser_screenshot`)
- `tabs` — list, navigate, goBack, goForward, close tabs (replaces `browser_navigate`, `browser_list_tabs`)
- `execute_all` — execute tool on all browsers (replaces `browser_execute_all`)
- `execute_batch` — execute multiple tools across browsers in parallel

**v2 Page interaction tools**:
- `page_read` — unified read tool with action dispatch (inspect, content, text, html, attr, meta, forms, count, select, summary, generate_selector)
- `page_act` — unified act tool with action dispatch (click, fill, check, select_option, press, scroll, submit, wait_for, type, smart_click, fill_form, upload, drag, dblclick, hover, dialog_override, dialog_respond)
- `page_js` — JavaScript execution escape hatch (gated behind `page.execute` group)

**Browser state tools**:
- `cookies` — consolidated cookie management (get, set, remove, list)
- `windows` — consolidated window management (list, create, focus, close)

**Meta tool**:
- `help` — full system reference and workflow guides

- Session management via `Map<sessionId, Transport>`
- Supports multiple simultaneous MCP clients
- Uses `zod` for input schema validation

### 10. CLI Adapter (`src/adapters/cli.ts`)

Commander.js program with commands:

- `list`, `navigate <id> <url>`, `screenshot <id> [file]`, `content <id> [selector]`, `select <id>`, `page read <id> <action> [params...]`, `page act <id> <action> [params...]`, `page js <id> <code>`, `tabs <id>`, `exec <id> <tool> [params...]`, `exec-all <tool> [params...]`
- All CLI commands are thin wrappers that call the REST API internally

### 11. Auth Middleware (`src/auth.ts`)

Exports shared auth utilities:

- `isAuthRequired()` — returns true when `auth.apiKey` is non-empty
- `validateApiKey(key)` — validates a key against the configured API key

Used by:
- `server.ts` — Hono middleware that guards REST and MCP routes (skips health and root)
- `ws-server.ts` — checks `authKey` in the extension `register` message

---

## Data Models / Storage

### In-Memory State (Registry)

```typescript
interface Browser {
  id: string;                  // UUID
  name: string;                // Human-readable
  capabilities: Capability[];  // Declared tools
  permissions: PermissionProfile;
  connectedAt: number;         // Date.now()
  lastHeartbeat: number;       // Date.now()
}

interface PendingRequest {
  resolve: (result: ToolResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
```

### Persistent State (Config)

- File: `~/.config/browserpowers/config.yaml`
- Schema: includes `port`, `host`, `mcp`, `rest`, `ws`, `gates`, `browsers`
- Created on first run if missing

### No Database

The core has no database dependency. All runtime state is in-memory. Persisting browser state or history is intentionally the extension's responsibility.

---

## Relationships and Flow

### Agent → Core → Browser (Tool Execution)

```
Agent                             Core                              Extension
  │                                 │                                  │
  │── MCP/REST/CLI ──────────────► │                                  │
  │    execute(browserId, tool)    │                                  │
  │                                 │── gate check (permissions) ──►  │
  │                                 │── capability check ───────────►  │
  │                                 │                                  │
  │                                 │── WebSocket execute ──────────►  │
  │                                 │    { requestId, tool, params }  │
  │                                 │                                  │── chrome.* API call
  │                                 │                                  │
  │                                 │◄── WebSocket result/error ──────│
  │                                 │    { requestId, data }          │
  │                                 │                                  │
  │◄──── MCP/REST/CLI response ────│                                  │
  │    { success, data, error }    │                                  │
```

### Startup Sequence

```
Core starts → load config → create Hono app → mount REST + MCP
  → create HTTP server → attach WebSocket → listen on port
  → CLI available for commands

Extension loads → init service worker → ws-client.connect()
  → WebSocket opens → send register → receive registered(browserId)
  → start heartbeat timer → ready for commands
```

---

## Dependencies

### Runtime

| Package | Purpose | Confidence |
|---|---|---|
| `hono` ^4.12 | HTTP framework (REST + MCP) | High |
| `@hono/node-server` ^2.0 | Node.js adapter for Hono | High |
| `ws` ^8.20 | WebSocket server | High |
| `@modelcontextprotocol/sdk` ^1.29 | MCP server implementation | Medium (protocol evolving) |
| `commander` ^14.0 | CLI framework | High |
| `zod` ^4.4 | Schema validation (MCP input) | High |
| `yaml` ^2.8 | Config file parsing | High |

### Dev

| Package | Purpose |
|---|---|
| `tsx` ^4.21 | TypeScript execution (dev mode) |
| `typescript` ^6.0 | Type checking |
| `@types/node`, `@types/ws` | Type definitions |
| `rimraf` ^6.0 | Clean build artifacts |

---

## Contracts / Invariants

| Invariant | Description |
|---|---|
| **Same-port HTTP+WS** | HTTP and WebSocket MUST share a single TCP port. The HTTP server handles Hono routes; the WebSocket upgrade interceptor handles `/ws`. |
| **No shared state with extension** | The core MUST NOT assume it knows an extension's local settings. It only knows what the extension declares in its `register` message. |
| **Gate before execute** | Every tool execution MUST pass through the gate check before being sent to the extension. |
| **Request uniqueness** | `requestId` format is `${browserId}:${uuid}` to guarantee global uniqueness. |
| **Timeout all requests** | Every pending request MUST have a timeout. Default: 120 seconds (configurable via `queue.defaultTimeoutMs` or per-call `timeout_ms`). |
| **Singleton registry** | The registry is a singleton module-level export. Exactly one instance exists per process. |
| **Config is optional** | The server MUST start even if config file is missing or corrupt (fall back to defaults). |
| **Auth is optional** | When `auth.apiKey` is empty, all interfaces are unauthenticated. When non-empty, REST, MCP, and WebSocket all require the key. CLI always bypasses. |

---

## Configuration / Operations

### Runtime Configuration

| Env / File | Field | Default |
|---|---|---|
| config.yaml | `port` | 4199 |
| config.yaml | `host` | 127.0.0.1 |
| config.yaml | `mcp.enabled` | true |
| config.yaml | `mcp.path` | /mcp |
| config.yaml | `rest.enabled` | true |
| config.yaml | `rest.path` | /api |
| config.yaml | `ws.path` | /ws |
| config.yaml | `ws.heartbeatIntervalMs` | 30000 |
| config.yaml | `gates.defaultPermission` | ask |
| config.yaml | `auth.apiKey` | "" (empty) |

### Startup

```bash
# Development (auto-restart on changes)
pnpm dev:core            # tsx watch src/index.ts

# Production
pnpm build               # tsc
pnpm start               # node dist/index.js

# CLI mode
pnpm run cli -- list
```

### Shutdown

- `SIGINT` / `SIGTERM`: close HTTP server, exit(0)
- WebSocket connections are closed by OS on process exit

### Observability

- All message types and significant events are logged to stdout with `[ws]`, `[rest]`, `[mcp]`, `[core]` prefix
- Health endpoint (`GET /api/health`) reports connected browser count and uptime
- No structured logging or metrics sink (future concern)

---

## Design Decisions

| Decision | Rationale | Confidence |
|---|---|---|
| **Shared HTTP + WebSocket port** | Simpler deployment, no CORS issues, single port to configure | High |
| **In-memory registry, no DB** | Browser state is ephemeral by nature; persistence adds complexity without value at this stage | High |
| **CommandService as single implementation** | All adapters call the same business logic; zero duplication of routing/permission/error logic | High |
| **Permission gates on core, not just extension** | Defense in depth — the core never even sends a command if the gate blocks it | High |
| **Config in ~/.config/browserpowers/** | Follows XDG convention; versionable, shareable, no GUI needed | Medium |
| **MCP as primary agent interface** | MCP is the emerging standard for AI tool access; REST and CLI are secondary for scripting/humans | Medium |
| **Heartbeat-based staleness** | Simpler than pings; 30s interval is generous enough for browser wake-from-sleep scenarios | High |

---

## Implementation Pointers

- Entry: `core/src/index.ts`
- Server: `core/src/server.ts`
- WebSocket: `core/src/ws-server.ts`
- Registry: `core/src/registry.ts`
- Gates: `core/src/gates/middleware.ts`
- Command Service: `core/src/command-service/service.ts`, `core/src/command-service/interface.ts`
- Adapters: `core/src/adapters/rest.ts`, `core/src/adapters/mcp.ts`, `core/src/adapters/cli.ts`
- Config: `core/src/config.ts`
- Types: `core/src/types.ts`
