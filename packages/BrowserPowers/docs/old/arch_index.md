---
node_type: index
title: BrowserPowers — Architecture Index (old format)
status: deprecated
updated: 2026-06-11
tags: [architecture, deprecated]
links:
  supersedes: [../architecture/INDEX.md]
---

# BrowserPowers — Architecture Index

> **DEPRECATED**: This document is preserved for history. The current version lives at [docs/architecture/INDEX.md](../architecture/INDEX.md).

## Overview

BrowserPowers is split into two independently buildable and runnable components: the **Core Server** and the **Browser Extension**. They communicate exclusively over a WebSocket JSON protocol. No shared runtime — each runs in its own process (or, for the extension, inside the browser).

## Components

| File | Description |
|---|---|
| [arch_core.md](arch_core.md) | Node.js server: Hono HTTP, WebSocket server, MCP endpoint, Command Service, Registry, Gates, CLI |
| [arch_extension.md](arch_extension.md) | WXT-based browser extension: service worker, WebSocket client, capability router (chrome.* API bridge), v2 page interaction modules (page-read, page-act, page-js, inspector, target-resolver, anchor-manager), storage, shared popup/options UI |

## Decision Records

| File | Description |
|---|---|
| [decisions/ADR-001-page-interaction-api-v2.md](decisions/ADR-001-page-interaction-api-v2.md) | Accepted decision for the next page interaction API model: `page.read` / `page.act` / `page.js`, structured targets, inspect anchors, and agent-friendly result envelopes |

## Boundary Rules

- The core **never** imports or depends on the extension's source. It knows the extension only through the WebSocket protocol.
- The extension **never** imports or depends on the core's source. It knows the core only through the WebSocket protocol.
- Shared types (message shapes, permission models) are duplicated across both packages by convention, not by shared module.
- The core's `registry.ts` is the single source of truth for connected browser state.
- The extension's `chrome.storage.local` is the single source of truth for per-browser settings (name, permissions, core URL).
