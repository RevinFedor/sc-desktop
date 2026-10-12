const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const IMPORT_ID = 'abcdef12-1234-4234-8234-123456789abc'

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

test('publishes and calls the YouTube subtitle tool over MCP stdio', async t => {
  const projectRoot = path.resolve(__dirname, '..')
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mcp-youtube-'))
  const token = 'a'.repeat(64)
  fs.writeFileSync(path.join(dataRoot, 'mobile-api-token'), `${token}\n`, { mode: 0o600 })
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))

  let postSeen = false
  let postedOrigin = null
  let searchSeen = false
  const api = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    if (req.method === 'POST' && req.url === '/api/youtube/search') {
      searchSeen = true
      return sendJson(res, 200, {
        ok: true,
        query: 'Bob McGrew agents',
        limit: 1,
        offset: 0,
        items: [{
          video_id: 'abcdefghijk',
          title: 'Bob McGrew interview',
          url: 'https://www.youtube.com/watch?v=abcdefghijk',
        }],
      })
    }
    if (req.method === 'POST' && req.url === '/api/imports') {
      postSeen = true
      // The app disables automatic clipboard delivery based on this field,
      // so the MCP client must always identify itself as a machine caller.
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        try { postedOrigin = JSON.parse(raw).origin } catch {}
      })
      return sendJson(res, 200, {
        ok: true,
        import: {
          id: IMPORT_ID,
          platform: 'youtube',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          status: 'done',
        },
      })
    }
    if (req.method === 'GET' && req.url === `/api/imports/${IMPORT_ID}/result`) {
      return sendJson(res, 200, { ok: true, text: 'fixture subtitles' })
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  })
  await new Promise((resolve, reject) => {
    api.once('error', reject)
    api.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => api.close(resolve)))
  const port = api.address().port

  const transport = new StdioClientTransport({
    command: path.join(projectRoot, 'mcp', 'run.sh'),
    cwd: projectRoot,
    env: {
      ...process.env,
      SC_DESKTOP_DIR: dataRoot,
      SC_MOBILE_PORT: String(port),
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'youtube-subtitles-test', version: '1.0.0' }, { capabilities: {} })
  t.after(() => client.close())
  await client.connect(transport)

  const listed = await client.listTools()
  const names = new Set(listed.tools.map(tool => tool.name))
  assert.equal(names.has('youtube_get_subtitles'), true)
  assert.equal(names.has('youtube_search'), true)
  assert.equal(names.has('youtube_subtitles_status'), true)
  assert.equal(names.has('youtube_subtitles_cancel'), true)
  assert.equal(names.has('youtube_list_channels'), true)
  assert.equal(names.has('youtube_channel_index'), true)
  assert.equal(names.has('youtube_channel_index_status'), true)
  assert.equal(names.has('youtube_channel_semantic_search'), true)
  assert.equal(names.has('youtube_channel_context'), true)

  const response = await client.callTool({
    name: 'youtube_get_subtitles',
    arguments: {
      url: 'https://youtu.be/dQw4w9WgXcQ',
      client_request_id: 'mcp-fixture-request',
      wait_ms: 0,
    },
  })
  assert.equal(response.isError, undefined)
  const result = JSON.parse(response.content[0].text)
  assert.equal(postSeen, true)
  assert.equal(postedOrigin, 'mcp')
  assert.equal(result.status, 'done')
  assert.equal(result.text, 'fixture subtitles')

  const searchResponse = await client.callTool({
    name: 'youtube_search',
    arguments: { query: 'Bob McGrew agents', limit: 1 },
  })
  const searchResult = JSON.parse(searchResponse.content[0].text)
  assert.equal(searchSeen, true)
  assert.equal(searchResult.count, 1)
  assert.equal(searchResult.items[0].title, 'Bob McGrew interview')
})
