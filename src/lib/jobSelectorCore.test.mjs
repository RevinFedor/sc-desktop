import test from 'node:test'
import assert from 'node:assert/strict'

import {
  activeVisibleJobs,
  createSelectionCache,
  findJobByIdentity,
  jobsForSource,
  sameArrayItems,
} from './jobSelectorCore.mjs'

test('sameArrayItems accepts a new wrapper around the same job objects', () => {
  const a = { id: 1 }
  const b = { id: 2 }
  assert.equal(sameArrayItems([a, b], [a, b]), true)
  assert.equal(sameArrayItems([a, b], [a, { ...b }]), false)
})

test('selection cache preserves reference across unrelated job updates', () => {
  const own = { id: 1, source_id: 10, status: 'running' }
  const other = { id: 2, source_id: 20, status: 'running' }
  const cache = createSelectionCache(sameArrayItems)
  const selector = jobs => jobsForSource(jobs, 10, { activeOnly: true })

  const first = cache.select([own, other], selector)
  const second = cache.select([own, { ...other, items_done: 9 }], selector)

  assert.strictEqual(second, first)
  assert.deepEqual(second, [own])
})

test('selection cache changes reference when selected job changes', () => {
  const own = { id: 1, source_id: 10, status: 'running' }
  const cache = createSelectionCache(sameArrayItems)
  const selector = jobs => jobsForSource(jobs, 10, { activeOnly: true })

  const first = cache.select([own], selector)
  const nextOwn = { ...own, items_done: 1 }
  const second = cache.select([nextOwn], selector)

  assert.notStrictEqual(second, first)
  assert.strictEqual(second[0], nextOwn)
})

test('activeVisibleJobs excludes hidden children and terminal rows', () => {
  const jobs = [
    { id: 1, status: 'running' },
    { id: 2, status: 'done' },
    { id: 3, status: 'awaiting_ai', hidden: true },
  ]
  assert.deepEqual(activeVisibleJobs(jobs, job => !job.hidden).map(job => job.id), [1])
})

test('exact live id wins over another job carrying the same database id', () => {
  const index = { id: 'index-4', db_id: 7, type: 'tg_index' }
  const fetch = { id: 7, db_id: 99, type: 'tg_fetch' }
  assert.equal(findJobByIdentity([index, fetch], 7), fetch)
  assert.equal(findJobByIdentity([fetch, index], 'index-4'), index)
})
