const test = require('node:test')
const assert = require('node:assert/strict')

const {
  telegramStableTarget,
  telegramSourceHealth,
  isTelegramSourceUnavailable,
} = require('./telegram-source-state')

function source(kind, external_id, handle = 'old_name') {
  return {
    platform: 'telegram',
    external_id,
    handle,
    meta_json: JSON.stringify({ kind }),
  }
}

test('uses marked stable ids for every Telegram peer kind', () => {
  assert.equal(telegramStableTarget(source('channel', '2383492108')), '-1002383492108')
  assert.equal(telegramStableTarget(source('group', '1538637370')), '-1001538637370')
  assert.equal(telegramStableTarget(source('chat', '12345')), '-12345')
  assert.equal(telegramStableTarget(source('user', '67890')), '67890')
})

test('does not guess a numeric peer type when metadata is incomplete', () => {
  assert.equal(telegramStableTarget(source('', '12345', 'old_name')), null)
  assert.equal(telegramStableTarget(source('', '12345', '-10012345')), '-10012345')
  assert.equal(telegramStableTarget({ platform: 'youtube', external_id: '123' }), null)
})

test('reads the persistent unavailable health marker from source metadata', () => {
  const row = {
    meta_json: JSON.stringify({
      kind: 'channel',
      tg_health: { status: 'unavailable', code: 'telegram_source_unavailable' },
    }),
  }
  assert.equal(isTelegramSourceUnavailable(row), true)
  assert.equal(telegramSourceHealth(row).code, 'telegram_source_unavailable')
  assert.equal(isTelegramSourceUnavailable({ meta_json: '{bad json' }), false)
})
