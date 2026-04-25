/**
 * FILE: extension/src/v2/page-js.ts
 * PURPOSE: Execute arbitrary JavaScript on the page — gated escape hatch for page.js tool.
 *          Sends code to the persistent content script via chrome.tabs.sendMessage.
 * OWNS: page.js dispatch — wraps chrome.tabs.sendMessage for arbitrary code execution.
 * EXPORTS: dispatchJsAction
 * DOCS: .agents/reports/plan_content-script-arch_2026-05-28.md
 */

import { performed, blocked } from "./action-result.js";
import type { ActionResult } from "../types.js";

export async function dispatchJsAction(code: string, tabId: number, frameId?: number): Promise<ActionResult> {
  if (!code) {
    return blocked("js", "No code provided", {
      errorCode: "MISSING_PARAM",
      suggestions: ["Provide JavaScript code to execute"],
    });
  }

  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      {
        source: "browserpowers",
        type: "bp:js",
        params: { code },
      } as any,
      frameId ? { frameId } : {},
    ) as Record<string, unknown>;

    if (!response) {
      return blocked("js", "Content script not available — page may not be loaded", {
        errorCode: "CONTENT_SCRIPT_NOT_READY",
        recoverable: true,
        suggestions: ["Wait for the page to finish loading", "Retry the operation"],
      });
    }

    if (response.success === false) {
      return blocked("js", (response.message as string) || (response.error as string), {
        errorCode: response.errorCode as string,
        recoverable: true,
        suggestions: [
          "Check the JavaScript syntax",
          "Ensure the code is a valid expression or statement",
        ],
      });
    }

    const result = (response as any).data?.result ?? (response as any).result;
    return performed("js", "JavaScript executed successfully", {
      data: { result },
      evidence: { hasResult: result !== undefined },
    });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (msg.includes("receiving end does not exist") || msg.includes("Could not establish connection")) {
      return blocked("js", "Content script not available — page may not be loaded", {
        errorCode: "CONTENT_SCRIPT_NOT_READY",
        recoverable: true,
        suggestions: ["Wait for the page to finish loading", "Retry the operation"],
      });
    }
    return blocked("js", `JavaScript execution failed: ${msg}`, {
      errorCode: "JS_EXECUTION_ERROR",
      recoverable: true,
      suggestions: [
        "Check the JavaScript syntax",
        "Ensure the code is a valid expression or statement",
      ],
    });
  }
}
