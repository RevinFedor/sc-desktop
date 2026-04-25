import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";
import { createConnection } from "net";

export let coreProcess: ChildProcess | null = null;
export const CORE_PORT = 4199;

/**
 * Wait until a TCP port is accepting connections.
 */
async function waitForPort(port: number, host: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await new Promise<void>((resolve, reject) => {
        const socket = createConnection(port, host, () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", () => {
          socket.destroy();
          reject();
        });
      });
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Timed out waiting for ${host}:${port} after ${timeoutMs}ms`);
}

/**
 * Global setup for Playwright e2e tests.
 * Starts the core server on port 4199 before all tests.
 */
async function globalSetup(): Promise<() => Promise<void>> {
  const rootDir = resolve(__dirname, "..");
  const coreDir = resolve(rootDir, "core");

  console.log(`\n[setup] Starting core on port ${CORE_PORT}...`);

  // Start core only (not the full `pnpm dev` which would also start extension dev server)
  coreProcess = spawn("pnpm", ["dev"], {
    cwd: coreDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  coreProcess.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[core] ${line}`);
  });

  coreProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[core:err] ${line}`);
  });

  // Wait for core to be ready
  try {
    await waitForPort(CORE_PORT, "127.0.0.1", 30_000);
    console.log(`[setup] Core is ready on port ${CORE_PORT}`);
  } catch (err) {
    console.error("[setup] Core failed to start:", err);
    throw err;
  }

  // Return teardown function
  return async () => {
    console.log("[teardown] Stopping core...");
    if (coreProcess && !coreProcess.killed) {
      coreProcess.kill("SIGTERM");
      setTimeout(() => {
        if (coreProcess && !coreProcess.killed) {
          coreProcess.kill("SIGKILL");
        }
      }, 3000);
    }
  };
}

export default globalSetup;
