/**
 * FILE: extension/src/site-permissions.ts
 * PURPOSE: Resolve site-pattern permission decisions for page tools (read, act, execute).
 * OWNS: Domain pattern matching and permission resolution logic for site-specific rules.
 * EXPORTS: normalizeHostname(url), matchDomainPattern(hostname, pattern), resolvePagePermission(url, lists)
 * DOCS: agent_chat/plan_site_permissions_2026-05-13.md
 */

import type { PagePermissionGroup, SitePermissionLists } from "./types";

/**
 * Extract and normalize hostname from a URL string.
 * Strips www. prefix for consistent matching.
 */
export function normalizeHostname(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Check whether a hostname matches a pattern.
 * Patterns can be:
 *   "*"                → matches everything
 *   "example.com"      → exact match (after www normalization)
 *   "*.example.com"    → suffix match (example.com and all subdomains)
 */
export function matchDomainPattern(hostname: string, pattern: string): boolean {
  if (pattern === "*") return true;

  const normalized = pattern.toLowerCase();

  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(2);
    return hostname === suffix || hostname.endsWith("." + suffix);
  }

  return hostname === normalized;
}

/**
 * Score a pattern match: higher = more specific.
 * exact domain = 2, wildcard subdomain = 1, * = 0
 */
function patternScore(pattern: string): number {
  if (pattern === "*") return 0;
  if (pattern.startsWith("*.")) return 1;
  return 2;
}

/**
 * Resolve the permission decision for a page tool on a given URL.
 *
 * Returns one of: "allow" | "ask" | "deny"
 *
 * Resolution order:
 * 1. Find all matching patterns across allow/ask/deny lists
 * 2. Pick the most specific match (exact > wildcard > *)
 * 3. If equally specific matches conflict, safest wins: deny > ask > allow
 * 4. If no pattern matches, returns "ask" (conservative default)
 */
export function resolvePagePermission(
  url: string,
  lists: SitePermissionLists,
): "allow" | "ask" | "deny" {
  const hostname = normalizeHostname(url);
  if (!hostname) return "ask";

  let bestDecision: "allow" | "ask" | "deny" = "ask";
  let bestScore = -1;

  const entries: Array<[string, "allow" | "ask" | "deny"]> = [
    ...lists.allow.map((p) => [p, "allow"] as const),
    ...lists.ask.map((p) => [p, "ask"] as const),
    ...lists.deny.map((p) => [p, "deny"] as const),
  ];

  for (const [pattern, decision] of entries) {
    if (!matchDomainPattern(hostname, pattern)) continue;

    const score = patternScore(pattern);

    if (score > bestScore) {
      bestDecision = decision;
      bestScore = score;
    } else if (score === bestScore) {
      // Tie: safest wins (deny > ask > allow)
      const safetyOrder: Record<string, number> = { deny: 2, ask: 1, allow: 0 };
      if ((safetyOrder[decision] ?? 0) > (safetyOrder[bestDecision] ?? 0)) {
        bestDecision = decision;
      }
    }
  }

  return bestDecision;
}
