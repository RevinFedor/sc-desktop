/**
 * Persistent WebSocket Bridge
 *
 * Run once: node bridge.js
 * Stays alive permanently. Extension connects here (port 3457).
 * MCP clients (Claude sessions) connect here (port 3458).
 *
 * Architecture:
 *   Extension ←(WS:3457)→ THIS ←(WS:3458)→ MCP index.js (per Claude session)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EXT_PORT, MCP_PORT, APP_URL } from './runtime-config.js';

const manifest = JSON.parse(readFileSync(new URL('../../browser-extension/manifest.json', import.meta.url), 'utf8'));
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64'))
  .digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
const extensionOrigin = 'chrome-extension://' + extensionId;

// ── Extension side (port 3457) ────────────────────────────────────────

let extensionWs = null;
// Очередь waiters, разрешаемых когда расширение (пере)подключится. Нужно для
// авто-wake: когда MCP-команда приходит при мёртвом канале, мы будим SW и
// ждём здесь его reconnect, вместо голого отказа 'Extension not connected'.
let extReconnectWaiters = [];
let lastWakeAt = 0;
const WAKE_COOLDOWN_MS = 10_000; // не спамить reload при пачке параллельных команд
const SC_BRIDGE = APP_URL;

// Будит дремлющий/мёртвый SW расширения через существующий канал sc-desktop:
// POST /reload-extension кладёт команду в очередь, SW-alarm (каждые 3с,
// переживает смерть SW) её забирает и делает chrome.runtime.reload() → на boot
// top-level connectMcpBridge() заново дозванивается на :3457. Покрывает только
// failure-mode «уснул/отвалился SW», НЕ circuit-breaker (force-disabled).
async function wakeExtension() {
  const now = Date.now();
  if (now - lastWakeAt < WAKE_COOLDOWN_MS) return false;
  lastWakeAt = now;
  try {
    await fetch(`${SC_BRIDGE}/reload-extension`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    console.log('[Bridge] wakeExtension: reload queued via sc-desktop bridge');
    return true;
  } catch (e) {
    console.log('[Bridge] wakeExtension failed:', e.message);
    return false;
  }
}

// Резолвится когда extServer получит следующий 'connection' (extensionWs OPEN),
// либо реджектится по таймауту.
function waitForExtension(timeoutMs = 6000) {
  if (extensionWs && extensionWs.readyState === WebSocket.OPEN) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      extReconnectWaiters = extReconnectWaiters.filter(w => w !== resolve);
      resolve(false);
    }, timeoutMs);
    extReconnectWaiters.push((ok) => { clearTimeout(t); resolve(ok); });
  });
}
// Bridge-side id space. Each MCP client uses its own commandId counter starting
// at 1, so two parallel sessions both send id=1 — without rewriting, the second
// would overwrite the first in pendingCommands and the response would go to
// the wrong client. We rewrite the id here to a bridge-unique value and restore
// the client's original id on the response.
const pendingCommands = new Map(); // bridgeId -> { mcpSocket, originalId }
let bridgeCommandSeq = 0;

const extServer = new WebSocketServer({
  port: EXT_PORT, host: '127.0.0.1',
  verifyClient: ({ origin }) => !origin || origin.replace(/\/$/, '') === extensionOrigin,
});

extServer.on('listening', () => {
  console.log(`[Bridge] Extension port: ws://localhost:${EXT_PORT}`);
});

extServer.on('connection', (socket) => {
  console.log('[Bridge] Extension connected');
  extensionWs = socket;
  // Разбудить всех, кто ждал reconnect после авто-wake.
  if (extReconnectWaiters.length) {
    const waiters = extReconnectWaiters;
    extReconnectWaiters = [];
    for (const w of waiters) { try { w(true); } catch {} }
  }

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Route response back to the MCP client that sent the command,
      // restoring the client's original commandId.
      if (msg.commandId && pendingCommands.has(msg.commandId)) {
        const { mcpSocket, originalId } = pendingCommands.get(msg.commandId);
        pendingCommands.delete(msg.commandId);
        if (mcpSocket.readyState === WebSocket.OPEN) {
          msg.commandId = originalId;
          mcpSocket.send(JSON.stringify(msg));
        }
      }
    } catch (e) {
      console.error('[Bridge] Parse error:', e.message);
    }
  });

  socket.on('close', () => {
    console.log('[Bridge] Extension disconnected');
    extensionWs = null;
    // Команда могла уже выполнить side effect (например, tabs.create), а
    // disconnect случился до ACK. Это ambiguous delivery, не доказанный
    // отказ операции. Вызывающий обязан reconcile по стабильному id/URL.
    for (const [, { mcpSocket, originalId }] of pendingCommands) {
      if (mcpSocket.readyState === WebSocket.OPEN) {
        mcpSocket.send(JSON.stringify({
          commandId: originalId,
          success: false,
          error: 'Extension disconnected before command result; delivery state unknown',
          code: 'extension_disconnected_delivery_unknown',
          deliveryUnknown: true,
          retryable: true,
        }));
      }
    }
    pendingCommands.clear();
  });
});

// ── MCP client side (port 3458) ───────────────────────────────────────

const mcpServer = new WebSocketServer({
  port: MCP_PORT, host: '127.0.0.1',
  // stdio clients are local Node processes. Web pages must not control tabs.
  verifyClient: ({ origin }) => !origin,
});

mcpServer.on('listening', () => {
  console.log(`[Bridge] MCP client port: ws://localhost:${MCP_PORT}`);
  console.log('[Bridge] Ready. Waiting for connections...');
});

mcpServer.on('connection', (socket) => {
  console.log('[Bridge] MCP client connected');

  socket.on('message', async (raw) => {
    try {
      const command = JSON.parse(raw.toString());

      if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
        // Self-healing: вместо голого отказа будим SW и ждём его reconnect.
        // Покрывает частый случай «уснул/отвалился SW» — раньше требовал
        // ручного ⟳ или открытия вкладки. Circuit-breaker этим не лечится.
        console.log('[Bridge] command while disconnected → waking extension');
        await wakeExtension();
        const back = await waitForExtension(6000);
        if (!back || !extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
          socket.send(JSON.stringify({
            commandId: command.commandId,
            success: false,
            error: 'Extension not connected (auto-wake failed — SW may be force-disabled; toggle the extension off/on)',
          }));
          return;
        }
        console.log('[Bridge] extension back online → forwarding command');
      }

      // Rewrite to a bridge-unique id so parallel MCP clients can't collide.
      const originalId = command.commandId;
      const bridgeId = ++bridgeCommandSeq;
      command.commandId = bridgeId;
      pendingCommands.set(bridgeId, { mcpSocket: socket, originalId });

      // Forward to extension with the rewritten id.
      extensionWs.send(JSON.stringify(command));

    } catch (e) {
      console.error('[Bridge] MCP message error:', e.message);
    }
  });

  socket.on('close', () => {
    console.log('[Bridge] MCP client disconnected');
    // Clean up pending commands from this client
    for (const [id, { mcpSocket }] of pendingCommands) {
      if (mcpSocket === socket) {
        pendingCommands.delete(id);
      }
    }
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Bridge] Shutting down...');
  extServer.close();
  mcpServer.close();
  process.exit(0);
});
