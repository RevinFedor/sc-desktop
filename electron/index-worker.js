'use strict'

const util = require('node:util')
const { parentPort, workerData } = require('node:worker_threads')

const {
  BATCH_SIZE,
  CONTEXT_NEIGHBORS,
  RPM_TARGET,
  buildEmbeddingText,
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

function prepareSelection(sourceId, limit) {
  const handle = db.getDb()
  handle.exec('DROP TABLE IF EXISTS temp.index_job_selection')
  handle.exec(`
    CREATE TEMP TABLE index_job_selection (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL UNIQUE
    )
  `)

  const limitSql = limit ? 'LIMIT ?' : ''
  const statement = handle.prepare(`
    INSERT INTO index_job_selection(item_id)
    SELECT i.id
      FROM items i
     WHERE i.source_id = ?
       AND i.caption IS NOT NULL AND length(trim(i.caption)) > 0
       AND i.id NOT IN (SELECT item_id FROM items_vec)
     ORDER BY i.published_at DESC, i.id DESC
     ${limitSql}
  `)
  if (limit) statement.run(sourceId, limit)
  else statement.run(sourceId)

  return handle.prepare('SELECT COUNT(*) AS n FROM index_job_selection').get()?.n || 0
}

function selectionPage(afterSeq, limit) {
  return db.getDb().prepare(`
    SELECT selected.seq, i.id, i.published_at, i.sender, i.caption, i.type
      FROM index_job_selection selected
      JOIN items i ON i.id = selected.item_id
     WHERE selected.seq > ?
     ORDER BY selected.seq ASC
     LIMIT ?
  `).all(afterSeq, limit)
}

function buildContextMap(sourceId, batchRows) {
  const map = new Map()
  if (!batchRows.length) return map

  // Preserve the old batch-level one-day candidate boundary while keeping
  // memory bounded: each target performs a LIMIT 5 lookup instead of loading
  // every caption in a dense day into JavaScript.
  const minTimestamp = batchRows.reduce(
    (minimum, row) => Math.min(minimum, Number(row.published_at) || 0),
    Infinity,
  )
  const lowerBound = Math.max(0, (Number.isFinite(minTimestamp) ? minTimestamp : 0) - 86_400)
  const priorStatement = db.getDb().prepare(`
    SELECT id, published_at, sender, caption
      FROM items
     WHERE source_id = ?
       AND published_at IS NOT NULL
       AND published_at < ?
       AND published_at >= ?
       AND caption IS NOT NULL AND length(trim(caption)) > 0
     ORDER BY published_at DESC, id DESC
     LIMIT ?
  `)

  for (const row of batchRows) {
    if (row.published_at == null) {
      map.set(row.id, [])
      continue
    }
    const priors = priorStatement
      .all(sourceId, row.published_at, lowerBound, CONTEXT_NEIGHBORS)
      .reverse()
    map.set(row.id, priors)
  }
  return map
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

async function runIndexJob(data) {
  const sourceId = data.sourceId
  const limit = data.limit || null
  const origin = data.origin || 'unknown'
  const liveId = data.jobId
  const setupStarted = Date.now()

  throwIfCancelled()
  resetOrphan(sourceId)
  throwIfCancelled()

  const selectStarted = Date.now()
  const itemsTotal = prepareSelection(sourceId, limit)
  console.log(`[IndexJob] start source #${sourceId} origin=${origin} limit=${limit || 'full'} ` +
    `selection rows=${itemsTotal} took ${Date.now() - selectStarted}ms`)
  if (!itemsTotal) {
    return { type: 'noop', reason: 'already-indexed' }
  }

  throwIfCancelled()
  const countStarted = Date.now()
  const initialIndexed = db.vectorCountForSource(sourceId)
  console.log(`[IndexJob] start source #${sourceId} vectorCount=${initialIndexed} took ${Date.now() - countStarted}ms`)

  const startedAt = Math.floor(Date.now() / 1000)
  let dbRowId = null
  try {
    dbRowId = db.recordJob({
      type: 'tg_index',
      source_id: sourceId,
      status: 'running',
      items_total: itemsTotal,
      params: { limit, origin },
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

  try {
    while (job.itemsDone < job.itemsTotal) {
      throwIfCancelled()
      const pageSize = Math.min(BATCH_SIZE, job.itemsTotal - job.itemsDone)
      const batch = selectionPage(afterSeq, pageSize)
      if (!batch.length) {
        throw new Error(`index selection changed: ${job.itemsDone}/${job.itemsTotal} rows remained available`)
      }
      afterSeq = batch[batch.length - 1].seq

      const contextStarted = Date.now()
      const contextMap = buildContextMap(sourceId, batch)
      const contextMs = Date.now() - contextStarted
      const batchNumber = Math.floor(job.itemsDone / BATCH_SIZE) + 1
      const batchCount = Math.ceil(job.itemsTotal / BATCH_SIZE)
      if (contextMs >= 100) {
        console.log(`[IndexJob] #${liveId} slow context batch ${batchNumber}/${batchCount} ` +
          `source #${sourceId} origin=${origin} rows=${batch.length} ctx_ms=${contextMs}`)
      }
      const texts = batch.map(row => buildEmbeddingText(row, contextMap.get(row.id) || []))

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
      const vectorRows = batch.map((row, index) => ({ item_id: row.id, embedding: vectors[index] }))
      const writeStarted = Date.now()
      db.bulkUpsertVectors(vectorRows)
      const writeMs = Date.now() - writeStarted
      if (writeMs >= 100) {
        console.log(`[IndexJob] #${liveId} slow bulkUpsert batch ${batchNumber}/${batchCount} ` +
          `source #${sourceId} origin=${origin} rows=${vectorRows.length} bulk_ms=${writeMs}`)
      }

      job.itemsDone += batch.length
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
        `(${batch.length} msgs, total=${Date.now() - embedStarted}ms embed=${embedMs}ms ` +
        `bulk=${writeMs}ms ctx=${contextMs}ms, ${window.units} RPM in window) → ${job.itemsDone}/${job.itemsTotal}`)
      post({ type: 'progress', itemsDone: job.itemsDone, itemsTotal: job.itemsTotal })
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
  const handle = db.getDb()
  const total = handle.prepare('SELECT COUNT(*) AS n FROM items WHERE source_id = ?').get(sourceId)?.n || 0
  const indexed = db.vectorCountForSource(sourceId)
  return { state: 'idle', done: indexed, total }
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
  const row = db.findRunningJobForSource('tg_index', data.sourceId)
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
    return runIndexJob(workerData)
  }
  if (operation === 'status') {
    return { type: 'result', result: statusForSource(workerData.sourceId) }
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
