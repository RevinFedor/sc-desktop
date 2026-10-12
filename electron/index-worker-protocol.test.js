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

test('optional local item selection is bounded, deduplicated and never coerces invalid IDs', () => {
  assert.deepEqual(normalizeStartRequest({ sourceId: 48, itemIds: [3, '1', 3, 2] }), {
    sourceId: 48, limit: null, origin: 'unknown', itemIds: [1, 2, 3],
  })
  assert.deepEqual(normalizeStartRequest({ sourceId: 48, itemIds: [] }).itemIds, [])
  for (const itemIds of [[null], [true], [-1], [0], [1.5], ['not-an-id'], '1,2']) {
    assert.throws(() => normalizeStartRequest({ sourceId: 48, itemIds }), /itemIds/)
  }
  assert.throws(() => normalizeStartRequest({ sourceId: 48, itemIds: Array(5001).fill(1) }), /at most 5000/)
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

test('fragment progress exposes its unit and selection instead of claiming message counts', () => {
  let state = createStartingState({ id: 8, sourceId: 48 })
  state = applyWorkerMessage(state, {
    type: 'started', dbRowId: 902, itemsTotal: 6, initialIndexed: 2,
    unit: 'fragments', messagesSelected: 3, indexVersion: 'fixture-v1',
  })
  state = applyWorkerMessage(state, { type: 'progress', itemsDone: 4, itemsTotal: 6 })
  assert.equal(snapshot(state).items_done, 6)
  assert.equal(snapshot(state).items_total, 8)
  assert.equal(snapshot(state).unit, 'fragments')
  assert.equal(snapshot(state).messages_selected, 3)
  assert.deepEqual(runningStatus(state), {
    state: 'running', done: 6, total: 8, jobId: 'index-8', dbId: 902,
    unit: 'fragments', messages_selected: 3, index_version: 'fixture-v1',
    fragments_total: 0, fragments_embedded: 0,
  })
})

test('message completion does not count staged fragments as published messages', () => {
  let state = createStartingState({ id: 9, sourceId: 48 })
  state = applyWorkerMessage(state, {
    type: 'started', itemsTotal: 2, initialIndexed: 1,
    unit: 'messages', messagesSelected: 3, fragmentsTotal: 12,
  })
  state = applyWorkerMessage(state, { type: 'progress', itemsDone: 0, itemsTotal: 2, fragmentsEmbedded: 4 })
  assert.equal(snapshot(state).unit, 'messages')
  assert.equal(snapshot(state).items_done, 1)
  assert.equal(snapshot(state).items_total, 3)
  assert.equal(snapshot(state).fragments_embedded, 4)
  assert.equal(snapshot(state).fragments_total, 12)
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
