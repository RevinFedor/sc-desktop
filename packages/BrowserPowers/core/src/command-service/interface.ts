import type { ToolResult } from "../types.js";

/**
 * The CommandService is the SINGLE implementation of all browser operations.
 * It routes calls to connected browser extensions and returns results.
 * REST, MCP, and CLI adapters all call into this — zero logic duplication.
 */
export interface CommandService {
  /** List all currently connected browsers */
  listBrowsers(): Promise<BrowserInfo[]>;

  /** Execute a tool on a specific browser (sync: waits for result) */
  execute(browserId: string, tool: string, params: Record<string, unknown>): Promise<ToolResult>;

  /** Execute a tool asynchronously — returns requestId immediately */
  executeAsync(browserId: string, tool: string, params: Record<string, unknown>): Promise<{ requestId: string }>;

  /** Poll an async result by requestId */
  getResult(requestId: string): Promise<{ status: "pending" | "complete" | "error"; result?: ToolResult }>;

  /** Execute a tool on all connected browsers */
  executeAll(tool: string, params: Record<string, unknown>): Promise<ToolResult[]>;

  /** Execute multiple tools on one or more browsers in parallel */
  executeBatch(batch: Array<{ browserId: string; tool: string; params: Record<string, unknown> }>): Promise<ToolResult[]>;

  /** Get available tools for a specific browser */
  getCapabilities(browserId: string): Promise<string[]>;

  /** Check if a browser is connected */
  isConnected(browserId: string): Promise<boolean>;

  /** Find a browser ID by exact name match. Throws if not found or ambiguous. */
  findBrowserByName(name: string): Promise<string>;
}

export interface BrowserInfo {
  id: string;
  name: string;
  connected: boolean;
  capabilities: string[];
  lastHeartbeat: number;
}
