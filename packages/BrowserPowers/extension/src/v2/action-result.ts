/**
 * FILE: extension/src/v2/action-result.ts
 * PURPOSE: Build ActionResult envelope objects for page interaction API v2.
 * OWNS: ActionResult construction helpers — one function per status.
 * EXPORTS: performed, alreadyInDesiredState, notPerformed, ambiguous, blocked, anchorStaleError, ActionResultOpts
 * DOCS: agent_chat/plan_adr001_v2_2026-05-12.md (Phase 2a)
 */

import type { ActionResult } from "../types.js";

export interface ActionResultOpts {
  targetSummary?: string;
  evidence?: Record<string, unknown>;
  errorCode?: string;
  recoverable?: boolean;
  suggestions?: string[];
  data?: Record<string, unknown>;
}

function build(
  status: ActionResult["status"],
  action: string,
  message: string,
  opts?: ActionResultOpts,
): ActionResult {
  return {
    success: status === "performed" || status === "already_in_desired_state",
    status,
    action,
    message,
    targetSummary: opts?.targetSummary,
    evidence: opts?.evidence,
    errorCode: opts?.errorCode,
    recoverable: opts?.recoverable,
    suggestions: opts?.suggestions,
    data: opts?.data,
  };
}

export function performed(action: string, message: string, opts?: ActionResultOpts): ActionResult {
  return build("performed", action, message, opts);
}

export function alreadyInDesiredState(action: string, message: string, opts?: ActionResultOpts): ActionResult {
  return build("already_in_desired_state", action, message, opts);
}

export function notPerformed(action: string, message: string, opts?: ActionResultOpts): ActionResult {
  return build("not_performed", action, message, opts);
}

export function ambiguous(action: string, message: string, opts?: ActionResultOpts): ActionResult {
  return build("ambiguous", action, message, {
    errorCode: "AMBIGUOUS_TARGET",
    suggestions: ["Run page.read with action=inspect to choose an anchor", "Refine the target using a more specific CSS selector"],
    ...opts,
  });
}

export function blocked(action: string, message: string, opts?: ActionResultOpts): ActionResult {
  return build("blocked", action, message, opts);
}

export function anchorStaleError(action: string, anchorId: string): ActionResult {
  return build("blocked", action, `Anchor ${anchorId} is no longer valid (stale)`, {
    errorCode: "ANCHOR_STALE",
    recoverable: true,
    suggestions: [
      "Run page.read with action=inspect to get fresh anchors",
      "Use a semantic target (css, text, role) instead of the stale anchor",
    ],
  });
}
