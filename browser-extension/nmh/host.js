#!/usr/bin/env node
// Native Messaging Host for SC Browser Parser.
// Reads length-prefixed JSON messages from stdin, appends them to logs/exporter-YYYY-MM-DD.log.
// Each message is one full event from the extension.

const fs = require('fs');
const path = require('path');

const os = require('node:os');
const LOG_DIR = process.env.SC_BROWSER_DATA_DIR
  ? path.resolve(process.env.SC_BROWSER_DATA_DIR)
  : path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop', 'browser-mcp');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function logFilePath() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `exporter-${y}-${m}-${day}.log`);
}

function isoNow() {
  return new Date().toISOString();
}

function appendLine(line) {
  try {
    fs.appendFileSync(logFilePath(), line + '\n', { encoding: 'utf8' });
  } catch (e) {
    // last-resort: write to stderr (won't reach extension, but visible in `chrome://` host stderr if you launch host manually)
    process.stderr.write(`[host] write failed: ${e.message}\n`);
  }
}

function sendResponse(obj) {
  // Native Messaging response framing: 4-byte LE length + JSON.
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(len);
  process.stdout.write(json);
}

// Boot marker — useful when debugging "is the host even alive".
appendLine(`[${isoNow()}] [host] BOOT pid=${process.pid} cwd=${process.cwd()} log=${logFilePath()}`);

let buffer = Buffer.alloc(0);
let expectedLen = null;

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // Drain as many full messages as the buffer holds.
  while (true) {
    if (expectedLen === null) {
      if (buffer.length < 4) return;
      expectedLen = buffer.readUInt32LE(0);
      buffer = buffer.slice(4);
    }
    if (buffer.length < expectedLen) return;
    const payload = buffer.slice(0, expectedLen).toString('utf8');
    buffer = buffer.slice(expectedLen);
    expectedLen = null;
    handleMessage(payload);
  }
});

process.stdin.on('end', () => {
  appendLine(`[${isoNow()}] [host] STDIN END pid=${process.pid}`);
  process.exit(0);
});

process.stdin.on('error', (e) => {
  appendLine(`[${isoNow()}] [host] STDIN ERROR ${e.message}`);
});

function handleMessage(payload) {
  let msg;
  try {
    msg = JSON.parse(payload);
  } catch (e) {
    appendLine(`[${isoNow()}] [host] INVALID_JSON ${payload.slice(0, 200)}`);
    sendResponse({ ok: false, error: 'invalid json' });
    return;
  }

  // Expected shape: { ts, level, tag, msg, data?, exportId? }
  // We accept anything — never drop a log because of shape.
  const ts = msg.ts || isoNow();
  const level = (msg.level || 'log').toUpperCase();
  const tag = msg.tag || 'misc';
  const exportId = msg.exportId ? `[exp:${msg.exportId}]` : '';
  const main = msg.msg !== undefined ? String(msg.msg) : '';
  let dataStr = '';
  if (msg.data !== undefined) {
    try {
      dataStr = ' ' + JSON.stringify(msg.data);
    } catch (_) {
      dataStr = ' [data:unserializable]';
    }
  }
  appendLine(`[${ts}] [${level}] [${tag}]${exportId} ${main}${dataStr}`);

  // ack so the extension knows the host is alive (optional, lets us measure RTT)
  if (msg.ack) sendResponse({ ok: true, ts: isoNow() });
}
