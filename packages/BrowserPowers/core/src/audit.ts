/**
 * FILE: core/src/audit.ts
 * PURPOSE: Append-only rotating JSONL audit log for all command executions.
 *          Writes to ~/.config/browserpowers/audit/audit-YYYY-MM-DD.jsonl.
 *          Rotates files at 10MB (renames current, starts new).
 * OWNS: Audit log file lifecycle — append, rotate, no read API (append-only).
 * EXPORTS: logAudit, getAuditDir
 * DOCS: .agents/reports/plan_medium-low_2026-05-27.md (#032)
 */

import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const AUDIT_DIR = join(homedir(), ".config", "browserpowers", "audit");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

let currentFile: string | null = null;
let currentSize = 0;

function ensureDir(): void {
  if (!existsSync(AUDIT_DIR)) {
    mkdirSync(AUDIT_DIR, { recursive: true });
  }
}

function getCurrentFile(): string {
  if (!currentFile) {
    ensureDir();
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    currentFile = join(AUDIT_DIR, `audit-${date}.jsonl`);
    if (existsSync(currentFile)) {
      try {
        currentSize = statSync(currentFile).size;
      } catch {
        currentSize = 0;
      }
    }
  }
  return currentFile;
}

function rotateIfNeeded(): void {
  if (currentSize >= MAX_FILE_SIZE && currentFile) {
    const ts = Date.now();
    const rotated = currentFile.replace(".jsonl", `-${ts}.jsonl`);
    try {
      renameSync(currentFile, rotated);
      console.log(`[audit] Rotated ${currentFile} -> ${rotated}`);
    } catch {
      // Best-effort rotation — if rename fails, keep writing to current file
    }
    currentFile = null;
    currentSize = 0;
  }
}

/**
 * Append a single JSONL entry to the audit log.
 * The entry is enriched with a timestamp before writing.
 */
export async function logAudit(entry: Record<string, unknown>): Promise<void> {
  try {
    rotateIfNeeded();
    const file = getCurrentFile();
    const line = JSON.stringify({ _t: new Date().toISOString(), ...entry }) + "\n";
    await appendFile(file, line);
    currentSize += Buffer.byteLength(line, "utf-8");
  } catch (err) {
    console.error("[audit] Failed to write audit entry:", (err as Error).message);
  }
}

/**
 * Get the audit log directory path (for inspection or cleanup).
 */
export function getAuditDir(): string {
  return AUDIT_DIR;
}
