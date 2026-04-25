/**
 * FILE: extension/entrypoints/content.ts
 * PURPOSE: Persistent content script entrypoint — handles all DOM interaction messages from
 *          the service worker by dispatching to real TypeScript functions in content-actions.ts.
 * OWNS: Message dispatch hub for bp:read, bp:act, bp:js messages in the page context.
 * EXPORTS: WXT content script via defineContentScript (global)
 * DOCS: .agents/reports/plan_content-script-arch_2026-05-28.md
 */

import {
  // Target resolution & inspection
  resolveTarget,
  inspectElements,
  listFrames,
  // Act actions
  clickElement,
  fillElement,
  checkElement,
  selectOption,
  pressKeys,
  scrollElement,
  submitForm,
  typeText,
  uploadFile,
  dragElement,
  dblclickElement,
  hoverElement,
  // Dialog
  dialogOverride,
  dialogRespond,
  // Wait conditions
  waitForElement,
  waitForTarget,
  waitForNetworkIdle,
  waitForFunction,
  // Batch
  fillFormFields,
  // Read
  readContent,
  readTexts,
  readHtml,
  readAttr,
  readMeta,
  readForms,
  countElements,
  selectText,
  readSummary,
  generateSelector,
} from "../src/v2/content-actions";
import type { Target, ActResult } from "../src/v2/content-actions";

// ── Console Capture Buffer ──
// The MAIN world override (from capture.js, registered via
// registerContentScripts({ world: "MAIN" })) writes entries to a shared DOM
// <meta id="__bp_pipe"> via data-e attribute. The content script watches this
// element via MutationObserver — the DOM is genuinely shared between worlds.
// This bypasses broken postMessage and executeScript({ world: "MAIN" }) paths.

const CONSOLE_MAX = 500;
const consoleBuffer: Array<{ level: string; messages: unknown[]; timestamp: number; stack?: string }> = [];

// Set up pipe element and observer at module scope (runs at document_start).
// The pipe is created early so capture.js (MAIN world, document_start) can
// find it when it runs.
if (typeof MutationObserver !== 'undefined') {
  const pipe = document.createElement('meta');
  pipe.id = '__bp_pipe';
  (document.head || document.documentElement).appendChild(pipe);
  const obs = new MutationObserver(() => {
    const raw = pipe.getAttribute('data-e');
    if (!raw) return;
    try {
      const entry = JSON.parse(raw);
      consoleBuffer.push(entry);
      if (consoleBuffer.length > CONSOLE_MAX) {
        consoleBuffer.splice(0, consoleBuffer.length - CONSOLE_MAX);
      }
    } catch { /* malformed JSON — skip */ }
  });
  obs.observe(pipe, { attributes: true, attributeFilter: ['data-e'] });
}

// ── Console Entry Type ──
interface ConsoleEntry { level: string; messages: unknown[]; timestamp: number; stack?: string; }

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  main() {
    // Console capture is handled by capture.js (registered via
    // registerContentScripts({ world: "MAIN" })) which overrides console in the
    // page's MAIN world and pipes entries via a shared DOM <meta> element.
    // The MutationObserver at module scope (above) buffers them.

    chrome.runtime.onMessage.addListener(
      (
        message: { source: string; type: string; action?: string; params?: Record<string, unknown> },
        _sender,
        sendResponse,
      ) => {
        if (message.source !== "browserpowers") return false;

        handleMessage(message).then(sendResponse).catch((err) => {
          sendResponse({ success: false, message: `Content script error: ${(err as Error).message}`, errorCode: "CONTENT_SCRIPT_ERROR" });
        });
        return true; // keep channel open for async
      },
    );
  },
});

// ── DOM Readiness Guard ──

function ensureReady(): Promise<void> {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
  });
}

// ── Message Handler ──

async function handleMessage(
  message: { source: string; type: string; action?: string; params?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  try {
    switch (message.type) {
      case "bp:read":
        return handleRead(message.action || "", message.params || {});
      case "bp:act":
        return handleAct(message.action || "", message.params || {});
      case "bp:js":
        return handleJs(message.params || {});
      default:
        return { success: false, message: `Unknown message type: ${message.type}`, errorCode: "UNKNOWN_TYPE" };
    }
  } catch (err) {
    return { success: false, message: `Handler error: ${(err as Error).message}`, errorCode: "HANDLER_ERROR" };
  }
}

// ── Read Handler ──

async function handleRead(
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureReady();

  switch (action) {
    case "inspect": {
      const limit = (params.limit as number) ?? 50;
      const includeHidden = (params.include_hidden as boolean) ?? false;
      const compact = (params.compact as boolean) ?? false;
      return inspectElements(limit, includeHidden, compact) as unknown as Record<string, unknown>;
    }
    case "content":
      return { content: readContent((params.target as Target) ?? null) };
    case "text": {
      const target = params.target as Target | undefined;
      const selector = target?.css || "body *";
      const limit = (params.limit as number) ?? 50;
      return { texts: readTexts(selector, limit) };
    }
    case "html": {
      const target = params.target as Target | undefined;
      const limit = (params.limit as number) ?? 10;
      if (!target?.css) return { success: false, message: "CSS selector required for html action" };
      return { html: readHtml(target.css, limit) };
    }
    case "attr": {
      const target = params.target as Target | undefined;
      const name = (params.name as string) || (params.selector as string);
      if (!target?.css || !name) return { success: false, message: "CSS selector and attribute name required" };
      return { name, value: readAttr(target.css, name) };
    }
    case "meta":
      return readMeta();
    case "forms": {
      const limit = (params.limit as number) ?? 20;
      return { forms: readForms(limit) };
    }
    case "count": {
      const target = params.target as Target | undefined;
      if (!target?.css) return { success: false, message: "CSS selector required" };
      return { count: countElements(target.css) };
    }
    case "select":
      return { selectedText: selectText() };
    case "summary":
      return readSummary();
    case "frames":
      return { frames: listFrames() };
    case "generate_selector": {
      const target = params.target as Target | undefined;
      const css = target?.css as string | undefined;
      if (!css) return { success: false, message: "CSS selector required (use target.css)" };
      return generateSelector(css);
    }
    case "console": {
      const limit = (params.limit as number) ?? 50;
      const offset = (params.offset as number) ?? 0;
      const totalCount = consoleBuffer.length;
      const entries = consoleBuffer.slice(-(offset + limit), -(offset) || undefined);
      return { entries, totalCount };
    }
    default:
      return { success: false, message: `Unknown read action: ${action}`, errorCode: "UNKNOWN_ACTION" };
  }
}

// ── Act Handler ──

async function handleAct(
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureReady();

  /** Try to resolve the element, with a short poll for lazy-loaded content */
  const resolveEl = async (): Promise<Element | null> => {
    const attempt = (): Element | null => {
      const sel = params.selector as string | undefined;
      if (sel) {
        const resolution = resolveTarget({ css: sel });
        return resolution.found ? (resolution.element ?? null) : null;
      }
      const target = params.target as Target | undefined;
      if (target) {
        const resolution = resolveTarget(target);
        if (resolution.found && resolution.element) return resolution.element;
      }
      return null;
    };

    // Try immediately
    const immediate = attempt();
    if (immediate) return immediate;

    // Poll briefly (500ms) for dynamically loaded elements
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      const result = attempt();
      if (result) return result;
    }

    return null;
  };

  switch (action) {
    case "click": {
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return clickElement(el);
    }
    case "fill": {
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      const value = params.value as string;
      if (value === undefined) return { success: false, message: "No value provided" };
      return fillElement(el, value);
    }
    case "check": {
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return checkElement(el, params.checked as boolean | undefined);
    }
    case "select_option": {
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return selectOption(el, params.value as string | undefined, params.label as string | undefined);
    }
    case "press": {
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return pressKeys(el, params.key as string, params.keys as string[] | undefined);
    }
    case "scroll": {
      const direction = (params.direction as string) || "down";
      const amount = params.amount as number | undefined;
      if (direction === "to_element") {
        const el = await resolveEl();
        return scrollElement(el, direction, amount);
      }
      return scrollElement(null, direction, amount);
    }
    case "submit": {
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return submitForm(el);
    }
    case "type": {
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      const text = (params.text as string) ?? (params.value as string);
      const delay = (params.delay as number) ?? 30;
      if (!text) return { success: false, message: "No text provided (use 'text' parameter)" };
      return typeText(el, text, delay);
    }
    case "smart_click": {
      const target = params.target as Target | undefined;
      if (!target) return { success: false, message: "Smart click requires a target" };
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return clickElement(el);
    }
    case "fill_form": {
      const fields = params.fields as Array<{ selector: string; value: string }> | undefined;
      if (!fields || fields.length === 0) {
        return { success: false, message: "No fields provided" };
      }
      return fillFormFields(fields);
    }
    case "upload": {
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return uploadFile(
        el,
        params.file_data as string,
        params.file_name as string | undefined,
        params.file_type as string | undefined,
      );
    }
    case "drag": {
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return dragElement(el, params.x as number | undefined, params.y as number | undefined);
    }
    case "dblclick": {
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return dblclickElement(el);
    }
    case "hover": {
      const el = await resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return hoverElement(el);
    }
    case "dialog_override":
      return dialogOverride();
    case "dialog_respond":
      return dialogRespond(params.response as Record<string, unknown> | undefined);

    // ── wait_for ──
    case "wait_for": {
      const condition = (params.condition as string) || "exists";
      const timeout = (params.timeout_ms as number) ?? 10000;
      const pollInterval = (params.poll_interval_ms as number) ?? 100;

      // network_idle
      if (condition === "network_idle") {
        const idleMs = (params.idle_ms as number) ?? 500;
        return waitForNetworkIdle(idleMs, timeout);
      }

      // function
      if (condition === "function") {
        const expression = params.expression as string;
        if (!expression) return { success: false, message: "Function condition requires 'expression'" };
        return waitForFunction(expression, timeout, pollInterval);
      }

      // Element conditions
      const sel = params.selector as string | undefined;
      const target = params.target as Target | undefined;

      if (sel) {
        return waitForElement(sel, condition, timeout, pollInterval);
      }
      if (target) {
        return waitForTarget(target, condition, timeout, pollInterval);
      }
      // No selector or target — just wait
      await new Promise((r) => setTimeout(r, timeout));
      return { success: true, message: `Waited ${timeout}ms`, evidence: { elapsed_ms: timeout } };
    }

    default:
      return { success: false, message: `Unknown act action: ${action}`, errorCode: "UNKNOWN_ACTION" };
  }
}

// ── JS Handler ──

async function handleJs(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureReady();
  const code = params.code as string | undefined;
  if (!code) {
    return { success: false, message: "No code provided", errorCode: "MISSING_PARAM" };
  }
  try {
    const result = new Function(code)();
    // Try to serialize — if it fails, return type info
    let serialized: unknown;
    try {
      serialized = JSON.parse(JSON.stringify(result));
    } catch {
      serialized = {
        _nonSerializable: true,
        type: typeof result,
        hint: result === null ? "null" : result?.constructor?.name || typeof result,
      };
    }
    return { success: true, data: { result: serialized } };
  } catch (err) {
    return { success: false, message: `JavaScript execution failed: ${(err as Error).message}`, errorCode: "JS_EXECUTION_ERROR" };
  }
}
