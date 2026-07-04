/**
 * MCP Server: Claude Code <-> Bridge
 *
 * Spawned by each Claude session (via stdio).
 * Connects to the persistent bridge.js on port 3458 as a WS client.
 * Does NOT start any servers — no port conflicts between sessions.
 *
 * Architecture:
 *   Claude Code ←(MCP stdio)→ THIS ←(WS client:3458)→ bridge.js ←(WS:3457)→ Extension
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import WebSocket from 'ws';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, openSync } from 'node:fs';
import net from 'node:net';

const BRIDGE_URL = 'ws://localhost:3458';
const BRIDGE_PORT = 3458;
// 90s — covers harvest_list / wait_for_selector with long timeouts and slow
// SPAs. Per-tool wait_for_selector has its own timeout (default 10s) — this is
// just the outer kill switch.
const COMMAND_TIMEOUT = 90000;
const RECONNECT_INTERVAL = 3000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = resolve(__dirname, 'bridge.js');
const BRIDGE_LOG = '/tmp/hh-extension-bridge.log';

let bridgeSpawnAttempted = false;

// Probe localhost:3458. If nothing is listening, spawn bridge.js detached so it
// survives this Claude session. Multiple sessions race-safe: only the first
// wins the port, the rest get EADDRINUSE and silently exit; all sessions then
// connect to the single surviving bridge.
function ensureBridgeRunning() {
  if (bridgeSpawnAttempted) return;
  bridgeSpawnAttempted = true;

  const probe = net.createConnection({ port: BRIDGE_PORT, host: '127.0.0.1' });
  probe.once('connect', () => probe.destroy()); // bridge already running
  probe.once('error', () => {
    if (!existsSync(BRIDGE_PATH)) {
      console.error(`[MCP] bridge.js not found at ${BRIDGE_PATH}`);
      return;
    }
    try {
      const out = openSync(BRIDGE_LOG, 'a');
      const child = spawn(process.execPath, [BRIDGE_PATH], {
        detached: true,
        stdio: ['ignore', out, out],
      });
      child.unref();
      console.error(`[MCP] Spawned bridge (pid ${child.pid}), logs: ${BRIDGE_LOG}`);
    } catch (e) {
      console.error('[MCP] Failed to spawn bridge:', e.message);
    }
  });
}

// ── Bridge Connection ─────────────────────────────────────────────────

let bridgeWs = null;
let pendingCommands = new Map();
let commandId = 0;
let reconnectScheduled = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_BACKOFF = 60000; // cap exponential backoff at 1 min

function scheduleReconnect() {
  if (reconnectScheduled) return; // dedupe close+error firing both
  reconnectScheduled = true;
  reconnectAttempts++;
  // Exponential backoff: 3s, 6s, 12s, 24s, ..., capped at 60s.
  // Without backoff a dead bridge produces 20 reconnects/min × hours = 80K zombie sockets.
  const delay = Math.min(RECONNECT_INTERVAL * Math.pow(2, Math.min(reconnectAttempts - 1, 5)), MAX_RECONNECT_BACKOFF);
  setTimeout(() => {
    reconnectScheduled = false;
    connectBridge();
  }, delay);
}

function connectBridge() {
  try {
    const ws = new WebSocket(BRIDGE_URL);

    ws.on('open', () => {
      console.error('[MCP] Connected to bridge');
      bridgeWs = ws;
      reconnectAttempts = 0;
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.commandId && pendingCommands.has(msg.commandId)) {
          const { resolve } = pendingCommands.get(msg.commandId);
          pendingCommands.delete(msg.commandId);
          resolve(msg);
        }
      } catch (e) {
        console.error('[MCP] Parse error:', e.message);
      }
    });

    ws.on('close', () => {
      bridgeWs = null;
      try { ws.removeAllListeners(); ws.terminate(); } catch {} // free socket fully
      scheduleReconnect();
    });

    ws.on('error', () => {
      bridgeWs = null;
      try { ws.removeAllListeners(); ws.terminate(); } catch {}
      scheduleReconnect();
    });

  } catch (e) {
    scheduleReconnect();
  }
}

ensureBridgeRunning();
connectBridge();

function sendToExtension(command) {
  return new Promise((resolve, reject) => {
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      reject(new Error('Bridge not connected yet — auto-spawn in progress. Retry the tool call in 2-3 seconds.'));
      return;
    }

    const id = ++commandId;
    command.commandId = id;

    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Command timed out after ${COMMAND_TIMEOUT}ms`));
    }, COMMAND_TIMEOUT);

    pendingCommands.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    bridgeWs.send(JSON.stringify(command));
  });
}

// ── MCP Server ────────────────────────────────────────────────────────

const server = new McpServer(
  {
    name: 'extension-bridge',
    version: '1.0.0',
  },
  {
    instructions: `
Browser automation through a real Chromium browser via the SC Browser Parser extension.
Real user profile, no CDP, no \`navigator.webdriver\` — undetectable on hh.ru, LinkedIn, Cloudflare-protected sites.

## Architecture (3 processes)
  Claude session ─(stdio)→ mcp/browser/index.js ─(WS:3458)→ bridge.js ─(WS:3457)→ Browser Extension → DOM
- Each Claude session spawns its own \`index.js\` (this process). One \`bridge.js\` is shared by all sessions.
- Bridge auto-spawns on first tool call if port 3458 is free (detached, survives session). Logs: /tmp/hh-extension-bridge.log
- Multiple Claude sessions in parallel: safe. Bridge dispatches responses by commandId per client socket.

## Flow when a tool call fails
1. \`Bridge not connected yet — auto-spawn in progress\` — bridge was just started, retry in 2-3 seconds.
2. \`Extension not connected\` — bridge is running, but the browser extension is not. Tell the user to:
   - Open Chrome → \`chrome://extensions\` → make sure SC Browser Parser extension is enabled
   - Click the SC Browser Parser toolbar icon to wake the service worker
   Then retry.
3. \`No tab with id: X\` — tab was closed. Call \`list_tabs\` for the current id and retry.
4. \`No response from any frame\` — content script not injected on that page. Retry once, or \`reload_tab\` the tab.
5. \`Cannot access contents of the page\` — page predates extension reload. Ask user to F5 / use \`reload_tab\`.
6. \`chrome.userScripts unavailable\` / \`Allow user scripts\` — user must enable the toggle on the extension's details page (Chrome 138+) for \`evaluate_raw\` to work on CSP-locked sites like aistudio.google.com or banks. The DSL-based \`evaluate\` (selector/extract/click/fill) still works without it.

## Tool quick-reference

**Discovery & basic actions**
- \`list_tabs\` — every open tab, returns {id, url, title, active}.
- \`snapshot\` — simplified DOM tree of interactive elements with selectors. Prefer this over \`get_text\` for finding things to click.
- \`click\`, \`fill\` — by CSS selector. \`fill\` works on input/textarea/select AND contenteditable (TipTap, ProseMirror).
- \`hover\` — synthetic mouse hover via dispatchEvent. Triggers CSS \`:hover\`, JS hover-listeners, tooltips. **Does NOT** trigger trusted-only effects like YouTube inline-preview (those need real OS events via CDP).
- \`navigate\` — load URL in active tab and wait for load.
- \`get_text\` — textContent of one element (or whole body).
- \`scroll\` — scroll the window itself.

**Reading data**
- \`evaluate\` — restricted DSL. Accepts {selector, extract:[fields], limit} for reading, or {fill:"css", index:N, value} / {click:"css", index:N} for indexed actions. Always works, no toggle required. Use this first.
- \`evaluate_raw\` — arbitrary JS in USER_SCRIPT world (bypasses page CSP including \`unsafe-eval\`). REQUIRES Chrome 138+ AND the "Allow user scripts" toggle on the extension's details page in chrome://extensions. If unavailable returns a clear error — fall back to \`evaluate\` DSL or write more specific selectors.
- \`get_cookies\` — read browser cookies by domain/url/name. Useful for authenticated requests via \`evaluate_raw\` + fetch().
- \`get_storage\` — read localStorage / sessionStorage with optional keyPrefix.

**Tab management**
- \`new_tab\` — open URL (foreground or background). Returns the new tabId. Use background:true to scrape multiple sites in parallel.
- \`close_tab\`, \`focus_tab\`, \`reload_tab\` — self-explanatory. \`reload_tab\` waits for load completion by default.

**Screenshots**
- \`screenshot\` — viewport PNG/JPEG via captureVisibleTab. No "DevTools is debugging this tab" badge, undetectable. Returns native image.
- \`screenshot_element\` — scrolls element into view, captures viewport, returns image + element rect (in CSS px, with devicePixelRatio) so you can crop afterwards if needed.

**Virtualized lists & async waits**
- \`scroll_element\` — scroll a specific container (not window). direction=top|bottom for jumps, up|down for relative. Returns scroll state {scrollTop, scrollHeight, atTop, atBottom}.
- \`wait_for_selector\` — poll until a selector appears (and optionally is visible). Better than fixed sleeps after navigate/click.
- \`harvest_list\` — scrolls a virtualized container top → bottom collecting unique items by dedupe key. Use for infinite feeds (Twitter, AI Studio chats, paginated tables).

**Performance**
- \`batch\` — execute a list of MCP actions in one round-trip. Each {action, ...args}; the action names match the internal mcp_* names (mcp_click, mcp_fill, mcp_scroll_element, mcp_wait_for_selector, etc). Use this whenever you have 3+ sequential steps to save 100-300ms each.

**Yandex Maps**
- \`yandex_maps_search\` — search organizations on Yandex Maps, get structured data (title/address/coordinates/phones/website/socials/rating/working-hours/categories) with NO API key. Drives the real maps tab, reads embedded SSR state. Location via region/ll/spn (not scrolling). Paginates via ?page=N + de-dupe by id; pass max_pages (number or "all") for full coverage — pin ll+spn so pages stay consistent. Deterministic report: fetched (unique collected) + total_in_area (Yandex estimate, informational) + remaining + complete (true source of truth on whether the end was reached) + pages_fetched + stop_reason. Then use \`navigate\`+\`get_text\`/\`evaluate\` on each result's \`site\` to read the clinic's own website.

Note: Google AI Studio research is NOT a browser-MCP tool anymore. It moved to
the sc-desktop bridge HTTP channel (same as claude/perplexity research):
POST http://127.0.0.1:53127/research-start {provider:"aistudio", prompt, options:{model}}
then GET /research-status?id=<aim_...>&wait=60000. See the external-research skill.
This MCP server is for LIVE PARSING only (tabs/click/evaluate/snapshot).

## Picking the right tool
- Need a CSS selector → \`snapshot\` first, then click/fill.
- Need a structured list of items → \`evaluate\` DSL with {selector, extract}.
- Need to look at the page visually (e.g. layout questions, did the modal appear) → \`screenshot\` (or \`screenshot_element\`).
- Need to verify state after an action → \`wait_for_selector\` then read.
- Page uses virtualization (rows only render when on-screen) → \`harvest_list\` or scroll_element + evaluate in a loop.
- Need arbitrary JS / read framework state / call internal APIs → \`evaluate_raw\` (after toggle).
- Doing 3+ steps with no intermediate decisions → wrap in \`batch\`.

## Critical: do NOT switch to chrome-devtools MCP if browser MCP fails
Send the user the recovery script (above). The two MCPs are not interchangeable — chrome-devtools spawns a new headless Chrome, this MCP drives the user's real session with their cookies/extensions.

## Source / repo
This MCP lives in the sc-desktop repo: \`~/Desktop/sc-desktop/mcp/browser/\`. \`bridge.js\` and \`index.js\` plus the \`browser-extension/\` Chrome extension are dev-only — there is no production variant.
`.trim(),
  }
);

// Tool: Get list of open tabs
server.registerTool(
  'list_tabs',
  {
    description: 'List all open browser tabs with their URLs and titles',
    inputSchema: {},
  },
  async () => {
    try {
      const result = await sendToExtension({ action: 'mcp_list_tabs' });
      return { content: [{ type: 'text', text: JSON.stringify(result.tabs, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// Tool: Force-reload extension (skip hot-reload poll wait)
server.registerTool(
  'force_reload_extension',
  {
    description: 'Force chrome.runtime.reload() on the SC Browser Parser extension. Use when hot-reload polling hasn\'t picked up file changes yet and you need the latest extension code immediately.',
    inputSchema: {},
  },
  async () => {
    try {
      const result = await sendToExtension({ action: 'mcp_force_reload' });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// Tool: Take DOM snapshot of a tab
server.registerTool(
  'snapshot',
  {
    description: 'Get a simplified DOM snapshot of a browser tab. Returns interactive elements (links, buttons, inputs) with their selectors, text content, and attributes. Use this to find CSS selectors for scraping.',
    inputSchema: {
      tabId: z.number().optional().describe('Tab ID to snapshot. If omitted, uses the active tab.'),
      fullHtml: z.boolean().optional().describe('If true, returns raw outerHTML instead of simplified tree. Large output.'),
    },
  },
  async ({ tabId, fullHtml }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_snapshot',
        tabId: tabId || null,
        fullHtml: fullHtml || false,
      });
      return { content: [{ type: 'text', text: result.snapshot }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// Tool: Click an element
server.registerTool(
  'click',
  {
    description: 'Click an element on the page by CSS selector',
    inputSchema: {
      tabId: z.number().optional().describe('Tab ID. If omitted, uses the active tab.'),
      selector: z.string().describe('CSS selector of the element to click'),
    },
  },
  async ({ tabId, selector }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_click',
        tabId: tabId || null,
        selector,
      });
      return { content: [{ type: 'text', text: result.success ? 'Clicked' : `Failed: ${result.error}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// Tool: Hover over an element (synthetic). Dispatches pointerover/mouseover/
// pointerenter/mouseenter/pointermove/mousemove on the element. Wakes up
// CSS :hover, JS hover-listeners, tooltips. Does NOT trigger trusted-only
// behaviours (e.g. YouTube inline-preview video) which require real OS
// mouse events delivered via CDP — outside the Chrome Extension API surface.
server.registerTool(
  'hover',
  {
    description: 'Hover over an element by CSS selector (synthetic mouse events). Triggers CSS :hover, JS hover-listeners, tooltips. Does NOT trigger trusted-only effects like YouTube inline-preview (those need real OS mouse events via CDP).',
    inputSchema: {
      tabId: z.number().optional().describe('Tab ID. If omitted, uses the active tab.'),
      selector: z.string().describe('CSS selector of the element to hover'),
    },
  },
  async ({ tabId, selector }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_hover',
        tabId: tabId || null,
        selector,
      });
      return { content: [{ type: 'text', text: result.success ? `Hovered (${Math.round(result.rect?.x||0)},${Math.round(result.rect?.y||0)})` : `Failed: ${result.error}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// Tool: Fill an input field
server.registerTool(
  'fill',
  {
    description: 'Fill a text input or textarea by CSS selector',
    inputSchema: {
      tabId: z.number().optional().describe('Tab ID. If omitted, uses the active tab.'),
      selector: z.string().describe('CSS selector of the input element'),
      value: z.string().describe('Value to set'),
    },
  },
  async ({ tabId, selector, value }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_fill',
        tabId: tabId || null,
        selector,
        value,
      });
      return { content: [{ type: 'text', text: result.success ? 'Filled' : `Failed: ${result.error}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// Tool: Navigate to a URL
server.registerTool(
  'navigate',
  {
    description: 'Navigate a tab to a URL',
    inputSchema: {
      tabId: z.number().optional().describe('Tab ID. If omitted, uses the active tab.'),
      url: z.string().describe('URL to navigate to'),
    },
  },
  async ({ tabId, url }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_navigate',
        tabId: tabId || null,
        url,
      });
      return { content: [{ type: 'text', text: result.success ? `Navigated to ${url}` : `Failed: ${result.error}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// Tool: Evaluate JavaScript on the page
server.registerTool(
  'evaluate',
  {
    description: 'Execute JavaScript code in the context of a page and return the result',
    inputSchema: {
      tabId: z.number().optional().describe('Tab ID. If omitted, uses the active tab.'),
      code: z.string().describe('JavaScript code to evaluate. Must return a JSON-serializable value.'),
    },
  },
  async ({ tabId, code }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_evaluate',
        tabId: tabId || null,
        code,
      });
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      const output = result.result !== undefined ? JSON.stringify(result.result, null, 2) : 'undefined';
      return { content: [{ type: 'text', text: output }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// Tool: Get page text content
server.registerTool(
  'get_text',
  {
    description: 'Get text content of an element (or the whole page body) by CSS selector',
    inputSchema: {
      tabId: z.number().optional().describe('Tab ID. If omitted, uses the active tab.'),
      selector: z.string().optional().describe('CSS selector. If omitted, returns document.body text.'),
    },
  },
  async ({ tabId, selector }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_get_text',
        tabId: tabId || null,
        selector: selector || 'body',
      });
      return { content: [{ type: 'text', text: result.text || '' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// Tool: Scroll the page
server.registerTool(
  'scroll',
  {
    description: 'Scroll the page up or down',
    inputSchema: {
      tabId: z.number().optional().describe('Tab ID. If omitted, uses the active tab.'),
      direction: z.enum(['up', 'down']).describe('Scroll direction'),
      amount: z.number().optional().describe('Pixels to scroll. Default: 600'),
    },
  },
  async ({ tabId, direction, amount }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_scroll',
        tabId: tabId || null,
        direction,
        amount: amount || 600,
      });
      return { content: [{ type: 'text', text: result.success ? 'Scrolled' : `Failed: ${result.error}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// ── Tab management ────────────────────────────────────────────────────

server.registerTool(
  'new_tab',
  {
    description: 'Open a new browser tab and (optionally) navigate to a URL. Waits for load to complete unless background:true.',
    inputSchema: {
      url: z.string().optional().describe('URL to load. Omit for blank tab.'),
      background: z.boolean().optional().describe('If true, do not focus the new tab and do not wait for load.'),
    },
  },
  async ({ url, background }) => {
    try {
      const result = await sendToExtension({ action: 'mcp_new_tab', url, background: !!background });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'close_tab',
  {
    description: 'Close a browser tab.',
    inputSchema: { tabId: z.number().describe('Tab ID to close') },
  },
  async ({ tabId }) => {
    try {
      const result = await sendToExtension({ action: 'mcp_close_tab', tabId });
      return { content: [{ type: 'text', text: result.success ? 'Closed' : `Failed: ${result.error}` }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'focus_tab',
  {
    description: 'Activate a tab and focus its window.',
    inputSchema: { tabId: z.number().describe('Tab ID to focus') },
  },
  async ({ tabId }) => {
    try {
      const result = await sendToExtension({ action: 'mcp_focus_tab', tabId });
      return { content: [{ type: 'text', text: result.success ? 'Focused' : `Failed: ${result.error}` }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'reload_tab',
  {
    description: 'Reload a tab. Waits for load completion by default.',
    inputSchema: {
      tabId: z.number().optional(),
      bypassCache: z.boolean().optional().describe('If true, hard reload ignoring HTTP cache.'),
      waitForLoad: z.boolean().optional().describe('Default true. Set false to return immediately.'),
    },
  },
  async ({ tabId, bypassCache, waitForLoad }) => {
    try {
      const result = await sendToExtension({ action: 'mcp_reload_tab', tabId: tabId || null, bypassCache, waitForLoad });
      return { content: [{ type: 'text', text: result.success ? 'Reloaded' : `Failed: ${result.error}` }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

// ── Screenshots ───────────────────────────────────────────────────────

server.registerTool(
  'screenshot',
  {
    description: 'Capture a PNG/JPEG screenshot of the visible viewport of a tab. Returns the image directly.',
    inputSchema: {
      tabId: z.number().optional(),
      format: z.enum(['png', 'jpeg']).optional().describe('Default png.'),
      quality: z.number().min(1).max(100).optional().describe('JPEG quality 1-100, default 80.'),
    },
  },
  async ({ tabId, format, quality }) => {
    try {
      const result = await sendToExtension({ action: 'mcp_screenshot', tabId: tabId || null, format, quality });
      if (!result.success) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      return { content: [{ type: 'image', data: result.base64, mimeType: result.mimeType }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'screenshot_element',
  {
    description: 'Capture a screenshot of the visible viewport after scrolling a specific element into view. Returns the full viewport image plus the element rect for cropping. Use selector to target.',
    inputSchema: {
      tabId: z.number().optional(),
      selector: z.string().describe('CSS selector of the element to focus.'),
      format: z.enum(['png', 'jpeg']).optional(),
      quality: z.number().min(1).max(100).optional(),
    },
  },
  async ({ tabId, selector, format, quality }) => {
    try {
      const result = await sendToExtension({ action: 'mcp_screenshot_element', tabId: tabId || null, selector, format, quality });
      if (!result.success) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      return {
        content: [
          { type: 'text', text: `Element rect (CSS px): ${JSON.stringify(result.crop)} dpr=${result.devicePixelRatio}` },
          { type: 'image', data: result.base64, mimeType: result.mimeType },
        ],
      };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

// ── Virtualized scrolling helpers ─────────────────────────────────────

server.registerTool(
  'scroll_element',
  {
    description: 'Scroll a specific element by selector. Use direction=top|bottom for absolute jumps, up|down for relative. Returns final scroll state.',
    inputSchema: {
      tabId: z.number().optional(),
      selector: z.string().describe('CSS selector of the scrollable container.'),
      direction: z.enum(['up', 'down', 'top', 'bottom']).describe('Direction to scroll.'),
      amount: z.number().optional().describe('Pixels for up/down. Default 600.'),
    },
  },
  async ({ tabId, selector, direction, amount }) => {
    try {
      const result = await sendToExtension({ action: 'mcp_scroll_element', tabId: tabId || null, selector, direction, amount });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'wait_for_selector',
  {
    description: 'Poll until a selector appears (and optionally is visible). Returns once found or after timeout.',
    inputSchema: {
      tabId: z.number().optional(),
      selector: z.string(),
      timeout: z.number().optional().describe('Max wait in ms. Default 10000.'),
      visible: z.boolean().optional().describe('Require element to be visible (non-zero box, not display:none).'),
    },
  },
  async ({ tabId, selector, timeout, visible }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_wait_for_selector',
        tabId: tabId || null,
        selector,
        timeout: timeout || 10000,
        visible: !!visible,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'harvest_list',
  {
    description: 'Scroll a virtualized list container from top to bottom and collect unique items. Use for AI Studio chats, Twitter feeds, infinite-scroll lists. Returns deduplicated array of {fields...}.',
    inputSchema: {
      tabId: z.number().optional(),
      containerSelector: z.string().describe('CSS selector of the scrollable virtualized container.'),
      itemSelector: z.string().describe('CSS selector for items inside the container (e.g. ms-chat-turn, article).'),
      fields: z.array(z.string()).optional().describe('Fields to extract: textContent (default), outerHTML, or any attribute name (href, data-id, etc).'),
      dedupeAttr: z.string().optional().describe('Attribute used as dedupe key. If omitted, hash of textContent is used.'),
      stepPx: z.number().optional().describe('Pixels per scroll step. Default ~ container height.'),
      settleMs: z.number().optional().describe('Wait between scrolls for items to render. Default 250.'),
      maxSteps: z.number().optional().describe('Hard cap on scroll iterations. Default 200.'),
      maxItems: z.number().optional().describe('Stop once this many unique items collected. Default 5000.'),
    },
  },
  async ({ tabId, containerSelector, itemSelector, fields, dedupeAttr, stepPx, settleMs, maxSteps, maxItems }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_harvest_virtual_list',
        tabId: tabId || null,
        containerSelector, itemSelector, fields, dedupeAttr, stepPx, settleMs, maxSteps, maxItems,
      });
      if (!result.success) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ count: result.count, items: result.items }, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

// ── Arbitrary JS / cookies / storage / batch ──────────────────────────

server.registerTool(
  'evaluate_raw',
  {
    description: 'Run arbitrary JavaScript inside the page in a USER_SCRIPT world (full DOM access, bypasses page CSP including unsafe-eval). Bypasses the limited evaluate() DSL. Result is auto-serialized (DOM nodes summarized, cycles broken). Requires Chrome 138+ and the "Allow user scripts" toggle on the extension details page — otherwise returns an error and you should fall back to the evaluate() DSL.',
    inputSchema: {
      tabId: z.number().optional(),
      code: z.string().describe('JS code. Use `return` to send a value back, OR set expression:true to treat the input as an expression.'),
      expression: z.boolean().optional().describe('If true, the code is wrapped as `return (code)`.'),
      async: z.boolean().optional().describe('If true, code may use await; the function is wrapped as async.'),
      maxDepth: z.number().optional().describe('Object serialization depth limit (default 4).'),
    },
  },
  async ({ tabId, code, expression, async: isAsync, maxDepth }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_evaluate_raw',
        tabId: tabId || null,
        code, expression, async: isAsync, maxDepth,
      });
      if (!result.success) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      const out = result.result === undefined ? 'undefined' : JSON.stringify(result.result, null, 2);
      return { content: [{ type: 'text', text: out }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'get_cookies',
  {
    description: 'Read cookies from the browser (uses chrome.cookies API). Filter by domain, url, or name.',
    inputSchema: {
      domain: z.string().optional(),
      url: z.string().optional(),
      name: z.string().optional(),
    },
  },
  async ({ domain, url, name }) => {
    try {
      const result = await sendToExtension({ action: 'mcp_get_cookies', domain, url, name });
      if (!result.success) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(result.cookies, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'get_storage',
  {
    description: 'Read localStorage or sessionStorage of a tab. Optional keyPrefix filter.',
    inputSchema: {
      tabId: z.number().optional(),
      type: z.enum(['local', 'session']).optional().describe('Default local.'),
      keyPrefix: z.string().optional().describe('Only return keys starting with this prefix.'),
    },
  },
  async ({ tabId, type, keyPrefix }) => {
    try {
      const result = await sendToExtension({ action: 'mcp_get_storage', tabId: tabId || null, type: type || 'local', keyPrefix });
      if (!result.success) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'batch',
  {
    description: 'Execute a list of MCP actions sequentially in the extension and return all results. Saves round-trips for scripted scenarios. Each action is a {action: "mcp_xxx", ...args} object — same names the tools use internally (mcp_click, mcp_fill, mcp_evaluate_raw, mcp_wait_for_selector, etc). Optional delayMs between steps; stopOnError breaks on first failure.',
    inputSchema: {
      actions: z.array(z.any()).describe('Array of action objects. Example: [{"action":"mcp_navigate","url":"..."},{"action":"mcp_wait_for_selector","selector":".x"},{"action":"mcp_click","selector":".y"}]'),
      stopOnError: z.boolean().optional(),
      tabId: z.number().optional().describe('Default tabId for sub-actions that omit one.'),
    },
  },
  async ({ actions, stopOnError, tabId }) => {
    try {
      const result = await sendToExtension({ action: 'mcp_batch', actions, stopOnError, tabId: tabId || null });
      return { content: [{ type: 'text', text: JSON.stringify(result.results, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

// ── Ozon catalog/search/favorites ───────────────────────────────────
server.registerTool(
  'ozon_favorites',
  {
    description: 'Read Ozon favorites from the real browser profile via extension background fetch with browser cookies, without opening or navigating tabs. Calls Ozon Composer page/json and returns structured product cards with direct links, prices, ratings, delivery labels, images, filters, and counters. Default URL is https://www.ozon.ru/my/favorites.',
    inputSchema: {
      url: z.string().optional().describe('Ozon favorites URL. Defaults to https://www.ozon.ru/my/favorites. Required only if you want a custom favorites/filter URL.'),
      max_pages: z.union([z.number(), z.string()]).optional().describe('Pages to fetch using Ozon nextPage pagination. Default fetches up to hard cap 30 pages for favorites. "all"/0 also fetches up to that cap.'),
      limit: z.union([z.number(), z.string()]).optional().describe('Max unique products to return. Default 100. "all"/0 returns all products from fetched pages.'),
      page: z.number().optional().describe('Start page. Default removes page= and starts from page 1.'),
      category: z.union([z.number(), z.string()]).optional().describe('Optional favorites category id, copied into category=...'),
      available_only: z.boolean().optional().describe('Optional available-only hint. Uses Ozon URL state when supported.'),
      in_stock_only: z.boolean().optional().describe('Alias for available_only.'),
      photo_limit: z.number().optional().describe('Images per product. Default 5, max 20.'),
    },
  },
  async ({ url, max_pages, limit, page, category, available_only, in_stock_only, photo_limit }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_ozon_favorites',
        url, max_pages, limit, page, category, available_only, in_stock_only, photo_limit,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'ozon_purchases',
  {
    description: 'Read Ozon "Покупки / Купленные товары" from the real browser profile via extension background fetch with browser cookies, without opening or navigating tabs. Without query it reads Ozon special purchased-products list (https://www.ozon.ru/my/favorites/list?list=4294967294), not /my/orderlist. With query/q/product it uses Ozon purchased-products search (/my/purchases/search?text=...) and returns product cards with direct links, prices, ratings, delivery labels, images, filters, and counters.',
    inputSchema: {
      query: z.string().optional().describe('Search text for Ozon purchased-products search, e.g. "стакан" or "пергамент".'),
      q: z.string().optional().describe('Alias for query.'),
      product: z.string().optional().describe('Alias for query.'),
      product_query: z.string().optional().describe('Alias for query.'),
      search: z.string().optional().describe('Alias for query.'),
      url: z.string().optional().describe('Optional custom Ozon purchased-products/favorites-list URL. Defaults to https://www.ozon.ru/my/favorites/list?list=4294967294.'),
      max_pages: z.union([z.number(), z.string()]).optional().describe('Pages to fetch using Ozon nextPage pagination. Default fetches up to hard cap 30 pages. "all"/0 also fetches up to that cap.'),
      limit: z.union([z.number(), z.string()]).optional().describe('Max matching unique products to return. Default 100. "all"/0 returns all matches from fetched pages.'),
      page: z.number().optional().describe('Start page. Default removes page= and starts from page 1.'),
      photo_limit: z.number().optional().describe('Images per product. Default 5, max 20.'),
    },
  },
  async ({ query, q, product, product_query, search, url, max_pages, limit, page, photo_limit }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_ozon_purchases',
        query, q, product, product_query, search, url, max_pages, limit, page, photo_limit,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'ozon_search',
  {
    description: 'Search Ozon through the real browser profile and return structured product cards without opening or navigating tabs. Pass query text or an Ozon search/category URL. The tool fetches Ozon Composer page/json directly from the extension service worker with browser cookies, de-dupes by SKU, and returns direct product links, prices, ratings, delivery labels, images, filters, and sort options.',
    inputSchema: {
      query: z.string().optional().describe('Search text. Used to build /search/?text=... when url is omitted.'),
      q: z.string().optional().describe('Alias for query.'),
      url: z.string().optional().describe('Ozon search/category URL with filters already set. Required unless query/q is provided.'),
      max_pages: z.union([z.number(), z.string()]).optional().describe('Pages to fetch. Default 1. "all"/0 fetches up to hard cap 30 pages.'),
      limit: z.union([z.number(), z.string()]).optional().describe('Max unique products to return. Default 100. "all"/0 returns all products from fetched pages.'),
      page: z.number().optional().describe('Start page. Default removes page= and starts from page 1.'),
      sort: z.string().optional().describe('Sort: popular/score, new, price/price_asc/cheaper, price_desc/expensive, rating, discount.'),
      sorting: z.string().optional().describe('Raw Ozon sorting value; overrides sort mapping if provided.'),
      price_min: z.number().optional().describe('Min price filter. Encoded as currency_price=min;max.'),
      price_max: z.number().optional().describe('Max price filter. Encoded as currency_price=min;max.'),
      min_price: z.number().optional().describe('Alias for price_min.'),
      max_price: z.number().optional().describe('Alias for price_max.'),
      currency_price: z.string().optional().describe('Raw Ozon currency_price value, e.g. "500.000;1500.000".'),
      delivery: z.union([z.number(), z.string()]).optional().describe('Raw Ozon delivery filter. Known values from live filter state: 1=today, 2=tomorrow, 4=up to 3 days, 8=up to 7 days, 889551867=from 1 hour.'),
      photo_limit: z.number().optional().describe('Images per product. Default 5, max 20.'),
    },
  },
  async ({ query, q, url, max_pages, limit, page, sort, sorting, price_min, price_max, min_price, max_price, currency_price, delivery, photo_limit }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_ozon_search',
        query, q, url, max_pages, limit, page, sort, sorting, price_min, price_max, min_price, max_price, currency_price, delivery, photo_limit,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'ozon_orders',
  {
    description: 'Read Ozon orders from the real browser profile via extension background fetch with browser cookies, without opening or navigating tabs. Lists active or completed orders with full Ozon pagination. For product-name search it fetches each orderdetails Composer payload directly and returns matching orders with product titles, prices, images, sellers, and direct product links.',
    inputSchema: {
      url: z.string().optional().describe('Ozon order list URL. Defaults to https://www.ozon.ru/my/orderlist?selectedTab=archive.'),
      selected_tab: z.string().optional().describe('Order tab: archive/completed/history for completed orders, active/current for active orders. Default archive.'),
      status: z.string().optional().describe('Alias for selected_tab.'),
      selected_year: z.union([z.number(), z.string()]).optional().describe('Archive year, e.g. 2026, 2025, ... 2021. Copied into selectedYear=...'),
      year: z.union([z.number(), z.string()]).optional().describe('Alias for selected_year.'),
      query: z.string().optional().describe('Search text. When provided, the tool fetches order details and searches product titles/attributes/sellers/order text.'),
      q: z.string().optional().describe('Alias for query.'),
      product: z.string().optional().describe('Alias for query/product-name search.'),
      product_query: z.string().optional().describe('Alias for query/product-name search.'),
      search: z.string().optional().describe('Alias for query/product-name search.'),
      month: z.union([z.number(), z.string()]).optional().describe('Optional month filter: 1-12 or Russian month name, e.g. "июнь". Uses selected_year/year when the order text has no year.'),
      selected_month: z.union([z.number(), z.string()]).optional().describe('Alias for month.'),
      date_from: z.string().optional().describe('Optional lower date bound in YYYY-MM-DD. Uses Russian order date text plus selected_year/year when needed.'),
      date_to: z.string().optional().describe('Optional upper date bound in YYYY-MM-DD.'),
      include_details: z.boolean().optional().describe('Fetch details for returned/scanned orders even without query. Required for product links. Default true when query/date filters are used, false for plain list.'),
      details: z.boolean().optional().describe('Alias for include_details.'),
      max_pages: z.union([z.number(), z.string()]).optional().describe('Order-list pages to scan. Default 1 for plain list, hard cap 200 for search/date filters. "all"/0 scans up to hard cap.'),
      limit: z.union([z.number(), z.string()]).optional().describe('Max returned orders/matches. Default 100. "all"/0 returns all scanned matches.'),
      min_results: z.number().optional().describe('For query search with default stop_when_found=true, stop after at least this many matches. Default 1.'),
      stop_when_found: z.boolean().optional().describe('For query search, stop after min_results matches. Default true for text query, false for date-only filtering.'),
      detail_limit: z.union([z.number(), z.string()]).optional().describe('Max order details to fetch. Default 1000 when details are needed. "all"/0 removes this cap within max_pages.'),
      detail_concurrency: z.number().optional().describe('Parallel detail fetches per page. Default 4, max 6.'),
      photo_limit: z.number().optional().describe('Images per product/order preview. Default 3, max 20.'),
    },
  },
  async ({ url, selected_tab, status, selected_year, year, query, q, product, product_query, search, month, selected_month, date_from, date_to, include_details, details, max_pages, limit, min_results, stop_when_found, detail_limit, detail_concurrency, photo_limit }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_ozon_orders',
        url, selected_tab, status, selected_year, year, query, q, product, product_query, search,
        month, selected_month, date_from, date_to, include_details, details,
        max_pages, limit, min_results, stop_when_found, detail_limit, detail_concurrency, photo_limit,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'ozon_order_detail',
  {
    description: 'Read one Ozon orderdetails page from the real browser profile via extension background fetch with browser cookies, without opening or navigating tabs, and return products with direct /product/... links, prices, seller, status, address, totals, attributes, and images.',
    inputSchema: {
      order_id: z.string().optional().describe('Ozon order id, e.g. 65277293-0507.'),
      order: z.string().optional().describe('Alias for order_id.'),
      url: z.string().optional().describe('Full Ozon orderdetails URL. Required unless order_id/order is provided.'),
      detail_url: z.string().optional().describe('Alias for url.'),
      selected_tab: z.string().optional().describe('Optional tab marker copied into selectedTab, e.g. archive.'),
      status: z.string().optional().describe('Alias for selected_tab.'),
      photo_limit: z.number().optional().describe('Images per product. Default 5, max 20.'),
    },
  },
  async ({ order_id, order, url, detail_url, selected_tab, status, photo_limit }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_ozon_order_detail',
        order_id, order, url, detail_url, selected_tab, status, photo_limit,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'ozon_product_images',
  {
    description: 'Get Ozon product preview/gallery images by product URL/SKU or by searching purchased products, without touching the active tab by default. Query mode returns matching candidates with preview images from Ozon Composer; product-page mode fetches the full product gallery from Composer, optionally through a background tab when transport:"tab" is requested.',
    inputSchema: {
      url: z.string().optional().describe('Ozon product URL. If provided, the tool fetches images for this product directly.'),
      product_url: z.string().optional().describe('Alias for url.'),
      sku: z.union([z.number(), z.string()]).optional().describe('Ozon product SKU/id. Used to match purchased/search candidates or build product identity.'),
      id: z.union([z.number(), z.string()]).optional().describe('Alias for sku.'),
      product_id: z.union([z.number(), z.string()]).optional().describe('Alias for sku.'),
      query: z.string().optional().describe('Search text in purchased products, e.g. "бумажные тарелки глубокие".'),
      q: z.string().optional().describe('Alias for query.'),
      product: z.string().optional().describe('Alias for query.'),
      product_query: z.string().optional().describe('Alias for query.'),
      search: z.string().optional().describe('Alias for query.'),
      items: z.array(z.any()).optional().describe('Advanced specs. Each item may contain query/q/product/title, sku/id/product_id, url, required_terms, exclude_terms, visual_hint, limit.'),
      source: z.string().optional().describe('Search source when query is used: purchases (default) or search.'),
      max_pages: z.union([z.number(), z.string()]).optional().describe('Pages to scan when query is used. Default 3, hard cap 30.'),
      limit: z.union([z.number(), z.string()]).optional().describe('How many matched products to fetch full galleries for. Default 1. "all"/0 returns up to candidate_limit.'),
      candidate_limit: z.number().optional().describe('How many text-matching candidates with preview images to return. Default 5 for query mode, max 30.'),
      preview_photo_limit: z.number().optional().describe('Preview images per candidate from search/purchases. Default 5, max 20.'),
      photo_limit: z.number().optional().describe('Full product-page gallery images per product. Default 30, max 80.'),
      include_product_page: z.boolean().optional().describe('Fetch full product-page gallery for selected products. Default true. Pass false to only return search/purchase preview images.'),
      include_candidates: z.boolean().optional().describe('Return candidate list with preview images. Default true.'),
      transport: z.string().optional().describe('direct (default) uses Composer fetch without opening tabs; tab opens a background tab and extracts from the product page DOM/Composer.'),
      use_tab: z.boolean().optional().describe('Alias for transport:"tab".'),
      keep_open: z.boolean().optional().describe('When transport:"tab" creates a background tab, keep it open. Default false.'),
    },
  },
  async ({ url, product_url, sku, id, product_id, query, q, product, product_query, search, items, source, max_pages, limit, candidate_limit, preview_photo_limit, photo_limit, include_product_page, include_candidates, transport, use_tab, keep_open }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_ozon_product_images',
        url, product_url, sku, id, product_id, query, q, product, product_query, search, items,
        source, max_pages, limit, candidate_limit, preview_photo_limit, photo_limit,
        include_product_page, include_candidates, transport, use_tab, keep_open,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'ozon_cart_prepare',
  {
    description: 'Find products in Ozon purchases/search, add them to the cart, then open the Ozon cart and select only those products with checkboxes. This is a mutating cart-preparation tool: it may add items and change cart selection, but it never deletes cart items and never proceeds to checkout/payment. Pass confirm:true to allow mutation.',
    inputSchema: {
      confirm: z.boolean().optional().describe('Required true to mutate the cart. Without confirm the tool returns an error before opening or clicking Ozon pages.'),
      queries: z.array(z.string()).optional().describe('Product search queries in purchased products, e.g. ["деревянные ложки", "деревянные вилки", "бумажные тарелки глубокие"].'),
      query: z.string().optional().describe('Single product search query. Used when queries/items are omitted.'),
      q: z.string().optional().describe('Alias for query.'),
      items: z.array(z.any()).optional().describe('Advanced product specs. Each item may contain query/q/product/title, sku/id/product_id, url, quantity, required_terms, exclude_terms, visual_hint, candidate_limit, and limit.'),
      limit_per_query: z.number().optional().describe('How many products to pick per query. Default 1.'),
      candidate_limit: z.number().optional().describe('How many text-matching candidates with preview images to return per query. Default 5 in dry_run or visual_hint mode, otherwise 0.'),
      visual_hint: z.string().optional().describe('Optional visual description for a single query, e.g. "коричневое основание, не белое". When set without exact sku/url, the tool returns candidates for visual review unless visual_confirmed:true is passed.'),
      visual_confirmed: z.boolean().optional().describe('Set true only after the caller has picked exact sku/url from preview images. Prevents blind mutation from text-only matches when visual_hint is present.'),
      max_pages: z.union([z.number(), z.string()]).optional().describe('Purchased-products search pages per query. Default 3, hard cap 30.'),
      photo_limit: z.number().optional().describe('Images per product in returned summary. Default 1, max 5.'),
      select_only_targets: z.boolean().optional().describe('Default true: in the cart, target products are checked and other visible products are unchecked. Does not delete anything.'),
      preserve_existing_selection: z.boolean().optional().describe('If true, leave already selected non-target cart products selected. Default false.'),
      open_cart: z.boolean().optional().describe('Open/navigate a cart tab after adding. Default true.'),
      focus_cart: z.boolean().optional().describe('Focus the cart tab at the end. Default true when open_cart is true.'),
      keep_open: z.boolean().optional().describe('Keep the working cart tab open. Default true when open_cart is true.'),
      dry_run: z.boolean().optional().describe('If true, only search and report candidates; do not click add-to-cart or change cart checkboxes.'),
    },
  },
  async ({ confirm, queries, query, q, items, limit_per_query, candidate_limit, visual_hint, visual_confirmed, max_pages, photo_limit, select_only_targets, preserve_existing_selection, open_cart, focus_cart, keep_open, dry_run }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_ozon_cart_prepare',
        confirm, queries, query, q, items, limit_per_query, candidate_limit, visual_hint, visual_confirmed, max_pages, photo_limit,
        select_only_targets, preserve_existing_selection, open_cart, focus_cart, keep_open, dry_run,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);
// ── Avito realty/search/chat ─────────────────────────────────────────
server.registerTool(
  'avito_search',
  {
    description: 'Search Avito listings from a real browser profile. Best mode: pass an Avito search URL with filters already set; simple product searches can be built from query/city/category/price/seller_type. The tool paginates via Avito page links, de-dupes by item id, and extracts structured cards: title, URL, price, address/metro, description, first photos, plus realty-specific rooms/area/floor/conditions when present. detail_limit opens first N listings for full item details, seller type/rating/reviews, sections/specs, photos, and chat preview.',
    inputSchema: {
      url: z.string().optional().describe('Avito search URL. Best practice for complex filters: set filters manually once and pass the resulting URL. Required unless query/category or an explicit tabId is provided.'),
      search_url: z.string().optional().describe('Alias for url.'),
      query: z.string().optional().describe('Simple search text used to build an Avito URL when url is omitted, e.g. "MacBook Air M5 16/512".'),
      q: z.string().optional().describe('Alias for query.'),
      search: z.string().optional().describe('Alias for query.'),
      city: z.string().optional().describe('City slug/name for generated URLs. Known aliases include msk/moscow/Москва -> moskva, spb/Питер -> sankt-peterburg. Default moskva.'),
      region: z.string().optional().describe('Alias for city.'),
      category: z.string().optional().describe('Category slug/alias for generated URLs, e.g. noutbuki/laptops/ноутбуки. Optional; omitted searches the city root.'),
      category_path: z.string().optional().describe('Raw Avito category path for generated URLs, e.g. noutbuki.'),
      price_min: z.number().optional().describe('Min price for generated URLs; encoded as pmin.'),
      price_max: z.number().optional().describe('Max price for generated URLs; encoded as pmax.'),
      min_price: z.number().optional().describe('Alias for price_min.'),
      max_price: z.number().optional().describe('Alias for price_max.'),
      seller_type: z.string().optional().describe('For generated URLs: private/person/owner -> user=1; company/business/shop -> user=2. For complex cases pass user directly or use a prepared URL.'),
      seller: z.string().optional().describe('Alias for seller_type.'),
      tabId: z.number().optional().describe('Explicit existing Avito tab to read. If omitted and url is provided, a background tab is created and closed after extraction.'),
      max_pages: z.union([z.number(), z.string()]).optional().describe('Pages to fetch. Default 1. A number N fetches up to N pages. "all"/0 fetches up to hard cap 20 pages.'),
      limit: z.union([z.number(), z.string()]).optional().describe('Max unique listings to return. Default 100. "all"/0 returns all listings from fetched pages, capped by max_pages.'),
      photo_limit: z.number().optional().describe('Photos per listing from the search page. Default 5, max 20.'),
      detail_limit: z.number().optional().describe('Open and enrich the first N listings with item-detail extraction. Default 0, max 15.'),
      description_limit: z.number().optional().describe('Max description/snippet chars per listing/detail.'),
      f: z.string().optional().describe('Optional Avito encoded filter string to override URL f= param.'),
      user: z.union([z.number(), z.string()]).optional().describe('Optional Avito user filter query param, e.g. 1 for owners.'),
      localPriority: z.boolean().optional().describe('Optional localPriority query param.'),
      page: z.number().optional().describe('Start page. Default removes p= and starts from page 1.'),
      map_bbox: z.object({
        latBottom: z.number(),
        latTop: z.number(),
        lonLeft: z.number(),
        lonRight: z.number(),
        zoom: z.number().optional(),
      }).optional().describe('Optional Avito map search rectangle. Encoded into map={base64 JSON searchArea}.'),
    },
  },
  async ({
    url, search_url, query, q, search, city, region, category, category_path,
    price_min, price_max, min_price, max_price, seller_type, seller,
    tabId, max_pages, limit, photo_limit, detail_limit, description_limit,
    f, user, localPriority, page, map_bbox,
  }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_avito_search',
        tabId: tabId || null,
        url, search_url, query, q, search, city, region, category, category_path,
        price_min, price_max, min_price, max_price, seller_type, seller,
        max_pages, limit, photo_limit, detail_limit, description_limit, f, user, localPriority, page, map_bbox,
      });
      const { success, commandId, ...payload } = result;
      if (!success) return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'avito_item_detail',
  {
    description: 'Open an Avito listing and extract full detail: title, price, rooms/area/floor, address/metro, rental conditions, item sections, description, photos, seller, house links/reviews, and mini-chat preview if present.',
    inputSchema: {
      url: z.string().optional().describe('Avito item URL. Required unless an explicit tabId is provided.'),
      tabId: z.number().optional().describe('Explicit existing Avito tab to read. If omitted and url is provided, a background tab is created.'),
      photo_limit: z.number().optional().describe('Max photos. Default 12, max 50.'),
      description_limit: z.number().optional().describe('Max description chars. Default 12000.'),
      keep_open: z.boolean().optional().describe('If a background tab is created, keep it open. Default false.'),
    },
  },
  async ({ url, tabId, photo_limit, description_limit, keep_open }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_avito_item_detail',
        tabId: tabId || null,
        url, photo_limit, description_limit, keep_open,
      });
      const { success, commandId, ...payload } = result;
      if (!success) return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      return { content: [{ type: 'text', text: JSON.stringify(payload.detail, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'avito_messages_list',
  {
    description: 'Read Avito Messages inbox/channel list from the real browser profile. Returns recent channels with channel URL/id, user, item title/price, last message, datetime text, unread flag, tags, and unread counter. Optional query uses Avito inbox search by default. Does not open individual threads, so it is the safe way to inspect unread status.',
    inputSchema: {
      url: z.string().optional().describe('Avito messenger URL. Defaults to https://www.avito.ru/profile/messenger.'),
      tabId: z.number().optional().describe('Explicit existing Avito messenger tab to read. If omitted, a background tab is created and closed after extraction.'),
      query: z.string().optional().describe('Optional text query, e.g. "macbook" or "ноутбук". By default it is entered into Avito inbox search before extraction.'),
      q: z.string().optional().describe('Alias for query.'),
      search: z.string().optional().describe('Alias for query.'),
      unread_only: z.boolean().optional().describe('Return only channels that Avito currently marks as unread.'),
      use_avito_search: z.boolean().optional().describe('If query is provided, fill Avito inbox search input before extracting. Default true. If false, only locally filters visible/scroll-collected previews.'),
      limit: z.number().optional().describe('Max channels to return. Default 50, max 200.'),
      max_scrolls: z.number().optional().describe('Scroll the channel list this many times to collect more than the initially visible rows. Default 0, max 20.'),
      keep_open: z.boolean().optional().describe('For a created tab, keep it open. Default false.'),
    },
  },
  async ({ url, tabId, query, q, search, unread_only, use_avito_search, limit, max_scrolls, keep_open }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_avito_messages_list',
        tabId: tabId || null,
        url, query, q, search, unread_only, use_avito_search, limit, max_scrolls, keep_open,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'avito_thread_read',
  {
    description: 'Open and read one Avito messenger thread/channel. Returns header item/user, unread delimiter presence, messages with direction/time/read marker, composer state, and suggestions. Warning: opening an unread thread can mark it as read in Avito.',
    inputSchema: {
      url: z.string().optional().describe('Full Avito channel URL, e.g. https://www.avito.ru/profile/messenger/channel/... Required unless channel_url/channel_id or explicit tabId is provided.'),
      channel_url: z.string().optional().describe('Alias for url.'),
      channel_id: z.string().optional().describe('Channel id from avito_messages_list, e.g. u2i-... Used to build the channel URL.'),
      tabId: z.number().optional().describe('Explicit existing Avito messenger tab to read. If omitted and url/channel_id is provided, a background tab is created.'),
      limit: z.number().optional().describe('Max last messages to return. Default 120, max 300.'),
      keep_open: z.boolean().optional().describe('For a created tab, keep it open. Default false.'),
    },
  },
  async ({ url, channel_url, channel_id, tabId, limit, keep_open }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_avito_thread_read',
        tabId: tabId || null,
        url, channel_url, channel_id, limit, keep_open,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'avito_chat_read',
  {
    description: 'Open/read the Avito mini messenger for a listing. Returns raw thread text/lines, composer state, and tabId. Uses stable Avito data-marker selectors. If url is provided without tabId, a background tab is opened and kept open by default.',
    inputSchema: {
      url: z.string().optional().describe('Avito item URL. Required unless an explicit tabId is provided.'),
      tabId: z.number().optional().describe('Explicit existing Avito tab to read. If omitted and url is provided, a background tab is created.'),
      open_composer: z.boolean().optional().describe('Click "Написать сообщение" if the composer is not open. Default true.'),
      keep_open: z.boolean().optional().describe('For a created tab, keep it open. Default true; pass false to close after read.'),
    },
  },
  async ({ url, tabId, open_composer, keep_open }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_avito_chat_read',
        tabId: tabId || null,
        url, open_composer, keep_open,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'avito_message_draft',
  {
    description: 'Open an Avito listing messenger and draft a message into the textarea without sending. Returns chat/composer state and keeps a created tab open by default for visual inspection.',
    inputSchema: {
      url: z.string().optional().describe('Avito item URL. Required unless an explicit tabId is provided.'),
      tabId: z.number().optional().describe('Explicit existing Avito tab to draft in. If omitted and url is provided, a background tab is created.'),
      message: z.string(),
      keep_open: z.boolean().optional().describe('For a created tab, keep it open. Default true; pass false to close after drafting.'),
    },
  },
  async ({ url, tabId, message, keep_open }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_avito_message_draft',
        tabId: tabId || null,
        url, message, keep_open,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

server.registerTool(
  'avito_message_send',
  {
    description: 'Send an Avito listing message. Safety: the extension refuses before drafting/sending unless confirm=true. With confirm=true it drafts first, clicks Avito send, waits, then returns the thread state. A created tab stays open by default.',
    inputSchema: {
      url: z.string().optional().describe('Avito item URL. Required unless an explicit tabId is provided.'),
      tabId: z.number().optional().describe('Explicit existing Avito tab to send from. If omitted and url is provided, a background tab is created.'),
      message: z.string(),
      confirm: z.boolean().describe('Must be true; otherwise the tool returns an error without drafting or sending.'),
      keep_open: z.boolean().optional().describe('For a created tab, keep it open. Default true; pass false to close after send.'),
    },
  },
  async ({ url, tabId, message, confirm, keep_open }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_avito_message_send',
        tabId: tabId || null,
        url, message, confirm, keep_open,
      });
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  }
);

// ── Yandex Maps search ──────────────────────────────────────────────
server.registerTool(
  'yandex_maps_search',
  {
    description: 'Search organizations on Yandex Maps and return structured data (title, address, coordinates, phones, website, socials, rating, working hours, categories) WITHOUT any API key. Drives the real yandex.ru/maps tab and reads the embedded SSR search-state — no HTML scraping, no paid Search API. Location is set by region/ll/spn, NOT by scrolling. Paginates by navigating ?page=N (≈25 orgs/page) and de-dupes by org id. Deterministic coverage report: each call returns area_covered (bbox), fetched (unique orgs collected), total_in_area (Yandex\'s estimate — informational, can drift), remaining, complete (TRUE source of truth: did we reach the end of results), pages_fetched, stop_reason. Use the returned `site` to then navigate() + read each clinic\'s website. IMPORTANT for full coverage across a city, pin ll+spn (otherwise pages drift as the map viewport moves).',
    inputSchema: {
      query: z.string().describe('Search text, e.g. "осанка клиника" or "остеопат ВНЧС". Can include a city ("осанка спб") if region is omitted.'),
      region: z.string().optional().describe('City: "spb"/"msk"/"moscow" or a numeric Yandex region id (2=СПб, 213=Москва). Sets the search region deterministically. Omit to let Yandex infer from query text.'),
      ll: z.string().optional().describe('Map center "lon,lat". REQUIRED for reliable multi-page pagination (pins the area so pages stay consistent). Also lets you compute distance to each result locally.'),
      spn: z.string().optional().describe('Span "dLon,dLat" — size of the search area, e.g. "0.5,0.4" ≈ whole СПб. Pin together with ll for multi-page pagination. Bigger span → more results.'),
      z: z.number().optional().describe('Zoom level 10-17. Lower = wider area.'),
      max_pages: z.union([z.number(), z.string()]).optional().describe('How many pages to fetch (≈25 orgs each). Default 1 (first page only). A number N auto-paginates up to N pages. "all" (or 0) paginates to the end of results (hard cap 40 pages). Pagination stops early when a page returns no new orgs or fewer than a full page.'),
      tabId: z.number().optional().describe('Tab to drive. If omitted, uses the active tab. The tab will be navigated to the Yandex Maps search URL.'),
    },
  },
  async ({ query, region, ll, spn, z: zoom, max_pages, tabId }) => {
    try {
      const result = await sendToExtension({
        action: 'mcp_yandex_search',
        tabId: tabId || null,
        query, region, ll, spn, z: zoom, max_pages,
      });
      if (!result.success) return { content: [{ type: 'text', text: `Error: ${result.error}${result.url ? ' (url: ' + result.url + ')' : ''}` }] };
      const { success, commandId, ...payload } = result;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// ── Google AI Studio — ВЫНЕСЕНО на HTTP-канал ───────────────────────
// aistudio_run/aistudio_get_result удалены: AI Studio теперь запускается
// через тот же bridge HTTP что claude/perplexity —
//   POST /research-start {provider:'aistudio', prompt, options:{model}}
//   GET  /research-status?id=<aim_...>&wait=60000
// browser-MCP остаётся инструментом ЖИВОГО ПАРСИНГА (list_tabs/click/
// evaluate/snapshot), research-flow ему не место. См. external-research skill.

// ── Start ─────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Server running on stdio');
}

main().catch((err) => {
  console.error('[MCP] Fatal:', err);
  process.exit(1);
});
