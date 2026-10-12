'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Database = require('better-sqlite3')
const { _createCoordinator } = require('./index-job')
const { createTelegramRagApi } = require('./telegram-rag-api')

class FakeWorker extends EventEmitter {
  constructor(data) { super(); this.data = data; this.sent = []; this.terminated = 0 }
  postMessage(message) { this.sent.push(message) }
  unref() {}
  terminate() { this.terminated++; return Promise.resolve(0) }
}

function harness(t, { fetchError = null, workerError = null, withPreparation = false, guardCandidates = null } = {}) {
  const workers = []
  const controlCalls = []
  const statusCalls = []
  const fetchCalls = []
  const readCalls = []
  const preparationCalls = []
  const fixtureDb = new Database(':memory:')
  fixtureDb.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL); INSERT INTO items VALUES (5,48),(6,48),(7,49),(8,50)')
  t.after(() => fixtureDb.close())
  const indexJob = _createCoordinator({
    workerFactory: data => {
      if (workerError) throw workerError
      const worker = new FakeWorker(data)
      workers.push(worker)
      return worker
    },
    controlTask: async (operation, payload) => { controlCalls.push({ operation, payload }); return {} },
    statusTask: async sourceId => { statusCalls.push(sourceId); return { state: 'idle', done: 0, total: 4, unit: 'messages' } },
    logger: { log() {}, error() {}, warn() {} },
  })
  if (withPreparation) indexJob.setTelegramPreparation(async request => { preparationCalls.push(request) })
  const api = createTelegramRagApi({
    ...(guardCandidates ? { guardCandidates } : {}),
    indexJob,
    jobRunner: {
      startTelegramFetch: params => { fetchCalls.push(params); if (fetchError) throw fetchError; return 9 },
      getJobDetail: id => ({ id, status: 'running', type: 'tg_fetch' }),
    },
    database: () => ({ getDb: () => fixtureDb, getSource: id => id === 48 || id === 49 ? { id, platform: 'telegram' } : id === 50 ? { id, platform: 'youtube' } : null }),
    readBody: async (req, ceiling) => { readCalls.push(ceiling); return req.testBody },
    sendJson: (res, status, body) => { res.status = status; res.body = body },
  })
  t.after(() => api.close())
  async function call(method, path, body, headers = {}) {
    const res = {}
    const handled = await api.handle({ method, headers, testBody: body }, res, new URL(path, 'http://127.0.0.1:53127'))
    return { handled, ...res }
  }
  return { call, api, indexJob, workers, controlCalls, statusCalls, fetchCalls, readCalls, preparationCalls }
}

test('index start returns a visible starting job immediately; status and cancel address the same existing job without another worker', async t => {
  const { call, workers, statusCalls } = harness(t)
  const started = await call('POST', '/telegram-rag/index/start', { source_id: 48, limit: 100, item_ids: [5, 6] })
  assert.equal(started.status, 200)
  assert.equal(started.body.accepted, true)
  assert.equal(started.body.job_id, 'index-1')
  assert.equal(started.body.job.phase, 'starting')
  assert.equal(started.body.job.status, 'running')
  assert.equal(started.body.job.source_id, 48)
  assert.equal(workers.length, 1)
  assert.deepEqual(workers[0].data.itemIds, [5, 6])
  const status = await call('GET', '/telegram-rag/index/status?id=index-1&source_id=48')
  assert.equal(status.body.job.id, started.body.job_id)
  assert.equal(status.body.index.state, 'running')
  assert.deepEqual(statusCalls, [], 'starting status must not block on corpus preparation')
  const cancel = await call('POST', '/telegram-rag/index/cancel', { job_id: started.body.job_id, source_id: 48 })
  assert.equal(cancel.body.ok, true)
  assert.deepEqual(workers[0].sent, [{ type: 'cancel' }])
  assert.equal(Atomics.load(new Int32Array(workers[0].data.cancelBuffer), 0), 1)
  workers[0].emit('message', { type: 'terminal', status: 'cancelled', itemsDone: 0, itemsTotal: 0, finishedAt: 200 })
  const final = await call('GET', '/telegram-rag/index/status?id=index-1')
  assert.equal(final.body.job.status, 'cancelled')
  assert.equal(workers.length, 1)
})

test('guard audit delegates a bounded read-only source page without starting metadata/index/fetch jobs', async t => {
  const reads = []
  const h = harness(t, { guardCandidates: async args => {
    reads.push(args)
    return { item_ids: [5], scanned: 2, next_item_id: 6, complete: false }
  } })
  const out = await h.call('GET', '/telegram-rag/index/guards?source_id=48&after_item_id=3&limit=20')
  assert.equal(out.status, 200)
  assert.deepEqual(reads, [{ sourceId: 48, afterItemId: 3, limit: 20 }])
  assert.deepEqual(out.body.item_ids, [5])
  for (const query of ['source_id=50', 'source_id=48&limit=1001', 'source_id=48&after_item_id=-1']) {
    assert.equal((await h.call('GET', `/telegram-rag/index/guards?${query}`)).status, 400)
  }
  assert.equal((await h.call('GET', '/telegram-rag/index/guards?source_id=48', null, { origin: 'https://example.com' })).status, 403)
  assert.equal(reads.length, 1)
  assert.equal(h.workers.length, 0)
  assert.equal(h.fetchCalls.length, 0)
})

test('same-scope starts deduplicate and different selection returns the original job id instead of starting competing work', async t => {
  const { call, workers } = harness(t)
  const original = await call('POST', '/telegram-rag/index/start', { source_id: 48, limit: 100 })
  const repeat = await call('POST', '/telegram-rag/index/start', { source_id: 48, limit: 100 })
  assert.equal(repeat.body.job_id, original.body.job_id)
  assert.equal(workers.length, 1)
  const conflicting = await call('POST', '/telegram-rag/index/start', { source_id: 48, limit: 50 })
  assert.equal(conflicting.status, 400)
  assert.equal(conflicting.body.ok, false)
  assert.equal(conflicting.body.code, 'INDEX_ALREADY_RUNNING_DIFFERENT_SCOPE')
  assert.equal(conflicting.body.existing_job_id, original.body.job_id)
  assert.equal(workers.length, 1)
})

test('status/cancel reject a mismatched source and cannot borrow another job or cancel another chat', async t => {
  const { call, workers } = harness(t)
  const original = await call('POST', '/telegram-rag/index/start', { source_id: 48 })
  const mismatch = await call('GET', `/telegram-rag/index/status?id=${original.body.job_id}&source_id=49`)
  assert.equal(mismatch.status, 400)
  assert.equal(mismatch.body.code, 'INDEX_JOB_SOURCE_MISMATCH')
  const cancel = await call('POST', '/telegram-rag/index/cancel', { job_id: original.body.job_id, source_id: 49 })
  assert.equal(cancel.status, 400)
  assert.equal(cancel.body.code, 'INDEX_JOB_SOURCE_MISMATCH')
  assert.deepEqual(workers[0].sent, [])
  const unknown = await call('GET', '/telegram-rag/index/status?id=index-999&source_id=48')
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'INDEX_JOB_NOT_FOUND')
  const unknownCancel = await call('POST', '/telegram-rag/index/cancel', { job_id: 'index-999', source_id: 48 })
  assert.equal(unknownCancel.body.code, 'INDEX_JOB_NOT_FOUND')
  assert.equal(workers.length, 1)
  assert.deepEqual(workers[0].sent, [])
})

test('accepted startup can fail later; the original status carries terminal error rather than claiming successful indexing', async t => {
  const { call, indexJob, workers, controlCalls } = harness(t)
  const terminal = new Promise(resolve => indexJob.subscribe(job => { if (job.status === 'error') resolve(job) }))
  const started = await call('POST', '/telegram-rag/index/start', { source_id: 48 })
  workers[0].emit('error', new Error('Gemini worker preparation failed'))
  await terminal
  const status = await call('GET', `/telegram-rag/index/status?id=${started.body.job_id}`)
  assert.equal(status.body.job.status, 'error')
  assert.match(status.body.job.error, /preparation failed/)
  assert.equal(status.body.index.done, 0)
  assert.equal(controlCalls[0].operation, 'recover-source')
  assert.equal(controlCalls[0].payload.sourceId, 48)
  assert.equal(workers.length, 1)
})

test('a synchronous worker-factory failure still becomes a terminal snapshot under the immediate receipt id', async t => {
  const { call, indexJob, controlCalls } = harness(t, { workerError: new Error('native startup failed') })
  const terminal = new Promise(resolve => indexJob.subscribe(job => { if (job.status === 'error') resolve(job) }))
  const started = await call('POST', '/telegram-rag/index/start', { source_id: 48 })
  await terminal
  const status = await call('GET', `/telegram-rag/index/status?id=${started.body.job_id}`)
  assert.equal(status.body.job.status, 'error')
  assert.match(status.body.job.error, /native startup failed/)
  assert.equal(controlCalls.length, 1)
})

test('fetch route passes one explicit session/target to existing runner exactly once and reports only the running desktop job', async t => {
  const { call, fetchCalls } = harness(t)
  const params = { target: '@fixture_chat', session: 'session_fixture', mode: 'sync_new', limit: 50 }
  const out = await call('POST', '/telegram-rag/fetch/start', { params })
  assert.equal(out.status, 200)
  assert.deepEqual(fetchCalls, [{ ...params, origin: 'mcp', autoCopy: false }])
  assert.equal(out.body.job_id, 'desktop:9')
  assert.equal(out.body.job.status, 'running')
  assert.equal(out.body.delivered, undefined)
})

test('invalid source/fetch payloads and browser origins are rejected before any job is started', async t => {
  const { call, workers, fetchCalls, readCalls } = harness(t)
  for (const source_id of [0, 50, 51]) {
    const out = await call('POST', '/telegram-rag/index/start', { source_id })
    assert.equal(out.status, 400)
  }
  for (const params of [null, [], { target: ['@a', '@b'], mode: 'sync_new' }, { target: '', mode: 'sync_new' }, { target: '@a', mode: 'unknown' }]) {
    const out = await call('POST', '/telegram-rag/fetch/start', { params })
    assert.equal(out.status, 400)
  }
  const before = readCalls.length
  const origin = await call('POST', '/telegram-rag/index/start', { source_id: 48 }, { origin: 'https://example.org' })
  assert.equal(origin.status, 403)
  assert.equal(readCalls.length, before)
  assert.equal(workers.length, 0)
  assert.equal(fetchCalls.length, 0)
  assert.equal((await call('GET', '/other-route')).handled, false)
  assert.equal((await call('GET', '/telegram-rag/unknown')).status, 404)
})

test('fetch startup error is returned once with its exact code and no automatic fallback/retry', async t => {
  const error = Object.assign(new Error('session currently busy'), { code: 'telegram_session_busy' })
  const { call, fetchCalls } = harness(t, { fetchError: error })
  const out = await call('POST', '/telegram-rag/fetch/start', { params: { target: '@fixture', session: 'session_fixture', mode: 'sync_new' } })
  assert.equal(out.status, 400)
  assert.equal(out.body.ok, false)
  assert.equal(out.body.code, 'telegram_session_busy')
  assert.equal(fetchCalls.length, 1)
})

test('invalid explicit limits are rejected before preparation or embedding rather than widening to a paid full index', async t => {
  const { call, workers, preparationCalls } = harness(t, { withPreparation: true })
  for (const limit of [0, -1, '0', '100', 1.5, 200001, true, NaN, Infinity]) {
    const result = await call('POST', '/telegram-rag/index/start', { source_id: 48, limit })
    assert.equal(result.status, 400)
    assert.equal(result.body.code, 'INVALID_INDEX_LIMIT')
  }
  assert.equal(preparationCalls.length, 0)
  assert.equal(workers.length, 0)
})

test('empty malformed foreign or unavailable item selections reject before any metadata child or embedding worker', async t => {
  const { call, workers, preparationCalls } = harness(t, { withPreparation: true })
  for (const item_ids of [[], [0], ['5'], [1.5], [true], [5, 7], [5, 999], Array(5001).fill(5)]) {
    const result = await call('POST', '/telegram-rag/index/start', { source_id: 48, item_ids })
    assert.equal(result.status, 400)
    assert.equal(result.body.code, [5, 7].every(id => item_ids.includes(id)) || item_ids.includes(999) ? 'INDEX_SELECTION_SOURCE_MISMATCH' : 'INVALID_INDEX_SELECTION')
  }
  assert.equal(preparationCalls.length, 0)
  assert.equal(workers.length, 0)
})

test('valid repeated local IDs are deduplicated within the checked source and omission/null still explicitly permits full selection', async t => {
  const first = harness(t)
  const selected = await first.call('POST', '/telegram-rag/index/start', { source_id: 48, item_ids: [6, 5, 5] })
  assert.equal(selected.status, 200)
  assert.deepEqual(first.workers[0].data.itemIds, [5, 6])
  const full = harness(t)
  const result = await full.call('POST', '/telegram-rag/index/start', { source_id: 48, limit: null })
  assert.equal(result.status, 200)
  assert.equal(full.workers[0].data.limit, null)
})
