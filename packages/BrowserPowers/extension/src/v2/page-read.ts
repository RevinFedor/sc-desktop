/**
 * FILE: extension/src/v2/page-read.ts
 * PURPOSE: Dispatch read actions (inspect, content, text, html, attr, meta, forms, count, select,
 *          summary, frames, generate_selector) via chrome.tabs.sendMessage to the persistent content script.
 * OWNS: page.read dispatch — each read action implementation in the service worker.
 * EXPORTS: dispatchReadAction
 * DOCS: .agents/reports/plan_content-script-arch_2026-05-28.md
 */

import { performed, notPerformed, blocked } from "./action-result.js";
import { setAnchors } from "./anchor-manager.js";
import type { ActionResult, Target } from "../types.js";

type ReadAction = "inspect" | "content" | "text" | "html" | "attr" | "meta" | "forms" | "count" | "select" | "summary" | "frames" | "generate_selector" | "console";

export async function dispatchReadAction(
  action: ReadAction,
  params: Record<string, unknown>,
  tabId: number,
  frameId?: number,
): Promise<ActionResult> {
  switch (action) {
    case "inspect":
      return inspect(params, tabId, frameId);
    case "content":
      return content(params, tabId, frameId);
    case "text":
      return text(params, tabId, frameId);
    case "html":
      return html(params, tabId, frameId);
    case "attr":
      return attr(params, tabId, frameId);
    case "meta":
      return meta(tabId, frameId);
    case "forms":
      return forms(tabId, params, frameId);
    case "count":
      return count(params, tabId, frameId);
    case "select":
      return selectText(tabId, frameId);
    case "summary":
      return summary(tabId, frameId);
    case "frames":
      return listFrames(tabId, frameId);
    case "generate_selector":
      return generateSelector(params, tabId, frameId);
    case "console":
      return consoleRead(params, tabId, frameId);
    default:
      return notPerformed("read", `Unknown read action: ${action}`);
  }
}

// ── Helper: send read message to content script ──

async function sendReadMessage(
  tabId: number,
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const maxRetries = 3;
  const delays = [1000, 2000, 4000]; // 1s, 2s, 4s exponential backoff

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        source: "browserpowers",
        type: "bp:read",
        action,
        params,
      }) as Record<string, unknown>;
      return response;
    } catch (err) {
      if (attempt < maxRetries) {
        console.warn(`[bp-ext] page-read sendMessage attempt ${attempt + 1} failed, retrying in ${delays[attempt]}ms`);
        await new Promise(r => setTimeout(r, delays[attempt]));
      } else {
        const msg = (err as Error).message || String(err);
        // Content script may not be loaded yet
        if (msg.includes("receiving end does not exist") || msg.includes("Could not establish connection")) {
          return undefined;
        }
        throw err;
      }
    }
  }
  return undefined;
}

// ── Read action handlers ──

async function inspect(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const limit = (params.limit as number) ?? 50;
  const includeHidden = (params.include_hidden as boolean) ?? false;
  const compact = (params.compact as boolean) ?? false;

  try {
    const data = await sendReadMessage(tabId, "inspect", { limit, includeHidden, compact });
    if (!data) {
      return blocked("inspect", "Content script not available — page may not be loaded", {
        errorCode: "CONTENT_SCRIPT_NOT_READY",
        recoverable: true,
        suggestions: ["Wait for the page to finish loading", "Retry the inspect"],
      });
    }
    if (data.success === false) {
      return blocked("inspect", data.message as string, { errorCode: data.errorCode as string });
    }

    const anchors = data.anchors as Array<Record<string, unknown>> | undefined;

    if (anchors) {
      const anchorEntries = anchors.map((a: Record<string, unknown>) => ({
        anchor: a.anchor as string,
        target: a.target as Target,
        selector: (a.target as Target)?.css || `[data-bp-anchor="${a.anchor as string}"]`,
      }));
      setAnchors(tabId, data.documentId as string, anchorEntries);
    }

    return performed("inspect", `Found ${anchors?.length || 0} interactable elements`, {
      data,
      evidence: { anchorCount: anchors?.length || 0 },
    });
  } catch (err) {
    return blocked("inspect", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function content(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;

  try {
    const data = await sendReadMessage(tabId, "content", { target: target ?? null });
    if (!data) return contentScriptNotReady("content");

    const contentText = data.content as string | undefined;
    return performed("content", "Page content extracted", {
      evidence: { length: contentText?.length || 0 },
      data: { content: contentText },
    });
  } catch (err) {
    return blocked("content", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function text(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const selector = target?.css || "body *";
  const limit = (params.limit as number) ?? 50;

  try {
    const data = await sendReadMessage(tabId, "text", { target: { css: selector }, limit });
    if (!data) return contentScriptNotReady("text");

    const texts = (data.texts as string[]) || [];
    return performed("text", `Found ${texts.length} matching elements`, {
      data: { texts },
      targetSummary: selector,
    });
  } catch (err) {
    return blocked("text", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function html(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const limit = (params.limit as number) ?? 10;
  if (!target?.css) return notPerformed("html", "CSS selector required for html action");

  try {
    const data = await sendReadMessage(tabId, "html", { target: { css: target.css }, limit });
    if (!data) return contentScriptNotReady("html");

    if (data.success === false) return notPerformed("html", data.message as string);

    const htmls = (data.html as string[]) || [];
    return performed("html", `Found ${htmls.length} matching elements`, {
      data: { html: htmls },
      targetSummary: target.css,
    });
  } catch (err) {
    return blocked("html", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function attr(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const name = (params.name as string) || (params.selector as string);
  if (!target?.css || !name) return notPerformed("attr", "CSS selector and attribute name required");

  try {
    const data = await sendReadMessage(tabId, "attr", { target: { css: target.css }, name });
    if (!data) return contentScriptNotReady("attr");

    if (data.success === false) return notPerformed("attr", data.message as string);

    const value = data.value;
    return performed("attr", `Attribute "${name}" read successfully`, {
      data: { name, value },
      targetSummary: target.css,
    });
  } catch (err) {
    return blocked("attr", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function meta(tabId: number, frameId?: number): Promise<ActionResult> {
  try {
    const data = await sendReadMessage(tabId, "meta", {});
    if (!data) return contentScriptNotReady("meta");

    if (data.success === false) return notPerformed("meta", data.message as string);

    return performed("meta", "Page metadata extracted", { data });
  } catch (err) {
    return blocked("meta", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function forms(tabId: number, params?: Record<string, unknown>, frameId?: number): Promise<ActionResult> {
  const limit = (params?.limit as number) ?? 20;

  try {
    const data = await sendReadMessage(tabId, "forms", { limit });
    if (!data) return contentScriptNotReady("forms");

    if (data.success === false) return notPerformed("forms", data.message as string);

    const formsData = (data.forms as Array<unknown>) || [];
    return performed("forms", `Found ${formsData.length} forms`, {
      data: { forms: formsData },
    });
  } catch (err) {
    return blocked("forms", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function count(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  if (!target?.css) return notPerformed("count", "CSS selector required");

  try {
    const data = await sendReadMessage(tabId, "count", { target: { css: target.css } });
    if (!data) return contentScriptNotReady("count");

    if (data.success === false) return notPerformed("count", data.message as string);

    const c = (data.count as number) ?? 0;
    return performed("count", `Found ${c} matching elements`, {
      data: { count: c },
      targetSummary: target.css,
    });
  } catch (err) {
    return blocked("count", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function selectText(tabId: number, frameId?: number): Promise<ActionResult> {
  try {
    const data = await sendReadMessage(tabId, "select", {});
    if (!data) return contentScriptNotReady("select");

    const text = (data.selectedText as string) ?? "";
    return performed("select", text ? "Text selected" : "No text selected", {
      data: { selectedText: text },
    });
  } catch (err) {
    return blocked("select", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function summary(tabId: number, frameId?: number): Promise<ActionResult> {
  try {
    const data = await sendReadMessage(tabId, "summary", {});
    if (!data) return contentScriptNotReady("summary");

    if (data.success === false) return notPerformed("summary", data.message as string);

    return performed("summary", "Page summary extracted", { data });
  } catch (err) {
    return blocked("summary", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function listFrames(tabId: number, frameId?: number): Promise<ActionResult> {
  try {
    const data = await sendReadMessage(tabId, "frames", {});
    if (!data) return contentScriptNotReady("frames");

    const frames = (data.frames as Array<Record<string, unknown>>) || [];
    return performed("frames", `Found ${frames.length} frames`, {
      data: { frames },
      evidence: { frameCount: frames.length },
    });
  } catch (err) {
    return blocked("frames", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function generateSelector(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const css = target?.css as string | undefined;

  if (!css) return notPerformed("generate_selector", "CSS selector required (use target.css)");

  try {
    const data = await sendReadMessage(tabId, "generate_selector", { target: { css } });
    if (!data) return contentScriptNotReady("generate_selector");

    if (!data.success) return notPerformed("generate_selector", (data.message as string) || "Failed");

    return performed("generate_selector", `Generated ${(data.selectors as Array<unknown>)?.length ?? 0} selectors`, {
      data,
      targetSummary: css,
    });
  } catch (err) {
    return blocked("generate_selector", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

async function consoleRead(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const limit = (params.limit as number) ?? 50;
  const offset = (params.offset as number) ?? 0;
  try {
    // Read from content script buffer. Entries arrive from the MAIN world
    // capture script (capture.js, registered via registerContentScripts)
    // via a shared DOM <meta> attribute + MutationObserver.
    const data = await sendReadMessage(tabId, "console", { limit, offset });
    if (!data) return contentScriptNotReady("console");
    if (data.success === false) return notPerformed("console", data.message as string);
    const entries = (data.entries as Array<unknown>) || [];
    const totalCount = (data.totalCount as number) ?? 0;
    return performed("console", `Found ${totalCount} console entries (showing ${entries.length})`, {
      data: { entries, totalCount },
      evidence: { totalCount },
    });
  } catch (err) {
    return blocked("console", `Content script error: ${(err as Error).message}`, {
      errorCode: "CONTENT_SCRIPT_ERROR",
      recoverable: true,
    });
  }
}

// ── Helpers ──

function contentScriptNotReady(action: string): ActionResult {
  return blocked(action, "Content script not available — page may not be loaded", {
    errorCode: "CONTENT_SCRIPT_NOT_READY",
    recoverable: true,
    suggestions: ["Wait for the page to finish loading", "Retry the operation"],
  });
}
