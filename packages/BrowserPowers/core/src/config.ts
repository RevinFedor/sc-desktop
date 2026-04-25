import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Permission, ServerConfig } from "./types.js";

const CONFIG_DIR = join(homedir(), ".config", "browserpowers");
const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");

const DEFAULT_CONFIG: ServerConfig = {
  port: 4199,
  host: "127.0.0.1",
  mcp: {
    enabled: true,
    path: "/mcp",
  },
  rest: {
    enabled: true,
    path: "/api",
  },
  ws: {
    path: "/ws",
    heartbeatIntervalMs: 30_000,
  },
  gates: {
    defaultPermission: "ask",
    approvalTimeoutMs: 60_000,
  },
  queue: {
    maxDepth: 50,
    defaultTimeoutMs: 120_000,
  },
  execution: {
    commandMode: "sync",
  },
  browsers: {},
  auth: {
    apiKey: "",
  },
};

/** Cached config — loaded once at startup, avoids 2× disk read per tool execution */
let cachedConfig: ServerConfig | null = null;

export function loadConfig(): ServerConfig {
  if (cachedConfig) return cachedConfig;

  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, stringify(DEFAULT_CONFIG), "utf-8");
    chmodSync(CONFIG_PATH, 0o600);
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  let parsed: Partial<ServerConfig> = {};
  try {
    parsed = parse(raw) as Partial<ServerConfig>;
  } catch (err) {
    throw new Error(
      `Failed to parse config YAML at ${CONFIG_PATH}: ${(err as Error).message}. ` +
      `Fix or delete the file to start the server with safe defaults.`
    );
  }

  cachedConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    mcp: { ...DEFAULT_CONFIG.mcp, ...parsed.mcp },
    rest: { ...DEFAULT_CONFIG.rest, ...parsed.rest },
    ws: { ...DEFAULT_CONFIG.ws, ...parsed.ws },
    gates: { ...DEFAULT_CONFIG.gates, ...parsed.gates },
    queue: { ...DEFAULT_CONFIG.queue, ...parsed.queue },
    execution: { ...DEFAULT_CONFIG.execution, ...parsed.execution },
    auth: { ...DEFAULT_CONFIG.auth, ...parsed.auth },
  };

  return cachedConfig;
}

/** Force-reload config from disk (used in tests or after config changes) */
export function reloadConfig(): ServerConfig {
  cachedConfig = null;
  return loadConfig();
}

export function saveConfig(config: ServerConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, stringify(config), "utf-8");
  chmodSync(CONFIG_PATH, 0o600);
}

export { CONFIG_DIR, CONFIG_PATH };
