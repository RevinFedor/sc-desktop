'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const Database = require('better-sqlite3')
const { createTelegramRagReaders, readTelegramCaptionSpan, annotateSemanticContextRefs, MAX_CAPTION_CHARS } = require('./telegram-rag-readers')
const { itemContentHash } = require('../electron/telegram-rag-index')

function fixture(t) {
  const handle = new Database(':memory:')
  t.after(() => handle.close())
  handle.exec(`
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY, platform TEXT NOT NULL, handle TEXT NOT NULL,
      display_name TEXT, external_id TEXT, meta_json TEXT, tg_session TEXT
    );
    CREATE TABLE items (
      id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, external_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text', url TEXT, title TEXT, caption TEXT,
      published_at INTEGER, sender TEXT, topic_id INTEGER, topic_title TEXT,
      parent_external_id TEXT, reply_resolved INTEGER DEFAULT 1, reactions TEXT,
      raw_meta_json TEXT, has_media INTEGER DEFAULT 0,
      media_path TEXT, transcript_path TEXT, transcribe_status TEXT, transcribe_engine TEXT,
      UNIQUE(source_id, external_id)
    );
    CREATE INDEX items_parent ON items(source_id, parent_external_id);
    CREATE INDEX items_source_published ON items(source_id, published_at);
    CREATE TABLE telegram_rag_item_state (item_id INTEGER PRIMARY KEY, local_revision INTEGER NOT NULL DEFAULT 1);
  `)
  const putSource = handle.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?)')
  putSource.run(1, 'telegram', '-100111', 'The actual discussion', '111', JSON.stringify({ kind: 'group', username: 'source_channel_stale' }), 'test_session')
  putSource.run(2, 'telegram', 'other_channel', 'Other source', '222', JSON.stringify({ kind: 'channel' }), 'test_session')
  putSource.run(3, 'youtube', 'non_telegram', 'Not Telegram', '333', '{}', null)
  putSource.run(4, 'telegram', 'a_person', 'Person', '444', JSON.stringify({ kind: 'user' }), 'test_session')
  function insert(values) {
    const row = { source_id: 1, type: 'text', caption: '', published_at: 100, ...values }
    if (row.raw_meta_json === undefined) {
      const peer = { id: row.source_id === 1 ? 111 : row.source_id === 2 ? 222 : 444, kind: row.source_id === 4 ? 'user' : 'channel' }
      const parent = row.parent_external_id == null ? null : String(row.parent_external_id)
      row.raw_meta_json = JSON.stringify({ telegram_reply: {
        version: 1, source_peer: peer, target_peer: peer, message_id: parent,
        scope: parent ? (parent === String(row.topic_id) ? 'topic_anchor' : 'same_peer') : 'none',
      }, external_reply: null })
    }
    const keys = Object.keys(row)
    handle.prepare(`INSERT INTO items (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map(key => row[key]))
    handle.prepare('INSERT INTO telegram_rag_item_state(item_id) VALUES (?)').run(row.id)
    return row
  }
  return { handle, insert, readers: createTelegramRagReaders(handle) }
}

test('selected message exposes its >800 character tail and paginates the complete caption without splitting emoji', t => {
  const { insert, readers } = fixture(t)
  const chars = [...'начало ', ...'x'.repeat(MAX_CAPTION_CHARS - 10), ...'😀', ...' важный хвост']
  const caption = chars.join('')
  insert({ id: 1, external_id: '501', caption })
  const first = readers.readItem({ item_id: 1 }).item
  assert.equal(first.caption_returned_chars, MAX_CAPTION_CHARS)
  assert.equal(first.caption_total_chars, chars.length)
  assert.equal(first.caption_next_offset, MAX_CAPTION_CHARS)
  assert.equal(first.caption_has_more, true)
  const second = readers.readItem({ source_id: 1, external_id: '501', caption_offset: first.caption_next_offset, expected_caption_hash: first.caption_hash }).item
  assert.equal(first.caption + second.caption, caption)
  assert.equal(second.caption_has_more, false)
  assert.equal(second.caption_next_offset, null)
  assert.equal(second.caption_offset_unit, 'unicode_codepoints')
  assert.equal(second.offset_unit, 'unicode_codepoints')
  assert.equal(readers.readItem({ item_id: 1, caption_offset: chars.length + 100, expected_caption_hash: first.caption_hash }).item.caption, '')
})

test('edited text between pages rejects continuation with stale_message and publishes the new original hash', t => {
  const { handle, insert, readers } = fixture(t)
  insert({ id: 1, external_id: '501', caption: 'исходный 😀 длинный текст' })
  const first = readers.readItem({ item_id: 1, caption_chars: 4 }).item
  const nextArgs = { item_id: 1, caption_offset: first.caption_next_offset, expected_caption_hash: first.caption_hash }
  assert.equal(readers.readItem(nextArgs).item.caption_hash, first.caption_hash)
  handle.prepare('UPDATE items SET caption = ? WHERE id = ?').run('изменённый 😀 длинный текст', 1)
  assert.throws(() => readers.readItem(nextArgs), error => {
    assert.equal(error.code, 'stale_message')
    assert.equal(error.item_id, 1)
    assert.equal(error.source_id, 1)
    assert.equal(error.expected_caption_hash, first.caption_hash)
    assert.notEqual(error.caption_hash, first.caption_hash)
    assert.match(error.message, /restart reading at offset 0/)
    return true
  })
  assert.throws(() => readers.readItem({ item_id: 1, caption_offset: 4 }), { code: 'expected_caption_hash_required' })
  assert.notEqual(readers.readItem({ item_id: 1 }).item.caption_hash, first.caption_hash)
})

test('caption hash covers exact original Unicode text and declares UTF16/codepoint pagination coordinates', t => {
  const { insert, readers } = fixture(t)
  const original = '  e\u0301 😀 https://Example.org/AbC\r\n'
  insert({ id: 1, external_id: '501', caption: original })
  const first = readers.readItem({ item_id: 1, caption_chars: 7 }).item
  assert.equal(first.caption_hash, createHash('sha256').update(original, 'utf8').digest('hex'))
  assert.notEqual(first.caption_hash, createHash('sha256').update(original.normalize('NFC'), 'utf8').digest('hex'))
  const second = readers.readItem({ item_id: 1, caption_offset: 7, expected_caption_hash: first.caption_hash }).item
  assert.equal(second.caption_utf16_offset_unit, 'utf16_code_units')
  assert.equal(second.caption_utf16_offset, 8)
  assert.equal(second.caption_utf16_total_units, original.length)
  assert.equal(second.caption_utf16_returned_units, second.caption.length)
  assert.equal(first.caption + second.caption, original)
})

test('semantic UTF16 match spans map explicitly to codepoint offsets and never return half an emoji', () => {
  const text = 'a😀bc'
  const exact = readTelegramCaptionSpan(text, { start: 1, end: 4, offset_unit: 'utf16_code_units' })
  assert.equal(exact.caption, '😀b')
  assert.deepEqual(exact.span, { start: 1, end: 4, offset_unit: 'utf16_code_units' })
  assert.deepEqual(exact.unicode_span, { start: 1, end: 3, offset_unit: 'unicode_codepoints' })
  assert.equal(exact.boundaries_adjusted, false)
  const split = readTelegramCaptionSpan(text, { start: 2, end: 2, offset_unit: 'utf16_code_units' })
  assert.equal(split.caption, '😀')
  assert.deepEqual(split.requested_span, { start: 2, end: 2, offset_unit: 'utf16_code_units' })
  assert.deepEqual(split.span, { start: 1, end: 3, offset_unit: 'utf16_code_units' })
  assert.equal(split.boundaries_adjusted, true)
  assert.throws(() => readTelegramCaptionSpan(text, { offset_unit: 'unicode_codepoints' }), TypeError)
  assert.throws(() => readTelegramCaptionSpan(text, { start: 6 }), RangeError)
  assert.throws(() => readTelegramCaptionSpan(text, { start: 3, end: 2 }), RangeError)
})

test('ordinary long Telegram text is returned in full by readItem rather than silently trimmed to 800', t => {
  const { insert, readers } = fixture(t)
  const caption = `${'prefix '.repeat(150)}вот точный вывод в хвосте`
  insert({ id: 1, external_id: '501', caption })
  const item = readers.readItem({ item_id: 1 }).item
  assert.equal(item.caption, caption)
  assert.equal(item.caption_truncated, false)
  assert.equal(item.caption_returned_chars, item.caption_total_chars)
  assert.equal(item.caption_next_offset, null)
})

test('item IDs, external IDs and all graph lookups are scoped to the actual Telegram source', t => {
  const { insert, readers } = fixture(t)
  insert({ id: 10, source_id: 1, external_id: '500', caption: 'source one', parent_external_id: '499' })
  insert({ id: 11, source_id: 2, external_id: '500', caption: 'source two' })
  insert({ id: 12, source_id: 2, external_id: '499', caption: 'parent from another source' })
  insert({ id: 13, source_id: 3, external_id: '500', caption: 'not Telegram' })
  assert.equal(readers.readItem({ source_id: 2, external_id: 500 }).item.caption, 'source two')
  assert.equal(readers.readItem({ item_id: 10, source_id: 2 }).error, 'item not found')
  assert.equal(readers.readItem({ item_id: 10, external_id: '501' }).error, 'item not found')
  assert.equal(readers.readItem({ item_id: 13 }).error, 'Telegram source not found')
  const graph = readers.replyThread({ item_id: 10 })
  assert.deepEqual(graph.ancestors, [])
  assert.equal(graph.missing_parent_external_id, '499')
  assert.equal(graph.ancestor_stop_reason, 'missing_parent')
  assert.equal(graph.ancestor_chain_truncated, false)
  assert.deepEqual(readers.context({ item_id: 10 }).conversation.map(item => item.source_id), [1])
})

test('chronological neighbors use Telegram message ID for identical timestamps, irrespective of insert IDs', t => {
  const { insert, readers } = fixture(t)
  insert({ id: 4, external_id: '300', caption: 'third' })
  insert({ id: 9, external_id: '200', caption: 'center' })
  insert({ id: 100, external_id: '100', caption: 'first' })
  insert({ id: 101, external_id: '5', published_at: 50, caption: 'old sparse id' })
  insert({ id: 102, external_id: '9000', published_at: 150, caption: 'new sparse id' })
  const result = readers.neighbors({ item_id: 9, before: 2, after: 2 })
  assert.deepEqual(result.before.map(item => item.external_id), ['5', '100'])
  assert.deepEqual(result.after.map(item => item.external_id), ['300', '9000'])
  assert.equal(result.before_has_more, false)
  assert.equal(result.after_has_more, false)
  const bounded = readers.neighbors({ item_id: 9, before: 1, after: 1 })
  assert.deepEqual(bounded.before.map(item => item.external_id), ['100'])
  assert.equal(bounded.before_has_more, true)
  assert.equal(bounded.after_has_more, true)
  assert.equal(result.neighbors_are_not_reply_edges, true)
})

test('mixed-topic neighbors preserve old all-topic behavior and support explicit same_topic filtering', t => {
  const { insert, readers } = fixture(t)
  insert({ id: 1, external_id: '10', published_at: 10, topic_id: 77, topic_title: 'career', caption: 'same before' })
  insert({ id: 2, external_id: '20', published_at: 20, topic_id: 88, caption: 'other before' })
  insert({ id: 3, external_id: '30', published_at: 30, topic_id: 77, topic_title: 'career', caption: 'center' })
  insert({ id: 4, external_id: '40', published_at: 40, topic_id: 88, caption: 'other after' })
  insert({ id: 5, external_id: '50', published_at: 50, topic_id: 77, caption: 'same after' })
  const all = readers.neighbors({ item_id: 3 })
  assert.deepEqual(all.before.map(item => item.external_id), ['10', '20'])
  assert.equal(all.same_topic, false)
  const topic = readers.neighbors({ item_id: 3, same_topic: true })
  assert.deepEqual(topic.before.map(item => item.external_id), ['10'])
  assert.deepEqual(topic.after.map(item => item.external_id), ['50'])
  assert.equal(topic.center.topic_title, 'career')
  assert.equal(topic.center.url, 'https://t.me/c/111/77/30')
})

test('topic-anchor membership is not a reply; a true reply in the same topic remains a graph edge', t => {
  const { insert, readers } = fixture(t)
  insert({ id: 1, external_id: '77', topic_id: 77, type: 'other', caption: 'topic created' })
  insert({ id: 2, external_id: '100', topic_id: 77, parent_external_id: '77', caption: 'ordinary topic post' })
  insert({ id: 3, external_id: '105', topic_id: 77, parent_external_id: '100', caption: 'real reply' })
  const graph = readers.replyThread({ item_id: 2 })
  assert.deepEqual(graph.ancestors, [])
  assert.equal(graph.center.parent_external_id, '77')
  assert.equal(graph.center.reply_parent_external_id, null)
  assert.equal(graph.center.parent_relation, 'topic_anchor')
  assert.deepEqual(graph.descendants.map(item => item.external_id), ['105'])
  assert.deepEqual(readers.replyThread({ item_id: 1 }).descendants, [])
})

test('cross-peer #99 cannot collide with local #99 or appear as its descendant, while same-peer proof preserves true replies', t => {
  const { insert, readers } = fixture(t)
  const packet = { version: 1, source_peer: { kind: 'channel', id: 111 }, target_peer: { kind: 'channel', id: 222 }, message_id: 99, scope: 'external_peer' }
  insert({ id: 1, external_id: '99', caption: 'unrelated local #99', published_at: 1 })
  insert({ id: 2, external_id: '100', caption: 'reply to another chat', parent_external_id: '99', published_at: 200000, raw_meta_json: JSON.stringify({ telegram_reply: packet, external_reply: { peer: packet.target_peer, message_id: 99, quote_text: 'Exact external quote', quote_offset: 4 } }) })
  insert({ id: 3, external_id: '101', caption: 'actual local reply', parent_external_id: '99', published_at: 200001 })
  const cross = readers.replyThread({ item_id: 2 })
  assert.deepEqual(cross.ancestors, [])
  assert.equal(cross.ancestor_stop_reason, 'external_reply')
  assert.equal(cross.center.reply_parent_external_id, null)
  assert.equal(cross.center.reply_scope, 'external_peer')
  assert.equal(cross.center.external_reply.peer.id, 222)
  assert.equal(cross.center.external_reply.message_id, '99')
  assert.equal(cross.center.external_reply.quote_text, 'Exact external quote')
  assert.equal(cross.center.parent_relation, 'external_reply')
  assert.deepEqual(readers.replyThread({ item_id: 1, max_descendants: 1 }).descendants.map(item => item.external_id), ['101'])
  assert.deepEqual(readers.replyThread({ item_id: 3 }).ancestors.map(item => item.external_id), ['99'])
  assert.equal(readers.context({ item_id: 2 }).reply_edges.some(edge => edge.from_item_id === 2), false)
})

test('legacy absent peer provenance preserves the candidate path while clearly separating it from actual reply edges', t => {
  const { insert, readers } = fixture(t)
  insert({ id: 1, external_id: '99', caption: 'local message' })
  insert({ id: 2, external_id: '100', parent_external_id: '99', caption: 'legacy message', raw_meta_json: '{}' })
  const graph = readers.replyThread({ item_id: 2 })
  assert.deepEqual(graph.ancestors.map(item => item.external_id), ['99'])
  assert.equal(graph.ancestors[0].edge_relation_quality, 'unknown_legacy')
  assert.equal(graph.ancestors[0].path_relation_quality, 'unknown_legacy')
  assert.equal(graph.provenance_complete, false)
  assert.equal(graph.center.parent_external_id, '99')
  assert.equal(graph.center.reply_parent_external_id, null)
  assert.equal(graph.center.unverified_parent_external_id, '99')
  assert.equal(graph.center.reply_scope, 'unknown_legacy')
  assert.equal(graph.center.parent_relation, 'unverified_parent')
  const context = readers.context({ item_id: 2 })
  assert.deepEqual(context.reply_edges, [])
  assert.deepEqual(context.legacy_reply_candidate_edges, [{ from_item_id: 2, to_item_id: 1, relation: 'legacy_reply_candidate', relation_quality: 'unknown_legacy' }])
  assert.equal(context.conversation.find(item => item.item_id === 1).relations.includes('legacy_reply_candidate_ancestor'), true)
})

test('unknown ancestor boundary provenance is counted before missing/depth/cycle exits, not only for returned nodes', t => {
  const { handle, insert, readers } = fixture(t)
  insert({ id: 1, external_id: '20', parent_external_id: '999', raw_meta_json: '{}', caption: 'legacy boundary' })
  insert({ id: 2, external_id: '30', parent_external_id: '20', caption: 'checked center' })
  const missing = readers.replyThread({ item_id: 2 })
  assert.equal(missing.ancestors[0].path_relation_quality, 'same_peer')
  assert.equal(missing.ancestor_stop_reason, 'missing_parent')
  assert.equal(missing.ancestor_boundary_relation_quality, 'unknown_legacy')
  assert.equal(missing.provenance_complete, false)
  assert.equal(missing.local_traversal_complete, false)
  assert.equal(missing.telegram_completeness, 'not_checked_local_reader')
  insert({ id: 3, external_id: '999', caption: 'older boundary target' })
  const depth = readers.replyThread({ item_id: 2, max_depth: 1 })
  assert.equal(depth.ancestor_stop_reason, 'max_depth')
  assert.equal(depth.ancestor_boundary_relation_quality, 'unknown_legacy')
  assert.equal(depth.provenance_complete, false)
  handle.prepare('UPDATE items SET parent_external_id = ? WHERE id = ?').run('30', 1)
  const cycle = readers.replyThread({ item_id: 2 })
  assert.equal(cycle.ancestor_cycle_detected, true)
  assert.equal(cycle.ancestor_boundary_relation_quality, 'unknown_legacy')
  assert.equal(cycle.provenance_complete, false)
  assert.equal(readers.context({ item_id: 2 }).provenance_complete, false)
})

test('unknown descendant boundary provenance survives node/depth/cycle limits even when the candidate was not returned', t => {
  const { handle, insert, readers } = fixture(t)
  insert({ id: 1, external_id: '10', caption: 'checked root' })
  insert({ id: 2, external_id: '20', parent_external_id: '10', raw_meta_json: '{}', caption: 'unverified child' })
  const nodes = readers.replyThread({ item_id: 1, max_descendants: 0 })
  assert.deepEqual(nodes.descendants, [])
  assert.equal(nodes.descendants_node_truncated, true)
  assert.equal(nodes.descendant_boundary_relation_quality, 'unknown_legacy')
  assert.equal(nodes.provenance_complete, false)
  const depth = readers.replyThread({ item_id: 1, max_depth: 0 })
  assert.equal(depth.descendants_depth_truncated, true)
  assert.equal(depth.provenance_complete, false)
  handle.prepare('UPDATE items SET parent_external_id = ? WHERE id = ?').run('20', 1)
  handle.prepare('UPDATE items SET raw_meta_json = ? WHERE id = ?').run(JSON.stringify({ telegram_reply: { version: 1, scope: 'same_peer', source_peer: null, target_peer: null, message_id: 20 } }), 1)
  const cycle = readers.replyThread({ item_id: 1 })
  assert.equal(cycle.descendants_cycle_detected, true)
  assert.equal(cycle.descendant_boundary_relation_quality, 'unknown_legacy')
  assert.equal(cycle.provenance_complete, false)
})

function refFor(handle, id, role, overrides = {}) {
  const row = handle.prepare('SELECT * FROM items WHERE id = ?').get(id)
  return { source_id: row.source_id, item_id: row.id, external_id: row.external_id,
    local_revision: 1, content_hash: itemContentHash(row), role, ...overrides }
}

function semanticTarget(handle, id) {
  return { ...handle.prepare('SELECT * FROM items WHERE id = ?').get(id), local_revision: 1 }
}

test('semantic refs separate checked ancestry, legacy candidates, neighbors and missing guards without changing stored roles/hashes', t => {
  const { handle, insert } = fixture(t)
  insert({ id: 1, external_id: '10', caption: 'chronological candidate' })
  insert({ id: 2, external_id: '20', parent_external_id: '999', raw_meta_json: '{}', caption: 'legacy parent path' })
  insert({ id: 3, external_id: '30', parent_external_id: '20', caption: 'checked hit' })
  const refs = [refFor(handle, 2, 'reply'), refFor(handle, 1, 'prior'),
    { source_id: 1, item_id: null, external_id: '999', local_revision: null, content_hash: null, role: 'missing_reply' }]
  const before = JSON.stringify(refs)
  const annotated = annotateSemanticContextRefs(handle, semanticTarget(handle, 3), refs)
  assert.equal(JSON.stringify(refs), before)
  assert.equal(annotated[0].embedding_role, 'reply')
  assert.equal(annotated[0].role, 'reply')
  assert.equal(annotated[0].content_hash, refs[0].content_hash)
  assert.equal(annotated[0].role_is_embedding_only, true)
  assert.equal(annotated[0].retrieval_relation, 'verified_reply_ancestor')
  assert.equal(annotated[0].edge_relation_quality, 'same_peer')
  assert.equal(annotated[0].node_reply_scope, 'unknown_legacy', 'the parent own next edge remains unknown even though the incoming edge is checked')
  assert.equal(annotated[1].retrieval_relation, 'chronological_neighbor')
  assert.equal(annotated[1].edge_relation_quality, 'not_reply')
  assert.equal(annotated[2].retrieval_relation, 'dependency_guard')
  assert.equal(annotated[2].guard_state, 'still_missing')
  assert.equal(annotated[2].path_relation_quality, 'unknown_legacy')
  const legacy = annotateSemanticContextRefs(handle, semanticTarget(handle, 2), [refFor(handle, 1, 'reply')])
  assert.equal(legacy[0].retrieval_relation, 'unverified_reply_reference', 'an arbitrary reference is not placed on the legacy path')
  handle.prepare('UPDATE items SET parent_external_id = ? WHERE id = ?').run('10', 2)
  const candidate = annotateSemanticContextRefs(handle, semanticTarget(handle, 2), [refFor(handle, 1, 'reply')])
  assert.equal(candidate[0].retrieval_relation, 'legacy_reply_candidate_ancestor')
  assert.equal(candidate[0].edge_relation_quality, 'unknown_legacy')
  assert.equal(candidate[0].path_relation_quality, 'unknown_legacy')
})

test('semantic ref resolution never borrows a foreign-source PK or a same-source wrong external identity', t => {
  const { handle, insert } = fixture(t)
  insert({ id: 1, external_id: '20', caption: 'actual local parent' })
  insert({ id: 2, external_id: '30', parent_external_id: '20', caption: 'local hit' })
  insert({ id: 9, source_id: 2, external_id: '20', caption: 'foreign parent with same number' })
  const queries = []
  const scopedHandle = { prepare(sql) {
    const statement = handle.prepare(sql)
    return { get: (...args) => { if (sql.includes('FROM items')) queries.push(args); return statement.get(...args) }, all: (...args) => statement.all(...args) }
  } }
  const refs = [refFor(handle, 9, 'reply'), refFor(handle, 9, 'reply', { source_id: 1 }), refFor(handle, 1, 'reply', { external_id: '999' })]
  const result = annotateSemanticContextRefs(scopedHandle, semanticTarget(handle, 2), refs)
  assert.equal(result[0].retrieval_relation, 'source_scope_guard')
  assert.equal(result[0].scope_guard, 'rejected')
  assert.equal(result[1].retrieval_relation, 'unverified_reference')
  assert.equal(result[1].node_revision_status, 'missing')
  assert.equal(result[2].retrieval_relation, 'unverified_reference')
  assert.ok(queries.every(args => args[0] === 1))
})

test('semantic refs with stale/missing revisions or changed content never get verified ancestry labels', t => {
  const { handle, insert } = fixture(t)
  insert({ id: 1, external_id: '20', caption: 'parent' })
  insert({ id: 2, external_id: '30', parent_external_id: '20', caption: 'hit' })
  const target = semanticTarget(handle, 2)
  const staleRevision = refFor(handle, 1, 'reply', { local_revision: 2 })
  const unknownRevision = refFor(handle, 1, 'reply', { local_revision: null })
  const badHash = refFor(handle, 1, 'reply', { content_hash: '0'.repeat(64) })
  for (const [ref, status] of [[staleRevision, 'stale'], [unknownRevision, 'unknown'], [badHash, 'stale']]) {
    const result = annotateSemanticContextRefs(handle, target, [ref])[0]
    assert.equal(result.node_revision_status, status)
    assert.equal(result.retrieval_relation, 'unverified_reference')
    assert.equal(result.edge_relation_quality, 'unknown')
  }
  const previouslyCurrent = refFor(handle, 1, 'reply')
  handle.prepare('DELETE FROM telegram_rag_item_state WHERE item_id = ?').run(1)
  const missingNodeRevision = annotateSemanticContextRefs(handle, target, [previouslyCurrent])[0]
  assert.equal(missingNodeRevision.node_revision_status, 'unknown')
  assert.equal(missingNodeRevision.retrieval_relation, 'unverified_reference')
  assert.equal(missingNodeRevision.edge_relation_quality, 'unknown')
})

test('semantic refs turn known external namespaces into guards and dependency-only roles into explicit non-caption evidence', t => {
  const { handle, insert } = fixture(t)
  insert({ id: 1, external_id: '99', caption: 'unrelated local #99' })
  insert({ id: 2, external_id: '100', parent_external_id: '99', caption: 'external hit', raw_meta_json: JSON.stringify({ telegram_reply: { version: 1, source_peer: { kind: 'channel', id: 111 }, target_peer: { kind: 'channel', id: 222 }, message_id: 99, scope: 'external_peer' }, external_reply: { peer: { kind: 'channel', id: 222 }, message_id: 99 } }) })
  const external = annotateSemanticContextRefs(handle, semanticTarget(handle, 2), [refFor(handle, 1, 'reply')])[0]
  assert.equal(external.retrieval_relation, 'external_reply_guard')
  assert.equal(external.guard_state, 'external_namespace')
  assert.equal(external.edge_relation_quality, 'unknown')
  insert({ id: 3, external_id: '101', parent_external_id: '99', caption: 'local hit' })
  const dependency = annotateSemanticContextRefs(handle, semanticTarget(handle, 3), [refFor(handle, 1, 'reply-link')])[0]
  assert.equal(dependency.retrieval_relation, 'dependency_guard')
  assert.equal(dependency.guard_state, 'present_dependency')
  assert.equal(dependency.in_embedding_context, false)
  assert.equal(dependency.role_is_embedding_only, true)
  assert.equal(dependency.edge_relation_quality, 'same_peer')
  const excludedRef = refFor(handle, 1, 'excluded_reply_guard', { guard_reason: 'service_message' })
  const excluded = annotateSemanticContextRefs(handle, semanticTarget(handle, 3), [excludedRef])[0]
  assert.equal(excluded.retrieval_relation, 'dependency_guard')
  assert.equal(excluded.guard_state, 'present_excluded_parent')
  assert.equal(excluded.in_embedding_context, false)
  assert.equal(excluded.embedding_role, 'excluded_reply_guard')
  assert.equal(excluded.guard_reason, 'service_message')
  handle.prepare('UPDATE items SET caption = ? WHERE id = ?').run('changed excluded row', 1)
  assert.equal(annotateSemanticContextRefs(handle, semanticTarget(handle, 3), [excludedRef])[0].guard_state, 'changed_excluded_parent')
  handle.prepare('DELETE FROM items WHERE id = ?').run(1)
  assert.equal(annotateSemanticContextRefs(handle, semanticTarget(handle, 3), [excludedRef])[0].guard_state, 'missing_excluded_parent')
})

test('public semantic wire annotates guards in the shared read transaction and preserves saved processed-caption metadata', t => {
  process.env.SC_DESKTOP_DB = ':memory:'
  const db = require('../electron/database')
  const { prepareTelegramIndex, telegramIndexPage, saveTelegramIndexBatch } = require('../electron/telegram-rag-index')
  const { searchTelegramRag } = require('../electron/telegram-rag-search')
  const { serializeTelegramItem } = require('./telegram-rag-readers')
  t.after(() => db.close())
  const sid = db.upsertSource({ platform: 'telegram', handle: '-1009111', external_id: '9111', meta: { kind: 'group' } })
  const meta = parent => ({ telegram_reply: { version: 1, source_peer: { kind: 'channel', id: 9111 }, target_peer: { kind: 'channel', id: 9111 }, message_id: parent, scope: parent ? 'same_peer' : 'none' }, external_reply: null })
  db.upsertItem({ source_id: sid, external_id: '99', type: 'other', caption: '', published_at: 1, raw_meta: meta(null), reply_resolved: true })
  const caption = `${'original caption '.repeat(3000)}\n\n[фото — описание · gemini]\nmodel-generated description`
  const target = db.upsertItem({ source_id: sid, external_id: '100', type: 'photo', caption, published_at: 200000, parent_external_id: '99', raw_meta: meta(99), has_media: true, reply_resolved: true })
  db.appendItemTranscript({ source_id: sid, external_id: '100', kind: 'photo', engine: 'gemini', text: 'model-generated description' })
  prepareTelegramIndex(db, sid, 1)
  const pending = telegramIndexPage(db, 0)
  assert.ok(pending.length > 32, 'fixture crosses the first candidate budget')
  const embedding = new Float32Array(db.EMBEDDING_DIM)
  embedding[0] = 1
  saveTelegramIndexBatch(db, pending, pending.map(() => embedding))
  const stored = db.getDb().prepare('SELECT context_refs_json FROM telegram_rag_generations WHERE item_id = ? AND status = ?').get(target, 'active').context_refs_json
  let annotatedCalls = 0
  const result = searchTelegramRag(db, { query_embedding: embedding, source_id: sid, limit: 1 }, {
    annotateContextRefs: (row, refs) => {
      assert.equal(db.getDb().inTransaction, true)
      annotatedCalls++
      return annotateSemanticContextRefs(db.getDb(), row, refs)
    },
  })
  assert.equal(annotatedCalls, 1)
  assert.ok(result.diagnostics.fragment_budget >= 64, 'one annotation is reused across adaptive candidate pages and same-generation matches')
  assert.equal(result.rows[0].id, target)
  const guard = result.rows[0]._matched_chunks[0].context_refs.find(ref => ref.role === 'excluded_reply_guard')
  assert.ok(guard)
  assert.equal(guard.retrieval_relation, 'dependency_guard')
  assert.equal(guard.guard_state, 'present_excluded_parent')
  assert.equal(guard.in_embedding_context, false)
  assert.equal(guard.role_is_embedding_only, true)
  assert.equal(db.getDb().prepare('SELECT context_refs_json FROM telegram_rag_generations WHERE item_id = ? AND status = ?').get(target, 'active').context_refs_json, stored)
  const item = serializeTelegramItem(result.rows[0], result.source)
  assert.equal(item.caption_source, 'saved_caption')
  assert.equal(item.caption_may_include_processed_media, true)
  assert.equal(item.caption_contains_processing_marker, true)
  assert.equal(item.transcribe_status, 'done')
  assert.equal(item.transcribe_engine, 'gemini')
})

test('saved captions label model description/transcription presence without claiming all text was typed by the author', t => {
  const { insert, readers } = fixture(t)
  insert({ id: 1, external_id: '10', caption: 'original caption\n\n[фото — описание · gemini]\ngenerated description', type: 'photo', has_media: 1, transcribe_status: 'done', transcribe_engine: 'gemini' })
  const item = readers.readItem({ item_id: 1 }).item
  assert.equal(item.caption_source, 'saved_caption')
  assert.equal(item.caption_may_include_processed_media, true)
  assert.equal(item.caption_contains_processing_marker, true)
  assert.equal(item.transcribe_engine, 'gemini')
})

test('missing parent and unresolved historical reply metadata are distinguished from depth truncation', t => {
  const { insert, readers } = fixture(t)
  insert({ id: 1, external_id: '10', parent_external_id: '2' })
  insert({ id: 2, external_id: '20', reply_resolved: 0 })
  const missing = readers.replyThread({ item_id: 1, max_depth: 0 })
  assert.equal(missing.ancestor_stop_reason, 'missing_parent')
  assert.equal(missing.missing_parent_external_id, '2')
  assert.equal(missing.ancestor_chain_truncated, false)
  const unresolved = readers.replyThread({ item_id: 2 })
  assert.equal(unresolved.ancestor_stop_reason, 'reply_unresolved')
  assert.equal(unresolved.center.reply_resolved, false)
})

test('long reply chains expose actual ancestor/descendant depth truncation and permit exact boundary completeness', t => {
  const { insert, readers } = fixture(t)
  for (let n = 1; n <= 15; n++) insert({ id: n, external_id: String(1000 + n), parent_external_id: n === 1 ? null : String(1000 + n - 1), published_at: n })
  const ancestors = readers.replyThread({ item_id: 15, max_depth: 5 })
  assert.deepEqual(ancestors.ancestors.map(item => item.hop), [5, 4, 3, 2, 1])
  assert.equal(ancestors.ancestor_stop_reason, 'max_depth')
  assert.equal(ancestors.ancestor_chain_truncated, true)
  const truncated = readers.replyThread({ item_id: 1, max_depth: 3 })
  assert.deepEqual(truncated.descendants.map(item => item.external_id), ['1002', '1003', '1004'])
  assert.equal(truncated.descendants_depth_truncated, true)
  assert.equal(truncated.descendants_node_truncated, false)
  const exact = readers.replyThread({ item_id: 12, max_depth: 3, max_descendants: 3 })
  assert.equal(exact.descendants.length, 3)
  assert.equal(exact.descendants_truncated, false)
  assert.equal(exact.ancestor_chain_truncated, true)
})

test('wide reply trees distinguish a real extra node from exactly filling max_descendants', t => {
  const { insert, readers } = fixture(t)
  insert({ id: 1, external_id: '100' })
  for (let n = 2; n <= 5; n++) insert({ id: n, external_id: String(100 + n), parent_external_id: '100', published_at: n })
  const short = readers.replyThread({ item_id: 1, max_descendants: 3 })
  assert.equal(short.descendants.length, 3)
  assert.equal(short.descendants_node_truncated, true)
  const exact = readers.replyThread({ item_id: 1, max_descendants: 4 })
  assert.equal(exact.descendants.length, 4)
  assert.equal(exact.descendants_truncated, false)
  const zero = readers.replyThread({ item_id: 1, max_descendants: 0 })
  assert.equal(zero.descendants.length, 0)
  assert.equal(zero.descendants_node_truncated, true)
})

test('corrupt cyclic reply data terminates and does not duplicate the center in either direction', t => {
  const { insert, readers } = fixture(t)
  insert({ id: 1, external_id: '10', parent_external_id: '20' })
  insert({ id: 2, external_id: '20', parent_external_id: '30' })
  insert({ id: 3, external_id: '30', parent_external_id: '10' })
  const graph = readers.replyThread({ item_id: 1 })
  assert.equal(graph.ancestor_cycle_detected, true)
  assert.equal(graph.descendants_cycle_detected, true)
  assert.equal(graph.ancestors.length, 2)
  assert.equal(graph.descendants.length, 2)
  assert.equal(graph.descendants_truncated, false)
  const context = readers.context({ item_id: 1 })
  assert.equal(context.conversation.length, 3)
  assert.equal(context.conversation.filter(item => item.item_id === 1).length, 1)
})

test('forward and media provenance survive; the citation URL refers to the real source, not the forwarded channel', t => {
  const { insert, readers } = fixture(t)
  const forward = { source: { id: 999, kind: 'channel', username: 'original_source', name: 'Original' }, channel_post: 1234, from_name: null, date: '2026-10-06T00:00:00Z' }
  insert({ id: 1, external_id: '200', url: 'https://t.me/original_source/1234', sender: 'Forwarding author', title: 'caption title', topic_id: 77, has_media: 1, raw_meta_json: JSON.stringify({ forward, access_hash: 'never expose', media: [{ kind: 'document', file_name: 'example.md', bytes: 1200, content_type: 'text/markdown', access_hash: 'secret' }] }) })
  const item = readers.readItem({ item_id: 1 }).item
  assert.equal(item.url, 'https://t.me/c/111/77/200')
  assert.equal(item.forward.source.id, 999)
  assert.equal(item.forward.channel_post, 1234)
  assert.equal(item.sender, 'Forwarding author')
  assert.equal(item.title, 'caption title')
  assert.equal(item.has_media, true)
  assert.equal(item.media[0].file_name, 'example.md')
  assert.equal(item.media[0].bytes, 1200)
  assert.equal(JSON.stringify(item).includes('access_hash'), false)
  insert({ id: 2, source_id: 4, external_id: '200', url: 'https://t.me/original_source/1234' })
  assert.equal(readers.readItem({ item_id: 2 }).item.url, null)
})

test('source group labels alone never fabricate channel permalinks; only resolved peer evidence permits one', t => {
  const { handle, insert, readers } = fixture(t)
  const putSource = handle.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?)')
  putSource.run(5, 'telegram', '555', 'basic group mislabeled by an imported contract', '555', JSON.stringify({ kind: 'group' }), 'test_session')
  putSource.run(6, 'telegram', 'looks_like_handle', 'Display name used as a target', '666', '{}', 'test_session')
  putSource.run(7, 'telegram', 'verified_group', 'Actual public supergroup', '777', JSON.stringify({ kind: 'group', username: 'verified_group' }), 'test_session')
  putSource.run(8, 'telegram', '888', 'Known channel without marked handle', '888', JSON.stringify({ kind: 'channel' }), 'test_session')
  putSource.run(9, 'telegram', '999', 'Confirmed forum without a marked handle', '999', JSON.stringify({ kind: 'group', forum: true }), 'test_session')
  putSource.run(10, 'telegram', '-1010', 'Actual basic Chat from the parser', '1010', JSON.stringify({ kind: 'chat' }), 'test_session')
  putSource.run(11, 'telegram', '1111', 'Explicit supergroup', '1111', JSON.stringify({ kind: 'supergroup' }), 'test_session')
  putSource.run(12, 'telegram', '1212', 'Forum membership stored in item', '1212', JSON.stringify({ kind: 'group' }), 'test_session')
  for (let sid = 5; sid <= 12; sid++) insert({ id: sid, source_id: sid, external_id: '200', ...(sid === 12 ? { topic_id: 77 } : {}) })
  assert.equal(readers.readItem({ item_id: 5 }).item.url, null)
  assert.equal(readers.readItem({ item_id: 6 }).item.url, null)
  assert.equal(readers.readItem({ item_id: 7 }).item.url, 'https://t.me/verified_group/200')
  assert.equal(readers.readItem({ item_id: 8 }).item.url, 'https://t.me/c/888/200')
  assert.equal(readers.readItem({ item_id: 9 }).item.url, 'https://t.me/c/999/200')
  assert.equal(readers.readItem({ item_id: 10 }).item.url, null)
  assert.equal(readers.readItem({ item_id: 11 }).item.url, 'https://t.me/c/1111/200')
  assert.equal(readers.readItem({ item_id: 12 }).item.url, 'https://t.me/c/1212/77/200')
})

test('unified context deduplicates reply and chronological paths with explicit relationship labels', t => {
  const { insert, readers } = fixture(t)
  insert({ id: 9, external_id: '900', published_at: 1, caption: 'old explicit ancestor' })
  insert({ id: 1, external_id: '10', published_at: 2, parent_external_id: '900', caption: 'parent' })
  insert({ id: 2, external_id: '20', published_at: 3, parent_external_id: '10', caption: 'center' })
  insert({ id: 3, external_id: '30', published_at: 4, parent_external_id: '20', caption: 'reply' })
  insert({ id: 4, external_id: '40', published_at: 5, caption: 'adjacent unrelated' })
  const result = readers.context({ item_id: 2, before: 1, after: 2 })
  assert.deepEqual(result.conversation.map(item => item.external_id), ['900', '10', '20', '30', '40'])
  assert.deepEqual(result.conversation.find(item => item.external_id === '10').relations, ['reply_ancestor', 'neighbor_before'])
  assert.deepEqual(result.conversation.find(item => item.external_id === '30').relations, ['reply_descendant', 'neighbor_after'])
  assert.deepEqual(result.conversation.find(item => item.external_id === '40').relations, ['neighbor_after'])
  assert.equal(result.reply_edges.some(edge => edge.from_item_id === 4), false)
  assert.deepEqual(result.reply_edges, [
    { from_item_id: 1, to_item_id: 9, relation: 'reply' },
    { from_item_id: 2, to_item_id: 1, relation: 'reply' },
    { from_item_id: 3, to_item_id: 2, relation: 'reply' },
  ])
  assert.match(result.context_scope, /do not establish/)
})

test('bounds and malformed inputs are explicit, while empty reactions are a verified zero rather than unknown', t => {
  const { insert, readers } = fixture(t)
  insert({ id: 1, external_id: '10', caption: 'abc', reactions: '[]', raw_meta_json: '{broken' })
  assert.equal(readers.readItem({ item_id: 1 }).item.reactions.total, 0)
  assert.equal(readers.readItem({ item_id: 1, caption_chars: 0 }).item.caption_has_more, true)
  for (const args of [{ item_id: 1, caption_chars: 16001 }, { item_id: 1, caption_offset: -1 }, { item_id: 1, caption_offset: 0.5 }]) assert.throws(() => readers.readItem(args), RangeError)
  assert.throws(() => readers.readItem({ external_id: '10' }), TypeError)
  assert.throws(() => readers.readItem({ source_id: 1, external_id: '-10010' }), TypeError)
  assert.throws(() => readers.neighbors({ item_id: 1, before: 101 }), RangeError)
  assert.throws(() => readers.neighbors({ item_id: 1, same_topic: 'yes' }), TypeError)
  assert.throws(() => readers.replyThread({ item_id: 1, max_depth: 51 }), RangeError)
  assert.throws(() => readers.replyThread({ item_id: 1, max_descendants: 501 }), RangeError)
  assert.equal(readers.readItem({ item_id: 9999 }).error, 'item not found')
})
