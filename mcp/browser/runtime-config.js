import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function port(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error(name + ' must be an integer between 1 and 65535');
  }
  return Number(raw);
}

export const EXT_PORT = port('SC_BROWSER_EXT_PORT', 3457);
export const MCP_PORT = port('SC_BROWSER_MCP_PORT', 3458);
export const DATA_DIR = process.env.SC_BROWSER_DATA_DIR
  ? resolve(process.env.SC_BROWSER_DATA_DIR)
  : join(homedir(), 'Library', 'Application Support', 'sc-desktop', 'browser-mcp');
export const BRIDGE_LOG = join(DATA_DIR, 'bridge.log');
export const APP_URL = process.env.SC_BROWSER_APP_URL || 'http://127.0.0.1:53127';
const app = new URL(APP_URL);
if (app.protocol !== 'http:' || app.hostname !== '127.0.0.1' || app.username || app.password) {
  throw new Error('SC_BROWSER_APP_URL must be a loopback HTTP URL');
}
