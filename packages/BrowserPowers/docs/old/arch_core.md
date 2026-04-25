---
node_type: architecture
title: BrowserPowers — Core Server Architecture (old format)
status: deprecated
updated: 2026-06-11
tags: [core, architecture, deprecated]
links:
  supersedes: [../architecture/core.md]
---

# BrowserPowers — Core Server Architecture

> **DEPRECATED**: This document is preserved for history. The current version lives at [docs/architecture/core.md](../architecture/core.md).

## Overview

The core server (`core/`) is a Node.js process that hosts four interfaces (MCP, REST, CLI, WebSocket) connected through a unified Command Service. It is the central coordination point: it routes agent commands to connected browser extensions, enforces permission gates, and provides observability.

**Package name**: `browserpowers`  
**Entry point**: `src/index.ts`  
**Runtime**: Node.js >= 18  
**Framework**: Hono (HTTP), ws (WebSocket), Commander (CLI), MCP SDK  

---

*Full content preserved at original file location. See [docs/architecture/core.md](../architecture/core.md) for the current version.*
