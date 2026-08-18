const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')

const {
  TERMINAL_NOTIFICATION_BODY_LIMIT,
  createTerminalNotificationRoute,
} = require('./terminal-notification-route')

const TOKEN = 'a'.repeat(64)

function completionEvent(overrides = {}) {
  return {
    kind: 'terminal-completion',
    eventId: 'tab-1:123456789',
    projectId: 'project-1',
    tabId: 'tab-1',
    tabName: '  Main   Codex  ',
    firedAt: 123456789,
    mode: 'persistent',
    unread: true,
    ...overrides,
  }
}

async function withRoute(notificationService, run, routeOptions = {}) {
  const logger = { log() {}, warn() {} }
  const route = createTerminalNotificationRoute({
    notificationService,
    ensureToken: () => ({ token: TOKEN, tokenPath: '<test>' }),
    logger,
    ...routeOptions,
  })
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (await route.handle(req, res, url)) return
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"not found"}')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function post(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/notifications/terminal-completion`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('authenticates, normalizes, and delivers a completion event', async () => {
  let received
  await withRoute({
    async notifyTerminalCompletion(event) {
      received = event
      return { deliveries: [{ message_id: 625 }], duplicate: false }
    },
  }, async baseUrl => {
    const response = await post(baseUrl, completionEvent())
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ok: true,
      eventId: 'tab-1:123456789',
      duplicate: false,
      deliveries: [{ message_id: 625 }],
    })
  })
  assert.equal(received.tabName, 'Main Codex')
})

test('rejects missing credentials and every browser Origin', async () => {
  const service = { async notifyTerminalCompletion() { throw new Error('not reached') } }
  await withRoute(service, async baseUrl => {
    const unauthorized = await fetch(
      `${baseUrl}/notifications/terminal-completion`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(completionEvent()),
      },
    )
    assert.equal(unauthorized.status, 401)

    const browser = await post(baseUrl, completionEvent(), {
      Origin: 'https://example.com',
    })
    assert.equal(browser.status, 403)
  })
})

test('rejects malformed envelopes before delivery', async () => {
  let calls = 0
  await withRoute({
    async notifyTerminalCompletion() {
      calls += 1
      return {}
    },
  }, async baseUrl => {
    const response = await post(
      baseUrl,
      completionEvent({ eventId: 'wrong-id' }),
    )
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /tabId:firedAt/)
  })
  assert.equal(calls, 0)
})

test('returns 413 for a body over the notification limit', async () => {
  await withRoute({
    async notifyTerminalCompletion() { return {} },
  }, async baseUrl => {
    const response = await post(
      baseUrl,
      JSON.stringify({ payload: 'x'.repeat(TERMINAL_NOTIFICATION_BODY_LIMIT + 1) }),
    )
    assert.equal(response.status, 413)
  })
})

test('maps configuration failures to 503 and delivery failures to 502', async () => {
  const configurationError = new Error('not configured')
  configurationError.code = 'telegram_bot_not_configured'
  await withRoute({
    async notifyTerminalCompletion() { throw configurationError },
  }, async baseUrl => {
    assert.equal((await post(baseUrl, completionEvent())).status, 503)
  })

  await withRoute({
    async notifyTerminalCompletion() { throw new Error('Telegram unavailable') },
  }, async baseUrl => {
    assert.equal((await post(baseUrl, completionEvent())).status, 502)
  })
})

test('rate limits authenticated attempts without calling Telegram again', async () => {
  let calls = 0
  await withRoute({
    async notifyTerminalCompletion() {
      calls += 1
      return {}
    },
  }, async baseUrl => {
    const first = await post(baseUrl, completionEvent())
    const second = await post(baseUrl, completionEvent())
    assert.equal(first.status, 200)
    assert.equal(second.status, 429)
    assert.equal(second.headers.get('retry-after'), '60')
  }, { rateLimit: 1 })
  assert.equal(calls, 1)
})
