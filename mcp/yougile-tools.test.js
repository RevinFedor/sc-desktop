const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  loadYougileToolBridge,
  resolveYougileApiKey,
  resolveYougileFileUrl,
} = require('./yougile-tools')

test('embeds all upstream YouGile tools with JSON schemas', async () => {
  const bridge = await loadYougileToolBridge({ allowLegacy: false })
  assert.equal(bridge.tools.length, 61)
  assert.equal(new Set(bridge.tools.map(tool => tool.name)).size, 61)

  const listTasks = bridge.tools.find(tool => tool.name === 'yougile_list_tasks')
  assert.equal(listTasks.annotations.readOnlyHint, true)
  assert.equal(listTasks.inputSchema.type, 'object')
  assert.equal(listTasks.inputSchema.properties.limit.default, 50)

  const downloadFile = bridge.tools.find(tool => tool.name === 'yougile_download_file')
  assert.equal(downloadFile.annotations.readOnlyHint, true)
  assert.equal(downloadFile.inputSchema.properties.maxBytes.default, 100 * 1024 * 1024)

  const createSubtask = bridge.tools.find(tool => tool.name === 'yougile_create_subtask')
  assert.equal(createSubtask.annotations.readOnlyHint, false)
  assert.equal(createSubtask.annotations.idempotentHint, true)
  assert.deepEqual(createSubtask.inputSchema.required, ['parentId', 'title', 'requestId'])
  assert.equal(createSubtask.inputSchema.additionalProperties, false)
  assert.equal(createSubtask.inputSchema.properties.columnId, undefined)
})

test('prefers the shared SC settings without exposing the key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-yougile-settings-'))
  const settingsPath = path.join(dir, 'settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify({
    api_keys: { YOUGILE_API_KEY: 'test-secret' },
  }))

  const previous = process.env.YOUGILE_API_KEY
  delete process.env.YOUGILE_API_KEY
  try {
    assert.deepEqual(resolveYougileApiKey({ settingsPath, allowLegacy: false }), {
      key: 'test-secret',
      source: 'settings',
    })
  } finally {
    if (previous === undefined) delete process.env.YOUGILE_API_KEY
    else process.env.YOUGILE_API_KEY = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('uploads a local file and attaches it to the requested task chat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-yougile-upload-'))
  const settingsPath = path.join(dir, 'settings.json')
  const filePath = path.join(dir, 'evidence.png')
  fs.writeFileSync(settingsPath, JSON.stringify({ api_keys: { YOUGILE_API_KEY: 'test-secret' } }))
  fs.writeFileSync(filePath, Buffer.from('fake-png'))

  const calls = []
  const bridge = await loadYougileToolBridge({
    settingsPath,
    allowLegacy: false,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      if (String(url).endsWith('/upload-file')) {
        assert.ok(options.body instanceof FormData)
        return new Response(JSON.stringify({
          result: 'ok',
          url: '/user-data/upload-id/evidence.png',
          fullUrl: 'https://yougile.com/user-data/upload-id/evidence.png',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ id: 123456 }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  try {
    const result = await bridge.call('yougile_send_task_file', {
      taskId: 'task-uuid',
      filePath,
      caption: 'Скриншот проверки',
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, 'https://yougile.com/api-v2/upload-file')
    assert.equal(calls[1].url, 'https://yougile.com/api-v2/chats/task-uuid/messages')
    assert.equal(calls[1].options.headers.Authorization, 'Bearer test-secret')
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      text: 'Скриншот проверки\n/root/#file:/user-data/upload-id/evidence.png',
      textHtml: '',
      label: '',
    })
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.messageId, 123456)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('downloads a YouGile image marker to cache and returns it as an MCP image', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-yougile-download-'))
  const settingsPath = path.join(dir, 'settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify({ api_keys: { YOUGILE_API_KEY: 'test-secret' } }))
  const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex')
  let request = null
  const bridge = await loadYougileToolBridge({
    settingsPath,
    allowLegacy: false,
    downloadDir: path.join(dir, 'cache'),
    fetchImpl: async (url, options) => {
      request = { url: String(url), options }
      return new Response(imageBytes, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(imageBytes.length) },
      })
    },
  })

  try {
    const result = await bridge.call('yougile_download_file', {
      fileUrl: 'Комментарий\n/root/#file:/user-data/upload-id/evidence.png',
    })
    assert.equal(request.url, 'https://yougile.com/user-data/upload-id/evidence.png')
    assert.equal(request.options.headers.Authorization, 'Bearer test-secret')
    assert.deepEqual(result.content.map(item => item.type), ['text', 'resource_link', 'image'])
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.contentType, 'image/png')
    assert.equal(fs.readFileSync(payload.filePath).toString('hex'), imageBytes.toString('hex'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('decodes the extra transport layer in real YouGile attachment markers', () => {
  const resolved = resolveYougileFileUrl(
    '/root/#file:/user-data/upload-id/%25D1%2582%25D0%25B5%25D1%2581%25D1%2582.png%3Fpreviews%5B%5D%3D-256-preview',
  )
  assert.equal(resolved.pathname, '/user-data/upload-id/%D1%82%D0%B5%D1%81%D1%82.png')
  assert.equal(resolved.search, '?previews[]=-256-preview')
})
