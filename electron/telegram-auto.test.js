const test = require('node:test')
const assert = require('node:assert/strict')

const {
  runTelegramAutoOnce,
  setTelegramAutoEnabled,
  stopTelegramAutoScheduler,
} = require('./telegram-auto')

test.afterEach(() => stopTelegramAutoScheduler())

test('auto scheduler skips a persistently unavailable source', async () => {
  let starts = 0
  const db = {
    listTelegramAutoSources: () => [{
      id: 7,
      handle: 'gone_channel',
      tg_session: 'session_test',
      tg_auto: { pull: true, index: false, types: ['text'], engine: 'assemblyai' },
      tg_health: { status: 'unavailable', code: 'telegram_source_unavailable' },
    }],
  }
  const jobRunner = {
    subscribe: () => () => {},
    startTelegramCatchUp: () => { starts += 1; return 1 },
  }

  const result = await runTelegramAutoOnce({
    db,
    jobRunner,
    indexJob: {},
    reason: 'test',
  })

  assert.equal(starts, 0)
  assert.equal(result.groups, 0)
  assert.equal(result.sources, 1)
  assert.equal(result.skippedUnavailable, 1)
})

test('master switch prevents an automatic Telegram pass from starting', async () => {
  let starts = 0
  setTelegramAutoEnabled(false)
  const result = await runTelegramAutoOnce({
    db: {
      listTelegramAutoSources: () => [{
        id: 1,
        handle: 'chat',
        tg_auto: { pull: true, types: ['text'] },
      }],
    },
    jobRunner: {
      subscribe: () => () => {},
      startTelegramCatchUp: () => { starts += 1; return 1 },
    },
    indexJob: {},
    reason: 'test-disabled',
  })

  assert.equal(result.skipped, 'disabled')
  assert.equal(starts, 0)
})

test('cancelling one auto umbrella stops the remaining groups in that pass', async () => {
  let nextId = 10
  let starts = 0
  const listeners = new Set()
  const jobRunner = {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    startTelegramCatchUp() {
      starts += 1
      const id = nextId++
      setImmediate(() => {
        for (const fn of listeners) fn({ id, status: 'cancelled' })
      })
      return id
    },
  }
  const rows = [
    { id: 1, handle: 'one', tg_session: 'a', tg_auto: { pull: true, types: ['text'] } },
    { id: 2, handle: 'two', tg_session: 'b', tg_auto: { pull: true, types: ['text'] } },
  ]

  const result = await runTelegramAutoOnce({
    db: {
      listTelegramAutoSources: () => rows,
      maxExternalId: () => 1,
    },
    jobRunner,
    indexJob: {},
    reason: 'test-cancelled',
  })

  assert.equal(starts, 1)
  assert.equal(result.cancelled, true)
})

test('turning master switch off cancels the live auto umbrella', async () => {
  const listeners = new Set()
  const cancelled = []
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const jobRunner = {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    startTelegramCatchUp() {
      markStarted()
      return 77
    },
    cancelJob(id) {
      cancelled.push(id)
      setImmediate(() => {
        for (const fn of listeners) fn({ id, status: 'cancelled' })
      })
      return true
    },
  }
  const run = runTelegramAutoOnce({
    db: {
      listTelegramAutoSources: () => [{
        id: 1,
        handle: 'chat',
        tg_session: 'a',
        tg_auto: { pull: true, types: ['text'] },
      }],
      maxExternalId: () => 1,
    },
    jobRunner,
    indexJob: {},
    reason: 'test-master-cancel',
  })

  await started
  const state = setTelegramAutoEnabled(false)
  const result = await run

  assert.deepEqual(cancelled, [77])
  assert.equal(state.cancel_requested, true)
  assert.equal(result.cancelled, true)
})
