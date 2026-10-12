'use strict'

const { INDEX_VERSION, error, buildDocument, embeddingText, identity, timedRange, timecode, sha } = require('./boosty-rag-document')
const { dateBoundary } = require('./telegram-rag-search')

function integer(value, fallback, min, max, label) {
  const n = value == null ? fallback : Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw error('BOOSTY_INVALID_ARGUMENT', `${label} must be an integer ${min}..${max}`)
  return n
}

function source(db, id) {
  const value = db.getSource(integer(id, null, 1, Number.MAX_SAFE_INTEGER, 'source_id'))
  if (!value || value.platform !== 'boosty') throw error('BOOSTY_SOURCE_NOT_FOUND', 'Saved Boosty source not found')
  return value
}

function documents(db, sourceId) {
  const author = source(db, sourceId)
  // Keep the UI/account catalogue's existing post/video shape unchanged.
  const assets = db.getDb().prepare("SELECT * FROM items WHERE source_id=? AND type='boosty_asset' ORDER BY published_at DESC,id").all(author.id)
  return [...db.listBoostyItems(author.id), ...assets].filter(row => ['boosty_post', 'boosty_video', 'boosty_asset'].includes(row.type))
    .map(row => buildDocument(row, author, db.LIB_ROOT))
}

function document(db, itemId) {
  const row = db.getDb().prepare('SELECT * FROM items WHERE id = ?').get(integer(itemId, null, 1, Number.MAX_SAFE_INTEGER, 'item_id'))
  if (!row || !['boosty_post', 'boosty_video', 'boosty_asset'].includes(row.type)) throw error('BOOSTY_ITEM_NOT_FOUND', 'Saved Boosty post, child video or attachment not found')
  return buildDocument(row, source(db, row.source_id), db.LIB_ROOT)
}

function documentStatus(handle, doc) {
  if (doc.reason) return { state: 'missing', reason: doc.reason, fragments_total: 0, fragments_indexed: 0, staged: 0 }
  const generation = handle.prepare('SELECT * FROM boosty_rag_generations WHERE generation_id = ?').get(doc.generationId)
  const active = handle.prepare("SELECT * FROM boosty_rag_generations WHERE item_id = ? AND status = 'active'").get(doc.row.id)
  const indexed = generation?.status === 'active' && generation.index_version === INDEX_VERSION && generation.document_hash === doc.documentHash && generation.fragments_total === doc.chunks.length ? handle.prepare(`SELECT COUNT(*) AS n FROM semantic_chunks c
    JOIN semantic_chunks_vec v ON v.chunk_id = c.id AND v.source_id = c.source_id WHERE c.item_id = ? AND c.source_id = ? AND c.document_hash = ?`).get(doc.row.id, doc.row.source_id, doc.documentHash).n : 0
  const staged = generation?.status === 'staging' ? handle.prepare('SELECT COUNT(*) AS n FROM boosty_rag_staging WHERE generation_id = ? AND embedding IS NOT NULL').get(doc.generationId).n : 0
  return { state: indexed === doc.chunks.length ? 'ready_current' : staged > 0 ? 'partial' : active ? 'stale' : 'pending',
    fragments_total: doc.chunks.length, fragments_indexed: indexed, staged }
}

function coverage(handle, docs) {
  const totals = { known_posts: 0, known_interviews: 0, available_posts: 0, available_interviews: 0,
    ready_posts: 0, ready_interviews: 0, pending_posts: 0, pending_interviews: 0,
    missing_posts: 0, missing_interviews: 0, stale: 0, partial: 0, fragments_total: 0, fragments_indexed: 0, staged: 0 }
  Object.assign(totals, { known_assets: 0, available_assets: 0, ready_assets: 0, pending_assets: 0, missing_assets: 0 })
  const exceptions = []
  for (const doc of docs) {
    const unit = doc.kind === 'post' ? 'posts' : doc.kind === 'asset' ? 'assets' : 'interviews'
    const state = documentStatus(handle, doc)
    totals[`known_${unit}`]++
    if (doc.reason) {
      totals[`missing_${unit}`]++
      exceptions.push({ item_id: doc.row.id, type: doc.kind, reason: doc.reason })
      continue
    }
    totals[`available_${unit}`]++
    totals[state.state === 'ready_current' ? `ready_${unit}` : `pending_${unit}`]++
    if (state.state === 'stale' || state.state === 'partial') totals[state.state]++
    totals.fragments_total += state.fragments_total
    totals.fragments_indexed += state.fragments_indexed
    totals.staged += state.staged
  }
  return { ...totals, pending: totals.pending_posts + totals.pending_interviews + totals.pending_assets,
    asset_inventory_scope: 'saved_library_asset_rows_not_remote_full_assets_inventory',
    current_ready: totals.pending_posts + totals.pending_interviews + totals.pending_assets === 0 && totals.available_posts + totals.available_interviews + totals.available_assets > 0,
    all_known_texts_covered: totals.missing_posts + totals.missing_interviews + totals.missing_assets + totals.pending_posts + totals.pending_interviews + totals.pending_assets === 0,
    index_version: INDEX_VERSION, freshness: 'current_saved_originals_rehashed_this_request',
    remote_edits_or_access_checked: false, checked_at: new Date().toISOString(), exceptions }
}

function indexStatus(db, args) {
  return db.getDb().transaction(() => ({ source_id: source(db, args.source_id).id,
    ...coverage(db.getDb(), documents(db, args.source_id)) })).deferred()
}

function listSources(db, args = {}) {
  const limit = integer(args.limit, 100, 1, 500, 'limit'), offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
  const rows = db.listSources('boosty').filter(row => !args.query || `${row.handle} ${row.display_name}`.toLowerCase().includes(String(args.query).toLowerCase()))
  return { sources: rows.slice(offset, offset + limit).map(row => ({ source_id: row.id, handle: row.handle, title: row.display_name,
    url: `https://boosty.to/${encodeURIComponent(row.handle)}`, ...indexStatus(db, { source_id: row.id }) })),
    total: rows.length, has_more: offset + limit < rows.length, next_offset: offset + limit < rows.length ? offset + limit : null }
}

function listInterviews(db, args) {
  const docs = documents(db, args.source_id).filter(doc => doc.kind === 'transcript')
  const limit = integer(args.limit, 100, 1, 500, 'limit'), offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
  return { source_id: Number(args.source_id), total: docs.length,
    interviews: docs.slice(offset, offset + limit).map(doc => ({ ...identity(doc),
      duration_seconds: doc.row.duration_seconds || null, saved_text_available: !doc.reason,
      index: documentStatus(db.getDb(), doc), saved_access_state: doc.row.access_status || null })),
    has_more: offset + limit < docs.length, next_offset: offset + limit < docs.length ? offset + limit : null }
}

function listAssets(db, args) {
  const docs = documents(db, args.source_id).filter(doc => doc.kind === 'asset')
  const limit = integer(args.limit, 100, 1, 500, 'limit'), offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
  return { source_id: Number(args.source_id), total: docs.length,
    assets: docs.slice(offset, offset + limit).map(doc => ({ ...identity(doc), saved_text_available: !doc.reason,
      availability_reason: doc.reason, index: documentStatus(db.getDb(), doc) })),
    next_offset: offset + limit < docs.length ? offset + limit : null }
}

function validateSelection(db, args) {
  const author = source(db, args.source_id)
  if (args.limit != null) integer(args.limit, null, 1, 20000, 'limit')
  if (args.item_ids != null) {
    if (!Array.isArray(args.item_ids) || !args.item_ids.length || args.item_ids.length > 5000) throw error('BOOSTY_INVALID_SELECTION', 'item_ids must have 1..5000 entries')
    const ids = [...new Set(args.item_ids.map(id => integer(id, null, 1, Number.MAX_SAFE_INTEGER, 'item_id')))].sort((a, b) => a - b)
    const n = db.getDb().prepare(`SELECT COUNT(*) AS n FROM items WHERE source_id = ? AND type IN ('boosty_post','boosty_video','boosty_asset') AND id IN (${ids.map(() => '?')})`).get(author.id, ...ids).n
    if (n !== ids.length) throw error('BOOSTY_SELECTION_SOURCE_MISMATCH', 'Every selected item must belong to this saved Boosty source')
    return { source_id: author.id, item_ids: ids, limit: args.limit ?? null }
  }
  return { source_id: author.id, item_ids: null, limit: args.limit ?? null }
}

function prepareIndex(db, args, checkCancelled = () => {}) {
  const selected = validateSelection(db, args)
  const all = documents(db, args.source_id)
  const docs = all.filter(doc => selected.item_ids == null || selected.item_ids.includes(doc.row.id)).slice(0, selected.limit || all.length)
  const pending = [], ready = [], missing = []
  const h = db.getDb()
  for (const doc of docs) {
    checkCancelled()
    if (doc.reason) { missing.push({ item_id: doc.row.id, reason: doc.reason }); continue }
    if (documentStatus(h, doc).state === 'ready_current') { ready.push(doc.row.id); continue }
    h.transaction(() => {
      h.prepare("UPDATE boosty_rag_generations SET status='obsolete' WHERE item_id=? AND status='staging' AND generation_id!=?").run(doc.row.id, doc.generationId)
      h.prepare(`INSERT INTO boosty_rag_generations(generation_id,item_id,source_id,document_hash,index_version,fragments_total,status)
        VALUES(?,?,?,?,?,?,'staging') ON CONFLICT(generation_id) DO UPDATE SET status='staging'`).run(doc.generationId, doc.row.id, doc.row.source_id, doc.documentHash, INDEX_VERSION, doc.chunks.length)
      const reusable = h.prepare(`SELECT c.chunk_index,c.start_char,c.end_char,c.text,v.embedding FROM semantic_chunks c
        JOIN semantic_chunks_vec v ON v.chunk_id=c.id JOIN boosty_rag_generations g ON g.item_id=c.item_id AND g.document_hash=c.document_hash
        WHERE c.item_id=? AND g.status='active' AND g.index_version=?`).all(doc.row.id, INDEX_VERSION)
      const reuse = new Map(reusable.map(row => [row.chunk_index, row]))
      const insert = h.prepare('INSERT OR IGNORE INTO boosty_rag_staging(generation_id,chunk_index,chunk_json,embedding) VALUES(?,?,?,?)')
      for (const chunk of doc.chunks) {
        const old = reuse.get(chunk.chunk_index)
        const vector = old && old.text === chunk.text && old.start_char === chunk.start_char && old.end_char === chunk.end_char ? old.embedding : null
        insert.run(doc.generationId, chunk.chunk_index, JSON.stringify(chunk), vector)
      }
    }).immediate()
    const rows = h.prepare('SELECT chunk_index,chunk_json FROM boosty_rag_staging WHERE generation_id=? AND embedding IS NULL ORDER BY chunk_index').all(doc.generationId)
    pending.push({ doc, rows: rows.map(row => ({ generation_id: doc.generationId, item_id: doc.row.id,
      chunk_index: row.chunk_index, embedding_text: embeddingText(doc, JSON.parse(row.chunk_json)) })) })
  }
  return { docs, pending, ready, missing, fragments_pending: pending.reduce((n, entry) => n + entry.rows.length, 0) }
}

function saveBatch(db, rows, vectors) {
  const h = db.getDb()
  h.transaction(() => {
    const update = h.prepare(`UPDATE boosty_rag_staging SET embedding=? WHERE generation_id=? AND chunk_index=?
      AND generation_id IN (SELECT generation_id FROM boosty_rag_generations WHERE status='staging' AND index_version=?)`)
    rows.forEach((row, index) => {
      const vector = vectors[index]
      if (!(vector instanceof Float32Array) || vector.length !== 768 || [...vector].some(n => !Number.isFinite(n))) throw error('BOOSTY_INVALID_VECTOR', 'Embedding must contain 768 finite floats')
      const result = update.run(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), row.generation_id, row.chunk_index, INDEX_VERSION)
      if (result.changes !== 1) throw error('BOOSTY_GENERATION_SUPERSEDED', 'Boosty generation changed before embeddings were saved')
    })
  }).immediate()
}

function publish(db, desired) {
  const h = db.getDb()
  return h.transaction(() => {
    const current = document(db, desired.row.id)
    if (current.reason || current.generationId !== desired.generationId) throw error('BOOSTY_ORIGINAL_CHANGED', 'Saved original changed during indexing; repeat indexing to resume current texts')
    const staged = h.prepare('SELECT * FROM boosty_rag_staging WHERE generation_id=? ORDER BY chunk_index').all(desired.generationId)
    if (staged.length !== current.chunks.length || staged.some(row => !row.embedding)) return false
    const delVector = h.prepare('DELETE FROM semantic_chunks_vec WHERE chunk_id=?')
    for (const row of h.prepare('SELECT id FROM semantic_chunks WHERE item_id=?').all(current.row.id)) delVector.run(BigInt(row.id))
    h.prepare('DELETE FROM semantic_chunks WHERE item_id=?').run(current.row.id)
    const insert = h.prepare(`INSERT INTO semantic_chunks(item_id,source_id,chunk_index,start_char,end_char,start_seconds,end_seconds,
      position_approximate,text,document_hash,indexed_at) VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch())`)
    const vector = h.prepare('INSERT INTO semantic_chunks_vec(chunk_id,embedding,source_id) VALUES(?,?,?)')
    for (const entry of staged) {
      const chunk = JSON.parse(entry.chunk_json)
      const id = insert.run(current.row.id, current.row.source_id, chunk.chunk_index, chunk.start_char, chunk.end_char,
        chunk.start_seconds, chunk.end_seconds, 0, chunk.text, current.documentHash).lastInsertRowid
      vector.run(BigInt(id), entry.embedding, BigInt(current.row.source_id))
    }
    h.prepare("UPDATE boosty_rag_generations SET status='obsolete' WHERE item_id=? AND status='active'").run(current.row.id)
    h.prepare("UPDATE boosty_rag_generations SET status='active',published_at=unixepoch() WHERE generation_id=? AND status='staging'").run(current.generationId)
    h.prepare('DELETE FROM boosty_rag_staging WHERE generation_id=?').run(current.generationId)
    h.prepare("DELETE FROM boosty_rag_staging WHERE generation_id IN (SELECT generation_id FROM boosty_rag_generations WHERE item_id=? AND status='obsolete')").run(current.row.id)
    return true
  }).immediate()
}

function expected(doc, args, mandatory = false) {
  if ((mandatory || Number(args.offset || 0) > 0) && !args.expected_document_hash) throw error('BOOSTY_HASH_REQUIRED', 'expected_document_hash is required for continuation or context')
  if (args.expected_document_hash && args.expected_document_hash !== doc.documentHash) throw error('BOOSTY_ORIGINAL_CHANGED', 'Saved original changed; restart from the new document_hash, do not join versions')
  if (doc.reason) throw error('BOOSTY_TEXT_UNAVAILABLE', 'No saved text is available; this reader never downloads or transcribes')
}

function readOriginal(db, args) {
  const doc = document(db, args.item_id)
  expected(doc, args)
  const format = args.format || 'text'
  if (!['text', 'txt', 'srt'].includes(format)) throw error('BOOSTY_INVALID_FORMAT', 'format must be text, txt or srt')
  const text = format === 'srt' ? doc.rawSrt : format === 'txt' ? doc.rawTxt : doc.text
  if (text == null) throw error('BOOSTY_FORMAT_UNAVAILABLE', 'This saved original format is unavailable')
  const points = [...text]
  const offset = integer(args.offset, 0, 0, points.length, 'offset'), size = integer(args.max_chars, 12000, 1, 16000, 'max_chars')
  const end = Math.min(points.length, offset + size)
  return { ...identity(doc), format, original_hash: sha(text), offset_unit: 'unicode_codepoints', offset,
    content: points.slice(offset, end).join(''), returned_chars: end - offset, total_chars: points.length,
    truncated: end < points.length, next_offset: end < points.length ? end : null }
}

function passage(doc, chunk) {
  const prepared = doc.chunks[chunk.chunk_index]
  const range = timedRange(doc, chunk)
  return { chunk_id: chunk.id ?? null, chunk_index: chunk.chunk_index,
    text: doc.text.slice(chunk.start_char, chunk.end_char), start_char: chunk.start_char, end_char: chunk.end_char,
    offset_unit: 'utf16_code_units', document_hash: doc.documentHash, generation_id: doc.generationId,
    representation: prepared?.representation || null,
    ...(doc.kind === 'asset' ? { pdf_pages: [...doc.text.slice(0, chunk.end_char).matchAll(/\[PDF page (\d+)\]/g)]
      .filter((m, i, list) => m.index >= chunk.start_char || i === list.findLastIndex(v => v.index <= chunk.start_char))
      .map(m => Number(m[1])).filter(page => doc.assetPages.includes(page)) } : {}),
    time_accuracy: range ? 'saved_cue_exact_not_audio_verified' : 'unavailable',
    time_alignment: range?.basis || 'unavailable',
    aligned_srt_span: range?.aligned_start_char != null ? { start_char: range.aligned_start_char, end_char: range.aligned_end_char,
      offset_unit: 'utf16_code_units' } : null,
    cue_start: range?.first ?? null, cue_end: range?.last ?? null,
    start_seconds: range ? doc.cues[range.first].start_seconds : null,
    end_seconds: range ? doc.cues[range.last].end_seconds : null,
    timecode: range ? timecode(doc.cues[range.first].start_seconds) : null }
}

function context(db, args) {
  const doc = document(db, args.item_id)
  expected(doc, args, true)
  const maxChars = integer(args.max_chars, 12000, 128, 16000, 'max_chars')
  let anchor = null
  if (args.chunk_index != null) {
    const idx = integer(args.chunk_index, null, 0, Math.max(0, doc.chunks.length - 1), 'chunk_index')
    anchor = doc.chunks[idx]
  }
  const alignment = anchor ? timedRange(doc, anchor) : null
  if (doc.cues.length && (args.cue_index != null || alignment)) {
    const index = args.cue_index != null ? integer(args.cue_index, null, 0, doc.cues.length - 1, 'cue_index')
      : alignment?.first
    if (index == null) throw error('BOOSTY_CONTEXT_ANCHOR_REQUIRED', 'cue_index or chunk_index is required')
    const before = integer(args.before_cues, 8, 0, 100, 'before_cues'), after = integer(args.after_cues, 25, 0, 100, 'after_cues')
    const first = Math.max(0, index - before), last = Math.min(doc.cues.length - 1, (alignment?.last ?? index) + after)
    const cues = [], points = []
    let remaining = maxChars
    for (const cue of doc.cues.slice(first, last + 1)) {
      const value = [...cue.text]
      if (value.length > remaining && cues.length) break
      // A single abnormally long cue is paged separately through original.
      const shown = value.slice(0, remaining).join('')
      cues.push({ ...cue, text: shown, truncated: value.length > remaining })
      points.push(shown)
      remaining -= Math.min(value.length, remaining) + 1
      if (remaining <= 0) break
    }
    const end = cues.at(-1)?.cue_index ?? first - 1
    return { ...identity(doc), relation: 'chronological_same_video_not_verified_question_answer_or_speaker',
      anchor: anchor ? passage(doc, anchor) : null, cues, text: points.join('\n'),
      requested_cue_start: first, requested_cue_end: last,
      truncated: end < last || cues.some(cue => cue.truncated),
      next_cue_index: cues.at(-1)?.truncated ? end : end < last ? end + 1 : null,
      next_offset: cues.at(-1)?.truncated ? [...doc.text.slice(0, cues.at(-1).start_char + cues.at(-1).text.length)].length : null,
      question_answer_completeness: 'inspect_or_extend_context_not_inferred' }
  }
  if (!anchor) throw error('BOOSTY_CONTEXT_ANCHOR_REQUIRED', 'chunk_index is required for untimed text')
  const before = integer(args.before_chars, 2000, 0, 8000, 'before_chars')
  const start = Math.max(0, anchor.start_char - before), end = Math.min(doc.text.length, start + maxChars)
  return { ...identity(doc), anchor: passage(doc, anchor), text: doc.text.slice(start, end), cues: [],
    start_char: start, end_char: end, offset_unit: 'utf16_code_units', truncated: end < doc.text.length,
    relation: 'same_saved_text_no_timecode', next_offset: [...doc.text.slice(0, end)].length }
}

function normalizeSearch(args) {
  const ids = args.source_ids ?? (args.source_id != null ? [args.source_id] : null)
  if (!Array.isArray(ids) || !ids.length || ids.length > 20) throw error('BOOSTY_SCOPE_REQUIRED', 'Explicit source_id or source_ids (1..20) is required')
  const sourceIds = [...new Set(ids.map(id => integer(id, null, 1, Number.MAX_SAFE_INTEGER, 'source_id')))]
  if (args.source_id != null && !sourceIds.includes(Number(args.source_id))) throw error('BOOSTY_SCOPE_CONFLICT', 'source_id must agree with source_ids')
  const types = args.types ?? ['transcript']
  if (!Array.isArray(types) || !types.length || types.some(type => !['transcript', 'post', 'asset'].includes(type))) throw error('BOOSTY_INVALID_TYPES', 'types must contain transcript, post and/or asset')
  const limit = integer(args.limit, 10, 1, 100, 'limit'), budget = integer(args.budget, 1000, 1, 10000, 'budget')
  const minCos = args.min_cos ?? 0.4
  if (typeof minCos !== 'number' || !Number.isFinite(minCos) || minCos < -1 || minCos > 1) throw error('BOOSTY_INVALID_ARGUMENT', 'min_cos must be -1..1')
  const from = dateBoundary(args.date_from), to = dateBoundary(args.date_to, { end: true })
  if (from != null && to != null && from > to) throw error('BOOSTY_INVALID_DATE_RANGE', 'date_from must not follow date_to')
  const groupBy = args.group_by ?? 'interview'
  if (!['interview', 'post'].includes(groupBy)) throw error('BOOSTY_INVALID_ARGUMENT', 'group_by must be interview or post')
  return { source_ids: sourceIds, types: [...new Set(types)], limit, budget, min_cos: minCos, date_from: from, date_to: to, group_by: groupBy }
}

function search(db, { query_embedding, ...args }) {
  const scope = normalizeSearch(args), h = db.getDb()
  const vector = new Float32Array(query_embedding)
  if (vector.length !== 768 || [...vector].some(n => !Number.isFinite(n))) throw error('BOOSTY_INVALID_VECTOR', 'Query embedding must contain 768 finite floats')
  return h.transaction(() => {
    const all = scope.source_ids.flatMap(id => documents(db, id))
    const eligible = all.filter(doc => !doc.reason && scope.types.includes(doc.kind) &&
      (scope.date_from == null || doc.row.published_at >= scope.date_from) &&
      (scope.date_to == null || doc.row.published_at <= scope.date_to) && documentStatus(h, doc).state === 'ready_current')
    const ids = eligible.map(doc => doc.row.id), byId = new Map(eligible.map(doc => [doc.row.id, doc]))
    const groups = new Map()
    let rows = [], candidates = 0, budgetUsed = Math.min(scope.budget, Math.max(32, scope.limit * 4)), exhausted = false
    if (ids.length) while (true) {
      const partition = scope.source_ids.length === 1 ? 'AND source_id=?' : ''
      rows = h.prepare(`SELECT c.*,v.distance FROM (SELECT chunk_id,distance FROM semantic_chunks_vec
        WHERE embedding MATCH ? AND k=? ${partition} AND chunk_id IN (
          SELECT c.id FROM semantic_chunks c JOIN boosty_rag_generations g ON g.item_id=c.item_id
          AND g.document_hash=c.document_hash WHERE g.status='active' AND g.index_version=? AND c.item_id IN (${ids.map(() => '?')})
        )) v JOIN semantic_chunks c ON c.id=v.chunk_id ORDER BY v.distance,c.item_id,c.chunk_index`).all(
        Buffer.from(vector.buffer), budgetUsed, ...(partition ? [BigInt(scope.source_ids[0])] : []), INDEX_VERSION, ...ids)
      candidates = rows.length
      for (const row of rows) {
        const cos = 1 - row.distance * row.distance / 2
        if (cos < scope.min_cos) continue
        const doc = byId.get(row.item_id)
        const key = scope.group_by === 'post' ? `${doc.row.source_id}:${doc.postId}` : String(row.item_id)
        if (!groups.has(key)) groups.set(key, { ...identity(doc), cos, matches: [], group_id: key })
        const group = groups.get(key)
        if (group.matches.length < 3 && !group.matches.some(match => match.chunk_id === row.id)) group.matches.push({ ...identity(doc), ...passage(doc, row), cos })
      }
      const ranked = [...groups.values()].sort((a, b) => b.cos - a.cos || a.item_id - b.item_id)
      const weakest = ranked[scope.limit - 1]?.cos, tail = rows.length ? 1 - rows.at(-1).distance ** 2 / 2 : null
      if (rows.length < budgetUsed || (tail != null && tail < scope.min_cos) || (ranked.length >= scope.limit && tail < weakest)) break
      if (budgetUsed >= scope.budget) { exhausted = true; break }
      budgetUsed = Math.min(scope.budget, budgetUsed * 2)
    }
    const results = [...groups.values()].sort((a, b) => b.cos - a.cos || a.item_id - b.item_id).slice(0, scope.limit)
    // Re-publications/translations are not independent interviews just because
    // their child IDs differ. Only assert what this response proves: identical
    // non-whitespace passages among RETURNED hits, not whole-video equivalence.
    const passageCopies = new Map()
    for (const hit of results.flatMap(result => result.matches)) {
      const normalised = hit.text.replace(/\s/gu, '')
      if (normalised.length < 80) continue
      const hash = sha(normalised)
      if (!passageCopies.has(hash)) passageCopies.set(hash, [])
      passageCopies.get(hash).push(hit)
    }
    for (const copies of passageCopies.values()) {
      if (new Set(copies.map(hit => hit.item_id)).size < 2) continue
      for (const hit of copies) hit.duplicate_passage_refs = copies.filter(other => other.item_id !== hit.item_id).map(other => ({
        item_id: other.item_id, post_external_id: other.post_external_id, canonical_url: other.canonical_url,
        document_hash: other.document_hash, chunk_index: other.chunk_index,
        relation: 'exact_non_whitespace_passage_copy_candidate_not_verified_same_recording',
      }))
    }
    // Files can be changed outside SQLite. Check returned originals again so
    // an edit between eligibility and ranking cannot yield a mixed-version hit.
    for (const hit of results.flatMap(result => result.matches)) {
      if (document(db, hit.item_id).documentHash !== hit.document_hash) throw error('BOOSTY_ORIGINAL_CHANGED', 'An original changed during search; retry this read-only query')
    }
    return { query: args.query || '', scope, results, returned: results.length,
      coverage: coverage(h, all), eligible_documents: eligible.length,
      diagnostics: { candidate_scope: 'source_date_type_current_saved_hash_profile_before_knn',
        fragment_candidates: candidates, fragment_budget: budgetUsed, search_budget_exhausted: exhausted,
        limit_unit: scope.group_by, ranking: 'maximum_fragment_cosine_not_probability',
        indexed_corpus_is_not_exhaustive_study: true, speakers_and_salary_not_inferred: true,
        duplicate_detection_scope: 'returned_passages_only_not_full_near_duplicate_audit',
        unique_resource_ids_are_not_independent_interviews: true } }
  }).deferred()
}

function performRead(db, action, args) {
  try {
    const fn = { sources: listSources, interviews: listInterviews, assets: listAssets, status: indexStatus,
      validate: validateSelection, original: readOriginal, context, search }[action]
    if (!fn) throw error('BOOSTY_UNKNOWN_OPERATION', 'Unknown Boosty saved-text operation')
    return { ok: true, ...fn(db, args) }
  } catch (e) { return { ok: false, code: e.code || 'BOOSTY_RAG_ERROR', error: e.message } }
}

module.exports = { INDEX_VERSION, integer, source, documents, document, documentStatus, coverage, indexStatus,
  listSources, listInterviews, listAssets, validateSelection, prepareIndex, saveBatch, publish, readOriginal, passage, context,
  normalizeSearch, search, performRead }
