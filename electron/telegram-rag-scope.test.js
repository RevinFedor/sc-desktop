const test = require('node:test')
const assert = require('node:assert/strict')

// Run with ELECTRON_RUN_AS_NODE=1 so the production better-sqlite3 ABI and
// installed sqlite-vec extension execute the queries, rather than a SQL mock.
// Only a synthetic in-memory library is opened.
process.env.SC_DESKTOP_DB = ':memory:'
const db = require('./database')

const query = new Float32Array(db.EMBEDDING_DIM)
query[0] = 1

function vector(cos) {
  const embedding = new Float32Array(db.EMBEDDING_DIM)
  embedding[0] = cos
  embedding[1] = Math.sqrt(Math.max(0, 1 - cos * cos))
  return embedding
}

function source(handle) {
  return db.upsertSource({
    platform: 'telegram', handle, display_name: handle,
    external_id: handle, tg_session: 'fixture', is_explicit: true,
  })
}

function indexedItem(sourceId, externalId, cos, fields = {}) {
  const id = db.upsertItem({
    source_id: sourceId, external_id: String(externalId), type: 'text',
    caption: `fixture message ${externalId}`, published_at: 1000,
    ...fields,
  })
  db.bulkUpsertVectors([{ item_id: id, embedding: vector(cos) }])
  return id
}

test.after(() => db.close())

test('source is restricted before KNN even with 150 closer unrelated vectors', () => {
  const wanted = source('rag-scope-wanted')
  const unrelated = source('rag-scope-unrelated')
  for (let n = 0; n < 150; n++) indexedItem(unrelated, n + 1, 0.99)
  const wantedId = indexedItem(wanted, 42, 0.8, {
    sender: 'fixture author', topic_id: 77, topic_title: 'career',
    parent_external_id: '40', has_media: true,
    raw_meta: { forwarded_from: { id: 123 } },
    reactions: [{ e: '👍', n: 5 }],
  })
  indexedItem(wanted, 43, 0.5)

  // Control: reproduce the previous global-top-100/post-filter failure on the
  // same real extension and fixture, proving the target is outside that set.
  const oldRows = db.getDb().prepare(`
    SELECT i.id FROM (
      SELECT item_id, distance FROM items_vec
       WHERE embedding MATCH ? AND k = 100
    ) v JOIN items i ON i.id = v.item_id
     WHERE i.source_id = ? ORDER BY v.distance LIMIT 1
  `).all(Buffer.from(query.buffer), wanted)
  assert.deepEqual(oldRows, [])

  const hits = db.hybridSearch({ query_embedding: query, source_id: wanted, limit: 1 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, wantedId)
  assert.equal(hits[0].source_id, wanted)
  assert.ok(Math.abs(hits[0]._cos - 0.8) < 1e-6)
  assert.equal(hits[0]._score, hits[0]._cos)
  assert.deepEqual(hits[0]._branches, ['vec'])
  assert.equal('_dist' in hits[0], false)
  assert.equal(hits[0].sender, 'fixture author')
  assert.equal(hits[0].topic_id, 77)
  assert.equal(hits[0].topic_title, 'career')
  assert.equal(hits[0].parent_external_id, '40')
  assert.equal(hits[0].has_media, 1)
  assert.deepEqual(JSON.parse(hits[0].raw_meta_json), { forwarded_from: { id: 123 } })
  assert.deepEqual(JSON.parse(hits[0].reactions), [{ e: '👍', n: 5 }])
})

test('inclusive dates restrict candidates before ranking, not after the limit', () => {
  const wanted = source('rag-scope-dates')
  for (let n = 0; n < 150; n++) {
    indexedItem(wanted, n + 1, 0.99, { published_at: 1000 + n })
  }
  indexedItem(wanted, 160, 1, { published_at: null })
  const fromId = indexedItem(wanted, 161, 0.8, { published_at: 2000 })
  const toId = indexedItem(wanted, 162, 0.7, { published_at: 2001 })
  indexedItem(wanted, 163, 0.95, { published_at: 2002 })

  const hits = db.hybridSearch({
    query_embedding: query, source_id: wanted, limit: 2,
    date_from: 2000, date_to: 2001,
  })
  assert.deepEqual(hits.map(row => row.id), [fromId, toId])
  assert.deepEqual(db.hybridSearch({
    query_embedding: query, source_id: wanted, date_from: 2001, date_to: 2000,
  }), [])
})

test('topic restrictions rank within the topic and General includes NULL and zero', () => {
  const wanted = source('rag-scope-topics')
  for (let n = 0; n < 150; n++) indexedItem(wanted, n + 1, 0.99, { topic_id: 7 })
  const generalNull = indexedItem(wanted, 160, 0.8, { topic_id: null })
  const generalZero = indexedItem(wanted, 161, 0.7, { topic_id: 0 })
  const topicEight = indexedItem(wanted, 162, 0.6, { topic_id: 8 })

  const general = db.hybridSearch({
    query_embedding: query, source_id: wanted, limit: 2, topic_id: 0,
  })
  assert.deepEqual(general.map(row => row.id), [generalNull, generalZero])
  const topic = db.hybridSearch({
    query_embedding: query, source_id: wanted, limit: 2, topic_id: 8,
  })
  assert.deepEqual(topic.map(row => row.id), [topicEight])
})

test('date and topic scopes combine and open-ended bounds work', () => {
  const wanted = source('rag-scope-combined')
  indexedItem(wanted, 1, 1, { topic_id: 1, published_at: 1000 })
  indexedItem(wanted, 2, 0.99, { topic_id: 2, published_at: 2000 })
  const scoped = indexedItem(wanted, 3, 0.8, { topic_id: 1, published_at: 2000 })
  const newer = indexedItem(wanted, 4, 0.7, { topic_id: 1, published_at: 3000 })

  const hits = db.hybridSearch({
    query_embedding: query, source_id: wanted, limit: 1,
    topic_id: 1, date_from: 2000, date_to: 2000,
  })
  assert.deepEqual(hits.map(row => row.id), [scoped])
  assert.deepEqual(db.hybridSearch({
    query_embedding: query, source_id: wanted, limit: 2, topic_id: 1, date_from: 2000,
  }).map(row => row.id), [scoped, newer])
  assert.deepEqual(db.hybridSearch({
    query_embedding: query, source_id: wanted, limit: 1, topic_id: 1, date_to: 2000,
  }).map(row => row.external_id), ['1'])
})

test('unfiltered source search preserves ranking, cosine and limits over 100', () => {
  const wanted = source('rag-scope-many')
  const ids = []
  for (let n = 0; n < 130; n++) ids.push(indexedItem(wanted, n + 1, 0.9 - n / 1000))
  const hits = db.hybridSearch({ query_embedding: query, source_id: wanted, limit: 120 })
  assert.equal(hits.length, 120)
  assert.deepEqual(hits.map(row => row.id), ids.slice(0, 120))
  assert.ok(hits.every((row, n) => n === 0 || hits[n - 1]._cos >= row._cos))
  assert.equal(db.hybridSearch({ query_embedding: query, source_id: wanted, limit: 0 }).length, 0)
})

test('empty or unindexed sources cannot borrow matches from other chats', () => {
  const empty = source('rag-scope-empty')
  const unindexed = source('rag-scope-unindexed')
  db.upsertItem({ source_id: unindexed, external_id: '1', type: 'text', caption: 'not indexed' })
  assert.deepEqual(db.hybridSearch({ query_embedding: query, source_id: empty }), [])
  assert.deepEqual(db.hybridSearch({ query_embedding: query, source_id: unindexed }), [])
  assert.deepEqual(db.hybridSearch({ query_embedding: query, source_id: -1 }), [])
})

function chunkedItem(sourceId, externalId, cosines, fields = {}) {
  const id = db.upsertItem({
    source_id: sourceId, external_id: String(externalId), type: 'text',
    caption: `full fixture message ${externalId}`, published_at: 1000,
    ...fields,
  })
  const chunks = cosines.map((_, index) => ({
      chunk_index: index, start_char: index * 10, end_char: (index + 1) * 10,
      text: `fragment ${index} of message ${externalId}`,
  }))
  const row = db.getDb().prepare('SELECT * FROM items WHERE id = ?').get(id)
  const platform = db.getSource(sourceId).platform
  if (platform !== 'telegram') {
    db.replaceSemanticChunksForItem({ itemId: id, sourceId,
      documentHash: `fixture-${sourceId}-${externalId}`, chunks })
    const stored = db.getDb().prepare('SELECT id FROM semantic_chunks WHERE item_id = ? ORDER BY chunk_index').all(id)
    db.bulkUpsertSemanticChunkVectors(stored.map((chunk, index) => ({
      chunk_id: chunk.id, source_id: sourceId, embedding: vector(cosines[index]),
    })))
    return id
  }
  const staged = db.stageTelegramRagGeneration({
    itemId: id, sourceId, documentHash: `fixture-${sourceId}-${externalId}`,
    indexVersion: 'fixture-v1', targetRevision: 1,
    targetContentHash: db.telegramRagItemContentHash(row), chunks,
  })
  db.saveTelegramRagGenerationVectors(staged.generationId, cosines.flatMap((cos, index) => (
    cosines[index] == null ? [] : [{
      chunk_index: index, embedding: vector(cos),
    }]
  )))
  if (cosines.every(cos => cos != null)) assert.equal(db.publishTelegramRagGeneration(staged.generationId).published, true)
  return id
}

test('Telegram fragment candidates cannot be starved by closer Telegram/YouTube sources', () => {
  const wanted = source('rag-fragment-wanted')
  const unrelated = source('rag-fragment-unrelated')
  const youtube = db.upsertSource({ platform: 'youtube', handle: 'rag-fragment-youtube' })
  chunkedItem(unrelated, 1, Array(150).fill(0.99))
  chunkedItem(youtube, 1, Array(150).fill(0.99))
  const caption = `full caption ${'x'.repeat(9000)}`
  const wantedId = chunkedItem(wanted, 42, [0.8, 0.7], {
    caption, sender: 'fragment author', topic_id: 77, topic_title: 'career',
    parent_external_id: '40', has_media: true,
    raw_meta: { forward: { from_id: 123 } },
    reactions: [{ e: '👍', n: 3 }],
  })

  const hits = db.telegramSemanticChunkSearch({ query_embedding: query, source_id: wanted, limit: 1 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].item_id, wantedId)
  assert.equal(hits[0].source_id, wanted)
  assert.equal(hits[0].chunk_index, 0)
  assert.equal(hits[0].text, 'fragment 0 of message 42')
  assert.equal(hits[0].caption, caption)
  assert.equal(hits[0].sender, 'fragment author')
  assert.equal(hits[0].topic_id, 77)
  assert.equal(hits[0].topic_title, 'career')
  assert.equal(hits[0].parent_external_id, '40')
  assert.equal(hits[0].has_media, 1)
  assert.deepEqual(JSON.parse(hits[0].raw_meta_json), { forward: { from_id: 123 } })
  assert.deepEqual(JSON.parse(hits[0].reactions), [{ e: '👍', n: 3 }])
  assert.ok(Math.abs(hits[0]._cos - 0.8) < 1e-6)
  assert.equal(hits[0]._score, hits[0]._cos)
  assert.equal('_dist' in hits[0], false)

  assert.deepEqual(db.telegramSemanticChunkSearch({ query_embedding: query, source_id: youtube }), [])
  // Existing YouTube API still sees its own corpus unchanged.
  assert.equal(db.semanticChunkSearch({ query_embedding: query, source_id: youtube, limit: 1 }).length, 1)
})

test('Telegram fragment date/topic scopes constrain KNN before its candidate budget', () => {
  const wanted = source('rag-fragment-dates-topics')
  chunkedItem(wanted, 1, Array(150).fill(0.99), { published_at: 1000, topic_id: 42 })
  chunkedItem(wanted, 2, [0.99], { published_at: 2000, topic_id: 7 })
  chunkedItem(wanted, 3, [0.98], { published_at: 2002, topic_id: 42 })
  chunkedItem(wanted, 4, [0.99], { published_at: null, topic_id: 42 })
  const fromId = chunkedItem(wanted, 5, [0.8], { published_at: 2000, topic_id: 42 })
  const toId = chunkedItem(wanted, 6, [0.7], { published_at: 2001, topic_id: 42 })
  const nullGeneral = chunkedItem(wanted, 7, [0.6], { published_at: 2000, topic_id: null })
  const zeroGeneral = chunkedItem(wanted, 8, [0.5], { published_at: 2000, topic_id: 0 })

  const hits = db.telegramSemanticChunkSearch({
    query_embedding: query, source_id: wanted, limit: 2,
    date_from: 2000, date_to: 2001, topic_id: 42,
  })
  assert.deepEqual(hits.map(row => row.item_id), [fromId, toId])
  assert.deepEqual(db.telegramSemanticChunkSearch({
    query_embedding: query, source_id: wanted, limit: 2, topic_id: 0,
  }).map(row => row.item_id), [nullGeneral, zeroGeneral])
  assert.deepEqual(db.telegramSemanticChunkSearch({
    query_embedding: query, source_id: wanted, date_from: 2001, date_to: 2000,
  }), [])
})

test('Telegram fragment budgets are bounded without hiding same-message fragments', () => {
  const wanted = source('rag-fragment-budget')
  const itemId = chunkedItem(wanted, 1, Array(1005).fill(0.8))
  const hits = db.telegramSemanticChunkSearch({ query_embedding: query, source_id: wanted, limit: 2000 })
  assert.equal(hits.length, 1000)
  assert.ok(hits.every(row => row.item_id === itemId))
  assert.equal(new Set(hits.map(row => row.id)).size, 1000)
  assert.deepEqual(db.telegramSemanticChunkSearch({ query_embedding: query, source_id: wanted, limit: 0 }), [])
  assert.deepEqual(db.telegramSemanticChunkSearch({ query_embedding: query, source_id: -1 }), [])
})

test('Telegram coverage distinguishes complete/partial/prepared/legacy-only messages', () => {
  const wanted = source('rag-fragment-coverage')
  chunkedItem(wanted, 1, [0.8, 0.7])
  const partialId = chunkedItem(wanted, 2, [0.8, null, null])
  db.bulkUpsertVectors([{ item_id: partialId, embedding: vector(0.5) }])
  const preparedId = chunkedItem(wanted, 3, [null, null])
  // A stale timestamp must not be treated as an existing embedding.
  db.getDb().prepare('UPDATE semantic_chunks SET indexed_at = 123 WHERE item_id = ?').run(preparedId)
  indexedItem(wanted, 4, 0.8)
  db.upsertItem({ source_id: wanted, external_id: '5', type: 'text', caption: 'not indexed' })
  chunkedItem(wanted, 6, [0.9], { caption: '   ' })
  const youtube = db.upsertSource({ platform: 'youtube', handle: 'rag-coverage-youtube' })
  chunkedItem(youtube, 1, [0.9])

  const status = db.telegramRagIndexStatus(wanted)
  assert.equal(status.done, 1)
  assert.equal(status.total, 5)
  assert.equal(status.messages_indexed, 1)
  assert.equal(status.messages_complete, 1)
  assert.equal(status.messages_partial, 1)
  assert.equal(status.messages_prepared, 3)
  assert.equal(status.legacy_only_messages, 2)
  assert.equal(status.fragments_indexed, 2)
  assert.equal(status.fragments_total, 7)
  assert.equal(status.staged_fragments, 5)
  assert.equal(status.staged_fragments_indexed, 1)
  const youtubeStatus = db.telegramRagIndexStatus(youtube)
  assert.equal(youtubeStatus.messages_total, 0)
  assert.equal(youtubeStatus.fragments_total, 0)
  assert.equal(youtubeStatus.fragments_indexed, 0)
  assert.equal(db.telegramRagIndexStatus(-1).messages_total, 0)

  const generationId = db.getDb().prepare(
    'SELECT desired_generation_id FROM telegram_rag_item_state WHERE item_id = ?'
  ).get(partialId).desired_generation_id
  const remaining = db.getDb().prepare(
    'SELECT chunk_index FROM telegram_rag_generation_chunks WHERE generation_id = ? AND embedding IS NULL'
  ).all(generationId)
  db.saveTelegramRagGenerationVectors(generationId, remaining.map(chunk => ({
    chunk_index: chunk.chunk_index, embedding: vector(0.7),
  })))
  assert.equal(db.publishTelegramRagGeneration(generationId, {
    validateSnapshot: () => `fixture-${wanted}-2`,
  }).published, true)
  const after = db.telegramRagIndexStatus(wanted)
  assert.equal(after.messages_complete, 2)
  assert.equal(after.messages_partial, 0)
  assert.equal(after.fragments_indexed, 5)
  assert.equal(after.messages_indexed, 2)
  assert.equal(after.legacy_only_messages, 1)
})

const ragDocument = require('./telegram-rag-index')

function stageCurrent(itemId) {
  const document = ragDocument.buildCurrentTelegramDocument(db, itemId)
  return {
    document,
    ...db.stageTelegramRagGeneration({
      itemId, sourceId: document.targetReference.source_id,
      documentHash: document.documentHash, indexVersion: ragDocument.INDEX_VERSION,
      targetRevision: document.targetReference.local_revision,
      targetContentHash: document.targetReference.content_hash,
      sourceRevision: db.getTelegramRagSourceRevision(document.targetReference.source_id),
      contextRefs: document.contextRefs, chunks: document.chunks,
    }),
  }
}

function fillStaged(staged, cos = 0.8, count = staged.pendingChunks.length) {
  return db.saveTelegramRagGenerationVectors(staged.generationId,
    staged.pendingChunks.slice(0, count).map(chunk => ({ chunk_index: chunk.chunk_index, embedding: vector(cos) })))
}

function publishCurrent(staged) {
  return db.publishTelegramRagGeneration(staged.generationId, {
    validateSnapshot: ({ target }) => ragDocument.buildCurrentTelegramDocument(db, target.id),
  })
}

test('A/edit/B publication fences prevent late A from overwriting ready B', () => {
  const wanted = source('rag-generation-revision')
  const id = db.upsertItem({ source_id: wanted, external_id: '1', type: 'text', caption: 'old A' })
  const a = stageCurrent(id)
  fillStaged(a)
  assert.equal(publishCurrent(a).published, true)
  db.upsertItem({ source_id: wanted, external_id: '1', type: 'text', caption: 'new B' })
  assert.deepEqual(db.telegramSemanticChunkSearch({ query_embedding: query, source_id: wanted }), [])
  assert.equal(db.telegramRagIndexStatus(wanted).stale_messages, 1)
  const b = stageCurrent(id)
  fillStaged(b)
  assert.equal(publishCurrent(b).published, true)
  assert.equal(publishCurrent(a).published, false)
  const hits = db.telegramSemanticChunkSearch({ query_embedding: query, source_id: wanted })
  assert.equal(hits[0].generation_id, b.generationId)
  assert.equal(hits[0].document_hash, b.document.documentHash)
  assert.equal(hits[0].caption, 'new B')
  assert.equal(hits[0].local_revision, 2)
  assert.equal(hits[0].indexed_revision, 2)
})

test('failed/partial generations remain unpublished and resume only missing vectors', () => {
  const wanted = source('rag-generation-resume')
  const id = indexedItem(wanted, 1, 0.8, { caption: 'long body '.repeat(700) })
  const a = stageCurrent(id)
  assert.ok(a.pendingChunks.length > 2)
  fillStaged(a, 0.99, 1)
  assert.equal(publishCurrent(a).rejection, 'generation_incomplete')
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM semantic_chunks_vec WHERE source_id = ?').get(BigInt(wanted)).n, 0)
  assert.equal(db.telegramSemanticChunkSearch({ query_embedding: query, source_id: wanted }).length, 0)
  assert.equal(db.hybridSearch({ query_embedding: query, source_id: wanted, legacy_only: true })[0].id, id)
  const resumed = stageCurrent(id)
  assert.equal(resumed.generationId, a.generationId)
  assert.equal(resumed.pendingChunks.length, a.pendingChunks.length - 1)
  fillStaged(resumed)
  assert.equal(publishCurrent(resumed).published, true)
  assert.equal(db.telegramRagIndexStatus(wanted).messages_complete, 1)
  assert.equal(db.hybridSearch({ query_embedding: query, source_id: wanted, legacy_only: true }).length, 0)
})

test('unrelated future arrivals do not block publication; newly eligible priors do', () => {
  const wanted = source('rag-generation-chronology')
  const id = db.upsertItem({ source_id: wanted, external_id: '10', type: 'text', caption: 'target', published_at: 2000 })
  const a = stageCurrent(id)
  fillStaged(a)
  db.upsertItem({ source_id: wanted, external_id: '100', type: 'text', caption: 'unrelated future', published_at: 4000 })
  assert.equal(publishCurrent(a).published, true)

  const next = db.upsertItem({ source_id: wanted, external_id: '20', type: 'text', caption: 'second target', published_at: 3000 })
  const b = stageCurrent(next)
  fillStaged(b)
  db.upsertItem({ source_id: wanted, external_id: '15', type: 'text', caption: 'new preceding context', published_at: 2500 })
  assert.equal(publishCurrent(b).rejection, 'context_selection_changed')
  assert.equal(db.telegramRagIndexStatus(wanted).messages_complete, 1)
})

test('missing same-source parent arrival and parent deletion invalidate dependents', () => {
  const wanted = source('rag-generation-parent')
  const other = source('rag-generation-other-parent')
  const id = db.upsertItem({ source_id: wanted, external_id: '10', type: 'text', caption: 'reply',
    parent_external_id: '5', topic_id: 9, published_at: 2000 })
  const a = stageCurrent(id)
  fillStaged(a)
  assert.equal(publishCurrent(a).published, true)
  db.upsertItem({ source_id: other, external_id: '5', type: 'text', caption: 'wrong-source parent', published_at: 1000 })
  assert.equal(db.telegramSemanticChunkSearch({ query_embedding: query, source_id: wanted }).length, 1)
  const parentId = db.upsertItem({ source_id: wanted, external_id: '5', type: 'text', caption: 'real parent',
    topic_id: 99, published_at: 1000 })
  assert.equal(db.telegramSemanticChunkSearch({ query_embedding: query, source_id: wanted }).length, 0)
  assert.equal(publishCurrent(a).rejection, 'dependency_changed')
  const b = stageCurrent(id)
  fillStaged(b)
  assert.equal(publishCurrent(b).published, true)
  db.deleteItem(parentId)
  assert.equal(db.telegramSemanticChunkSearch({ query_embedding: query, source_id: wanted }).length, 0)
  assert.equal(db.telegramRagIndexStatus(wanted).stale_messages, 1)
})

test('migrated legacy vectors are removed before top-k so they cannot starve eligible legacy', () => {
  const wanted = source('rag-generation-legacy-prefilter')
  for (let n = 1; n <= 110; n++) {
    const id = indexedItem(wanted, n, 0.99)
    const staged = stageCurrent(id)
    fillStaged(staged)
    assert.equal(publishCurrent(staged).published, true)
  }
  const legacy = indexedItem(wanted, 9999, 0.8)
  const hits = db.hybridSearch({ query_embedding: query, source_id: wanted, limit: 1, legacy_only: true })
  assert.equal(hits[0].id, legacy)
  assert.ok(Math.abs(hits[0]._cos - 0.8) < 1e-6)
})

test('close staged embeddings never starve ready results and supersession releases their blobs', () => {
  const wanted = source('rag-generation-staging-prefilter')
  const readyId = db.upsertItem({ source_id: wanted, external_id: '1', type: 'text', caption: 'ready', published_at: 1000 })
  const ready = stageCurrent(readyId)
  fillStaged(ready, 0.8)
  assert.equal(publishCurrent(ready).published, true)
  const pendingId = db.upsertItem({ source_id: wanted, external_id: '2', type: 'text',
    caption: 'not complete yet '.repeat(9000), published_at: 2000 })
  const pending = stageCurrent(pendingId)
  assert.ok(pending.pendingChunks.length > 100)
  fillStaged(pending, 0.99, 100)
  const hits = db.telegramSemanticChunkSearch({ query_embedding: query, source_id: wanted, limit: 1 })
  assert.equal(hits[0].item_id, readyId)
  assert.equal(db.getDb().prepare(
    'SELECT COUNT(*) AS n FROM semantic_chunks_vec WHERE source_id = ?'
  ).get(BigInt(wanted)).n, 1)
  db.upsertItem({ source_id: wanted, external_id: '2', type: 'text', caption: 'new replacement' })
  const replacement = stageCurrent(pendingId)
  assert.notEqual(replacement.generationId, pending.generationId)
  assert.equal(db.getDb().prepare(
    'SELECT COUNT(*) AS n FROM telegram_rag_generation_chunks WHERE generation_id = ?'
  ).get(pending.generationId).n, 0)
  assert.equal(db.saveTelegramRagGenerationVectors(pending.generationId,
    [{ chunk_index: 0, embedding: vector(0.99) }]).obsolete, true)
  fillStaged(replacement)
  assert.equal(publishCurrent(replacement).published, true)
  assert.equal(publishCurrent(pending).published, false)
})
