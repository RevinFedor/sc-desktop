import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const require = createRequire(import.meta.url);
const base = process.env.SC_DESKTOP_TEST_ROOT || join(homedir(), 'Library', 'Application Support', 'sc-desktop', 'test-artifacts', 'publication-smoke');
mkdirSync(base, { recursive: true });
async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function marker(stream, expected) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => { stream.off('data', read); reject(new Error('Missing state marker: ' + expected + ' ' + text)); }, 10000);
    const read = data => { text += data.toString(); if (text.includes(expected)) { clearTimeout(timeout); stream.off('data', read); resolve(); } };
    stream.on('data', read);
  });
}
async function open(url, options) { const ws = new WebSocket(url, options); await once(ws, 'open'); return ws; }
async function refused(url, origin) {
  const ws = new WebSocket(url, { origin });
  const error = await once(ws, 'error'); assert.match(error[0].message, /401/);
}

test('isolated bridge: browser origins rejected, clients routed independently, stdio catalog and read call', { timeout: 20000 }, async t => {
  const folder = mkdtempSync(join(base, 'bridge-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const extPort = await freePort(), mcpPort = await freePort();
  const env = { ...process.env, SC_BROWSER_EXT_PORT: String(extPort), SC_BROWSER_MCP_PORT: String(mcpPort),
    SC_BROWSER_DATA_DIR: folder, SC_BROWSER_APP_URL: 'http://127.0.0.1:1' };
  const bridge = spawn(process.execPath, [join(here, 'bridge.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (bridge.exitCode === null) { bridge.kill('SIGTERM'); await once(bridge, 'exit'); } });
  await marker(bridge.stdout, '[Bridge] Ready.');
  await refused('ws://127.0.0.1:' + extPort, 'https://untrusted.example');
  await refused('ws://127.0.0.1:' + extPort, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  await refused('ws://127.0.0.1:' + mcpPort, 'https://untrusted.example');
  const manifest = JSON.parse(readFileSync(join(root, 'browser-extension/manifest.json')));
  const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  const extension = await open('ws://127.0.0.1:' + extPort, { origin: 'chrome-extension://' + id });
  t.after(() => extension.terminate());
  extension.on('message', raw => {
    const command = JSON.parse(raw.toString());
    const answer = command.action === 'mcp_list_tabs' ? { tabs: [{ id: 7, url: 'http://fixture.example/', title: 'Fixture' }] }
      : { text: 'tab-' + command.tabId };
    extension.send(JSON.stringify({ ...answer, commandId: command.commandId, success: true }));
  });
  const left = await open('ws://127.0.0.1:' + mcpPort), right = await open('ws://127.0.0.1:' + mcpPort);
  t.after(() => { left.terminate(); right.terminate(); });
  const replies = [once(left, 'message'), once(right, 'message')];
  left.send(JSON.stringify({ commandId: 1, action: 'mcp_get_text', tabId: 101 }));
  right.send(JSON.stringify({ commandId: 1, action: 'mcp_get_text', tabId: 202 }));
  const decoded = (await Promise.all(replies)).map(([data]) => JSON.parse(data.toString()));
  assert.deepEqual(decoded.map(x => [x.commandId, x.text]), [[1, 'tab-101'], [1, 'tab-202']]);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, 'index.js')], env, stderr: 'pipe' });
  const ready = marker(transport.stderr, '[MCP] Connected to bridge');
  const client = new Client({ name: 'isolated-setup-check', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport); await ready;
  const catalog = await client.listTools();
  assert(catalog.tools.some(tool => tool.name === 'list_tabs'));
  assert(catalog.tools.some(tool => tool.name === 'snapshot'));
  const result = await client.callTool({ name: 'list_tabs', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text)[0].id, 7);
});

test('native log setup keeps public identity, supports quoted paths and creates no private key', () => {
  const folder = mkdtempSync(join(base, "native space's-"));
  try {
    const { install } = require('../../browser-extension/nmh/setup.js');
    const before = readFileSync(join(root, 'browser-extension/manifest.json'));
    const options = { dataDir: join(folder, 'data'), targetRoot: join(folder, 'targets') };
    const plan = install(options); assert.deepEqual(install(options), plan);
    assert.deepEqual(readFileSync(join(root, 'browser-extension/manifest.json')), before);
    assert.equal(existsSync(join(root, 'browser-extension/nmh/extension-key.pem')), false);
    for (const destination of plan.destinations) {
      const manifest = JSON.parse(readFileSync(destination));
      assert.equal(manifest.path, plan.wrapperPath);
      assert.deepEqual(manifest.allowed_origins, ['chrome-extension://' + plan.extensionId + '/']);
    }
    execFileSync('/bin/bash', ['-n', plan.wrapperPath]);
    const payload = Buffer.from(JSON.stringify({ tag: 'fixture', msg: 'native setup verification', ack: true }));
    const length = Buffer.alloc(4); length.writeUInt32LE(payload.length);
    const output = execFileSync('/bin/bash', [plan.wrapperPath], { input: Buffer.concat([length, payload]) });
    assert.equal(JSON.parse(output.subarray(4, 4 + output.readUInt32LE(0)).toString()).ok, true);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
