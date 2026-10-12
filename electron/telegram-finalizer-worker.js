const fs = require('node:fs')
const path = require('node:path')
const { parentPort } = require('node:worker_threads')

const db = require('./database')
const { formatCommentsBlock } = require('./assemble')

const DEFAULT_CHUNK_SIZE = 500

function telegramRawMeta(item) {
  const out = {}
  if (Array.isArray(item?.media) && item.media.length) out.media = item.media
  if (item?.forward && typeof item.forward === 'object') out.forward = item.forward
  if (item?.telegram_reply && typeof item.telegram_reply === 'object') out.telegram_reply = item.telegram_reply
  if (Object.prototype.hasOwnProperty.call(item || {}, 'external_reply')) out.external_reply = item.external_reply
  return Object.keys(out).length ? out : null
}

function itemRow(sourceId, item) {
  return {
    source_id: sourceId,
    external_id: String(item.id),
    type: item.type || 'other',
    url: null,
    title: null,
    caption: item.text || null,
    published_at: item.date ? Math.floor(new Date(item.date).getTime() / 1000) : null,
    duration_seconds: item.duration || null,
    views: null,
    likes: null,
    comments: null,
    sender: item.sender || null,
    has_media: !!item.has_media,
    raw_meta: telegramRawMeta(item),
    topic_id: item.topic_id != null ? item.topic_id : null,
    topic_title: item.topic_title || null,
    parent_external_id: item.parent_external_id || null,
    reply_resolved: true,
    reactions: item.reactions === undefined ? null : item.reactions,
    reactions_resolved: item.reactions !== undefined,
  }
}

function singleBody(payload) {
  const item = payload.items[0] || {}
  const chunks = []
  if (item.sender) chunks.push(String(item.sender))
  if (item.text) chunks.push(String(item.text).trim())

  const forwardedBy = item.forward?.source?.name || item.forward?.from_name || null
  const forwardedDate = item.forward?.date || null
  if (item.forward) {
    const details = [forwardedBy, forwardedDate].filter(Boolean).join(' · ')
    chunks.push(`[пересланное сообщение${details ? ` · ${details}` : ''}]`)
  }

  for (const media of (Array.isArray(item.media) ? item.media : [])) {
    const label = media.file_name || media.kind || 'файл'
    const details = [
      media.content_type || null,
      media.bytes != null && Number.isFinite(Number(media.bytes)) ? formatBytes(Number(media.bytes)) : null,
    ].filter(Boolean)
    chunks.push(`[вложение: ${label}${details.length ? ` · ${details.join(' · ')}` : ''}]`)
  }

  const mediaResults = Array.isArray(payload.mediaResults) ? payload.mediaResults : []
  for (const result of mediaResults) {
    const text = String(result?.text || '').trim()
    if (!text) continue
    const headings = {
      voice: 'голосовое — расшифровка',
      photo: 'фото — описание',
      pdf: 'документ — извлечение',
    }
    const heading = headings[result.kind] || 'вложение — содержимое'
    chunks.push(`[${heading}${result.engine ? ` · ${result.engine}` : ''}]\n${text}`)
  }

  const isAudio = item.has_media && (item.type === 'voice' || item.type === 'audio' || item.type === 'video')
  const hasVoiceResult = mediaResults.some(result => result?.kind === 'voice' && String(result?.text || '').trim())
  if (isAudio && !hasVoiceResult) {
    if (payload.tg_voice?.text) {
      const heading = payload.tg_voice.engine
        ? `[голосовое — расшифровка · ${payload.tg_voice.engine}]`
        : '[голосовое — расшифровка]'
      chunks.push(`${heading}\n${String(payload.tg_voice.text).trim()}`)
    } else if (payload.tg_voice?.error) {
      chunks.push(`[голосовое — расшифровка не удалась: ${payload.tg_voice.error}]`)
    } else if (!payload.params?.transcribe_engine) {
      chunks.push('[голосовое сообщение — транскрипция не запрошена]')
    }
  }
  return chunks.filter(Boolean).join('\n\n').trim() + '\n'
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

async function writeJsonSidecarAtomic(filePath, summary, items) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  const handle = await fs.promises.open(tempPath, 'w', 0o600)
  try {
    await handle.write(`{\n  "summary": ${JSON.stringify(summary)},\n  "items": [\n`)
    for (let i = 0; i < items.length; i++) {
      const json = JSON.stringify(items[i], null, 2)
        .split('\n')
        .map(line => `    ${line}`)
        .join('\n')
      await handle.write(`${json}${i + 1 < items.length ? ',' : ''}\n`)
    }
    await handle.write('  ]\n}\n')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.promises.rename(tempPath, filePath)
}

async function persistItems(requestId, payload) {
  const items = Array.isArray(payload.items) ? payload.items : []
  if (!payload.source_id || items.length === 0) return { rows: 0, mediaApplied: 0 }
  const rows = items.map(item => itemRow(payload.source_id, item))
  const chunkSize = Math.max(50, Number(payload.chunkSize) || DEFAULT_CHUNK_SIZE)
  let done = 0
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const started = Date.now()
    db.bulkUpsertItems(chunk)
    done += chunk.length
    parentPort.postMessage({
      type: 'progress', requestId,
      progress: { done, total: rows.length, chunkRows: chunk.length, ms: Date.now() - started },
    })
    await new Promise(resolve => setImmediate(resolve))
  }

  let mediaApplied = 0
  for (const result of (payload.mediaResults || [])) {
    const id = db.appendItemTranscript({
      source_id: payload.source_id,
      external_id: result.msg_id,
      text: result.text,
      engine: result.engine,
      kind: result.kind,
    })
    if (id) mediaApplied += 1
  }
  return { rows: rows.length, mediaApplied }
}

async function persistSidecars(payload) {
  if (payload.isMediaOnly || !payload.filePath) {
    return { file_path: null, file_path_comments: null }
  }
  await fs.promises.mkdir(path.dirname(payload.filePath), { recursive: true })
  if (payload.isSingle) {
    await fs.promises.writeFile(payload.filePath, singleBody(payload), { encoding: 'utf8', mode: 0o600 })
    let commentsPath = null
    if (payload.params?.include_comments && payload.outcomeStatus === 'done') {
      const comments = Array.isArray(payload.commentsBuffer) ? payload.commentsBuffer : []
      commentsPath = payload.commentsFilePath
      const body = comments.length === 0
        ? '--- комментарии (0) ---\n(под этим постом нет комментариев)\n'
        : `--- комментарии (${comments.length}) ---\n${formatCommentsBlock(comments)}\n`
      await fs.promises.writeFile(commentsPath, body, { encoding: 'utf8', mode: 0o600 })
    }
    return { file_path: payload.filePath, file_path_comments: commentsPath }
  }

  await writeJsonSidecarAtomic(payload.filePath, payload.summary, payload.items || [])
  return { file_path: payload.filePath, file_path_comments: null }
}

async function finalize(requestId, payload) {
  const started = Date.now()
  const persisted = await persistItems(requestId, payload)
  const files = await persistSidecars(payload)
  return {
    ...persisted,
    ...files,
    durationMs: Date.now() - started,
  }
}

function catalogItemRow(payload, item) {
  const sourceId = payload.source_id
  if (payload.kind === 'youtube-channel' || payload.kind === 'tiktok-channel') {
    return {
      source_id: sourceId,
      external_id: String(item.video_id),
      type: 'video',
      url: item.url || null,
      title: item.title || null,
      caption: null,
      published_at: item.timestamp || null,
      duration_seconds: item.duration_sec || null,
      views: item.view_count || null,
      likes: null,
      comments: null,
      sender: null,
      has_media: true,
      raw_meta: null,
    }
  }
  if (payload.kind === 'instagram-profile') {
    return {
      source_id: sourceId,
      external_id: String(item.external_id),
      type: item.type || 'other',
      url: item.url || null,
      title: item.title || null,
      caption: item.caption || null,
      published_at: item.date ? Math.floor(new Date(item.date).getTime() / 1000) : null,
      duration_seconds: item.duration_sec || null,
      views: item.views || null,
      likes: item.likes || null,
      comments: item.comments || null,
      sender: null,
      has_media: !!item.has_media,
      raw_meta: null,
    }
  }
  if (payload.kind === 'reddit') {
    return {
      source_id: sourceId,
      external_id: String(item.external_id),
      type: item.type || 'text',
      url: item.url || null,
      title: item.title || null,
      caption: item.caption || null,
      published_at: item.date ? Math.floor(new Date(item.date).getTime() / 1000) : null,
      duration_seconds: null,
      views: null,
      likes: item.likes || null,
      comments: item.comments || null,
      sender: item.sender || null,
      has_media: !!item.has_media,
      raw_meta: item.raw_meta || null,
      parent_external_id: item.parent_external_id || null,
      depth: item.depth != null ? item.depth : null,
    }
  }
  throw new Error(`unknown catalog kind: ${payload.kind || '(missing)'}`)
}

async function finalizeCatalog(requestId, payload) {
  const items = Array.isArray(payload.items) ? payload.items : []
  if (payload.kind === 'boosty-public-catalog') {
    return require('./boosty-catalog-store').savePublicCatalog(db, { ...payload, posts: items })
  }
  if (payload.kind === 'boosty-catalog') {
    if (!payload.entity?.author_handle) throw new Error('Boosty не вернул автора')
    const sourceId = db.upsertBoostyChannel({
      author_id: payload.entity.author_id || null,
      handle: payload.entity.author_handle,
      display_name: payload.entity.title || payload.entity.author_handle,
      avatar_url: payload.entity.avatar_url || null,
      meta: payload.source_meta || {},
      is_explicit: payload.explicit === true,
      mark_synced: payload.mark_synced === true,
    })
    const relativeThumbnails = {}
    for (const [externalId, filePath] of Object.entries(payload.thumbnails || {})) {
      if (!filePath) continue
      const absolute = path.resolve(String(filePath))
      const relative = path.relative(db.LIB_ROOT, absolute)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
      relativeThumbnails[String(externalId)] = relative.split(path.sep).join('/')
    }
    const counts = db.upsertBoostyCatalog({
      source_id: sourceId,
      posts: items,
      thumbnail_paths: relativeThumbnails,
    })
    db.patchSourceMeta(sourceId, payload.source_meta || {}, { mark_synced: payload.mark_synced === true })
    let dbJobId = null
    if (payload.job) dbJobId = db.recordJob({ ...payload.job, source_id: sourceId })
    const thumbnailItems = []
    for (const post of items) {
      if (post?.external_id && post?.thumbnail_url) {
        thumbnailItems.push({ external_id: String(post.external_id), url: post.thumbnail_url })
      }
      for (const video of (post?.videos || [])) {
        if (video?.video_id && video?.thumbnail_url) {
          thumbnailItems.push({ external_id: String(video.video_id), url: video.thumbnail_url })
        }
      }
    }
    let thumbnailManifestPath = null
    if (thumbnailItems.length && payload.thumbnail_manifest_path) {
      await fs.promises.writeFile(
        payload.thumbnail_manifest_path,
        JSON.stringify({ author: payload.entity.author_handle, items: thumbnailItems }),
        { encoding: 'utf8', mode: 0o600 },
      )
      thumbnailManifestPath = payload.thumbnail_manifest_path
    }
    return {
      sourceId,
      counts,
      thumbnailItems: thumbnailManifestPath ? null : thumbnailItems,
      thumbnailCount: thumbnailItems.length,
      thumbnailManifestPath,
      dbJobId,
    }
  }
  const chunkSize = Math.max(50, Number(payload.chunkSize) || DEFAULT_CHUNK_SIZE)
  let done = 0
  for (let index = 0; index < items.length; index += chunkSize) {
    const chunk = items.slice(index, index + chunkSize).map(item => catalogItemRow(payload, item))
    const started = Date.now()
    db.bulkUpsertItems(chunk)
    done += chunk.length
    parentPort.postMessage({
      type: 'progress', requestId,
      progress: { done, total: items.length, chunkRows: chunk.length, ms: Date.now() - started },
    })
    await new Promise(resolve => setImmediate(resolve))
  }

  let dbJobId = null
  const breakdown = payload.type_breakdown && typeof payload.type_breakdown === 'object'
    ? payload.type_breakdown
    : {}
  const isChannel = payload.kind === 'youtube-channel' || payload.kind === 'tiktok-channel'
  if (isChannel && payload.source_id && payload.status === 'done' && done > 0) {
    db.recordCoverage({
      source_id: payload.source_id,
      job_id: null,
      date_from: payload.date_from || null,
      date_to: payload.date_to || null,
      content_type: 'video',
      depth: 'metadata',
      items_count: done,
    })
  } else if (!isChannel && payload.source_id && payload.status === 'done' && Object.keys(breakdown).length) {
    dbJobId = db.recordJob({
      type: payload.job_type,
      source_id: payload.source_id,
      status: payload.status,
      items_total: payload.items_done || done,
      items_done: payload.items_done || done,
      cost_usd: payload.cost_usd || 0,
      params: payload.params || null,
      error: payload.error || null,
      started_at: payload.started_at || null,
      finished_at: payload.finished_at || null,
    })
    for (const [contentType, count] of Object.entries(breakdown)) {
      db.recordCoverage({
        source_id: payload.source_id,
        job_id: dbJobId,
        date_from: payload.date_from || null,
        date_to: payload.date_to || null,
        content_type: contentType,
        depth: 'metadata',
        items_count: Number(count || 0),
      })
    }
  }
  return { rows: done, dbJobId }
}

async function finalizeBatch(payload) {
  let filePath = payload.file_path || null
  const paths = Array.isArray(payload.combine_paths) ? payload.combine_paths.filter(Boolean) : []
  if (paths.length && payload.combine_output_path) {
    const chunks = []
    for (const transcriptPath of paths) {
      try { chunks.push(await fs.promises.readFile(transcriptPath, 'utf8')) } catch {}
    }
    if (chunks.length) {
      const separator = payload.combine_separator || `\n\n${'='.repeat(72)}\n\n`
      await fs.promises.writeFile(payload.combine_output_path, chunks.join(separator), 'utf8')
      filePath = payload.combine_output_path
    }
  }
  const row = { ...(payload.job || {}), file_path: filePath }
  const dbJobId = db.recordJob(row)
  if (payload.coverage?.source_id && Number(payload.coverage.items_count || 0) > 0) {
    db.recordCoverage({
      source_id: payload.coverage.source_id,
      job_id: payload.coverage.job_id || null,
      date_from: payload.coverage.date_from || null,
      date_to: payload.coverage.date_to || null,
      content_type: payload.coverage.content_type || 'video',
      depth: payload.coverage.depth || 'transcribed',
      items_count: Number(payload.coverage.items_count || 0),
    })
  }
  return { dbJobId, file_path: filePath }
}

function syncFolder(payload) {
  const chats = Array.isArray(payload.chats) ? payload.chats : []
  const session = typeof payload.tg_session === 'string' && payload.tg_session.trim()
    ? payload.tg_session.trim()
    : null
  const transaction = db.getDb().transaction(() => {
    const sourceIds = []
    const sources = []
    const errors = []
    let clearedHealth = 0
    for (const chat of chats) {
      try {
        const sourceId = db.upsertSource({
          platform: 'telegram',
          handle: chat.handle,
          display_name: chat.title || null,
          external_id: chat.tg_id != null ? String(chat.tg_id) : null,
          avatar_url: chat.avatar_path || null,
          meta: {
            kind: chat.kind,
            username: chat.username || null,
            via_folder_id: payload.filter_id,
          },
          is_explicit: false,
          tg_session: session,
        })
        try {
          const health = db.clearTelegramSourceHealth(sourceId)
          if (health?.changed) clearedHealth += 1
        } catch {}
        sourceIds.push(sourceId)
        sources.push({ id: sourceId, handle: chat.handle })
      } catch (error) {
        errors.push({
          handle: chat?.handle || null,
          error: error?.message || String(error),
        })
      }
    }
    const folderId = db.upsertFolder({
      tg_filter_id: payload.filter_id,
      title: payload.title,
      tg_session: session,
    })
    db.setFolderSources(folderId, sourceIds)
    return { folderId, sourceIds, sources, clearedHealth, errors }
  })
  return transaction()
}

function pruneFolders(payload) {
  const session = typeof payload.tg_session === 'string' && payload.tg_session.trim()
    ? payload.tg_session.trim()
    : null
  if (!session) return { removed: 0, folderIds: [] }
  const seen = new Set((payload.seen_filter_ids || []).map(Number))
  const removedIds = []
  const transaction = db.getDb().transaction(() => {
    for (const folder of db.listFolders()) {
      if (folder.tg_session !== session) continue
      if (folder.tg_filter_id == null || seen.has(Number(folder.tg_filter_id))) continue
      db.deleteFolder(folder.id)
      removedIds.push(folder.id)
    }
  })
  transaction()
  return { removed: removedIds.length, folderIds: removedIds }
}

let finalizerQueue = Promise.resolve()
let operationQueue = Promise.resolve()
let catalogQueue = Promise.resolve()
const assembling = new Map()
const catalogAssembling = new Map()

function enqueueFinalize(requestId, payload) {
  finalizerQueue = finalizerQueue.then(async () => {
    try {
      const result = await finalize(requestId, payload || {})
      parentPort.postMessage({ type: 'result', requestId, result })
    } catch (error) {
      parentPort.postMessage({
        type: 'error', requestId,
        error: error?.stack || error?.message || String(error),
      })
    }
  })
}

function enqueueOperation(requestId, operation) {
  // Small folder/auto/reply mutations must not sit behind a 100k-item JSON
  // sidecar write. This independent chain runs on the same worker thread and
  // therefore cannot overlap synchronous SQLite calls, but it can interleave
  // while finalization yields between chunks or awaits filesystem I/O.
  operationQueue = operationQueue.then(async () => {
    try {
      const result = await operation()
      parentPort.postMessage({ type: 'result', requestId, result })
    } catch (error) {
      parentPort.postMessage({
        type: 'error', requestId,
        error: error?.stack || error?.message || String(error),
      })
    }
  })
}

function enqueueCatalog(requestId, payload) {
  catalogQueue = catalogQueue.then(async () => {
    try {
      const result = await finalizeCatalog(requestId, payload || {})
      parentPort.postMessage({ type: 'result', requestId, result })
    } catch (error) {
      parentPort.postMessage({
        type: 'error', requestId,
        error: error?.stack || error?.message || String(error),
      })
    }
  })
}

parentPort.on('message', message => {
  if (message?.type === 'catalog-start') {
    catalogAssembling.set(message.requestId, { ...(message.payload || {}), items: [] })
    return
  }
  if (message?.type === 'catalog-chunk') {
    const payload = catalogAssembling.get(message.requestId)
    if (payload && Array.isArray(message.rows) && message.rows.length) payload.items.push(...message.rows)
    return
  }
  if (message?.type === 'catalog-commit') {
    const payload = catalogAssembling.get(message.requestId)
    catalogAssembling.delete(message.requestId)
    if (!payload) {
      parentPort.postMessage({ type: 'error', requestId: message.requestId, error: 'catalog payload was not started' })
      return
    }
    enqueueCatalog(message.requestId, payload)
    return
  }
  if (message?.type === 'sync-folder') {
    enqueueOperation(message.requestId, () => syncFolder(message.payload || {}))
    return
  }
  if (message?.type === 'prune-folders') {
    enqueueOperation(message.requestId, () => pruneFolders(message.payload || {}))
    return
  }
  if (message?.type === 'set-telegram-auto') {
    enqueueOperation(message.requestId, () => db.setTelegramAutoForSources(
      message.payload?.source_ids || [],
      message.payload?.patch || {},
    ))
    return
  }
  if (message?.type === 'apply-reply-updates') {
    enqueueOperation(message.requestId, () => ({
      updated: db.bulkUpdateParentExternalId(
        message.payload?.source_id,
        message.payload?.rows || [],
      ),
    }))
    return
  }
  if (message?.type === 'item-mutation') {
    const method = message.payload?.method
    const allowed = {
      markItemTranscribed: db.markItemTranscribed,
      markItemDownloaded: db.markItemDownloaded,
      markItemVideoDownloaded: db.markItemVideoDownloaded,
      markItemDownloadError: db.markItemDownloadError,
      markItemTranscribeError: db.markItemTranscribeError,
    }
    const mutate = allowed[method]
    if (!mutate) {
      parentPort.postMessage({ type: 'error', requestId: message.requestId, error: `unsupported item mutation: ${method}` })
      return
    }
    enqueueOperation(message.requestId, () => ({ result: mutate(message.payload?.args || {}) }))
    return
  }
  if (message?.type === 'finalize-batch-job') {
    enqueueOperation(message.requestId, () => finalizeBatch(message.payload || {}))
    return
  }
  if (message?.type === 'finalize') {
    enqueueFinalize(message.requestId, message.payload || {})
    return
  }
  if (message?.type === 'finalize-start') {
    assembling.set(message.requestId, {
      ...(message.payload || {}),
      items: [],
      mediaResults: [],
      commentsBuffer: [],
    })
    return
  }
  if (message?.type === 'finalize-chunk') {
    const payload = assembling.get(message.requestId)
    if (!payload || !['items', 'mediaResults', 'commentsBuffer'].includes(message.field)) return
    if (Array.isArray(message.rows) && message.rows.length) {
      payload[message.field].push(...message.rows)
    }
    return
  }
  if (message?.type === 'finalize-commit') {
    const payload = assembling.get(message.requestId)
    assembling.delete(message.requestId)
    if (!payload) {
      parentPort.postMessage({
        type: 'error', requestId: message.requestId,
        error: 'telegram finalizer payload was not started',
      })
      return
    }
    enqueueFinalize(message.requestId, payload)
  }
})
