---
node_type: index
updated: 2026-06-11
---

# Documentation Index

## Overview
This is the canonical documentation for BrowserPowers — a central command server for multi-browser AI agent control. Docs are organized into layers following the ontology: overview (why), spec (what), architecture (how).

## Layers

### overview/ — Product Identity
Why this product exists, who it serves, what it does.
- [product.md](overview/product.md) — Elevator pitch, core capabilities, non-goals, target users 🟢
- [INDEX.md](overview/INDEX.md) — Full overview index

### spec/ — Behavioral Specification
What the system must do, exactly, in BDD+RFC format.
- [spec.md](spec/spec.md) — Complete behavioral specification: WebSocket protocol, MCP tools, REST API, CLI, permissions, configuration, auth, error handling 🟢
- [INDEX.md](spec/INDEX.md) — Full spec index

### architecture/ — Implementation Structure
How the current implementation realizes the spec.
- [core.md](architecture/core.md) — Core server architecture: Hono HTTP, WebSocket, MCP, Command Service, Registry, Gates 🟢
- [extension.md](architecture/extension.md) — Browser extension architecture: WXT, MV3 service worker, v2 page interaction modules 🟢
- [decisions/](architecture/decisions/INDEX.md) — Architecture Decision Records 🟢
- [INDEX.md](architecture/INDEX.md) — Full architecture index

### Other
- [reference/](reference/INDEX.md) — Glossary and conventions
- [old/](old/INDEX.md) — Archived old-format documentation (pre-ontology) 🔴

## Status Key
- 🟢 active — Current and authoritative
- 🟡 draft — Work in progress
- 🔴 deprecated — Replaced, kept for history

---

*Auto-generated. Last rebuilt: 2026-06-11*
