'use strict'

// Shared retrieval contract for MCP and the desktop semantic-search UI. The
// database helpers apply eligibility BEFORE KNN; this layer groups fragments
// into original messages and never rewards a message for merely being longer.
const MAX_FRAGMENT_CANDIDATES = 1000
const { INDEX_VERSION } = require('./telegram-rag-index')

function boundedNumber(value, fallback, min, max, label) {
  const n = value == null ? fallback : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) throw new RangeError(`Invalid ${label}`)
  return n
}

function dateBoundary(value, { end = false } = {}) {
  if (value == null || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Date must be Unix seconds or ISO date')
    return value
  }
  const text = String(value).trim()
  const day = /^\d{4}-\d{2}-\d{2}$/.test(text)
  if (!day && !/^\d{4}-\d{2}-\d{2}T/.test(text)) throw new RangeError('Date must be Unix seconds or ISO date')
  const millis = Date.parse(day ? `${text}T00:00:00Z` : text)
  if (!Number.isFinite(millis) || (day && new Date(millis).toISOString().slice(0, 10) !== text)) throw new RangeError('Invalid ISO date')
  return Math.floor(millis / 1000) + (day && end ? 86399 : 0)
}

function normalizeRagScope(args = {}) {
  const sourceId = Number(args.source_id)
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) throw new RangeError('source_id must be a positive integer')
  // The desktop UI progressively asks for more rows. Its contract predates the
  // MCP page cap (100); keep that capability while bounding fragment work.
  const limit = boundedNumber(args.limit, 10, 1, 10000, 'limit')
  if (!Number.isInteger(limit)) throw new RangeError('limit must be an integer')
  const minCos = boundedNumber(args.min_cos, 0.55, -1, 1, 'min_cos')
  const dateFrom = dateBoundary(args.date_from)
  const dateTo = dateBoundary(args.date_to, { end: true })
  if (dateFrom != null && dateTo != null && dateFrom > dateTo) throw new RangeError('date_from must not be after date_to')
  const topic = args.topic_id == null ? null : Number(args.topic_id)
  if (topic != null && (!Number.isSafeInteger(topic) || topic < 0)) throw new RangeError('topic_id must be a nonnegative integer')
  return { source_id: sourceId, limit, min_cos: minCos, date_from: dateFrom, date_to: dateTo, topic_id: topic }
}

function searchTelegramRag(db, { query_embedding, ...args }, options = {}) {
  const scope = normalizeRagScope(args)
  const handle = db.getDb()
  // Coverage, legacy migration eligibility and every adaptive K query must
  // see one committed generation. WAL writers can publish concurrently, but
  // a later page cannot append new-revision spans to an earlier-revision row.
  // Query embedding is completed by the caller before entering this read tx.
  return handle.transaction(() => searchTelegramRagSnapshot(db, handle, query_embedding, scope, options)).deferred()
}

function searchTelegramRagSnapshot(db, handle, query_embedding, scope, options) {
  const source = db.getSource(scope.source_id)
  if (!source || source.platform !== 'telegram') throw new Error('Telegram source not found')
  const coverage = db.telegramRagIndexStatus(scope.source_id, { index_version: INDEX_VERSION })
  const legacy = db.hybridSearch({ ...scope, query_embedding, legacy_only: true })
    .filter(row => row._cos >= scope.min_cos)
    .map(row => ({ ...row, _index_mode: 'legacy_context', _matched_chunks: [], _freshness: 'unknown_legacy' }))
  const messages = new Map(legacy.map(row => [Number(row.id), row]))
  const annotatedRefs = new Map()
  let budget = Math.min(MAX_FRAGMENT_CANDIDATES, Math.max(32, scope.limit * 4))
  let fragmentRows = []
  let exhausted = false

  if (coverage.fragments_indexed > 0) {
    while (true) {
      fragmentRows = db.telegramSemanticChunkSearch({ ...scope, query_embedding, limit: budget, index_version: INDEX_VERSION })
      for (const row of fragmentRows) {
        if (row._cos < scope.min_cos) continue
        const id = Number(row.item_id)
        const match = {
          chunk_id: row.id, chunk_index: row.chunk_index,
          start_char: row.start_char, end_char: row.end_char,
          offset_unit: 'utf16_code_units', text: row.text,
          document_hash: row.document_hash,
          index_revision: row.indexed_revision,
          content_hash: row.indexed_content_hash,
          index_version: row.index_version,
          context_refs: (() => {
            const key = `${id}:${row.generation_id || row.document_hash}`
            if (!annotatedRefs.has(key)) {
              let refs = []
              try { refs = JSON.parse(row.context_refs_json || '[]') } catch {}
              annotatedRefs.set(key, options.annotateContextRefs
                ? options.annotateContextRefs({ ...row, id }, refs) : refs)
            }
            return annotatedRefs.get(key)
          })(),
          cos: row._cos,
        }
        const previous = messages.get(id)
        if (!previous || previous._cos < row._cos) {
          messages.set(id, {
            ...row, id, _cos: row._cos, _score: row._cos, _branches: ['vec'],
            _index_mode: 'telegram_fragments', _freshness: 'current_local_input',
            _matched_chunks: [match],
          })
        } else if (previous._index_mode === 'telegram_fragments' && previous._matched_chunks.length < 3 &&
                   !previous._matched_chunks.some(chunk => chunk.chunk_id === row.id)) {
          previous._matched_chunks.push(match)
        }
      }
      const ranked = [...messages.values()].sort((a, b) => b._cos - a._cos || Number(a.id) - Number(b.id))
      const weakest = ranked[scope.limit - 1]?._cos
      const last = fragmentRows[fragmentRows.length - 1]?._cos
      const complete = fragmentRows.length < budget || (last != null && last < scope.min_cos)
      // Ties at the kth-message boundary need another scoped page of candidates.
      if (complete || (ranked.length >= scope.limit && last != null && last < weakest)) break
      if (budget >= MAX_FRAGMENT_CANDIDATES) { exhausted = true; break }
      budget = Math.min(MAX_FRAGMENT_CANDIDATES, budget * 2)
    }
  }

  const rows = [...messages.values()]
    .sort((a, b) => b._cos - a._cos || Number(a.id) - Number(b.id))
    .slice(0, scope.limit)
  const chronology = handle.prepare(`
    SELECT MIN(published_at) AS first_item_at, MAX(published_at) AS last_item_at
    FROM items WHERE source_id = ?
  `).get(scope.source_id)
  return {
    rows, source, coverage, scope, chronology,
    diagnostics: {
      candidate_scope: 'source_date_topic_before_knn',
      fragment_candidates: fragmentRows.length, fragment_budget: budget,
      search_budget_exhausted: exhausted,
      ranking: 'maximum_fragment_cosine_per_message',
      score_is_probability: false,
      context_ref_roles_are_embedding_inputs_not_reply_proof: true,
    },
  }
}

module.exports = { MAX_FRAGMENT_CANDIDATES, dateBoundary, normalizeRagScope, searchTelegramRag }
