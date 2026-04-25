import { randomUUID } from "node:crypto";
import type { Browser, Capability, CommandMode, QueuedItem, ToolResult } from "./types.js";
import { loadConfig } from "./config.js";

interface PendingApproval {
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  tool: string;
  params: Record<string, unknown>;
  browserId: string;
}

export class ApprovalTimeoutError extends Error {
  constructor(
    public readonly browserId: string,
    public readonly requestId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Approval request ${requestId} timed out after ${timeoutMs}ms`);
    this.name = "ApprovalTimeoutError";
  }
}

/**
 * In-memory registry of all connected browser extensions.
 * Each browser registers via WebSocket and is tracked here.
 */
class BrowserRegistry {
  private browsers = new Map<string, Browser>();
  /** Fast lookup: requestId → QueuedItem (for resolve/reject by requestId) */
  private pendingRequests = new Map<string, QueuedItem>();
  /** Per-browser ordered queue: browserId → requestId[] (for FIFO ordering) */
  private requestQueues = new Map<string, string[]>();
  /** Set of browserIds currently busy (one in-flight at a time) */
  private busy = new Set<string>();

  private pendingApprovals = new Map<string, PendingApproval>();

  /** Completed results store: requestId → ToolResult, held for 5 min for async polling */
  private completedResults = new Map<string, ToolResult>();

  /** Sentinel value for in-flight async requests */
  static readonly PENDING = Symbol("pending");

  private scheduleDrain(browserId: string): void {
    void import("./ws-server.js")
      .then(({ tryDrain }) => tryDrain(browserId))
      .catch(() => {
        // Ignore drain attempts during shutdown/module teardown.
      });
  }

  /** Register a newly connected browser */
  register(
    browserId: string,
    name: string,
    capabilities: Capability[],
    permissions: Browser["permissions"],
    commandMode?: CommandMode,
  ): Browser {
    const config = loadConfig();
    const browser: Browser = {
      id: browserId,
      name,
      capabilities,
      permissions,
      commandMode: commandMode ?? config.execution.commandMode,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };
    this.browsers.set(browserId, browser);
    return browser;
  }

  /** Remove a disconnected browser */
  unregister(browserId: string): void {
    this.browsers.delete(browserId);
    // Reject all queued and pending requests for this browser
    this.rejectAllForBrowser(browserId, new Error(`Browser ${browserId} disconnected`));
    // Reject any pending approvals for this browser
    for (const [requestId, entry] of this.pendingApprovals) {
      if (requestId.startsWith(browserId)) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`Browser ${browserId} disconnected`));
        this.pendingApprovals.delete(requestId);
      }
    }
  }

  /** Update heartbeat timestamp */
  heartbeat(browserId: string): void {
    const browser = this.browsers.get(browserId);
    if (browser) browser.lastHeartbeat = Date.now();
  }

  /** Get all registered browsers */
  list(): Browser[] {
    return Array.from(this.browsers.values());
  }

  /** Get a specific browser */
  get(browserId: string): Browser | undefined {
    return this.browsers.get(browserId);
  }

  /** Enqueue a request for a browser. Returns a promise that resolves when the extension replies. */
  enqueue(
    browserId: string,
    tool: string,
    params: Record<string, unknown>,
    timeoutMs: number = 120_000,
  ): { requestId: string; promise: Promise<ToolResult> } {
    // Enforce queue depth limit
    const maxDepth = loadConfig().queue.maxDepth;
    const currentDepth = this.requestQueues.get(browserId)?.length ?? 0;
    if (currentDepth >= maxDepth) {
      return {
        requestId: "",
        promise: Promise.reject(new Error(`Queue full (${maxDepth} items) for browser ${browserId}`)),
      };
    }

    const requestId = `${browserId}:${randomUUID()}`;
    let resolve: (result: ToolResult) => void;
    let reject: (err: Error) => void;
    const promise = new Promise<ToolResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const timer = setTimeout(() => {
      // Remove from queue FIRST, then pendingRequests — atomic order prevents
      // a race where tryDrain finds the requestId in the queue but not in pendingRequests
      this.removeFromQueue(browserId, requestId);
      this.pendingRequests.delete(requestId);
      this.busy.delete(browserId);
      reject(new Error(`Request ${requestId} timed out after ${timeoutMs}ms`));
      this.scheduleDrain(browserId);
    }, timeoutMs);

    const item: QueuedItem = {
      requestId,
      tool,
      params,
      resolve: resolve!,
      reject: reject!,
      timer,
      timeoutMs,
      browserId,
    };

    this.pendingRequests.set(requestId, item);

    // Add to per-browser queue
    const queue = this.requestQueues.get(browserId) ?? [];
    queue.push(requestId);
    this.requestQueues.set(browserId, queue);

    return { requestId, promise };
  }

  /** Dequeue the next item for a browser. Returns null if queue is empty. */
  dequeue(browserId: string): { requestId: string; tool: string; params: Record<string, unknown> } | null {
    const queue = this.requestQueues.get(browserId);
    if (!queue || queue.length === 0) return null;
    const requestId = queue.shift()!;
    if (queue.length === 0) this.requestQueues.delete(browserId);

    const item = this.pendingRequests.get(requestId);
    if (!item) return null; // already timed out

    return { requestId, tool: item.tool, params: item.params };
  }

  /** Remove a requestId from a browser's queue (used on timeout/disconnect) */
  private removeFromQueue(browserId: string, requestId: string): void {
    const queue = this.requestQueues.get(browserId);
    if (!queue) return;
    const idx = queue.indexOf(requestId);
    if (idx !== -1) queue.splice(idx, 1);
    if (queue.length === 0) this.requestQueues.delete(browserId);
  }

  /** Mark a browser as busy (one in-flight) */
  setBusy(browserId: string): void {
    this.busy.add(browserId);
  }

  /** Clear busy flag for a browser */
  clearBusy(browserId: string): void {
    this.busy.delete(browserId);
  }

  /** Check if a browser is busy */
  isBusy(browserId: string): boolean {
    return this.busy.has(browserId);
  }

  /** Get queued item count for a browser */
  queuedCount(browserId: string): number {
    return this.requestQueues.get(browserId)?.length ?? 0;
  }

  /** Reject ALL queued items for a browser (on disconnect) */
  rejectAllForBrowser(browserId: string, error: Error): void {
    for (const [requestId, item] of [...this.pendingRequests]) {
      if (item.browserId !== browserId) continue;
      clearTimeout(item.timer);
      item.reject(error);
      this.pendingRequests.delete(requestId);
    }
    this.requestQueues.delete(browserId);
    this.busy.delete(browserId);
  }

  /** Resolve a pending request with a result */
  resolveRequest(requestId: string, result: ToolResult): void {
    const entry = this.pendingRequests.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      // Use stored browserId and tool from QueuedItem — NOT a split of requestId
      // (avoid colon-in-browserId bugs) and NOT the caller's stale "unknown" placeholder
      result.browserId = entry.browserId;
      result.tool = entry.tool;
      this.busy.delete(entry.browserId);
      this.removeFromQueue(entry.browserId, requestId);
      entry.resolve(result);
      this.pendingRequests.delete(requestId);
      this.storeResult(requestId, result);
    }
  }

  /** Reject a pending request with an error */
  rejectRequest(requestId: string, error: Error): void {
    const entry = this.pendingRequests.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      this.busy.delete(entry.browserId);
      this.removeFromQueue(entry.browserId, requestId);
      entry.reject(error);
      this.pendingRequests.delete(requestId);
      this.storeResult(requestId, {
        browserId: entry.browserId,
        tool: entry.tool,
        success: false,
        error: error.message,
      });
    }
  }

  /** Store a completed result for async polling (auto-purged after 5 min) */
  storeResult(requestId: string, result: ToolResult): void {
    this.completedResults.set(requestId, result);
    // Auto-purge after 5 minutes
    setTimeout(() => {
      this.completedResults.delete(requestId);
    }, 5 * 60 * 1000);
  }

  /** Poll a result by requestId. Returns null if not found or expired. */
  getResult(requestId: string): ToolResult | null {
    return this.completedResults.get(requestId) ?? null;
  }

  /** Queue an approval request and return a promise that resolves with user's decision */
  queueApproval(
    browserId: string,
    requestId: string,
    tool: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId);
        reject(new ApprovalTimeoutError(browserId, requestId, timeoutMs));
      }, timeoutMs);

      this.pendingApprovals.set(requestId, { resolve, reject, timer, tool, params, browserId });
    });
  }

  /** Resolve an approval request with user's decision (true = approved, false = denied) */
  resolveApproval(requestId: string, approved: boolean): void {
    const entry = this.pendingApprovals.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      entry.resolve(approved);
      this.pendingApprovals.delete(requestId);
    } else {
      console.log(`[registry] Late approval response for ${requestId} (already timed out) — ignored`);
    }
  }

  /** List all pending approval requests */
  listPendingApprovals(): Array<{ requestId: string; tool: string; browserId: string; requestedAt: string }> {
    const result: Array<{ requestId: string; tool: string; browserId: string; requestedAt: string }> = [];
    for (const [requestId, entry] of this.pendingApprovals) {
      result.push({ requestId, tool: entry.tool, browserId: entry.browserId, requestedAt: new Date().toISOString() });
    }
    return result;
  }

  /** Cancel a pending approval request by ID */
  cancelApproval(requestId: string): boolean {
    const entry = this.pendingApprovals.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.reject(new Error("Approval cancelled by user"));
    this.pendingApprovals.delete(requestId);
    return true;
  }

  /** Find stale connections (no heartbeat for too long) */
  findStale(maxAgeMs: number): Browser[] {
    const now = Date.now();
    return Array.from(this.browsers.values()).filter(
      (b) => now - b.lastHeartbeat > maxAgeMs,
    );
  }
}

/** Singleton */
export const registry = new BrowserRegistry();
