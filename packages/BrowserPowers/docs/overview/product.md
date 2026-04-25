---
node_type: overview
title: BrowserPowers — Product Overview
status: active
updated: 2026-06-11
tags: [product, overview, browser-automation, ai-agents]
links:
  documents: [../../core/, ../../extension/]
  depends_on: [../reference/glossary.md]
---

# BrowserPowers — Product Overview

## Overview

BrowserPowers is a **central command server for multi-browser AI agent control.**

Instead of ephemeral, headless browser automation (Playwright, Puppeteer, Selenium), each of your real browsers runs a lightweight extension that connects to the core server over WebSocket. Agents interact with the core via MCP, REST, or CLI — and every command executes inside a real browser you can see, touch, and trust.

**The core promise:** your AI agents navigate the same browsers you use every day. Not a headless simulacrum. Not a fleeting session. Your actual Chrome, your actual Firefox, with your actual logged-in sessions, extensions, and cookies.

---

## Core Capabilities

| Capability | Description |
|---|---|
| **Multi-browser** | Connect any number of browsers (Chrome, Firefox, etc.) to one core. Each is an independent identity. |
| **Permission gates** | Per-browser permissions with simple global controls for browser powers and site-pattern controls for page powers. Users can allow, ask, or deny agents. |
| **MCP-first** | Full Model Context Protocol server — agents in Claude Desktop, Cursor, and any MCP client can command your browsers directly. |
| **Sync & Async modes** | Per-browser execution mode: sync returns rich results with auto-snapshot and post-action diffs in one call; async is fire-and-forget with deferred result polling. |
| **REST API** | HTTP endpoints for browser management and tool execution — integrate from any language. |
| **CLI** | `browserpowers list`, `navigate`, `screenshot`, `content` — scriptable from your terminal. |
| **Shared brain** | Agent presets, system prompts, skills, and MCP definitions live on the core. Browsers just toggle what they enable locally. |
| **LLM routing** | Every LLM call passes through the core: logged, inspectable, routable. One API key for all browsers. |
| **External agent control** | Your coding agent (Cline, Aider, etc.) can command any browser through MCP or the API. |
| **Optional API key authentication** | Secure the core server with an API key. REST/MCP/WS require the key; CLI bypasses. Default: no auth. |

---

## Main User Flows

### 1. Set up the core

```bash
# Install and start the core server
pnpm dev:core
# Core listens on localhost:4199 — HTTP, WebSocket, and MCP

> **Optional**: You can set an API key in `~/.config/browserpowers/config.yaml` under `auth.apiKey`. When set, all REST, MCP, and WebSocket connections will require this key. The browser extension will prompt you for the key in its settings UI.
```

### 2. Install the extension

Open each browser, load the extension unpacked, configure:
- A friendly name (auto-generated on first run, editable later)
- The core WebSocket URL
- Permission levels per capability group

The extension auto-connects. Each browser registers its capabilities with the core.

### 3. An agent takes control

**Via MCP (Claude Desktop, Cursor, any MCP client):**

```
User asks: "What's on my second browser's screen?"
Agent calls: browsers → finds "Research Firefox"
Agent calls: screenshot(browser_id="...")
→ Returns a screenshot of that browser's active tab
```

**Via CLI:**

```bash
browserpowers navigate "Work Chrome" "https://example.com"
browserpowers screenshot "Work Chrome" "./screenshot.png"
browserpowers content "Research Firefox"
```

> **Dev mode**: Use `pnpm run cli -- <command>` instead of `browserpowers <command>`.
> For full production installation, see the install script at `scripts/install.mjs`.

**Via REST API:**

```bash
curl -X POST http://localhost:4199/api/browsers/:id/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-api-key>" \
   -d '{"tool": "page.read", "params": {"action": "content"}}'
```

### 4. Multi-browser workflows

```bash
# Run a command on ALL connected browsers at once
browserpowers exec-all screenshots.capture
# → Returns screenshots from every browser in one call
```

---

## System Shape

```
┌──────────────────────────────────────────────────┐
│                   Core Server                     │
│  ┌─────────┐  ┌──────────┐  ┌─────────────────┐  │
│  │  MCP    │  │  REST    │  │  CLI (Commander) │  │
│  │  Server │  │  (Hono)  │  │                  │  │
│  └────┬────┘  └────┬─────┘  └────────┬────────┘  │
│       │            │                 │           │
│       └──────┬─────┴─────────────────┘           │
│              │                                    │
│       ┌──────▼──────┐                             │
│       │  Command    │                             │
│       │  Service    │                             │
│       └──────┬──────┘                             │
│              │                                    │
│       ┌──────▼──────┐  ┌──────────────────┐      │
│       │  Registry   │  │  Gates/Perms     │      │
│       └──────┬──────┘  └──────────────────┘      │
│              │                                    │
│       ┌──────▼──────┐                             │
│       │  WebSocket  │                             │
│       │  Server     │                             │
│       └──────┬──────┘                             │
└──────────────┼────────────────────────────────────┘
               │  WebSocket (JSON)
      ┌─────────┼──────────┐
      │         │          │
┌────▼───┐ ┌──▼────┐ ┌──▼────┐
│ Chrome │ │Firefox│ │ Safari│ ...
│ Ext.   │ │ Ext.  │ │ Ext.  │
└────────┘ └───────┘ └───────┘
  Real browser   Real browser
```

---

## Extension Permissions

The browser extension requires the following permissions for its operation:

| Permission | Reason |
|---|---|
| `tabs` | List, create, navigate, close tabs |
| `cookies` | Get, set, remove cookies |
| `history` | Search and delete browsing history |
| `bookmarks` | List, create, delete bookmarks |
| `downloads` | List and open downloads |
| `webRequest` | Observe network requests |
| `<all_urls>` | Execute page operations (inspect, click, fill) on any site |
| `storage` | Page localStorage access |

---

## Non-Goals

- **Not a replacement for Playwright/Puppeteer in CI/CD.** If you need ephemeral browser automation for testing, use the tools built for that. BrowserPowers is for persistent, real-user browsers.
- **Not a cloud-hosted browser farm.** The initial architecture runs on localhost. An enterprise deployment can move the core to a server, but that's a deployment choice, not a product requirement.
- **Not a general-purpose RPA tool.** BrowserPowers is purpose-built for AI agent browser control with permission gates and observability — not for macro recording or form-filling scripts.
- **Not a standalone LLM client.** The extension renders chat, but the LLM brains (presets, prompts, skills) live on the core. This is not a ChatGPT-in-a-browser product.

---

## Target Users

- **AI power users** who want their coding agents to control real browsers with safety boundaries.
- **Developers** building agentic workflows that need persistent, logged-in browser sessions.
- **Organizations** that want centrally managed, permission-gated browser access for AI agents.
- **Anyone tired of "the browser agent can't handle this page because Playwright doesn't support it."**

---

## Design Principles

1. **Real browsers, always.** No headless proxies, no HTML-to-text pipelines. The browser extension IS the browser API bridge.
2. **Identities, not sessions.** Each browser is a first-class participant with its own configuration, permissions, and history.
3. **Permission gates at the browser.** The core never bypasses a browser's permission profile — the extension enforces locally what it exposes.
4. **Observability by default.** Every command, every result, every error is logged at the core. You can always see what happened and when.
5. **One protocol to rule them.** MCP is the primary interface for agents. REST and CLI exist for scripting and debugging.

---

## Roadmap (suggested)

| Phase | Focus |
|---|---|
| 0 | Core server + extension skeleton, WebSocket protocol, basic REST |
| 1 | MCP server with browser tools, CLI, permission gates |
| 2 | LLM routing, shared agent presets, skills/MCP catalogue |
| 3 | Headless core agent, multi-browser orchestration, popup/settings UI |
| 4 | Observability dashboard, org deployment mode |
