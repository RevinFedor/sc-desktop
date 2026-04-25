/**
 * FILE: extension/src/v2/snapshot-diff.ts
 * PURPOSE: Compute a semantic diff between two inspect snapshots (before/after a page mutation).
 *          Uses stable semantic keys (`role|name|tag|text`) to match anchors across captures.
 * OWNS: Snapshot diff algorithm — standalone, runs in service worker context.
 * EXPORTS: diffSnapshots, AnchorSnapshot, SnapshotDiff
 * DOCS: .agents/reports/plan_execution-modes_2026-06-11.md
 */

/** Minimal anchor shape for diffing — extracted from inspect results */
export interface AnchorSnapshot {
  anchor: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  visible?: boolean;
  enabled?: boolean;
  checked?: boolean;
  selected?: boolean;
}

/** Per-field change record */
export interface AnchorChange {
  key: string;
  changes: Record<string, { from: unknown; to: unknown }>;
}

/** Result of comparing two snapshots */
export interface SnapshotDiff {
  urlChanged: boolean;
  titleChanged: boolean;
  documentIdChanged: boolean;
  anchorsAdded: AnchorSnapshot[];
  anchorsRemoved: AnchorSnapshot[];
  anchorsChanged: AnchorChange[];
}

/** Fields to compare for change detection */
const COMPARABLE_FIELDS = ["visible", "enabled", "checked", "selected", "text"] as const;

/**
 * Build a stable semantic key for an anchor.
 * Format: `${role ?? tag}|${name ?? ""}|${tag}|${text ?? ""}`
 */
function makeKey(anchor: AnchorSnapshot): string {
  const role = anchor.role ?? anchor.tag;
  const name = anchor.name ?? "";
  const tag = anchor.tag;
  const text = anchor.text ?? "";
  return `${role}|${name}|${tag}|${text}`;
}

/**
 * Compare two snapshots (before/after) by semantic key matching.
 * Returns what was added, removed, and changed.
 *
 * @param before - Anchors from the "before" inspect snapshot
 * @param after - Anchors from the "after" inspect snapshot
 * @param meta - Optional top-level metadata to diff (url, title, documentId)
 */
export function diffSnapshots(
  before: AnchorSnapshot[],
  after: AnchorSnapshot[],
  meta?: {
    urlBefore?: string;
    urlAfter?: string;
    titleBefore?: string;
    titleAfter?: string;
    documentIdBefore?: string;
    documentIdAfter?: string;
  },
): SnapshotDiff {
  // Build maps: semanticKey → anchor
  const beforeMap = new Map<string, AnchorSnapshot>();
  for (const a of before) {
    const key = makeKey(a);
    if (!beforeMap.has(key)) {
      beforeMap.set(key, a);
    }
  }

  const afterMap = new Map<string, AnchorSnapshot>();
  for (const a of after) {
    const key = makeKey(a);
    if (!afterMap.has(key)) {
      afterMap.set(key, a);
    }
  }

  const beforeKeys = new Set(beforeMap.keys());
  const afterKeys = new Set(afterMap.keys());

  // Added: keys in after but not in before
  const anchorsAdded: AnchorSnapshot[] = [];
  for (const key of afterKeys) {
    if (!beforeKeys.has(key)) {
      anchorsAdded.push(afterMap.get(key)!);
    }
  }

  // Removed: keys in before but not in after
  const anchorsRemoved: AnchorSnapshot[] = [];
  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) {
      anchorsRemoved.push(beforeMap.get(key)!);
    }
  }

  // Changed: keys in both but fields differ
  const anchorsChanged: AnchorChange[] = [];
  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) continue;
    const b = beforeMap.get(key)!;
    const a = afterMap.get(key)!;
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    for (const field of COMPARABLE_FIELDS) {
      const oldVal = b[field];
      const newVal = a[field];
      if (oldVal !== newVal) {
        changes[field] = { from: oldVal, to: newVal };
      }
    }

    if (Object.keys(changes).length > 0) {
      anchorsChanged.push({ key, changes });
    }
  }

  return {
    urlChanged: meta?.urlBefore !== meta?.urlAfter,
    titleChanged: meta?.titleBefore !== meta?.titleAfter,
    documentIdChanged: meta?.documentIdBefore !== meta?.documentIdAfter,
    anchorsAdded,
    anchorsRemoved,
    anchorsChanged,
  };
}
