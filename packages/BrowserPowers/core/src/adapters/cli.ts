import { Command } from "commander";
import { loadConfig } from "../config.js";
import { stringify } from "yaml";

const config = loadConfig();
const BASE = `http://${config.host}:${config.port}${config.rest.path}`;
const FETCH_TIMEOUT_MS = 5000;

function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers ?? {});
  if (config.auth.apiKey) {
    headers.set("Authorization", `Bearer ${config.auth.apiKey}`);
  }
  return fetch(url, {
    ...options,
    headers,
    signal: options?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

function cliError(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

/** Format data as human-readable text instead of raw JSON (#009). */
function prettyPrint(data: unknown): string {
  if (data === null || data === undefined) return "(empty)";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (Array.isArray(data)) {
    return data.map(item => typeof item === "object" ? JSON.stringify(item, null, 2) : String(item)).join("\n");
  }
  return JSON.stringify(data, null, 2);
}

/** Execute a tool via REST, handling --async mode if set on the program */
async function executeViaRest(
  browserId: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const isAsync = program.opts().async;
  if (isAsync) {
    const res = await apiFetch(`${BASE}/browsers/${browserId}/execute-async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, params }),
    });
    const data = await res.json() as { requestId?: string; error?: string };
    if (data.error) cliError(data.error);
    console.log(`⏳ Queued as ${data.requestId}`);
    console.log(`   Poll: GET ${BASE}/results/${data.requestId}`);
    return null;
  }
  const res = await apiFetch(`${BASE}/browsers/${browserId}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, params }),
  });
  return res.json();
}

const program = new Command();

program
  .name("browserpowers")
  .description("CLI for multi-browser agent control")
  .version("1.0.0")
  .option("--async", "Execute asynchronously — print requestId and exit immediately");

// ── Helper: auto-detect target type from shorthand string (#028) ──
// Mirrors Playwright's locator behavior:
//   "#id"     → CSS, ".class"   → CSS, "[attr]" → CSS
//   "text:"   → text literal
//   bare string  → text (matched against visible text)

function autoDetectTarget(input: string): Record<string, unknown> {
  input = input.trim();
  if (input.startsWith("#") || input.startsWith(".") || input.startsWith("[")) {
    return { css: input };
  }
  if (input.startsWith("text:")) {
    return { text: input.slice(5).trim() };
  }
  // Bare string — treat as text match
  return { text: input };
}

// ── Helper: parse key=value args and JSON into a params object ──

function parseParamArgs(args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const arg of args) {
    // Try JSON first
    try {
      const parsed = JSON.parse(arg);
      if (typeof parsed === "object" && parsed !== null) {
        Object.assign(params, parsed);
        continue;
      }
    } catch {
      // Not JSON, try key=value
    }
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      const key = arg.slice(0, eqIdx);
      const val = arg.slice(eqIdx + 1);
      // Try to parse as number or boolean
      if (val === "true") params[key] = true;
      else if (val === "false") params[key] = false;
      else if (!isNaN(Number(val))) params[key] = Number(val);
      else params[key] = val;
    }
  }
  return params;
}

// ── list ──
program
  .command("list")
  .description("List all connected browsers")
  .action(async () => {
    const res = await apiFetch(`${BASE}/browsers`);
    const { browsers } = await res.json() as { browsers: any[] };
    if (browsers.length === 0) {
      console.log("No browsers connected.");
      return;
    }
    for (const b of browsers) {
      console.log(`  ${b.id}  "${b.name}"  [${b.capabilities.join(", ")}]  heartbeat: ${new Date(b.lastHeartbeat).toISOString()}`);
    }
  });

// ── navigate ──
program
  .command("navigate <browserId> <url>")
  .description("Navigate a browser to a URL")
  .action(async (browserId: string, url: string) => {
    const result = await executeViaRest(browserId, "tabs.create", { url }) as any;
    if (result === null) return; // async mode
    console.log(result.success ? `✅ Navigated to ${url}` : `❌ ${result.error}`);
  });

// ── screenshot ──
program
  .command("screenshot <browserId> [filepath]")
  .description("Take a screenshot of a browser tab")
  .action(async (browserId: string, filepath?: string) => {
    const result = await executeViaRest(browserId, "screenshots.capture", {}) as any;
    if (result === null) return; // async mode
    if (!result.success) {
      cliError(result.error ?? "Screenshot failed");
    }
    if (filepath && result.data?.base64) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(filepath, Buffer.from(result.data.base64, "base64"));
      console.log(`✅ Screenshot saved to ${filepath}`);
    } else {
      console.log(JSON.stringify(result.data));
    }
  });

// ── content ──
program
  .command("content <browserId> [selector]")
  .description("Get page content from a browser")
  .action(async (browserId: string, selector?: string) => {
    const result = await executeViaRest(browserId, "page.read", { action: "content", target: selector ? { css: selector } : undefined }) as any;
    if (result === null) return; // async mode
    if (!result.success) {
      cliError(result.error ?? "Content fetch failed");
    }
    console.log(prettyPrint(result.data));
  });

// ── select ──
program
  .command("select <browserId>")
  .description("Get selected text from a browser")
  .action(async (browserId: string) => {
    const result = await executeViaRest(browserId, "page.read", { action: "select" }) as any;
    if (result === null) return; // async mode
    if (!result.success) {
      cliError(result.error ?? "Select text fetch failed");
    }
    console.log(prettyPrint(result.data));
  });

// ── tabs ──
program
  .command("tabs <browserId>")
  .description("List all tabs in a browser")
  .action(async (browserId: string) => {
    const result = await executeViaRest(browserId, "tabs.list", {}) as any;
    if (result === null) return; // async mode
    if (!result.success) {
      cliError(result.error ?? "Tabs list failed");
    }
    console.log(prettyPrint(result.data));
  });

// ── exec ──
program
  .command("exec <browserId> <tool> [params...]")
  .description("Execute any tool with JSON params")
  .action(async (browserId: string, tool: string, paramArgs: string[]) => {
    let params: Record<string, unknown> = {};
    if (paramArgs.length > 0) {
      try {
        params = JSON.parse(paramArgs.join(" "));
      } catch {
        cliError("Invalid JSON params");
      }
    }
    const result = await executeViaRest(browserId, tool, params) as any;
    if (result === null) return; // async mode
    console.log(JSON.stringify(result, null, 2));
  });

// ── exec-all ──
program
  .command("exec-all <tool> [params...]")
  .description("Execute a tool on ALL browsers (pretty-printed by default)")
  .option("--json", "Output raw JSON instead of pretty-printed table")
  .action(async (tool: string, paramArgs: string[], options: { json?: boolean }) => {
    let params: Record<string, unknown> = {};
    if (paramArgs.length > 0) {
      try {
        params = JSON.parse(paramArgs.join(" "));
      } catch {
        cliError("Invalid JSON params");
      }
    }
    const res = await apiFetch(`${BASE}/execute-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, params }),
    });
    const result = await res.json() as { results?: Array<{ browserId?: string; success?: boolean; error?: string; data?: unknown }> };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Pretty-print grouped by browser name
    const results = result.results ?? [];
    if (results.length === 0) {
      console.log("No browsers connected.");
      return;
    }

    // Fetch browser list for name mapping
    let nameMap = new Map<string, string>();
    try {
      const browsersRes = await apiFetch(`${BASE}/browsers`);
      const { browsers } = await browsersRes.json() as { browsers: Array<{ id: string; name: string }> };
      nameMap = new Map(browsers.map(b => [b.id, b.name]));
    } catch {
      // If fetch fails, fall back to showing IDs only
    }

    console.log(`\n  Tool: ${tool}`);
    console.log(`  Results (${results.length} browser(s)):\n`);
    for (const r of results) {
      const icon = r.success ? "✅" : "❌";
      const brief = r.success ? "OK" : (r.error ?? "Unknown error").slice(0, 80);
      const displayName = nameMap.get(r.browserId ?? "") ?? r.browserId ?? "?";
      console.log(`    ${icon} ${displayName}  — ${brief}`);
    }
    console.log("");
  });

// ── page read ──
program
  .command("page")
  .description("Page operations (read or act)")
  .addCommand(
    new Command("read")
      .description("Read page content without mutating it")
      .argument("<browserId>", "Target browser ID")
      .argument("<action>", "Read action: inspect, content, text, html, attr, meta, forms, count, select, summary, generate_selector")
      .argument("[params...]", "key=value params or JSON")
      .option("--json", "Output raw JSON")
      .action(async (browserId: string, action: string, paramArgs: string[], options: { json?: boolean }) => {
        const params = parseParamArgs(paramArgs);

        // Auto-detect target from shorthand (#028)
        if (params.target && typeof params.target === "string") {
          params.target = autoDetectTarget(params.target as string);
        }

        const res = await executeViaRest(browserId, "page.read", { action, ...params }) as any;
        if (res === null) return; // async mode
        if (!res.success) {
          cliError(res.error ?? "Page read failed");
        }
        if (options.json) {
          console.log(JSON.stringify(res.data, null, 2));
        } else {
          console.log(prettyPrint(res.data));
        }
      }),
  )
  .addCommand(
    new Command("act")
      .description("Interact with or mutate the page")
      .argument("<browserId>", "Target browser ID")
      .argument("<action>", "Act action: click, fill, check, select_option, press, scroll, submit, wait_for, type, smart_click, fill_form, upload, drag, dblclick, hover, dialog_override, dialog_respond")
      .argument("[params...]", "key=value params or JSON (e.g. target=#my-button or css=.btn)")
      .option("--json", "Output raw JSON")
      .action(async (browserId: string, action: string, paramArgs: string[], options: { json?: boolean }) => {
        const params = parseParamArgs(paramArgs);

        // Auto-detect target from shorthand (#028)
        if (params.target && typeof params.target === "string") {
          params.target = autoDetectTarget(params.target as string);
        }

        // For common commands, allow shorthand like "css=#my-button"
        if (params.css) {
          params.target = { css: params.css };
          delete params.css;
        }
        if (params.text) {
          params.target = { text: params.text };
          delete params.text;
        }

        const result = await executeViaRest(browserId, "page.act", { action, ...params }) as any;
        if (result === null) return; // async mode
        if (!result.success) {
          cliError(result.error ?? "Page act failed");
        }
        if (options.json) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          // Compact output for common actions
          const data = result.data;
          if (data?.message) {
            console.log(`  ✅ ${data.message}`);
            if (data.evidence) {
              console.log(`     ${JSON.stringify(data.evidence)}`);
            }
          } else {
            console.log(JSON.stringify(data, null, 2));
          }
        }
      }),
  );

// ── status ──
program
  .command("status")
  .description("Check daemon status, uptime, and connected browsers")
  .action(async () => {
    // Check if REST API is alive
    try {
      const healthRes = await apiFetch(`${BASE}/browsers`, {
        signal: AbortSignal.timeout(3000),
      });
      const { browsers } = await healthRes.json() as { browsers: any[] };

      // Try to read PID file
      const { homedir } = await import("node:os");
      const { readFileSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const pidPath = resolve(homedir(), ".browserpowers", "daemon.pid");

      console.log("\n  🔥 BrowserPowers Daemon\n");

      if (existsSync(pidPath)) {
        const pid = readFileSync(pidPath, "utf-8").trim();
        console.log(`  PID:      ${pid}`);
        console.log(`  Running:  ✅ Yes\n`);
      } else {
        console.log(`  PID:      (no PID file)`);
        console.log(`  Running:  ✅ (API responds)\n`);
      }

      console.log(`  API:      ${BASE}`);
      console.log(`  Browsers: ${browsers.length} connected\n`);

      if (browsers.length === 0) {
        console.log("  No browsers connected. Load the extension and check it's connecting to this server.");
      } else {
        for (const b of browsers) {
          const age = Math.round((Date.now() - b.connectedAt) / 1000);
          console.log(`    • ${b.id}  "${b.name}"  [${(b.capabilities || []).map((c: any) => c.tool || c).join(", ")}]  connected ${age}s ago`);
        }
      }
      console.log("");
    } catch (err) {
      console.log("\n  🔥 BrowserPowers Daemon\n");
      console.log(`  Running:  ❌ Not responding\n`);
      console.log(`  API:      ${BASE}`);
      console.log(`  Error:    ${(err as Error).message}\n`);
      console.log("  Start the daemon:  browserpowers serve\n");
      cliError("Daemon not responding");
    }
  });

// ── init ──
program
  .command("init")
  .description("Run the first-time setup wizard")
  .action(async () => {
    const { createInterface } = await import("node:readline");
    const { existsSync, writeFileSync, mkdirSync, chmodSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { resolve } = await import("node:path");
    const { loadConfig } = await import("../config.js");

    const configDir = resolve(homedir(), ".config", "browserpowers");
    const configPath = resolve(configDir, "config.yaml");

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const question = (query: string): Promise<string> =>
      new Promise((resolve) => rl.question(query, resolve));

    console.log(`
  ╔══════════════════════════════════════╗
  ║       BrowserPowers Setup Wizard     ║
  ╚══════════════════════════════════════╝
    `);

    if (existsSync(configPath)) {
      const overwrite = await question("Config already exists. Overwrite? (y/N) ");
      if (overwrite.toLowerCase() !== "y") {
        console.log("Setup cancelled. Existing config preserved.");
        rl.close();
        return;
      }
    }

    const port = await question("Core server port (default: 4199): ");
    const host = await question("Core server host (default: 127.0.0.1): ");
    const browserName = await question("Default browser name (default: My Browser): ");

    rl.close();

    const config = {
      port: port ? parseInt(port, 10) : 4199,
      host: host || "127.0.0.1",
      mcp: { enabled: true, path: "/mcp" },
      rest: { enabled: true, path: "/api" },
      ws: { path: "/ws", heartbeatIntervalMs: 30000 },
      gates: { defaultPermission: "ask" },
      browsers: {
        "default": {
          name: browserName || "My Browser",
          permissions: {
            tabs: "allow",
            "page.read": "allow",
            "page.act": "ask",
            "page.execute": "deny",
            screenshots: "allow",
            history: "deny",
            bookmarks: "deny",
            downloads: "deny",
            network: "deny",
            storage: "deny",
          },
        },
      },
    };

    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, stringify(config), "utf-8");
    chmodSync(configPath, 0o600);

    console.log(`\n✅ Config created at ${configPath}`);
    console.log("\n── Next steps ──");
    console.log("1. Start the core:    browserpowers serve");
    console.log("2. Load the extension in your browser (chrome://extensions → Load unpacked → extension/.output/chrome-mv3/)");
    console.log("3. Connect your MCP client to: http://127.0.0.1:4199/mcp");
    console.log("4. Run `browserpowers mcp-config --client claude` for Claude Desktop setup");
    console.log("5. Connect: The extension auto-connects to the core via WebSocket");
    console.log("6. Verify:  Run `browserpowers list` to see connected browsers\n");
  });

// ── stop ──
program
  .command("stop")
  .description("Stop the running daemon")
  .action(async () => {
    const { homedir } = await import("node:os");
    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const pidPath = resolve(homedir(), ".browserpowers", "daemon.pid");

    // First try REST graceful shutdown
    try {
      const res = await apiFetch(`${BASE}/browsers`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log("To stop: press Ctrl+C in the server terminal, or kill the process.");
        console.log(`If you have a PID file at ${pidPath}, use: taskkill /PID $(type ${pidPath})`);
        return;
      }
    } catch {
      // Server not responding
    }

    // Try PID file
    if (existsSync(pidPath)) {
      const pid = readFileSync(pidPath, "utf-8").trim();
      console.log(`Found PID ${pid} from ${pidPath}`);
      console.log(`Run: taskkill /PID ${pid} (Windows) or kill ${pid} (Unix)`);
    } else {
      console.log("Cannot determine how to stop the daemon. No PID file found and API not responding.");
      process.exit(1);
    }
  });

// ── config ──
program
  .command("config")
  .description("Show configuration")
  .addCommand(
    new Command("show")
      .description("Print current configuration")
      .action(async () => {
        const { loadConfig } = await import("../config.js");
        const cfg = loadConfig();
        console.log(JSON.stringify(cfg, null, 2));
      })
  )
  .addCommand(
    new Command("path")
      .description("Print config file location")
      .action(async () => {
        const { CONFIG_PATH } = await import("../config.js");
        console.log(CONFIG_PATH);
      })
  );

// ── mcp-config ──
program
  .command("mcp-config")
  .description("Generate MCP client configuration snippet")
  .option("-c, --client <name>", "Target client: claude, cursor, or generic")
  .action(async (options: { client?: string }) => {
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();
    const baseUrl = `http://${config.host}:${config.port}${config.mcp.path}`;

    const client = (options.client || "generic").toLowerCase();

    const snippets: Record<string, object> = {
      generic: {
        mcpServers: {
          browserpowers: {
            url: baseUrl,
          },
        },
      },
      claude: {
        mcpServers: {
          browserpowers: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-stdio"],
            url: baseUrl,
          },
        },
      },
      cursor: {
        mcpServers: {
          browserpowers: {
            url: baseUrl,
            type: "streamable-http",
          },
        },
      },
    };

    const snippet = snippets[client] ?? snippets.generic;

    console.log(JSON.stringify(snippet, null, 2));
    console.log(`\n// Paste the above into your ${client === "generic" ? "MCP client" : client + " config"} file to connect BrowserPowers.\n`);
  });

// ── disconnect ──
program
  .command("disconnect <browserId>")
  .description("Disconnect a browser from the daemon")
  .action(async (browserId: string) => {
    try {
      const res = await apiFetch(`${BASE}/browsers/${browserId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        console.log(`✅ Disconnected browser ${browserId}`);
      } else {
        const err = await res.json() as { error?: string };
        cliError(err.error || `Failed to disconnect browser ${browserId}`);
      }
    } catch (e) {
      cliError(`Failed to disconnect: ${(e as Error).message}`);
    }
  });

// ── approvals ──
program
  .command("approvals")
  .description("Manage pending approval requests")
  .addCommand(
    new Command("list")
      .description("List all pending approvals")
      .action(async () => {
        try {
          const res = await apiFetch(`${BASE}/approvals`);
          const data = await res.json() as { approvals: any[] };
          if (data.approvals.length === 0) {
            console.log("No pending approvals.");
            return;
          }
          for (const a of data.approvals) {
            console.log(`  ${a.requestId}  tool: ${a.tool}  browser: ${a.browserId}  waiting since ${new Date(a.requestedAt).toISOString()}`);
          }
        } catch (e) {
          cliError(`Failed to list approvals: ${(e as Error).message}`);
        }
      })
  )
  .addCommand(
    new Command("cancel <requestId>")
      .description("Cancel a pending approval request")
      .action(async (requestId: string) => {
        try {
          const res = await apiFetch(`${BASE}/approvals/${requestId}`, { method: "DELETE" });
          if (res.ok) {
            console.log(`✅ Cancelled approval ${requestId}`);
          } else {
            const err = await res.json() as { error?: string };
            cliError(err.error || `Failed to cancel approval`);
          }
        } catch (e) {
          cliError(`Failed to cancel: ${(e as Error).message}`);
        }
      })
  );

// ── capabilities ──
program
  .command("capabilities <browserId>")
  .description("List capabilities for a specific browser")
  .action(async (browserId: string) => {
    try {
      const res = await apiFetch(`${BASE}/browsers/${browserId}/capabilities`);
      const data = await res.json() as { capabilities: Array<{ tool: string; description: string; group: string }> | string[] };
      const caps = data.capabilities;
      if (!caps || caps.length === 0) {
        console.log(`No capabilities for browser ${browserId}`);
        return;
      }
      for (const c of caps) {
        if (typeof c === "string") {
          console.log(`  • ${c}`);
        } else {
          console.log(`  • ${c.tool}  (${c.group})  — ${c.description || "no description"}`);
        }
      }
    } catch (e) {
      cliError(`Failed to list capabilities: ${(e as Error).message}`);
    }
  });

// ── serve ──
program
  .command("serve")
  .description("Start the BrowserPowers core server (HTTP + WebSocket + MCP)")
  .option("--pid-file <path>", "Path to write PID file for process management")
  .action(() => {
    // Serve mode is handled in index.ts, not here.
    // This command exists so --pid-file appears in --help output.
    console.log("To start the server, run: browserpowers serve");
    console.log("The server will start in the foreground. Press Ctrl+C to stop.");
  });

export function runCli(args: string[]): void {
  program.parse(["node", "browserpowers", ...args]);
}

export default program;
