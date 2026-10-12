'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')

// These are deliberately synthetic fixtures. No Application API/user database
// or Telegram session is read by the test process.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-rag-excluded-parent-'))
process.env.SC_DESKTOP_DIR = tempRoot
process.env.SC_DESKTOP_DB = path.join(tempRoot, 'library.db')
const db = require('./database')
const rag = require('./telegram-rag-index')

test.after(() => { db.close(); fs.rmSync(tempRoot, { recursive: true, force: true }) })

function fixture(name, { parentType = 'other', parentCaption = '', topicId = null } = {}) {
  const sourceId = db.upsertSource({ platform: 'telegram', handle: name, external_id: name, is_explicit: true })
  const parentId = db.upsertItem({ source_id: sourceId, external_id: '10', type: parentType,
    caption: parentCaption, published_at: 100, topic_id: topicId })
  const targetId = db.upsertItem({ source_id: sourceId, external_id: '20', type: 'text', caption: 'agreed',
    published_at: 200000, parent_external_id: '10', topic_id: topicId,
    raw_meta: { telegram_reply: { version: 1, scope: 'same_peer', message_id: 10,
      source_peer: { kind: 'channel', id: 92001 }, target_peer: { kind: 'channel', id: 92001 } } } })
  return { sourceId, parentId, targetId }
}

function stage(targetId, sourceId, document = rag.buildCurrentTelegramDocument(db, targetId)) {
  return { document, ...db.stageTelegramRagGeneration({
    itemId: targetId, sourceId, documentHash: document.documentHash, indexVersion: rag.INDEX_VERSION,
    targetRevision: document.targetReference.local_revision,
    targetContentHash: document.targetReference.content_hash,
    sourceRevision: db.getTelegramRagSourceRevision(sourceId),
    contextRefs: document.contextRefs, chunks: document.chunks,
  }) }
}

function embedAndPublish(generation) {
  const embedding = new Float32Array(db.EMBEDDING_DIM); embedding[0] = 1
  db.saveTelegramRagGenerationVectors(generation.generationId,
    generation.document.chunks.map(chunk => ({ chunk_index: chunk.chunk_index, embedding })))
  const published = db.publishTelegramRagGeneration(generation.generationId, {
    validateSnapshot: ({ target }) => rag.buildCurrentTelegramDocument(db, target.id),
  })
  assert.equal(published.published, true, published.rejection)
}

function oldGeneration(targetId, sourceId, { indexVersion = rag.INDEX_VERSION } = {}) {
  const current = rag.buildCurrentTelegramDocument(db, targetId)
  const document = {
    ...current,
    documentHash: current.unguardedDocumentHash || current.documentHash,
    contextRefs: current.contextRefs.filter(ref => ref.role !== 'excluded_reply_guard'),
  }
  const generation = { document, ...db.stageTelegramRagGeneration({
    itemId: targetId, sourceId, documentHash: document.documentHash, indexVersion,
    targetRevision: document.targetReference.local_revision,
    targetContentHash: document.targetReference.content_hash,
    sourceRevision: db.getTelegramRagSourceRevision(sourceId), contextRefs: document.contextRefs, chunks: document.chunks,
  }) }
  embedAndPublish(generation)
  return generation
}

function preGuardFingerprint(row, supplied = {}) {
  const context = { ...supplied, ancestors: rag.eligibleAncestors(row, supplied.ancestors || []) }
  const ref = (candidate, role) => ({ source_id: candidate.source_id, item_id: candidate.id,
    external_id: String(candidate.external_id), local_revision: Number(candidate.local_revision) || 1,
    content_hash: rag.itemContentHash(candidate), role })
  const fingerprint = {
    version: rag.INDEX_VERSION, model: require('./embedder').MODEL, task_type: 'RETRIEVAL_DOCUMENT',
    target_bytes: rag.TARGET_BYTES, overlap_bytes: rag.OVERLAP_BYTES, context_bytes: rag.CONTEXT_BYTES,
    item_id: row.id, source_id: row.source_id, external_id: String(row.external_id),
    topic_id: rag.normalisedTopic(row), parent_external_id: row.parent_external_id ?? null,
    sender: rag.prefixByBytes(row.sender, 64), caption: String(row.caption || ''),
    target_ref: ref(row, 'target'), context: rag.selectedContext(row, context),
    relation_refs: context.ancestors.map(parent => ref(parent, 'reply-link')),
    missing_refs: context.missingRefs || [],
  }
  return createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex')
}

function state(itemId) { return db.getDb().prepare('SELECT * FROM telegram_rag_item_state WHERE item_id = ?').get(itemId) }

function pythonMutation({ sourceId, parentId }, operation = 'update') {
  const script = `
import json, sys
import library_db
conn = library_db.open_db()
payload = json.loads(sys.argv[1])
if payload['operation'] == 'delete':
    conn.execute('DELETE FROM items WHERE id = ?', (payload['parent_id'],))
else:
    library_db.upsert_item(conn, source_id=payload['source_id'], external_id='10',
        type='other', caption='parent now carries the real question', published_at=100)
conn.commit()
conn.close()
`
  const result = spawnSync('python3', ['-c', script, JSON.stringify({ source_id: sourceId, parent_id: parentId, operation })], {
    env: { ...process.env, PYTHONPATH: path.join(__dirname, '..', 'python-workers', 'shared') },
    encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
}

test('native delayed existing empty parent changing to nonempty must invalidate the ready target', () => {
  const f = fixture('excluded-parent-native-counter')
  const generation = stage(f.targetId, f.sourceId)
  embedAndPublish(generation)
  const guard = generation.document.contextRefs.find(ref => ref.role === 'excluded_reply_guard')
  assert.equal(guard.item_id, f.parentId)
  assert.equal(guard.external_id, '10')
  assert.equal(state(f.targetId).stale, 0)
  db.upsertItem({ source_id: f.sourceId, external_id: '10', type: 'other',
    caption: 'parent now carries the real question', published_at: 100 })
  assert.notEqual(rag.buildCurrentTelegramDocument(db, f.targetId).documentHash, generation.document.documentHash)
  assert.equal(state(f.targetId).stale, 1, 'out-of-day empty parent is still a dependency')
  assert.equal(db.telegramRagIndexStatus(f.sourceId).ready_current_messages, 0)
})

test('Python upsert of an excluded delayed parent invalidates and fences the same ready generation', () => {
  const f = fixture('excluded-parent-python-update')
  const generation = stage(f.targetId, f.sourceId)
  embedAndPublish(generation)
  pythonMutation(f)
  assert.equal(state(f.targetId).stale, 1)
  assert.equal(db.publishTelegramRagGeneration(generation.generationId).rejection, 'dependency_changed')
  assert.equal(db.telegramRagIndexStatus(f.sourceId).ready_current_messages, 0)
})

test('both native SQL writers invalidate excluded-parent deletion outside the chronology window', () => {
  for (const writer of ['javascript', 'python']) {
    const f = fixture(`excluded-parent-${writer}-delete`)
    const generation = stage(f.targetId, f.sourceId)
    embedAndPublish(generation)
    if (writer === 'javascript') db.deleteItem(f.parentId)
    else pythonMutation(f, 'delete')
    assert.equal(state(f.targetId).stale, 1)
    assert.equal(db.publishTelegramRagGeneration(generation.generationId).rejection, 'dependency_changed')
  }
})

test('excluded row in a delayed three-node chain is guarded; a fourth candidate remains outside the unchanged cap', () => {
  for (const excludedDepth of [1, 2, 3, 4]) {
    const sourceId = db.upsertSource({ platform: 'telegram', handle: `excluded-chain-depth-${excludedDepth}` })
    const parentIds = []
    for (let index = excludedDepth; index >= 1; index--) {
      parentIds[index] = db.upsertItem({ source_id: sourceId, external_id: String(index),
        type: index === excludedDepth ? 'other' : 'text', caption: index === excludedDepth ? '' : `chain parent ${index}`,
        published_at: 100 + index, parent_external_id: index < excludedDepth ? String(index + 1) : null })
    }
    const targetId = db.upsertItem({ source_id: sourceId, external_id: '20', type: 'text', caption: 'agreed',
      published_at: 200000, parent_external_id: '1' })
    const generation = stage(targetId, sourceId)
    embedAndPublish(generation)
    const guards = generation.document.contextRefs.filter(ref => ref.role === 'excluded_reply_guard')
    assert.equal(guards.length, excludedDepth <= rag.REPLY_DEPTH ? 1 : 0)
    db.upsertItem({ source_id: sourceId, external_id: String(excludedDepth), type: 'other',
      caption: 'new meaning in formerly excluded row', published_at: 100 + excludedDepth })
    assert.equal(state(targetId).stale, excludedDepth <= rag.REPLY_DEPTH ? 1 : 0)
  }
})

test('direct topic anchor stays outside replies; an existing anchor stopping an ancestor path is only a guard', () => {
  const f = fixture('excluded-topic-anchor', { parentCaption: 'topic creation data', topicId: 10 })
  let document = rag.buildCurrentTelegramDocument(db, f.targetId)
  assert.equal(document.contextRefs.length, 0)
  assert.doesNotMatch(document.embeddingTexts.join('\n'), /topic creation data/)
  const middleId = db.upsertItem({ source_id: f.sourceId, external_id: '15', type: 'text', caption: 'middle reply',
    parent_external_id: '10', topic_id: 11, published_at: 150000 })
  db.bulkUpdateParentExternalId(f.sourceId, [{ external_id: '20', parent_external_id: '15', raw_meta_patch: {
    telegram_reply: { version: 1, scope: 'same_peer', message_id: 15,
      source_peer: { kind: 'channel', id: 92001 }, target_peer: { kind: 'channel', id: 92001 } },
  } }])
  const generation = stage(f.targetId, f.sourceId)
  document = generation.document
  assert.ok(document.contextRefs.some(ref => ref.item_id === middleId && ref.role === 'reply'))
  assert.ok(document.contextRefs.some(ref => ref.item_id === f.parentId && ref.role === 'excluded_reply_guard'))
  assert.doesNotMatch(document.embeddingTexts.join('\n'), /topic creation data/)
  embedAndPublish(generation)
  db.upsertItem({ source_id: f.sourceId, external_id: '10', type: 'other', caption: 'renamed topic creation data', topic_id: 10, published_at: 100 })
  assert.equal(state(f.targetId).stale, 1)
})

test('rows without an excluded guard retain pre-fix fingerprint, input and references byte-for-byte', () => {
  const parent = { id: 1, source_id: 9, external_id: '10', caption: 'real question', sender: 'a', published_at: 100,
    topic_id: 3, local_revision: 1, type: 'text' }
  const row = { id: 2, source_id: 9, external_id: '20', caption: 'own target', sender: 'b', published_at: 200000,
    topic_id: 3, local_revision: 1, type: 'text', parent_external_id: '10' }
  for (const [target, context] of [
    [row, { ancestors: [parent], priors: [] }],
    [{ ...row, caption: 'long text 🧩 '.repeat(500), parent_external_id: null }, { priors: [parent] }],
    [{ ...row, parent_external_id: '99' }, { missingRefs: [{ source_id: 9, external_id: '99', item_id: null,
      local_revision: null, content_hash: null, role: 'missing_reply' }] }],
  ]) {
    const document = rag.buildTelegramDocument(target, context)
    assert.equal(document.documentHash, preGuardFingerprint(target, context))
    assert.equal(Object.hasOwn(document, 'unguardedDocumentHash'), false)
    assert.equal(document.contextRefs.some(ref => ref.role === 'excluded_reply_guard'), false)
    const expectedInputs = document.chunks.map(chunk => `message #${target.external_id} by ${target.sender}:\n${chunk.text}` +
      (document.context.length ? `\nquoted context:\n${document.context.map(ref => ref.header + ref.text).join('\n')}` : ''))
    assert.deepEqual(document.embeddingTexts, expectedInputs)
  }
})

test('guard-only old active generations are detected read-only and repaired with exactly reused complete vectors', () => {
  const f = fixture('excluded-migrate-unchanged')
  const old = oldGeneration(f.targetId, f.sourceId)
  const oldRefs = db.getDb().prepare('SELECT context_refs_json FROM telegram_rag_generations WHERE generation_id = ?').get(old.generationId).context_refs_json
  const oldVector = db.getDb().prepare(`SELECT v.embedding FROM semantic_chunks c JOIN semantic_chunks_vec v ON v.chunk_id = c.id
    WHERE c.item_id = ?`).get(f.targetId).embedding
  const detected = rag.detectTelegramExcludedReplyGuards(db, { sourceId: f.sourceId, limit: 1 })
  assert.deepEqual(detected.item_ids, [f.targetId])
  assert.equal(detected.complete, true)
  assert.equal(detected.details[0].embedding_reuse_proven, true)
  assert.equal(state(f.targetId).active_generation_id, old.generationId, 'detector must not write')
  assert.equal(state(f.targetId).stale, 0)

  const prepared = rag.prepareTelegramIndex(db, f.sourceId, null, { itemIds: detected.item_ids })
  assert.equal(prepared.messagesPending, 1)
  assert.equal(prepared.fragmentsPending, 0, 'full profile/input proof removes the need for Gemini')
  assert.deepEqual(rag.telegramIndexPage(db, 0), [])
  assert.equal(state(f.targetId).active_generation_id, old.generationId, 'preparation only stages')
  assert.equal(rag.publishReadyTelegramGenerations(db), 1)
  assert.notEqual(state(f.targetId).active_generation_id, old.generationId)
  assert.equal(db.getDb().prepare('SELECT context_refs_json FROM telegram_rag_generations WHERE generation_id = ?').get(old.generationId).context_refs_json, oldRefs)
  const newVector = db.getDb().prepare(`SELECT v.embedding FROM semantic_chunks c JOIN semantic_chunks_vec v ON v.chunk_id = c.id
    WHERE c.item_id = ?`).get(f.targetId).embedding
  assert.deepEqual(newVector, oldVector)
  assert.deepEqual(rag.detectTelegramExcludedReplyGuards(db, { sourceId: f.sourceId }).item_ids, [])
})

test('already-active old generation with newly meaningful parent requires fresh embedding, not caption-only reuse', () => {
  const f = fixture('excluded-migrate-changed')
  const old = oldGeneration(f.targetId, f.sourceId)
  pythonMutation(f)
  assert.equal(state(f.targetId).stale, 0, 'fixture recreates the old missing-dependency bug')
  const detected = rag.detectTelegramExcludedReplyGuards(db, { sourceId: f.sourceId })
  assert.deepEqual(detected.item_ids, [f.targetId])
  assert.equal(detected.details[0].embedding_reuse_proven, false)
  assert.notEqual(detected.details[0].current_input_hash, detected.details[0].stored_input_hash)
  const prepared = rag.prepareTelegramIndex(db, f.sourceId, null, { itemIds: detected.item_ids })
  assert.equal(prepared.fragmentsPending, old.document.chunks.length)
  assert.match(rag.telegramIndexPage(db, 0)[0].embedding_text, /parent now carries the real question/)
})

test('guard migration refuses reuse for another profile or incomplete/changed active fragment storage', () => {
  for (const defect of ['profile', 'vector_missing', 'span']) {
    const f = fixture(`excluded-migrate-${defect}`)
    const old = oldGeneration(f.targetId, f.sourceId, { indexVersion: defect === 'profile' ? 'another-profile' : rag.INDEX_VERSION })
    const chunkId = db.getDb().prepare('SELECT id FROM semantic_chunks WHERE item_id = ?').get(f.targetId).id
    if (defect === 'vector_missing') db.getDb().prepare('DELETE FROM semantic_chunks_vec WHERE chunk_id = ?').run(BigInt(chunkId))
    if (defect === 'span') db.getDb().prepare('UPDATE semantic_chunks SET start_char = start_char + 1 WHERE id = ?').run(chunkId)
    const detected = rag.detectTelegramExcludedReplyGuards(db, { sourceId: f.sourceId })
    assert.deepEqual(detected.item_ids, [f.targetId])
    assert.equal(detected.details[0].embedding_reuse_proven, false, defect)
    const prepared = rag.prepareTelegramIndex(db, f.sourceId, null, { itemIds: [f.targetId] })
    assert.equal(prepared.fragmentsPending, old.document.chunks.length, defect)
  }
})

test('bounded detector follows up to three candidates, skips explicit foreign-peer collisions and keeps stable PK pages', () => {
  const f = fixture('excluded-detect-bounded')
  oldGeneration(f.targetId, f.sourceId)
  const secondId = db.upsertItem({ source_id: f.sourceId, external_id: '21', type: 'text', caption: 'second agreed',
    parent_external_id: '10', published_at: 200001 })
  oldGeneration(secondId, f.sourceId)
  const crossId = db.upsertItem({ source_id: f.sourceId, external_id: '22', type: 'text', caption: 'foreign reply',
    parent_external_id: '10', published_at: 200002,
    raw_meta: { telegram_reply: { version: 1, scope: 'external_peer', message_id: 10,
      source_peer: { kind: 'channel', id: 92001 }, target_peer: { kind: 'channel', id: 92002 } } } })
  const cross = stage(crossId, f.sourceId); embedAndPublish(cross)
  const first = rag.detectTelegramExcludedReplyGuards(db, { sourceId: f.sourceId, limit: 1 })
  assert.equal(first.scanned, 1)
  assert.equal(first.complete, false)
  assert.equal(first.next_item_id, f.targetId)
  assert.deepEqual(first.item_ids, [f.targetId])
  const second = rag.detectTelegramExcludedReplyGuards(db, { sourceId: f.sourceId, afterItemId: first.next_item_id, limit: 1 })
  assert.deepEqual(second.item_ids, [secondId])
  const third = rag.detectTelegramExcludedReplyGuards(db, { sourceId: f.sourceId, afterItemId: second.next_item_id, limit: 1 })
  assert.equal(third.complete, true)
  assert.deepEqual(third.item_ids, [])
  assert.equal(third.scanned, 1)
})

test('empty ordinary replies already remain relation dependencies and do not gain an exclusion fingerprint', () => {
  const f = fixture('excluded-empty-ordinary', { parentType: 'text' })
  const generation = stage(f.targetId, f.sourceId)
  assert.equal(Object.hasOwn(generation.document, 'unguardedDocumentHash'), false)
  assert.ok(generation.document.contextRefs.some(ref => ref.item_id === f.parentId && ref.role === 'reply-link'))
  embedAndPublish(generation)
  pythonMutation(f)
  assert.equal(state(f.targetId).stale, 1)
})

test('copied guard-only vectors cannot publish if either SQL writer changes the guarded parent afterward', () => {
  for (const writer of ['javascript', 'python']) {
    const f = fixture(`excluded-copy-fence-${writer}`)
    const old = oldGeneration(f.targetId, f.sourceId)
    const prepared = rag.prepareTelegramIndex(db, f.sourceId, null, { itemIds: [f.targetId] })
    assert.equal(prepared.fragmentsPending, 0)
    if (writer === 'javascript') db.upsertItem({ source_id: f.sourceId, external_id: '10', type: 'other',
      caption: 'parent changed after the vector copy', published_at: 100 })
    else pythonMutation(f)
    assert.throws(() => rag.publishReadyTelegramGenerations(db), /dependency_changed/)
    assert.equal(state(f.targetId).active_generation_id, old.generationId)
    assert.equal(state(f.targetId).stale, 1)
  }
})

test('detector finds a now-meaningful previously excluded ancestor within the depth cap, not beyond it', () => {
  for (const depth of [3, 4]) {
    const sourceId = db.upsertSource({ platform: 'telegram', handle: `excluded-detect-chain-${depth}` })
    for (let id = 1; id <= depth; id++) db.upsertItem({ source_id: sourceId, external_id: String(id),
      type: id === 1 ? 'other' : 'text', caption: id === 1 ? '' : `parent ${id}`,
      parent_external_id: id > 1 ? String(id - 1) : null, published_at: 100 + id })
    const targetId = db.upsertItem({ source_id: sourceId, external_id: '20', type: 'text', caption: 'agreed',
      parent_external_id: String(depth), published_at: 200000 })
    oldGeneration(targetId, sourceId)
    db.upsertItem({ source_id: sourceId, external_id: '1', type: 'other', caption: 'late real parent text', published_at: 101 })
    const detected = rag.detectTelegramExcludedReplyGuards(db, { sourceId })
    assert.deepEqual(detected.item_ids, depth === 3 ? [targetId] : [])
    if (depth === 3) assert.equal(detected.details[0].embedding_reuse_proven, false)
  }
})

test('detector also finds a pre-guard excluded row already deleted, but does not flag a known missing-parent dependency', () => {
  const f = fixture('excluded-detect-deleted')
  oldGeneration(f.targetId, f.sourceId)
  pythonMutation(f, 'delete')
  assert.equal(state(f.targetId).stale, 0, 'old generation recreates the deletion dependency gap')
  const detected = rag.detectTelegramExcludedReplyGuards(db, { sourceId: f.sourceId })
  assert.deepEqual(detected.item_ids, [f.targetId])
  assert.deepEqual(detected.details[0].missing_guard_external_ids, ['10'])
  assert.equal(detected.details[0].embedding_reuse_proven, false)
  const generation = stage(f.targetId, f.sourceId)
  embedAndPublish(generation)
  assert.deepEqual(rag.detectTelegramExcludedReplyGuards(db, { sourceId: f.sourceId }).item_ids, [])
})
