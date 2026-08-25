'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeStartRequest,
  createStartingState,
  applyWorkerMessage,
  snapshot,
  runningStatus,
  matchesJobId,
  buildEmbeddingText,
  rpmWindowState,
} = require('./index-worker-protocol')

test('normalizes source identity and full-index limits', () => {
  assert.deepEqual(normalizeStartRequest({ sourceId: '48', limit: 0, origin: '' }), {
    sourceId: 48,
    limit: null,
    origin: 'unknown',
  })
  assert.deepEqual(normalizeStartRequest({ sourceId: 48, limit: 12.9, origin: 'manual' }), {
    sourceId: 48,
    limit: 12,
    origin: 'manual',
  })
  assert.throws(() => normalizeStartRequest({ sourceId: null }), /sourceId required/)
})

test('worker messages preserve cumulative and monotonic progress', () => {
  let state = createStartingState({ id: 7, sourceId: 48 })
  state = applyWorkerMessage(state, {
    type: 'started', dbRowId: 901, itemsTotal: 5, initialIndexed: 12, startedAt: 100,
  })
  state = applyWorkerMessage(state, { type: 'progress', itemsDone: 2, itemsTotal: 5 })
  // A delayed duplicate cannot make progress move backwards.
  state = applyWorkerMessage(state, { type: 'progress', itemsDone: 1, itemsTotal: 5 })

  assert.deepEqual(runningStatus(state), {
    state: 'running', done: 14, total: 17, jobId: 'index-7', dbId: 901,
  })
  assert.equal(snapshot(state).id, 'index-7')
  assert.equal(snapshot(state).live_id, 7)
  assert.equal(snapshot(state).items_done, 14)
  assert.equal(snapshot(state).items_total, 17)

  state = applyWorkerMessage(state, {
    type: 'terminal', status: 'cancelled', itemsDone: 3, itemsTotal: 5, finishedAt: 200,
  })
  assert.equal(snapshot(state).status, 'cancelled')
  assert.equal(snapshot(state).items_done, 15)
  assert.equal(snapshot(state).error, null)
})

test('live and database ids both address the same job', () => {
  let state = createStartingState({ id: 3, sourceId: 9 })
  state = applyWorkerMessage(state, {
    type: 'started', dbRowId: 400, itemsTotal: 1, initialIndexed: 0, startedAt: 1,
  })
  assert.equal(matchesJobId(state, 3), true)
  assert.equal(matchesJobId(state, 'index-3'), true)
  assert.equal(matchesJobId(state, '400'), true)
  assert.equal(matchesJobId(state, 'db-400'), false)
})

test('context text keeps five prior lines before the target and clamps captions', () => {
  const long = 'x'.repeat(1600)
  const text = buildEmbeddingText(
    { sender: 'target', caption: long },
    [{ sender: 'prior', caption: 'hello' }],
  )
  const lines = text.split('\n')
  assert.equal(lines[0], 'prior: hello')
  assert.equal(lines[1].startsWith('target: '), true)
  assert.equal(lines[1].length, 'target: '.length + 1500)
})

test('RPM accounting charges every text and expires old reservations', () => {
  const now = 100_000
  const blocked = rpmWindowState([
    { ts: now - 1_000, units: 2350 },
  ], 100, now)
  assert.equal(blocked.units, 2350)
  assert.equal(blocked.waitMs, 59_200)

  const expired = rpmWindowState([
    { ts: now - 60_001, units: 2350 },
  ], 100, now)
  assert.equal(expired.units, 0)
  assert.equal(expired.waitMs, 0)
})
