const test = require('node:test')
const assert = require('node:assert/strict')
const { telegramSendSavedMessageTool, normalizeSavedMessageInput } = require('./telegram-saved-message')

test('Saved Messages schema exposes an explicit album mode without an arbitrary recipient', () => {
  const schema = telegramSendSavedMessageTool.inputSchema
  assert.deepEqual(schema.properties.album.required, ['paths', 'mode'])
  assert.deepEqual(schema.properties.album.properties.mode.enum, ['photo', 'document'])
  assert.equal(schema.properties.album.properties.paths.maxItems, 50)
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.target, undefined)
  assert.equal(telegramSendSavedMessageTool.annotations.idempotentHint, false)
})

test('album paths and caption retain their exact order and plain text', () => {
  const album = { mode: 'document', paths: ['/tmp/b.png', '/tmp/a.png'], caption: '  Пример\n🛰 **plain**\n' }
  assert.deepEqual(normalizeSavedMessageInput({ album }).album, album)
  assert.equal(normalizeSavedMessageInput({ album }).text, '')
})

test('invalid mode, ambiguous attachment lists and wrong recipients are rejected', () => {
  const paths = ['/a.png', '/b.png']
  for (const args of [
    { album: { paths } }, { album: { paths, mode: 'auto' } },
    { album: { paths: ['/a.png'], mode: 'document' } },
    { album: { paths: Array(51).fill('/a.png'), mode: 'document' } },
    { album: { paths, mode: 'document' }, files: ['/c.png'] },
    { album: { paths, mode: 'photo', caption: 12 } },
    { text: 'hello', target: '@somebody' },
  ]) assert.throws(() => normalizeSavedMessageInput(args))
})

test('legacy arguments stay separate and Unicode text counts codepoints', () => {
  const input = normalizeSavedMessageInput({ text: 'legacy', images: ['/a.png'], files: ['/b.pdf'], silent: true })
  assert.deepEqual(input, { text: 'legacy', images: ['/a.png'], files: ['/b.pdf'], album: null, silent: true })
  assert.equal(normalizeSavedMessageInput({ text: '🛰'.repeat(4096) }).text, '🛰'.repeat(4096))
  assert.throws(() => normalizeSavedMessageInput({ text: '🛰'.repeat(4097) }), /4096/)
})
