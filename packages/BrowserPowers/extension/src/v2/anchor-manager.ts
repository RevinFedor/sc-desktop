/**
 * FILE: extension/src/v2/anchor-manager.ts
 * PURPOSE: Manage anchor lifecycle in the extension service worker.
 *          Anchors are per-tab, per-inspect-session with documentId staleness detection.
 * OWNS: Anchor storage, retrieval, and invalidation for fast follow-up actions.
 * EXPORTS: setAnchors, getAnchor, getDocumentId, clearAnchors, clearAllAnchors
 * DOCS: agent_chat/plan_adr001_v2_2026-05-12.md (Phase 2c)
 */

import type { Target } from "../types.js";

interface AnchorEntry {
  selector: string;
  documentId: string;
  tabId: number;
  target: Target;
}

const tabAnchors = new Map<number, Map<string, AnchorEntry>>();

/**
 * Store a batch of anchors for a given tab + documentId.
 */
export function setAnchors(
  tabId: number,
  documentId: string,
  anchors: Array<{ anchor: string; target: Target; selector: string }>,
): void {
  const map = new Map<string, AnchorEntry>();
  for (const a of anchors) {
    map.set(a.anchor, {
      selector: a.selector,
      documentId,
      tabId,
      target: a.target,
    });
  }
  tabAnchors.set(tabId, map);
}

/**
 * Retrieve an anchor entry by tabId + anchorId + documentId.
 * Returns null if the anchor doesn't exist or is stale (documentId mismatch).
 */
export function getAnchor(
  tabId: number,
  anchorId: string,
  documentId?: string,
): { selector: string; target: Target } | null {
  const map = tabAnchors.get(tabId);
  if (!map) return null;
  const entry = map.get(anchorId);
  if (!entry) return null;
  if (documentId !== undefined && entry.documentId !== documentId) return null; // stale
  return { selector: entry.selector, target: entry.target };
}

/**
 * Get the documentId of the last anchor batch stored for a tab.
 * Returns null if no anchors are stored for the tab.
 */
export function getDocumentId(tabId: number): string | null {
  const map = tabAnchors.get(tabId);
  if (!map || map.size === 0) return null;
  // All entries in a batch have the same documentId — grab from first
  return map.values().next().value?.documentId ?? null;
}

/**
 * Remove all anchors for a given tab (on navigation / page change).
 */
export function clearAnchors(tabId: number): void {
  tabAnchors.delete(tabId);
}

/**
 * Remove all anchors across all tabs.
 */
export function clearAllAnchors(): void {
  tabAnchors.clear();
}
