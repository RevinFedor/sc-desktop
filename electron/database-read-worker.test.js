const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-db-read-worker-'))
process.env.SC_DESKTOP_DIR = tempRoot
process.env.SC_DESKTOP_DB = path.join(tempRoot, 'library.db')

const db = require('./database')
const dbRead = require('./database-read-client')

test.after(async () => {
  await dbRead.stop()
  db.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('large aggregate read runs off the parent event loop', async () => {
  const sourceId = db.upsertSource({
    platform: 'telegram', handle: 'worker-source', display_name: 'worker-source',
    external_id: '1001', meta: { kind: 'channel' }, is_explicit: true,
    tg_session: 'fixture',
  })
  const folderId = db.upsertFolder({ tg_filter_id: 3, title: 'worker-folder', tg_session: 'fixture' })
  db.setFolderSources(folderId, [sourceId])
  db.bulkUpsertItems(Array.from({ length: 5000 }, (_, index) => ({
    source_id: sourceId,
    external_id: String(index + 1),
    type: index % 2 ? 'text' : 'photo',
    caption: `payload ${index}`,
    published_at: index,
  })))

  let heartbeats = 0
  const timer = setInterval(() => { heartbeats += 1 }, 1)
  const rows = await dbRead.request('listFolderSources', folderId)
  clearInterval(timer)

  assert.equal(rows.length, 1)
  assert.equal(rows[0].items_count, 5000)
  assert.ok(heartbeats > 0, `expected parent-loop heartbeats, got ${heartbeats}`)

  const indexStatus = await dbRead.request('semanticIndexStatus', sourceId)
  assert.equal(indexStatus.state, 'idle')
  assert.equal(indexStatus.unit, 'messages')
  assert.equal(indexStatus.done, 0)
  assert.equal(indexStatus.total, 5000)
  assert.equal(indexStatus.ready_current_messages, 0)
  assert.equal(indexStatus.legacy_only_messages, 0)
  assert.equal(indexStatus.staged_fragments, 0)

  const activity = await dbRead.request('activityHistoryRows')
  assert.deepEqual(Object.keys(activity).sort(), [
    'boosty',
    'instagramBatch',
    'local',
    'rutube',
    'telegramLive',
    'telegramSingle',
    'youtube',
    'youtubeBatch',
    'youtubeBatchComments',
    'youtubeComments',
  ])

  const assembled = await dbRead.request('assemblyText', {
    source_id: sourceId,
    types: ['text', 'photo'],
    mode: 'all',
  })
  assert.equal(assembled.count, 5000)
  assert.match(assembled.text, /payload 0/)
  assert.ok(assembled.bytes > 5000)

  const exact = await dbRead.request('copyManyText', sourceId, ['1', '2', '3'])
  assert.equal(exact.count, 3)
  assert.match(exact.text, /payload 0/)

  const exportPath = path.join(tempRoot, 'assembled.txt')
  const saved = await dbRead.request('assemblySave', {
    source_id: sourceId,
    types: ['text'],
    mode: 'all',
  }, exportPath)
  assert.equal(saved.ok, true)
  assert.ok(fs.statSync(exportPath).size > 0)
})

test('desktop RAG reads preserve fragment metadata, topic scope and progressive limits above 100', async () => {
  const sourceId = db.upsertSource({ platform: 'telegram', handle: 'worker-rag-source', tg_session: 'fixture' })
  const query = new Float32Array(db.EMBEDDING_DIM)
  query[0] = 1
  const embedding = new Float32Array(db.EMBEDDING_DIM)
  embedding[0] = 0.8
  embedding[1] = 0.6
  const legacy = []
  for (let n = 1; n <= 150; n++) {
    const id = db.upsertItem({ source_id: sourceId, external_id: String(n), type: 'text',
      caption: `legacy ${n}`, topic_id: 8 })
    legacy.push({ item_id: id, embedding })
  }
  db.bulkUpsertVectors(legacy)
  const modernId = db.upsertItem({ source_id: sourceId, external_id: '200', type: 'text',
    caption: 'current complete caption', topic_id: 8 })
  const row = db.getDb().prepare('SELECT * FROM items WHERE id = ?').get(modernId)
  const generation = db.stageTelegramRagGeneration({ itemId: modernId, sourceId,
    documentHash: 'worker-rag-document', indexVersion: require('./telegram-rag-index').INDEX_VERSION, targetRevision: 1,
    targetContentHash: db.telegramRagItemContentHash(row),
    chunks: [{ chunk_index: 0, start_char: 8, end_char: 16, text: 'complete' }],
  })
  db.saveTelegramRagGenerationVectors(generation.generationId, [{ chunk_index: 0, embedding: query }])
  assert.equal(db.publishTelegramRagGeneration(generation.generationId).published, true)

  const first = await dbRead.request('telegramRagSearch', {
    source_id: sourceId, query_embedding: query, limit: 50, min_cos: -1, topic_id: 8,
  })
  assert.equal(first.rows.length, 50)
  assert.equal(first.rows[0].id, modernId)
  assert.equal(first.rows[0].caption, 'current complete caption')
  assert.equal(first.rows[0]._matched_chunks[0].text, 'complete')
  assert.equal(first.rows[0].generation_id, generation.generationId)
  const more = await dbRead.request('telegramRagSearch', {
    source_id: sourceId, query_embedding: query, limit: 125, min_cos: -1, topic_id: 8,
  })
  assert.equal(more.rows.length, 125)
  assert.equal(new Set(more.rows.map(item => item.id)).size, 125)
  assert.equal(more.coverage.ready_current_messages, 1)
  assert.equal(more.coverage.legacy_only_messages, 150)
  assert.equal(more.diagnostics.candidate_scope, 'source_date_topic_before_knn')
  assert.equal((await dbRead.request('telegramRagSearch', {
    source_id: sourceId, query_embedding: query, limit: 125, min_cos: -1, topic_id: 9,
  })).rows.length, 0)
})

test('batch transcript lookup, assembly and file reads stay in the worker', async () => {
  const sourceId = db.upsertSource({
    platform: 'youtube',
    handle: 'worker-youtube',
    display_name: 'Worker YouTube',
    external_id: 'UC-worker',
    meta: { kind: 'channel' },
    is_explicit: true,
  })
  const firstPath = path.join(tempRoot, 'video-one.txt')
  const secondPath = path.join(tempRoot, 'video-two.txt')
  fs.writeFileSync(firstPath, 'first transcript')
  fs.writeFileSync(secondPath, 'second transcript')
  db.bulkUpsertItems([
    { source_id: sourceId, external_id: 'video-1', type: 'video', title: 'One', caption: 'one', published_at: 1 },
    { source_id: sourceId, external_id: 'video-2', type: 'video', title: 'Two', caption: 'two', published_at: 2 },
  ])
  db.markItemTranscribed({
    source_id: sourceId, external_id: 'video-1', transcript_path: firstPath, engine: 'fixture', cost_usd: 0,
  })
  db.markItemTranscribed({
    source_id: sourceId, external_id: 'video-2', transcript_path: secondPath, engine: 'fixture', cost_usd: 0,
  })

  const state = await dbRead.request('youtubeItemsState', sourceId, ['video-1', 'video-2'])
  assert.equal(state.length, 2)
  assert.deepEqual(new Set(state.map(row => row.transcript_path)), new Set([firstPath, secondPath]))

  const global = await dbRead.request('youtubeItemsStateGlobal', ['video-1', 'video-2'])
  assert.equal(global.length, 2)
  assert.ok(global.every(row => row.origin === 'items'))

  const cachePlan = await dbRead.request('youtubeBatchCachePlan', ['video-1', 'video-2', 'video-3'])
  assert.deepEqual(new Set(cachePlan.cachedIds), new Set(['video-1', 'video-2']))
  assert.deepEqual(cachePlan.runIds, ['video-3'])

  const estimate = await dbRead.request('youtubeBatchAssembly', {
    sourceId,
    videoIds: ['video-1', 'video-2'],
    action: 'estimate',
  })
  assert.equal(estimate.ok, true)
  assert.equal(estimate.count, 2)

  const copied = await dbRead.request('youtubeBatchAssembly', {
    sourceId,
    videoIds: ['video-1', 'video-2'],
    action: 'copy',
  })
  assert.equal(copied.ok, true)
  assert.match(copied.content, /first transcript/)
  assert.match(copied.content, /second transcript/)

  const combinedPath = path.join(tempRoot, 'youtube-combined.txt')
  const saved = await dbRead.request('youtubeBatchAssembly', {
    sourceId,
    videoIds: ['video-1', 'video-2'],
    action: 'save',
    outputPath: combinedPath,
  })
  assert.equal(saved.file_path, combinedPath)
  assert.match(fs.readFileSync(combinedPath, 'utf8'), /second transcript/)

  const direct = await dbRead.request('readTextFiles', [firstPath, secondPath], {
    trim: true,
    separator: '\n---\n',
  })
  assert.equal(direct.parts, 2)
  assert.equal(direct.text, 'first transcript\n---\nsecond transcript\n')
})

test('Boosty hierarchy and storage stats are projected off main', async () => {
  const sourceId = db.upsertSource({
    platform: 'boosty',
    handle: 'worker-boosty',
    display_name: 'Worker Boosty',
    external_id: 'boosty-worker',
    meta: { kind: 'channel' },
    is_explicit: true,
  })
  const audioPath = path.join(tempRoot, 'boosty-audio.m4a')
  const transcriptPath = path.join(tempRoot, 'boosty-transcript.txt')
  fs.writeFileSync(audioPath, Buffer.alloc(2048, 1))
  fs.writeFileSync(transcriptPath, 'boosty transcript')
  db.bulkUpsertItems([
    {
      source_id: sourceId, external_id: 'post:one', type: 'boosty_post',
      title: 'Post one', caption: 'Body', published_at: 10,
      raw_meta: { entity_kind: 'post', access_state: 'accessible', video_count: 1 },
    },
    {
      source_id: sourceId, external_id: 'video:one', type: 'boosty_video',
      title: 'Video one', caption: 'Video', published_at: 10,
      parent_external_id: 'post:one', duration_seconds: 120,
      raw_meta: { entity_kind: 'video', position: 0 },
    },
  ])
  db.markItemDownloaded({ source_id: sourceId, external_id: 'video:one', media_path: audioPath })
  db.markItemTranscribed({
    source_id: sourceId, external_id: 'video:one', transcript_path: transcriptPath,
    engine: 'fixture', cost_usd: 0,
  })

  const result = await dbRead.request('boostyPosts', sourceId, {
    audio_dir: tempRoot,
    video_dir: tempRoot,
  })
  assert.equal(result.ok, true)
  assert.equal(result.posts.length, 1)
  assert.equal(result.posts[0].videos.length, 1)
  assert.equal(result.posts[0].videos[0].media_bytes, 2048)
  assert.equal(result.stats.transcribed, 1)

  const plan = await dbRead.request(
    'boostyBatchPlan', sourceId, ['video:one'], 'transcribe', false,
    { audio_dir: tempRoot, video_dir: tempRoot },
  )
  assert.equal(plan.total, 1)
  assert.equal(plan.cachedLogs.length, 1)
  assert.equal(plan.selection.length, 0)

  const storage = await dbRead.request('boostyPlatformStorage')
  assert.equal(storage.sources, 1)
  assert.ok(storage.audio.bytes >= 2048)
  assert.ok(storage.transcripts.bytes > 0)
})
