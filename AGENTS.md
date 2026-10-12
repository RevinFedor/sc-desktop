# SC Desktop — instructions for a portable checkout

Read README.md and the chosen docs/setup/*.prompt.md before setup. Use absolute paths discovered on this computer. Browser MCP can run with only mcp/browser dependencies and browser-extension; full Electron/Python setup is separate. A local stdio MCP client is required; do not assume Noted Terminal, Voice Record or GT Editor is installed.

Preserve existing credentials, data, browser profiles and unrelated MCP configuration. Never commit settings, cookies, sessions, databases, exports, screenshots, logs or keys. Paid inference and provider Send are separate from installation; ask for an explicit approved test before sending. Verify a real result, not an ACK. A timeout after an external action means the outcome can be unknown: recover the same requestId instead of duplicating it.

Python runtime is python-workers/. Electron main uses subprocess + ndjson, not node-pty. Keep database schema consistent in electron/database.js and python-workers/shared/library_db.py. Main process logs require a [Tag] prefix. Main/preload edits need a restart of the owned instance; renderer uses Vite. Do not restart other active apps, hubs or browsers. Extension reload waits for confirmed research idle; never bypass that gate.

Runtime data is under ~/Library/Application Support/sc-desktop/. Shared service settings use ~/.config/sc/settings.json. Native Messaging host manifests are installed in the browser's required standard directories. New public examples must use placeholders and contain no machine-specific paths.
