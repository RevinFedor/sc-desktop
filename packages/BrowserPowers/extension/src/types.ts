export type PermissionLevel = "allow" | "deny" | "ask";

export type PagePermissionGroup = "page.read" | "page.act" | "page.execute";

export interface SitePermissionLists {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface ExtensionSettings {
  browserName: string;
  coreUrl: string;
  authKey: string;  // API key for core authentication (empty = none)
  approvalNotificationsEnabled: boolean;
  permissions: Record<string, PermissionLevel>;
  pageSitePermissions: Record<PagePermissionGroup, SitePermissionLists>;
}

// ── Page Interaction API v2 ──

export interface Target {
  css?: string;
  text?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
}

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
