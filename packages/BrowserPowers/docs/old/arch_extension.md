---
node_type: architecture
title: BrowserPowers — Browser Extension Architecture (old format)
status: deprecated
updated: 2026-06-11
tags: [extension, architecture, deprecated]
links:
  supersedes: [../architecture/extension.md]
---

# BrowserPowers — Browser Extension Architecture

> **DEPRECATED**: This document is preserved for history. The current version lives at [docs/architecture/extension.md](../architecture/extension.md).

## Overview

The browser extension (`extension/`) is a thin bridge that connects a real browser to the BrowserPowers core. It runs as a Manifest V3 service worker, maintains a persistent WebSocket connection to the core, and maps incoming tool commands to `chrome.*` API calls.

**Package name**: `browserpowers-extension`  
**Framework**: [WXT](https://wxt.dev/) (cross-browser extension tooling)  
**Targets**: Chrome MV3 (primary), Firefox (via WXT)  
**Runtime**: Browser extension service worker (not Node.js)  

---

*Full content preserved at original file location. See [docs/architecture/extension.md](../architecture/extension.md) for the current version.*
