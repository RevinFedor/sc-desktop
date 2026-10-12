'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn: realSpawn } = require('node:child_process')
const { EventEmitter, once } = require('node:events')
const { PassThrough } = require('node:stream')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-public-catalog-http-'))
process.env.SC_DESKTOP_DIR = root
process.env.SC_DESKTOP_DB = path.join(root, 'library.db')
const db = require('./database')
const { createPublicCatalogRunner } = require('./boosty-catalog-runner')
const { createBoostyCatalogApi } = require('./boosty-catalog-api')
const { createBoostyCatalogClient } = require('../mcp/boosty-catalog-client')
const { callBoostyCatalogTool } = require('../mcp/boosty-catalog-tools')
const dbRead = require('./database-read-client')
const { finalizeCatalogJob, stopTelegramFinalizer } = require('./telegram-finalizer-client')
const token = 'b'.repeat(64), jobs = new Map(), events = new EventEmitter(), spawns = [], cancellations = []
let seq = 1, fake = false
const fixtureScript = path.resolve(__dirname, '../tests/fixtures/replay_public_worker.py')
const python = fs.existsSync(path.resolve(__dirname, '../.venv/bin/python3')) ? path.resolve(__dirname, '../.venv/bin/python3') : 'python3'
class ChildDouble extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.killed = false }
  send(event) { this.stdout.write(`${JSON.stringify(event)}\n`) }
  kill() { this.killed = true; queueMicrotask(() => this.emit('close', null)); return true }
}
const publicRunner = createPublicCatalogRunner({ db, jobs, allocateId: () => seq++,
  spawn: (exe, args, options) => {
    assert.equal(options.env.SC_BOOSTY_AUTH_COOKIE, undefined)
    assert.equal(options.env.SC_BOOSTY_AUTH_EXPIRES, undefined)
    const child = fake ? new ChildDouble() : realSpawn(exe, [fixtureScript, ...args.slice(1)], options)
    spawns.push({ args, child }); return child
  }, workerEnv: () => ({ PATH: process.env.PATH, SC_BOOSTY_AUTH_COOKIE: 'CREDENTIAL_NOT_FORWARDED', SC_BOOSTY_AUTH_EXPIRES: '9999' }),
  python, script: '/only-used-as-argv-marker/boosty_catalog_ndjson.py', cwd: root,
  emit: job => events.emit('job', job), finalizeCatalog: finalizeCatalogJob, logger: { log() {}, warn() {} } })
const runner = {
  startBoostyChannelFetch: p => publicRunner.start(p),
  getJobDetail: (id, options = {}) => options.identity === 'db' ? [...jobs.values()].find(j => j.dbRowId === Number(id)) : jobs.get(id),
  // Generic app controller is a double, not a live SC cancellation. The
  // real Python child is signalled only in this isolated fixture process.
  cancelJob: (id, options) => {
    cancellations.push({ id, options })
    const job = [...jobs.values()].find(j => j.dbRowId === Number(id))
    if (!job?.child) return false
    job._cancelRequested = true; job.status = 'cancelling'; job.child.kill('SIGTERM'); return true
  },
}
function api() {
  return createBoostyCatalogApi({ token, runner, read: (action, args) => dbRead.request('boostyCatalog', action, args),
    readBody: async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body) },
    sendJson: (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) } })
}
let currentApi = api()
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (!await currentApi.handle(req, res, url)) { res.writeHead(404); res.end('{}') }
})
let base
test.before(async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}` })
test.after(async () => {
  await new Promise(resolve => server.close(resolve))
  currentApi.close()
  // This finalizer belongs to THIS isolated test process, never the live app.
  await stopTelegramFinalizer()
  await dbRead.stop()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})
async function call(route, body = null, headers = { Authorization: `Bearer ${token}` }) {
  const response = await fetch(`${base}/boosty-catalog/${route}`, { method: body ? 'POST' : 'GET',
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json() }
}
async function terminal(jobId) {
  const found = [...jobs.values()].find(j => j.params.public_job_id === jobId)
  if (found && ['done', 'error', 'cancelled'].includes(found.status)) return found
  return new Promise((resolve, reject) => {
    const listener = job => { if (job.params.public_job_id === jobId && job.phase === 'terminal') { clearTimeout(timer); events.off('job', listener); resolve(job) } }
    const timer = setTimeout(() => { events.off('job', listener); reject(new Error('Fixture terminal deadline')) }, 10000)
    events.on('job', listener)
  })
}

test('actual HTTP handler enforces bearer/Origin/metadata scope before worker launch', async () => {
  const count = spawns.length
  assert.equal((await call('sources', null, {})).status, 401)
  assert.equal((await call('sources', null, { Authorization: `Bearer ${token}`, Origin: 'chrome-extension://forged' })).status, 403)
  const p = { handle: 'youareaageek', auth_mode: 'public', request_id: 'bad' }
  assert.equal((await call('start', { ...p, download_media: true })).status, 400)
  assert.equal((await call('start', { ...p, auth_mode: 'account' })).status, 400)
  assert.equal(spawns.length, count)
  assert.equal((await call('capabilities')).body.auto_clipboard, false)
})

test('HTTP→real catalogue runner→real Python worker with RETAINED transport→real DB finalizer→full paged339/153 and4/5 tiers', async () => {
  for (const [handle, expected, levels] of [['itkrasavchik', 339, 4], ['youareaageek', 153, 5]]) {
    const p = { handle, auth_mode: 'public', request_id: `http-full-${handle}`, autoCopy: true }
    const submitted = await call('start', p)
    assert.equal(submitted.status, 200)
    assert.equal(submitted.body.accepted, true)
    const job = await terminal(submitted.body.job_id)
    assert.equal(job.status, 'done', job.error)
    assert.equal(job.params.autoCopy, false)
    assert.equal(job.params.origin, 'mcp')
    assert.equal(job.boosty_channel.videos_total, handle === 'itkrasavchik' ? 240 : 235)
    assert.equal(job.boosty_channel.visible_videos, handle === 'itkrasavchik' ? 4 : 1)
    const status = await call(`status?job_id=${encodeURIComponent(submitted.body.job_id)}`)
    assert.equal(status.body.job.status, 'done')
    const state = (await call(`state?handle=${handle}`)).body
    assert.equal(state.latest.complete_visible_feed, true)
    assert.equal(state.latest.posts_count, expected)
    assert.equal(state.tiers.tiers.length, levels)
    assert.equal(state.tiers.complete, true)
    assert.equal(state.account_entitlement_verified, false)
    let offset = 0, seen = new Set(), pages = 0
    while (true) {
      const page = (await call(`posts?handle=${handle}&limit=37&offset=${offset}&expected_catalog_revision=${state.catalog_revision}`)).body
      assert.equal(page.ok, true)
      for (const post of page.posts) { assert.ok(!seen.has(post.post_id)); seen.add(post.post_id); assert.equal(post.metadata_only, true) }
      assert.ok(!/playerUrls|signedQuery|CREDENTIAL|transcript_path|thumbnail_url|media_path/.test(JSON.stringify(page)))
      pages++
      if (!page.has_more) break
      offset = page.next_offset
    }
    assert.equal(seen.size, expected)
    assert.equal(pages, Math.ceil(expected / 37))
    const before = spawns.length
    currentApi.close(); currentApi = api() // durable same-key retry after API recreation
    assert.equal((await call('start', p)).body.job_id, submitted.body.job_id)
    assert.equal(spawns.length, before)
    assert.equal((await call('start', { ...p, limit: 1 })).status, 409)
  }
})

test('limited pass and separate tiers refresh do not downgrade earlier complete feed', async () => {
  const p = { handle: 'youareaageek', auth_mode: 'public', request_id: 'http-limit', limit: 2 }
  const run = await call('start', p); await terminal(run.body.job_id)
  const state = (await call('state?handle=youareaageek')).body
  assert.equal(state.latest.complete_visible_feed, false)
  assert.equal(state.latest.posts_count, 2)
  assert.equal(state.last_complete.posts_count, 153)
  const refresh = await call('tiers/refresh', { handle: 'youareaageek', auth_mode: 'public', request_id: 'http-tiers' })
  await terminal(refresh.body.job_id)
  const after = (await call('tiers?handle=youareaageek')).body
  assert.equal(after.latest.job_id, run.body.job_id)
  assert.equal(after.tiers.tiers.length, 5)
  assert.equal((await call('posts?handle=youareaageek&offset=1')).status, 409)
})

test('MCP tool adapter and client use the actual HTTP contract, not hidden SQL/worker fallback', async () => {
  const client = createBoostyCatalogClient({ baseUrl: base, tokenReader: () => token })
  const submitted = JSON.parse((await callBoostyCatalogTool('boosty_catalog_start', { handle: 'youareaageek', request_id: 'mcp-http-replay' }, client)).content[0].text)
  assert.equal(submitted.ok, true)
  await terminal(submitted.job_id)
  const status = JSON.parse((await callBoostyCatalogTool('boosty_catalog_status', { request_id: submitted.request_id }, client)).content[0].text)
  assert.equal(status.job.status, 'done')
  const state = JSON.parse((await callBoostyCatalogTool('boosty_catalog_state', { handle: 'youareaageek' }, client)).content[0].text)
  const posts = JSON.parse((await callBoostyCatalogTool('boosty_catalog_posts', { handle: 'youareaageek', limit: 2, expected_catalog_revision: state.catalog_revision }, client)).content[0].text)
  assert.equal(posts.total, 153)
  assert.equal(posts.posts.length, 2)
  assert.equal(posts.coverage.auth_mode, 'public')
  assert.equal((await client.tiers({ handle: 'youareaageek' })).tiers.tiers.length, 5)
})

test('exact cancel/error persist partial metadata, keep complete proof, cannot cancel a reused physical id or account job', async () => {
  fake = true
  for (const shouldCancel of [true, false]) {
    const r = await call('start', { handle: 'youareaageek', auth_mode: 'public', request_id: shouldCancel ? 'http-cancel' : 'http-429' })
    const child = spawns.at(-1).child
    child.send({ type: 'entity', author_handle: 'youareaageek', author_id: '33702342', title: 'Про гринд в АйТи', posts_count: 153 })
    child.send({ type: 'post', data: { post_id: 'partial-real-id', title: 'Partial', has_access: null, videos: [] } })
    child.send({ type: 'page', page: 1, loaded: 1, fetched: 1, next_cursor: 'opaque', is_last: false })
    if (shouldCancel) {
      assert.equal((await call('cancel', { job_id: r.body.job_id })).body.cancel_requested, true)
    } else {
      child.send({ type: 'error', http_status: 429, message: 'RAW SECRET' })
      child.send({ type: 'done', posts_total: 1, pages: 1, fetched: 1, stop_reason: 'rate_limited', catalog_complete: false, remote_eof: false })
      child.emit('close', 4)
    }
    const job = await terminal(r.body.job_id)
    assert.equal(job.status, shouldCancel ? 'cancelled' : 'error')
    assert.ok(!JSON.stringify((await call(`status?job_id=${r.body.job_id}`)).body).includes('RAW SECRET'))
    assert.equal((await call('state?handle=youareaageek')).body.last_complete.posts_count, 153)
  }
  const count = cancellations.length
  assert.equal((await call('cancel', { job_id: 'account-or-unknown-job' })).status, 400)
  const last = [...jobs.values()].at(-1)
  last.params.public_job_id = 'other-job' // simulate numeric reuse, without a live child
  assert.equal((await call('cancel', { job_id: 'boosty-catalog:http-429' })).body.cancel_requested, false)
  assert.equal(cancellations.length, count)
  fake = false
})
