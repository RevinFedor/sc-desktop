---
node_type: spec
title: BrowserPowers — Behavioral Specification (old format)
status: deprecated
updated: 2026-06-11
tags: [spec, deprecated]
links:
  supersedes: [../spec/spec.md]
---

# BrowserPowers — Behavioral Specification

> **DEPRECATED**: This document is preserved for history. The current version lives at [docs/spec/spec.md](../spec/spec.md).

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

*Full content preserved at original file location. See [docs/spec/spec.md](../spec/spec.md) for the current version.*
