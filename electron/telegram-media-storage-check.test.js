'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { Worker } = require('node:worker_threads')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createTelegramMediaStorageChecks } = require('./telegram-media-storage-check')
const { createTelegramRagApi } = require('./telegram-rag-api')

class FakeWorker extends EventEmitter {
  unref() {}
  result(value) { this.emit('message', { ok: true, value }); this.emit('exit', 0) }
}
function fakeChecks(options = {}) {
  const workers = []
  const checks = createTelegramMediaStorageChecks({ deadlineMs: 40,
    workerFactory: data => { const worker = new FakeWorker(); workers.push({ worker, data }); return worker }, ...options })
  return { checks, workers }
}
async function waitFor(predicate, timeout = 2000) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Expected test marker did not arrive')
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('real storage worker keeps success/error behavior on an owned temporary directory', async t => {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-storage-worker-'))
  t.after(() => fs.rmSync(owned, { recursive: true, force: true }))
  const checks = createTelegramMediaStorageChecks({ deadlineMs: 5000 })
  const directory = path.join(owned, 'cache')
  const result = await checks.check(directory, 1048576)
  assert.equal(result.directory, fs.realpathSync(directory))
  assert.equal(result.writable, true)
  assert.ok(result.free_bytes >= 1048576)
  await waitFor(() => checks.pending().length === 0)
  await assert.rejects(checks.check(directory, Number.MAX_SAFE_INTEGER), { code: 'MEDIA_STORAGE_UNAVAILABLE' })
  await waitFor(() => checks.pending().length === 0)
})

test('deadline preserves pending single-flight across normalized paths/subdirectories until actual worker exit', async () => {
  const { checks, workers } = fakeChecks()
  const first = checks.check('/Volumes/storage-fixture/owned/cache', 1048576)
  const rejected = assert.rejects(first, error => error.code === 'MEDIA_STORAGE_UNAVAILABLE' &&
    error.recovery_reason === 'CHECK_PENDING' && error.storage_check.pending === true)
  await assert.rejects(checks.check('/Volumes/storage-fixture/owned/../owned/cache', 1048576), error => error.recovery_reason === 'CHECK_PENDING')
  await rejected
  assert.equal(checks.pending()[0].state, 'timed_out_pending')
  await assert.rejects(checks.check('/Volumes/storage-fixture/another-cache', 2097152), error => error.recovery_reason === 'CHECK_PENDING')
  assert.equal(workers.length, 1)
  // A late message cannot retroactively turn the timed-out request into success
  // or release the volume lock while the original thread has not exited.
  workers[0].worker.emit('message', { ok: true, value: { writable: true } })
  assert.equal(checks.pending().length, 1)
  await assert.rejects(checks.check('/Volumes/storage-fixture/owned/cache'), error => error.recovery_reason === 'CHECK_PENDING')
  workers[0].worker.emit('exit', 0)
  assert.equal(checks.pending().length, 0)
  const after = checks.check('/Volumes/storage-fixture/owned/cache', 1048576)
  workers[1].worker.result({ directory: '/Volumes/storage-fixture/owned/cache', writable: true })
  assert.equal((await after).writable, true)
  assert.equal(workers.length, 2)
})

test('explicit independent volume check remains usable and total pending checker count is bounded', async () => {
  const { checks, workers } = fakeChecks({ maxConcurrent: 2, deadlineMs: 1000 })
  const a = checks.check('/Volumes/volume-a/owned')
  const b = checks.check('/Volumes/volume-b/owned')
  await assert.rejects(checks.check('/Volumes/volume-c/owned'), error => error.recovery_reason === 'CHECK_PENDING')
  assert.equal(workers.length, 2)
  workers[1].worker.result({ directory: '/Volumes/volume-b/owned', writable: true })
  assert.equal((await b).writable, true)
  workers[0].worker.result({ directory: '/Volumes/volume-a/owned', writable: true })
  await a
})

test('invalid input/constructor failure cannot touch disk or leave a hidden checker reservation', async () => {
  let starts = 0
  const checks = createTelegramMediaStorageChecks({ workerFactory: () => { starts++; throw new Error('worker unavailable') } })
  assert.throws(() => checks.check('/', 1048576))
  assert.throws(() => checks.check('/owned/cache', 0))
  assert.equal(starts, 0)
  await assert.rejects(checks.check('/owned/cache', 1048576), { code: 'MEDIA_STORAGE_UNAVAILABLE' })
  assert.equal(starts, 1)
  assert.deepEqual(checks.pending(), [])
})

test('worker error and protocol-less exit report explicit errors and release only after termination', async () => {
  const { checks, workers } = fakeChecks()
  const pending = checks.check('/owned/cache')
  workers[0].worker.emit('error', new Error('checker failed'))
  await assert.rejects(pending, { code: 'MEDIA_STORAGE_UNAVAILABLE' })
  assert.equal(checks.pending().length, 1)
  await assert.rejects(checks.check('/other-local/cache'), error => error.recovery_reason === 'CHECK_PENDING')
  workers[0].worker.emit('exit', 1)
  const next = checks.check('/owned/cache')
  workers[1].worker.emit('exit', 1)
  await assert.rejects(next, { code: 'MEDIA_STORAGE_UNAVAILABLE' })
  assert.deepEqual(checks.pending(), [])
})

test('actual blocked worker leaves HTTP health/cancel responsive; API timeout is explicit and repeat does not launch another thread', async t => {
  const shared = new SharedArrayBuffer(8), state = new Int32Array(shared), workers = []
  const checks = createTelegramMediaStorageChecks({ deadlineMs: 150,
    workerFactory: data => {
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
        const state=new Int32Array(workerData.shared);Atomics.store(state,1,1);Atomics.wait(state,0,0);
        parentPort.postMessage({ok:true,value:{directory:workerData.directory,writable:true}});`,
      { eval: true, workerData: { ...data, shared } })
      workers.push(worker); return worker
    } })
  t.after(async () => {
    Atomics.store(state, 0, 1); Atomics.notify(state, 0)
    await Promise.all(workers.map(worker => worker.terminate()))
  })
  const params = { request_id: 'cancel-fixture', _fetch_request_hash: 'fixture-hash', _reserved_job_row_id: 1 }
  const row = { id: 1, type: 'tg_fetch', source_id: 48, status: 'running', items_done: 0, parameters_json: JSON.stringify(params) }
  const live = { id: 44, type: 'tg_fetch', status: 'running', params }
  let cancels = 0
  const api = createTelegramRagApi({ storageCheck: checks.check, storageChecks: checks.pending,
    database: () => ({ getDb: () => ({ prepare: () => ({ get: () => row, all: () => [row] }) }) }),
    jobRunner: { getJobDetail: id => id === 44 ? live : null, listJobs: () => [live],
      cancelJob(id, options) { assert.equal(id, 1); assert.equal(options.identity, 'db'); cancels++; row.status = live.status = 'cancelling'; return true } },
    indexJob: { subscribe: () => () => {}, listActiveSnapshots: () => [] },
    readBody: async req => { let body = ''; for await (const part of req) body += part; return JSON.parse(body) },
    sendJson: (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) } })
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') { res.end('ok'); return }
    await api.handle(req, res, new URL(req.url, 'http://127.0.0.1'))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { api.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000) })
  const pending = request('/telegram-rag/fetch/storage-check', { directory: '/Volumes/synthetic-worker/owned', min_free_bytes: 1048576 })
  await waitFor(() => Atomics.load(state, 1) === 1)
  assert.equal(await (await fetch(base + '/healthz', { signal: AbortSignal.timeout(1000) })).text(), 'ok')
  const cancel = await (await request('/telegram-rag/fetch/cancel', { request_id: 'cancel-fixture' })).json()
  assert.equal(cancel.cancel_requested, true); assert.equal(cancels, 1)
  const timedOut = await (await pending).json()
  assert.equal(timedOut.code, 'MEDIA_STORAGE_UNAVAILABLE')
  assert.equal(timedOut.recovery_reason, 'CHECK_PENDING')
  assert.equal(timedOut.storage_check.pending, true)
  const repeat = await (await request('/telegram-rag/fetch/storage-check', { directory: '/Volumes/synthetic-worker/another', min_free_bytes: 1048576 })).json()
  assert.equal(repeat.recovery_reason, 'CHECK_PENDING'); assert.equal(workers.length, 1)
  const active = await (await fetch(base + '/telegram-rag/jobs/active')).json()
  assert.equal(active.storage_enumeration_complete, true)
  assert.equal(active.storage_checks.length, 1)
  assert.equal(active.storage_checks[0].state, 'timed_out_pending')
  Atomics.store(state, 0, 1); Atomics.notify(state, 0)
  await waitFor(() => checks.pending().length === 0)
})
