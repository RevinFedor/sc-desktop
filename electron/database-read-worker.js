const fs = require('node:fs')
const path = require('node:path')
const { parentPort } = require('node:worker_threads')

const db = require('./database')
const { assembleText } = require('./assemble')

function sourceDetail(id) {
  const source = db.getSource(id)
  return {
    source,
    typeBreakdown: db.itemTypeBreakdown(id),
    telegramAnalysis: source?.platform === 'telegram'
      ? db.latestTelegramAnalysisForSource(id)
      : null,
    senders: db.senderBreakdown(id),
    coverage: db.listCoverage(id),
    dateRange: db.itemsDateRange(id),
    jobs: source?.platform === 'boosty'
      ? db.listJobsForSource(id).filter(job => job.type !== 'yt_channel_fetch' && job.type !== 'tk_channel_fetch')
      : [],
    commentsCount: db.countCommentsBySource(id),
    postsWithComments: db.listPostsWithComments(id).length,
  }
}

function assemblyEstimate(scope) {
  const base = db.assemblyEstimate(scope)
  let transcriptBytes = 0
  for (const row of db.assemblyTranscriptPaths(scope)) {
    try {
      if (row.transcript_path) transcriptBytes += fs.statSync(row.transcript_path).size
    } catch {}
  }
  const bytes = (base.caption_bytes || 0) + transcriptBytes + base.count * 50
  return { ...base, bytes, tokens: Math.round(bytes / 3) }
}

function telegramRunContexts(sourceIds, includeMaxId = false) {
  const ids = Array.isArray(sourceIds)
    ? sourceIds.map(Number).filter(Number.isFinite)
    : []
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  const maxExpr = includeMaxId
    ? `(SELECT MAX(CAST(i.external_id AS INTEGER)) FROM items i WHERE i.source_id = s.id)`
    : 'NULL'
  return db.getDb().prepare(`
    SELECT s.id, s.platform, s.handle, s.display_name, s.external_id,
           s.tg_session, s.tg_session_conflict,
           ${maxExpr} AS max_external_id
      FROM sources s
     WHERE s.id IN (${placeholders})
  `).all(...ids)
}

function sumExistingFiles(paths) {
  let bytes = 0
  let present = 0
  const unique = [...new Set(paths || [])]
  for (const value of unique) {
    const absolute = path.isAbsolute(String(value || ''))
      ? value
      : path.join(db.LIB_ROOT, String(value || ''))
    try { bytes += fs.statSync(absolute).size; present += 1 } catch {}
  }
  return { bytes, present, total: unique.length }
}

function socialOverview(sourceId) {
  const overview = db.socialSourceOverview(sourceId)
  if (!overview) return { ok: false, error: 'unsupported source' }
  const storage = db.storageBreakdownForSource(sourceId)
  const media = sumExistingFiles(storage.media_paths)
  const transcripts = sumExistingFiles(storage.transcript_paths)
  const dbPayloadBytes = Number(overview.bytes?.db_payload || 0)
  return {
    ok: true,
    ...overview,
    storage: {
      root: db.LIB_ROOT,
      db_payload: { bytes: dbPayloadBytes },
      media,
      transcripts,
      index: { bytes: storage.index_bytes || 0, vectors: storage.index_vectors || 0 },
      total_bytes: dbPayloadBytes + media.bytes + transcripts.bytes + (storage.index_bytes || 0),
    },
  }
}

function sourceStorage(sourceId) {
  const breakdown = db.storageBreakdownForSource(sourceId)
  const source = db.getSource(sourceId)
  const media = sumExistingFiles(breakdown.media_paths)
  const videos = sumExistingFiles(breakdown.video_paths)
  const transcripts = sumExistingFiles(breakdown.transcript_paths)
  const thumbnails = sumExistingFiles(breakdown.thumbnail_paths)
  return {
    ok: true,
    platform: source?.platform || null,
    root: db.LIB_ROOT,
    text: { bytes: breakdown.text_bytes },
    index: { bytes: breakdown.index_bytes, vectors: breakdown.index_vectors },
    media,
    videos,
    transcripts,
    thumbnails,
    total_bytes: breakdown.text_bytes + breakdown.index_bytes + media.bytes
      + videos.bytes + transcripts.bytes + thumbnails.bytes,
  }
}

function parseJsonObject(value) {
  try {
    const parsed = value ? JSON.parse(value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function allowedFileInfo(filePath, roots) {
  if (!filePath || typeof filePath !== 'string') return { present: false, bytes: 0, path: null }
  const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(db.LIB_ROOT, filePath)
  const allowed = (roots || [db.LIB_ROOT]).some(rawRoot => {
    if (!rawRoot) return false
    const root = path.resolve(rawRoot)
    const relative = path.relative(root, absolute)
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
  if (!allowed) return { present: false, bytes: 0, path: null }
  try {
    const stat = fs.statSync(absolute)
    return { present: stat.isFile(), bytes: stat.isFile() ? stat.size : 0, path: absolute }
  } catch {
    return { present: false, bytes: 0, path: absolute }
  }
}

function publicBoostyRow(row, storage = {}) {
  const media = allowedFileInfo(row.media_path, [db.LIB_ROOT, storage.audio_dir])
  const video = allowedFileInfo(row.video_path, [db.LIB_ROOT, storage.video_dir])
  const transcript = allowedFileInfo(row.transcript_path, [db.LIB_ROOT])
  const srt = allowedFileInfo(row.transcript_path ? String(row.transcript_path).replace(/\.txt$/i, '.srt') : null, [db.LIB_ROOT])
  const thumbnail = allowedFileInfo(row.thumbnail_path, [db.LIB_ROOT])
  return {
    id: row.id,
    source_id: row.source_id,
    external_id: String(row.external_id),
    type: row.type,
    url: row.url,
    title: row.title,
    caption: row.caption,
    published_at: row.published_at,
    duration_seconds: row.duration_seconds,
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    parent_external_id: row.parent_external_id,
    depth: row.depth,
    thumbnail_path: row.thumbnail_path,
    thumbnail_present: thumbnail.present,
    media_path: media.present ? media.path : null,
    media_present: media.present,
    media_bytes: media.bytes,
    video_path: video.present ? video.path : null,
    video_present: video.present,
    video_bytes: video.bytes,
    transcript_path: transcript.present ? transcript.path : null,
    transcript_present: transcript.present,
    transcript_bytes: transcript.bytes,
    srt_path: srt.present ? srt.path : null,
    srt_present: srt.present,
    download_status: media.present ? 'done' : (row.media_path ? 'missing' : row.download_status),
    download_error: row.download_error,
    transcribe_status: transcript.present ? 'done' : (row.transcript_path ? 'missing' : row.transcribe_status),
    transcribe_error: row.transcribe_error,
    transcribe_engine: row.transcribe_engine,
    meta: parseJsonObject(row.raw_meta_json),
  }
}

function boostyPosts(sourceId, storage) {
  const source = db.getSource(sourceId)
  if (!source || source.platform !== 'boosty') return { ok: false, error: 'Источник Boosty не найден' }
  const publicRows = db.listBoostyItems(sourceId).map(row => publicBoostyRow(row, storage))
  const parents = publicRows.filter(row => row.type === 'boosty_post')
  const childrenByParent = new Map()
  for (const row of publicRows) {
    if (row.type !== 'boosty_video' || !row.parent_external_id) continue
    const key = String(row.parent_external_id)
    if (!childrenByParent.has(key)) childrenByParent.set(key, [])
    childrenByParent.get(key).push(row)
  }
  const posts = parents.map(parent => {
    const videos = (childrenByParent.get(parent.external_id) || []).sort(
      (a, b) => Number(a.meta.position || 0) - Number(b.meta.position || 0)
    )
    return {
      ...parent,
      videos,
      video_count: Math.max(Number(parent.meta.video_count || 0), videos.length),
      known_videos_count: videos.length,
      duration_seconds: videos.reduce((sum, video) => sum + Number(video.duration_seconds || 0), 0),
      media_bytes: videos.reduce((sum, video) => sum + Number(video.media_bytes || 0), 0),
      video_bytes: videos.reduce((sum, video) => sum + Number(video.video_bytes || 0), 0),
      media_present_count: videos.filter(video => video.media_present).length,
      video_present_count: videos.filter(video => video.video_present).length,
      transcribed_count: videos.filter(video => video.transcript_present).length,
    }
  })
  const videos = publicRows.filter(row => row.type === 'boosty_video')
  return {
    ok: true,
    source,
    meta: parseJsonObject(source.meta_json),
    posts,
    stats: {
      posts: posts.length,
      videos: videos.length,
      transcribed: videos.filter(video => video.transcript_present).length,
      audio_files: videos.filter(video => video.media_present).length,
      audio_bytes: videos.reduce((sum, video) => sum + Number(video.media_bytes || 0), 0),
      video_files: videos.filter(video => video.video_present).length,
      video_bytes: videos.reduce((sum, video) => sum + Number(video.video_bytes || 0), 0),
      locked_posts: posts.filter(post => post.meta.access_state === 'locked').length,
      lost_posts: posts.filter(post => post.meta.access_state === 'lost').length,
    },
  }
}

function boostyPlatformStorage() {
  const sources = db.getDb().prepare(`SELECT id FROM sources WHERE platform='boosty' ORDER BY id`).all()
  const mediaPaths = []
  const transcriptPaths = []
  const videoPaths = []
  const thumbnailPaths = []
  const perSource = {}
  let textBytes = 0
  let indexBytes = 0
  let indexVectors = 0
  for (const source of sources) {
    const breakdown = db.storageBreakdownForSource(source.id)
    const audio = sumExistingFiles(breakdown.media_paths)
    const videos = sumExistingFiles(breakdown.video_paths)
    perSource[String(source.id)] = {
      audio_bytes: audio.bytes, audio_files: audio.present, audio_known: audio.total,
      video_bytes: videos.bytes, video_files: videos.present, video_known: videos.total,
    }
    mediaPaths.push(...breakdown.media_paths)
    videoPaths.push(...breakdown.video_paths)
    transcriptPaths.push(...breakdown.transcript_paths)
    thumbnailPaths.push(...breakdown.thumbnail_paths)
    textBytes += Number(breakdown.text_bytes || 0)
    indexBytes += Number(breakdown.index_bytes || 0)
    indexVectors += Number(breakdown.index_vectors || 0)
  }
  const audio = sumExistingFiles(mediaPaths)
  const videos = sumExistingFiles(videoPaths)
  const transcripts = sumExistingFiles(transcriptPaths)
  const thumbnails = sumExistingFiles(thumbnailPaths)
  return {
    ok: true,
    sources: sources.length,
    audio, videos, transcripts, thumbnails,
    text: { bytes: textBytes },
    index: { bytes: indexBytes, vectors: indexVectors },
    per_source: perSource,
    total_bytes: audio.bytes + videos.bytes + transcripts.bytes + thumbnails.bytes + textBytes + indexBytes,
  }
}

function boostyBatchPlan(sourceId, videoIds, mode, saveVideo, storage = {}) {
  const source = db.getSource(sourceId)
  if (!source || source.platform !== 'boosty') throw new Error('Источник Boosty не найден')
  const requested = Array.isArray(videoIds) ? videoIds.map(String) : []
  const rows = db.listBoostyVideos(sourceId, requested)
  const byId = new Map(rows.map(row => [String(row.external_id), row]))
  const ordered = []
  const seen = new Set()
  for (const id of requested) {
    const row = byId.get(id)
    if (!row || seen.has(id)) continue
    seen.add(id)
    ordered.push(row)
  }
  if (!ordered.length) throw new Error('Выбранные видео Boosty не найдены в библиотеке')

  const cachedLogs = []
  const selection = []
  for (const row of ordered) {
    const transcript = allowedFileInfo(row.transcript_path, [db.LIB_ROOT])
    const audio = allowedFileInfo(row.media_path, [db.LIB_ROOT, storage.audio_dir])
    const video = allowedFileInfo(row.video_path, [db.LIB_ROOT, storage.video_dir])
    const srt = allowedFileInfo(row.transcript_path ? String(row.transcript_path).replace(/\.txt$/i, '.srt') : null, [db.LIB_ROOT])
    const ready = mode === 'download'
      ? audio.present && (!saveVideo || video.present)
      : transcript.present
    let meta = {}
    try { meta = row.raw_meta_json ? JSON.parse(row.raw_meta_json) : {} } catch {}
    if (ready) {
      cachedLogs.push({
        video_id: String(row.external_id),
        title: row.title || null,
        kind: 'cache',
        file_path: mode === 'download' ? null : transcript.path,
        srt_path: srt.present ? srt.path : null,
        audio_path: audio.present ? audio.path : null,
        audio_bytes: audio.bytes,
        video_path: video.present ? video.path : null,
        video_bytes: video.bytes,
      })
      continue
    }
    selection.push({
      url: row.url,
      video_id: String(row.external_id),
      position: meta.position || null,
      title: row.title || null,
      duration_sec: row.duration_seconds || null,
      author: source.display_name || source.handle,
      audio_path: audio.present ? audio.path : null,
      video_path: video.present ? video.path : null,
    })
  }
  return { source, total: ordered.length, cachedLogs, selection }
}

function semanticIndexStatus(sourceId) {
  const id = Number(sourceId)
  const handle = db.getDb()
  const total = handle.prepare('SELECT COUNT(*) AS n FROM items WHERE source_id = ?').get(id)?.n || 0
  const indexed = db.vectorCountForSource(id)
  return { state: 'idle', done: indexed, total }
}

function activityHistoryRows() {
  const handle = db.getDb()
  return {
    youtube: handle.prepare(
      `SELECT * FROM jobs WHERE type = 'yt_transcribe' ORDER BY started_at DESC LIMIT 150`
    ).all(),
    local: db.listSourcelessJobs({ type: 'local_transcribe', limit: 150 }),
    rutube: db.listSourcelessJobs({ type: 'rutube_transcribe', limit: 150 }),
    boosty: db.listSourcelessJobs({ type: 'boosty_transcribe', limit: 150 }),
    telegramSingle: db.listSourcelessJobs({ type: 'tg_fetch', limit: 150 }),
    youtubeBatch: db.listSourcelessJobs({ type: 'yt_batch_transcribe', limit: 150 }),
    instagramBatch: db.listSourcelessJobs({ type: 'ig_batch_transcribe', limit: 150 }),
    youtubeComments: handle.prepare(
      `SELECT * FROM jobs WHERE type = 'yt_comments' ORDER BY started_at DESC LIMIT 150`
    ).all(),
    youtubeBatchComments: db.listSourcelessJobs({ type: 'yt_batch_comments', limit: 150 }),
  }
}

function buildAssemblyCommentsMap(scope, rows) {
  if (!scope?.with_comments || !Array.isArray(rows) || rows.length === 0) return null
  const idsBySource = new Map()
  for (const row of rows) {
    if (row?.source_id == null || row?.external_id == null) continue
    if (!idsBySource.has(row.source_id)) idsBySource.set(row.source_id, [])
    idsBySource.get(row.source_id).push(String(row.external_id))
  }
  const result = new Map()
  for (const [sourceId, ids] of idsBySource) {
    for (let index = 0; index < ids.length; index += 500) {
      for (const comment of db.listCommentsForPosts(sourceId, ids.slice(index, index + 500))) {
        const key = `${sourceId}:${String(comment.post_external_id)}`
        if (!result.has(key)) result.set(key, [])
        result.get(key).push(comment)
      }
    }
  }
  return result
}

function buildAssemblyChatLabels(scope, rows) {
  const sourceIds = [...new Set((rows || []).map(row => Number(row.source_id)).filter(Number.isFinite))]
  if (sourceIds.length < 2 && (!Array.isArray(scope?.source_ids) || scope.source_ids.length < 2)) return null
  const result = new Map()
  for (const sourceId of sourceIds) {
    const source = db.getSource(sourceId)
    if (!source) continue
    result.set(source.id, {
      handle: source.handle,
      title: source.display_name && source.display_name !== source.handle
        ? source.display_name
        : null,
    })
  }
  return result
}

function buildAssembly(scope) {
  const rows = db.assemblyFetch(scope || {})
  const text = assembleText(rows, {
    showTopicHeaders: scope?.topic_id == null,
    commentsByPostId: buildAssemblyCommentsMap(scope, rows),
    chatLabelBySourceId: buildAssemblyChatLabels(scope, rows),
  })
  const bytes = Buffer.byteLength(text || '', 'utf8')
  return { text, count: rows.length, bytes, tokens: Math.round(bytes / 3) }
}

function assemblyText(scope) {
  return buildAssembly(scope)
}

async function assemblySave(scope, filePath) {
  const result = buildAssembly(scope)
  if (!result.text) return { ...result, ok: false, error: 'empty' }
  await fs.promises.writeFile(filePath, result.text, 'utf8')
  return { ok: true, path: filePath, count: result.count, bytes: result.bytes, tokens: result.tokens }
}

function copyManyText(sourceId, externalIds) {
  const ids = Array.isArray(externalIds) ? externalIds.map(String) : []
  const rows = []
  for (let index = 0; index < ids.length; index += 500) {
    rows.push(...db.getItemsByExternalIds(sourceId, ids.slice(index, index + 500)))
  }
  rows.sort((a, b) => (a.published_at || 0) - (b.published_at || 0))
  const parts = rows.map(row => String(row.caption || '').trim()).filter(Boolean)
  const text = parts.length ? `${parts.join('\n\n')}\n` : ''
  return {
    text,
    count: parts.length,
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

function youtubeItemsState(sourceId, videoIds) {
  return db.getItemsByExternalIds(sourceId, videoIds || []).map(row => ({
    external_id: row.external_id,
    transcript_path: row.transcript_path,
    duration_seconds: row.duration_seconds,
    title: row.title,
  }))
}

function youtubeItemsStateGlobal(videoIds) {
  const result = []
  for (const [videoId, hit] of db.findYoutubeTranscriptsByVideoIds(videoIds || [])) {
    result.push({
      external_id: videoId,
      transcript_path: hit.file_path,
      origin: hit.origin,
      source_id: hit.source_id,
      source_handle: hit.source_handle || null,
    })
  }
  return result
}

function youtubeBatchCachePlan(videoIds) {
  const ids = Array.isArray(videoIds) ? videoIds.map(String) : []
  const hits = db.findYoutubeTranscriptsByVideoIds(ids)
  const cachedFiles = {}
  for (const [videoId, hit] of hits) {
    if (!hit?.file_path) continue
    try {
      if (fs.statSync(hit.file_path).isFile()) cachedFiles[String(videoId)] = hit.file_path
    } catch {}
  }
  const cachedIds = Object.keys(cachedFiles)
  const cached = new Set(cachedIds)
  return {
    cachedIds,
    cachedFiles,
    runIds: ids.filter(id => !cached.has(id)),
  }
}

function youtubeResumeRemaining(videoIds, videoFiles, transcriptsDir) {
  const ids = Array.isArray(videoIds) ? videoIds.map(String) : []
  const files = videoFiles && typeof videoFiles === 'object' ? videoFiles : {}
  let names = []
  try { names = fs.readdirSync(transcriptsDir, { withFileTypes: true }) } catch {}
  const cachedIds = new Set(names
    .filter(entry => entry.isFile() && entry.name.endsWith('.txt'))
    .map(entry => entry.name.split('__', 1)[0]))
  return ids.filter(videoId => {
    const explicit = files[videoId]
    if (explicit) {
      try { if (fs.statSync(explicit).isFile()) return false } catch {}
    }
    return !cachedIds.has(videoId)
  })
}

function youtubeItemsCommentsState(videoIds) {
  const result = []
  for (const [videoId, hit] of db.findYoutubeCommentsByVideoIds(videoIds || [])) {
    result.push({
      external_id: videoId,
      file_path: hit.file_path,
      finished_at: hit.finished_at,
      sort: hit.sort,
      limit: hit.limit,
      include_replies: !!hit.include_replies,
      count_total: hit.count_total,
    })
  }
  return result
}

async function readTextFiles(paths, { trim = false, separator = '\n\n' } = {}) {
  const parts = []
  for (const filePath of (paths || [])) {
    if (!filePath) continue
    try {
      const body = await fs.promises.readFile(filePath, 'utf8')
      parts.push(trim ? body.trim() : body)
    } catch {}
  }
  const text = parts.length ? `${parts.join(separator)}${trim ? '\n' : ''}` : ''
  return { text, parts: parts.length, bytes: Buffer.byteLength(text, 'utf8') }
}

async function boostyCopyText(sourceId, videoIds) {
  const paths = db.listBoostyVideos(sourceId, videoIds || [])
    .map(row => row.transcript_path)
    .filter(Boolean)
  const separator = `\n\n${'='.repeat(72)}\n\n`
  return readTextFiles(paths, { trim: false, separator })
}

async function youtubeBatchAssembly(payload = {}) {
  const sourceId = Number(payload.sourceId) || null
  const videoIds = Array.isArray(payload.videoIds) ? payload.videoIds.map(String) : []
  const params = payload.params && typeof payload.params === 'object' ? payload.params : {}
  const entries = []
  if (sourceId && videoIds.length) {
    const byId = new Map(db.getItemsByExternalIds(sourceId, videoIds).map(item => [String(item.external_id), item]))
    for (const videoId of videoIds) {
      const item = byId.get(videoId)
      if (item?.transcript_path) {
        entries.push({ video_id: videoId, transcript_path: item.transcript_path })
      }
    }
  }
  if (entries.length === 0) {
    const files = params.video_files || {}
    const ids = Array.isArray(params.video_ids) ? params.video_ids.map(String) : []
    for (const videoId of ids) {
      if (files[videoId]) entries.push({ video_id: videoId, transcript_path: files[videoId] })
    }
  }
  if (entries.length === 0 && Array.isArray(payload.liveLog)) {
    for (const row of payload.liveLog) {
      if (row?.file_path) entries.push({ video_id: row.video_id, transcript_path: row.file_path })
    }
  }
  if (!entries.length) return { ok: false, error: 'no transcripts found' }

  const separator = `\n\n${'='.repeat(72)}\n\n`
  if (payload.action === 'estimate') {
    let bytes = 0
    let present = 0
    for (const entry of entries) {
      try { bytes += (await fs.promises.stat(entry.transcript_path)).size; present += 1 } catch {}
    }
    if (!present) return { ok: false, error: 'no transcripts found' }
    if (present > 1) bytes += Buffer.byteLength(separator, 'utf8') * (present - 1)
    return { ok: true, bytes, tokens: Math.round(bytes / 3), count: present }
  }

  const read = await readTextFiles(entries.map(entry => entry.transcript_path), { separator })
  if (!read.parts) return { ok: false, error: 'no transcripts found' }
  const result = {
    ok: true,
    bytes: read.bytes,
    tokens: Math.round(read.bytes / 3),
    count: read.parts,
  }
  if (payload.action === 'save') {
    await fs.promises.writeFile(payload.outputPath, read.text, 'utf8')
    return { ...result, file_path: payload.outputPath }
  }
  return { ...result, content: read.text }
}

async function selectedTranscriptsAssembly(payload = {}) {
  const sourceId = Number(payload.sourceId)
  const externalIds = Array.isArray(payload.externalIds) ? payload.externalIds.map(String) : []
  if (!sourceId || !externalIds.length) return { ok: false, error: 'no transcripts found' }
  const byId = new Map(db.getItemsByExternalIds(sourceId, externalIds).map(item => [String(item.external_id), item]))
  const paths = externalIds.map(id => byId.get(id)?.transcript_path).filter(Boolean)
  const separator = `\n\n${'='.repeat(72)}\n\n`
  const read = await readTextFiles(paths, { separator })
  if (!read.parts) return { ok: false, error: 'no transcripts found' }
  const result = { ok: true, bytes: read.bytes, count: read.parts }
  if (payload.action === 'save') {
    await fs.promises.writeFile(payload.outputPath, read.text, 'utf8')
    return { ...result, file_path: payload.outputPath }
  }
  return { ...result, content: read.text }
}

const methods = {
  listSources: platform => db.listSources(platform || null),
  getSource: id => db.getSource(id),
  findTelegramSourceByTarget: target => db.findTelegramSourceByTarget(target),
  sourceDetail,
  listFolders: session => db.listFolders(session || null),
  getFolder: id => db.getFolder(Number(id)),
  listFolderSources: id => db.listFolderSources(Number(id)),
  listJobsForSource: (id, limit) => db.listJobsForSource(id, limit),
  listJobsForSourcePage: (id, options) => db.listJobsForSourcePage(id, options || {}),
  listItems: params => db.listItems(params),
  listItemsPage: params => db.listItemsPage(params),
  searchItems: (sourceId, query, limit) => db.searchItems(sourceId || null, query, limit || 50),
  listSourceTopics: sourceId => db.listSourceTopics(sourceId),
  itemTypeBreakdown: (sourceId, topicId) => db.itemTypeBreakdown(sourceId, topicId ?? null),
  telegramMediaEstimate: scope => db.telegramMediaEstimate(scope || {}),
  assemblyEstimate,
  countCommentsBySource: sourceId => db.countCommentsBySource(Number(sourceId)),
  listPostsWithComments: sourceId => db.listPostsWithComments(Number(sourceId)),
  maxExternalId: sourceId => db.maxExternalId(Number(sourceId)),
  telegramRunContexts,
  listItemsMissingParent: (sourceId, limit) => db.listItemsMissingParent(sourceId, limit),
  semanticIndexStatus,
  activityHistoryRows,
  assemblyText,
  assemblySave,
  copyManyText,
  youtubeItemsState,
  youtubeItemsStateGlobal,
  youtubeBatchCachePlan,
  youtubeResumeRemaining,
  youtubeItemsCommentsState,
  readTextFiles,
  boostyCopyText,
  boostyPosts,
  boostyPlatformStorage,
  boostyBatchPlan,
  youtubeBatchAssembly,
  selectedTranscriptsAssembly,
  hybridSearch: params => db.hybridSearch(params || {}),
  sourceStorage,
  socialOverview,
}

parentPort.on('message', async message => {
  const fn = methods[message?.method]
  if (!fn) {
    parentPort.postMessage({ id: message?.id, ok: false, error: `unknown DB read method: ${message?.method}` })
    return
  }
  try {
    const value = await fn(...(message.args || []))
    parentPort.postMessage({ id: message.id, ok: true, value })
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: error?.stack || error?.message || String(error),
    })
  }
})
