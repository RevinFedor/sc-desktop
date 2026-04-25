import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Hono } from "hono";
import { commandService } from "../command-service/service.js";
import { loadConfig } from "../config.js";
import { saveScreenshotToTemp } from "../screenshot.js";

const config = loadConfig();

/** Strip null/undefined fields from an object recursively. */
function stripNulls(obj: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const mapped = obj.map(stripNulls).filter((x) => x !== undefined);
    return mapped.length > 0 ? mapped : undefined;
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const stripped = stripNulls(value);
      if (stripped !== undefined) result[key] = stripped;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  return obj;
}

// ============================================================
// Schema Definitions
// ============================================================

/** Shared target sub-object for page_read and page_act (#012). */
const targetSchema = z.object({
  css: z.string().optional(),
  text: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  testId: z.string().optional(),
});

// ── Full parameter schemas (used for manual validation after stub passes through) ──

const browsersSchema = z.object({
  summary: z.boolean().optional(),
});

const screenshotSchema = z.object({
  browser_id: z.string().optional(),
  browser_name: z.string().optional(),
  mode: z.enum(["sync", "async"]).optional(),
}).refine(data => data.browser_id || data.browser_name, {
  message: "Either browser_id or browser_name is required",
});


const executeAllSchema = z.object({
  tool: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const executeBatchSchema = z.object({
  commands: z.array(z.object({
    browser_id: z.string().optional(),
    browser_name: z.string().optional(),
    tool: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }).refine(data => data.browser_id || data.browser_name, {
    message: "Each command must have either browser_id or browser_name",
  })),
});

const pageReadSchema = z.object({
  browser_id: z.string().optional(),
  browser_name: z.string().optional(),
  frameId: z.number().optional(),
  frame_url: z.string().optional().describe("Target iframe by URL substring match (alternative to frameId)"),
  frame_name: z.string().optional().describe("Target iframe by name attribute (alternative to frameId)"),
  action: z.enum(["inspect", "content", "text", "html", "attr", "meta", "forms", "count", "select", "summary", "generate_selector"]),
  target: targetSchema.optional(),
  limit: z.number().optional(),
  include_hidden: z.boolean().optional(),
  compact: z.boolean().optional(),
  name: z.string().optional(),
  timeout_ms: z.number().optional(),
  mode: z.enum(["sync", "async"]).optional(),
}).refine(data => data.browser_id || data.browser_name, {
  message: "Either browser_id or browser_name is required",
});

const pageActSchema = z.object({
  browser_id: z.string().optional(),
  browser_name: z.string().optional(),
  frameId: z.number().optional(),
  frame_url: z.string().optional().describe("Target iframe by URL substring match (alternative to frameId)"),
  frame_name: z.string().optional().describe("Target iframe by name attribute (alternative to frameId)"),
  action: z.enum(["click", "fill", "check", "select_option", "press", "scroll", "submit", "wait_for", "type", "smart_click", "fill_form", "upload", "drag", "dblclick", "hover", "dialog_override", "dialog_respond"]),
  target: targetSchema.optional(),
  anchor: z.string().optional(),
  value: z.string().optional(),
  checked: z.boolean().optional(),
  key: z.string().optional(),
  keys: z.array(z.string()).optional(),
  direction: z.enum(["up", "down", "to_element"]).optional(),
  amount: z.number().optional(),
  timeout_ms: z.number().optional(),
  condition: z.enum(["exists", "visible", "hidden", "enabled", "disabled", "stable", "url", "network_idle", "load_state", "function"]).optional(),
  pattern: z.string().optional(),
  state: z.string().optional(),
  expression: z.string().optional(),
  idle_ms: z.number().optional(),
  poll_interval_ms: z.number().optional(),
  text: z.string().optional(),
  delay: z.number().optional(),
  click_delay_ms: z.number().optional().default(100).describe("Delay before click in ms (default 100, minimum 0)"),
  file_data: z.string().optional(),
  file_name: z.string().optional(),
  file_type: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  response: z.object({ confirm: z.boolean().optional(), prompt: z.string().optional() }).optional(),
  fields: z.array(z.object({
    anchor: z.string().optional(),
    target: z.object({ css: z.string().optional() }).optional(),
    value: z.string(),
  })).optional(),
  mode: z.enum(["sync", "async"]).optional(),
}).refine(data => data.browser_id || data.browser_name, {
  message: "Either browser_id or browser_name is required",
});

const pageJsSchema = z.object({
  browser_id: z.string().optional(),
  browser_name: z.string().optional(),
  frameId: z.number().optional(),
  frame_url: z.string().optional().describe("Target iframe by URL substring match (alternative to frameId)"),
  frame_name: z.string().optional().describe("Target iframe by name attribute (alternative to frameId)"),
  code: z.string(),
  timeout_ms: z.number().optional(),
  mode: z.enum(["sync", "async"]).optional(),
}).refine(data => data.browser_id || data.browser_name, {
  message: "Either browser_id or browser_name is required",
});

const tabsSchema = z.object({
  action: z.enum(["list", "navigate", "goBack", "goForward", "close"]),
  browser_id: z.string().optional(),
  browser_name: z.string().optional(),
  tab_id: z.number().optional(),
  url: z.string().url().optional(),
  wait_until: z.enum(["none", "domcontentloaded", "complete"]).optional(),
  timeout_ms: z.number().optional(),
  snapshot: z.boolean().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  mode: z.enum(["sync", "async"]).optional(),
}).refine(data => data.browser_id || data.browser_name, {
  message: "Either browser_id or browser_name is required",
});

const cookiesSchema = z.object({
  action: z.enum(["get", "set", "remove", "list"]),
  browser_id: z.string().optional(),
  browser_name: z.string().optional(),
  url: z.string(),
  name: z.string().optional(),
  value: z.string().optional(),
  mode: z.enum(["sync", "async"]).optional(),
}).refine(data => data.browser_id || data.browser_name, {
  message: "Either browser_id or browser_name is required",
});

const windowsSchema = z.object({
  action: z.enum(["list", "create", "focus", "close"]),
  browser_id: z.string().optional(),
  browser_name: z.string().optional(),
  url: z.string().optional(),
  window_id: z.number().optional(),
  mode: z.enum(["sync", "async"]).optional(),
}).refine(data => data.browser_id || data.browser_name, {
  message: "Either browser_id or browser_name is required",
});

/** Stub schema used for tool registration — help-first pattern (#017). */
const helpStub = z.object({
  help: z.boolean().optional().describe("Show full parameter reference instead of executing"),
}).passthrough();

// ============================================================
// Response Formatting
// ============================================================

/** Known ActionResult statuses from the extension API. */
const ACTION_RESULT_STATUSES = new Set(["performed", "already_in_desired_state", "not_performed", "ambiguous", "blocked"]);

/**
 * Check if a value looks like an ActionResult envelope from the extension.
 * ActionResult has { success, status, action, message, ...data }.
 * We strip the envelope and format the inner data with a clean message prefix.
 */
function isActionResult(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.success === "boolean" &&
    typeof v.status === "string" &&
    ACTION_RESULT_STATUSES.has(v.status) &&
    typeof v.action === "string"
  );
}

/**
 * Format an ActionResult envelope into a clean one-liner message + inner data.
 */
function formatActionResponse(data: Record<string, unknown>): string {
  const success = data.success as boolean;
  const message = data.message as string | undefined;
  const innerData = data.data as unknown;
  const targetSummary = data.targetSummary as string | undefined;

  const parts: string[] = [];
  const icon = success ? "✅" : "❌";
  if (message) {
    let line = `${icon} ${message}`;
    if (targetSummary) line += ` (target: ${targetSummary})`;
    parts.push(line);
  }

  // Render the inner data if present and non-empty
  if (innerData !== undefined && innerData !== null) {
    const formatted = formatResult(innerData, 0);
    if (formatted && formatted !== "(empty)" && formatted !== "null") {
      parts.push(formatted);
    }
  }

  // For failures, include suggestions if present
  if (!success) {
    const suggestions = data.suggestions as string[] | undefined;
    if (suggestions && suggestions.length > 0) {
      parts.push("Suggestions:");
      for (const s of suggestions) {
        parts.push(`  - ${s}`);
      }
    }
    const errorCode = data.errorCode as string | undefined;
    if (errorCode) parts.push(`Error code: ${errorCode}`);
  }

  return parts.join("\n");
}

/** Format a result value as human-readable plain text (#011). */
function formatResult(data: unknown, depth = 0): string {
  // Auto-detect and strip ActionResult envelopes at top level
  if (depth === 0 && isActionResult(data)) {
    return formatActionResponse(data as Record<string, unknown>);
  }

  // Auto-detect inspect/snapshot data (inner data) — render as compact tree
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (typeof d.url === "string" && typeof d.title === "string" && Array.isArray(d.anchors)) {
      return formatInspectResult(d);
    }
  }

  const indent = "  ".repeat(depth);
  if (data === null || data === undefined) return "(empty)";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (Array.isArray(data)) {
    if (data.length === 0) return "(empty)";
    return data.map((item, i) => {
      if (typeof item === "object" && item !== null) {
        return `${indent}[${i + 1}]\n${formatResult(item, depth + 1)}`;
      }
      return `${indent}[${i + 1}] ${formatResult(item, depth)}`;
    }).join("\n");
  }
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return "(empty)";
  return entries.map(([key, value]) => {
    if (typeof value === "object" && value !== null) {
      return `${indent}${key}:\n${formatResult(value, depth + 1)}`;
    }
    return `${indent}${key}: ${formatResult(value, depth)}`;
  }).join("\n");
}

/**
 * Format inspect/snapshot data as a compact accessibility tree (Playwright MCP style).
 * Detects data shaped like { url, title, anchors[] } and renders a scannable tree
 * that an AI agent can easily parse for element targeting.
 */
function formatInspectResult(data: Record<string, unknown>): string {
  const lines: string[] = [];

  // Page header
  lines.push("### Page");
  if (data.url) lines.push(`URL: ${data.url}`);
  if (data.title) lines.push(`Title: ${data.title}`);
  if (data.documentId) lines.push(`Document: ${data.documentId}`);

  // Anchor tree
  const anchors = data.anchors as Array<Record<string, unknown>> | undefined;
  if (anchors && anchors.length > 0) {
    lines.push("");
    lines.push("### Interactive Elements");
    for (const a of anchors) {
      const aid = a.anchor as string;
      const tag = a.tag as string;
      const text = a.text as string | undefined;

      // Build attribute suffix: [role=...], [placeholder="..."], [checked], etc.
      const attrs: string[] = [];
      if (a.role && a.role !== tag) attrs.push(`role=${a.role}`);
      if (a.placeholder) attrs.push(`placeholder="${a.placeholder}"`);
      if (a.type && a.type !== "text") attrs.push(`type=${a.type}`);
      if (a.checked === true) attrs.push("checked");
      if (a.selected === true) attrs.push("selected");
      if (a.disabled === true) attrs.push("disabled");

      const suffix = attrs.length > 0 ? " [" + attrs.join(", ") + "]" : "";
      const textPart = text ? ` "${text}"` : "";
      lines.push(`  [${aid}] ${tag}${textPart}${suffix}`);
    }
  } else if (anchors && anchors.length === 0) {
    lines.push("");
    lines.push("### Interactive Elements");
    lines.push("  (no interactable elements found)");
  }

  return lines.join("\n");
}

/** Format browser list as pipe-delimited text (#015). */
function formatBrowserList(browsers: unknown, summary = false): string {
  if (!Array.isArray(browsers) || browsers.length === 0) return "(no browsers connected)";
  return browsers.map((b: Record<string, unknown>) => {
    const capList = Array.isArray(b.capabilities) ? b.capabilities.join(", ") : "";
    if (summary) {
      return `id: ${b.id ?? "?"} | name: ${b.name ?? "?"} | capabilities: ${capList || "none"} | connected: ${Date.now() - (typeof b.lastHeartbeat === "number" ? b.lastHeartbeat : Date.now())}ms`;
    }
    const parts: string[] = [`id: ${b.id ?? "?"}`, `name: ${b.name ?? "?"}`];
    if (capList) parts.push(`capabilities: ${capList}`);
    if (typeof b.lastHeartbeat === "number") parts.push(`connected: ${Date.now() - b.lastHeartbeat}ms`);
    return parts.join(" | ");
  }).join("\n");
}

// ============================================================
// Browser Resolution — name or ID
// ============================================================

/**
 * Resolve a browser identifier, accepting either a browser_id or browser_name.
 * If browser_id is provided, it is returned directly.
 * If browser_name is provided, it is looked up via commandService.
 * Throws if neither or both are provided.
 */
async function resolveBrowserId(args: { browser_id?: string; browser_name?: string }): Promise<string> {
  if (args.browser_id && args.browser_name) {
    throw new Error("Provide either browser_id or browser_name, not both");
  }
  if (args.browser_id) return args.browser_id;
  if (args.browser_name) {
    const id = await commandService.findBrowserByName(args.browser_name);
    if (!id) throw new Error(`Browser "${args.browser_name}" not found`);
    return id;
  }
  throw new Error("Either browser_id or browser_name is required");
}

// ============================================================
// Help System
// ============================================================

/** Generate full parameter documentation for a specific tool (#017, #016). */
function generateToolHelp(toolName: string): string {
  const help: Record<string, string> = {
    browsers: [
      "## browsers",
      "",
      "List connected browsers with capabilities, status, and active tab info.",
      "",
      "### Parameters",
      "- `summary` (boolean, optional) — If true, return condensed summary (name, active tab URL, capabilities, connection age)",
      "",
      "### Output",
      "Pipe-delimited text with one line per browser. Summary mode returns 4 fields per line; full mode includes additional status and URL info.",
    ].join("\n"),

    screenshot: [
      "## screenshot",
      "",
      "Capture a screenshot of the active tab in a browser.",
      "",
      "### Parameters",
      "- `browser_id` (string, optional) — Target browser ID (provide this or browser_name)",
      "- `browser_name` (string, optional) — Target browser name (provide this or browser_id)",
      "",
      "### Output",
      "Returns the file path where the screenshot PNG was saved, or an error if capture failed.",
    ].join("\n"),





    execute_all: [
      "## execute_all",
      "",
      "Execute a tool on ALL connected browsers at once.",
      "",
      "### Parameters",
      "- `tool` (string, required) — Tool name to run (e.g. screenshots.capture)",
      "- `params` (object, optional) — Tool parameters as key-value pairs",
      "",
      "### Output",
      "Returns one result per browser, each with success status and data.",
    ].join("\n"),

    execute_batch: [
      "## execute_batch",
      "",
      "Execute multiple tools across browsers in parallel.",
      "",
      "### Parameters",
      "- `commands` (array, required) — Array of command objects, each with:",
      "  - `browser_id` (string, optional) — Target browser ID (provide this or browser_name)",
      "  - `browser_name` (string, optional) — Target browser name (provide this or browser_id)",
      "  - `tool` (string, required) — Tool to execute (e.g. tabs.list, page.read)",
      "  - `params` (object, optional) — Tool parameters",
      "",
      "### Output",
      "Returns an array of per-item results in the same order as the input commands.",
    ].join("\n"),

    tabs: [
      "## tabs",
      "",
      "List, navigate, and manipulate browser tabs. Use `action` to choose the operation.",
      "",
      "### Common Parameters",
      "- `action` (enum, required) — Which tab operation: list, navigate, goBack, goForward, close",
      "- `browser_id` (string, optional) — Target browser ID (provide this or browser_name)",
      "- `browser_name` (string, optional) — Target browser name (provide this or browser_id)",
      "- `tab_id` (number, optional) — Target tab ID (default: active tab for goBack/goForward/close)",
      "",
      "### Parameters (list)",
      "- `action` (enum) — `\"list\"` to list all open tabs",
      "- `limit` (number, optional) — Max tabs to return (default 100)",
      "- `offset` (number, optional) — Number of tabs to skip (default 0)",
      "",
      "### Parameters (navigate)",
      "- `action` (enum) — `\"navigate\"` to navigate to a URL",
      "- `url` (string, required) — The URL to navigate to",
      "- `tab_id` (number, optional) — Navigate an existing tab in-place (default: create new tab)",
      "- `wait_until` (enum, optional) — Load state to wait for: none, domcontentloaded, complete (default: complete)",
      "- `timeout_ms` (number, optional) — Max wait time in ms (default 30000)",
      "- `snapshot` (boolean, optional) — If true, run compact inspect after navigation and return anchors",
      "",
      "### Parameters (goBack)",
      "- `action` (enum) — `\"goBack\"` to navigate back in tab history",
      "- `tab_id` (number, optional) — Tab to go back in (default: active tab)",
      "",
      "### Parameters (goForward)",
      "- `action` (enum) — `\"goForward\"` to navigate forward in tab history",
      "- `tab_id` (number, optional) — Tab to go forward in (default: active tab)",
      "",
      "### Parameters (close)",
      "- `action` (enum) — `\"close\"` to close a tab",
      "- `tab_id` (number, optional) — Tab to close (default: active tab)",
      "",
      "### Output",
      "For list: returns tab list with IDs, URLs, and titles. For navigate/goBack/goForward: returns tabId, direction, and elapsed time. For close: returns confirmation.",
    ].join("\n"),

    page_read: [
      "## page_read",
      "",
      "Read page content without mutating it. Use `action` to choose an operation.",
      "",
      "### Quick Start",
      "```",
      "# See the page as an interactive element tree (recommended first step)",
      "page_read({ action: \"inspect\" })",
      "",
      "# Get the full visible text of the page",
      "page_read({ action: \"content\" })",
      "",
      "# Get page metadata (title, description, OG tags)",
      "page_read({ action: \"meta\" })",
      "```",
      "",
      "### Text-Based Targeting (Recommended)",
      "The `inspect` action returns a compact tree of interactable elements with anchor IDs.",
      "Use visible text to target elements — it's more stable than anchors across page reloads:",
      "```",
      "# Target by visible text (preferred)",
      "page_read({ action: \"inspect\", target: { text: \"Submit\" } })",
      "page_read({ action: \"text\", target: { text: \"Email\" } })",
      "```",
      "",
      "### Parameters",
      "- `browser_id` (string, optional) — Target browser ID (provide this or browser_name)",
      "- `browser_name` (string, optional) — Target browser name (provide this or browser_id)",
      "- `frameId` (number, optional) — Target frame ID for iframe isolation",
      "- `frame_url` (string, optional) — Target iframe by URL substring match (alternative to frameId)",
      "- `frame_name` (string, optional) — Target iframe by name attribute (alternative to frameId)",
      "- `action` (enum, required) — What to read: inspect, content, text, html, attr, meta, forms, count, select, summary, generate_selector",
      "- `target` (object, optional) — Structured target describing what to read:",
      "  - `text` (string) — Visible text to match (recommended primary targeting method)",
      "  - `css` (string) — CSS selector",
      "  - `role` (string) — ARIA role (use with `name` for accessible targeting)",
      "  - `name` (string) — Accessible name (used with role)",
      "  - `label` (string) — aria-label to match",
      "  - `placeholder` (string) — Placeholder text to match",
      "  - `testId` (string) — data-testid to match",
      "- `limit` (number, optional) — Max results (for inspect, text, html; default 50)",
      "- `include_hidden` (boolean, optional) — Include hidden elements in inspect",
      "- `compact` (boolean, optional) — Return minimal anchor fields (anchor+target+tag only, saves ~60% payload)",
      "- `name` (string, optional) — Attribute name (for attr action)",
      "- `timeout_ms` (number, optional) — Max wait time (default 120000)",
      "",
      "### Actions",
      "- `inspect` — Return a compact accessibility tree of interactable elements with anchor IDs and visible text (tree format output)",
      "- `content` — Return the full visible text content of the page (or a CSS-targeted element)",
      "- `text` — Return text content of matching elements",
      "- `html` — Return HTML of matching elements",
      "- `attr` — Read a specific attribute value from a matched element",
      "- `meta` — Return page metadata (title, description, OG tags, language)",
      "- `forms` — Return form structure with all fields, types, and options",
      "- `count` — Count elements matching a CSS selector",
      "- `select` — Return the currently selected text on the page",
      "- `summary` — Lightweight page overview (button count, form count, link count, content detection)",
      "- `generate_selector` — Generate ranked CSS selectors for a target element",
      "",
      "### Output",
      "Returns the page data as formatted text. `inspect` returns a compact accessibility tree:",
      "```",
      "### Page",
      "URL: https://example.com",
      "Title: Example Page",
      "",
      "### Interactive Elements",
      "  [a1] button \"Submit\"",
      "  [a2] textbox \"Email\" [placeholder=\"user@example.com\"]",
      "  [a3] link \"More info\"",
      "```",
    ].join("\n"),

    page_act: [
      "## page_act",
      "",
      "Interact with or mutate the page. Use `action` to choose an operation.",
      "",
      "### Quick Start",
      "```",
      "# Click by visible text (stable across page reloads)",
      "page_act({ action: \"click\", target: { text: \"Submit\" } })",
      "",
      "# Fill an input by its label text",
      "page_act({ action: \"fill\", target: { text: \"Email\" }, value: \"user@example.com\" })",
      "",
      "# Or use an anchor from inspect output (fast path)",
      "page_act({ action: \"click\", anchor: \"a3\" })",
      "```",
      "",
      "### Text-Based Targeting (Recommended)",
      "Target elements using visible text — this is the most stable approach and survives page reloads:",
      "```",
      "# Button or link labeled \"Submit\"",
      "page_act({ action: \"click\", target: { text: \"Submit\" } })",
      "",
      "# Input field with visible label \"Email\"",
      "page_act({ action: \"fill\", target: { text: \"Email\" }, value: \"hello@test.com\" })",
      "",
      "# Checkbox with visible text",
      "page_act({ action: \"check\", target: { text: \"Remember me\" } })",
      "```",
      "",
      "### Anchor Fast-Path",
      "Use anchor IDs from `page_read(inspect)` for the fastest execution (skips CSS resolution).",
      "Anchors are single-use and invalidated on page navigation:",
      "```",
      "# Fast path — anchor from inspect output",
      "page_act({ action: \"click\", anchor: \"a7\" })",
      "```",
      "",
      "### Parameters",
      "- `browser_id` (string, optional) — Target browser ID (provide this or browser_name)",
      "- `browser_name` (string, optional) — Target browser name (provide this or browser_id)",
      "- `frameId` (number, optional) — Target frame ID for iframe isolation",
      "- `frame_url` (string, optional) — Target iframe by URL substring match (alternative to frameId)",
      "- `frame_name` (string, optional) — Target iframe by name attribute (alternative to frameId)",
      "- `action` (enum, required) — Action to perform: click, fill, check, select_option, press, scroll, submit, wait_for, type, smart_click, fill_form, upload, drag, dblclick, hover, dialog_override, dialog_respond",
      "- `target` (object, optional) — Element selector: prefer `{ text: \"visible label\" }` for stable targeting",
      "  - `text` (string) — Visible text to match (recommended primary targeting method)",
      "  - `css` (string) — CSS selector",
      "  - `role` (string) — ARIA role (use with `name`)",
      "  - `name` (string) — Accessible name",
      "- `anchor` (string, optional) — Anchor ID from inspect (fast path, invalidated on navigation)",
      "- `value` (string, optional) — Value to fill or select",
      "- `checked` (boolean, optional) — Desired checked state (for check action)",
      "- `key` (string, optional) — Key to press (for press action)",
      "- `keys` (array, optional) — Key combination (e.g. ['Control', 'a'])",
      "- `direction` (enum, optional) — Scroll direction: up, down, to_element",
      "- `amount` (number, optional) — Scroll amount in pixels",
      "- `timeout_ms` (number, optional) — Timeout in ms (default 10000)",
      "- `condition` (enum, optional) — Wait condition: exists, visible, hidden, enabled, disabled, stable, url, network_idle, load_state, function",
      "- `pattern` (string, optional) — URL pattern (for wait_for condition=url)",
      "- `state` (string, optional) — DOM readyState (for wait_for condition=load_state)",
      "- `expression` (string, optional) — JS expression (for wait_for condition=function)",
      "- `idle_ms` (number, optional) — Network idle threshold ms",
      "- `poll_interval_ms` (number, optional) — Polling interval ms (default 100)",
      "- `text` (string, optional) — Text to type (for type action)",
      "- `delay` (number, optional) — Ms between keystrokes (for type action, default 30)",
      "- `file_data` (string, optional) — Base64-encoded file content (for upload action)",
      "- `file_name` (string, optional) — Upload file name",
      "- `file_type` (string, optional) — Upload file MIME type",
      "- `x` (number, optional) — Target X coordinate (for drag action)",
      "- `y` (number, optional) — Target Y coordinate (for drag action)",
      "- `response` (object, optional) — Dialog response: { confirm?, prompt? } (for dialog_respond action)",
      "- `fields` (array, optional) — Array of { anchor?, target?, value } (for fill_form action)",
      "",
      "### Output",
      "Returns a confirmation message with action result. Success: `✅ Clicked \"Submit\"`. Failure: error with suggestions.",
    ].join("\n"),

    page_js: [
      "## page_js",
      "",
      "Execute arbitrary JavaScript on the page — gated escape hatch. Use only when page_read and page_act cannot express the task.",
      "",
      "### Parameters",
      "- `browser_id` (string, optional) — Target browser ID (provide this or browser_name)",
      "- `browser_name` (string, optional) — Target browser name (provide this or browser_id)",
      "- `frameId` (number, optional) — Target frame ID for iframe isolation",
      "- `frame_url` (string, optional) — Target iframe by URL substring match (alternative to frameId)",
      "- `frame_name` (string, optional) — Target iframe by name attribute (alternative to frameId)",
      "- `code` (string, required) — JavaScript code to execute (must return JSON-serializable value)",
      "- `timeout_ms` (number, optional) — Max wait time in ms (default 120000)",
      "",
      "### Output",
      "Returns the JavaScript execution result as evaluated JSON.",
    ].join("\n"),

    cookies: [
      "## cookies",
      "",
      "Manage browser cookies. Supports get, set, remove, and list operations via the `action` parameter.",
      "",
      "### Parameters",
      "- `action` (enum, required) — Cookie operation: get, set, remove, list",
      "- `browser_id` (string, optional) — Target browser ID (provide this or browser_name)",
      "- `browser_name` (string, optional) — Target browser name (provide this or browser_id)",
      "- `url` (string, required) — URL scope for the cookie",
      "- `name` (string, optional) — Cookie name (required for get, set, remove)",
      "- `value` (string, optional) — Cookie value (required for set)",
      "",
      "### Output",
      "Returns cookie data: single cookie for get, success confirmation for set/remove, or cookie list for list.",
    ].join("\n"),

    windows: [
      "## windows",
      "",
      "Manage browser windows. Supports list, create, focus, and close operations via the `action` parameter.",
      "",
      "### Parameters",
      "- `action` (enum, required) — Window operation: list, create, focus, close",
      "- `browser_id` (string, optional) — Target browser ID (provide this or browser_name)",
      "- `browser_name` (string, optional) — Target browser name (provide this or browser_id)",
      "- `url` (string, optional) — URL to open in the new window (for create)",
      "- `window_id` (number, optional) — Window ID (required for focus, close)",
      "",
      "### Output",
      "Returns window list for list, success confirmation for create/focus/close.",
    ].join("\n"),
  };

  return help[toolName] ?? `No help available for \`${toolName}\`.`;
}

/** Generate the full system reference document (#018). */
function getSystemReference(topic?: string): string {
  const full = [
    "# BrowserPowers System Reference",
    "",
    "## Overview",
    "BrowserPowers is a browser automation system that exposes browser capabilities through the Model Context Protocol (MCP). It provides programmatic access to browser tabs, page content, cookies, windows, screenshots, and JavaScript execution.",
    "",
    "## Tool Groups",
    "",
    "### Browser Management",
    "- `browsers` — List connected browsers with capabilities and status",
    "- `screenshot` — Capture a screenshot of the active tab",
    "- `execute_all` — Execute a tool on ALL connected browsers",
    "- `execute_batch` — Execute multiple tools across browsers in parallel",
    "- `tabs` — List, navigate, go back/forward, and close browser tabs",
    "",
    "### Page Interaction",
    "- `page_read` — Read page content (inspect, text, html, attr, etc.)",
    "- `page_act` — Interact with or mutate the page (click, fill, type, etc.)",
    "- `page_js` — Execute JavaScript on the page (gated escape hatch)",
    "",
    "### Browser State",
    "- `cookies` — Manage cookies (get, set, remove, list)",
    "- `windows` — Manage windows (list, create, focus, close)",
    "",
    "## Navigation Workflow",
      "1. `browsers` — Find a connected browser by ID or name",
      "2. `tabs({ action: \"navigate\", url })` — Navigate to a URL (use `snapshot: true` for the page tree)",
      "3. `page_read({ action: \"inspect\" })` — See all interactable elements as a compact tree",
      "4. `page_act` — Interact using text targeting or anchor fast-path",
      "",
      "## Element Targeting (Text-First)",
      "Three targeting strategies, in order of preference:",
      "",
      "1. **Text targeting (most stable)** — `target: { text: \"Submit\" }` survives page reloads",
      "2. **Anchor fast-path (fastest)** — `anchor: \"a7\"` from inspect output, skips CSS resolution",
      "3. **CSS / Role targeting** — `target: { css: \"#id\" }` or `target: { role: \"button\", name: \"Submit\" }`",
      "",
      "## Gate / Approval Model",
    "Some tools require gate approval before execution:",
    "- `page_js` requires explicit gate approval (gated escape hatch)",
    "- Browser connection requires user approval",
    "- Cookie and window operations are gated at the group level",
    "",
    "## Per-Tool Help",
    "Every tool accepts a `help: true` parameter that returns full parameter documentation without executing. Use this to explore tool capabilities before making real calls.",
    "",
    "Example: call any tool with `{ help: true }` to see its parameter reference.",
    "",
    "## Connection Lifecycle",
    "1. Client connects via MCP over streamable HTTP",
    "2. Server assigns a session ID",
    "3. Client sends tool requests within the session",
    "4. Session ends via DELETE or timeout",
    "",
    "## Rate Limits & Constraints",
    "- `page_js` is intentionally slow — prefer `page_read`/`page_act` for standard operations",
    "- Screenshots are saved to temp files and the path is returned",
    "- Each browser connection has its own capabilities set",
  ].join("\n");

  if (!topic) return full;

  const topics: Record<string, string> = {
    navigation: [
      "## Navigation Workflow",
      "",
      "Start by listing connected browsers, then navigate to a URL, then interact with the page.",
      "",
      "1. `browsers` — Find a connected browser and get its ID (or use `browser_name`)",
      "2. `tabs` with `action: \"navigate\"` — Navigate to a target URL",
      "   - Set `snapshot: true` to get the page accessibility tree and anchors",
      "   - Set `wait_until` to control load timing",
      "3. `page_read` — Start here to understand the page. Use `action: \"inspect\"` to get a compact tree of all interactable elements with their visible text and anchor IDs.",
      "   - Text-based targeting is recommended: `page_read({ target: { text: \"Email\" } })`",
      "4. `page_act` — Interact with elements. Target by visible text, anchor ID, or CSS selector.",
      "   - Most stable: `page_act({ action: \"click\", target: { text: \"Submit\" } })`",
      "   - Fastest: `page_act({ action: \"click\", anchor: \"a7\" })`",
    ].join("\n"),

    anchors: [
      "## Element Targeting (Text-First)",
      "",
      "BrowserPowers supports three targeting strategies, in order of preference:",
      "",
      "### 1. Text Targeting (Most Stable)",
      "Target elements by their visible text. This survives page reloads and is the most intuitive:",
      "```",
      "page_act({ action: \"click\", target: { text: \"Submit\" } })",
      "page_act({ action: \"fill\", target: { text: \"Email\" }, value: \"user@example.com\" })",
      "page_act({ action: \"check\", target: { text: \"Remember me\" } })",
      "```",
      "The `inspect` output shows all element text, making text targeting straightforward.",
      "",
      "### 2. Anchor Fast-Path (Fastest)",
      "Anchors are element IDs returned by `page_read({ action: \"inspect\" })`. They bypass CSS ",
      "selector resolution for the fastest execution. Invalidated on page navigation:",
      "```",
      "page_act({ action: \"click\", anchor: \"a7\" })",
      "```",
      "Benefits: No selector ambiguity, works with shadow DOM, fastest path.",
      "",
      "### 3. CSS / Role Targeting",
      "CSS selectors, ARIA role+name, labels, placeholders, and test IDs for precise targeting:",
    ].join("\n"),

    gates: [
      "## Gate / Approval Model",
      "",
      "BrowserPowers uses a gate system for sensitive operations:",
      "",
      "- **Browser connection**: Users must approve browser connections",
      "- **page_js**: JavaScript execution requires explicit gate approval — this is a gated escape hatch",
      "- **Cookies**: Cookie operations are gated at the group level (one gate for all cookie ops)",
      "- **Windows**: Window operations are gated at the group level",
      "",
      "When a gate is triggered, the tool returns an error indicating approval is needed.",
    ].join("\n"),
  };

  return topics[topic] ?? `No topic found for "${topic}". Available topics: navigation, anchors, gates.`;
}

// ============================================================
// MCP Server
// ============================================================

/**
 * Creates the MCP server and mounts it on the Hono app at config.mcp.path.
 * Uses streamable HTTP transport — supports multiple simultaneous clients.
 * Each client gets its own session, but all share the same McpServer tools.
 */
export function mountMcpServer(app: Hono): void {
  if (!config.mcp.enabled) {
    console.log("[mcp] MCP endpoint disabled in config");
    return;
  }

  // MCP Server — tool definitions live here (shared across all sessions)
  const mcpServer = new McpServer(
    {
      name: "browserpowers",
      version: "1.0.0",
    },
    {
      instructions: [
        "BrowserPowers is a browser automation system providing tools for browser management, navigation, page interaction, cookies, windows, and JavaScript execution.",
        "",
        "Quick workflow: browsers → tabs(navigate, snapshot:true) → page_read(inspect) for element tree → page_act(click/fill) to interact.",
        "",
        "Text-first targeting (recommended): use visible text to target elements — survives page reloads.",
        "  page_act({ action: \"click\", target: { text: \"Submit\" } })",
        "  page_act({ action: \"fill\", target: { text: \"Email\" }, value: \"...\" })",
        "",
        "Anchor fast-path: page_read(inspect) returns anchor IDs. Use them with page_act's anchor field for fastest execution.",
        "  page_act({ action: \"click\", anchor: \"a7\" })",
        "",
        "Gate model: page_js requires gate approval; cookies and windows are gated at the group level.",
        "",
        "Help: call any tool with { help: true } for full parameter documentation. Call the global `help` tool for the complete system reference.",
      ].join("\n"),
    },
  );

  // ── Tools ──

  // browsers
  mcpServer.registerTool(
    "browsers",
    {
      description: "List connected browsers with capabilities, status, and active tab info.",
      inputSchema: helpStub,
    },
    async (args: Record<string, unknown>) => {
      if (args.help) return { content: [{ type: "text" as const, text: generateToolHelp("browsers") }] };
      const { summary } = browsersSchema.parse(args);
      const browsers = await commandService.listBrowsers();
      return {
        content: [{ type: "text" as const, text: formatBrowserList(browsers, summary) }],
      };
    },
  );

  // screenshot
  mcpServer.registerTool(
    "screenshot",
    {
      description: "Capture a screenshot of the active tab in a browser.",
      inputSchema: helpStub,
    },
    async (args: Record<string, unknown>) => {
      if (args.help) return { content: [{ type: "text" as const, text: generateToolHelp("screenshot") }] };
      const parsed = screenshotSchema.parse(args);
      const browser_id = await resolveBrowserId(parsed);

      if (parsed.mode === "async") {
        const { requestId } = await commandService.executeAsync(browser_id, "screenshots.capture", {});
        return { content: [{ type: "text" as const, text: `⏳ Queued as ${requestId}. Poll GET /api/results/${requestId} for the result.` }] };
      }

      const result = await commandService.execute(browser_id, "screenshots.capture", {});
      if (!result.success) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      const data = result.data as { base64?: string } | undefined;
      if (data?.base64) {
        const { filePath } = await saveScreenshotToTemp(data.base64, browser_id);
        return {
          content: [{ type: "text" as const, text: `Screenshot saved to ${filePath}` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: "Screenshot returned no data" }],
        isError: true,
      };
    },
  );

  // tabs (consolidated from browser_list_tabs + tabs_navigate)
  mcpServer.registerTool(
    "tabs",
    {
      description: "List and navigate browser tabs. Use `action` to choose the operation.",
      inputSchema: helpStub,
    },
    async (args: Record<string, unknown>) => {
      if (args.help) return { content: [{ type: "text" as const, text: generateToolHelp("tabs") }] };
      const parsed = tabsSchema.parse(args);
      const { action, url, wait_until, timeout_ms, snapshot, limit, offset, tab_id } = parsed;
      const browser_id = await resolveBrowserId(parsed);

      let command: string;
      let params: Record<string, unknown>;

      switch (action) {
        case "list":
          command = "tabs.list";
          params = {};
          if (limit !== undefined) params.limit = limit;
          if (offset !== undefined) params.offset = offset;
          break;
        case "navigate":
          command = "tabs.navigate";
          params = { url } as Record<string, unknown>;
          if (tab_id !== undefined) params.tabId = tab_id;
          if (wait_until !== undefined) params.wait_until = wait_until;
          if (timeout_ms !== undefined) params.timeout_ms = timeout_ms;
          if (snapshot !== undefined) params.snapshot = snapshot;
          break;
        case "goBack":
          command = "tabs.goBack";
          params = {};
          if (tab_id !== undefined) params.tabId = tab_id;
          break;
        case "goForward":
          command = "tabs.goForward";
          params = {};
          if (tab_id !== undefined) params.tabId = tab_id;
          break;
        case "close":
          command = "tabs.close";
          params = {};
          if (tab_id !== undefined) params.tabId = tab_id;
          break;
      }

      if (parsed.mode === "async") {
        const { requestId } = await commandService.executeAsync(browser_id, command, params);
        return { content: [{ type: "text" as const, text: `⏳ Queued as ${requestId}. Poll GET /api/results/${requestId} for the result.` }] };
      }

      const result = await commandService.execute(browser_id, command, params);
      if (!result.success) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: formatResult(result.data) }] };
    },
  );

  // execute_all
  mcpServer.registerTool(
    "execute_all",
    {
      description: "Execute a tool on ALL connected browsers at once.",
      inputSchema: helpStub,
    },
    async (args: Record<string, unknown>) => {
      if (args.help) return { content: [{ type: "text" as const, text: generateToolHelp("execute_all") }] };
      const { tool, params } = executeAllSchema.parse(args);
      const results = await commandService.executeAll(tool, params ?? {});
      return {
        content: [{ type: "text" as const, text: formatResult(stripNulls(results)) }],
      };
    },
  );

  // execute_batch
  mcpServer.registerTool(
    "execute_batch",
    {
      description: "Execute multiple tools across browsers in parallel. Returns an array of per-item results.",
      inputSchema: helpStub,
    },
    async (args: Record<string, unknown>) => {
      if (args.help) return { content: [{ type: "text" as const, text: generateToolHelp("execute_batch") }] };
      const { commands } = executeBatchSchema.parse(args);
      const resolved = await Promise.all(commands.map(async (cmd: { browser_id?: string; browser_name?: string; tool: string; params?: Record<string, unknown> }) => ({
        browserId: await resolveBrowserId(cmd),
        tool: cmd.tool,
        params: cmd.params ?? {},
      })));
      const results = await commandService.executeBatch(resolved);
      return {
        content: [{ type: "text" as const, text: formatResult(stripNulls(results)) }],
      };
    },
  );

  // ── V2 Page tools ──

  // page_read
  mcpServer.registerTool(
    "page_read",
    {
      description: "Read page content without mutating it. Use `action` to choose an operation.",
      inputSchema: helpStub,
    },
    async (args: Record<string, unknown>) => {
      if (args.help) return { content: [{ type: "text" as const, text: generateToolHelp("page_read") }] };
      const parsed = pageReadSchema.parse(args);
      const resolvedId = await resolveBrowserId(parsed);
      const { browser_id: _bid, browser_name: _bn, mode, ...pageParams } = parsed;

      if (mode === "async") {
        const { requestId } = await commandService.executeAsync(resolvedId, "page.read", pageParams);
        return { content: [{ type: "text" as const, text: `⏳ Queued as ${requestId}. Poll GET /api/results/${requestId} for the result.` }] };
      }

      const result = await commandService.execute(resolvedId, "page.read", pageParams);
      if (!result.success) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: formatResult(result.data) }] };
    },
  );

  // page_act
  mcpServer.registerTool(
    "page_act",
    {
      description: "Interact with or mutate the page. Use `action` to choose an operation.",
      inputSchema: helpStub,
    },
    async (args: Record<string, unknown>) => {
      if (args.help) return { content: [{ type: "text" as const, text: generateToolHelp("page_act") }] };
      const parsed = pageActSchema.parse(args);
      const resolvedId = await resolveBrowserId(parsed);
      const { browser_id: _bid, browser_name: _bn, mode, ...pageParams } = parsed;

      if (mode === "async") {
        const { requestId } = await commandService.executeAsync(resolvedId, "page.act", pageParams);
        return { content: [{ type: "text" as const, text: `⏳ Queued as ${requestId}. Poll GET /api/results/${requestId} for the result.` }] };
      }

      const result = await commandService.execute(resolvedId, "page.act", pageParams);
      if (!result.success) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: formatResult(result.data) }] };
    },
  );

  // page_js
  mcpServer.registerTool(
    "page_js",
    {
      description: "Execute arbitrary JavaScript on the page — gated escape hatch.",
      inputSchema: helpStub,
    },
    async (args: Record<string, unknown>) => {
      if (args.help) return { content: [{ type: "text" as const, text: generateToolHelp("page_js") }] };
      const parsed = pageJsSchema.parse(args);
      const browser_id = await resolveBrowserId(parsed);
      const { code, timeout_ms, mode } = parsed;

      if (mode === "async") {
        const { requestId } = await commandService.executeAsync(browser_id, "page.js", { code, timeout_ms });
        return { content: [{ type: "text" as const, text: `⏳ Queued as ${requestId}. Poll GET /api/results/${requestId} for the result.` }] };
      }

      const result = await commandService.execute(browser_id, "page.js", { code, timeout_ms });
      if (!result.success) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: formatResult(result.data) }] };
    },
  );

  // ── Cookies tool (consolidated from cookies_get/set/remove/list) (#006) ──

  mcpServer.registerTool(
    "cookies",
    {
      description: "Manage browser cookies. Supports get, set, remove, and list operations via the `action` parameter.",
      inputSchema: helpStub,
    },
    async (args: Record<string, unknown>) => {
      if (args.help) return { content: [{ type: "text" as const, text: generateToolHelp("cookies") }] };
      const parsed = cookiesSchema.parse(args);
      const browser_id = await resolveBrowserId(parsed);
      const { action, url, name, value, mode } = parsed;

      let command: string;
      let params: Record<string, unknown>;

      switch (action) {
        case "get":
          command = "cookies.get";
          params = { url, name };
          break;
        case "set":
          command = "cookies.set";
          params = { url, name, value };
          break;
        case "remove":
          command = "cookies.remove";
          params = { url, name };
          break;
        case "list":
          command = "cookies.list";
          params = { url };
          break;
      }

      if (mode === "async") {
        const { requestId } = await commandService.executeAsync(browser_id, command, params);
        return { content: [{ type: "text" as const, text: `⏳ Queued as ${requestId}. Poll GET /api/results/${requestId} for the result.` }] };
      }

      const result = await commandService.execute(browser_id, command, params);
      if (!result.success) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: formatResult(result.data) }] };
    },
  );

  // ── Windows tool (consolidated from windows_list/create/focus/close) (#007) ──

  mcpServer.registerTool(
    "windows",
    {
      description: "Manage browser windows. Supports list, create, focus, and close operations via the `action` parameter.",
      inputSchema: helpStub,
    },
    async (args: Record<string, unknown>) => {
      if (args.help) return { content: [{ type: "text" as const, text: generateToolHelp("windows") }] };
      const parsed = windowsSchema.parse(args);
      const browser_id = await resolveBrowserId(parsed);
      const { action, url, window_id, mode } = parsed;

      // Enhanced list: chrome.windows.getAll({ populate: true }) already includes tabs
      if (action === "list") {
        if (mode === "async") {
          const { requestId } = await commandService.executeAsync(browser_id, "windows.list", {});
          return { content: [{ type: "text" as const, text: `⏳ Queued as ${requestId}. Poll GET /api/results/${requestId} for the result.` }] };
        }
        const windowsResult = await commandService.execute(browser_id, "windows.list", {});
        if (!windowsResult.success) {
          return { content: [{ type: "text" as const, text: `Error: ${windowsResult.error}` }], isError: true };
        }
        const windowsData = Array.isArray(windowsResult.data) ? windowsResult.data as Array<Record<string, unknown>> : [];
        const enriched = windowsData.map((w) => ({
          ...w,
          tabCount: Array.isArray(w.tabs) ? w.tabs.length : 0,
        }));
        return { content: [{ type: "text" as const, text: formatResult(enriched) }] };
      }

      let command: string;
      let params: Record<string, unknown>;

      switch (action) {
        case "create":
          command = "windows.create";
          params = { url };
          break;
        case "focus":
          command = "windows.focus";
          params = { window_id };
          break;
        case "close":
          command = "windows.close";
          params = { window_id };
          break;
      }

      if (mode === "async") {
        const { requestId } = await commandService.executeAsync(browser_id, command, params);
        return { content: [{ type: "text" as const, text: `⏳ Queued as ${requestId}. Poll GET /api/results/${requestId} for the result.` }] };
      }

      const result = await commandService.execute(browser_id, command, params);
      if (!result.success) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: formatResult(result.data) }] };
    },
  );

  // ── Global help meta-tool (#018) ──

  mcpServer.registerTool(
    "help",
    {
      description: "Get the full system reference — capability summary, workflow guides, tool relationships, and how everything fits together.",
      inputSchema: z.object({
        topic: z.string().optional().describe("Optional topic to focus on (e.g. 'navigation', 'anchors', 'gates')"),
      }),
    },
    async ({ topic }: { topic?: string }) => {
      return { content: [{ type: "text" as const, text: getSystemReference(topic) }] };
    },
  );

  // ── Session management (streamable HTTP) ──

  // Map of sessionId → transport (for stateful sessions)
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  const mcpPath = config.mcp.path;

  // POST — all MCP requests come through here
  app.post(mcpPath, async (c) => {
    const req = c.req.raw;
    const sessionId = req.headers.get("mcp-session-id");

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing transport for this session
      const transport = transports.get(sessionId)!;
      const res = await transport.handleRequest(req);
      return res;
    }

    // New initialization — check if this is an initialize request
    const body = await req.clone().json().catch(() => null);

    if (sessionId && !transports.has(sessionId)) {
      // Session ID provided but not found — server was restarted
      return c.json({
        error: "Session not found",
        code: "SESSION_STALE",
        message: "The server was restarted. The client must send a new initialize request.",
      }, 410);
    }

    if (!body || !isInitializeRequest(body)) {
      return c.json({ error: "Invalid MCP request — expected initialize request for new session" }, 400);
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
        console.log(`[mcp] New session initialized: ${sid}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
        console.log(`[mcp] Session closed: ${transport.sessionId}`);
      }
    };

    await mcpServer.connect(transport);
    const res = await transport.handleRequest(req);
    return res;
  });

  // DELETE — session cleanup (clients send DELETE to close sessions)
  app.delete(mcpPath, async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.close();
      transports.delete(sessionId);
      console.log(`[mcp] Session deleted: ${sessionId}`);
    }
    return c.body(null, 204);
  });

  // GET — SSE stream (for server-initiated notifications)
  app.get(mcpPath, async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      const res = await transport.handleRequest(c.req.raw);
      return res;
    }
    return c.json({ error: "No active session" }, 400);
  });

  console.log(`[mcp] MCP server mounted at http://localhost:${config.port}${mcpPath}`);
}
