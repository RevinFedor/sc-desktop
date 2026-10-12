'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createTelegramRagClient } = require('./telegram-rag-client')

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return body } }
}

test('client uses only the public Application API start/status/cancel/fetch routes and preserves a running receipt as running', async () => {
  const calls = []
  const replies = [
    { ok: true, accepted: true, job_id: 'index-7', job: { id: 'index-7', status: 'running', phase: 'starting' } },
    { ok: true, job_id: 'index-7', job: { status: 'done' }, index: { done: 4, total: 4 } },
    { ok: true, job_id: 'index-7' },
    { ok: true, job_id: 'desktop:8', job: { status: 'running' } },
  ]
  const client = createTelegramRagClient({
    baseUrl: 'http://fixture.test',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(replies[calls.length - 1]) },
  })
  const receipt = await client.startIndex({ source_id: 48, limit: 100, item_ids: [10, 20] })
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.job.status, 'running')
  assert.equal(receipt.completed, undefined)
  assert.equal(calls.length, 1, 'an accepted receipt does not cause another start or hidden polling')
  const status = await client.indexStatus({ id: 'index-7', source_id: 48, ignored_null: null })
  assert.equal(status.job.status, 'done')
  await client.cancelIndex({ job_id: 'index-7', source_id: 48 })
  const params = { target: '@fixture', session: 'session_fixture', mode: 'sync_new', limit: 10 }
  const fetchReceipt = await client.startFetch(params)
  assert.equal(fetchReceipt.job.status, 'running')
  assert.equal(new URL(calls[0].url).pathname, '/telegram-rag/index/start')
  assert.deepEqual(JSON.parse(calls[0].options.body), { source_id: 48, limit: 100, item_ids: [10, 20] })
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
  const statusUrl = new URL(calls[1].url)
  assert.equal(statusUrl.pathname, '/telegram-rag/index/status')
  assert.equal(statusUrl.searchParams.get('id'), 'index-7')
  assert.equal(statusUrl.searchParams.get('source_id'), '48')
  assert.equal(statusUrl.searchParams.has('ignored_null'), false)
  assert.equal(calls[1].options.method, 'GET')
  assert.equal(calls[1].options.body, undefined)
  assert.equal(new URL(calls[2].url).pathname, '/telegram-rag/index/cancel')
  assert.deepEqual(JSON.parse(calls[2].options.body), { job_id: 'index-7', source_id: 48 })
  assert.equal(new URL(calls[3].url).pathname, '/telegram-rag/fetch/start')
  assert.deepEqual(JSON.parse(calls[3].options.body), { params })
  assert.ok(calls.every(call => call.options.signal instanceof AbortSignal))
})

test('missing Application API route reports the installed-app update boundary and never starts a fallback worker', async () => {
  let calls = 0
  let parsed = 0
  const client = createTelegramRagClient({
    fetchImpl: async () => { calls++; return { status: 404, ok: false, async json() { parsed++; return {} } } },
  })
  await assert.rejects(client.startIndex({ source_id: 48 }), /running SC Desktop app needs.*Application API update.*No hidden MCP worker fallback/)
  assert.equal(calls, 1)
  assert.equal(parsed, 0)
})

test('API conflict/failure codes and original competing job id survive transport unchanged', async () => {
  let calls = 0
  const client = createTelegramRagClient({
    fetchImpl: async () => { calls++; return response({ ok: false, code: 'INDEX_ALREADY_RUNNING_DIFFERENT_SCOPE', error: 'another selection is already running', existing_job_id: 'index-4' }, 400) },
  })
  await assert.rejects(client.startIndex({ source_id: 48 }), error => {
    assert.equal(error.code, 'INDEX_ALREADY_RUNNING_DIFFERENT_SCOPE')
    assert.equal(error.existing_job_id, 'index-4')
    assert.match(error.message, /another selection/)
    return true
  })
  assert.equal(calls, 1)
})

test('HTTP 200 with ok:false remains a failure instead of an accepted or successful job', async () => {
  const client = createTelegramRagClient({ fetchImpl: async () => response({ ok: false, code: 'telegram_session_busy', error: 'session busy' }) })
  await assert.rejects(client.startFetch({ target: '@fixture', mode: 'sync_new' }), { code: 'telegram_session_busy' })
})

test('deadline abort rejects an unknown start outcome and instructs checking existing status without any retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  let captured
  const client = createTelegramRagClient({
    fetchImpl: async (_url, options) => {
      calls++
      captured = options
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('deadline'), { name: 'AbortError' })), { once: true }))
    },
  })
  const pending = client.startFetch({ target: '@fixture', session: 'session_fixture', mode: 'sync_new' })
  const rejection = assert.rejects(pending, /timed out; check the existing source\/job status before starting again/)
  t.mock.timers.tick(35000)
  await rejection
  assert.equal(captured.signal.aborted, true)
  assert.equal(calls, 1)
})

test('network and malformed-response failures are not silently converted to successful receipts or alternative paths', async () => {
  let networkCalls = 0
  const network = createTelegramRagClient({ fetchImpl: async () => { networkCalls++; throw new TypeError('fetch failed') } })
  await assert.rejects(network.indexStatus({ source_id: 48 }), /fetch failed/)
  assert.equal(networkCalls, 1)
  let malformedCalls = 0
  const malformed = createTelegramRagClient({ fetchImpl: async () => { malformedCalls++; return { status: 200, ok: true, async json() { throw new SyntaxError('invalid JSON') } } } })
  await assert.rejects(malformed.startIndex({ source_id: 48 }), /invalid JSON/)
  assert.equal(malformedCalls, 1)
})

test('durable fetch status/cancel/resume use the original request identity without starting a new fetch', async () => {
  const calls = []
  const client = createTelegramRagClient({ baseUrl: 'http://fixture.test', fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return response({ ok: true, request_id: 'night-original', job_id: 'fetch:night-original', persisted_status: 'running' })
  } })
  await client.fetchStatus({ request_id: 'night-original' })
  await client.cancelFetch({ request_id: 'night-original' })
  await client.resumeFetch({ request_id: 'night-original', resume_id: 'night-resume-1' })
  assert.equal(new URL(calls[0].url).searchParams.get('request_id'), 'night-original')
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(new URL(calls[1].url).pathname, '/telegram-rag/fetch/cancel')
  assert.deepEqual(JSON.parse(calls[1].options.body), { request_id: 'night-original' })
  assert.equal(new URL(calls[2].url).pathname, '/telegram-rag/fetch/resume')
  assert.deepEqual(JSON.parse(calls[2].options.body), { request_id: 'night-original', resume_id: 'night-resume-1' })
  assert.ok(calls.every(call => !call.url.endsWith('/fetch/start')))
})

test('unknown accepted fetch preserves its durable recovery identity in an API error', async () => {
  const client = createTelegramRagClient({ fetchImpl: async () => response({ ok: false,
    code: 'FETCH_START_OUTCOME_UNKNOWN', error: 'ack lost', request_id: 'night-original',
    job_id: 'fetch:night-original', accepted: true }, 400) })
  await assert.rejects(client.startFetch({ request_id: 'night-original', target: '@fixture', mode: 'all' }), error => {
    assert.equal(error.code, 'FETCH_START_OUTCOME_UNKNOWN')
    assert.equal(error.request_id, 'night-original')
    assert.equal(error.job_id, 'fetch:night-original')
    assert.equal(error.accepted, true)
    return true
  })
})
