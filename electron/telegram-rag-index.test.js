'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

// Synthetic in-memory fixtures only; production native SQLite + sqlite-vec.
process.env.SC_DESKTOP_DB = ':memory:'
const db = require('./database')
const {
  INDEX_VERSION, MAX_EMBEDDING_BYTES, TARGET_BYTES,
  splitCaption, buildTelegramDocument, prepareTelegramIndex,
  itemContentHash,
  telegramIndexPage, publishReadyTelegramGenerations, saveTelegramIndexBatch,
  telegramFragmentIndexStatus,
} = require('./telegram-rag-index')

test.after(() => db.close())

function source(handle) {
  return db.upsertSource({
    platform: 'telegram', handle, external_id: handle,
    display_name: handle, tg_session: 'fixture', is_explicit: true,
  })
}

function item(sourceId, externalId, fields = {}) {
  const parent = fields.parent_external_id == null ? null : String(fields.parent_external_id)
  const metadata = { telegram_reply: {
    version: 1, source_peer: null, target_peer: null, message_id: parent,
    scope: parent ? (parent === String(fields.topic_id) ? 'topic_anchor' : 'same_peer') : 'none',
  }, external_reply: null }
  return db.upsertItem({
    source_id: sourceId, external_id: String(externalId),
    type: 'text', caption: `fixture ${externalId}`, published_at: Number(externalId),
    raw_meta: metadata,
    ...fields,
  })
}

function fixtureEmbedding(text, needle = 'tail-only-needle') {
  const vector = new Float32Array(db.EMBEDDING_DIM)
  vector[text.includes(needle) ? 0 : 1] = 1
  return vector
}

function embedPending(sourceId, needle) {
  let after = 0
  let written = 0
  publishReadyTelegramGenerations(db)
  while (true) {
    const rows = telegramIndexPage(db, after, 100)
    if (!rows.length) break
    saveTelegramIndexBatch(db, rows, rows.map(row => fixtureEmbedding(row.embedding_text, needle)))
    after = rows.at(-1).seq
    written += rows.length
  }
  return written
}

function chunks(itemId) {
  return db.getDb().prepare('SELECT * FROM semantic_chunks WHERE item_id = ? ORDER BY chunk_index').all(itemId)
}

test('Unicode fragments cover the whole original caption including the tail, with exact offsets', () => {
  const text = `${'заявка 👩‍💻 🇹🇭 e\u0301\n'.repeat(170)}tail-only-needle`
  const fragments = splitCaption(text)
  assert.ok(fragments.length > 3)
  assert.equal(fragments[0].start_char, 0)
  assert.equal(fragments.at(-1).end_char, text.length)
  const boundaries = new Set(Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text), part => part.index))
  boundaries.add(text.length)
  fragments.forEach((fragment, index) => {
    assert.equal(fragment.text, text.slice(fragment.start_char, fragment.end_char))
    assert.ok(boundaries.has(fragment.start_char))
    assert.ok(boundaries.has(fragment.end_char))
    assert.ok(Buffer.byteLength(fragment.text, 'utf8') <= TARGET_BYTES)
    if (index) {
      assert.ok(fragment.start_char > fragments[index - 1].start_char)
      assert.ok(fragment.start_char <= fragments[index - 1].end_char)
    }
  })
  assert.match(fragments.at(-1).text, /tail-only-needle/)
})

test('full long-caption tail is searchable in real SQLite while legacy prefix vectors are preserved', () => {
  const sourceId = source('rag-chunk-tail')
  const caption = `${'head unrelated words '.repeat(400)}tail-only-needle B2B recommendation`
  const targetId = item(sourceId, 1, { caption })
  db.bulkUpsertVectors([{ item_id: targetId, embedding: fixtureEmbedding(caption.slice(0, 1500)) }])
  const plan = prepareTelegramIndex(db, sourceId, 1)
  assert.equal(plan.messagesSelected, 1)
  assert.ok(plan.fragmentsPending > 2)
  assert.equal(embedPending(sourceId), plan.fragmentsPending)
  const query = fixtureEmbedding('tail-only-needle')
  const hits = db.semanticChunkSearch({ query_embedding: query, source_id: sourceId, limit: 1 })
  assert.equal(hits[0].item_id, targetId)
  assert.match(hits[0].text, /tail-only-needle/)
  assert.ok(hits[0].start_char > 1500)
  assert.ok(hits[0]._cos > 0.999)
  assert.equal(db.vectorCountForSource(sourceId), 1)
  const status = telegramFragmentIndexStatus(db, sourceId)
  assert.equal(status.unit, 'messages')
  assert.equal(status.messages_complete, 1)
  assert.equal(status.messages_total, 1)
  assert.equal(status.done, status.total)
  assert.equal(status.legacy_only_messages, 0)
})

test('same-source delayed reply is included; other topics, foreign parents and topic anchors are excluded', () => {
  const sourceId = source('rag-chunk-topic')
  const foreign = source('rag-chunk-topic-foreign')
  item(foreign, 1, { caption: 'foreign wrong parent', topic_id: 10 })
  item(sourceId, 1, { caption: 'delayed real reply parent', topic_id: 10, published_at: 100 })
  item(sourceId, 10, { caption: 'Topic created', type: 'other', topic_id: 10, published_at: 90 })
  item(sourceId, 30, { caption: 'different topic contamination', topic_id: 20, published_at: 200_001 })
  item(sourceId, 31, { caption: 'same topic before', topic_id: 10, published_at: 200_001 })
  const replyId = item(sourceId, 32, {
    caption: 'short answer', parent_external_id: '1', topic_id: 10, published_at: 200_002,
  })
  prepareTelegramIndex(db, sourceId, 1)
  const text = telegramIndexPage(db, 0)[0].embedding_text
  assert.match(text, /^message #32:\nshort answer/)
  assert.match(text, /reply #1: delayed real reply parent/)
  assert.match(text, /prior #31: same topic before/)
  assert.doesNotMatch(text, /different topic contamination|foreign wrong parent|Topic created/)
  embedPending(sourceId)
  assert.equal(chunks(replyId)[0].text, 'short answer')

  item(sourceId, 33, { caption: 'not a reply to the topic author', parent_external_id: '10', topic_id: 10, published_at: 200_003 })
  prepareTelegramIndex(db, sourceId, 1)
  assert.doesNotMatch(telegramIndexPage(db, 0)[0].embedding_text, /reply #10:|Topic created/)

  item(sourceId, 34, { caption: 'parent absent in this source', parent_external_id: '888', topic_id: 10, published_at: 200_004 })
  item(foreign, 888, { caption: 'foreign missing-parent match', published_at: 100 })
  prepareTelegramIndex(db, sourceId, 1)
  assert.doesNotMatch(telegramIndexPage(db, 0)[0].embedding_text, /foreign missing-parent match/)
})

test('equal timestamps use Telegram message ids, not insertion order; General null/0 share context', () => {
  const sourceId = source('rag-chunk-equal-time')
  item(sourceId, 30, { caption: 'future telegram id', published_at: 1000, topic_id: 0 })
  const targetId = item(sourceId, 20, { caption: 'target id twenty', published_at: 1000, topic_id: null })
  item(sourceId, 10, { caption: 'earlier telegram id', published_at: 1000, topic_id: 0 })
  prepareTelegramIndex(db, sourceId, 2)
  const pending = telegramIndexPage(db, 0)
  const target = pending.find(row => row.item_id === targetId)
  assert.match(target.embedding_text, /prior #10: earlier telegram id/)
  assert.doesNotMatch(target.embedding_text, /future telegram id/)
  assert.deepEqual(pending.map(row => row.item_id), [
    db.getDb().prepare('SELECT id FROM items WHERE source_id = ? AND external_id = ?').get(sourceId, '30').id,
    targetId,
  ])
})

test('unchanged resume reuses chunk ids/vectors, while edits and late transcriptions invalidate them', () => {
  const sourceId = source('rag-chunk-invalidation')
  const parentId = item(sourceId, 1, { caption: 'actual original parent', published_at: 1 })
  const targetId = item(sourceId, 2, { caption: 'original caption', parent_external_id: '1', published_at: 200_000 })
  const original = prepareTelegramIndex(db, sourceId, 1)
  assert.equal(original.changedMessages, 1)
  embedPending(sourceId)
  const before = chunks(targetId)
  const resume = prepareTelegramIndex(db, sourceId, 1)
  assert.equal(resume.changedMessages, 0)
  assert.equal(resume.fragmentsPending, 0)
  assert.deepEqual(chunks(targetId), before)

  item(sourceId, 2, { caption: 'original caption\nlate transcription tail-only-needle', parent_external_id: '1', published_at: 200_000 })
  const edit = prepareTelegramIndex(db, sourceId, 1)
  assert.equal(edit.changedMessages, 1)
  assert.ok(edit.fragmentsPending > 0)
  assert.equal(chunks(targetId)[0].document_hash, before[0].document_hash, 'staging must preserve the active generation')
  embedPending(sourceId)
  assert.notEqual(chunks(targetId)[0].document_hash, before[0].document_hash)
  assert.notEqual(chunks(targetId)[0].id, before[0].id)
  const afterEdit = chunks(targetId)[0].document_hash

  item(sourceId, 1, { caption: 'corrected actual parent', published_at: 1 })
  const parentEdit = prepareTelegramIndex(db, sourceId, 1)
  assert.equal(parentEdit.changedMessages, 1)
  assert.equal(chunks(targetId)[0].document_hash, afterEdit, 'parent edit stages replacement without destroying previous fragments')
  embedPending(sourceId)
  assert.notEqual(chunks(targetId)[0].document_hash, afterEdit)
  assert.equal(chunks(parentId).length, 0, 'limit=1 must not index older parents as new target messages')

  db.getDb().prepare('UPDATE items SET caption = ? WHERE id = ?').run('', targetId)
  const empty = prepareTelegramIndex(db, sourceId, 1)
  assert.equal(empty.fragmentsSelected, 0)
  embedPending(sourceId)
  assert.equal(chunks(targetId).length, 0)
})

test('fingerprint tracks model/topic/context; source snapshots and cyclic/missing parents are bounded', () => {
  const row = { id: 9, source_id: 1, external_id: '9', caption: 'target', topic_id: 2, parent_external_id: '4', raw_meta_json: JSON.stringify({ telegram_reply: { version: 1, scope: 'same_peer', source_peer: null, target_peer: null, message_id: 4 } }) }
  const parent = { id: 4, source_id: 1, external_id: '4', caption: 'actual parent', topic_id: 2 }
  const a = buildTelegramDocument(row, { ancestors: [parent] }, { model: 'model-a' })
  assert.equal(a.documentHash, buildTelegramDocument(row, { ancestors: [parent] }, { model: 'model-a' }).documentHash)
  assert.notEqual(a.documentHash, buildTelegramDocument(row, { ancestors: [parent] }, { model: 'model-b' }).documentHash)
  assert.notEqual(a.documentHash, buildTelegramDocument({ ...row, topic_id: 3 }, { ancestors: [parent] }, { model: 'model-a' }).documentHash)
  for (const text of a.embeddingTexts) assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_EMBEDDING_BYTES)
  const sourceId = source('rag-chunk-cycle')
  item(sourceId, 1, { parent_external_id: '2', caption: 'cycle one', published_at: 1 })
  item(sourceId, 2, { parent_external_id: '1', caption: 'cycle two', published_at: 2 })
  assert.doesNotThrow(() => prepareTelegramIndex(db, sourceId, null))
  const text = telegramIndexPage(db, 0)[0].embedding_text
  assert.equal((text.match(/reply #1:/g) || []).length, 1)
  assert.equal((text.match(/reply #2:/g) || []).length, 0)

  const oldSnapshot = telegramIndexPage(db, 0).map(part => part.embedding_text)
  item(sourceId, 2, { caption: 'changed after preparation', parent_external_id: '1', published_at: 2 })
  assert.deepEqual(telegramIndexPage(db, 0).map(part => part.embedding_text), oldSnapshot)
})

test('known cross-peer collision never expands locally; legacy bounded candidate context remains byte-compatible', () => {
  const sourceId = source('rag-cross-peer-collision')
  item(sourceId, 99, { caption: 'unrelated local question #99', published_at: 1 })
  const external = {
    telegram_reply: { version: 1, source_peer: { kind: 'channel', id: 111 }, target_peer: { kind: 'channel', id: 222 }, message_id: 99, scope: 'external_peer' },
    external_reply: { peer: { kind: 'channel', id: 222 }, message_id: 99, quote_text: 'original external quote' },
  }
  const targetId = item(sourceId, 100, { caption: 'cross-peer quote reply', parent_external_id: '99', published_at: 200000, raw_meta: external })
  prepareTelegramIndex(db, sourceId, 1)
  const cross = telegramIndexPage(db, 0)[0]
  assert.equal(cross.item_id, targetId)
  assert.doesNotMatch(cross.embedding_text, /reply #99:|unrelated local question/)
  const generation = db.getDb().prepare('SELECT context_refs_json FROM telegram_rag_generations WHERE generation_id = ?').get(cross.generation_id)
  assert.deepEqual(JSON.parse(generation.context_refs_json), [])
  embedPending(sourceId)
  const legacyId = item(sourceId, 101, { caption: 'unknown legacy target', parent_external_id: '99', published_at: 200001, raw_meta: {} })
  prepareTelegramIndex(db, sourceId, 1)
  assert.equal(telegramIndexPage(db, 0)[0].item_id, legacyId)
  assert.match(telegramIndexPage(db, 0)[0].embedding_text, /reply #99: unrelated local question/)
})

test('cross-peer document guard excludes forged same-ID local context, while absent peer metadata preserves the previous hash/input', () => {
  const crypto = require('node:crypto')
  const legacy = { id: 100, source_id: 1, external_id: '100', type: 'text', sender: 'author', caption: 'reply text', parent_external_id: '99', topic_id: 77, published_at: 200000 }
  const parent = { id: 99, source_id: 1, external_id: '99', type: 'text', caption: 'local question', topic_id: 77, published_at: 1 }
  const beforePeerSupportHash = crypto.createHash('sha256').update(JSON.stringify({ source_id: 1, external_id: '100', caption: 'reply text', sender: 'author', type: 'text', published_at: 200000, topic_id: 77, parent_external_id: '99' })).digest('hex')
  assert.equal(itemContentHash(legacy), beforePeerSupportHash)
  const priorInput = buildTelegramDocument(legacy, { ancestors: [parent] })
  assert.match(priorInput.embeddingTexts[0], /reply #99: local question/)
  const external = { ...legacy, raw_meta_json: JSON.stringify({ telegram_reply: { version: 1, source_peer: { kind: 'channel', id: 111 }, target_peer: { kind: 'channel', id: 222 }, message_id: 99, scope: 'external_peer' }, external_reply: { peer: { kind: 'channel', id: 222 }, message_id: 99 } }) }
  const safe = buildTelegramDocument(external, { ancestors: [parent] })
  assert.doesNotMatch(safe.embeddingTexts[0], /reply #99:|local question/)
  assert.deepEqual(safe.contextRefs, [])
  assert.notEqual(itemContentHash(external), beforePeerSupportHash)
  assert.notEqual(safe.documentHash, priorInput.documentHash)
})

test('same-peer proof restores the explicit parent path; provenance-only edits change fingerprints and invalidate ready vectors', () => {
  const sourceId = source('rag-reply-provenance-change')
  item(sourceId, 99, { caption: 'actual local question', published_at: 1 })
  const external = {
    telegram_reply: { version: 1, source_peer: { kind: 'channel', id: 111 }, target_peer: { kind: 'channel', id: 222 }, message_id: 99, scope: 'external_peer' },
    external_reply: { peer: { kind: 'channel', id: 222 }, message_id: 99 },
  }
  const targetId = item(sourceId, 100, { caption: 'unchanged target text', parent_external_id: '99', published_at: 200000, raw_meta: external })
  prepareTelegramIndex(db, sourceId, 1)
  embedPending(sourceId)
  const externalHash = chunks(targetId)[0].document_hash
  item(sourceId, 100, { caption: 'unchanged target text', parent_external_id: '99', published_at: 200000 })
  assert.equal(telegramFragmentIndexStatus(db, sourceId).stale_messages, 1)
  const staged = prepareTelegramIndex(db, sourceId, 1)
  assert.equal(staged.messagesPending, 1)
  assert.match(telegramIndexPage(db, 0)[0].embedding_text, /reply #99: actual local question/)
  embedPending(sourceId)
  assert.notEqual(chunks(targetId)[0].document_hash, externalHash)
  assert.equal(telegramFragmentIndexStatus(db, sourceId).messages_complete, 1)
})

test('cancellation before preparation has no vector side effects and coverage does not claim unscheduled messages', () => {
  const sourceId = source('rag-chunk-cancel')
  item(sourceId, 1, { caption: 'old eligible message' })
  const newestId = item(sourceId, 2, { caption: 'newest eligible message' })
  assert.throws(() => prepareTelegramIndex(db, sourceId, 1, {
    throwIfCancelled: () => { throw new Error('cancelled fixture') },
  }), /cancelled fixture/)
  assert.equal(chunks(newestId).length, 0)
  const plan = prepareTelegramIndex(db, sourceId, 1)
  assert.equal(plan.messagesSelected, 1)
  embedPending(sourceId)
  const status = telegramFragmentIndexStatus(db, sourceId)
  assert.equal(status.messages_complete, 1)
  assert.equal(status.messages_total, 2)
  assert.equal(status.index_version, INDEX_VERSION)
})

test('unrelated future posts do not reject a staged generation, but a new eligible prior does', () => {
  const sourceId = source('rag-chunk-source-fence')
  const targetId = item(sourceId, 10, { caption: 'original target', published_at: 1000 })
  prepareTelegramIndex(db, sourceId, 1)
  item(sourceId, 20, { caption: 'unrelated later post', published_at: 2000 })
  assert.doesNotThrow(() => embedPending(sourceId))
  assert.equal(chunks(targetId)[0].text, 'original target')

  // Staging against a consistent snapshot is not a license to publish after a
  // previously unseen same-topic prior becomes part of the actual context.
  const secondSource = source('rag-chunk-prior-fence')
  const secondId = item(secondSource, 10, { caption: 'another target', published_at: 1000 })
  prepareTelegramIndex(db, secondSource, 1)
  item(secondSource, 5, { caption: 'newly fetched earlier context', published_at: 500 })
  assert.throws(() => embedPending(secondSource), /context_selection_changed/)
  assert.equal(chunks(secondId).length, 0)
  prepareTelegramIndex(db, secondSource, 1)
  embedPending(secondSource)
  assert.equal(chunks(secondId)[0].text, 'another target')
})

test('a missing reply parent arriving during embedding fences the obsolete context generation', () => {
  const sourceId = source('rag-chunk-missing-parent-fence')
  const targetId = item(sourceId, 10, { caption: 'short delayed reply', parent_external_id: '5', published_at: 1000 })
  prepareTelegramIndex(db, sourceId, 1)
  item(sourceId, 5, { caption: 'late fetched real question', published_at: 100 })
  assert.throws(() => embedPending(sourceId), /dependency_changed/)
  assert.equal(chunks(targetId).length, 0)
  prepareTelegramIndex(db, sourceId, 1)
  const pending = telegramIndexPage(db, 0)
  assert.match(pending[0].embedding_text, /reply #5: late fetched real question/)
  embedPending(sourceId)
  assert.equal(telegramFragmentIndexStatus(db, sourceId).messages_complete, 1)
})

test('A -> edit -> B -> late A cannot replace the newer published generation', () => {
  const sourceId = source('rag-chunk-supersede')
  const targetId = item(sourceId, 1, { caption: 'generation A' })
  prepareTelegramIndex(db, sourceId, 1)
  const old = telegramIndexPage(db, 0)
  item(sourceId, 1, { caption: 'generation B' })
  prepareTelegramIndex(db, sourceId, 1)
  embedPending(sourceId)
  const before = chunks(targetId)
  const result = db.saveTelegramRagGenerationVectors(old[0].generation_id, old.map(row => ({
    chunk_index: row.chunk_index, embedding: fixtureEmbedding(row.embedding_text),
  })))
  assert.equal(result.obsolete, true)
  const publication = db.publishTelegramRagGeneration(old[0].generation_id)
  assert.equal(publication.published, false)
  assert.equal(publication.rejection, 'generation_superseded')
  assert.deepEqual(chunks(targetId), before)
  assert.equal(before[0].text, 'generation B')
})

test('explicit local item selection indexes only requested source-scoped targets, not the full source', () => {
  const sourceId = source('rag-chunk-explicit-items')
  const older = item(sourceId, 1, { caption: 'older selected target', published_at: 100 })
  const ignored = item(sourceId, 2, { caption: 'unselected context is not another target', published_at: 200 })
  const newer = item(sourceId, 3, { caption: 'newer selected target', published_at: 300 })
  const plan = prepareTelegramIndex(db, sourceId, null, { itemIds: [newer, older, newer] })
  assert.equal(plan.messagesSelected, 2)
  assert.deepEqual(telegramIndexPage(db, 0).map(row => row.item_id), [newer, older])
  embedPending(sourceId)
  assert.equal(chunks(older).length, 1)
  assert.equal(chunks(newer).length, 1)
  assert.equal(chunks(ignored).length, 0)
  assert.equal(telegramFragmentIndexStatus(db, sourceId).messages_complete, 2)
  assert.equal(telegramFragmentIndexStatus(db, sourceId).messages_total, 3)

  const empty = prepareTelegramIndex(db, sourceId, null, { itemIds: [] })
  assert.equal(empty.messagesSelected, 0)
  assert.equal(empty.fragmentsPending, 0)
})

test('foreign or missing local item selection is rejected before any generation is staged', () => {
  const sourceId = source('rag-chunk-explicit-invalid')
  const foreign = source('rag-chunk-explicit-foreign')
  const validId = item(sourceId, 1, { caption: 'valid target must not be partly indexed' })
  const otherId = item(foreign, 1, { caption: 'foreign target' })
  assert.throws(() => prepareTelegramIndex(db, sourceId, null, { itemIds: [validId, otherId] }), /outside the requested source/)
  assert.equal(chunks(validId).length, 0)
  assert.equal(chunks(otherId).length, 0)
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM telegram_rag_generations WHERE source_id = ?').get(sourceId).n, 0)
  assert.throws(() => prepareTelegramIndex(db, sourceId, null, { itemIds: [999999999] }), /unavailable local items/)
  assert.equal(chunks(validId).length, 0)
})
