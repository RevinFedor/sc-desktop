'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Database = require('better-sqlite3')
const { _createCoordinator } = require('./index-job')
const { createBoostyRagApi } = require('./boosty-rag-api')
const token = 'a'.repeat(64)
class FakeWorker extends EventEmitter {
  constructor(data) { super(); this.data = data; this.sent = [] }
  postMessage(message) { this.sent.push(message) }
  terminate() { return Promise.resolve() }
  unref() {}
}
function harness(t) {
  const h = new Database(':memory:')
  h.exec('CREATE TABLE jobs(id INTEGER PRIMARY KEY,type TEXT,source_id INTEGER,status TEXT,items_done INTEGER,items_total INTEGER,parameters_json TEXT,error TEXT,started_at INTEGER,finished_at INTEGER)')
  t.after(() => h.close())
  const workers = [], reads = [], embeddings = []
  const indexJob = _createCoordinator({ workerFactory: data => { const w = new FakeWorker(data); workers.push(w); return w },
    controlTask: async () => ({}), logger: { log() {}, error() {} } })
  const api = createBoostyRagApi({ token, database: () => ({ getDb: () => h }), indexJob,
    read: async (action, args) => {
      reads.push({ action, args })
      if (action === 'validate') {
        if (Number(args.source_id) !== 4206) return { ok: false, code: 'BOOSTY_SOURCE_NOT_FOUND', error: 'Not a saved Boosty source' }
        return { ok: true, source_id: 4206, limit: args.limit ?? null, item_ids: args.item_ids ?? null }
      }
      if (action === 'status') return { ok: true, source_id: 4206, current_ready: false }
      return { ok: true, result: action }
    },
    embedQuery: async query => { embeddings.push(query); return new Float32Array(768) },
    readBody: async req => req.body, sendJson: (res, status, body) => { res.status = status; res.body = body },
  })
  t.after(() => api.close())
  const call = async (method, route, body, headers = { authorization: `Bearer ${token}` }) => {
    const res = {}
    await api.handle({ method, headers, body }, res, new URL(route, 'http://127.0.0.1:53127'))
    return res
  }
  return { h, api, call, workers, reads, embeddings }
}

test('local API requires bearer and rejects even an authenticated forged extension/browser Origin', async t => {
  const x = harness(t)
  assert.equal((await x.call('GET', '/boosty-rag/sources', null, {})).status, 401)
  assert.equal((await x.call('GET', '/boosty-rag/sources', null, { authorization: `Bearer ${token}`, origin: 'chrome-extension://fixture' })).status, 403)
  assert.equal(x.reads.length, 0)
  assert.equal((await x.call('GET', '/boosty-rag/capabilities')).body.saved_text_only, true)
})

test('start/receipt/retry/cancel/status are one exact visible job; changed idempotency scope is refused', async t => {
  const x = harness(t), body = { source_id: 4206, request_id: 'test-boosty-one' }
  const first = await x.call('POST', '/boosty-rag/index/start', body)
  assert.equal(first.body.job.type, 'boosty_index')
  assert.equal(first.body.job.phase, 'starting')
  assert.equal(x.workers[0].data.mode, 'boosty')
  assert.equal(x.workers[0].data.requestId, body.request_id)
  assert.equal((await x.call('POST', '/boosty-rag/index/start', body)).body.job_id, first.body.job_id)
  assert.equal(x.workers.length, 1)
  assert.equal((await x.call('POST', '/boosty-rag/index/start', { ...body, limit: 1 })).status, 409)
  const cancel = await x.call('POST', '/boosty-rag/index/cancel', { job_id: first.body.job_id, source_id: 4206 })
  assert.equal(cancel.body.cancel_requested, true)
  assert.equal(Atomics.load(new Int32Array(x.workers[0].data.cancelBuffer), 0), 1)
  x.workers[0].emit('message', { type: 'terminal', status: 'cancelled', itemsDone: 0, itemsTotal: 0 })
  const status = await x.call('GET', `/boosty-rag/index/status?job_id=${first.body.job_id}`)
  assert.equal(status.body.job.status, 'cancelled')
  const resumed = await x.call('POST', '/boosty-rag/index/resume', { ...body, request_id: 'test-boosty-resume', resume_of: first.body.job_id })
  assert.equal(resumed.status, 200)
  assert.equal(x.workers.length, 2)
})

test('a wrong/unknown exact job never cancels another source or starts a replacement', async t => {
  const x = harness(t)
  const first = await x.call('POST', '/boosty-rag/index/start', { source_id: 4206, request_id: 'original' })
  assert.equal((await x.call('POST', '/boosty-rag/index/cancel', { job_id: first.body.job_id, source_id: 99 })).status, 400)
  assert.equal((await x.call('POST', '/boosty-rag/index/cancel', { job_id: 'index-unknown' })).status, 400)
  assert.equal(x.workers[0].sent.length, 0)
})

test('persisted exact job/receipt survive an app/API recreation without a hidden worker', async t => {
  const x = harness(t)
  x.h.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run(31, 'boosty_index', 4206, 'interrupted', 7, 9,
    JSON.stringify({ request_id: 'old-request', public_job_id: 'index-old', limit: null, item_ids: null }), null, 100, 200)
  const out = await x.call('POST', '/boosty-rag/index/start', { source_id: 4206, request_id: 'old-request' })
  assert.equal(out.body.job_id, 'index-old')
  assert.equal(out.body.job.status, 'interrupted')
  assert.equal(out.body.deduplicated, true)
  assert.equal(x.workers.length, 0)
  assert.equal((await x.call('GET', '/boosty-rag/index/status?job_id=index-old')).body.job.db_id, 31)
})

test('invalid source/scope is rejected before a query embedding; search/read/context go through saved-text worker', async t => {
  const x = harness(t)
  assert.equal((await x.call('POST', '/boosty-rag/search', { query: 'LoRA', source_id: 99 })).status, 400)
  assert.equal((await x.call('POST', '/boosty-rag/search', { query: 'LoRA', source_id: 4206, types: ['caption'] })).status, 400)
  assert.equal(x.embeddings.length, 0)
  const out = await x.call('POST', '/boosty-rag/search', { query: 'LoRA', source_id: 4206, limit: 5 })
  assert.equal(out.status, 200)
  assert.equal(x.embeddings.length, 1)
  assert.equal(x.reads.at(-1).action, 'search')
  assert.equal(x.reads.at(-1).args.query_embedding.length, 768)
  assert.equal((await x.call('POST', '/boosty-rag/original', { item_id: 1 })).body.result, 'original')
  assert.equal((await x.call('POST', '/boosty-rag/context', { item_id: 1 })).body.result, 'context')
})
