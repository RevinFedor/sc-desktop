'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
process.env.SC_DESKTOP_DB = ':memory:'
const db = require('./database')
const { searchTelegramRag, normalizeRagScope, dateBoundary, MAX_FRAGMENT_CANDIDATES } = require('./telegram-rag-search')
const { INDEX_VERSION } = require('./telegram-rag-index')
const { serializeTelegramItem, readTelegramCaptionSpan } = require('../mcp/telegram-rag-readers')

const query = new Float32Array(db.EMBEDDING_DIM)
query[0] = 1
let nextSource = 100000
const pending = []
function vector(cos) {
  const result = new Float32Array(db.EMBEDDING_DIM)
  result[0] = cos
  result[1] = Math.sqrt(Math.max(0, 1 - cos * cos))
  return result
}
function source(handle) {
  const peer = String(nextSource++)
  return db.upsertSource({ platform: 'telegram', handle, external_id: peer, meta: { kind: 'channel', username: handle }, display_name: handle, tg_session: 'fixture' })
}
function message(sourceId, externalId, fields = {}) {
  return db.upsertItem({ source_id: sourceId, external_id: String(externalId), type: 'text', caption: `fixture ${externalId}`, published_at: 1000, ...fields })
}
function legacy(sourceId, externalId, cos, fields = {}) {
  const id = message(sourceId, externalId, fields)
  db.bulkUpsertVectors([{ item_id: id, embedding: vector(cos) }])
  return id
}
function fragments(sourceId, externalId, cosines, fields = {}, explicitChunks = null) {
  const id = message(sourceId, externalId, { caption: 'x'.repeat(cosines.length), ...fields })
  pending.push({ id, sourceId, cosines, explicitChunks })
  return id
}
function publish(indexVersion = INDEX_VERSION) {
  for (const { id, sourceId, cosines, explicitChunks } of pending.splice(0)) {
    const row = db.getDb().prepare('SELECT * FROM items WHERE id = ?').get(id)
    const staged = db.stageTelegramRagGeneration({
      itemId: id, sourceId, documentHash: `fixture-input-${id}`, indexVersion,
      targetRevision: db.getDb().prepare('SELECT local_revision FROM telegram_rag_item_state WHERE item_id = ?').get(id)?.local_revision || 1,
      targetContentHash: db.telegramRagItemContentHash(row),
      sourceRevision: db.getTelegramRagSourceRevision(sourceId),
      chunks: explicitChunks || cosines.map((_, chunk_index) => ({ chunk_index, start_char: chunk_index, end_char: chunk_index + 1, text: row.caption.slice(chunk_index, chunk_index + 1) })),
    })
    db.saveTelegramRagGenerationVectors(staged.generationId, cosines.map((cos, chunk_index) => ({ chunk_index, embedding: vector(cos) })))
    const published = db.publishTelegramRagGeneration(staged.generationId, { validateSnapshot: () => `fixture-input-${id}` })
    assert.equal(published.published, true, JSON.stringify(published))
  }
}
function instrument() {
  const calls = []
  return {
    calls,
    api: {
      ...db,
      hybridSearch: args => { calls.push({ kind: 'legacy', args }); return db.hybridSearch(args) },
      telegramSemanticChunkSearch: args => { calls.push({ kind: 'chunks', args }); return db.telegramSemanticChunkSearch(args) },
    },
  }
}
test.after(() => db.close())

test('aggregator restricts source/date/topic before both KNN branches, despite many closer ineligible candidates', () => {
  const wanted = source('search-scope-wanted')
  const foreign = source('search-scope-foreign')
  for (let n = 1; n <= 50; n++) legacy(foreign, n, 0.99)
  fragments(foreign, 100, Array(80).fill(0.99))
  for (let n = 1; n <= 40; n++) legacy(wanted, n, 0.99, { published_at: 1, topic_id: 77 })
  fragments(wanted, 50, Array(80).fill(0.99), { published_at: 1, topic_id: 77 })
  fragments(wanted, 51, [0.99], { published_at: 2000, topic_id: 88 })
  const eligibleChunk = fragments(wanted, 52, [0.8], { published_at: 2000, topic_id: 77 })
  const eligibleLegacy = legacy(wanted, 53, 0.7, { published_at: 2001, topic_id: 77 })
  publish()
  const tracked = instrument()
  const result = searchTelegramRag(tracked.api, { query_embedding: query, source_id: wanted, date_from: 2000, date_to: 2001, topic_id: 77, limit: 2 })
  assert.deepEqual(result.rows.map(row => row.id), [eligibleChunk, eligibleLegacy])
  assert.ok(result.rows.every(row => row.source_id === wanted && row.topic_id === 77))
  assert.equal(result.diagnostics.candidate_scope, 'source_date_topic_before_knn')
  assert.equal(result.diagnostics.search_budget_exhausted, false)
  for (const { args } of tracked.calls) {
    assert.equal(args.source_id, wanted)
    assert.equal(args.date_from, 2000)
    assert.equal(args.date_to, 2001)
    assert.equal(args.topic_id, 77)
  }
})

test('adaptive fragment retrieval returns unique messages and caps matched fragments without rewarding message length', () => {
  const sid = source('search-adaptive-duplicates')
  const long = fragments(sid, 1, Array(80).fill(0.9))
  const concise = fragments(sid, 2, [0.8])
  fragments(sid, 3, [0.7])
  publish()
  const tracked = instrument()
  const result = searchTelegramRag(tracked.api, { query_embedding: query, source_id: sid, limit: 2 })
  assert.deepEqual(result.rows.map(row => row.id), [long, concise])
  assert.deepEqual(tracked.calls.filter(call => call.kind === 'chunks').map(call => call.args.limit), [32, 64, 128])
  assert.equal(result.rows[0]._matched_chunks.length, 3)
  assert.equal(new Set(result.rows[0]._matched_chunks.map(match => match.chunk_id)).size, 3)
  assert.ok(Math.abs(result.rows[0]._cos - 0.9) < 1e-6)
  assert.ok(Math.abs(result.rows[1]._cos - 0.8) < 1e-6)
  assert.equal(result.diagnostics.ranking, 'maximum_fragment_cosine_per_message')
  assert.equal(result.diagnostics.score_is_probability, false)
})

test('kth-message ties expand the candidate budget before deterministic original-message ranking', () => {
  const sid = source('search-tied-boundary')
  const first = fragments(sid, 1, [0.8])
  fragments(sid, 2, Array(50).fill(0.8))
  publish()
  const tracked = instrument()
  const result = searchTelegramRag(tracked.api, { query_embedding: query, source_id: sid, limit: 1 })
  assert.equal(result.rows[0].id, first)
  assert.deepEqual(tracked.calls.filter(call => call.kind === 'chunks').map(call => call.args.limit), [32, 64])
  assert.equal(result.diagnostics.search_budget_exhausted, false)
})

test('legacy compatibility covers only unmigrated messages and cannot outrank a published replacement with its obsolete vector', () => {
  const sid = source('search-mixed-migration')
  const migrated = legacy(sid, 1, 1)
  const unmigrated = legacy(sid, 2, 0.8)
  assert.equal(fragments(sid, 1, [0.6]), migrated)
  publish()
  const result = searchTelegramRag(db, { query_embedding: query, source_id: sid, limit: 2 })
  assert.deepEqual(result.rows.map(row => row.id), [unmigrated, migrated])
  assert.equal(result.rows[0]._index_mode, 'legacy_context')
  assert.equal(result.rows[0]._freshness, 'unknown_legacy')
  assert.equal(result.rows[1]._index_mode, 'telegram_fragments')
  assert.equal(result.rows[1]._freshness, 'current_local_input')
  assert.ok(Math.abs(result.rows[1]._cos - 0.6) < 1e-6)
  assert.equal(db.vectorCountForSource(sid), 2, 'compatibility vectors remain stored')
  message(sid, 1, { caption: 'edited after publication' })
  const afterEdit = searchTelegramRag(db, { query_embedding: query, source_id: sid, limit: 2 })
  assert.deepEqual(afterEdit.rows.map(row => row.id), [unmigrated])
  assert.equal(afterEdit.coverage.stale_messages, 1)
})

test('Unicode matched spans preserve indexed revision and exact original text independently of contextual document hash', () => {
  const sid = source('search-unicode-provenance')
  const caption = 'head 😀 e\u0301 затем точный tail-only-needle https://Example.org/AbC'
  const start = caption.indexOf('tail-only-needle')
  const end = caption.length
  const id = fragments(sid, 1, [0.9], { caption, topic_id: 77, parent_external_id: '99', sender: 'real author' }, [{ chunk_index: 0, start_char: start, end_char: end, text: caption.slice(start, end) }])
  publish()
  const result = searchTelegramRag(db, { query_embedding: query, source_id: sid, limit: 1 })
  const row = result.rows[0]
  assert.equal(row.id, id)
  assert.equal(row.indexed_revision, row.local_revision)
  assert.ok(row.local_revision > 0)
  assert.equal(row._matched_chunks[0].offset_unit, 'utf16_code_units')
  assert.equal(row._matched_chunks[0].document_hash, row.indexed_input_hash)
  assert.equal(row._matched_chunks[0].index_revision, row.local_revision)
  assert.equal(row._matched_chunks[0].content_hash, row.indexed_content_hash)
  assert.equal(row._matched_chunks[0].index_version, INDEX_VERSION)
  assert.deepEqual(row._matched_chunks[0].context_refs, [])
  const item = serializeTelegramItem(row, result.source)
  const excerpt = readTelegramCaptionSpan(caption, { start: row._matched_chunks[0].start_char, end: row._matched_chunks[0].end_char, offset_unit: row._matched_chunks[0].offset_unit, expected_caption_hash: item.caption_hash })
  assert.equal(excerpt.caption, 'tail-only-needle https://Example.org/AbC')
  assert.ok(excerpt.unicode_span.start < excerpt.span.start, 'an earlier emoji makes UTF16 and codepoint coordinates differ')
  assert.equal(excerpt.caption_hash, item.caption_hash)
  assert.notEqual(item.caption_hash, row.indexed_input_hash, 'caption and context fingerprints serve different purposes')
  assert.equal(item.url, `https://t.me/c/${result.source.external_id}/77/1`)
})

test('old fragment-index versions cannot be reported current or silently reappear through their migrated legacy vectors', () => {
  const sid = source('search-obsolete-index-version')
  const old = legacy(sid, 1, 1)
  assert.equal(fragments(sid, 1, [0.9]), old)
  publish('telegram-context-fragments-obsolete')
  assert.equal(db.telegramSemanticChunkSearch({ query_embedding: query, source_id: sid }).length, 1, 'control proves an obsolete fragment is physically present')
  const result = searchTelegramRag(db, { query_embedding: query, source_id: sid, limit: 1 })
  assert.deepEqual(result.rows, [])
  assert.equal(result.coverage.messages_complete, 0)
  assert.equal(result.coverage.pending_messages, 1)
  assert.equal(result.coverage.legacy_only_messages, 0)
  assert.equal(db.vectorCountForSource(sid), 1)
})

test('catalogue counts fragment-only and mixed ready/legacy messages once, excludes stale and obsolete versions in both catalogue modes', () => {
  const fragmentOnly = source('search-catalogue-fragment-only')
  fragments(fragmentOnly, 1, [0.9, 0.8])
  const mixed = source('search-catalogue-mixed')
  const migrated = legacy(mixed, 1, 1)
  assert.equal(fragments(mixed, 1, [0.8]), migrated)
  legacy(mixed, 2, 0.7)
  legacy(mixed, 3, 0.6)
  publish()
  message(mixed, 3, { caption: 'edited legacy text is no longer verified' })
  const obsolete = source('search-catalogue-obsolete')
  fragments(obsolete, 1, [0.9])
  publish('telegram-context-fragments-obsolete')
  assert.equal(db.vectorCountForSource(fragmentOnly), 0, 'control has no message-level compatibility vectors')
  for (const rows of [db.listSources('telegram'), db.listSources()]) {
    const byId = new Map(rows.map(row => [row.id, row]))
    assert.equal(byId.get(fragmentOnly).semantic_indexed_count, 1)
    assert.equal(byId.get(fragmentOnly).semantic_current_count, 1)
    assert.equal(byId.get(fragmentOnly).semantic_legacy_count, 0)
    assert.equal(byId.get(mixed).semantic_indexed_count, 2)
    assert.equal(byId.get(mixed).semantic_indexable_count, 3)
    assert.equal(byId.get(mixed).semantic_current_count, 1)
    assert.equal(byId.get(mixed).semantic_legacy_count, 1)
    assert.equal(byId.get(mixed).semantic_stale_count, 1)
    assert.equal(byId.get(obsolete).semantic_indexed_count, 0)
    assert.equal(byId.get(obsolete).semantic_current_count, 0)
  }
})

test('legacy UI limit 5000 exceeds vec0 KNN cap safely using exact eligible distances without crossing source/date/topic scope', () => {
  const wanted = source('search-large-ui-legacy')
  const foreign = source('search-large-ui-foreign')
  const eligible = []
  db.getDb().transaction(() => {
    for (let n = 1; n <= 5100; n++) eligible.push(legacy(wanted, n, 0.9 - n / 20000, { published_at: 2000, topic_id: 77 }))
    for (let n = 1; n <= 30; n++) legacy(foreign, n, 1, { published_at: 2000, topic_id: 77 })
    legacy(wanted, 6000, 1, { published_at: 2000, topic_id: 88 })
    legacy(wanted, 6001, 1, { published_at: 1999, topic_id: 77 })
  })()
  const result = searchTelegramRag(db, { query_embedding: query, source_id: wanted, limit: 5000, date_from: 2000, date_to: 2000, topic_id: 77 })
  assert.equal(result.rows.length, 5000)
  assert.deepEqual(result.rows.map(row => row.id), eligible.slice(0, 5000))
  assert.ok(result.rows.every(row => row.source_id === wanted && row.topic_id === 77 && row.published_at === 2000))
  assert.ok(Math.abs(result.rows[0]._cos - (0.9 - 1 / 20000)) < 1e-6)
  assert.ok(result.rows.every((row, n) => n === 0 || result.rows[n - 1]._cos >= row._cos))
  assert.equal(result.diagnostics.search_budget_exhausted, false)
})

test('a dominating long message exhausts the bounded candidate budget honestly instead of declaring complete recall', () => {
  const sid = source('search-exhausted-budget')
  const dominating = fragments(sid, 1, Array(MAX_FRAGMENT_CANDIDATES + 5).fill(0.9))
  fragments(sid, 2, [0.8])
  publish()
  const tracked = instrument()
  const result = searchTelegramRag(tracked.api, { query_embedding: query, source_id: sid, limit: 2 })
  assert.deepEqual(result.rows.map(row => row.id), [dominating])
  assert.equal(result.diagnostics.search_budget_exhausted, true)
  assert.equal(result.diagnostics.fragment_budget, MAX_FRAGMENT_CANDIDATES)
  assert.equal(result.diagnostics.fragment_candidates, MAX_FRAGMENT_CANDIDATES)
  assert.ok(tracked.calls.filter(call => call.kind === 'chunks').every(call => call.args.limit <= MAX_FRAGMENT_CANDIDATES))
})

test('scope normalizes inclusive UTC days and rejects malformed dates/ranges/limits before database calls', () => {
  const normalized = normalizeRagScope({ source_id: 1, date_from: '2026-10-06', date_to: '2026-10-06', topic_id: 0 })
  assert.equal(normalized.date_to - normalized.date_from, 86399)
  assert.equal(dateBoundary('2026-10-06T12:00:00+07:00'), Date.parse('2026-10-06T05:00:00Z') / 1000)
  assert.equal(dateBoundary(0), 0)
  for (const args of [{ source_id: 0 }, { source_id: 1, limit: 0.5 }, { source_id: 1, min_cos: 2 }, { source_id: 1, date_from: '2026-02-30' }, { source_id: 1, date_from: 100, date_to: 99 }, { source_id: 1, topic_id: -1 }]) assert.throws(() => normalizeRagScope(args), RangeError)
  assert.throws(() => searchTelegramRag({ ...db, getSource: () => ({ platform: 'youtube' }) }, { query_embedding: query, source_id: 1 }), /Telegram source not found/)
})

function walFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-rag-snapshot-'))
  const filename = path.join(root, 'library.db')
  function connection() {
    const modulePath = require.resolve('./database')
    const instance = new Module(modulePath, module)
    instance.filename = modulePath
    instance.paths = Module._nodeModulePaths(path.dirname(modulePath))
    const previous = process.env.SC_DESKTOP_DB
    process.env.SC_DESKTOP_DB = filename
    try { instance._compile(fs.readFileSync(modulePath, 'utf8'), modulePath) }
    finally { process.env.SC_DESKTOP_DB = previous }
    instance.exports.getDb()
    return instance.exports
  }
  const reader = connection()
  const writer = connection()
  assert.equal(reader.getDb().pragma('journal_mode', { simple: true }), 'wal')
  assert.notEqual(reader.getDb(), writer.getDb())
  const sid = writer.upsertSource({ platform: 'telegram', handle: 'wal-snapshot', display_name: 'snapshot before' })
  function message(externalId, caption, publishedAt) {
    return writer.upsertItem({ source_id: sid, external_id: String(externalId), type: 'text', caption, published_at: publishedAt })
  }
  function publishItem(id, cosines) {
    const row = writer.getDb().prepare('SELECT * FROM items WHERE id = ?').get(id)
    const revision = writer.getDb().prepare('SELECT local_revision FROM telegram_rag_item_state WHERE item_id = ?').get(id).local_revision
    const hash = `wal-${id}-${revision}-${row.caption}`
    const stage = writer.stageTelegramRagGeneration({ itemId: id, sourceId: sid,
      documentHash: hash, indexVersion: INDEX_VERSION, targetRevision: revision,
      targetContentHash: writer.telegramRagItemContentHash(row),
      chunks: cosines.map((_, chunk_index) => ({ chunk_index, start_char: 0,
        end_char: row.caption.length, text: row.caption })),
    })
    writer.saveTelegramRagGenerationVectors(stage.generationId, cosines.map((cos, chunk_index) => ({ chunk_index, embedding: vector(cos) })))
    assert.equal(writer.publishTelegramRagGeneration(stage.generationId, { validateSnapshot: () => hash }).published, true)
    return stage.generationId
  }
  t.after(() => { reader.close(); writer.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { reader, writer, sid, message, publishItem }
}

test('all adaptive K reads and corpus chronology use one WAL snapshot while a writer publishes revision 2', t => {
  const f = walFixture(t)
  const target = f.message(1, 'old target revision one', 4000)
  const dominating = f.message(2, 'unchanged dominating long message', 1000)
  f.publishItem(target, [0.95])
  f.publishItem(dominating, Array(80).fill(0.9))
  let calls = 0
  let writerGeneration
  const observed = {
    ...f.reader,
    telegramSemanticChunkSearch: args => {
      const rows = f.reader.telegramSemanticChunkSearch(args)
      if (++calls === 1) {
        f.message(1, 'new target revision two', 6000)
        writerGeneration = f.publishItem(target, [0.6])
        f.writer.upsertSource({ platform: 'telegram', handle: 'wal-snapshot', display_name: 'snapshot after' })
      }
      return rows
    },
  }
  const result = searchTelegramRag(observed, { query_embedding: query, source_id: f.sid, limit: 2 })
  assert.ok(calls >= 3, `expected adaptive 32/64/128 reads; got ${calls}`)
  const hit = result.rows.find(row => row.id === target)
  assert.equal(hit.caption, 'old target revision one')
  assert.equal(hit.local_revision, 1)
  assert.ok(hit._matched_chunks.every(match => match.index_revision === hit.local_revision),
    `mixed match revisions: ${hit._matched_chunks.map(match => match.index_revision)}`)
  assert.ok(hit._matched_chunks.every(match => match.document_hash === hit.indexed_input_hash))
  assert.equal(result.source.display_name, 'snapshot before')
  assert.deepEqual(result.chronology, { first_item_at: 1000, last_item_at: 4000 })
  const after = searchTelegramRag(f.reader, { query_embedding: query, source_id: f.sid, limit: 2 })
  assert.equal(after.rows.find(row => row.id === target).generation_id, writerGeneration)
  assert.equal(after.rows.find(row => row.id === target).caption, 'new target revision two')
  assert.deepEqual(after.chronology, { first_item_at: 1000, last_item_at: 6000 })
})

test('legacy-to-chunk transition between branches cannot mix old compatibility rows with new corpus metadata', t => {
  const f = walFixture(t)
  const dominant = f.message(1, 'current dominant', 1000)
  const target = f.message(2, 'old compatibility caption', 4000)
  f.publishItem(dominant, Array(80).fill(0.9))
  f.writer.bulkUpsertVectors([{ item_id: target, embedding: vector(0.99) }])
  let transitioned = false
  const observed = {
    ...f.reader,
    hybridSearch: args => {
      const rows = f.reader.hybridSearch(args)
      f.message(2, 'new migrated caption', 6000)
      f.publishItem(target, [0.7])
      transitioned = true
      return rows
    },
  }
  const result = searchTelegramRag(observed, { query_embedding: query, source_id: f.sid, limit: 2 })
  assert.equal(transitioned, true)
  const before = result.rows.find(row => row.id === target)
  assert.equal(before.caption, 'old compatibility caption')
  assert.equal(before._index_mode, 'legacy_context')
  assert.equal(result.coverage.legacy_only_messages, 1)
  assert.deepEqual(result.chronology, { first_item_at: 1000, last_item_at: 4000 })
  const after = searchTelegramRag(f.reader, { query_embedding: query, source_id: f.sid, limit: 2 })
  assert.equal(after.rows.find(row => row.id === target)._index_mode, 'telegram_fragments')
  assert.equal(after.coverage.legacy_only_messages, 0)
  assert.deepEqual(after.chronology, { first_item_at: 1000, last_item_at: 6000 })
})

for (const mutation of ['stale', 'delete']) {
  test(`a ${mutation} writer update cannot change eligibility halfway through one search snapshot`, t => {
    const f = walFixture(t)
    const dominant = f.message(1, 'current dominant', 1000)
    const target = f.message(2, 'eligible compatibility caption', 4000)
    f.publishItem(dominant, Array(80).fill(0.9))
    f.writer.bulkUpsertVectors([{ item_id: target, embedding: vector(0.99) }])
    const observed = {
      ...f.reader,
      hybridSearch: args => {
        const rows = f.reader.hybridSearch(args)
        if (mutation === 'stale') f.message(2, 'edited unindexed caption', 6000)
        else f.writer.deleteItem(target)
        return rows
      },
    }
    const result = searchTelegramRag(observed, { query_embedding: query, source_id: f.sid, limit: 2 })
    assert.equal(result.rows.find(row => row.id === target).caption, 'eligible compatibility caption')
    assert.equal(result.coverage.messages_total, 2)
    assert.equal(result.coverage.stale_messages, 0)
    assert.deepEqual(result.chronology, { first_item_at: 1000, last_item_at: 4000 })
    const after = searchTelegramRag(f.reader, { query_embedding: query, source_id: f.sid, limit: 2 })
    assert.equal(after.rows.some(row => row.id === target), false)
    assert.equal(after.coverage.stale_messages, mutation === 'stale' ? 1 : 0)
    assert.equal(after.coverage.messages_total, mutation === 'delete' ? 1 : 2)
  })
}
