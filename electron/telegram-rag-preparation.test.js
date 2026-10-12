'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { _createCoordinator } = require('./index-job')
const { createTelegramRagPreparation } = require('./telegram-rag-preparation')

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
class FakeWorker extends EventEmitter {
  constructor(data) { super(); this.data = data; this.sent = [] }
  postMessage(message) { this.sent.push(message) }
  unref() {}
  terminate() { return Promise.resolve(0) }
}

function harness({ source = { id: 48, platform: 'telegram', handle: '-100123', tg_session: 'bound_fixture_session', tg_session_conflict: 0 }, pending = [1], sourceGate = null, backfillError = null, detailError = null } = {}) {
  const events = []
  const workers = []
  const backfills = []
  const cancels = []
  const listeners = new Set()
  const warnings = []
  const snapshots = []
  const readCalls = []
  const workerStarted = deferred()
  const childStarted = deferred()
  const sourceRequested = deferred()
  const terminal = deferred()
  let detail = { id: 42, status: 'running' }
  const jobRunner = {
    startTelegramReplyBackfill(params) {
      events.push('backfill:start')
      backfills.push(params)
      if (backfillError) throw backfillError
      childStarted.resolve(42)
      return 42
    },
    cancelJob(id) {
      cancels.push(id)
      finishChild('cancelled')
      return true
    },
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback) },
    getJobDetail() { if (detailError) throw detailError; return detail },
  }
  function finishChild(status, error = null) {
    detail = { id: 42, status, error }
    events.push(`backfill:${status}`)
    for (const callback of [...listeners]) callback(detail)
  }
  const readDb = async (action, args) => {
    readCalls.push({ action, args })
    if (action === 'listItemsMissingParent') return pending
    if (action === 'getSource') {
      sourceRequested.resolve()
      return sourceGate ? sourceGate.promise : source
    }
    throw new Error(`unexpected read ${action}`)
  }
  const index = _createCoordinator({
    workerFactory: data => {
      events.push('worker:start')
      const worker = new FakeWorker(data)
      workers.push(worker)
      workerStarted.resolve(worker)
      return worker
    },
    controlTask: async () => ({}),
    statusTask: async () => ({ state: 'idle', done: 0, total: 1 }),
    logger: { log() {}, error() {}, warn() {} },
  })
  index.subscribe(job => {
    snapshots.push(job)
    events.push(`index:${job.status}:${job.phase}`)
    if (job.status !== 'running') terminal.resolve(job)
  })
  index.setTelegramPreparation(createTelegramRagPreparation({ jobRunner, readDb, logger: { warn: warning => warnings.push(warning) } }))
  return { index, events, workers, backfills, cancels, listeners, warnings, snapshots, readCalls, workerStarted, childStarted, sourceRequested, terminal, finishChild }
}

test('tracked receipt precedes metadata work, and the embedding worker starts only after the visible metadata child completes', async () => {
  const h = harness()
  const receipt = h.index.startTracked({ sourceId: 48, limit: 10 })
  assert.equal(receipt.phase, 'starting')
  assert.equal(receipt.status, 'running')
  assert.equal(h.workers.length, 0)
  assert.equal(h.backfills.length, 0)
  await h.childStarted.promise
  assert.equal(h.backfills.length, 1)
  assert.equal(h.backfills[0].source_id, 48)
  assert.equal(h.backfills[0]._runtime_source.tg_session, 'bound_fixture_session')
  assert.equal(h.workers.length, 0)
  assert.equal(h.listeners.size, 1)
  h.finishChild('done')
  const worker = await h.workerStarted.promise
  assert.equal(worker.data.sourceId, 48)
  assert.deepEqual(h.events.slice(0, 4), ['index:running:starting', 'backfill:start', 'backfill:done', 'worker:start'])
  assert.equal(h.listeners.size, 0)
})

test('exact local item selection never starts source-wide metadata maintenance or reads unrelated rows', async () => {
  const h = harness()
  const receipt = h.index.startTracked({ sourceId: 48, itemIds: [3, 4], origin: 'guard-only-repair' })
  const worker = await h.workerStarted.promise
  assert.equal(receipt.phase, 'starting')
  assert.deepEqual(h.readCalls, [])
  assert.deepEqual(h.backfills, [])
  assert.deepEqual(worker.data.itemIds, [3, 4])
  worker.emit('message', { type: 'noop', reason: 'already-indexed' })
  assert.equal((await h.terminal.promise).status, 'done')
})

test('Cancel immediately after acceptance prevents both metadata and embedding work', async () => {
  const h = harness()
  const receipt = h.index.startTracked({ sourceId: 48 })
  assert.equal(h.index.cancelById(receipt.id), true)
  const terminal = await h.terminal.promise
  assert.equal(terminal.status, 'cancelled')
  assert.equal(h.backfills.length, 0)
  assert.equal(h.workers.length, 0)
  assert.equal(h.listeners.size, 0)
})

test('Cancel while reading the source cannot start a new metadata child afterward', async () => {
  const sourceGate = deferred()
  const h = harness({ sourceGate })
  const receipt = h.index.startTracked({ sourceId: 48 })
  await h.sourceRequested.promise
  h.index.cancelById(receipt.id)
  sourceGate.resolve({ id: 48, platform: 'telegram', handle: '-100123', tg_session: 'bound_fixture_session' })
  assert.equal((await h.terminal.promise).status, 'cancelled')
  assert.equal(h.backfills.length, 0, 'no Telegram child may be started after Cancel')
  assert.equal(h.workers.length, 0)
  assert.equal(h.listeners.size, 0)
})

test('Cancel during metadata reaches that existing child and never launches embedding afterward', async () => {
  const h = harness()
  const receipt = h.index.startTracked({ sourceId: 48 })
  await h.childStarted.promise
  h.index.cancelById(receipt.id)
  const terminal = await h.terminal.promise
  assert.equal(terminal.status, 'cancelled')
  assert.deepEqual(h.cancels, [42])
  assert.equal(h.workers.length, 0)
  assert.equal(h.listeners.size, 0)
})

test('concurrent duplicate index starts share one metadata child and one eventual embedding worker', async () => {
  const h = harness()
  const first = h.index.startTracked({ sourceId: 48, limit: 10 })
  const second = h.index.startTracked({ sourceId: 48, limit: 10 })
  assert.equal(first.id, second.id)
  await h.childStarted.promise
  assert.equal(h.backfills.length, 1)
  h.finishChild('done')
  await h.workerStarted.promise
  assert.equal(h.workers.length, 1)
})

test('missing/conflicting bound session never falls back to another account while saved local indexing remains available', async () => {
  for (const source of [
    { id: 48, platform: 'telegram', handle: '-100123', tg_session: 'bound_fixture_session', tg_session_conflict: 1 },
    { id: 48, platform: 'telegram', handle: '-100123', tg_session: null, tg_session_conflict: 0 },
  ]) {
    const h = harness({ source })
    h.index.startTracked({ sourceId: 48 })
    await h.workerStarted.promise
    assert.equal(h.backfills.length, 0)
    assert.equal(h.workers.length, 1)
    assert.equal(h.listeners.size, 0)
  }
})

test('offline metadata startup and terminal errors preserve saved-local indexing and report the limited preparation', async () => {
  const startFailure = harness({ backfillError: new Error('Telegram unavailable offline') })
  startFailure.index.startTracked({ sourceId: 48 })
  await startFailure.workerStarted.promise
  assert.equal(startFailure.workers.length, 1)
  assert.match(startFailure.warnings[0], /indexing saved local input.*offline/)
  assert.equal(startFailure.listeners.size, 0)
  const terminalFailure = harness()
  terminalFailure.index.startTracked({ sourceId: 48 })
  await terminalFailure.childStarted.promise
  terminalFailure.finishChild('error', 'Telegram network timed out')
  await terminalFailure.workerStarted.promise
  assert.equal(terminalFailure.listeners.size, 0)
  assert.match(terminalFailure.warnings[0], /timed out/)
})

test('listener is removed even if the immediate child snapshot read throws', async () => {
  const h = harness({ detailError: new Error('child snapshot unavailable') })
  h.index.startTracked({ sourceId: 48 })
  await h.workerStarted.promise
  assert.match(h.warnings[0], /snapshot unavailable/)
  assert.equal(h.listeners.size, 0)
})

test('after metadata completion, Cancel signals only the active embedding worker rather than cancelling an old child', async () => {
  const h = harness()
  const receipt = h.index.startTracked({ sourceId: 48 })
  await h.childStarted.promise
  h.finishChild('done')
  const worker = await h.workerStarted.promise
  h.index.cancelById(receipt.id)
  assert.deepEqual(h.cancels, [])
  assert.deepEqual(worker.sent, [{ type: 'cancel' }])
  assert.equal(h.listeners.size, 0)
})

test('fully resolved metadata bypasses network preparation and starts the local worker directly', async () => {
  const h = harness({ pending: [] })
  h.index.startTracked({ sourceId: 48 })
  await h.workerStarted.promise
  assert.equal(h.backfills.length, 0)
  assert.deepEqual(h.readCalls.map(call => call.action), ['listItemsMissingParent'])
  assert.equal(h.listeners.size, 0)
})
