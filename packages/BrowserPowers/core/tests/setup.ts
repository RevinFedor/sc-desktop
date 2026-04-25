import { createServer, type Server } from "node:http";
import { vi } from "vitest";

/**
 * Allocate a random available TCP port for testing.
 */
export async function getRandomPort(): Promise<number> {
  const getPort = await import("get-port");
  return getPort.default();
}

/**
 * Create a minimal HTTP server on a random port for WS testing.
 * Returns { server, port, url } and a close() function.
 */
export async function createTestServer(): Promise<{
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer();
  const port = await getRandomPort();
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return {
    server,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

/**
 * Helper: wait for a condition function to return truthy, with timeout.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}
