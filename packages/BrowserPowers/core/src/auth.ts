// FILE: core/src/auth.ts
// PURPOSE: Shared authentication utilities for core server API key validation
// OWNS: API key validation logic used by REST/MCP/WS endpoints
// EXPORTS: isAuthRequired, validateApiKey
// DOCS: docs/spec.md §9 Authentication

import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config.js";

/**
 * Returns true when an API key has been configured and auth is required.
 * When false, all endpoints skip authentication checks entirely.
 */
export function isAuthRequired(): boolean {
  const cfg = loadConfig();
  return cfg.auth.apiKey.length > 0;
}

/**
 * Validates an API key against the configured key.
 * Returns true when auth is disabled (no key configured).
 * Returns true when the provided key matches the configured key.
 * Returns false when the key is missing, wrong, or auth is required but no key provided.
 */
export function validateApiKey(key: string | null | undefined): boolean {
  const cfg = loadConfig();
  if (!isAuthRequired()) return true;         // auth disabled — pass
  if (!key) return false;                     // key required but missing
  const keyBuf = Buffer.from(key);
  const cfgBuf = Buffer.from(cfg.auth.apiKey);
  if (keyBuf.length !== cfgBuf.length) return false;
  return timingSafeEqual(keyBuf, cfgBuf);
}
