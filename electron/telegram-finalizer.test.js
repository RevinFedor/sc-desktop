const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-tg-finalizer-'))
process.env.SC_DESKTOP_DIR = tempRoot
process.env.SC_DESKTOP_DB = path.join(tempRoot, 'library.db')

const db = require('./database')
const {
  finalizeTelegramJob,
  finalizeCatalogJob,
  syncTelegramFolder,
  pruneTelegramFolders,
  setTelegramAutoForSources,
  applyTelegramReplyUpdates,
  persistItemMutation,
  finalizeBatchJob,
  stopTelegramFinalizer,
} = require('./telegram-finalizer-client')

test.after(async () => {
  await stopTelegramFinalizer()
  db.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('worker finalizes a large Telegram payload without parking the parent loop', async () => {
  const sourceId = db.upsertSource({
    platform: 'telegram',
    handle: 'finalizer_fixture',
    display_name: 'Finalizer fixture',
    external_id: '99001',
    meta: { kind: 'channel' },
    is_explicit: true,
  })
  const dbRowId = db.recordJob({
    type: 'tg_fetch', source_id: sourceId, status: 'running',
    started_at: 100, params: { mode: 'all' },
  })
  const items = Array.from({ length: 1201 }, (_, index) => ({
    id: index + 1,
    type: 'text',
    text: `сообщение ${index + 1} ${'x'.repeat(80)}`,
    date: new Date((1_700_000_000 + index) * 1000).toISOString(),
    sender: `user-${index % 7}`,
    reactions: [],
  }))
  const filePath = path.join(tempRoot, 'jobs', 'fixture.json')
  const progress = []
  let heartbeats = 0
  const heartbeat = setInterval(() => { heartbeats += 1 }, 2)
  const result = await finalizeTelegramJob({
    id: 1,
    source_id: sourceId,
    dbRowId,
    items,
    params: { mode: 'all' },
    outcomeStatus: 'done',
    type_breakdown: { text: items.length },
    mediaResults: [],
    commentsBuffer: [],
    isSingle: false,
    isMediaOnly: false,
    filePath,
    commentsFilePath: null,
    summary: { id: 1, type: 'tg_fetch', status: 'done', items_total: items.length },
    chunkSize: 250,
  }, { onProgress: row => progress.push(row) })
  clearInterval(heartbeat)

  assert.equal(result.rows, items.length)
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM items WHERE source_id = ?').get(sourceId).n, items.length)
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).items.length, items.length)
  assert.deepEqual(progress.map(row => row.done), [250, 500, 750, 1000, 1201])
  assert.ok(heartbeats > 0, `expected parent-loop heartbeats, got ${heartbeats}`)
})

test('folder synchronization and pruning stay in the persistence worker', async () => {
  const chats = Array.from({ length: 1200 }, (_, index) => ({
    handle: `folder-chat-${index}`,
    title: `Folder chat ${index}`,
    tg_id: 200_000 + index,
    kind: 'channel',
    username: `folder_chat_${index}`,
  }))
  let heartbeats = 0
  const heartbeat = setInterval(() => { heartbeats += 1 }, 1)
  const first = await syncTelegramFolder({
    filter_id: 7,
    title: 'Large folder',
    chats,
    tg_session: 'fixture-session',
  })
  clearInterval(heartbeat)

  assert.equal(first.sourceIds.length, chats.length)
  assert.deepEqual(first.errors, [])
  assert.equal(db.listFolderSources(first.folderId).length, chats.length)
  assert.ok(heartbeats > 0, `expected parent-loop heartbeats, got ${heartbeats}`)

  const obsolete = await syncTelegramFolder({
    filter_id: 8,
    title: 'Obsolete folder',
    chats: chats.slice(0, 1),
    tg_session: 'fixture-session',
  })
  const pruned = await pruneTelegramFolders({
    tg_session: 'fixture-session',
    seen_filter_ids: [7],
  })
  assert.equal(pruned.removed, 1)
  assert.equal(db.getFolder(obsolete.folderId), undefined)
  assert.ok(db.getFolder(first.folderId))

  const auto = await setTelegramAutoForSources({
    source_ids: first.sourceIds,
    patch: { pull: true, index: true, types: ['text'], engine: 'gemini' },
  })
  assert.equal(auto.ok, true)
  assert.equal(auto.updated, chats.length)

  const replySourceId = first.sourceIds[0]
  db.bulkUpsertItems([{
    source_id: replySourceId,
    external_id: '999',
    type: 'text',
    caption: 'reply fixture',
    reply_resolved: false,
    reactions_resolved: false,
  }])
  const applied = await applyTelegramReplyUpdates({
    source_id: replySourceId,
    rows: [{ external_id: '999', parent_external_id: '998', reactions: [] }],
  })
  assert.equal(applied.updated, 1)
  const reply = db.getDb().prepare(
    'SELECT parent_external_id, reply_resolved, reactions_resolved FROM items WHERE source_id=? AND external_id=?'
  ).get(replySourceId, '999')
  assert.deepEqual(reply, { parent_external_id: '998', reply_resolved: 1, reactions_resolved: 1 })
})

test('web catalog mapping, bulk writes and history finalization stay off main', async () => {
  const youtubeSourceId = db.upsertSource({
    platform: 'youtube', handle: 'catalog-youtube', display_name: 'Catalog YouTube',
    external_id: 'UC-catalog', meta: { kind: 'channel' }, is_explicit: true,
  })
  const videos = Array.from({ length: 2500 }, (_, index) => ({
    video_id: `catalog-${index}`,
    url: `https://youtu.be/catalog-${index}`,
    title: `Catalog video ${index}`,
    timestamp: 1_700_000_000 + index,
    duration_sec: 60 + index % 100,
    view_count: index,
  }))
  let heartbeats = 0
  const heartbeat = setInterval(() => { heartbeats += 1 }, 1)
  const youtube = await finalizeCatalogJob({
    kind: 'youtube-channel',
    source_id: youtubeSourceId,
    items: videos,
    status: 'done',
    date_from: 1_700_000_000,
    date_to: 1_700_002_499,
  })
  clearInterval(heartbeat)
  assert.equal(youtube.rows, videos.length)
  assert.equal(db.listItems({ source_id: youtubeSourceId, limit: 3000 }).length, videos.length)
  assert.ok(heartbeats > 0, `expected parent-loop heartbeats, got ${heartbeats}`)

  const instagramSourceId = db.upsertSource({
    platform: 'instagram', handle: 'catalog-instagram', display_name: 'Catalog Instagram',
    external_id: 'ig-catalog', meta: { kind: 'profile' }, is_explicit: true,
  })
  const instagram = await finalizeCatalogJob({
    kind: 'instagram-profile',
    source_id: instagramSourceId,
    items: [{
      external_id: 'reel:catalog', type: 'reel', url: 'https://instagram.com/reel/catalog',
      caption: 'catalog reel', date: '2024-01-01T00:00:00Z', duration_sec: 25,
      views: 10, likes: 2, comments: 1, has_media: true,
    }],
    status: 'done',
    job_type: 'ig_profile_fetch',
    items_done: 1,
    type_breakdown: { reel: 1 },
    params: { backend: 'api', mode: 'reels' },
    started_at: 100,
    finished_at: 101,
  })
  assert.equal(instagram.rows, 1)
  assert.ok(instagram.dbJobId)
  assert.equal(db.listJobsForSource(instagramSourceId, 5)[0].status, 'done')

  const boostyManifest = path.join(tempRoot, 'boosty-thumbnails.json')
  const boosty = await finalizeCatalogJob({
    kind: 'boosty-catalog',
    entity: {
      author_id: 'boosty-author-id', author_handle: 'catalog-boosty',
      title: 'Catalog Boosty', avatar_url: null,
    },
    source_meta: { canonical_url: 'https://boosty.to/catalog-boosty', catalog_complete: true },
    explicit: true,
    mark_synced: true,
    thumbnails: {},
    thumbnail_manifest_path: boostyManifest,
    items: [{
      post_id: 'post-one', external_id: 'post:post-one', title: 'Post one',
      canonical_url: 'https://boosty.to/catalog-boosty/posts/post-one',
      has_access: true, published_at: 1_700_000_000,
      thumbnail_url: 'https://example.invalid/post.jpg',
      videos: [{
        video_id: 'video-one', title: 'Video one', position: 0,
        canonical_url: 'https://boosty.to/catalog-boosty/posts/post-one?video=video-one',
        thumbnail_url: 'https://example.invalid/video.jpg',
      }],
    }],
  })
  assert.equal(boosty.counts.posts, 1)
  assert.equal(boosty.counts.videos, 1)
  assert.equal(boosty.thumbnailItems, null)
  assert.equal(boosty.thumbnailCount, 2)
  assert.equal(JSON.parse(fs.readFileSync(boostyManifest, 'utf8')).items.length, 2)

  const transcriptPath = path.join(tempRoot, 'catalog-transcript.txt')
  const combinedPath = path.join(tempRoot, 'catalog-combined.txt')
  fs.writeFileSync(transcriptPath, 'catalog transcript body')
  await persistItemMutation({
    method: 'markItemTranscribed',
    args: {
      source_id: youtubeSourceId,
      external_id: 'catalog-0',
      transcript_path: transcriptPath,
      engine: 'fixture',
      cost_usd: 0,
    },
  })
  const batch = await finalizeBatchJob({
    job: {
      type: 'yt_batch_transcribe', source_id: youtubeSourceId, status: 'done',
      items_total: 1, items_done: 1, params: { video_ids: ['catalog-0'] },
      started_at: 200, finished_at: 201,
    },
    coverage: {
      source_id: youtubeSourceId, content_type: 'video', depth: 'transcribed', items_count: 1,
    },
    combine_paths: [transcriptPath],
    combine_output_path: combinedPath,
  })
  assert.ok(batch.dbJobId)
  assert.equal(batch.file_path, combinedPath)
  assert.equal(fs.readFileSync(combinedPath, 'utf8'), 'catalog transcript body')
  assert.equal(
    db.getItemsByExternalIds(youtubeSourceId, ['catalog-0'])[0].transcript_path,
    transcriptPath,
  )
})
