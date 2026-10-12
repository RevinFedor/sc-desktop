'use strict'

const crypto = require('node:crypto')
const { MODEL, OUTPUT_DIM } = require('./embedder')
const { normalizeItemIds } = require('./index-worker-protocol')

// Count bytes rather than estimating language-dependent tokens. Even the
// byte-fallback representation fits below Gemini's 2048-token input ceiling.
// The whole target fragment goes first; quoted context can never displace it.
const INDEX_VERSION = `telegram-context-fragments-v1:${MODEL}:${OUTPUT_DIM}:unit-l2`
const MAX_EMBEDDING_BYTES = 1900
const TARGET_BYTES = 1360
const OVERLAP_BYTES = 160
const CONTEXT_BYTES = 400
const PREVIOUS_MESSAGES = 5
const REPLY_DEPTH = 3
const CONTEXT_WINDOW_SECONDS = 86_400
const PAGE_SIZE = 100

function utf8Bytes(value) { return Buffer.byteLength(String(value || ''), 'utf8') }

function prefixByBytes(value, budget) {
  let result = ''
  let bytes = 0
  for (const point of String(value || '')) {
    const size = utf8Bytes(point)
    if (bytes + size > budget) break
    result += point
    bytes += size
  }
  return result
}

function captionUnits(text, maxBytes) {
  const units = []
  const segments = new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)
  for (const entry of segments) {
    if (utf8Bytes(entry.segment) <= maxBytes) {
      units.push({ start: entry.index, end: entry.index + entry.segment.length, bytes: utf8Bytes(entry.segment) })
      continue
    }
    // An adversarial combining cluster may be larger than an entire input.
    // Fall back to Unicode scalar boundaries, never half a surrogate pair.
    let offset = entry.index
    for (const point of entry.segment) {
      units.push({ start: offset, end: offset + point.length, bytes: utf8Bytes(point) })
      offset += point.length
    }
  }
  return units
}

function splitCaption(value, { targetBytes = TARGET_BYTES, overlapBytes = OVERLAP_BYTES } = {}) {
  const text = String(value || '')
  if (!text.trim()) return []
  const budget = Math.max(64, Math.min(TARGET_BYTES, Math.floor(Number(targetBytes) || TARGET_BYTES)))
  const overlap = Math.max(0, Math.min(budget / 3, Math.floor(Number(overlapBytes) || 0)))
  const units = captionUnits(text, budget)
  const chunks = []
  let start = 0
  while (start < units.length) {
    let end = start
    let bytes = 0
    while (end < units.length && bytes + units[end].bytes <= budget) bytes += units[end++].bytes
    if (end === start) throw new Error('Telegram fragment cannot fit one Unicode scalar')
    // Prefer a nearby paragraph/word boundary without leaving an unindexed gap.
    if (end < units.length) {
      const floor = start + Math.floor((end - start) * 0.75)
      for (let point = end - 1; point >= floor; point--) {
        if (/\s/u.test(text.slice(units[point].start, units[point].end))) {
          end = point + 1
          break
        }
      }
    }
    const startChar = units[start].start
    const endChar = units[end - 1].end
    chunks.push({
      chunk_index: chunks.length,
      start_char: startChar,
      end_char: endChar,
      start_seconds: null,
      end_seconds: null,
      position_approximate: false,
      text: text.slice(startChar, endChar),
    })
    if (end === units.length) break
    let next = end
    let carried = 0
    while (next > start + 1 && carried + units[next - 1].bytes <= overlap) carried += units[--next].bytes
    start = next
  }
  return chunks
}

function normalisedTopic(row) {
  const number = Number(row?.topic_id)
  return Number.isSafeInteger(number) && number > 0 ? number : 0
}

function isTopicAnchor(row, topicId) {
  return (topicId > 0 && String(row?.external_id) === String(topicId)) ||
    (row?.type === 'other' && !String(row?.caption || '').trim())
}

function replyRawMeta(row) {
  try {
    const raw = typeof row?.raw_meta_json === 'string' ? JSON.parse(row.raw_meta_json) : row?.raw_meta_json
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}

function replyParentCandidate(row) {
  const raw = replyRawMeta(row)
  const reply = raw.telegram_reply
  const parent = row?.parent_external_id == null ? null : String(row.parent_external_id)
  if (!parent || raw.external_reply || parent === String(normalisedTopic(row))) return null
  const source = reply?.source_peer, target = reply?.target_peer
  if (source && target && (source.kind !== target.kind || String(source.id) !== String(target.id))) return null
  // Preserve old bounded candidate paths, without claiming their peer was
  // checked. Only new explicit provenance can reject/prove that relation.
  if (!reply || reply.version !== 1) return parent
  if (reply.scope !== 'same_peer' || String(reply.message_id) !== parent) return null
  return parent
}

function ancestorCandidates(row, candidates = []) {
  const result = []
  const guardRefs = []
  let cursor = row
  const seen = new Set([String(row.external_id)])
  for (const candidate of candidates.slice(0, REPLY_DEPTH)) {
    const parent = replyParentCandidate(cursor)
    if (!parent || seen.has(parent) || candidate?.source_id !== row.source_id || String(candidate.external_id) !== parent) break
    if (isTopicAnchor(candidate, normalisedTopic(row))) {
      // Exclusion is still an input decision. An empty service row can later
      // acquire text, even days before its replying target. Keep the existing
      // row as a dependency without adding its text or a fabricated reply.
      guardRefs.push(itemReference(candidate, 'excluded_reply_guard'))
      break
    }
    result.push(candidate)
    seen.add(parent)
    cursor = candidate
  }
  return { ancestors: result, guardRefs }
}

function eligibleAncestors(row, candidates = []) {
  return ancestorCandidates(row, candidates).ancestors
}

function itemContentHash(row) {
  const raw = replyRawMeta(row)
  return crypto.createHash('sha256').update(JSON.stringify({
    source_id: row.source_id,
    external_id: String(row.external_id),
    caption: String(row.caption || ''),
    sender: row.sender ?? null,
    type: row.type ?? null,
    published_at: row.published_at ?? null,
    topic_id: normalisedTopic(row),
    parent_external_id: row.parent_external_id ?? null,
    ...(Object.hasOwn(raw, 'telegram_reply') ? { telegram_reply: raw.telegram_reply ?? null } : {}),
    ...(Object.hasOwn(raw, 'external_reply') ? { external_reply: raw.external_reply ?? null } : {}),
  })).digest('hex')
}

function itemReference(row, role) {
  return {
    source_id: row.source_id,
    item_id: row.id,
    external_id: String(row.external_id),
    local_revision: Number(row.local_revision) || 1,
    content_hash: itemContentHash(row),
    role,
  }
}

function selectedContext(row, { ancestors = [], priors = [] } = {}) {
  const entries = []
  const seen = new Set([String(row.id)])
  let budget = CONTEXT_BYTES
  const append = (candidate, role, perMessageBytes) => {
    if (!candidate || candidate.source_id !== row.source_id || seen.has(String(candidate.id))) return
    if (isTopicAnchor(candidate, normalisedTopic(row))) return
    seen.add(String(candidate.id))
    const caption = String(candidate.caption || '')
    if (!caption.trim()) return
    const header = `${role} #${String(candidate.external_id)}: `
    const allowed = Math.min(perMessageBytes, budget - utf8Bytes(header) - 1)
    if (allowed <= 0) return
    const text = prefixByBytes(caption, allowed)
    if (!text) return
    entries.push({
      ...itemReference(candidate, role),
      item_id: candidate.id,
      external_id: String(candidate.external_id),
      topic_id: normalisedTopic(candidate),
      role,
      text,
      header,
    })
    budget -= utf8Bytes(header + text + '\n')
  }
  // A delayed explicit reply remains discoverable even when its parent is not
  // among yesterday's neighbors. It gets priority over chronological guesses.
  eligibleAncestors(row, ancestors).forEach(parent => append(parent, 'reply', 180))
  priors.slice(-PREVIOUS_MESSAGES).reverse().forEach(prior => {
    if (normalisedTopic(prior) === normalisedTopic(row)) append(prior, 'prior', 110)
  })
  return entries
}

function buildTelegramDocument(row, context = {}, { model = MODEL } = {}) {
  const candidates = ancestorCandidates(row, context.ancestors || [])
  const guards = new Map()
  for (const ref of [...(context.guardRefs || []), ...candidates.guardRefs]) {
    if (ref?.source_id === row.source_id && ref.item_id != null) guards.set(`${ref.source_id}:${ref.external_id}`, ref)
  }
  const guardRefs = [...guards.values()]
  context = { ...context, ancestors: candidates.ancestors }
  const chunks = splitCaption(row.caption)
  const selected = selectedContext(row, context)
  const sender = prefixByBytes(row.sender, 64)
  const contextText = selected.map(entry => entry.header + entry.text).join('\n')
  const embeddingTexts = chunks.map(chunk => {
    const header = `message #${String(row.external_id)}${sender ? ` by ${sender}` : ''}:\n`
    const text = header + chunk.text + (contextText ? `\nquoted context:\n${contextText}` : '')
    if (utf8Bytes(text) > MAX_EMBEDDING_BYTES) throw new Error('Telegram embedding input exceeds byte budget')
    return text
  })
  const fingerprint = {
    version: INDEX_VERSION,
    model,
    task_type: 'RETRIEVAL_DOCUMENT',
    target_bytes: TARGET_BYTES,
    overlap_bytes: OVERLAP_BYTES,
    context_bytes: CONTEXT_BYTES,
    item_id: row.id,
    source_id: row.source_id,
    external_id: String(row.external_id),
    topic_id: normalisedTopic(row),
    parent_external_id: row.parent_external_id ?? null,
    sender,
    caption: String(row.caption || ''),
    target_ref: itemReference(row, 'target'),
    context: selected,
    relation_refs: (context.ancestors || []).map(parent => itemReference(parent, 'reply-link')),
    missing_refs: context.missingRefs || [],
  }
  const unguardedHash = crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex')
  // Do not add an empty key: all already-published inputs that never encounter
  // an excluded existing parent retain byte-identical fingerprints.
  if (guardRefs.length) fingerprint.excluded_reply_guards = guardRefs
  return {
    documentHash: guardRefs.length ? crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex') : unguardedHash,
    ...(guardRefs.length ? { unguardedDocumentHash: unguardedHash } : {}),
    chunks,
    embeddingTexts,
    context: selected,
    targetReference: itemReference(row, 'target'),
    contextRefs: [
      ...selected.map(({ source_id, item_id, external_id, local_revision, content_hash, role }) => ({ source_id, item_id, external_id, local_revision, content_hash, role })),
      ...(context.ancestors || []).filter(parent => !selected.some(entry => entry.item_id === parent.id)).map(parent => itemReference(parent, 'reply-link')),
      ...(context.missingRefs || []),
      ...guardRefs,
    ],
  }
}

function snapshotSource(handle, sourceId, limit, itemIds) {
  handle.exec('DROP TABLE IF EXISTS temp.telegram_rag_source')
  handle.exec('DROP TABLE IF EXISTS temp.telegram_rag_targets')
  handle.exec('DROP TABLE IF EXISTS temp.telegram_rag_pending')
  handle.exec('DROP TABLE IF EXISTS temp.telegram_rag_run_generations')
  handle.exec('DROP TABLE IF EXISTS temp.telegram_rag_requested_items')
  if (itemIds != null) {
    handle.exec('CREATE TEMP TABLE telegram_rag_requested_items(item_id INTEGER PRIMARY KEY)')
    const insert = handle.prepare('INSERT INTO telegram_rag_requested_items(item_id) VALUES (?)')
    for (const id of itemIds) insert.run(id)
    const unavailable = handle.prepare(`
      SELECT COUNT(*) AS n FROM telegram_rag_requested_items wanted
      LEFT JOIN items i ON i.id = wanted.item_id WHERE i.id IS NULL
    `).get().n
    if (unavailable) throw new Error('itemIds contain unavailable local items')
    const otherSources = handle.prepare(`
      SELECT COUNT(*) AS n FROM telegram_rag_requested_items wanted
      JOIN items i ON i.id = wanted.item_id WHERE i.source_id != ?
    `).get(sourceId).n
    if (otherSources) throw new Error('itemIds contain local items outside the requested source')
  }
  // This source-only SQLite snapshot keeps captions out of main-thread RAM
  // and gives target/parent/prior reads one consistent view during this run.
  handle.prepare(`
    CREATE TEMP TABLE telegram_rag_source AS
    SELECT i.id, i.source_id, i.external_id, CAST(i.external_id AS INTEGER) AS message_order,
           i.caption, i.sender, i.type, i.published_at, i.topic_id,
           COALESCE(i.topic_id, 0) AS normalised_topic, i.parent_external_id, i.raw_meta_json,
           COALESCE(r.local_revision, 1) AS local_revision
      FROM items i LEFT JOIN telegram_rag_item_state r ON r.item_id = i.id
     WHERE i.source_id = ?
  `).run(sourceId)
  handle.exec(`
    CREATE UNIQUE INDEX temp.telegram_rag_source_id ON telegram_rag_source(id);
    CREATE UNIQUE INDEX temp.telegram_rag_source_external ON telegram_rag_source(external_id);
    CREATE INDEX temp.telegram_rag_source_prior ON telegram_rag_source(normalised_topic, published_at, message_order, id);
    CREATE TEMP TABLE telegram_rag_targets(seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL UNIQUE);
    CREATE TEMP TABLE telegram_rag_run_generations(seq INTEGER PRIMARY KEY AUTOINCREMENT, generation_id TEXT NOT NULL UNIQUE, item_id INTEGER NOT NULL, pending_fragments INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 0);
    CREATE TEMP TABLE telegram_rag_pending(seq INTEGER PRIMARY KEY AUTOINCREMENT, generation_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, item_id INTEGER NOT NULL, embedding_text TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, UNIQUE(generation_id, chunk_index));
  `)
  // Do not let existing legacy vectors remove messages from the target set.
  // They do not fingerprint edited captions or later transcriptions.
  const sql = `
    INSERT INTO telegram_rag_targets(item_id)
    SELECT i.id FROM telegram_rag_source i
     WHERE ((i.caption IS NOT NULL AND length(trim(i.caption)) > 0)
        OR EXISTS (SELECT 1 FROM semantic_chunks c WHERE c.item_id = i.id))
       ${itemIds != null ? 'AND i.id IN (SELECT item_id FROM telegram_rag_requested_items)' : ''}
     ORDER BY i.published_at DESC, i.message_order DESC, i.id DESC
     ${limit ? 'LIMIT ?' : ''}
  `
  if (limit) handle.prepare(sql).run(limit)
  else handle.prepare(sql).run()
}

function createContextReader(handle, { live = false } = {}) {
  const table = live ? 'items' : 'telegram_rag_source'
  const topic = live ? 'COALESCE(i.topic_id, 0)' : 'i.normalised_topic'
  const order = live ? 'CAST(i.external_id AS INTEGER)' : 'i.message_order'
  const projection = live ? 'i.*, COALESCE(r.local_revision, 1) AS local_revision' : 'i.*'
  const join = live ? 'LEFT JOIN telegram_rag_item_state r ON r.item_id = i.id' : ''
  const byExternal = handle.prepare(`SELECT ${projection} FROM ${table} i ${join} WHERE i.source_id = ? AND i.external_id = ?`)
  const prior = handle.prepare(`
    SELECT ${projection} FROM ${table} i ${join}
     WHERE i.source_id = ? AND ${topic} = ? AND i.caption IS NOT NULL AND length(trim(i.caption)) > 0
       AND i.published_at >= ?
       AND (i.published_at < ? OR (i.published_at = ? AND
            (${order} < ? OR (${order} = ? AND i.id < ?))))
     ORDER BY i.published_at DESC, ${order} DESC, i.id DESC LIMIT ?
  `)
  return row => {
    const ancestors = []
    const missingRefs = []
    const guardRefs = []
    const seen = new Set([String(row.external_id)])
    let parentId = replyParentCandidate(row)
    while (parentId != null && ancestors.length < REPLY_DEPTH) {
      const key = String(parentId)
      if (seen.has(key)) break
      seen.add(key)
      const parent = byExternal.get(row.source_id, key)
      if (!parent || parent.source_id !== row.source_id) {
        missingRefs.push({ source_id: row.source_id, external_id: key, item_id: null, local_revision: null, content_hash: null, role: 'missing_reply' })
        break
      }
      if (isTopicAnchor(parent, normalisedTopic(row))) {
        guardRefs.push(itemReference(parent, 'excluded_reply_guard'))
        break
      }
      ancestors.push(parent)
      parentId = replyParentCandidate(parent)
    }
    const priors = row.published_at == null ? [] : prior.all(
      row.source_id, normalisedTopic(row), Number(row.published_at) - CONTEXT_WINDOW_SECONDS,
      row.published_at, row.published_at, Number(row.external_id), Number(row.external_id),
      row.id, PREVIOUS_MESSAGES,
    ).reverse()
    return { ancestors, priors, missingRefs, guardRefs }
  }
}

function normalisedReferences(refs) {
  return (refs || []).map(ref => ({
    source_id: Number(ref.source_id), item_id: ref.item_id == null ? null : Number(ref.item_id),
    external_id: String(ref.external_id),
    local_revision: ref.item_id == null ? null : Number(ref.local_revision || 1),
    content_hash: ref.item_id == null ? null : String(ref.content_hash), role: String(ref.role || 'context'),
  }))
}

function guardOnlyVectorReuseProof(db, sourceId, itemId, document, expectedGenerationId = null) {
  if (!document?.unguardedDocumentHash || !document.contextRefs.some(ref => ref.role === 'excluded_reply_guard')) return null
  const handle = db.getDb()
  const active = handle.prepare(`
    SELECT g.* FROM telegram_rag_item_state r
      JOIN telegram_rag_generations g ON g.generation_id = r.active_generation_id
     WHERE r.item_id = ? AND g.item_id = ? AND g.source_id = ? AND g.status = 'active'
  `).get(itemId, itemId, sourceId)
  if (!active || (expectedGenerationId && active.generation_id !== expectedGenerationId) ||
      active.index_version !== INDEX_VERSION || active.input_hash !== document.unguardedDocumentHash ||
      active.target_content_hash !== document.targetReference.content_hash ||
      Number(active.target_revision) !== document.targetReference.local_revision) return null
  let storedRefs
  try { storedRefs = JSON.parse(active.context_refs_json) } catch { return null }
  if (!Array.isArray(storedRefs)) return null
  const unchangedRefs = normalisedReferences(document.contextRefs.filter(ref => ref.role !== 'excluded_reply_guard'))
  if (JSON.stringify(unchangedRefs) !== JSON.stringify(storedRefs)) return null
  const chunks = handle.prepare(`
    SELECT c.*, v.embedding FROM semantic_chunks c
    LEFT JOIN semantic_chunks_vec v ON v.chunk_id = c.id AND v.source_id = c.source_id
     WHERE c.item_id = ? AND c.source_id = ? AND c.document_hash = ?
     ORDER BY c.chunk_index
  `).all(itemId, sourceId, active.input_hash)
  if (chunks.length !== document.chunks.length || chunks.length !== Number(active.fragments_total)) return null
  for (let index = 0; index < chunks.length; index++) {
    const old = chunks[index], current = document.chunks[index]
    if (Number(old.chunk_index) !== current.chunk_index || old.start_char !== current.start_char ||
        old.end_char !== current.end_char || old.text !== current.text ||
        (old.start_seconds ?? null) !== (current.start_seconds ?? null) ||
        (old.end_seconds ?? null) !== (current.end_seconds ?? null) ||
        Boolean(old.position_approximate) !== Boolean(current.position_approximate) ||
        !Buffer.isBuffer(old.embedding) || old.embedding.byteLength !== OUTPUT_DIM * 4) return null
    for (let n = 0; n < OUTPUT_DIM; n++) if (!Number.isFinite(old.embedding.readFloatLE(n * 4))) return null
  }
  return { generationId: active.generation_id, chunks }
}

function reuseExcludedReplyGuardVectors(db, sourceId, itemId, generationId, document) {
  const handle = db.getDb()
  return handle.transaction(() => {
    const proof = guardOnlyVectorReuseProof(db, sourceId, itemId, document)
    if (!proof) return { reused: false, saved: 0 }
    const rows = proof.chunks.map(chunk => {
      const embedding = new Float32Array(OUTPUT_DIM)
      for (let n = 0; n < OUTPUT_DIM; n++) embedding[n] = chunk.embedding.readFloatLE(n * 4)
      return { chunk_index: chunk.chunk_index, embedding }
    })
    const saved = db.saveTelegramRagGenerationVectors(generationId, rows)
    if (saved.obsolete) return { reused: false, saved: 0 }
    return { reused: true, saved: saved.saved, fromGenerationId: proof.generationId }
  }).immediate()
}

/** Read-only, source-scoped page for the pre-guard active-generation audit. */
function detectTelegramExcludedReplyGuards(db, { sourceId, afterItemId = 0, limit = 500 } = {}) {
  const sid = Number(sourceId), after = Number(afterItemId), count = Number(limit)
  if (!Number.isSafeInteger(sid) || sid <= 0) throw new Error('sourceId required')
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('afterItemId must be a nonnegative local item ID')
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error('limit must be an integer from 1 to 1000')
  const source = db.getSource(sid)
  if (!source || source.platform !== 'telegram') throw new Error(`Telegram source #${sid} not found`)
  const handle = db.getDb()
  return handle.transaction(() => {
    const rows = handle.prepare(`
      SELECT i.id, i.source_id, i.external_id, i.parent_external_id, i.topic_id, i.raw_meta_json,
             g.generation_id, g.input_hash, g.context_refs_json, g.index_version
        FROM items i JOIN telegram_rag_item_state r ON r.item_id = i.id
        JOIN telegram_rag_generations g ON g.generation_id = r.active_generation_id
       WHERE i.source_id = ? AND i.id > ? AND g.status = 'active'
       ORDER BY i.id LIMIT ?
    `).all(sid, after, count + 1)
    const scanned = rows.slice(0, count)
    const byExternal = handle.prepare(`
      SELECT i.*, COALESCE(r.local_revision, 1) AS local_revision FROM items i
      LEFT JOIN telegram_rag_item_state r ON r.item_id = i.id
       WHERE i.source_id = ? AND i.external_id = ?
    `)
    const details = []
    let candidates = 0
    for (const row of scanned) {
      let storedRefs
      try { storedRefs = JSON.parse(row.context_refs_json) } catch { storedRefs = [] }
      if (!Array.isArray(storedRefs)) storedRefs = []
      const referenced = new Set(storedRefs.filter(ref => Number(ref.source_id) === sid).map(ref => String(ref.external_id)))
      const missing = []
      const seen = new Set([String(row.external_id)])
      let cursor = row
      for (let depth = 0; depth < REPLY_DEPTH; depth++) {
        const parentId = replyParentCandidate(cursor)
        if (!parentId || seen.has(parentId)) break
        seen.add(parentId)
        const parent = byExternal.get(sid, parentId)
        if (!parent) {
          // A formerly excluded existing row may already have been deleted.
          // A genuine pre-existing missing-parent ref is still in referenced;
          // an absent ref needs the same bounded input-hash check as an arrival.
          if (!referenced.has(parentId)) missing.push(parentId)
          break
        }
        if (!referenced.has(parentId)) missing.push(parentId)
        if (isTopicAnchor(parent, normalisedTopic(row))) break
        cursor = parent
      }
      if (!missing.length) continue
      candidates += 1
      const current = buildCurrentTelegramDocument(db, row.id)
      if (!current || current.documentHash === row.input_hash) continue
      details.push({
        item_id: row.id, generation_id: row.generation_id,
        missing_guard_external_ids: missing,
        stored_input_hash: row.input_hash, current_input_hash: current.documentHash,
        embedding_reuse_proven: !!guardOnlyVectorReuseProof(db, sid, row.id, current, row.generation_id),
        reason: 'active_reply_input_dependency_missing',
      })
    }
    const complete = rows.length <= count
    return { source_id: sid, after_item_id: after, scanned: scanned.length, candidates,
      item_ids: details.map(detail => detail.item_id), details,
      next_item_id: complete ? null : scanned[scanned.length - 1].id, complete }
  })()
}

function prepareTelegramIndex(db, sourceId, limit, { throwIfCancelled = () => {}, itemIds = null } = {}) {
  const source = db.getSource(sourceId)
  if (!source || source.platform !== 'telegram') throw new Error(`Telegram source #${sourceId} not found`)
  const handle = db.getDb()
  const selectedIds = normalizeItemIds(itemIds)
  throwIfCancelled()
  const sourceRevision = handle.transaction(() => {
    const revision = db.getTelegramRagSourceRevision(sourceId)
    snapshotSource(handle, sourceId, limit, selectedIds)
    return revision
  })()
  const readContext = createContextReader(handle)
  const page = handle.prepare(`
    SELECT selected.seq, i.* FROM telegram_rag_targets selected
      JOIN telegram_rag_source i ON i.id = selected.item_id
     WHERE selected.seq > ? ORDER BY selected.seq LIMIT ?
  `)
  const insertGeneration = handle.prepare('INSERT INTO telegram_rag_run_generations(generation_id, item_id, pending_fragments) VALUES (?, ?, ?)')
  const insertPending = handle.prepare('INSERT INTO telegram_rag_pending(generation_id, chunk_index, item_id, embedding_text) VALUES (?, ?, ?, ?)')
  let after = 0
  let messagesSelected = 0
  let changedMessages = 0
  let fragmentsSelected = 0
  let fragmentsPending = 0
  let messagesPending = 0
  while (true) {
    throwIfCancelled()
    const rows = page.all(after, PAGE_SIZE)
    if (!rows.length) break
    for (const row of rows) {
      throwIfCancelled()
      const document = buildTelegramDocument(row, readContext(row))
      const staged = db.stageTelegramRagGeneration({
        itemId: row.id,
        sourceId,
        documentHash: document.documentHash,
        indexVersion: INDEX_VERSION,
        targetRevision: document.targetReference.local_revision,
        targetContentHash: document.targetReference.content_hash,
        sourceRevision,
        contextRefs: document.contextRefs,
        chunks: document.chunks,
      })
      if (staged.rejection || !staged.generationId) {
        const error = new Error(`Telegram index snapshot could not stage: ${staged.rejection || 'missing generation id'}`)
        error.code = 'TELEGRAM_RAG_SUPERSEDED'
        throw error
      }
      if (staged.changed) changedMessages += 1
      messagesSelected += 1
      fragmentsSelected += document.chunks.length
      if (staged.published) continue
      messagesPending += 1
      let pending = Array.isArray(staged.pendingChunks) ? staged.pendingChunks : []
      if (pending.length && reuseExcludedReplyGuardVectors(db, sourceId, row.id, staged.generationId, document).reused) pending = []
      insertGeneration.run(String(staged.generationId), row.id, pending.length)
      for (const chunk of pending) {
        insertPending.run(String(staged.generationId), chunk.chunk_index, row.id, document.embeddingTexts[chunk.chunk_index])
        fragmentsPending += 1
      }
    }
    after = rows[rows.length - 1].seq
  }
  return { source, messagesSelected, messagesPending, changedMessages, fragmentsSelected, fragmentsPending }
}

function telegramIndexPage(db, afterSeq, limit = PAGE_SIZE) {
  return db.getDb().prepare(`
    SELECT seq, generation_id, chunk_index, item_id, embedding_text FROM telegram_rag_pending
     WHERE seq > ? AND processed = 0 ORDER BY seq LIMIT ?
  `).all(afterSeq, limit)
}

function buildCurrentTelegramDocument(db, itemId) {
  const handle = db.getDb()
  const row = handle.prepare(`
    SELECT i.*, COALESCE(r.local_revision, 1) AS local_revision
      FROM items i LEFT JOIN telegram_rag_item_state r ON r.item_id = i.id
     WHERE i.id = ?
  `).get(itemId)
  if (!row) return null
  return buildTelegramDocument(row, createContextReader(handle, { live: true })(row))
}

function publishReadyTelegramGenerations(db) {
  const handle = db.getDb()
  const ready = handle.prepare('SELECT generation_id, item_id FROM telegram_rag_run_generations WHERE pending_fragments = 0 AND published = 0').all()
  let messagesPublished = 0
  for (const row of ready) {
    const result = db.publishTelegramRagGeneration(row.generation_id, {
      validateSnapshot: ({ target }) => buildCurrentTelegramDocument(db, target?.id || row.item_id),
    })
    if (!result.published) {
      const error = new Error(`Telegram index generation could not publish: ${result.rejection || 'unknown fence rejection'}`)
      error.code = 'TELEGRAM_RAG_SUPERSEDED'
      throw error
    }
    handle.prepare('UPDATE telegram_rag_run_generations SET published = 1 WHERE generation_id = ?').run(row.generation_id)
    messagesPublished += 1
  }
  return messagesPublished
}

function saveTelegramIndexBatch(db, rows, vectors) {
  const groups = new Map()
  rows.forEach((row, index) => {
    if (!groups.has(row.generation_id)) groups.set(row.generation_id, [])
    groups.get(row.generation_id).push({ chunk_index: row.chunk_index, embedding: vectors[index] })
  })
  const handle = db.getDb()
  for (const [generationId, values] of groups) {
    const saved = db.saveTelegramRagGenerationVectors(generationId, values)
    if (saved.obsolete) {
      const error = new Error('Telegram index generation superseded before saving embeddings')
      error.code = 'TELEGRAM_RAG_SUPERSEDED'
      throw error
    }
    handle.prepare('UPDATE telegram_rag_run_generations SET pending_fragments = pending_fragments - ? WHERE generation_id = ?').run(values.length, generationId)
  }
  const processed = handle.prepare('UPDATE telegram_rag_pending SET processed = 1 WHERE seq = ?')
  for (const row of rows) processed.run(row.seq)
  return publishReadyTelegramGenerations(db)
}

function telegramFragmentIndexStatus(db, sourceId) {
  return { ...db.telegramRagIndexStatus(sourceId, { index_version: INDEX_VERSION }), index_version: INDEX_VERSION, freshness: 'checked-at-index-run' }
}

module.exports = {
  INDEX_VERSION, MAX_EMBEDDING_BYTES, TARGET_BYTES, OVERLAP_BYTES, CONTEXT_BYTES,
  PREVIOUS_MESSAGES, REPLY_DEPTH, CONTEXT_WINDOW_SECONDS,
  prefixByBytes, splitCaption, normalisedTopic, isTopicAnchor, selectedContext,
  itemContentHash, buildTelegramDocument, buildCurrentTelegramDocument,
  replyParentCandidate, eligibleAncestors,
  detectTelegramExcludedReplyGuards,
  prepareTelegramIndex, telegramIndexPage, publishReadyTelegramGenerations,
  saveTelegramIndexBatch, telegramFragmentIndexStatus,
}
