const test = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')

process.env.SC_DESKTOP_DB = ':memory:'
const db = require('./database')
const { INDEX_VERSION } = require('./telegram-rag-index')

const vector = new Float32Array(db.EMBEDDING_DIM)
vector[0] = 1
const vectors = []
let fixture

function item(sourceId, externalId, { caption = `fixture ${externalId}`, legacy = true } = {}) {
  const id = db.upsertItem({ source_id: sourceId, external_id: String(externalId),
    type: 'text', caption, published_at: 1_700_000_000 + Number(externalId) })
  if (legacy) vectors.push({ item_id: id, embedding: vector })
  return id
}

function generation(sourceId, itemId, { version = INDEX_VERSION, partial = false, fragmentCount = 1 } = {}) {
  const row = db.getDb().prepare('SELECT * FROM items WHERE id = ?').get(itemId)
  const chunks = Array.from({ length: partial ? 2 : fragmentCount }, (_, index) => ({
    chunk_index: index, start_char: index, end_char: index + 1, text: row.caption,
  }))
  const staged = db.stageTelegramRagGeneration({ itemId, sourceId,
    documentHash: `catalogue-${itemId}-${version}`, indexVersion: version,
    targetRevision: 1, targetContentHash: db.telegramRagItemContentHash(row), chunks })
  db.saveTelegramRagGenerationVectors(staged.generationId, chunks.slice(0, partial ? 1 : chunks.length)
    .map(chunk => ({ chunk_index: chunk.chunk_index, embedding: vector })))
  if (!partial) assert.equal(db.publishTelegramRagGeneration(staged.generationId).published, true)
  return staged.generationId
}

test.beforeEach(() => {
  vectors.length = 0
  const wanted = db.upsertSource({ platform: 'telegram', handle: 'catalogue-wanted' })
  const foreign = db.upsertSource({ platform: 'telegram', handle: 'catalogue-foreign' })
  const youtube = db.upsertSource({ platform: 'youtube', handle: 'catalogue-youtube' })
  const empty = db.upsertSource({ platform: 'telegram', handle: 'catalogue-empty' })

  // Large unmigrated corpora and a tiny changed set. Insert through the actual
  // schema/triggers, without FTS or extra per-row reads irrelevant to counts.
  const handle = db.getDb()
  const insert = handle.prepare(`INSERT INTO items(source_id,external_id,type,caption,published_at)
    VALUES (?,?,'text',?,?)`)
  handle.transaction(() => {
    for (const [sourceId, total] of [[foreign, 10000], [youtube, 20000]]) {
      for (let n = 1; n <= total; n++) {
        const id = Number(insert.run(sourceId, String(n), `noise ${n}`, 1_700_000_000 + n).lastInsertRowid)
        vectors.push({ item_id: id, embedding: vector })
      }
    }
  })()

  const legacy = item(wanted, 101)
  const currentWithLegacy = item(wanted, 102)
  const currentWithoutLegacy = item(wanted, 103, { legacy: false })
  const partialNew = item(wanted, 104, { legacy: false })
  const partialLegacy = item(wanted, 105)
  const oldProfile = item(wanted, 106)
  const staleLegacy = item(wanted, 107)
  const staleCurrent = item(wanted, 108)
  const blank = item(wanted, 109, { caption: '   ' })
  const removed = item(wanted, 110)
  const emptied = item(wanted, 111)
  db.bulkUpsertVectors(vectors)
  generation(wanted, currentWithLegacy)
  generation(wanted, currentWithoutLegacy)
  generation(wanted, partialNew, { partial: true })
  generation(wanted, partialLegacy, { partial: true })
  generation(wanted, oldProfile, { version: 'obsolete-profile' })
  generation(wanted, staleCurrent)
  generation(wanted, emptied)
  db.upsertItem({ source_id: wanted, external_id: '107', type: 'text', caption: 'edited legacy' })
  db.upsertItem({ source_id: wanted, external_id: '108', type: 'text', caption: 'edited current' })
  handle.prepare("UPDATE items SET caption = '' WHERE id = ?").run(emptied)
  db.deleteItem(removed)
  const folder = db.upsertFolder({ tg_filter_id: 55, tg_session: 'fixture', title: 'catalogue folder' })
  db.setFolderSources(folder, [wanted, empty])
  fixture = { wanted, foreign, youtube, empty, partialNew, partialLegacy, legacy, blank, removed, folder }
})

test('catalogue transitions partial to current, then stale and deleted, without double-counting preserved legacy', () => {
  const pending = db.getDb().prepare(`
    SELECT desired_generation_id FROM telegram_rag_item_state WHERE item_id = ?
  `).get(fixture.partialLegacy).desired_generation_id
  db.saveTelegramRagGenerationVectors(pending, [{ chunk_index: 1, embedding: vector }])
  const hash = db.getDb().prepare('SELECT input_hash FROM telegram_rag_generations WHERE generation_id = ?').get(pending).input_hash
  assert.equal(db.publishTelegramRagGeneration(pending, { validateSnapshot: () => hash }).published, true)
  let wanted = db.listSources('telegram').find(row => row.id === fixture.wanted)
  assert.equal(wanted.semantic_indexed_count, 4)
  assert.equal(wanted.semantic_current_count, 3)
  assert.equal(wanted.semantic_legacy_count, 1)
  db.upsertItem({ source_id: fixture.wanted, external_id: '105', type: 'text', caption: 'edited after migration' })
  wanted = db.listSources('telegram').find(row => row.id === fixture.wanted)
  assert.equal(wanted.semantic_indexed_count, 3)
  assert.equal(wanted.semantic_current_count, 2)
  assert.equal(wanted.semantic_legacy_count, 1)
  assert.equal(wanted.semantic_stale_count, 4)
  db.deleteItem(fixture.partialLegacy)
  wanted = db.listSources().find(row => row.id === fixture.wanted)
  assert.equal(wanted.semantic_indexed_count, 3)
  assert.equal(wanted.semantic_indexable_count, 7)
  assert.equal(wanted.semantic_stale_count, 3)
})

test('auto-index preflight counts ready current Telegram messages, never physical duplicates or stale vectors', () => {
  const counts = db.semanticIndexCountsForSources([fixture.wanted, fixture.foreign, fixture.youtube, fixture.empty])
  assert.equal(counts.get(fixture.wanted).semantic_indexable_count, 8)
  assert.equal(counts.get(fixture.wanted).semantic_indexed_count, 2,
    'two current messages must not become legacy+chunk duplicates and cause auto-index to skip pending work')
  assert.equal(counts.get(fixture.foreign).semantic_indexed_count, 0,
    'hashless legacy is searchable compatibility, not completion of the current index')
  assert.equal(counts.get(fixture.youtube).semantic_indexed_count, 20000,
    'non-Telegram aggregate contract remains unchanged')
  assert.equal(counts.get(fixture.empty).semantic_indexed_count, 0)
  const next = item(fixture.wanted, 112, { legacy: false })
  let changed = db.semanticIndexCountsForSources([fixture.wanted]).get(fixture.wanted)
  assert.equal(changed.semantic_indexable_count, 9)
  assert.equal(changed.semantic_indexed_count, 2)
  assert.ok(changed.semantic_indexed_count < changed.semantic_indexable_count,
    'the existing auto scheduler must start the index after a new unindexed message')
  generation(fixture.wanted, next)
  assert.equal(db.semanticIndexCountsForSources([fixture.wanted]).get(fixture.wanted).semantic_indexed_count, 3)
  db.upsertItem({ source_id: fixture.wanted, external_id: '112', type: 'text',
    caption: 'edited saved message', published_at: 1_700_000_112 })
  changed = db.semanticIndexCountsForSources([fixture.wanted]).get(fixture.wanted)
  assert.equal(changed.semantic_indexed_count, 2, 'known stale generations cannot satisfy auto-index preflight')
})

test('storage counts physical fragment vectors and only present staged embeddings, not messages', () => {
  const sourceId = db.upsertSource({ platform: 'telegram', handle: 'storage-fragments-only' })
  const ready = item(sourceId, 1, { legacy: false })
  generation(sourceId, ready, { fragmentCount: 3 })
  const partial = item(sourceId, 2, { legacy: false })
  generation(sourceId, partial, { partial: true })
  assert.equal(db.vectorCountForSource(sourceId), 0)
  const storage = db.storageBreakdownForSource(sourceId)
  assert.equal(storage.index_vectors, 4)
  assert.equal(storage.index_bytes, 4 * db.EMBEDDING_DIM * 4)
  assert.equal(storage.index_legacy_vectors, 0)
  assert.equal(storage.index_chunk_vectors, 3)
  assert.equal(storage.index_staged_vectors, 1)
  assert.equal(storage.index_staged_bytes, db.EMBEDDING_DIM * 4)
})

test.afterEach(() => db.close())

function assertWanted(row) {
  assert.equal(row.semantic_indexable_count, 8)
  assert.equal(row.semantic_indexed_count, 4)
  assert.equal(row.semantic_current_count, 2)
  assert.equal(row.semantic_legacy_count, 2)
  assert.equal(row.semantic_stale_count, 2)
}

test('catalogue counts current/legacy/stale exactly without counting partial, blank, deleted or obsolete-profile rows', t => {
  const start = performance.now()
  const rows = db.listSources('telegram')
  const filteredMs = performance.now() - start
  assertWanted(rows.find(row => row.id === fixture.wanted))
  const foreign = rows.find(row => row.id === fixture.foreign)
  assert.equal(foreign.semantic_indexed_count, 10000)
  assert.equal(foreign.semantic_current_count, 0)
  assert.equal(foreign.semantic_legacy_count, 10000)
  const empty = rows.find(row => row.id === fixture.empty)
  assert.equal(empty.semantic_indexed_count, 0)
  assert.equal(empty.semantic_indexable_count, 0)

  const allStarted = performance.now()
  const all = db.listSources()
  const allMs = performance.now() - allStarted
  assertWanted(all.find(row => row.id === fixture.wanted))
  assert.equal(all.find(row => row.id === fixture.youtube).semantic_indexed_count, 20000)
  assert.equal(all.find(row => row.id === fixture.youtube).semantic_current_count, undefined)
  t.diagnostic(`native 30k legacy vectors / sparse changed ledger: listSources(telegram)=${filteredMs.toFixed(2)}ms, listSources(all)=${allMs.toFixed(2)}ms`)
})
