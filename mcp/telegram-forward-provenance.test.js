'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const { telegramForwardProvenance } = require('./telegram-forward-provenance')
const { serializeTelegramItem, readTelegramCaptionSpan } = require('./telegram-rag-readers')

test('original channel post preserves the old valid channel key and takes precedence over a saved-copy pair', () => {
  const payload = {
    date: '2026-10-07T00:00:00Z',
    source: { id: 92001, kind: 'channel', name: 'Original channel', username: 'fixture_original' },
    from_peer: { id: 92001, kind: 'channel' }, from_name: null,
    channel_post: 50, post_author: 'original author',
    saved_from_peer: { id: 1033012338, kind: 'user' }, saved_from_message_id: 777,
    imported: false,
  }
  assert.deepEqual(telegramForwardProvenance(payload), { key: 'channel:92001:50', basis: 'channel_post' })
})

test('saved user forward through a channel uses that complete saved-dialog namespace, never the original user plus channel message id', () => {
  const payload = {
    date: '2026-10-07T00:00:00Z',
    source: { id: 11, kind: 'user', name: 'Original user', username: 'fixture_user' },
    from_peer: { id: 11, kind: 'user' }, from_name: null,
    channel_post: null, post_author: null,
    saved_from_peer: { id: 22, kind: 'channel' }, saved_from_message_id: 33,
    imported: false,
  }
  const result = telegramForwardProvenance(payload)
  assert.deepEqual(result, { key: 'channel:22:33', basis: 'saved_dialog_message' })
  assert.notEqual(result.key, 'user:11:33')
})

test('saved-copy pairs support known user/chat/channel namespaces and explicit decimal IDs', () => {
  for (const kind of ['user', 'chat', 'channel']) {
    assert.deepEqual(telegramForwardProvenance({ saved_from_peer: { kind, id: '123' }, saved_from_message_id: '456' }),
      { key: `${kind}:123:456`, basis: 'saved_dialog_message' })
  }
  assert.deepEqual(telegramForwardProvenance({ from_peer: { kind: 'channel', id: '9223372036854775807' }, channel_post: '2147483647' }),
    { key: 'channel:9223372036854775807:2147483647', basis: 'channel_post' })
})

test('partial pairs do not borrow peer or message id from the other pair or a display-only source', () => {
  const unknown = [
    null, [], false, 'forward', {},
    { from_peer: { kind: 'channel', id: 11 } },
    { channel_post: 33 },
    { source: { kind: 'channel', id: 11 }, channel_post: 33 },
    { from_peer: { kind: 'user', id: 11 }, saved_from_message_id: 33 },
    { from_peer: { kind: 'channel', id: 11 }, saved_from_message_id: 33 },
    { channel_post: 33, saved_from_peer: { kind: 'channel', id: 22 } },
    { from_peer: { kind: 'user', id: 11 }, channel_post: 33 },
    { from_peer: { kind: 'hidden', id: 11 }, channel_post: 33 },
  ]
  for (const payload of unknown) assert.deepEqual(telegramForwardProvenance(payload), { key: null, basis: null })
  assert.deepEqual(telegramForwardProvenance({ from_peer: { kind: 'channel', id: 11 }, saved_from_peer: { kind: 'channel', id: 22 }, saved_from_message_id: 33 }),
    { key: 'channel:22:33', basis: 'saved_dialog_message' })
})

test('invalid peer namespaces and inexact/out-of-range IDs remain unknown rather than producing misleading keys', () => {
  for (const kind of ['group', 'peer', 'hidden', 'Channel', null]) {
    assert.deepEqual(telegramForwardProvenance({ saved_from_peer: { kind, id: 11 }, saved_from_message_id: 33 }), { key: null, basis: null })
  }
  for (const id of [0, -1, 1.5, NaN, Infinity, true, '', '01', '-10011', '11.5', '9223372036854775808', Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(telegramForwardProvenance({ from_peer: { kind: 'channel', id }, channel_post: 33 }), { key: null, basis: null })
  }
  for (const messageId of [0, -1, 1.5, NaN, Infinity, true, '', '01', '1.5', '2147483648']) {
    assert.deepEqual(telegramForwardProvenance({ saved_from_peer: { kind: 'user', id: 11 }, saved_from_message_id: messageId }), { key: null, basis: null })
  }
})

test('helper does not mutate payload or describe a saved copy as an ultimate channel origin', () => {
  const input = { from_name: 'Hidden author', source: { kind: 'hidden', name: 'Hidden author' }, saved_from_peer: { kind: 'user', id: 123 }, saved_from_message_id: 456 }
  const before = JSON.stringify(input)
  const result = telegramForwardProvenance(input)
  assert.equal(JSON.stringify(input), before)
  assert.equal(result.basis, 'saved_dialog_message')
})

test('actual searchChat public formatter keeps the correct forward pair and reports its basis', async () => {
  // Extract the real public function only. Inject its collaborators, so this
  // regression invokes no provider, database, Telegram, MCP hub or app process.
  const sourceCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')
  const begin = sourceCode.indexOf('async function searchChat(args) {')
  const end = sourceCode.indexOf('\nfunction neighbors(', begin)
  assert.ok(begin >= 0 && end > begin, 'searchChat extraction matches the current public formatter')
  const forward = { from_peer: { kind: 'user', id: 11 }, channel_post: null,
    saved_from_peer: { kind: 'channel', id: 22 }, saved_from_message_id: 33 }
  const row = { id: 7, source_id: 1, external_id: '100', type: 'text', caption: 'forwarded fixture',
    published_at: 1, sender: 'forwarding sender', raw_meta_json: JSON.stringify({ forward }),
    _cos: 0.8, _index_mode: 'legacy_context', _freshness: 'unknown_legacy', _matched_chunks: [] }
  const query = new Float32Array(768); query[0] = 1
  const context = {
    Buffer, crypto, telegramForwardProvenance, serializeTelegramItem, readTelegramCaptionSpan,
    db: { getDb: () => ({}) },
    annotateSemanticContextRefs: () => [],
    normalizeRagScope: args => ({ source_id: args.source_id, limit: 10, min_cos: 0.55 }),
    embedQuery: async () => query,
    searchTelegramRag: () => ({ rows: [row], source: { id: 1, platform: 'telegram', handle: '-100444', external_id: '444', meta_json: '{"kind":"group"}' },
      coverage: {}, diagnostics: {}, chronology: { first_item_at: 1, last_item_at: 1 } }),
  }
  const search = vm.runInNewContext(`${sourceCode.slice(begin, end)}\nsearchChat`, context)
  const result = await search({ source_id: 1, query: 'fixture' })
  assert.equal(result.results[0].forward_origin_key, 'channel:22:33')
  assert.equal(result.results[0].forward_origin_basis, 'saved_dialog_message')
})
