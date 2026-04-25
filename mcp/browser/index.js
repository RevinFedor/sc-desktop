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
