'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { once } = require('node:events')
const { shouldAutoCopy } = require('./clipboard-policy')

// The actual HTTP import/result routes and actual MCP client, with a controlled
// job producer instead of YouTube/network/paid transcription. No OS clipboard.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mobile-clipboard-'))
process.env.SC_DESKTOP_DIR = root
process.env.SC_MOBILE_PORT = '0'
const filePath = path.join(root, 'result.txt')
fs.writeFileSync(filePath, 'complete transcript\n', 'utf8')
const { startMobileApiServer, TOKEN_PATH } = require('./mobile-api-server')
const { createYoutubeSubtitlesClient } = require('../mcp/youtube-subtitles-client')
const starts = [], writes = [], listeners = new Set()
let cached = false, nextId = 0
const runner = {
  LIB_ROOT: root,
  lookupYoutubeCache: () => cached ? { file_path: filePath } : null,
  startYoutubeSingle: params => { starts.push({ id: ++nextId, params }); return nextId },
  subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
}
const originalCreateServer = http.createServer
let server
http.createServer = (...args) => (server = originalCreateServer(...args))
const facade = startMobileApiServer({ db: {}, jobRunner: runner, readScSettings: () => ({}) })
http.createServer = originalCreateServer
let base, client, token
test.before(async () => {
  if (!server.listening) await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
  token = fs.readFileSync(TOKEN_PATH, 'utf8').trim()
  client = createYoutubeSubtitlesClient({ baseUrl: base, token })
})
test.after(async () => {
  const closed = once(server, 'close')
  facade.close()
  await closed
  fs.rmSync(root, { recursive: true, force: true })
})
function complete(start) {
  // Verify the provenance passed to the worker-side automatic delivery gate.
  if (shouldAutoCopy(start.params, {})) writes.push('complete transcript\n')
  for (const listener of listeners) listener({ id: start.id, status: 'done', file_path: filePath })
}
async function post(input) {
  const response = await fetch(`${base}/api/imports`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  assert.ok(response.ok)
  return (await response.json()).import
}

test('MCP client -> actual mobile import -> saved completion -> full API result, no clipboard', async () => {
  const out = await client.start({ url: 'https://youtube.com/watch?v=fixture1234', client_request_id: 'clipboard-mcp', wait_ms: 0 })
  assert.equal(out.status, 'running')
  const started = starts.at(-1)
  assert.equal(started.params.origin, 'mcp')
  assert.equal(started.params.autoCopy, false)
  complete(started)
  const result = await client.status({ import_id: out.import.id, wait_ms: 0 })
  assert.equal(result.status, 'done')
  assert.equal(result.text, 'complete transcript\n')
  assert.deepEqual(writes, [])
  const repeated = await client.start({ url: 'https://youtube.com/watch?v=fixture1234', client_request_id: 'clipboard-mcp', wait_ms: 0 })
  assert.equal(repeated.import.id, out.import.id)
  assert.equal(starts.length, 1, 'no second job after idempotent repeat')
  assert.deepEqual(writes, [])
})

test('human request using the same API retains clipboard delivery independently of MCP', async () => {
  const item = await post({ url: 'https://youtube.com/watch?v=fixture2345', clientRequestId: 'clipboard-human' })
  const started = starts.at(-1)
  assert.equal(started.params.origin, 'client')
  assert.equal(started.params.autoCopy, true)
  complete(started)
  assert.equal((await client.status({ import_id: item.id, wait_ms: 0 })).status, 'done')
  assert.deepEqual(writes, ['complete transcript\n'])
})

test('MCP cache hit returns saved text without a worker or any clipboard delivery', async () => {
  cached = true
  const before = starts.length
  const out = await client.start({ url: 'https://youtube.com/watch?v=fixture3456', client_request_id: 'clipboard-cache', wait_ms: 0 })
  assert.equal(out.status, 'done')
  assert.equal(out.text, 'complete transcript\n')
  assert.equal(starts.length, before)
  assert.deepEqual(writes, ['complete transcript\n'])
})
