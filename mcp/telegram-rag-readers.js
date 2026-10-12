'use strict'

const { createHash } = require('node:crypto')

// Local Telegram readers. The caller owns the Application API database handle;
// this module neither opens storage nor downloads/materialises Telegram data.
const MAX_CAPTION_CHARS = 16000
const DEFAULT_CAPTION_CHARS = 4000
const MAX_NEIGHBORS = 100
const MAX_REPLY_DEPTH = 50
const MAX_DESCENDANTS = 500
const CAPTION_OFFSET_UNIT = 'unicode_codepoints'
const SEMANTIC_OFFSET_UNIT = 'utf16_code_units'

class TelegramRagReaderError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`)
    this.name = 'TelegramRagReaderError'
    this.code = code
    Object.assign(this, details)
  }
}

function captionHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function checkCaptionHash(expected, actual, details = {}) {
  if (expected == null) return
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) {
    throw new TypeError('expected_caption_hash must be a SHA256 hex digest')
  }
  if (expected.toLowerCase() !== actual) {
    throw new TelegramRagReaderError('stale_message', 'The original caption changed; restart reading at offset 0 rather than concatenating different versions.', {
      ...details, expected_caption_hash: expected.toLowerCase(), caption_hash: actual,
    })
  }
}

function objectJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function boundedInteger(value, fallback, min, max, name) {
  if (value == null) return fallback
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  }
  return n
}

function positiveId(value, name) {
  return boundedInteger(value, null, 1, Number.MAX_SAFE_INTEGER, name)
}

function telegramId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null
  const text = String(value ?? '').trim()
  return /^[1-9]\d*$/.test(text) ? text : null
}

function topicId(row) {
  const n = Number(row?.topic_id)
  return row?.topic_id != null && Number.isSafeInteger(n) && n > 0 ? n : null
}

function safeReplyPeer(value) {
  if (!value || typeof value !== 'object' || !['user', 'chat', 'channel'].includes(value.kind)) return null
  const id = telegramId(value.id)
  return id ? { id: Number.isSafeInteger(Number(id)) ? Number(id) : id, kind: value.kind } : null
}

function telegramReplyProvenance(row) {
  const raw = objectJson(row?.raw_meta_json)
  const packet = raw.telegram_reply && typeof raw.telegram_reply === 'object' ? raw.telegram_reply : null
  const sourcePeer = safeReplyPeer(packet?.source_peer)
  const targetPeer = safeReplyPeer(packet?.target_peer)
  const messageId = telegramId(packet?.message_id)
  let scope = packet?.version === 1 && ['same_peer', 'external_peer', 'topic_anchor', 'none', 'unknown', 'unavailable'].includes(packet.scope)
    ? packet.scope : 'unknown_legacy'
  if (sourcePeer && targetPeer && (sourcePeer.kind !== targetPeer.kind || String(sourcePeer.id) !== String(targetPeer.id))) scope = 'external_peer'
  const explicitExternal = raw.external_reply && typeof raw.external_reply === 'object' ? raw.external_reply : null
  const externalPeer = safeReplyPeer(explicitExternal?.peer) || (scope === 'external_peer' ? targetPeer : null)
  const externalMessage = telegramId(explicitExternal?.message_id) || (scope === 'external_peer' ? messageId : null)
  if (explicitExternal && externalPeer && externalMessage) scope = 'external_peer'
  const external = externalPeer && externalMessage ? {
    peer: externalPeer, message_id: externalMessage,
    ...(typeof explicitExternal?.quote_text === 'string' ? { quote_text: explicitExternal.quote_text } : {}),
    ...(Number.isSafeInteger(explicitExternal?.quote_offset) && explicitExternal.quote_offset >= 0 ? {
      quote_offset: explicitExternal.quote_offset, quote_offset_unit: 'utf16_code_units',
    } : {}),
  } : null
  return { scope, source_peer: sourcePeer, target_peer: targetPeer, message_id: messageId, external_reply: external }
}

function replyParent(row) {
  const parent = row?.parent_external_id == null ? null : String(row.parent_external_id)
  if (!parent) return null
  const provenance = telegramReplyProvenance(row)
  if (provenance.scope !== 'unknown_legacy' && (provenance.scope !== 'same_peer' || provenance.message_id !== parent)) return null
  // Historical imports occasionally stored the topic marker as a reply edge.
  // Membership of a topic must not turn thousands of posts into replies to its
  // creation message. Preserve the raw parent separately for provenance.
  if (topicId(row) != null && parent === String(topicId(row))) return null
  return parent
}

function sourceRef(source) {
  const meta = objectJson(source?.meta_json)
  return {
    source_id: source.id,
    platform: source.platform,
    handle: source.handle,
    title: source.display_name || source.handle,
    external_id: source.external_id || null,
    kind: meta.kind || meta.entity_kind || meta.dialog_kind || null,
    session: source.tg_session || null,
  }
}

function channelId(value) {
  const text = String(value ?? '').trim()
  if (/^-100[1-9]\d*$/.test(text)) return text.slice(4)
  return telegramId(value)
}

function username(value) {
  const text = String(value ?? '').trim().replace(/^@/, '')
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text) ? text : null
}

function telegramMessageUrl(source, row) {
  const id = telegramId(row.external_id)
  if (!id) return null
  const meta = objectJson(source.meta_json)
  const kind = meta.kind || meta.entity_kind || meta.dialog_kind
  // A user/basic group has no t.me message permalink. Never reuse row.url:
  // it may point at the original forwarded post or the linked channel rather
  // than the peer that owns this locally stored message ID.
  if (kind === 'user' || kind === 'chat') return null
  const topic = topicId(row)
  const suffix = `${topic && topic > 1 ? `${topic}/` : ''}${id}`
  const peer = channelId(source.external_id) || channelId(source.handle)
  const markedChannel = /^-100[1-9]\d*$/.test(String(source.handle || '')) ||
    /^-100[1-9]\d*$/.test(String(source.external_id || ''))
  // Fetch/folder workers use Chat=>"chat", Channel(megagroup)=>"group".
  // Other Telegram peer contracts use "group" for a basic Chat, so legacy or
  // imported metadata must not prove a channel merely from that ambiguous word.
  const confirmedChannel = ['channel', 'supergroup'].includes(kind) ||
    meta.forum === true || meta.megagroup === true || topic != null
  // Full history emits Channel(megagroup) as "group" without a megagroup flag.
  // Its observed message peer still proves the namespace. Do not use the reply
  // target/forward origin or an unversioned legacy packet to invent this proof.
  const packet = objectJson(row.raw_meta_json).telegram_reply
  const observedSource = packet?.version === 1 ? safeReplyPeer(packet.source_peer) : null
  const observedChannel = observedSource?.kind === 'channel' && String(observedSource.id) === peer
  if (peer && (confirmedChannel || markedChannel || observedChannel)) {
    return `https://t.me/c/${peer}/${suffix}`
  }
  const publicHandle = username(source.handle)
  const actualUsername = username(meta.username)
  // A target/display name can happen to look like a username. Require the
  // independently resolved username to agree with the stored source handle.
  return publicHandle && actualUsername && publicHandle.toLowerCase() === actualUsername.toLowerCase()
    ? `https://t.me/${publicHandle}/${suffix}` : null
}

function summariseReactions(value) {
  let reactions = value
  if (typeof reactions === 'string') {
    try { reactions = JSON.parse(reactions) } catch { return null }
  }
  if (!Array.isArray(reactions)) return null
  const valid = reactions.filter(r => r && typeof r === 'object')
  return {
    total: valid.reduce((sum, r) => sum + (Number(r.n) || 0), 0),
    top: valid.slice(0, 6),
  }
}

function safeForward(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entity = ref => ref && typeof ref === 'object' ? {
    id: ref.id ?? null, kind: ref.kind ?? null,
    ...(ref.name != null ? { name: ref.name } : {}),
    ...(ref.username != null ? { username: ref.username } : {}),
  } : null
  return {
    date: value.date ?? null,
    source: entity(value.source),
    from_peer: entity(value.from_peer),
    from_name: value.from_name ?? null,
    channel_post: value.channel_post ?? null,
    post_author: value.post_author ?? null,
    saved_from_peer: entity(value.saved_from_peer),
    saved_from_message_id: value.saved_from_message_id ?? null,
    imported: !!value.imported,
  }
}

function safeMedia(value) {
  if (!Array.isArray(value)) return []
  const keys = [
    'kind', 'file_name', 'content_type', 'bytes', 'width', 'height',
    'duration_seconds', 'media_type', 'grouped_id', 'spoiler',
  ]
  return value.filter(v => v && typeof v === 'object' && !Array.isArray(v))
    .map(v => Object.fromEntries(keys.filter(key => v[key] != null).map(key => [key, v[key]])))
}

function serializeTelegramItem(row, source, options = {}) {
  const offset = boundedInteger(options.caption_offset, 0, 0, Number.MAX_SAFE_INTEGER, 'caption_offset')
  const limit = boundedInteger(options.caption_chars, DEFAULT_CAPTION_CHARS, 0, MAX_CAPTION_CHARS, 'caption_chars')
  // Unicode-code-point pagination keeps emoji/supplementary characters intact.
  const originalText = String(row.caption ?? '')
  const hash = captionHash(originalText)
  checkCaptionHash(options.expected_caption_hash, hash, { item_id: row.id, source_id: row.source_id })
  const chars = Array.from(originalText)
  const caption = chars.slice(offset, offset + limit).join('')
  const returned = Math.max(0, Math.min(limit, chars.length - offset))
  const hasMore = offset + returned < chars.length
  const raw = objectJson(row.raw_meta_json)
  const parent = row.parent_external_id == null ? null : String(row.parent_external_id)
  const actualParent = replyParent(row)
  const reply = telegramReplyProvenance(row)
  const processingMarker = /\[(?:голосовое\s*—\s*расшифровка|фото\s*—\s*описание|документ\s*—\s*извлечение|медиа\s*·)/u.test(originalText)
  const checkedParent = reply.scope === 'same_peer' ? actualParent : null
  const parentRelation = checkedParent ? 'reply' : reply.scope === 'external_peer' ? 'external_reply'
    : parent && (reply.scope === 'topic_anchor' || parent === String(topicId(row))) ? 'topic_anchor'
      : parent ? 'unverified_parent' : null
  const item = {
    item_id: row.id,
    source_id: row.source_id,
    external_id: row.external_id,
    url: telegramMessageUrl(source, row),
    type: row.type,
    title: row.title || null,
    caption,
    caption_source: 'saved_caption',
    caption_may_include_processed_media: processingMarker || row.transcribe_status === 'done' || !!row.transcript_path,
    caption_contains_processing_marker: processingMarker,
    caption_hash: hash,
    caption_total_chars: chars.length,
    caption_offset: offset,
    caption_returned_chars: returned,
    caption_truncated: returned !== chars.length,
    caption_has_more: hasMore,
    caption_next_offset: hasMore && returned > 0 ? offset + returned : null,
    offset_unit: CAPTION_OFFSET_UNIT,
    caption_offset_unit: CAPTION_OFFSET_UNIT,
    caption_utf16_offset: chars.slice(0, offset).reduce((sum, char) => sum + char.length, 0),
    caption_utf16_returned_units: caption.length,
    caption_utf16_total_units: originalText.length,
    caption_utf16_offset_unit: SEMANTIC_OFFSET_UNIT,
    published_at: row.published_at ?? null,
    sender: row.sender || null,
    topic_id: topicId(row),
    topic_title: row.topic_title || null,
    parent_external_id: parent,
    reply_parent_external_id: checkedParent,
    reply_candidate_external_id: actualParent,
    parent_relation: parentRelation,
    reply_scope: reply.scope,
    reply_provenance: reply,
    external_reply: reply.external_reply,
    unverified_parent_external_id: parentRelation === 'unverified_parent' ? parent : null,
    reply_resolved: row.reply_resolved == null ? null : !!row.reply_resolved,
    reactions: summariseReactions(row.reactions),
    has_media: !!row.has_media,
    media: safeMedia(raw.media),
    forward: safeForward(raw.forward),
    media_path: row.media_path || null,
    transcript_path: row.transcript_path || null,
    transcribe_status: row.transcribe_status || null,
    transcribe_engine: row.transcribe_engine || null,
  }
  if (row.hop != null) item.hop = row.hop
  if (row.edge_relation_quality) item.edge_relation_quality = row.edge_relation_quality
  if (row.path_relation_quality) item.path_relation_quality = row.path_relation_quality
  return item
}

// Semantic chunk offsets currently use JS String.slice (UTF16 code units).
// They must not be passed as caption_offset, which counts Unicode code points.
// This helper labels both coordinate systems and expands a boundary that falls
// inside a surrogate pair, explicitly reporting the adjusted effective span.
function readTelegramCaptionSpan(text, options = {}) {
  const originalText = String(text ?? '')
  const hash = captionHash(originalText)
  checkCaptionHash(options.expected_caption_hash, hash)
  if (options.offset_unit != null && options.offset_unit !== SEMANTIC_OFFSET_UNIT) {
    throw new TypeError(`Matched caption spans require offset_unit=${SEMANTIC_OFFSET_UNIT}`)
  }
  const requestedStart = boundedInteger(options.start, 0, 0, originalText.length, 'start')
  const requestedEnd = boundedInteger(options.end, originalText.length, requestedStart, originalText.length, 'end')
  function insideSurrogatePair(offset) {
    if (offset <= 0 || offset >= originalText.length) return false
    const previous = originalText.charCodeAt(offset - 1)
    const next = originalText.charCodeAt(offset)
    return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF
  }
  const start = insideSurrogatePair(requestedStart) ? requestedStart - 1 : requestedStart
  const end = insideSurrogatePair(requestedEnd) ? requestedEnd + 1 : requestedEnd
  return {
    caption: originalText.slice(start, end),
    caption_hash: hash,
    requested_span: { start: requestedStart, end: requestedEnd, offset_unit: SEMANTIC_OFFSET_UNIT },
    span: { start, end, offset_unit: SEMANTIC_OFFSET_UNIT },
    unicode_span: {
      start: Array.from(originalText.slice(0, start)).length,
      end: Array.from(originalText.slice(0, end)).length,
      offset_unit: CAPTION_OFFSET_UNIT,
    },
    boundaries_adjusted: start !== requestedStart || end !== requestedEnd,
  }
}

const ORDER_ASC = 'COALESCE(published_at, 0) ASC, CAST(external_id AS INTEGER) ASC, external_id ASC, id ASC'
const ORDER_DESC = 'COALESCE(published_at, 0) DESC, CAST(external_id AS INTEGER) DESC, external_id DESC, id DESC'

function compareRows(a, b) {
  const time = Number(a.published_at ?? 0) - Number(b.published_at ?? 0)
  if (time) return time
  const ai = telegramId(a.external_id), bi = telegramId(b.external_id)
  if (ai && bi) {
    const an = BigInt(ai), bn = BigInt(bi)
    if (an !== bn) return an < bn ? -1 : 1
  } else {
    const fallback = String(a.external_id).localeCompare(String(b.external_id))
    if (fallback) return fallback
  }
  return Number(a.item_id ?? a.id) - Number(b.item_id ?? b.id)
}

const semanticRefReaders = new WeakMap()

function semanticRefContentHash(row) {
  const raw = objectJson(row.raw_meta_json)
  return createHash('sha256').update(JSON.stringify({
    source_id: row.source_id,
    external_id: String(row.external_id),
    caption: String(row.caption || ''),
    sender: row.sender ?? null,
    type: row.type ?? null,
    published_at: row.published_at ?? null,
    topic_id: topicId(row) || 0,
    parent_external_id: row.parent_external_id ?? null,
    ...(Object.hasOwn(raw, 'telegram_reply') ? { telegram_reply: raw.telegram_reply ?? null } : {}),
    ...(Object.hasOwn(raw, 'external_reply') ? { external_reply: raw.external_reply ?? null } : {}),
  })).digest('hex')
}

function semanticRefReader(handle) {
  if (semanticRefReaders.has(handle)) return semanticRefReaders.get(handle)
  const ledger = handle.prepare('PRAGMA table_info(telegram_rag_item_state)').all()
    .some(column => column.name === 'local_revision')
  const projection = ledger ? 'i.*, r.local_revision AS context_node_revision' : 'i.*'
  const join = ledger ? 'LEFT JOIN telegram_rag_item_state r ON r.item_id = i.id' : ''
  const reader = {
    source: handle.prepare("SELECT id FROM sources WHERE id = ? AND platform = 'telegram'"),
    external: handle.prepare(`SELECT ${projection} FROM items i ${join} WHERE i.source_id = ? AND i.external_id = ?`),
    identity: handle.prepare(`SELECT ${projection} FROM items i ${join} WHERE i.source_id = ? AND i.id = ? AND i.external_id = ?`),
  }
  semanticRefReaders.set(handle, reader)
  return reader
}

function contextRefRevision(ref, row) {
  if (!row) return 'missing'
  const stored = Number(ref?.local_revision), current = Number(row.context_node_revision)
  if (!Number.isSafeInteger(stored) || stored <= 0 || !Number.isSafeInteger(current) || current <= 0 ||
      typeof ref?.content_hash !== 'string') return 'unknown'
  return stored === current && ref.content_hash === semanticRefContentHash(row) ? 'current' : 'stale'
}

function combineRelationQuality(first, second) {
  if (first === 'unknown' || second === 'unknown') return 'unknown'
  if (first === 'unknown_legacy' || second === 'unknown_legacy') return 'unknown_legacy'
  return 'same_peer'
}

// Public output adapter only. The caller holds its read transaction around
// search + annotation; the stored role/hash/generation is never rewritten.
// A stored embedding role describes input construction, not authorship or a
// verified discussion edge. Every item lookup retains the target source scope.
function annotateSemanticContextRefs(handle, targetRow, refs) {
  if (!Array.isArray(refs)) return []
  const sid = Number(targetRow?.source_id)
  if (!handle || typeof handle.prepare !== 'function') throw new TypeError('A SQLite Application API handle is required')
  const read = semanticRefReader(handle)
  const validSource = Number.isSafeInteger(sid) && sid > 0 && !!read.source.get(sid)
  const targetExternal = telegramId(targetRow?.external_id)
  const targetId = Number(targetRow?.item_id ?? targetRow?.id)
  const currentTarget = validSource && targetExternal && Number.isSafeInteger(targetId) && targetId > 0
    ? read.identity.get(sid, targetId, targetExternal) : null
  const targetRevisionKnown = currentTarget && Number.isSafeInteger(Number(targetRow.local_revision)) &&
    Number(targetRow.local_revision) > 0 && Number(currentTarget.context_node_revision) === Number(targetRow.local_revision) &&
    semanticRefContentHash(currentTarget) === semanticRefContentHash(targetRow)
  const scoped = ref => ref && typeof ref === 'object' && Number(ref.source_id) === sid && validSource
  const lookup = ref => {
    const external = telegramId(ref?.external_id)
    if (!scoped(ref) || !external) return null
    if (ref.item_id != null) {
      const id = Number(ref.item_id)
      return Number.isSafeInteger(id) && id > 0 ? read.identity.get(sid, id, external) : null
    }
    return read.external.get(sid, external)
  }
  const nodeRefs = new Map(refs.filter(ref => scoped(ref) && ref.item_id != null)
    .map(ref => [String(ref.external_id), ref]))
  const path = new Map()
  const seen = new Set(targetExternal ? [targetExternal] : [])
  let cursor = currentTarget
  let pathQuality = targetRevisionKnown ? 'same_peer' : 'unknown'
  let stopScope = cursor ? telegramReplyProvenance(cursor).scope : 'unknown'
  for (let hop = 1; cursor && hop <= MAX_REPLY_DEPTH; hop++) {
    const provenance = telegramReplyProvenance(cursor)
    stopScope = provenance.scope
    const parent = replyParent(cursor)
    if (!parent) break
    const edgeQuality = provenance.scope === 'unknown_legacy' ? 'unknown_legacy' : 'same_peer'
    pathQuality = combineRelationQuality(pathQuality, edgeQuality)
    if (seen.has(parent)) {
      if (!path.has(parent)) path.set(parent, { edgeQuality, pathQuality, boundary: 'cycle' })
      break
    }
    seen.add(parent)
    const parentRow = read.external.get(sid, parent)
    const indexedRef = nodeRefs.get(parent)
    if (indexedRef && contextRefRevision(indexedRef, parentRow) !== 'current') pathQuality = 'unknown'
    path.set(parent, { edgeQuality, pathQuality, row: parentRow, boundary: parentRow ? null : 'missing_parent' })
    if (!parentRow) break
    cursor = parentRow
  }

  return refs.map(ref => {
    const input = ref && typeof ref === 'object' && !Array.isArray(ref) ? ref : {}
    const role = typeof input.role === 'string' ? input.role : 'unknown'
    const base = {
      ...input,
      embedding_role: role,
      role_is_embedding_only: true,
      in_embedding_context: role === 'reply' || role === 'prior',
      retrieval_relation: 'unknown',
      edge_relation_quality: 'unknown',
      path_relation_quality: 'unknown',
      node_revision_status: 'unknown',
      node_reply_scope: 'unknown',
    }
    if (!scoped(input)) return { ...base, retrieval_relation: 'source_scope_guard', scope_guard: 'rejected' }
    const node = lookup(input)
    const revision = input.item_id == null ? (node ? 'appeared' : 'missing') : contextRefRevision(input, node)
    const step = path.get(String(input.external_id))
    const annotated = { ...base, scope_guard: 'same_source', node_revision_status: revision,
      node_reply_scope: node ? telegramReplyProvenance(node).scope : 'unavailable' }
    if (role === 'excluded_reply_guard') {
      return { ...annotated, retrieval_relation: 'dependency_guard', in_embedding_context: false,
        guard_state: !node ? 'missing_excluded_parent' : revision !== 'current' ? 'changed_excluded_parent' : 'present_excluded_parent',
        edge_relation_quality: revision === 'current' ? (step?.edgeQuality || 'unknown') : 'unknown',
        path_relation_quality: revision === 'current' ? (step?.pathQuality || 'unknown') : 'unknown' }
    }
    if (input.item_id == null || role === 'missing_reply') {
      return { ...annotated, retrieval_relation: 'dependency_guard', in_embedding_context: false,
        guard_state: node ? 'appeared' : 'still_missing',
        edge_relation_quality: step?.edgeQuality || 'unknown',
        path_relation_quality: step?.pathQuality || 'unknown' }
    }
    if (!node || revision !== 'current') return { ...annotated, retrieval_relation: 'unverified_reference' }
    if (role === 'prior') return { ...annotated, retrieval_relation: 'chronological_neighbor',
      edge_relation_quality: 'not_reply', path_relation_quality: 'not_reply' }
    if (role !== 'reply' && role !== 'reply-link') return annotated
    if (!step) return { ...annotated,
      retrieval_relation: stopScope === 'external_peer' ? 'external_reply_guard' : 'unverified_reply_reference',
      guard_state: stopScope === 'external_peer' ? 'external_namespace' : 'not_on_current_parent_path' }
    const relation = role === 'reply-link' ? 'dependency_guard'
      : step.pathQuality === 'same_peer' ? 'verified_reply_ancestor'
        : step.edgeQuality === 'unknown_legacy' || step.pathQuality === 'unknown_legacy' ? 'legacy_reply_candidate_ancestor' : 'unverified_reply_reference'
    return { ...annotated, retrieval_relation: relation,
      edge_relation_quality: step.edgeQuality, path_relation_quality: step.pathQuality,
      ...(role === 'reply-link' ? { in_embedding_context: false, guard_state: 'present_dependency' } : {}) }
  })
}

function createTelegramRagReaders(handle) {
  if (!handle || typeof handle.prepare !== 'function') throw new TypeError('A SQLite Application API handle is required')
  const sourceQuery = handle.prepare("SELECT * FROM sources WHERE id = ? AND platform = 'telegram'")
  const byExternal = handle.prepare('SELECT * FROM items WHERE source_id = ? AND external_id = ?')
  const children = handle.prepare(`
    SELECT * FROM items WHERE source_id = ? AND parent_external_id = ?
      AND NOT (topic_id IS NOT NULL AND CAST(topic_id AS TEXT) = parent_external_id)
      AND (CASE WHEN json_valid(raw_meta_json) THEN json_extract(raw_meta_json, '$.telegram_reply.version') END IS NOT 1
        OR (CASE WHEN json_valid(raw_meta_json) THEN json_extract(raw_meta_json, '$.telegram_reply.scope') END = 'same_peer'
          AND CASE WHEN json_valid(raw_meta_json) THEN CAST(json_extract(raw_meta_json, '$.telegram_reply.message_id') AS TEXT) END = parent_external_id))
      AND CASE WHEN json_valid(raw_meta_json) THEN json_type(raw_meta_json, '$.external_reply') END IS NOT 'object'
    ORDER BY ${ORDER_ASC} LIMIT ?
  `)

  function centerFor(args = {}) {
    let row
    if (args.item_id != null) {
      const id = positiveId(args.item_id, 'item_id')
      if (args.source_id != null) {
        row = handle.prepare('SELECT * FROM items WHERE id = ? AND source_id = ?')
          .get(id, positiveId(args.source_id, 'source_id'))
      } else row = handle.prepare('SELECT * FROM items WHERE id = ?').get(id)
      if (row && args.external_id != null && String(row.external_id) !== String(args.external_id)) row = null
    } else {
      if (args.source_id == null || args.external_id == null) {
        throw new TypeError('Use item_id, or both source_id and external_id')
      }
      const sid = positiveId(args.source_id, 'source_id')
      const external = telegramId(args.external_id)
      if (!external) throw new TypeError('external_id must be a positive Telegram message ID')
      row = byExternal.get(sid, external)
    }
    if (!row) return { error: 'item not found' }
    const source = sourceQuery.get(row.source_id)
    if (!source) return { error: 'Telegram source not found' }
    return { row, source }
  }

  function readItem(args = {}) {
    const found = centerFor(args)
    if (found.error) return found
    const offset = boundedInteger(args.caption_offset, 0, 0, Number.MAX_SAFE_INTEGER, 'caption_offset')
    if (offset > 0 && args.expected_caption_hash == null) {
      throw new TelegramRagReaderError('expected_caption_hash_required', 'Continuation needs the caption_hash returned by the first page.', {
        item_id: found.row.id, source_id: found.row.source_id,
      })
    }
    return {
      source: sourceRef(found.source),
      item: serializeTelegramItem(found.row, found.source, { ...args, caption_chars: args.caption_chars ?? MAX_CAPTION_CHARS }),
    }
  }

  function neighbors(args = {}) {
    const found = centerFor(args)
    if (found.error) return found
    const { row, source } = found
    const before = boundedInteger(args.before, 5, 0, MAX_NEIGHBORS, 'before')
    const after = boundedInteger(args.after, 5, 0, MAX_NEIGHBORS, 'after')
    if (args.same_topic != null && typeof args.same_topic !== 'boolean') throw new TypeError('same_topic must be boolean')
    const sameTopic = args.same_topic === true
    const topicClause = sameTopic ? ' AND COALESCE(topic_id, 0) = ?' : ''
    const params = [row.source_id, ...(sameTopic ? [row.topic_id || 0] : [])]
    const time = row.published_at ?? 0
    // The tie-break uses Telegram's message ID, not local insertion order.
    // Sparse/deleted IDs are read as existing rows; no synthetic range is made.
    const bounds = [time, time, Number(row.external_id), time, Number(row.external_id), row.external_id, time, Number(row.external_id), row.external_id, row.id]
    function side(op, order, count) {
      return handle.prepare(`
        SELECT * FROM items WHERE source_id = ? ${topicClause}
          AND (COALESCE(published_at, 0) ${op} ?
            OR (COALESCE(published_at, 0) = ? AND CAST(external_id AS INTEGER) ${op} ?)
            OR (COALESCE(published_at, 0) = ? AND CAST(external_id AS INTEGER) = ? AND external_id ${op} ?)
            OR (COALESCE(published_at, 0) = ? AND CAST(external_id AS INTEGER) = ? AND external_id = ? AND id ${op} ?))
        ORDER BY ${order} LIMIT ?
      `).all(...params, ...bounds, count + 1)
    }
    const beforeRows = side('<', ORDER_DESC, before)
    const afterRows = side('>', ORDER_ASC, after)
    const format = r => serializeTelegramItem(r, source, args)
    return {
      source: sourceRef(source),
      before: beforeRows.slice(0, before).reverse().map(format),
      center: format(row),
      after: afterRows.slice(0, after).map(format),
      before_has_more: beforeRows.length > before,
      after_has_more: afterRows.length > after,
      same_topic: sameTopic,
      topic_scope_known: topicId(row) != null,
      ordering: 'published_at, Telegram message_id, item_id; null timestamps sort first',
      relation: 'chronological_neighbors',
      neighbors_are_not_reply_edges: true,
    }
  }

  function replyThread(args = {}) {
    const found = centerFor(args)
    if (found.error) return found
    const { row, source } = found
    const maxDepth = boundedInteger(args.max_depth, 10, 0, MAX_REPLY_DEPTH, 'max_depth')
    const maxDescendants = boundedInteger(args.max_descendants, 100, 0, MAX_DESCENDANTS, 'max_descendants')
    const ancestorRows = []
    const ancestorSeen = new Set([String(row.external_id)])
    let cursor = row
    let ancestorStop = 'root'
    let missingParent = null
    let ancestorPathQuality = 'same_peer'
    let ancestorProvenanceComplete = true
    let ancestorBoundaryQuality = null
    for (;;) {
      const parent = replyParent(cursor)
      if (!parent) {
        const scope = telegramReplyProvenance(cursor).scope
        if (!['same_peer', 'topic_anchor', 'none', 'external_peer'].includes(scope)) ancestorProvenanceComplete = false
        if (scope === 'external_peer') ancestorStop = 'external_reply'
        else if (scope === 'unavailable') ancestorStop = 'message_unavailable'
        else if (scope === 'unknown' || (scope === 'unknown_legacy' && cursor.parent_external_id)) ancestorStop = 'reply_provenance_unknown'
        else if (cursor.reply_resolved !== 1) ancestorStop = 'reply_unresolved'
        break
      }
      // The edge that stops traversal still has provenance. Compute it before
      // missing/depth/cycle exits, rather than proving only returned nodes.
      const quality = telegramReplyProvenance(cursor).scope === 'unknown_legacy' ? 'unknown_legacy' : 'same_peer'
      if (quality === 'unknown_legacy') { ancestorPathQuality = 'unknown_legacy'; ancestorProvenanceComplete = false }
      ancestorBoundaryQuality = ancestorPathQuality
      if (ancestorSeen.has(parent)) { ancestorStop = 'cycle'; break }
      const next = byExternal.get(row.source_id, parent)
      if (!next) { ancestorStop = 'missing_parent'; missingParent = parent; break }
      if (ancestorRows.length >= maxDepth) { ancestorStop = 'max_depth'; break }
      ancestorSeen.add(parent)
      ancestorRows.push({ ...next, hop: ancestorRows.length + 1, edge_relation_quality: quality, path_relation_quality: ancestorPathQuality })
      cursor = next
      ancestorBoundaryQuality = null
    }

    const descendantRows = []
    const descendantSeen = new Set([String(row.external_id)])
    const queue = [{ ...row, hop: 0, path_relation_quality: 'same_peer' }]
    let descendantDepthLimit = false
    let descendantNodeLimit = false
    let descendantCycle = false
    let descendantProvenanceComplete = true
    let descendantBoundaryQuality = null
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]
      const rows = children.all(row.source_id, String(current.external_id), maxDescendants + 1)
      for (const child of rows) {
        // A stale parent column must not reintroduce a checked cross-peer edge.
        // Legacy unverified IDs remain metadata, not asserted local replies.
        if (replyParent(child) !== String(current.external_id)) continue
        const quality = telegramReplyProvenance(child).scope === 'unknown_legacy' ? 'unknown_legacy' : 'same_peer'
        const pathQuality = current.path_relation_quality === 'unknown_legacy' || quality === 'unknown_legacy' ? 'unknown_legacy' : 'same_peer'
        if (pathQuality === 'unknown_legacy') descendantProvenanceComplete = false
        const key = String(child.external_id)
        const boundaryQuality = descendantBoundaryQuality === 'unknown_legacy' || pathQuality === 'unknown_legacy' ? 'unknown_legacy' : 'same_peer'
        if (descendantSeen.has(key)) { descendantCycle = true; descendantBoundaryQuality = boundaryQuality; continue }
        if (current.hop >= maxDepth) { descendantDepthLimit = true; descendantBoundaryQuality = boundaryQuality; continue }
        if (descendantRows.length >= maxDescendants) { descendantNodeLimit = true; descendantBoundaryQuality = boundaryQuality; break }
        descendantSeen.add(key)
        const node = { ...child, hop: current.hop + 1, edge_relation_quality: quality, path_relation_quality: pathQuality }
        descendantRows.push(node)
        queue.push(node)
      }
      if (descendantNodeLimit) break
    }
    const format = r => serializeTelegramItem(r, source, args)
    return {
      source: sourceRef(source),
      center: format(row),
      ancestors: ancestorRows.reverse().map(format),
      descendants: descendantRows.sort(compareRows).map(format),
      ancestor_chain_truncated: ancestorStop === 'max_depth',
      ancestor_stop_reason: ancestorStop,
      missing_parent_external_id: missingParent,
      ancestor_cycle_detected: ancestorStop === 'cycle',
      ancestor_boundary_relation_quality: ancestorBoundaryQuality,
      descendants_truncated: descendantDepthLimit || descendantNodeLimit,
      descendants_depth_truncated: descendantDepthLimit,
      descendants_node_truncated: descendantNodeLimit,
      descendants_cycle_detected: descendantCycle,
      descendant_boundary_relation_quality: descendantBoundaryQuality,
      provenance_complete: ['same_peer', 'topic_anchor', 'none', 'external_peer'].includes(telegramReplyProvenance(row).scope) &&
        ancestorProvenanceComplete && descendantProvenanceComplete,
      provenance_scope: 'observed_local_edges_and_boundary',
      local_traversal_complete: ['root', 'external_reply'].includes(ancestorStop) &&
        !descendantDepthLimit && !descendantNodeLimit && !descendantCycle,
      telegram_completeness: 'not_checked_local_reader',
      max_depth: maxDepth,
      max_descendants: maxDescendants,
      relation: 'stored_reply_graph_with_labelled_legacy_candidates',
      coverage: 'Saved local messages only; legacy peer identities are unverified candidates, known external replies are not local edges.',
    }
  }

  function context(args = {}) {
    const chronological = neighbors({ ...args, before: args.before ?? 15, after: args.after ?? 15 })
    if (chronological.error) return chronological
    const graph = replyThread(args)
    if (graph.error) return graph
    const merged = new Map()
    function add(item, relation, hop) {
      const key = `${item.source_id}:${item.external_id}`
      if (!merged.has(key)) merged.set(key, { ...item, relations: [], relation_details: [] })
      const node = merged.get(key)
      if (!node.relations.includes(relation)) {
        node.relations.push(relation)
        node.relation_details.push({ relation, ...(hop != null ? { hop } : {}) })
      }
    }
    add(graph.center, 'center')
    graph.ancestors.forEach(item => add(item, item.path_relation_quality === 'unknown_legacy' ? 'legacy_reply_candidate_ancestor' : 'reply_ancestor', item.hop))
    graph.descendants.forEach(item => add(item, item.path_relation_quality === 'unknown_legacy' ? 'legacy_reply_candidate_descendant' : 'reply_descendant', item.hop))
    chronological.before.forEach(item => add(item, 'neighbor_before'))
    chronological.after.forEach(item => add(item, 'neighbor_after'))
    const conversation = Array.from(merged.values()).sort(compareRows)
    const byId = new Map(conversation.map(item => [String(item.external_id), item]))
    const edges = conversation.flatMap(item => {
      const parent = byId.get(item.reply_parent_external_id)
      return parent ? [{ from_item_id: item.item_id, to_item_id: parent.item_id, relation: 'reply' }] : []
    })
    const candidates = conversation.flatMap(item => {
      const parent = item.reply_scope === 'unknown_legacy' ? byId.get(item.reply_candidate_external_id) : null
      return parent ? [{ from_item_id: item.item_id, to_item_id: parent.item_id, relation: 'legacy_reply_candidate', relation_quality: 'unknown_legacy' }] : []
    })
    return {
      source: graph.source,
      center: graph.center,
      ancestors: graph.ancestors,
      descendants: graph.descendants,
      before: chronological.before,
      after: chronological.after,
      conversation,
      returned: conversation.length,
      reply_edges: edges,
      legacy_reply_candidate_edges: candidates,
      provenance_complete: graph.provenance_complete,
      provenance_scope: graph.provenance_scope,
      local_traversal_complete: graph.local_traversal_complete,
      telegram_completeness: graph.telegram_completeness,
      ancestor_boundary_relation_quality: graph.ancestor_boundary_relation_quality,
      descendant_boundary_relation_quality: graph.descendant_boundary_relation_quality,
      same_topic: chronological.same_topic,
      before_has_more: chronological.before_has_more,
      after_has_more: chronological.after_has_more,
      ancestor_chain_truncated: graph.ancestor_chain_truncated,
      ancestor_stop_reason: graph.ancestor_stop_reason,
      missing_parent_external_id: graph.missing_parent_external_id,
      ancestor_cycle_detected: graph.ancestor_cycle_detected,
      descendants_truncated: graph.descendants_truncated,
      descendants_depth_truncated: graph.descendants_depth_truncated,
      descendants_node_truncated: graph.descendants_node_truncated,
      descendants_cycle_detected: graph.descendants_cycle_detected,
      caption_truncated_items: conversation.filter(item => item.caption_truncated).map(item => item.item_id),
      context_scope: 'Local reply graph and chronological candidates. Neighbor labels do not establish a shared conversation.',
    }
  }

  return { readItem, neighbors, replyThread, context }
}

module.exports = {
  createTelegramRagReaders, serializeTelegramItem, telegramMessageUrl, summariseReactions,
  readTelegramCaptionSpan, captionHash, TelegramRagReaderError, CAPTION_OFFSET_UNIT, SEMANTIC_OFFSET_UNIT,
  telegramReplyProvenance,
  annotateSemanticContextRefs,
  MAX_CAPTION_CHARS, DEFAULT_CAPTION_CHARS, MAX_NEIGHBORS, MAX_REPLY_DEPTH, MAX_DESCENDANTS,
}
