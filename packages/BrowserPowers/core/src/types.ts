// ── Core Types for BrowserPowers ──

/** Permission level for a tool or toolgroup */
export type Permission = "allow" | "deny" | "ask";

/** Known toolgroups (capability categories) */
export type ToolGroup =
  | "tabs"
  | "page.read"
  | "page.act"
  | "page.execute"
  | "screenshots"
  | "history.read"
  | "history.delete"
  | "bookmarks.read"
  | "bookmarks.modify"
  | "bookmarks.delete"
  | "cookies"
  | "downloads"
  | "network"
  | "storage"
  | "windows";

/** Permissions map: toolgroup → permission level */
export type PermissionProfile = Partial<Record<ToolGroup, Permission>>;

/** Execution mode for a browser: sync waits for result, async returns requestId immediately */
export type CommandMode = "sync" | "async";

/** A registered browser connection */
export interface Browser {
  id: string;
  name: string; // user-assigned name, e.g. "Work Chrome"
  capabilities: Capability[];
  permissions: PermissionProfile;
  commandMode: CommandMode;
  connectedAt: number;
  lastHeartbeat: number;
}

/** A single capability the browser exposes */
export interface Capability {
  tool: string;        // e.g. "tabs.list", "page.content"
  description: string; // human-readable
  group: ToolGroup;
}


// ── WebSocket Protocol ──

/** Extension → Core messages */
export type ExtToCore =
  | { type: "register"; payload: RegisterPayload }
  | { type: "result"; payload: { requestId: string; data: unknown } }
  | { type: "error"; payload: { requestId: string; message: string } }
  | { type: "heartbeat" }
  | { type: "approval_response"; payload: { requestId: string; approved: boolean; timed_out?: boolean } };

/** Core → Extension messages */
export type CoreToExt =
  | { type: "registered"; payload: { browserId: string } }
  | { type: "execute"; payload: { requestId: string; tool: string; params: Record<string, unknown>; commandMode: CommandMode } }
  | { type: "heartbeat_ack" }
  | { type: "config_updated"; payload: PermissionProfile }
  | { type: "request_approval"; payload: { requestId: string; tool: string; params: Record<string, unknown>; description: string } }
  | { type: "auth_required"; payload: { message: string } };

export interface RegisterPayload {
  name: string;
  capabilities: Capability[];
  permissions: PermissionProfile;
  /** Stable ID from a previous session — reuse on reconnect instead of generating a new UUID */
  browserId?: string;
  /** API key for core server authentication (optional — only needed when core requires it) */
  authKey?: string;
  /** Execution mode for this browser ("sync" | "async"). Defaults to server config if omitted. */
  commandMode?: CommandMode;
}


// ── Command Service ──

export interface ToolCall {
  browserId: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ToolResult {
  browserId: string;
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ── Page Interaction API v2 ──

/** Structured target for page operations */
export interface Target {
  css?: string;
  text?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
}

/** Lightweight anchor reference for fast follow-up actions */
export interface AnchorRef {
  id: string;
  tabId: number;
  frameId?: string;
  documentId?: string;
}

/** Page interaction action types — read */
export type ReadAction =
  | "inspect" | "content" | "text" | "html"
  | "attr" | "meta" | "forms" | "count" | "select"
  | "summary" | "frames" | "generate_selector";

/** Page interaction action types — act */
export type ActAction =
  | "click" | "fill" | "check" | "select_option"
  | "press" | "scroll" | "submit" | "wait_for"
  | "type" | "smart_click"
  | "upload" | "drag" | "dblclick" | "hover"
  | "dialog_override" | "dialog_respond";

/** ActionResult envelope — every page tool returns this shape */
export interface ActionResult {
  success: boolean;
  status: "performed" | "already_in_desired_state" | "not_performed" | "ambiguous" | "blocked";
  action: string;
  message: string;
  targetSummary?: string;
  evidence?: Record<string, unknown>;
  errorCode?: string;
  recoverable?: boolean;
  suggestions?: string[];
  data?: Record<string, unknown>;
}

/** Available tools exposed to MCP/REST/CLI clients */
export interface ToolDefinition {
  name: string;
  description: string;
  group: ToolGroup;
  inputSchema: Record<string, unknown>;
}


// ── Queue ──

/** A single item in the per-browser request queue */
export interface QueuedItem {
  requestId: string;
  tool: string;
  params: Record<string, unknown>;
  resolve: (result: ToolResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
  browserId: string;
}

/** Queue configuration */
export interface QueueConfig {
  maxDepth: number;
  defaultTimeoutMs: number;
}

// ── Config ──

export interface ServerConfig {
  port: number;
  host: string;
  mcp: {
    enabled: boolean;
    path: string;
  };
  rest: {
    enabled: boolean;
    path: string;
  };
  ws: {
    path: string;
    heartbeatIntervalMs: number;
  };
  gates: {
    defaultPermission: Permission;
    approvalTimeoutMs?: number;
  };
  queue: QueueConfig;
  execution: {
    /** Default execution mode for browsers that don't specify one ("sync" | "async") */
    commandMode: CommandMode;
  };
  browsers: Record<string, { name: string; permissions: PermissionProfile }>;
  auth: {
    apiKey: string;  // empty = no auth required
  };
}
