'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
process.env.SC_DESKTOP_DB = ':memory:'
const db = require('./database')
const rag = require('./telegram-rag-index')
test.after(() => db.close())

test('backfill merges peer metadata without losing forwarded/media metadata and retains explicit null', () => {
  const source = db.upsertSource({ platform: 'telegram', handle: 'peer-persistence', external_id: '111', meta: { kind: 'channel' } })
  db.bulkUpsertItems([{ source_id: source, external_id: '3', caption: 'reply', type: 'text',
    parent_external_id: '99', reply_resolved: 1,
    raw_meta: { forward: { from_name: 'original' }, media: [{ kind: 'photo' }], unrelated: 'keep' } }])
  const packet = { version: 1, source_peer: { kind: 'channel', id: 111 },
    target_peer: { kind: 'channel', id: 222 }, message_id: 99, scope: 'external_peer' }
  db.bulkUpdateParentExternalId(source, [{ external_id: '3', parent_external_id: null,
    raw_meta_patch: { telegram_reply: packet, external_reply: { peer: packet.target_peer, message_id: 99 } } }])
  let row = db.getDb().prepare('SELECT * FROM items WHERE source_id=? AND external_id=?').get(source, '3')
  let raw = JSON.parse(row.raw_meta_json)
  assert.equal(row.parent_external_id, null)
  assert.deepEqual(raw.forward, { from_name: 'original' })
  assert.deepEqual(raw.media, [{ kind: 'photo' }])
  assert.equal(raw.unrelated, 'keep')
  assert.deepEqual(raw.telegram_reply, packet)
  assert.equal(db.telegramRagItemContentHash(row), rag.itemContentHash(row))
  db.bulkUpdateParentExternalId(source, [{ external_id: '3', parent_external_id: null,
    raw_meta_patch: { telegram_reply: { ...packet, scope: 'none', message_id: null, target_peer: packet.source_peer }, external_reply: null } }])
  row = db.getDb().prepare('SELECT * FROM items WHERE source_id=? AND external_id=?').get(source, '3')
  raw = JSON.parse(row.raw_meta_json)
  assert.equal(Object.hasOwn(raw, 'external_reply'), true)
  assert.equal(raw.external_reply, null)
  assert.equal(db.telegramRagItemContentHash(row), rag.itemContentHash(row))
})

test('provenance-only patch invalidates an active generation and absent legacy keys remain hash-compatible', () => {
  const source = db.upsertSource({ platform: 'telegram', handle: 'peer-revision', external_id: '333', meta: { kind: 'channel' } })
  db.bulkUpsertItems([{ source_id: source, external_id: '1', type: 'text', caption: 'own original', published_at: 100, reply_resolved: 1 }])
  const row = db.getDb().prepare('SELECT * FROM items WHERE source_id=?').get(source)
  assert.equal(db.telegramRagItemContentHash(row), rag.itemContentHash(row))
  const document = rag.buildCurrentTelegramDocument(db, row.id)
  const staged = db.stageTelegramRagGeneration({ itemId: row.id, sourceId: source,
    documentHash: document.documentHash, indexVersion: rag.INDEX_VERSION,
    targetRevision: document.targetReference.local_revision, targetContentHash: document.targetReference.content_hash,
    sourceRevision: db.getTelegramRagSourceRevision(source), contextRefs: document.contextRefs, chunks: document.chunks })
  const vector = new Float32Array(768); vector[0] = 1
  db.saveTelegramRagGenerationVectors(staged.generationId, document.chunks.map(chunk => ({ chunk_index: chunk.chunk_index, embedding: vector })))
  assert.equal(db.publishTelegramRagGeneration(staged.generationId).published, true)
  assert.equal(db.telegramRagIndexStatus(source).messages_complete, 1)
  db.bulkUpdateParentExternalId(source, [{ external_id: '1', parent_external_id: null,
    raw_meta_patch: { telegram_reply: { version: 1, source_peer: { kind: 'channel', id: 333 },
      target_peer: { kind: 'channel', id: 444 }, message_id: 99, scope: 'external_peer' },
      external_reply: { peer: { kind: 'channel', id: 444 }, message_id: 99, quote_text: 'quoted, not own' } } }])
  const current = db.getDb().prepare('SELECT * FROM items WHERE id=?').get(row.id)
  assert.equal(db.telegramRagItemContentHash(current), rag.itemContentHash(current))
  const state = db.getDb().prepare('SELECT * FROM telegram_rag_item_state WHERE item_id=?').get(row.id)
  assert.equal(state.stale, 1)
  assert.ok(state.local_revision > document.targetReference.local_revision)
  assert.equal(db.telegramRagIndexStatus(source).messages_complete, 0)
  assert.equal(db.publishTelegramRagGeneration(staged.generationId).published, false)
})
