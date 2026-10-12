const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-research-contract-'))
process.env.SC_DESKTOP_DIR = root
process.env.SC_DESKTOP_DB = path.join(root, 'library.db')
// A real pre-migration history row must survive opening the new application.
const LegacyDatabase = require('better-sqlite3')
const legacy = new LegacyDatabase(process.env.SC_DESKTOP_DB)
legacy.exec(`CREATE TABLE research_jobs (
  job_id TEXT PRIMARY KEY, kind TEXT, provider TEXT, model_id TEXT, mode TEXT,
  status TEXT, stage TEXT, prompt TEXT, response_text TEXT, url TEXT,
  response_len INTEGER, link_count INTEGER, result_json TEXT, error TEXT,
  created_at INTEGER, updated_at INTEGER, done_at INTEGER
)`)
legacy.prepare('INSERT INTO research_jobs(job_id, provider, status, response_text) VALUES (?, ?, ?, ?)')
  .run('legacy_fixture', 'chatgpt', 'done', 'saved before migration')
legacy.close()
const database = require('./database')
const state = require('./research-state')
const { startServer } = require('./browser-bridge')
const { prepareResearchAttachments } = require('./research-attachment-preparer')
let opened = []
let tabs = new Map()
let nextTabId = 100
let holdOpen = null
let onOpen = null
let stallAttachment = false
let onStalledPreparation = null
let releasePreparation = null
const server = startServer({
  port: 0,
  jobRunner: { LIB_ROOT: root },
  settingsAccess: { readScSettings: () => ({ main: { external_research_temporary_chat: true } }) },
  prepareAttachments: async (input, options) => {
    if (input.id === 'contract_file_error') throw Object.assign(new Error('blocked /fixture/source.md; no browser send'), { code: 'attachment_preparation_timeout' })
    if (stallAttachment && input.id === 'contract_slow_file') {
      await new Promise(resolve => { releasePreparation = resolve; onStalledPreparation?.() })
    }
    return prepareResearchAttachments(input, options)
  },
  requestExtension: async (action, { url }) => {
    const id = new URL(url).searchParams.get('sc-research')
    if (action === 'mcp_find_research_tab') return { success: true, tabId: tabs.get(id) ?? null, url }
    assert.equal(action, 'mcp_open_research_tab')
    // Persistence must precede an externally visible browser side effect.
    assert.equal(database.getResearchJob(id).requestMetadata.dispatchState, 'opening')
    opened.push(id)
    const tabId = ++nextTabId
    onOpen?.(id)
    if (holdOpen) await holdOpen
    tabs.set(id, tabId)
    return { success: true, tabId: tabs.get(id) }
  },
})
let base
test.before(async () => {
  if (!server.listening) await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => {
  await new Promise(resolve => server.close(resolve))
  database.getDb().close()
  fs.rmSync(root, { recursive: true, force: true })
})

async function call(route, body) {
  const response = await fetch(base + route, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {})
  return { status: response.status, body: await response.json() }
}
function request(id, extra = {}) {
  return {
    requestId: id, provider: 'chatgpt', prompt: 'review this version',
    options: { mode: 'chat', model: '5.6-sol', effort: 'medium', temporaryChat: false, autoClose: false },
    ...extra,
  }
}

test('GPT-6 Chat keeps the exact model and non-Pro effort through HTTP and durable job storage', async () => {
  for (const [model, effort] of [['6', 'xhigh'], ['6-astra', 'pro']]) {
    const input = request(`contract_gpt6_${model}`, { options: {
      mode: 'chat', model, effort, temporaryChat: false, autoClose: false,
    } })
    const started = await call('/research-start', input)
    assert.equal(started.status, 200)
    assert.deepEqual((await call(`/research-job?id=${input.requestId}`)).body.options, input.options)
    assert.deepEqual(database.getResearchJob(input.requestId).requestMetadata.options, input.options)
    assert.equal(new URL(started.body.url).searchParams.has('temporary-chat'), false)
    assert.equal(opened.filter(id => id === input.requestId).length, 1)
  }
})

test('simultaneous duplicate starts open once and conflicting reuse is rejected', async () => {
  let release
  holdOpen = new Promise(resolve => { release = resolve })
  const input = request('contract_parallel')
  const before = opened.length
  const first = call('/research-start', input)
  while (opened.length === before) await new Promise(resolve => setTimeout(resolve, 5))
  const second = call('/research-start', input)
  const conflict = await call('/research-start', { ...input, prompt: 'different task' })
  assert.equal(conflict.status, 409)
  release(); holdOpen = null
  const results = await Promise.all([first, second])
  assert.equal(opened.length, before + 1)
  assert.deepEqual(results.map(result => result.body.id), [input.requestId, input.requestId])
})

test('ten independent starts pass the file pool before any browser ACK and keep results isolated', { timeout: 15000 }, async (t) => {
  const file = path.join(root, 'ten-inputs.md')
  const inputs = Array.from({ length: 10 }, (_, i) => `input-${i}`)
  fs.writeFileSync(file, inputs.join('\n'))
  const requests = inputs.map((_, i) => request(`contract_ten_${i}`, {
    prompt: `task-${i}`, files: [{ path: file, startLine: i + 1, endLine: i + 1 }],
  }))
  let release
  let allOpened
  holdOpen = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { allOpened = resolve })
  const seen = new Set()
  onOpen = id => {
    if (id.startsWith('contract_ten_')) seen.add(id)
    if (seen.size === 10) allOpened()
  }
  t.after(() => { release(); holdOpen = null; onOpen = null })
  const starts = requests.map(input => call('/research-start', input))
  let startAcks = 0
  starts.forEach(start => start.then(() => { startAcks++ }))
  // A global launch lock, or a file worker held until browser completion,
  // would deadlock here: all ten must enter open while every ACK is withheld.
  await ready
  assert.equal(startAcks, 0)
  assert.equal((await call('/healthz')).body.ok, true)
  release(); holdOpen = null; onOpen = null
  const accepted = await Promise.all(starts)
  assert(accepted.every(result => result.status === 200))
  assert.equal(new Set(accepted.map(result => result.body.tabId)).size, 10)
  assert.equal(new Set(accepted.map(result => result.body.url)).size, 10)
  const jobs = await Promise.all(requests.map(input => call(`/research-job?id=${input.requestId}`)))
  assert.deepEqual(jobs.map(result => result.body.prompt), inputs.map((_, i) => `task-${i}`))
  const snapshots = await Promise.all(requests.map(input => fetch(`${base}/research-attachment?id=${input.requestId}&index=0`)
    .then(r => r.json()).then(file => Buffer.from(file.base64, 'base64').toString('utf8'))))
  assert.deepEqual(snapshots, inputs)
  await Promise.all(requests.map(input => call('/research-state', {
    id: input.requestId, status: 'running', stage: 'running',
  })))
  // The earliest run stays busy while every later run finishes in reverse order.
  for (let i = 9; i >= 1; i--) {
    await call('/research-state', { id: requests[i].requestId, status: 'done',
      url: `https://chatgpt.com/c/parallel-${i}`, result: { text: `answer-${i}` } })
  }
  assert.equal((await call(`/research-status?id=${requests[0].requestId}`)).body.status, 'running')
  await call('/research-state', { id: requests[0].requestId, status: 'error', error: 'fixture provider failure' })
  for (let i = 0; i < 10; i++) {
    state.remove(requests[i].requestId)
    const restored = (await call(`/research-status?id=${requests[i].requestId}`)).body
    assert.equal(restored.status, i === 0 ? 'error' : 'done')
    if (i) assert.equal(restored.result.text, `answer-${i}`)
  }
  const beforeReplay = opened.length
  const replay = await call('/research-start', requests[7])
  assert.equal(replay.body.result.text, 'answer-7')
  assert.equal(opened.length, beforeReplay)
})

test('two reviews keep the conversation and use separate answers and file snapshots', async () => {
  const file = path.join(root, 'same-name.md')
  fs.writeFileSync(file, 'version one: amber')
  const first = request('contract_review_one', { files: [file] })
  const started = await call('/research-start', first)
  assert.equal(started.status, 200)
  assert.equal(new URL(started.body.url).searchParams.has('temporary-chat'), false)
  const conversationUrl = 'https://chatgpt.com/c/fixture-conversation'
  await call('/research-state', { id: first.requestId, provider: 'chatgpt', status: 'done', url: conversationUrl,
    result: { text: 'first answer: amber', url: conversationUrl } })
  fs.writeFileSync(file, 'version two: violet')
  const second = request('contract_review_two', { files: [file], conversationUrl, prompt: 'review new version' })
  await call('/research-start', second)
  const followupPayload = await call(`/research-job?id=${second.requestId}`)
  assert.deepEqual(followupPayload.body.conversationModeProof, {
    conversationId: 'fixture-conversation', mode: 'chat',
  })
  assert.equal(database.findResearchConversationMode('https://chatgpt.com/c/fixture-conversation-other'), null)
  await call('/research-state', { id: second.requestId, provider: 'chatgpt', status: 'done', url: conversationUrl,
    result: { text: 'second answer: violet', url: conversationUrl } })
  const [a, b] = await Promise.all([first, second].map(input => call(`/research-status?id=${input.requestId}`)))
  assert.equal(a.body.conversationId, b.body.conversationId)
  assert.equal(b.body.conversationUrl, conversationUrl)
  assert.notEqual(a.body.id, b.body.id)
  assert.equal(a.body.result.text, 'first answer: amber')
  assert.equal(b.body.result.text, 'second answer: violet')
  const bytes = await Promise.all([first, second].map(input => fetch(`${base}/research-attachment?id=${input.requestId}&index=0`)
    .then(r => r.json()).then(file => Buffer.from(file.base64, 'base64').toString('utf8'))))
  assert.deepEqual(bytes, ['version one: amber', 'version two: violet'])
  const count = opened.length
  state.remove(first.requestId)
  const restored = await call('/research-start', first)
  assert.equal(restored.body.result.text, 'first answer: amber')
  assert.equal(opened.length, count)
})

test('restart restores original request options and attachments before a content-script update', async () => {
  const input = request('contract_recovery')
  await call('/research-start', input)
  state.remove(input.requestId)
  await call('/research-state', { id: input.requestId, provider: 'chatgpt', status: 'running', stage: 'running' })
  const original = await call(`/research-job?id=${input.requestId}`)
  assert.equal(original.body.prompt, input.prompt)
  assert.equal(original.body.options.temporaryChat, false)
  assert.equal(original.body.options.effort, 'medium')
  const before = opened.length
  state.remove(input.requestId)
  const recoveredStatus = await call(`/research-status?id=${input.requestId}`)
  assert.equal(recoveredStatus.status, 200)
  const recovered = await call('/research-start', input)
  assert.equal(recovered.status, 200)
  assert.equal(opened.length, before)
})

test('a vanished browser tab after restart cannot cause a second paid request', async () => {
  const input = request('contract_missing_tab')
  await call('/research-start', input)
  state.remove(input.requestId)
  tabs.delete(input.requestId)
  const before = opened.length
  const recovered = await call('/research-start', input)
  assert.equal(recovered.body.status, 'error')
  assert.equal(recovered.body.stage, 'delivery_unknown')
  assert.equal(recovered.body.deliveryUnknown, true)
  assert.equal(opened.length, before)
  const again = await call('/research-start', input)
  assert.equal(again.body.status, 'error')
  assert.equal(opened.length, before)
})

test('failure to persist the request cannot open a browser tab', async () => {
  const save = database.upsertResearchJob
  database.upsertResearchJob = () => { throw new Error('fixture disk failure') }
  const before = opened.length
  try {
    const result = await call('/research-start', request('contract_disk_failure'))
    assert.equal(result.status, 503)
    assert.equal(result.body.code, 'research_request_persistence_failed')
    assert.equal(opened.length, before)
  } finally { database.upsertResearchJob = save }
})

test('capabilities advertise the same continuation contract as the real routes', async () => {
  const result = await call('/research-capabilities')
  assert.equal(result.body.idempotentRequestId, true)
  assert.equal(result.body.continuation.separateJobPerTurn, true)
  assert.ok(result.body.statusRecovery.includes('durable-request'))
})

test('additive migration preserves old answers and refuses unprovable id reuse', async () => {
  const result = await call('/research-status?id=legacy_fixture')
  assert.equal(result.body.result.text, 'saved before migration')
  assert.equal(result.body.prompt, undefined)
  assert.equal(result.body.requestMetadata, undefined)
  const reused = await call('/research-start', request('legacy_fixture'))
  assert.equal(reused.status, 422)
  assert.equal(reused.body.code, 'research_request_identity_unavailable')
})

test('an unsent prepared request can resume after the pre-dispatch write fails', async () => {
  const save = database.upsertResearchJob
  let writes = 0
  database.upsertResearchJob = job => {
    if (++writes === 2) throw new Error('fixture pre-dispatch disk failure')
    return save(job)
  }
  const before = opened.length
  const input = request('contract_prepared')
  try {
    const failed = await call('/research-start', input)
    assert.equal(failed.status, 503)
    assert.equal(failed.body.deliveryUnknown, false)
    assert.equal(opened.length, before)
  } finally { database.upsertResearchJob = save }
  state.remove(input.requestId)
  const restored = await call(`/research-status?id=${input.requestId}`)
  assert.equal(restored.status, 200)
  assert.equal(restored.body.id, input.requestId)
  assert.equal(opened.length, before + 1)
})

test('late running status cannot erase a completed answer', async () => {
  const input = request('contract_late_status')
  await call('/research-start', input)
  await call('/research-state', { id: input.requestId, status: 'done', result: { text: 'accepted answer' } })
  const late = await call('/research-state', { id: input.requestId, status: 'running', stage: 'running' })
  assert.equal(late.body.status, 'done')
  assert.equal(late.body.result.text, 'accepted answer')
})

test('health and other starts remain responsive during attachment preparation', async () => {
  stallAttachment = true
  const started = new Promise(resolve => { onStalledPreparation = resolve })
  const file = path.join(root, 'delayed.md')
  fs.writeFileSync(file, 'delayed input')
  const delayed = call('/research-start', request('contract_slow_file', { files: [file] }))
  try {
    await started
    const [health, other] = await Promise.all([
      call('/healthz'), call('/research-start', request('contract_independent')),
    ])
    assert.equal(health.body.ok, true)
    assert.equal(other.status, 200)
    assert.equal(opened.includes('contract_slow_file'), false)
    releasePreparation()
    assert.equal((await delayed).status, 200)
  } finally {
    stallAttachment = false
    onStalledPreparation = null
    releasePreparation?.()
  }
})

test('a lost HTTP response does not lose a preparation failure or repeat the browser request', async () => {
  const input = request('contract_file_error', { files: ['/fixture/source.md'] })
  const before = opened.length
  const failed = await call('/research-start', input)
  assert.equal(failed.body.status, 'error')
  assert.equal(failed.body.stage, 'attachment_validation')
  state.remove(input.requestId)
  const recovered = await call(`/research-status?id=${input.requestId}`)
  assert.equal(recovered.body.status, 'error')
  assert.match(recovered.body.error, /blocked.*source.md/)
  const retry = await call('/research-start', input)
  assert.equal(retry.body.status, 'error')
  assert.equal(opened.length, before)
})
