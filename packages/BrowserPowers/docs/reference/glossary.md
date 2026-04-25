---
node_type: reference
title: Glossary
status: active
updated: 2026-06-11
tags: [reference, glossary, terminology]
links:
  depends_on: [../overview/product.md]
---

# Glossary

## Core
The central Node.js server that exposes MCP, REST, and CLI interfaces and orchestrates commands to browser extensions. It hosts the command service, permission gates, browser registry, and WebSocket server.

## Extension
The browser extension (Manifest V3) installed in each real browser. It maintains a WebSocket connection to the core and executes `chrome.*` API calls on demand. Built with WXT.

## Browser ID
A UUID assigned by the core when an extension registers. Used to address commands to a specific browser instance.

## Capability
A single tool a browser extension exposes, e.g. `tabs.list`, `page.read`, `screenshots.capture`. Each capability belongs to a tool group.

## Tool Group
A category of related capabilities, e.g. `tabs`, `page.read`, `page.act`, `page.execute`, `screenshots`, `history.read`, `history.delete`, `bookmarks.read`, `cookies`, `windows`. Permission gates operate at the tool group level.

## Permission Profile
A per-browser map of tool group → permission level (`allow`, `ask`, or `deny`).

## Gate
The middleware (on both core and extension) that checks a permission profile before allowing tool execution. Returns one of: `allow` (proceed), `deny` (blocked), `ask` (trigger user approval).

## Registry
The core's in-memory store of all connected browsers, their capabilities, permissions, and pending requests. Singleton per process.

## MCP (Model Context Protocol)
The primary agent-facing interface. An emerging standard for AI tool access. BrowserPowers exposes its full tool surface via an MCP server using streamable HTTP transport.

## Command Service
The unified internal interface that all three adapters (MCP, REST, CLI) call into. The single implementation of all browser operations — list, execute, execute-all.

## ActionResult
A structured result envelope returned by all v2 page interaction tools. Contains `success`, `status`, `action`, `message`, and optional `evidence`, `errorCode`, `suggestions`, and `data` fields.

## Anchor
A lightweight, ephemeral reference to a DOM element discovered during `page.read({ action: "inspect" })`. Format: `a1`, `a2`, etc. Anchors enable fast follow-up actions without repeating target resolution.

## Structured Target
A semantic identification object for DOM elements, supporting `css`, `text`, `role`, `label`, `placeholder`, and `testId` matchers. Used by `page.read` and `page.act`.

## WXT
A next-gen cross-browser extension framework used to build the BrowserPowers extension. Supports Chrome (MV3) and Firefox with shared source.

## Hono
An ultralight web framework used by the core server for REST and MCP HTTP handling.

## Site Permission Rules
Per-domain allow/ask/deny overrides for page tools (`page.read`, `page.act`, `page.execute`), stored in the extension's `chrome.storage.local`. More specific than the global permission profile.
