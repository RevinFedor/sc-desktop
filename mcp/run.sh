#!/usr/bin/env bash
# Wrapper that launches the MCP server under Electron's bundled Node.
# better-sqlite3 in this repo is compiled against Electron's NODE_MODULE_VERSION
# (141), so a system Node interpreter (132/etc) can't load it. ELECTRON_RUN_AS_NODE
# tells the Electron binary to behave like a regular `node` and run our script,
# while keeping the same ABI used by the desktop app. Result: same library.db,
# same vec extension, no duplicate native builds.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec env ELECTRON_RUN_AS_NODE=1 \
  "$PROJECT_ROOT/node_modules/.bin/electron" \
  "$PROJECT_ROOT/mcp/server.js"
