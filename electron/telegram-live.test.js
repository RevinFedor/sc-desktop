const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeTelegramLiveRequest,
  createTelegramLiveState,
  applyTelegramLiveEvent,
  publicTelegramLiveState,
} = require('./telegram-live')

test('normalizes one search and a bounded cross-product batch', () => {
  const single = normalizeTelegramLiveRequest({
    operation: 'search', chat: 'ОМ: Таиланд', query: 'брекеты', limit: 999,
  })
  assert.equal(single.searches.length, 1)
  assert.equal(single.searches[0].limit, 100)
  assert.equal(single.concurrency, 3)

  const batch = normalizeTelegramLiveRequest({
    operation: 'search', chats: ['a', 'b'], queries: ['x', 'y'], concurrency: 99,
  })
  assert.deepEqual(batch.searches.map(row => `${row.chat}:${row.query}`), [
    'a:x', 'a:y', 'b:x', 'b:y',
  ])
  assert.equal(batch.concurrency, 5)
})

test('rejects ambiguous context/range requests and overlarge search batches', () => {
  assert.throws(
    () => normalizeTelegramLiveRequest({ operation: 'context', chat: 'x' }),
    /context requires/,
  )
  assert.throws(
    () => normalizeTelegramLiveRequest({ operation: 'range', chat: 'x', from_id: 1 }),
    /range requires/,
  )
  assert.throws(
    () => normalizeTelegramLiveRequest({
      operation: 'search',
      chats: Array.from({ length: 7 }, (_, index) => `c${index}`),
      queries: Array.from({ length: 10 }, (_, index) => `q${index}`),
    }),
    /max 60/,
  )
})

test('keeps full live result private while exposing compact progress', () => {
  const request = normalizeTelegramLiveRequest({
    operation: 'search', chat: 'chat', query: 'secret query',
  })
  const job = {
    params: request,
    tg_live: createTelegramLiveState(request),
    items_done: 0,
    items_total: 1,
  }
  applyTelegramLiveEvent(job, { type: 'progress', done: 1, total: 1, hits: 3 })
  applyTelegramLiveEvent(job, {
    type: 'result',
    result: { messages: [{ message_id: 7, text: 'private body' }], hits: 3 },
  })
  const summary = publicTelegramLiveState(job.tg_live)
  assert.equal(summary.result_available, true)
  assert.equal(summary.unique_hits, 1)
  assert.equal(JSON.stringify(summary).includes('private body'), false)
  assert.equal(job._tgLiveResult.messages[0].text, 'private body')
})

