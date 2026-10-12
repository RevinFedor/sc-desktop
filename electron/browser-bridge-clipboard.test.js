'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const Module = require('node:module')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-clipboard-contract-'))
process.env.SC_DESKTOP_DIR = root
process.env.SC_DESKTOP_DB = path.join(root, 'library.db')
const transcriptPath = path.join(root, 'transcript.txt')
const commentsPath = path.join(root, 'comments.txt')
fs.writeFileSync(transcriptPath, 'transcript', 'utf8')
fs.writeFileSync(commentsPath, 'comments', 'utf8')
const writes = [], starts = [], listeners = new Set()
const realLoad = Module._load
Module._load = function (name, ...args) {
  if (name === 'electron') return { clipboard: { writeText: text => writes.push(text) } }
  return realLoad.call(this, name, ...args)
}
const { startServer } = require('./browser-bridge')
const db = require('./database')
let cachedTranscript = true, cachedComments = true
const runner = {
  LIB_ROOT: root,
  lookupYoutubeCache: () => cachedTranscript ? { id: 90, file_path: transcriptPath } : null,
  lookupYoutubeCommentsCache: () => cachedComments ? { id: 91, file_path: commentsPath } : null,
  startYoutubeSingle: params => { starts.push({ id: 1, kind: 'transcript', params }); return 1 },
  startYoutubeComments: params => { starts.push({ id: 2, kind: 'comments', params }); return 2 },
  startTelegramLive: params => { starts.push({ id: 3, kind: 'telegram_live', params }); return 3 },
  startTelegramFetch: params => { starts.push({ id: 4, kind: 'telegram_save', params }); return 4 },
  getJobDetail: id => ({ id, status: 'running' }),
  subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
}
const server = startServer({ port: 0, jobRunner: runner })
let base
test.before(async () => {
  if (!server.listening) await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
})
test.beforeEach(() => { writes.length = 0; starts.length = 0; listeners.clear() })
test.after(async () => {
  await new Promise(resolve => server.close(resolve))
  db.close()
  Module._load = realLoad
  fs.rmSync(root, { recursive: true, force: true })
})
async function call(route, body) {
  const response = await fetch(base + route, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {})
  return { status: response.status, body: await response.json() }
}
const input = { url: 'https://www.youtube.com/watch?v=fixture1234', withComments: true }
function complete(id, file_path) {
  for (const listener of [...listeners]) listener({ id, file_path, status: 'done' })
}

test('MCP cache hit returns both saved paths and full text without touching clipboard', async () => {
  cachedTranscript = cachedComments = true
  const out = await call('/yt-add', { ...input, origin: 'mcp', autoCopy: true })
  assert.equal(out.status, 200)
  assert.equal(out.body.fromCache, true)
  assert.equal(out.body.cached_file_path, transcriptPath)
  assert.equal(out.body.cached_comments_file_path, commentsPath)
  const result = await call(`/yt-fetch?path=${encodeURIComponent(transcriptPath)}`)
  assert.equal(result.body.text, 'transcript')
  assert.deepEqual(starts, [])
  assert.deepEqual(writes, [])
  assert.equal(listeners.size, 0)
})

test('MCP cached transcript plus late comments never copies either intermediate or combined text', async () => {
  cachedTranscript = true; cachedComments = false
  const out = await call('/yt-add', { ...input, origin: 'mcp' })
  assert.equal(out.body.fromCache, true)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].params.origin, 'mcp')
  complete(2, commentsPath)
  assert.deepEqual(writes, [])
  assert.equal(listeners.size, 0)
})

test('MCP live transcript and comments inherit provenance and do not schedule combined copying', async () => {
  cachedTranscript = cachedComments = false
  const out = await call('/yt-add', { ...input, origin: 'mcp' })
  assert.equal(out.body.jobId, 1)
  assert.equal(out.body.commentsJobId, 2)
  assert.equal(starts.length, 2)
  assert.ok(starts.every(start => start.params.origin === 'mcp'))
  complete(1, transcriptPath); complete(2, commentsPath)
  assert.deepEqual(writes, [])
  assert.equal(listeners.size, 0)
})

test('human extension cache hit still copies the combined result without requiring an Origin header', async () => {
  cachedTranscript = cachedComments = true
  await call('/yt-add', input)
  assert.deepEqual(writes, ['transcript\n\ncomments'])
})

test('human cached transcript with late comments preserves intermediate then combined delivery', async () => {
  cachedTranscript = true; cachedComments = false
  await call('/yt-add', input)
  assert.deepEqual(writes, ['transcript'])
  complete(2, commentsPath)
  assert.deepEqual(writes, ['transcript', 'transcript\n\ncomments'])
  assert.equal(listeners.size, 0)
})

test('human live transcript and comments still combine after both completions', async () => {
  cachedTranscript = cachedComments = false
  await call('/yt-add', input)
  complete(2, commentsPath)
  assert.deepEqual(writes, [])
  complete(1, transcriptPath)
  assert.deepEqual(writes, ['transcript\n\ncomments'])
  assert.equal(listeners.size, 0)
})

test('machine-only Telegram routes override a caller request to enable clipboard effects', async () => {
  const live = await call('/telegram-live/start', { operation: 'search', origin: 'client', autoCopy: true })
  const saved = await call('/telegram-live/save', { chat: 'fixture', message_ids: [1], origin: 'client', autoCopy: true })
  assert.equal(live.status, 200)
  assert.equal(saved.status, 200)
  assert.equal(starts.length, 2)
  assert.ok(starts.every(start => start.params.origin === 'mcp' && start.params.autoCopy === false))
  assert.deepEqual(writes, [])
})
