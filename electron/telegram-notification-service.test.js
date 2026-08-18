const assert = require('node:assert/strict')
const test = require('node:test')

const {
  NOTIFICATION_DEDUPE_PREF_KEY,
  createTelegramNotificationService,
} = require('./telegram-notification-service')

const TOKEN = 'test-token'

function event(overrides = {}) {
  return {
    eventId: 'tab-1:123456789',
    tabName: 'Codex',
    ...overrides,
  }
}

function telegramResponse(messageId = 101) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, result: { message_id: messageId } }
    },
  }
}

function telegramError(status, description, parameters) {
  return {
    ok: false,
    status,
    async json() {
      return {
        ok: false,
        error_code: status,
        description,
        parameters,
      }
    },
  }
}

function fakeDb(storage = new Map()) {
  return {
    storage,
    getUiPreference(key) {
      return storage.get(key) ?? null
    },
    setUiPreference(key, value) {
      storage.set(key, structuredClone(value))
      return { ok: true }
    },
  }
}

function service({
  settings = {
    telegram_bot: {
      enabled: true,
      token: TOKEN,
      allowed_chat_ids: ['42'],
    },
  },
  db = fakeDb(),
  fetchImpl = async () => telegramResponse(),
  sleepImpl = async () => {},
  now = () => 1_000_000,
  allowTerminalNotifications = true,
} = {}) {
  return createTelegramNotificationService({
    readScSettings: () => settings,
    db,
    fetchImpl,
    sleepImpl,
    now,
    allowTerminalNotifications,
    env: {},
  })
}

test('sends a terminal completion to the sole allowed chat', async () => {
  const requests = []
  const result = await service({
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return telegramResponse(625)
    },
  }).notifyTerminalCompletion(event({ tabName: '  Main   Codex  ' }))

  assert.deepEqual(result, {
    ok: true,
    eventId: 'tab-1:123456789',
    deliveries: [{ message_id: 625 }],
    duplicate: false,
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`)
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    chat_id: '42',
    text: '🔔 Вкладка завершилась\nMain Codex',
    disable_web_page_preview: true,
  })
})

test('coalesces concurrent delivery of the same event', async () => {
  let resolveFetch
  let calls = 0
  const notificationService = service({
    fetchImpl: async () => {
      calls += 1
      return new Promise(resolve => { resolveFetch = resolve })
    },
  })

  const first = notificationService.notifyTerminalCompletion(event())
  const duplicate = notificationService.notifyTerminalCompletion(event())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  resolveFetch(telegramResponse(626))

  assert.equal((await first).duplicate, false)
  assert.equal((await duplicate).duplicate, true)
  assert.equal(calls, 1)
})

test('restores settled dedupe state after service recreation', async () => {
  const db = fakeDb()
  await service({ db }).notifyTerminalCompletion(event())
  assert.equal(db.storage.has(NOTIFICATION_DEDUPE_PREF_KEY), true)

  let calls = 0
  const restored = service({
    db,
    fetchImpl: async () => {
      calls += 1
      return telegramResponse()
    },
  })
  const result = await restored.notifyTerminalCompletion(event())

  assert.equal(result.duplicate, true)
  assert.equal(calls, 0)
})

test('retries a transient Telegram response and respects retry_after', async () => {
  let calls = 0
  const delays = []
  const notificationService = service({
    fetchImpl: async () => {
      calls += 1
      return calls === 1
        ? telegramError(429, 'Too Many Requests', { retry_after: 2 })
        : telegramResponse(627)
    },
    sleepImpl: async delay => { delays.push(delay) },
  })

  const result = await notificationService.notifyTerminalCompletion(event())
  assert.equal(result.deliveries[0].message_id, 627)
  assert.equal(calls, 2)
  assert.deepEqual(delays, [2_000])
})

test('releases a failed event so the durable client may retry it', async () => {
  let calls = 0
  const notificationService = service({
    fetchImpl: async () => {
      calls += 1
      return calls === 1
        ? telegramError(400, 'Bad Request')
        : telegramResponse(628)
    },
  })

  await assert.rejects(
    notificationService.notifyTerminalCompletion(event()),
    /Bad Request/,
  )
  const retried = await notificationService.notifyTerminalCompletion(event())
  assert.equal(retried.duplicate, false)
  assert.equal(retried.deliveries[0].message_id, 628)
  assert.equal(calls, 2)
})

test('reports configuration and runtime failures with stable codes', async () => {
  await assert.rejects(
    service({
      settings: { telegram_bot: { enabled: true, allowed_chat_ids: ['42'] } },
    }).notifyTerminalCompletion(event()),
    err => err.code === 'telegram_bot_not_configured',
  )
  await assert.rejects(
    service({
      settings: {
        telegram_bot: { enabled: false, token: TOKEN, allowed_chat_ids: ['42'] },
      },
    }).notifyTerminalCompletion(event()),
    err => err.code === 'telegram_bot_disabled',
  )
  await assert.rejects(
    service({
      settings: {
        telegram_bot: {
          enabled: true,
          token: TOKEN,
          allowed_chat_ids: ['1', '2'],
        },
      },
    }).notifyTerminalCompletion(event()),
    err => err.code === 'telegram_notification_chat_not_configured',
  )
  await assert.rejects(
    service({ allowTerminalNotifications: false }).notifyTerminalCompletion(event()),
    err => err.code === 'telegram_notifications_not_allowed',
  )
})
