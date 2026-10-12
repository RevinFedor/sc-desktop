const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')


function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}


test('publishes Telegram live transcription and returns text plus both files', async t => {
  const projectRoot = path.resolve(__dirname, '..')
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mcp-telegram-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  const cacheDir = path.join(
    dataRoot, 'cache', 'telegram-live-attachments', '3451593250', '37314',
  )
  fs.mkdirSync(cacheDir, { recursive: true })
  const mediaPath = path.join(cacheDir, '37314-attachment-37314.oga')
  const transcriptPath = path.join(cacheDir, '37314-attachment-37314__soniox.txt')
  fs.writeFileSync(mediaPath, Buffer.from('OggSfixture'))
  fs.writeFileSync(transcriptPath, 'Короткая проверенная расшифровка\n')

  let requestBody = null
  const bridge = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/telegram-live/start') {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        requestBody = JSON.parse(raw)
        sendJson(res, 200, { ok: true, job_id: 'desktop:9', desktop_job_id: 9 })
      })
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/telegram-live/status')) {
      return sendJson(res, 200, {
        ok: true,
        job_id: 'desktop:9',
        job: { status: 'done', type: 'tg_live_transcribe' },
        result: {
          operation: 'transcribe',
          chat: { id: 3451593250, title: 'Fixture chat' },
          message: { message_id: 37314, type: 'voice', url: 'https://t.me/c/3451593250/37314' },
          attachment_found: true,
          attachment: {
            kind: 'voice', content_type: 'audio/ogg', bytes: 11,
            file_path: mediaPath, content_kind: 'audio',
          },
          file_path: mediaPath,
          transcript_path: transcriptPath,
          transcription: {
            status: 'transcribed', engine: 'soniox', model: 'stt-async-v5',
            text: 'Короткая проверенная расшифровка', chars: 32,
            returned_chars: 32, token_count: 4, truncated: false,
          },
          media_downloaded: true,
          hits: 1,
          unique_hits: 1,
          truncated: false,
        },
      })
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  })
  await new Promise((resolve, reject) => {
    bridge.once('error', reject)
    bridge.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => bridge.close(resolve)))

  const transport = new StdioClientTransport({
    command: path.join(projectRoot, 'mcp', 'run.sh'),
    cwd: projectRoot,
    env: {
      ...process.env,
      SC_DESKTOP_DIR: dataRoot,
      SC_DESKTOP_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`,
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'telegram-live-test', version: '1.0.0' }, { capabilities: {} })
  t.after(() => client.close())
  await client.connect(transport)

  const listed = await client.listTools()
  const tool = listed.tools.find(row => row.name === 'telegram_live_transcribe')
  assert.ok(tool)
  assert.match(tool.description, /Soniox/)

  const response = await client.callTool({
    name: 'telegram_live_transcribe',
    arguments: {
      url: 'https://t.me/c/3451593250/37314',
      context: 'Таиланд',
      wait_ms: 30000,
    },
  })
  assert.equal(requestBody.operation, 'transcribe')
  assert.equal(requestBody.engine, 'soniox')
  assert.equal(requestBody.context, 'Таиланд')
  assert.deepEqual(response.content.map(block => block.type), [
    'text', 'resource_link', 'resource_link', 'text',
  ])
  const metadata = JSON.parse(response.content[0].text)
  assert.equal(metadata.result.transcription.text, undefined)
  assert.equal(metadata.result.delivery.transcript_text_included, true)
  assert.match(response.content[3].text, /Короткая проверенная расшифровка/)
})


test('publishes confirmed membership tools and read-only public search', async t => {
  const projectRoot = path.resolve(__dirname, '..')
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mcp-membership-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  const requests = []
  const bridge = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/telegram-live/start') {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        requests.push(JSON.parse(raw))
        sendJson(res, 200, {
          ok: true,
          job_id: `desktop:${requests.length}`,
          desktop_job_id: requests.length,
          job: { status: 'running', type: `tg_live_${requests.at(-1).operation}` },
        })
      })
      return
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  })
  await new Promise((resolve, reject) => {
    bridge.once('error', reject)
    bridge.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => bridge.close(resolve)))

  const transport = new StdioClientTransport({
    command: path.join(projectRoot, 'mcp', 'run.sh'),
    cwd: projectRoot,
    env: {
      ...process.env,
      SC_DESKTOP_DIR: dataRoot,
      SC_DESKTOP_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`,
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'telegram-membership-test', version: '1.0.0' }, { capabilities: {} })
  t.after(() => client.close())
  await client.connect(transport)

  const listed = await client.listTools()
  const byName = new Map(listed.tools.map(tool => [tool.name, tool]))
  assert.equal(byName.get('telegram_search_public_chats').annotations.readOnlyHint, true)
  assert.equal(byName.get('telegram_join_chat').annotations.idempotentHint, true)
  assert.equal(byName.get('telegram_leave_chat').annotations.destructiveHint, true)

  const rejected = await client.callTool({
    name: 'telegram_join_chat',
    arguments: { target: '@fixture', wait_ms: 0 },
  })
  assert.equal(rejected.isError, true)
  assert.equal(requests.length, 0)

  await client.callTool({
    name: 'telegram_join_chat',
    arguments: { target: 'https://t.me/+AbCdEf_123', confirm: true, wait_ms: 0 },
  })
  await client.callTool({
    name: 'telegram_leave_chat',
    arguments: { target: '@fixture_chat', confirm: true, wait_ms: 0 },
  })
  await client.callTool({
    name: 'telegram_search_public_chats',
    arguments: { query: 'Phuket rentals', limit: 7, wait_ms: 0 },
  })
  assert.deepEqual(requests.map(request => request.operation), ['join', 'leave', 'public_search'])
  assert.equal(requests[0].confirm, true)
  assert.equal(requests[0].target, 'https://t.me/+AbCdEf_123')
  assert.equal(requests[1].target, '@fixture_chat')
  assert.equal(requests[2].query, 'Phuket rentals')
  assert.equal(requests[2].limit, 7)
})
