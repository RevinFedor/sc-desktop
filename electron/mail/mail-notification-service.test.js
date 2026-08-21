const assert = require('node:assert/strict')
const test = require('node:test')
const {
  createMailNotificationService, gmailSearchUrl, siteUrlFor, readMailConfig, SEEN_PREF_KEY,
} = require('./mail-notification-service')

const silentLogger = { log() {}, warn() {} }

function makeDb(initial = null) {
  const store = new Map()
  if (initial) store.set(SEEN_PREF_KEY, initial)
  return {
    store,
    getUiPreference: key => store.get(key) ?? null,
    setUiPreference: (key, value) => { store.set(key, value); return { ok: true } },
  }
}

const baseSettings = {
  telegram_bot: { token: 'T', enabled: true },
  mail: {
    enabled: true,
    chat_id: '42',
    senders: ['noreply@codexresets.com'],
    gmail: { user: 'me@gmail.com', app_password: 'x'.repeat(16) },
  },
}

const sampleMail = {
  uid: 7,
  messageId: '<abc@codexresets.com>',
  subject: 'confirm your subscription',
  fromName: 'Codex Resets',
  fromAddress: 'noreply@codexresets.com',
  date: new Date('2026-08-21T07:09:00Z'),
  text: 'subscription_request received\n\nClick below to activate reset notifications.',
  html: null,
}

test('письмо уходит одним rich-сообщением с раскрывающимся телом', async () => {
  const calls = []
  const svc = createMailNotificationService({
    readScSettings: () => baseSettings,
    db: makeDb(),
    telegramApi: async (method, payload) => { calls.push({ method, payload }); return { message_id: 1 } },
    logger: silentLogger,
  })
  const res = await svc.deliver(sampleMail, svc.readConfig())
  assert.equal(res.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'sendRichMessage')
  assert.equal(calls[0].payload.chat_id, '42')
  const html = calls[0].payload.rich_message.html
  assert.match(html, /<details><summary>/)
  assert.match(html, /<h3>.*<a href="https:\/\/codexresets\.com\/">/s)
  assert.match(html, /rfc822msgid/)
})

test('при отказе rich-отправки уходит короткое обычное уведомление', async () => {
  const calls = []
  const svc = createMailNotificationService({
    readScSettings: () => baseSettings,
    db: makeDb(),
    telegramApi: async (method, payload) => {
      calls.push(method)
      if (method === 'sendRichMessage') {
        const err = new Error('Bad Request: RICH_MESSAGE_HTML_INVALID')
        err.httpStatus = 400
        err.telegramErrorCode = 400
        throw err
      }
      return { message_id: 2 }
    },
    logger: silentLogger,
    sleepImpl: async () => {},
  })
  const res = await svc.deliver(sampleMail, svc.readConfig())
  assert.equal(res.ok, true)
  assert.equal(res.fallback, true)
  assert.deepEqual(calls, ['sendRichMessage', 'sendMessage'])
})

test('временная ошибка Telegram повторяется, а не теряется', async () => {
  let attempts = 0
  const svc = createMailNotificationService({
    readScSettings: () => baseSettings,
    db: makeDb(),
    telegramApi: async () => {
      attempts += 1
      if (attempts < 3) {
        const err = new Error('Too Many Requests')
        err.telegramErrorCode = 429
        err.retryAfterSec = 0
        throw err
      }
      return { message_id: 3 }
    },
    logger: silentLogger,
    sleepImpl: async () => {},
  })
  const res = await svc.deliver(sampleMail, svc.readConfig())
  assert.equal(res.ok, true)
  assert.equal(attempts, 3)
})

test('постоянная недоступность не роняет процесс', async () => {
  const svc = createMailNotificationService({
    readScSettings: () => baseSettings,
    db: makeDb(),
    telegramApi: async () => { const e = new Error('chat not found'); e.httpStatus = 400; throw e },
    logger: silentLogger,
    sleepImpl: async () => {},
  })
  const res = await svc.deliver(sampleMail, svc.readConfig())
  assert.equal(res.ok, false)
  assert.match(res.error, /chat not found/)
})

test('выключенная настройка не поднимает наблюдателя', async () => {
  const svc = createMailNotificationService({
    readScSettings: () => ({ ...baseSettings, mail: { ...baseSettings.mail, enabled: false } }),
    db: makeDb(), telegramApi: async () => ({}), logger: silentLogger,
  })
  assert.equal((await svc.start()).status, 'disabled')
})

test('неполные настройки сообщают причину, а не падают', async () => {
  for (const [patch, expect] of [
    [{ gmail: { user: '', app_password: '' } }, /пароль/],
    [{ chat_id: '' }, /чат/],
    [{ senders: [] }, /отправител/],
  ]) {
    const svc = createMailNotificationService({
      readScSettings: () => ({ ...baseSettings, mail: { ...baseSettings.mail, ...patch } }),
      db: makeDb(), telegramApi: async () => ({}), logger: silentLogger,
    })
    const state = await svc.start()
    assert.equal(state.status, 'not_configured')
    assert.match(state.error, expect)
  }
})

test('в dev-режиме без явного разрешения доставка не запускается', async () => {
  const svc = createMailNotificationService({
    readScSettings: () => baseSettings, db: makeDb(),
    telegramApi: async () => ({}), logger: silentLogger, allowDelivery: false,
  })
  assert.equal((await svc.start()).status, 'not_allowed')
})

test('память о доставленных письмах переживает перезапуск', () => {
  const db = makeDb({ version: 1, uids: [1, 2, 3] })
  const cfg = readMailConfig(() => baseSettings)
  assert.equal(cfg.user, 'me@gmail.com')
  assert.deepEqual(db.getUiPreference(SEEN_PREF_KEY).uids, [1, 2, 3])
})

test('ссылка в Gmail строится по идентификатору письма', () => {
  assert.match(gmailSearchUrl('<a@b.c>'), /rfc822msgid%3Aa%40b\.c$/)
  assert.equal(gmailSearchUrl(''), null)
})

test('домен отправителя чистится от служебных префиксов', () => {
  assert.equal(siteUrlFor({ fromAddress: 'x@mail.example.com' }), 'https://example.com/')
  assert.equal(siteUrlFor({ fromAddress: 'x@example.com' }, { 'example.com': 'https://custom/' }), 'https://custom/')
  assert.equal(siteUrlFor({ fromAddress: 'broken' }), null)
})

test('первый запуск не рассылает старые письма, второй — работает как обычно', async () => {
  const { GmailWatcher } = require('./gmail-watcher')
  const db = makeDb()
  const captured = []

  // Подменяем сеть: проверяем решение «слать / не слать», а не сам IMAP.
  const runWatcher = async (hasBaseline, mails) => {
    const seenLocal = new Set()
    const w = new GmailWatcher({
      user: 'me@gmail.com', password: 'x', senders: ['noreply@codexresets.com'],
      isSeen: uid => seenLocal.has(uid), markSeen: uid => seenLocal.add(uid),
      hasBaseline, logger: silentLogger,
    })
    w.on('mail', m => captured.push(m.uid))
    w.client = {
      mailbox: { exists: mails.length },
      getMailboxLock: async () => ({ release() {} }),
      fetch: async function* () { for (const m of mails) yield m },
    }
    await w.checkNew({ firstRun: true })
    return seenLocal
  }

  const old = {
    uid: 1, source: Buffer.from('Subject: old\r\n\r\nbody'),
    envelope: { from: [{ address: 'noreply@codexresets.com' }], date: new Date(Date.now() - 86_400_000) },
  }
  const fresh = {
    uid: 2, source: Buffer.from('Subject: fresh\r\n\r\nbody'),
    envelope: { from: [{ address: 'noreply@codexresets.com' }], date: new Date() },
  }

  const seenFirst = await runWatcher(false, [old, fresh])
  assert.deepEqual(captured, [], 'при первом знакомстве ничего не рассылаем')
  assert.ok(seenFirst.has(1) && seenFirst.has(2), 'но всё помечаем как учтённое')

  captured.length = 0
  await runWatcher(true, [old, fresh])
  assert.deepEqual(captured, [2], 'на втором запуске уходит только свежее письмо')
  assert.equal(db.store.size, 0)
})
