const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { _createCoordinator } = require('./index-job')
const { normalizeRagScope } = require('./telegram-rag-search')

// Execute the actual IPC registration blocks without starting a GUI app or
// importing unrelated startup services. The coordinator is real; workers and
// history are bounded fixtures. Native DB-worker retrieval is tested separately.
const source = fs.readFileSync(require.resolve('./main'), 'utf8')
function block(from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  assert.ok(start >= 0 && end > start, `IPC block ${from} not found`)
  return source.slice(start, end)
}

class FixtureWorker extends EventEmitter {
  constructor(data) { super(); this.data = data; this.sent = [] }
  unref() {}
  postMessage(value) { this.sent.push(value) }
  terminate() { return Promise.resolve(0) }
}

function harness() {
  const workers = []
  const logger = { log() {}, warn() {}, error() {} }
  const indexJob = _createCoordinator({
    workerFactory: data => { const worker = new FixtureWorker(data); workers.push(worker); return worker },
    controlTask: async () => ({ updated: true }),
    statusTask: async () => ({ state: 'idle', done: 0, total: 0 }),
    logger,
  })
  const handlers = new Map()
  const readCalls = []
  const runner = {
    listJobs: () => [{ id: 1, type: 'tg_fetch', started_at: 1 }],
    cancelJob: id => typeof id === 'string' && id.startsWith('index-') ? indexJob.cancelById(id) : false,
    getJobDetail: id => ({ id, marker: 'subprocess-or-history' }),
  }
  const fixtureResult = {
    rows: [{ id: 777, caption: 'fixture' }],
    diagnostics: { search_budget_exhausted: true },
    coverage: { ready_current_messages: 1, messages_total: 20 },
    scope: { source_id: 42, limit: 125 },
  }
  const context = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    indexJob, jobRunner: runner, console: logger,
    normalizeRagScope,
    embedQuery: async () => new Float32Array([1, 0]),
    readDb: async (method, args) => { readCalls.push({ method, args }); return method === 'telegramRagSearch' ? fixtureResult : {} },
    searchTelegramRag: () => { throw new Error('unexpected main-thread search') },
    db: {},
  }
  vm.runInNewContext(block("ipcMain.handle('jobs:list'", "// ─── AI Studio MCP jobs"), context)
  vm.runInNewContext(block("ipcMain.handle('jobs:cancel'", "ipcMain.handle('jobs:setAutoIndexAfterFetch'"), context)
  vm.runInNewContext(block("ipcMain.handle('tg:search'", '// ─── Instagram settings'), context)
  vm.runInNewContext(block("ipcMain.handle('tg:index'", "ipcMain.handle('tg:indexStatus'"), context)
  return { indexJob, workers, handlers, readCalls, fixtureResult }
}

test('Requests hydration, detail and Cancel address a preparing index before a DB row exists', async () => {
  const h = harness()
  const accepted = h.indexJob.startTracked({ sourceId: 42 })
  const list = await h.handlers.get('jobs:list')()
  assert.equal(list.length, 2)
  assert.equal(list.find(job => job.id === accepted.id).phase, 'starting')
  assert.equal(list.find(job => job.id === accepted.id).db_id, null)
  assert.deepEqual(h.handlers.get('jobs:detail')(null, { id: accepted.id }), accepted)
  assert.equal(h.handlers.get('jobs:detail')(null, { id: 1, identity: 'live' }).marker, 'subprocess-or-history')
  const terminal = new Promise(resolve => h.indexJob.subscribe(update => {
    if (update.phase === 'terminal') resolve(update)
  }))
  assert.equal(h.handlers.get('jobs:cancel')(null, { id: accepted.id, identity: 'live', type: 'tg_index' }), true)
  assert.equal(Atomics.load(new Int32Array(h.workers[0].data.cancelBuffer), 0), 1)
  h.workers[0].emit('message', { type: 'fatal', error: 'cancelled during preparation' })
  assert.equal((await terminal).status, 'cancelled')
  assert.equal((await h.handlers.get('jobs:list')()).some(job => job.id === accepted.id), false)
})

test('tg:index returns the visible preparing snapshot before worker startup completes', async () => {
  const h = harness()
  const accepted = await h.handlers.get('tg:index')(null, { sourceId: 42, limit: 12 })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.jobId, 'index-1')
  assert.equal(accepted.job.phase, 'starting')
  assert.equal(accepted.job.db_id, null)
  assert.equal(h.indexJob.listActiveSnapshots().length, 1)
})

test('DB identity cannot cancel/detail a different index with a colliding live counter', () => {
  const h = harness()
  const a = h.indexJob.startTracked({ sourceId: 42 })
  const b = h.indexJob.startTracked({ sourceId: 43 })
  h.workers[0].emit('message', { type: 'started', dbRowId: 90, itemsTotal: 2, initialIndexed: 0 })
  h.workers[1].emit('message', { type: 'started', dbRowId: 1, itemsTotal: 2, initialIndexed: 0 })
  assert.equal(h.handlers.get('jobs:detail')(null, { id: 1, identity: 'db' }).id, b.id)
  assert.equal(h.handlers.get('jobs:detail')(null, { id: 'db-1', identity: 'db' }).id, b.id)
  assert.equal(h.handlers.get('jobs:cancel')(null, { id: 1, identity: 'db', type: 'tg_index' }), true)
  assert.equal(Atomics.load(new Int32Array(h.workers[0].data.cancelBuffer), 0), 0)
  assert.equal(Atomics.load(new Int32Array(h.workers[1].data.cancelBuffer), 0), 1)
  assert.notEqual(a.id, b.id)
})

test('tg:search passes topic/slider/progressive scope to worker and preserves budget diagnostics', async () => {
  const h = harness()
  const result = await h.handlers.get('tg:search')(null, {
    sourceId: 42, query: 'topic question', limit: 125, min_cos: -1, topic_id: 7,
  })
  assert.equal(h.readCalls.length, 1)
  assert.equal(h.readCalls[0].method, 'telegramRagSearch')
  assert.equal(h.readCalls[0].args[0].source_id, 42)
  assert.equal(h.readCalls[0].args[0].limit, 125)
  assert.equal(h.readCalls[0].args[0].min_cos, -1)
  assert.equal(h.readCalls[0].args[0].topic_id, 7)
  assert.deepEqual(result.results, h.fixtureResult.rows)
  assert.equal(result.diagnostics.search_budget_exhausted, true)
  assert.equal(result.coverage.messages_total, 20)
})
