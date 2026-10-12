'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { _createCoordinator } = require('./index-job')

class FakeWorker extends EventEmitter {
  constructor(data) {
    super()
    this.data = data
    this.sent = []
    this.terminated = 0
  }

  postMessage(message) { this.sent.push(message) }
  unref() {}
  terminate() { this.terminated += 1; return Promise.resolve(0) }
}

function harness({ status = { state: 'idle', done: 0, total: 0 } } = {}) {
  const workers = []
  const controlCalls = []
  const logs = []
  const workerFactory = data => {
    const worker = new FakeWorker(data)
    workers.push(worker)
    return worker
  }
  const controlTask = async (operation, payload) => {
    controlCalls.push({ operation, payload })
    return { updated: true }
  }
  const statusCalls = []
  const statusTask = async sourceId => {
    statusCalls.push(sourceId)
    return status
  }
  const logger = {
    log: message => logs.push(['log', message]),
    warn: message => logs.push(['warn', message]),
    error: message => logs.push(['error', message]),
  }
  return {
    api: _createCoordinator({ workerFactory, controlTask, statusTask, logger }),
    workers,
    controlCalls,
    statusCalls,
    logs,
  }
}

test('deduplicates concurrent starts for one source and emits cumulative progress', async () => {
  const { api, workers } = harness()
  const updates = []
  api.subscribe(update => updates.push(update))

  const first = api.start({ sourceId: 48, origin: 'manual' })
  const duplicate = api.start({ sourceId: '48', origin: 'auto' })
  assert.equal(workers.length, 1)
  assert.equal(workers[0].data.operation, 'index')

  workers[0].emit('message', {
    type: 'started', dbRowId: 500, itemsTotal: 4, initialIndexed: 10, startedAt: 100,
  })
  assert.equal(await first, 'index-1')
  assert.equal(await duplicate, 'index-1')
  assert.equal(api._activeCount(), 1)

  workers[0].emit('message', { type: 'progress', itemsDone: 2, itemsTotal: 4 })
  assert.equal(updates.at(-1).id, 'index-1')
  assert.equal(updates.at(-1).items_done, 12)
  assert.equal(updates.at(-1).items_total, 14)

  workers[0].emit('message', {
    type: 'terminal', status: 'done', itemsDone: 4, itemsTotal: 4, finishedAt: 200,
  })
  assert.equal(updates.at(-1).status, 'done')
  assert.equal(updates.at(-1).items_done, 14)
  assert.equal(api._activeCount(), 0)
})

test('no-op keeps history clean and allows a later start', async () => {
  const { api, workers } = harness()
  let updateCount = 0
  api.subscribe(() => { updateCount += 1 })

  const first = api.start({ sourceId: 7 })
  workers[0].emit('message', { type: 'noop', reason: 'already-indexed' })
  assert.deepEqual(await first, { noop: true, reason: 'already-indexed' })
  assert.equal(updateCount, 0)
  assert.equal(api._activeCount(), 0)

  const second = api.start({ sourceId: 7 })
  assert.equal(workers.length, 2)
  workers[1].emit('message', { type: 'noop', reason: 'already-indexed' })
  await second
})

test('cancellation matches the DB id and signals both shared state and the port', async () => {
  const { api, workers } = harness()
  const started = api.start({ sourceId: 12 })
  workers[0].emit('message', {
    type: 'started', dbRowId: 777, itemsTotal: 20, initialIndexed: 5, startedAt: 10,
  })
  assert.equal(await started, 'index-1')

  assert.equal(api.cancelById('777'), true)
  assert.equal(Atomics.load(new Int32Array(workers[0].data.cancelBuffer), 0), 1)
  assert.deepEqual(workers[0].sent, [{ type: 'cancel' }])

  workers[0].emit('message', {
    type: 'terminal', status: 'cancelled', itemsDone: 3, itemsTotal: 20, finishedAt: 20,
  })
  assert.equal(api._activeCount(), 0)
})

test('unexpected worker failure finalizes the DB row and emits an error snapshot', async () => {
  const { api, workers, controlCalls } = harness()
  const terminal = new Promise(resolve => {
    api.subscribe(update => {
      if (update.status === 'error') resolve(update)
    })
  })
  const started = api.start({ sourceId: 21 })
  workers[0].emit('message', {
    type: 'started', dbRowId: 888, itemsTotal: 9, initialIndexed: 2, startedAt: 10,
  })
  await started
  workers[0].emit('message', { type: 'progress', itemsDone: 4, itemsTotal: 9 })
  workers[0].emit('error', new Error('native worker crash'))

  const update = await terminal
  assert.equal(update.status, 'error')
  assert.equal(update.items_done, 6)
  assert.match(update.error, /native worker crash/)
  assert.equal(controlCalls.length, 1)
  assert.equal(controlCalls[0].operation, 'recover')
  assert.equal(controlCalls[0].payload.dbRowId, 888)
  assert.equal(controlCalls[0].payload.itemsDone, 4)
  assert.equal(api._activeCount(), 0)
})

test('startup failure recovers a row that may have been inserted before the handshake', async () => {
  const { api, workers, controlCalls } = harness()
  const started = api.start({ sourceId: 22 })
  workers[0].emit('error', new Error('worker boot failed'))

  await assert.rejects(started, /worker boot failed/)
  assert.equal(controlCalls.length, 1)
  assert.equal(controlCalls[0].operation, 'recover-source')
  assert.equal(controlCalls[0].payload.sourceId, 22)
  assert.equal(controlCalls[0].payload.status, 'error')
  assert.equal(api._activeCount(), 0)
})

test('idle status uses the shared read task while live status stays in memory', async () => {
  const idle = { state: 'idle', done: 8, total: 11 }
  const { api, workers, controlCalls, statusCalls } = harness({ status: idle })
  assert.deepEqual(await api.statusForSource(33), idle)
  assert.deepEqual(statusCalls, [33])
  assert.equal(controlCalls.length, 0)

  const started = api.start({ sourceId: 33 })
  workers[0].emit('message', {
    type: 'started', dbRowId: 999, itemsTotal: 3, initialIndexed: 8, startedAt: 1,
  })
  await started
  assert.deepEqual(await api.statusForSource(33), {
    state: 'running', done: 8, total: 11, jobId: 'index-1', dbId: 999,
  })
  assert.deepEqual(statusCalls, [33])
  assert.equal(controlCalls.length, 0)

  workers[0].emit('message', {
    type: 'terminal', status: 'done', itemsDone: 3, itemsTotal: 3, finishedAt: 2,
  })
})

test('tracked start returns immediately during preparation and shares one worker with await-start callers', async () => {
  const { api, workers } = harness()
  const updates = []
  api.subscribe(update => updates.push(update))
  const accepted = api.startTracked({ sourceId: 70, itemIds: [5, 2, 5] })
  assert.equal(accepted.id, 'index-1')
  assert.equal(accepted.status, 'running')
  assert.equal(accepted.phase, 'starting')
  assert.equal(accepted.db_id, null)
  assert.equal(accepted.items_done, 0)
  assert.deepEqual(workers[0].data.itemIds, [2, 5])
  assert.deepEqual(api.currentSnapshot(70), accepted)
  assert.deepEqual(api.getActiveSnapshot(accepted.id), accepted)
  assert.deepEqual(api.listActiveSnapshots(), [accepted])
  const preparingStatus = await api.statusForSource(70)
  assert.equal(preparingStatus.phase, 'starting')
  assert.equal(preparingStatus.unit, 'messages')
  assert.equal(preparingStatus.jobId, accepted.id)
  assert.equal(preparingStatus.dbId, null)
  assert.deepEqual(api.startTracked({ sourceId: 70, itemIds: [2, 5], origin: 'another caller' }), accepted)
  assert.equal(workers.length, 1)
  assert.equal(updates.length, 1)

  let awaitStarted = false
  const joined = api.start({ sourceId: 70, itemIds: [2, 5] }).then(id => {
    awaitStarted = true
    return id
  })
  await Promise.resolve()
  assert.equal(awaitStarted, false)
  workers[0].emit('message', {
    type: 'started', dbRowId: 990, itemsTotal: 2, initialIndexed: 0, startedAt: 100,
  })
  assert.equal(await joined, accepted.id)
  assert.equal(api.currentSnapshot(70).db_id, 990)
  assert.equal(api.currentSnapshot(70).phase, 'running')
  assert.throws(() => api.startTracked({ sourceId: 70, itemIds: [3] }), error => (
    error.code === 'INDEX_ALREADY_RUNNING_DIFFERENT_SCOPE' && error.jobId === accepted.id
  ))
  assert.equal(workers.length, 1)
  workers[0].emit('message', { type: 'terminal', status: 'done', itemsDone: 2, itemsTotal: 2 })
  assert.equal(api.currentSnapshot(70), null)
  assert.equal(api.getActiveSnapshot(accepted.id), null)
  assert.deepEqual(api.listActiveSnapshots(), [])
})

test('tracked preparation can be cancelled before DB startup without unhandled rejection', async () => {
  const { api, workers, controlCalls } = harness()
  const terminal = new Promise(resolve => api.subscribe(update => {
    if (update.phase === 'terminal') resolve(update)
  }))
  const accepted = api.startTracked({ sourceId: 71 })
  assert.equal(api.cancelById(accepted.id), true)
  assert.equal(Atomics.load(new Int32Array(workers[0].data.cancelBuffer), 0), 1)
  workers[0].emit('message', { type: 'fatal', error: 'cancelled' })
  const done = await terminal
  assert.equal(done.status, 'cancelled')
  assert.equal(done.error, null)
  assert.equal(done.db_id, null)
  assert.equal(done.items_done, 0)
  assert.equal(api.currentSnapshot(71), null)
  assert.equal(controlCalls[0].operation, 'recover-source')
})

test('tracked no-op publishes a terminal proof while preserving the old await-start result', async () => {
  const { api, workers } = harness()
  const updates = []
  api.subscribe(update => updates.push(update))
  const accepted = api.startTracked({ sourceId: 72 })
  const oldContract = api.start({ sourceId: 72 })
  workers[0].emit('message', { type: 'noop', reason: 'already-indexed' })
  assert.deepEqual(await oldContract, { noop: true, reason: 'already-indexed' })
  assert.equal(updates.length, 2)
  assert.equal(updates[1].id, accepted.id)
  assert.equal(updates[1].phase, 'terminal')
  assert.equal(updates[1].status, 'done')
  assert.equal(updates[1].noop, true)
  assert.equal(updates[1].reason, 'already-indexed')
  assert.equal(updates[1].db_id, null)
})

test('tracked preparation failure emits error rather than a fake completion', async () => {
  const { api, workers } = harness()
  const terminal = new Promise(resolve => api.subscribe(update => {
    if (update.phase === 'terminal') resolve(update)
  }))
  api.startTracked({ sourceId: 73 })
  workers[0].emit('error', new Error('source selection unavailable'))
  const result = await terminal
  assert.equal(result.status, 'error')
  assert.match(result.error, /source selection unavailable/)
  assert.equal(result.items_done, 0)
  assert.equal(api._activeCount(), 0)
})

test('status reads never await worker startup for an existing preparing job', async () => {
  const { api, workers, statusCalls } = harness()
  const started = api.start({ sourceId: 85 })
  const preparing = await api.statusForSource(85)
  assert.equal(preparing.phase, 'starting')
  assert.equal(preparing.unit, 'messages')
  assert.equal(preparing.dbId, null)
  assert.deepEqual(statusCalls, [])
  workers[0].emit('message', { type: 'started', dbRowId: 850, itemsTotal: 1, initialIndexed: 0 })
  await started
  workers[0].emit('message', { type: 'terminal', status: 'done', itemsDone: 1, itemsTotal: 1 })
})
