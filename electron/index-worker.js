'use strict'

const util = require('node:util')
const fs = require('node:fs')
const { parentPort, workerData } = require('node:worker_threads')
const { chunkTranscript } = require('./youtube-semantic')
const {
  INDEX_VERSION,
  prepareTelegramIndex,
  telegramIndexPage,
  publishReadyTelegramGenerations,
  saveTelegramIndexBatch,
  telegramFragmentIndexStatus,
} = require('./telegram-rag-index')

const {
  BATCH_SIZE,
  RPM_TARGET,
  errorMessage,
  rpmWindowState,
} = require('./index-worker-protocol')

if (!parentPort) throw new Error('index-worker must run inside worker_threads')

function post(message) {
  try { parentPort.postMessage(message) } catch {}
}

// Worker globals do not inherit the main process console interceptor. Forward
// every database/embedder/index log to main so the existing [Tag] logger still
// captures production failures.
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    const formatted = util.format(...args)
    post({ type: 'log', level, message: /^\[[^\]]+\]/.test(formatted) ? formatted : `[IndexWorker] ${formatted}` })
  }
}

const db = require('./database')
const realEmbedBatch = require('./embedder').embedBatch
const embedBatch = process.env.SC_INDEX_WORKER_FIXTURE === '1'
  ? async texts => {
      const delay = Math.max(0, Number(process.env.SC_INDEX_WORKER_FIXTURE_DELAY_MS) || 0)
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      return texts.map((_, index) => {
      const vector = new Float32Array(768)
      vector[index % vector.length] = 1
      return vector
      })
    }
  : realEmbedBatch

const cancelView = workerData?.cancelBuffer instanceof SharedArrayBuffer
  ? new Int32Array(workerData.cancelBuffer)
  : null
let cancelRequested = false
let resolveCancellation
const cancellation = new Promise(resolve => { resolveCancellation = resolve })

function signalCancellation() {
  if (cancelRequested) return
  cancelRequested = true
  resolveCancellation()
}

parentPort.on('message', message => {
  if (message?.type === 'cancel') signalCancellation()
})

function isCancelled() {
  return cancelRequested || (cancelView ? Atomics.load(cancelView, 0) === 1 : false)
}

function cancelledError() {
  const error = new Error('cancelled')
  error.code = 'INDEX_CANCELLED'
  return error
}

function throwIfCancelled() {
  if (isCancelled()) throw cancelledError()
}

async function waitForOrCancel(promise) {
  throwIfCancelled()
  return Promise.race([
    promise,
    cancellation.then(() => { throw cancelledError() }),
  ])
}

async function sleepUnlessCancelled(ms) {
  throwIfCancelled()
  let timer = null
  try {
    await Promise.race([
      new Promise(resolve => { timer = setTimeout(resolve, ms) }),
      cancellation.then(() => { throw cancelledError() }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  throwIfCancelled()
}

function resetOrphan(sourceId) {
  try {
    const orphan = db.findRunningJobForSource('tg_index', sourceId)
    if (!orphan) return
    db.updateJob(orphan.id, { status: 'interrupted' })
    console.log(`[IndexJob] reset orphan running row #${orphan.id} on source #${sourceId} → interrupted`)
  } catch (error) {
    console.warn(`[IndexJob] orphan guard failed on source #${sourceId}: ${errorMessage(error)}`)
  }
}

function resetYoutubeOrphan(sourceId) {
  try {
    const orphan = db.findRunningJobForSource('yt_index', sourceId)
    if (!orphan) return
    db.updateJob(orphan.id, { status: 'interrupted' })
    console.log(`[YouTubeIndex] reset orphan running row #${orphan.id} on source #${sourceId} → interrupted`)
  } catch (error) {
    console.warn(`[YouTubeIndex] orphan guard failed on source #${sourceId}: ${errorMessage(error)}`)
  }
}

function ensureYoutubeChunks(sourceId) {
  const source = db.getSource(sourceId)
  if (!source || source.platform !== 'youtube') throw new Error(`YouTube source #${sourceId} not found`)
  const rows = db.listYoutubeTranscriptItemsForIndex(sourceId)
  const validItemIds = []
  let changedVideos = 0
  let chunks = 0
  for (const row of rows) {
    throwIfCancelled()
    let raw = ''
    try { raw = fs.readFileSync(row.transcript_path, 'utf8') } catch {
      db.replaceSemanticChunksForItem({
        itemId: row.id,
        sourceId,
        documentHash: 'missing',
        chunks: [],
      })
      continue
    }
    const result = chunkTranscript(raw, { durationSeconds: row.duration_seconds })
    if (!result.documentHash || !result.chunks.length) {
      db.replaceSemanticChunksForItem({
        itemId: row.id,
        sourceId,
        documentHash: 'empty',
        chunks: [],
      })
      continue
    }
    const replaced = db.replaceSemanticChunksForItem({
      itemId: row.id,
      sourceId,
      documentHash: result.documentHash,
      chunks: result.chunks,
    })
    validItemIds.push(row.id)
    chunks += result.chunks.length
    if (replaced.changed) changedVideos += 1
  }
  console.log(`[YouTubeIndex] prepared source #${sourceId} videos=${validItemIds.length} chunks=${chunks} changed=${changedVideos}`)
  return { source, rows, validItemIds, chunks, changedVideos }
}

function youtubeChunkEmbeddingText(row) {
  const channel = row.source_title || row.source_handle || ''
  const title = row.title || row.external_id || 'YouTube video'
  return `Channel: ${channel}\nVideo: ${title}\nFragment ${Number(row.chunk_index) + 1}:\n${String(row.text || '').slice(0, 5000)}`
}

async function runYoutubeIndexJob(data) {
  const sourceId = data.sourceId
  const limit = data.limit || null
  const origin = data.origin || 'unknown'
  const liveId = data.jobId
  const setupStarted = Date.now()

  throwIfCancelled()
  resetYoutubeOrphan(sourceId)
  const prepared = ensureYoutubeChunks(sourceId)
  throwIfCancelled()

  const selectedItems = limit ? prepared.rows.slice(0, limit) : prepared.rows
  const selectedIds = selectedItems.map(row => row.id)
  const missing = db.listUnindexedSemanticChunks(sourceId, selectedIds)
  const initial = db.semanticChunkIndexStatus(sourceId)
  const itemsTotal = missing.length
  console.log(`[YouTubeIndex] start source #${sourceId} origin=${origin} limit=${limit || 'full'} ` +
    `selection chunks=${itemsTotal} existing=${initial.done}/${initial.total}`)
  if (!itemsTotal) return { type: 'noop', reason: 'already-indexed' }

  const startedAt = Math.floor(Date.now() / 1000)
  let dbRowId = null
  try {
    dbRowId = db.recordJob({
      type: 'yt_index',
      source_id: sourceId,
      status: 'running',
      items_total: itemsTotal,
      params: { limit, origin, unit: 'fragments' },
      started_at: startedAt,
    })
  } catch (error) {
    console.error('[YouTubeIndex] recordJob failed', errorMessage(error))
  }

  post({
    type: 'started',
    dbRowId,
    itemsTotal,
    initialIndexed: initial.done,
    startedAt,
  })

  let itemsDone = 0
  let status = 'running'
  let failure = null
  let requestLog = []
  try {
    for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
      throwIfCancelled()
      const batch = missing.slice(offset, offset + BATCH_SIZE)
      while (true) {
        throwIfCancelled()
        const window = rpmWindowState(requestLog, batch.length)
        requestLog = window.entries
        if (!window.waitMs) break
        console.log(`[YouTubeIndex] #${liveId} RPM throttle: ${window.units} in window, ` +
          `+${batch.length} would exceed ${RPM_TARGET}, sleeping ${window.waitMs}ms`)
        await sleepUnlessCancelled(window.waitMs)
      }

      const embedStarted = Date.now()
      const vectors = await waitForOrCancel(embedBatch(batch.map(youtubeChunkEmbeddingText), 'RETRIEVAL_DOCUMENT'))
      requestLog.push({ ts: embedStarted, units: batch.length })
      throwIfCancelled()
      db.bulkUpsertSemanticChunkVectors(batch.map((row, index) => ({
        chunk_id: row.id,
        source_id: sourceId,
        embedding: vectors[index],
      })))
      itemsDone += batch.length
      if (dbRowId) {
        try { db.updateJob(dbRowId, { items_done: itemsDone }) } catch (error) {
          console.error('[YouTubeIndex] mid-run updateJob failed', errorMessage(error))
        }
      }
      console.log(`[YouTubeIndex] #${liveId} batch ${Math.floor(offset / BATCH_SIZE) + 1}/${Math.ceil(missing.length / BATCH_SIZE)} ` +
        `chunks=${batch.length} embed_ms=${Date.now() - embedStarted} → ${itemsDone}/${itemsTotal}`)
      post({ type: 'progress', itemsDone, itemsTotal })
    }
    status = 'done'
  } catch (error) {
    if (error?.code === 'INDEX_CANCELLED' || errorMessage(error) === 'cancelled' || isCancelled()) {
      status = 'cancelled'
      failure = null
      console.log(`[YouTubeIndex] #${liveId} cancelled at ${itemsDone}/${itemsTotal}`)
    } else {
      status = 'error'
      failure = errorMessage(error)
      console.error(`[YouTubeIndex] #${liveId} failed: ${failure}`)
    }
  } finally {
    const finishedAt = Math.floor(Date.now() / 1000)
    if (dbRowId) {
      try {
        db.updateJob(dbRowId, {
          status,
          items_done: itemsDone,
          error: failure,
          finished_at: finishedAt,
        })
      } catch (error) {
        console.error('[YouTubeIndex] updateJob failed', errorMessage(error))
      }
    }
    console.log(`[YouTubeIndex] end source #${sourceId} status=${status} ` +
      `chunks=${itemsDone}/${itemsTotal} total_ms=${Date.now() - setupStarted}`)
    return {
      type: 'terminal',
      status,
      itemsDone,
      itemsTotal,
      error: failure,
      finishedAt,
      dbRowId,
    }
  }
}

async function runIndexJob(data) {
  const sourceId = data.sourceId
  const limit = data.limit || null
  const origin = data.origin || 'unknown'
  const liveId = data.jobId
  const setupStarted = Date.now()

  throwIfCancelled()
  resetOrphan(sourceId)
  throwIfCancelled()
  if (process.env.SC_INDEX_WORKER_FIXTURE === '1') {
    const delay = Math.max(0, Number(process.env.SC_INDEX_WORKER_FIXTURE_PREPARE_DELAY_MS) || 0)
    if (delay) await sleepUnlessCancelled(delay)
  }

  const selectStarted = Date.now()
  const prepared = prepareTelegramIndex(db, sourceId, limit, { throwIfCancelled, itemIds: data.itemIds })
  const itemsTotal = prepared.messagesPending
  console.log(`[IndexJob] start source #${sourceId} origin=${origin} limit=${limit || 'full'} ` +
    `selection messages=${prepared.messagesSelected} fragments=${prepared.fragmentsSelected} ` +
    `pending_messages=${itemsTotal} pending_fragments=${prepared.fragmentsPending} ` +
    `changed=${prepared.changedMessages} took ${Date.now() - selectStarted}ms`)
  if (!itemsTotal) {
    return { type: 'noop', reason: 'already-indexed' }
  }

  throwIfCancelled()
  // Count messages only after complete atomic publication. Staged fragment
  // vectors are resumable work, not searchable coverage.
  const initialIndexed = prepared.messagesSelected - prepared.messagesPending

  const startedAt = Math.floor(Date.now() / 1000)
  let dbRowId = null
  try {
    dbRowId = db.recordJob({
      type: 'tg_index',
      source_id: sourceId,
      status: 'running',
      items_total: itemsTotal,
      params: {
        limit, origin, unit: 'messages', messages_selected: prepared.messagesSelected,
        fragments_total: prepared.fragmentsPending, fragments_selected: prepared.fragmentsSelected,
        index_version: INDEX_VERSION,
        ...(data.itemIds != null ? { item_ids: data.itemIds } : {}),
      },
      started_at: startedAt,
    })
  } catch (error) {
    console.error('[IndexJob] recordJob failed', errorMessage(error))
  }

  post({
    type: 'started',
    dbRowId,
    itemsTotal,
    initialIndexed,
    startedAt,
    unit: 'messages',
    messagesSelected: prepared.messagesSelected,
    fragmentsTotal: prepared.fragmentsPending,
    indexVersion: INDEX_VERSION,
  })
  console.log(`[IndexJob] start source #${sourceId} origin=${origin} live #${liveId} setup took ${Date.now() - setupStarted}ms`)

  const job = {
    itemsDone: 0,
    itemsTotal,
    status: 'running',
    error: null,
  }
  let requestLog = []
  let afterSeq = 0
  let fragmentsEmbedded = 0

  try {
    job.itemsDone += publishReadyTelegramGenerations(db)
    while (job.itemsDone < job.itemsTotal) {
      throwIfCancelled()
      const batch = telegramIndexPage(db, afterSeq, BATCH_SIZE)
      if (!batch.length) {
        throw new Error(`index selection changed: ${job.itemsDone}/${job.itemsTotal} messages published without remaining fragments`)
      }
      afterSeq = batch[batch.length - 1].seq

      const batchNumber = Math.floor(fragmentsEmbedded / BATCH_SIZE) + 1
      const batchCount = Math.ceil(prepared.fragmentsPending / BATCH_SIZE)
      const texts = batch.map(row => row.embedding_text)

      while (true) {
        throwIfCancelled()
        const window = rpmWindowState(requestLog, batch.length)
        requestLog = window.entries
        if (!window.waitMs) break
        console.log(`[IndexJob] #${liveId} RPM throttle: ${window.units} in window, ` +
          `+${batch.length} would exceed ${RPM_TARGET}, sleeping ${window.waitMs}ms`)
        await sleepUnlessCancelled(window.waitMs)
      }

      const embedStarted = Date.now()
      const vectors = await waitForOrCancel(embedBatch(texts, 'RETRIEVAL_DOCUMENT'))
      const embedMs = Date.now() - embedStarted
      requestLog.push({ ts: embedStarted, units: batch.length })

      throwIfCancelled()
      const writeStarted = Date.now()
      job.itemsDone += saveTelegramIndexBatch(db, batch, vectors)
      fragmentsEmbedded += batch.length
      const writeMs = Date.now() - writeStarted
      if (writeMs >= 100) {
        console.log(`[IndexJob] #${liveId} slow stage/publish batch ${batchNumber}/${batchCount} ` +
          `source #${sourceId} origin=${origin} fragments=${batch.length} write_ms=${writeMs}`)
      }

      if (dbRowId) {
        try {
          const updateStarted = Date.now()
          db.updateJob(dbRowId, { items_done: job.itemsDone })
          const updateMs = Date.now() - updateStarted
          if (updateMs >= 100) {
            console.log(`[IndexJob] #${liveId} slow updateJob source #${sourceId} origin=${origin} update_ms=${updateMs}`)
          }
        } catch (error) {
          console.error('[IndexJob] mid-run updateJob failed', errorMessage(error))
        }
      }

      const window = rpmWindowState(requestLog, 0)
      requestLog = window.entries
      console.log(`[IndexJob] #${liveId} batch ${batchNumber}/${batchCount} ` +
        `(${batch.length} fragments, total=${Date.now() - embedStarted}ms embed=${embedMs}ms ` +
        `write=${writeMs}ms, ${window.units} RPM in window) → ${job.itemsDone}/${job.itemsTotal} messages published`)
      post({ type: 'progress', itemsDone: job.itemsDone, itemsTotal: job.itemsTotal, fragmentsEmbedded })
    }
    job.status = 'done'
  } catch (error) {
    if (error?.code === 'INDEX_CANCELLED' || errorMessage(error) === 'cancelled' || isCancelled()) {
      job.status = 'cancelled'
      job.error = null
      console.log(`[IndexJob] #${liveId} cancelled at ${job.itemsDone}/${job.itemsTotal}`)
    } else {
      job.status = 'error'
      job.error = errorMessage(error)
      console.error(`[IndexJob] #${liveId} failed: ${job.error}`)
    }
  } finally {
    const finishedAt = Math.floor(Date.now() / 1000)
    if (dbRowId) {
      try {
        db.updateJob(dbRowId, {
          status: job.status,
          items_done: job.itemsDone,
          error: job.error || null,
          finished_at: finishedAt,
        })
      } catch (error) {
        console.error('[IndexJob] updateJob failed', errorMessage(error))
      }
    }
    return {
      type: 'terminal',
      status: job.status,
      itemsDone: job.itemsDone,
      itemsTotal: job.itemsTotal,
      error: job.error,
      finishedAt,
      dbRowId,
    }
  }
}

function statusForSource(sourceId) {
  return telegramFragmentIndexStatus(db, sourceId)
}

function statusForYoutubeSource(sourceId) {
  ensureYoutubeChunks(sourceId)
  return db.semanticChunkIndexStatus(sourceId)
}

function recoverJob(data) {
  if (!data.dbRowId) return { updated: false }
  db.updateJob(data.dbRowId, {
    status: data.status,
    items_done: data.itemsDone || 0,
    error: data.error || null,
    finished_at: data.finishedAt || Math.floor(Date.now() / 1000),
  })
  return { updated: true }
}

function recoverSourceJob(data) {
  const row = db.findRunningJobForSource(data.mode === 'boosty' ? 'boosty_index' : data.mode === 'youtube' ? 'yt_index' : 'tg_index', data.sourceId)
  if (!row) return { updated: false }
  db.updateJob(row.id, {
    status: data.status,
    items_done: data.itemsDone || 0,
    error: data.error || null,
    finished_at: data.finishedAt || Math.floor(Date.now() / 1000),
  })
  return { updated: true, dbRowId: row.id }
}

async function run() {
  const operation = workerData?.operation
  if (operation === 'index') {
    if (workerData?.mode === 'boosty') return require('./boosty-rag-index').runBoostyIndex(db, workerData, {
      post, embedBatch, throwIfCancelled, waitForOrCancel, sleepUnlessCancelled, isCancelled,
    })
    return workerData?.mode === 'youtube'
      ? runYoutubeIndexJob(workerData)
      : runIndexJob(workerData)
  }
  if (operation === 'status') {
    return {
      type: 'result',
      result: workerData?.mode === 'boosty'
        ? require('./boosty-rag').indexStatus(db, { source_id: workerData.sourceId })
        : workerData?.mode === 'youtube'
        ? statusForYoutubeSource(workerData.sourceId)
        : statusForSource(workerData.sourceId),
    }
  }
  if (operation === 'recover') {
    return { type: 'result', result: recoverJob(workerData) }
  }
  if (operation === 'recover-source') {
    return { type: 'result', result: recoverSourceJob(workerData) }
  }
  throw new Error(`unknown index worker operation: ${operation || '(missing)'}`)
}

async function main() {
  let finalMessage
  try {
    finalMessage = await run()
  } catch (error) {
    finalMessage = { type: 'fatal', error: errorMessage(error) }
  }
  try {
    db.close()
  } catch (error) {
    console.error('[IndexWorker] database close failed', errorMessage(error))
  }
  if (finalMessage) post(finalMessage)
  try { parentPort.close() } catch {}
}

main().catch(error => {
  try {
    console.error('[IndexWorker] fatal shutdown error', errorMessage(error))
    try { db.close() } catch (error) {
      console.error('[IndexWorker] database close failed', errorMessage(error))
    }
    post({ type: 'fatal', error: errorMessage(error) })
  } finally {
    try { parentPort.close() } catch {}
  }
})
