/**
 * FILE: extension/src/v2/page-act.ts
 * PURPOSE: Dispatch act actions (click, fill, check, select_option, press, scroll, submit, wait_for,
 *          type, smart_click, fill_form, upload, drag, dblclick, hover, dialog_override, dialog_respond)
 *          via chrome.tabs.sendMessage to the persistent content script.
 * OWNS: page.act dispatch — each act action implementation in the service worker.
 * EXPORTS: dispatchActAction
 * DOCS: .agents/reports/plan_content-script-arch_2026-05-28.md
 */

import { getAnchor } from "./anchor-manager.js";
import { performed, notPerformed, ambiguous, blocked } from "./action-result.js";
import type { ActionResult, Target } from "../types.js";

type ActAction =
  | "click" | "fill" | "check" | "select_option" | "press" | "scroll" | "submit"
  | "wait_for" | "type" | "smart_click" | "fill_form" | "upload" | "drag"
  | "dblclick" | "hover" | "dialog_override" | "dialog_respond";

type WaitCondition =
  | "exists" | "visible" | "hidden" | "enabled" | "disabled" | "stable"
  | "url" | "network_idle" | "load_state" | "function";

export async function dispatchActAction(
  action: ActAction,
  params: Record<string, unknown>,
  tabId: number,
  frameId?: number,
): Promise<ActionResult> {
  switch (action) {
    case "click": return click(params, tabId, frameId);
    case "fill": return fill(params, tabId, frameId);
    case "check": return check(params, tabId, frameId);
    case "select_option": return selectOption(params, tabId, frameId);
    case "press": return press(params, tabId, frameId);
    case "scroll": return scrollAction(params, tabId, frameId);
    case "submit": return submit(params, tabId, frameId);
    case "wait_for": return waitFor(params, tabId, frameId);
    case "type": return typeAction(params, tabId, frameId);
    case "smart_click": return smartClick(params, tabId, frameId);
    case "fill_form": return fillForm(params, tabId, frameId);
    case "upload": return uploadAction(params, tabId, frameId);
    case "drag": return dragAction(params, tabId, frameId);
    case "dblclick": return dblclickAction(params, tabId, frameId);
    case "hover": return hoverAction(params, tabId, frameId);
    case "dialog_override": return dialogOverride(params, tabId, frameId);
    case "dialog_respond": return dialogRespond(params, tabId, frameId);
    default:
      return notPerformed("act", `Unknown act action: ${action}`);
  }
}

// ── Helper: send act message to content script ──

async function sendActMessage(
  tabId: number,
  action: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const maxRetries = 3;
  const delays = [1000, 2000, 4000]; // 1s, 2s, 4s exponential backoff

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        source: "browserpowers",
        type: "bp:act",
        action,
        params,
      }) as Record<string, unknown>;

      if (!response) {
        return blocked(action, "No response from content script", {
          errorCode: "CONTENT_SCRIPT_NOT_READY",
          recoverable: true,
        });
      }

      // Map content script response to ActionResult
      if (response.errorCode === "ANCHOR_STALE") {
        return blocked(action, response.message as string, {
          errorCode: "ANCHOR_STALE",
          recoverable: true,
          suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
        });
      }
      if (response.blocked) {
        return blocked(action, response.message as string, {
          errorCode: "OVERLAY_BLOCKED",
          recoverable: true,
          evidence: response.evidence as Record<string, unknown>,
          suggestions: [
            "Close any modals, popups, or spinners first",
            "Run page.read with action=inspect to see current elements",
          ],
        });
      }
      if (response.errorCode === "AMBIGUOUS_TARGET") {
        return ambiguous(action, response.message as string, {
          errorCode: "AMBIGUOUS_TARGET",
          recoverable: true,
          evidence: { matchedCount: response.matchCount },
          suggestions: ["Run page.read with action=inspect to choose an anchor", "Refine the target"],
        });
      }
      if (response.errorCode === "TARGET_NOT_FOUND" || response.success === false) {
        return notPerformed(action, response.message as string, {
          errorCode: response.errorCode as string | undefined,
        });
      }

      return performed(action, (response.message as string) || `${action} completed`, {
        evidence: response.evidence as Record<string, unknown>,
        data: response,
      });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      if (msg.includes("receiving end does not exist") || msg.includes("Could not establish connection")) {
        if (attempt < maxRetries) {
          console.warn(`[bp-ext] page-act sendMessage attempt ${attempt + 1} failed, retrying in ${delays[attempt]}ms`);
          await new Promise(r => setTimeout(r, delays[attempt]));
          continue;
        }
        return blocked(action, "Content script not available — page may not be loaded", {
          errorCode: "CONTENT_SCRIPT_NOT_READY",
          recoverable: true,
          suggestions: ["Wait for the page to finish loading", "Retry the operation"],
        });
      }
      if (attempt < maxRetries) {
        console.warn(`[bp-ext] page-act sendMessage attempt ${attempt + 1} failed, retrying in ${delays[attempt]}ms`);
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      return blocked(action, `Content script error: ${msg}`, {
        errorCode: "CONTENT_SCRIPT_ERROR",
        recoverable: true,
      });
    }
  }
  // Should not reach here
  return blocked(action, "Failed after all retries", {
    errorCode: "CONTENT_SCRIPT_ERROR",
    recoverable: true,
  });
}

// ── Resolve target/anchor to params for sendActMessage ──

function resolveTargetParams(
  tabId: number,
  target: Target | undefined,
  anchor: string | undefined,
): Record<string, unknown> | string {
  if (anchor) {
    const entry = getAnchor(tabId, anchor);
    if (!entry) return "STALE";
    return { selector: entry.selector };
  }
  if (target) {
    return { target };
  }
  return "NONE";
}

// ── Action implementations ──

async function click(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("click", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("click", "No target or anchor provided");
  }

  return sendActMessage(tabId, "click", resolved as Record<string, unknown>);
}

async function fill(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;
  const value = params.value as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("fill", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("fill", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  actParams.value = value;
  return sendActMessage(tabId, "fill", actParams);
}

async function check(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;
  const checked = params.checked as boolean | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("check", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("check", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  if (checked !== undefined) actParams.checked = checked;
  return sendActMessage(tabId, "check", actParams);
}

async function selectOption(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("select_option", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("select_option", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  actParams.value = params.value;
  actParams.label = params.label;
  return sendActMessage(tabId, "select_option", actParams);
}

async function press(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("press", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("press", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  actParams.key = params.key;
  actParams.keys = params.keys;
  return sendActMessage(tabId, "press", actParams);
}

async function scrollAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const direction = (params.direction as string) || "down";
  const amount = params.amount as number | undefined;
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;
  const needsTarget = direction === "to_element";

  if (needsTarget) {
    const resolved = resolveTargetParams(tabId, target, anchor);
    if (resolved === "STALE") {
      return blocked("scroll", `Anchor ${anchor} is no longer valid`, {
        errorCode: "ANCHOR_STALE",
        recoverable: true,
        suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
      });
    }
    if (resolved === "NONE") {
      return notPerformed("scroll", "No target or anchor provided for to_element scroll");
    }
    const actParams = resolved as Record<string, unknown>;
    actParams.direction = direction;
    actParams.amount = amount;
    return sendActMessage(tabId, "scroll", actParams);
  }

  return sendActMessage(tabId, "scroll", { direction, amount });
}

async function submit(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("submit", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("submit", "No target or anchor provided");
  }

  return sendActMessage(tabId, "submit", resolved as Record<string, unknown>);
}

async function waitFor(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;
  const timeout = (params.timeout_ms as number) ?? 10000;
  const condition = (params.condition as WaitCondition) ?? "exists";
  const pollingInterval = (params.poll_interval_ms as number) ?? 100;

  // URL condition: handle in service worker
  if (condition === "url") {
    const urlPattern = (params.pattern as string) ?? (params.url as string);
    if (!urlPattern) return notPerformed("wait_for", "URL condition requires 'pattern' or 'url' parameter");
    return waitForUrl(tabId, urlPattern, timeout, pollingInterval);
  }

  // load_state condition: handle in service worker
  if (condition === "load_state") {
    const targetState = (params.state as string) ?? "load";
    return waitForLoadState(tabId, targetState, timeout, pollingInterval);
  }

  // No condition: just wait
  if (!condition || condition === "none") {
    await new Promise((r) => setTimeout(r, timeout));
    return performed("wait_for", `Waited ${timeout}ms`, {
      data: { elapsed_ms: timeout },
    });
  }

  // network_idle, function: send to content script
  if (condition === "network_idle") {
    const idleMs = (params.idle_ms as number) ?? 500;
    return sendActMessage(tabId, "wait_for", { condition: "network_idle", idle_ms: idleMs, timeout_ms: timeout });
  }

  if (condition === "function") {
    const expression = params.expression as string;
    if (!expression) return notPerformed("wait_for", "Function condition requires 'expression' parameter");
    return sendActMessage(tabId, "wait_for", { condition: "function", expression, timeout_ms: timeout, poll_interval_ms: pollingInterval });
  }

  // Element conditions (exists, visible, hidden, enabled, disabled, stable)
  const resolved = resolveTargetParams(tabId, target, anchor);

  if (resolved === "STALE") {
    return blocked("wait_for", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }

  if (resolved !== "NONE") {
    const actParams = resolved as Record<string, unknown>;
    actParams.condition = condition;
    actParams.timeout_ms = timeout;
    actParams.poll_interval_ms = pollingInterval;
    return sendActMessage(tabId, "wait_for", actParams);
  }

  // No selector or target: just wait
  await new Promise((r) => setTimeout(r, timeout));
  return performed("wait_for", `Waited ${timeout}ms without condition`, {
    data: { elapsed_ms: timeout },
  });
}

async function waitForUrl(
  tabId: number,
  pattern: string,
  timeout: number,
  interval: number,
): Promise<ActionResult> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url?.includes(pattern)) {
      return performed("wait_for", `URL matched '${pattern}' after ${Date.now() - start}ms`, {
        data: { url: tab.url, elapsed_ms: Date.now() - start, matched: true },
      });
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  const tab = await chrome.tabs.get(tabId);
  return performed("wait_for", `URL did not match '${pattern}' after ${timeout}ms`, {
    data: { url: tab.url, elapsed_ms: timeout, matched: false },
  });
}

async function waitForLoadState(
  tabId: number,
  state: string,
  timeout: number,
  interval: number,
): Promise<ActionResult> {
  const map: Record<string, string> = {
    interactive: "complete",
    dominteractive: "complete",
    complete: "complete",
    domcomplete: "complete",
    load: "complete",
    domloaded: "complete",
  };
  const expected = map[state] ?? state;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === expected || tab.status === "complete") {
      return performed("wait_for", `Load state '${state}' reached after ${Date.now() - start}ms`, {
        data: { state: tab.status, elapsed_ms: Date.now() - start },
      });
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  const tab = await chrome.tabs.get(tabId);
  return performed("wait_for", `Load state '${state}' timeout after ${timeout}ms (current: ${tab.status})`, {
    data: { state: tab.status, elapsed_ms: timeout, timed_out: true },
  });
}

async function typeAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;
  const text = params.text as string ?? (params.value as string);
  const delay = (params.delay as number) ?? 30;

  if (!text) return notPerformed("type", "No text provided (use 'text' parameter)");

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("type", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("type", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  actParams.text = text;
  actParams.delay = delay;
  return sendActMessage(tabId, "type", actParams);
}

async function smartClick(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  if (!target) {
    return notPerformed("smart_click", "Smart click requires a target (use one of: css, text, role, name, label, placeholder, testId)");
  }

  return sendActMessage(tabId, "smart_click", { target });
}

// ── Upload action ──

async function uploadAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("upload", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("upload", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  actParams.file_data = params.file_data;
  actParams.file_name = params.file_name;
  actParams.file_type = params.file_type;
  return sendActMessage(tabId, "upload", actParams);
}

// ── Drag action ──

async function dragAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("drag", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("drag", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  if (params.x !== undefined) actParams.x = params.x;
  if (params.y !== undefined) actParams.y = params.y;
  return sendActMessage(tabId, "drag", actParams);
}

// ── Double-click action ──

async function dblclickAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("dblclick", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("dblclick", "No target or anchor provided");
  }

  return sendActMessage(tabId, "dblclick", resolved as Record<string, unknown>);
}

// ── Hover action ──

async function hoverAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("hover", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("hover", "No target or anchor provided");
  }

  return sendActMessage(tabId, "hover", resolved as Record<string, unknown>);
}

// ── Dialog actions ──

async function dialogOverride(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  return sendActMessage(tabId, "dialog_override", {});
}

async function dialogRespond(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  return sendActMessage(tabId, "dialog_respond", {
    response: params.response as Record<string, unknown> | undefined,
  });
}

// ── fill_form: batch fill multiple form fields ──

async function fillForm(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const fields = params.fields as Array<{ anchor?: string; target?: Target; value: string }> | undefined;
  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    return notPerformed("fill_form", "No fields provided (use 'fields' array)");
  }

  // Resolve anchors to selectors in service worker
  const resolved: Array<{ selector: string; value: string } | { error: string; value: string }> = fields.map((f) => {
    if (f.anchor) {
      const entry = getAnchor(tabId, f.anchor);
      if (entry) return { selector: entry.selector, value: f.value };
      return { error: `Anchor ${f.anchor} is stale`, value: f.value };
    }
    if (f.target?.css) return { selector: f.target.css, value: f.value };
    if (f.target?.text || f.target?.role || f.target?.name) {
      return { error: "fill_form only supports anchor or css target per field", value: f.value };
    }
    return { error: "No anchor or css target for field", value: f.value };
  });

  const errored = resolved.filter((r) => (r as { error?: string }).error);
  if (errored.length > 0) {
    return notPerformed("fill_form", `${errored.length} field(s) had resolution errors`, {
      evidence: { errors: errored.map((r) => (r as { error: string }).error) },
    });
  }

  const selectorsAndValues = resolved.map((r) => ({
    selector: (r as { selector: string; value: string }).selector,
    value: (r as { selector: string; value: string }).value,
  }));

  return sendActMessage(tabId, "fill_form", { fields: selectorsAndValues });
}
