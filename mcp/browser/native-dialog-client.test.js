import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { NativeDialogClient } from './native-dialog-client.js';

function workerFixture() {
  const requests = [];
  const worker = new EventEmitter();
  worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
  worker.stdin = new Writable({ write(chunk, _encoding, callback) {
    requests.push(JSON.parse(chunk.toString())); callback();
  } });
  return { worker, requests, respond(i, body) { worker.stdout.write(JSON.stringify({ ...body, requestId: requests[i].requestId }) + '\n'); } };
}

test('single shared native worker routes concurrent responses by request identity', async () => {
  const f = workerFixture(); let starts = 0;
  const c = new NativeDialogClient({ platform: 'darwin', startWorker: () => { starts++; return f.worker; } });
  const first = c.call({ action: 'read', browser: 'yandex' });
  const second = c.call({ action: 'handle', dialogId: 'ax:one', nativeWindowId: 13, accept: false });
  await new Promise(r => setImmediate(r));
  assert.equal(starts, 1); assert.equal(f.requests.length, 2);
  f.respond(1, { success: true, status: 'closed' }); f.respond(0, { success: true, status: 'open' });
  assert.equal((await first).status, 'open'); assert.equal((await second).status, 'closed'); c.stop();
});

test('native helper timeout never retries the action or promotes an ACK to success', async () => {
  const f = workerFixture(); const c = new NativeDialogClient({ platform: 'darwin', timeoutMs: 20, startWorker: () => f.worker });
  const r = await c.call({ action: 'handle', dialogId: 'ax:one', nativeWindowId: 13, accept: true });
  assert.equal(r.errorCode, 'NATIVE_OUTCOME_UNKNOWN'); assert.equal(r.retrySafe, false);
  assert.equal(f.requests.length, 1); c.stop();
});

test('worker exit leaves pending input outcome unknown and invalidates the process', async () => {
  const f = workerFixture(); const c = new NativeDialogClient({ platform: 'darwin', startWorker: () => f.worker });
  const pending = c.call({ action: 'handle', dialogId: 'ax:one', nativeWindowId: 13, accept: true });
  await new Promise(r => setImmediate(r)); f.worker.emit('exit', 1);
  assert.equal((await pending).errorCode, 'NATIVE_HELPER_UNAVAILABLE'); assert.equal(c.worker, null); c.stop();
});

test('non-macOS and stopped clients never launch a native helper', async () => {
  let starts = 0; const c = new NativeDialogClient({ platform: 'linux', startWorker: () => { starts++; } });
  assert.equal((await c.call({ action: 'read' })).errorCode, 'NATIVE_PLATFORM_UNSUPPORTED');
  assert.equal(starts, 0);
  const stopped = new NativeDialogClient({ platform: 'darwin', startWorker: () => { starts++; } }); stopped.stop();
  assert.equal((await stopped.call({ action: 'read' })).errorCode, 'NATIVE_HELPER_UNAVAILABLE'); assert.equal(starts, 0);
});
