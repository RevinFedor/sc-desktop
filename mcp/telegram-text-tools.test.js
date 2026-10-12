const test = require('node:test')
const assert = require('node:assert/strict')
const { telegramTextTools, normalizeTelegramTextArgs, callTelegramTextTool } = require('./telegram-text-tools')
const valid = { request_id: 'fixture-1', session: 'session_fixture', target: '@fixture', expected_account_id: '100', expected_peer_id: '200', text: 'коротко https://Example.org/AbC ID_X «Quote»', confirm: true }

test('schema keeps one text, one peer and explicit verified identities', () => {
  const send = telegramTextTools.find(t => t.name === 'telegram_send_text')
  assert.equal(send.inputSchema.additionalProperties, false)
  assert.deepEqual(send.inputSchema.required, Object.keys(valid))
  assert.equal(send.inputSchema.properties.confirm.const, true)
  assert.equal(send.inputSchema.properties.text.maxLength, 4096)
  assert.equal(send.annotations.idempotentHint, true)
  assert.match(send.description, /lowercase/)
  assert.match(send.description, /quoted text/)
})

test('public handler passes exact text and returns verified delivery, not generic success', async () => {
  let seen
  const out = await callTelegramTextTool('telegram_send_text', valid, async request => {
    seen = request
    return { ok: true, delivered: true, state: 'delivered', message_id: 123, verified_at: 1 }
  })
  assert.equal(seen.text, valid.text)
  assert.equal(seen.operation, 'send')
  assert.equal(JSON.parse(out.content[0].text).message_id, 123)
})

test('unknown outcome is an error and cannot be presented as delivery', async () => {
  const out = await callTelegramTextTool('telegram_send_text', valid, async () => ({ ok: false, delivered: false, state: 'unknown', request_id: valid.request_id }))
  assert.equal(out.isError, true)
  assert.equal(JSON.parse(out.content[0].text).delivered, false)
})

test('long text, recipient arrays, missing identities and extra actions never reach runner', async () => {
  let calls = 0
  const run = async () => { calls++; return {} }
  const bad = [
    { ...valid, text: 'x'.repeat(4097) }, { ...valid, target: ['@a', '@b'] },
    { ...valid, confirm: false }, { ...valid, expected_peer_id: undefined },
    { ...valid, expected_account_id: NaN }, { ...valid, files: ['/tmp/a'] },
    { ...valid, request_id: '' }, { ...valid, session: '../other' },
    { ...valid, schedule_date: 1 }, { ...valid, targets: ['@a', '@b'] },
  ]
  for (const args of bad) await assert.rejects(callTelegramTextTool('telegram_send_text', args, run))
  assert.equal(calls, 0)
})

test('status accepts only original request id and never a message body', () => {
  assert.deepEqual(normalizeTelegramTextArgs('telegram_send_text_status', { request_id: 'old-1' }), { request_id: 'old-1', operation: 'status' })
  assert.throws(() => normalizeTelegramTextArgs('telegram_send_text_status', { request_id: 'old-1', text: 'resend' }))
})

test('reply context reaches runner unchanged and invalid coordinates never dispatch', async () => {
  const reply = { ...valid, reply_to_message_id: 646, topic_id: 403 }
  const normalized = normalizeTelegramTextArgs('telegram_send_text', reply)
  assert.equal(normalized.reply_to_message_id, 646)
  assert.equal(normalized.topic_id, 403)
  let calls = 0
  for (const mutation of [{ reply_to_message_id: 0 }, { topic_id: true }, { reply_to_message_id: '646' },
    { reply_to_message_id: 2147483648 }, { reply_to_message_id: undefined, topic_id: 403 }]) {
    await assert.rejects(callTelegramTextTool('telegram_send_text', { ...reply, ...mutation }, async () => { calls++ }))
  }
  assert.equal(calls, 0)
  assert.deepEqual(normalizeTelegramTextArgs('telegram_send_text', valid), { ...valid, operation: 'send' })
})
