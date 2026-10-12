'use strict'

// Main-process coordinator for semantic indexing. All corpus reads, context
// construction, embedding throttling, and SQLite writes live in
// index-worker.js; this module keeps only lightweight public job state and
// forwards worker progress to the existing job:update subscribers.

const path = require('node:path')
const { Worker } = require('node:worker_threads')
const dbRead = require('./database-read-client')

const {
  normalizeSourceId,
  normalizeStartRequest,
  createStartingState,
  applyWorkerMessage,
  snapshot,
  runningStatus,
  matchesJobId,
  errorMessage,
} = require('./index-worker-protocol')

const WORKER_PATH = path.join(__dirname, 'index-worker.js')

function defaultWorkerFactory(data) {
  // Worker inherits the complete process environment explicitly, including
  // SC_DESKTOP_DB/SC_DESKTOP_DIR and GEMINI_API_KEY in dev, tests, and the
  // packaged Electron process. electron-builder includes electron/**/*, so
  // WORKER_PATH remains available from inside app.asar.
  return new Worker(WORKER_PATH, {
    workerData: data,
    env: { ...process.env },
  })
}

function logWorkerMessage(logger, message) {
  const level = message?.level === 'error' ? 'error'
    : message?.level === 'warn' ? 'warn'
      : 'log'
  const raw = typeof message?.message === 'string' ? message.message : String(message?.message || '')
  const tagged = /^\[[^\]]+\]/.test(raw) ? raw : `[IndexWorker] ${raw}`
  const output = typeof logger?.[level] === 'function' ? logger[level]
    : typeof logger?.log === 'function' ? logger.log
      : console.log
  try { output.call(logger, tagged) } catch {}
}

function terminateQuietly(worker) {
  if (!worker || typeof worker.terminate !== 'function') return
  try {
    const result = worker.terminate()
    if (result && typeof result.catch === 'function') result.catch(() => {})
  } catch {}
}

function createControlTask(workerFactory, logger) {
  return function runControlTask(operation, payload = {}) {
    return new Promise((resolve, reject) => {
      let worker
      let settled = false

      const finish = (error, result) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve(result)
        terminateQuietly(worker)
      }

      try {
        worker = workerFactory({ operation, ...payload })
        worker.unref?.()
      } catch (error) {
        finish(error)
        return
      }

      worker.on('message', message => {
        if (message?.type === 'log') {
          logWorkerMessage(logger, message)
          return
        }
        if (message?.type === 'result') {
          finish(null, message.result)
          return
        }
        if (message?.type === 'fatal') {
          finish(new Error(errorMessage(message.error)))
        }
      })
      worker.on('error', error => finish(error))
      worker.on('exit', code => {
        if (!settled) finish(new Error(`index ${operation} worker exited before result (code ${code})`))
      })
    })
  }
}

function createCoordinator({
  workerFactory = defaultWorkerFactory,
  controlTask = null,
  statusTask = null,
  logger = console,
  idSeed = 1,
} = {}) {
  let nextId = idSeed
  const activeJobs = new Map()
  const listeners = new Set()
  let telegramPreparation = null
  const runControlTask = controlTask || createControlTask(workerFactory, logger)
  const readIdleStatus = statusTask || (sourceId => runControlTask('status', { sourceId }))

  function emit(state) {
    const value = snapshot(state)
    for (const listener of listeners) {
      try { listener(value) } catch {}
    }
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function removeIfCurrent(job) {
    const key = `${job.state.mode || 'telegram'}:${job.state.source_id}`
    if (activeJobs.get(key) === job) {
      activeJobs.delete(key)
    }
  }

  function resolveStartup(job, value) {
    if (job.startSettled) return
    job.startSettled = true
    job.resolveStart(value)
  }

  function rejectStartup(job, error) {
    if (job.startSettled) return
    job.startSettled = true
    job.rejectStart(error)
  }

  async function failJob(job, failure) {
    if (job.lifecycleSettled || job.failureStarted) return
    job.failureStarted = true
    const message = errorMessage(failure)

    if (!job.startSettled || job.state.phase === 'starting') {
      const status = job.cancelled ? 'cancelled' : 'error'
      const finishedAt = Math.floor(Date.now() / 1000)
      // A worker can fail in the tiny window after INSERTing its running row
      // but before main receives the `started` message containing that row id.
      // Recover by source so History never keeps an orphaned running entry.
      try {
        await runControlTask('recover-source', {
          sourceId: job.state.source_id,
          mode: job.state.mode,
          status,
          itemsDone: 0,
          error: status === 'error' ? message : null,
          finishedAt,
        })
      } catch (recoveryError) {
        logger.error?.(`[IndexJob] failed startup recovery for source #${job.state.source_id}: ${errorMessage(recoveryError)}`)
      }
      job.lifecycleSettled = true
      removeIfCurrent(job)
      job.state = applyWorkerMessage(job.state, {
        type: 'terminal', status, itemsDone: 0, itemsTotal: 0,
        error: status === 'error' ? message : null, finishedAt,
      })
      rejectStartup(job, failure instanceof Error ? failure : new Error(message))
      if (job.tracked) emit(job.state)
      terminateQuietly(job.worker)
      return
    }

    const status = job.cancelled ? 'cancelled' : 'error'
    const finishedAt = Math.floor(Date.now() / 1000)
    job.state = applyWorkerMessage(job.state, {
      type: 'terminal',
      status,
      itemsDone: job.state.items_done,
      itemsTotal: job.state.items_total,
      error: status === 'error' ? message : null,
      finishedAt,
      dbRowId: job.state.dbRowId,
    })

    if (job.state.dbRowId) {
      try {
        await runControlTask('recover', {
          dbRowId: job.state.dbRowId,
          status,
          itemsDone: job.state.items_done,
          error: job.state.error,
          finishedAt,
        })
      } catch (recoveryError) {
        logger.error?.(`[IndexJob] failed to recover DB row #${job.state.dbRowId}: ${errorMessage(recoveryError)}`)
      }
    }

    job.lifecycleSettled = true
    removeIfCurrent(job)
    if (status === 'cancelled') {
      logger.log?.(`[IndexJob] #${job.state.id} worker stopped after cancellation at ${job.state.items_done}/${job.state.items_total}`)
    } else {
      logger.error?.(`[IndexJob] #${job.state.id} worker failed: ${message}`)
    }
    emit(job.state)
    terminateQuietly(job.worker)
  }

  function attachWorker(job) {
    const worker = job.worker
    worker.unref?.()

    worker.on('message', message => {
      if (message?.type === 'log') {
        logWorkerMessage(logger, message)
        return
      }
      if (message?.type === 'noop') {
        if (job.lifecycleSettled) return
        job.lifecycleSettled = true
        removeIfCurrent(job)
        resolveStartup(job, { noop: true, reason: message.reason || 'already-indexed' })
        if (job.tracked) {
          job.state = {
            ...applyWorkerMessage(job.state, {
              type: 'terminal', status: 'done', itemsDone: 0, itemsTotal: 0,
              finishedAt: Math.floor(Date.now() / 1000),
            }),
            noop: true,
            reason: message.reason || 'already-indexed',
          }
          emit(job.state)
        }
        terminateQuietly(worker)
        return
      }
      if (message?.type === 'fatal') {
        void failJob(job, new Error(errorMessage(message.error)))
        return
      }
      if (!['started', 'progress', 'terminal'].includes(message?.type)) {
        void failJob(job, new Error(`unknown index worker message: ${message?.type || '(missing)'}`))
        return
      }

      try {
        job.state = applyWorkerMessage(job.state, message)
      } catch (error) {
        void failJob(job, error)
        return
      }

      if (message.type === 'started') {
        resolveStartup(job, snapshot(job.state).id)
        emit(job.state)
        return
      }
      if (message.type === 'progress') {
        emit(job.state)
        return
      }

      job.lifecycleSettled = true
      removeIfCurrent(job)
      emit(job.state)
      // In the cancellation path embedBatch may still have an in-flight fetch
      // that lost a Promise.race. The DB row is already final before the
      // terminal message, so terminating now is safe and releases it promptly.
      terminateQuietly(worker)
    })

    worker.on('error', error => { void failJob(job, error) })
    worker.on('exit', code => {
      if (!job.lifecycleSettled) {
        void failJob(job, new Error(`index worker exited before terminal message (code ${code})`))
      }
    })
  }

  /**
   * Start indexing for one source. The Promise resolves after the worker has
   * atomically selected its corpus and either created the DB row (job id) or
   * proved the request is a no-op ({noop:true}). Concurrent calls for the same
   * source share that result and never spawn a second worker.
   */
  function jobForRequest(rawRequest, tracked = false) {
    const request = normalizeStartRequest(rawRequest)
    const mode = ['youtube', 'boosty'].includes(rawRequest?.mode) ? rawRequest.mode : 'telegram'
    if (mode === 'youtube' && request.itemIds != null) throw new Error('itemIds selection is only supported for Telegram indexing')
    const key = `${mode}:${request.sourceId}`
    const existing = activeJobs.get(key)
    if (existing) {
      if (tracked && (request.limit !== existing.request.limit ||
          JSON.stringify(request.itemIds ?? null) !== JSON.stringify(existing.request.itemIds ?? null))) {
        const error = new Error(`source already has an index job with another selection: ${snapshot(existing.state).id}`)
        error.code = 'INDEX_ALREADY_RUNNING_DIFFERENT_SCOPE'
        error.jobId = snapshot(existing.state).id
        throw error
      }
      if (tracked && !existing.tracked) {
        existing.tracked = true
        if (existing.state.phase === 'starting') emit(existing.state)
      }
      return existing
    }

    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const job = {
      state: createStartingState({ id: nextId++, sourceId: request.sourceId, mode, startedAt: Math.floor(Date.now() / 1000) }),
      request,
      tracked,
      worker: null,
      cancelBuffer,
      cancelView: new Int32Array(cancelBuffer),
      cancelled: false,
      startSettled: false,
      lifecycleSettled: false,
      failureStarted: false,
      resolveStart: null,
      rejectStart: null,
      startPromise: null,
    }
    job.startPromise = new Promise((resolve, reject) => {
      job.resolveStart = resolve
      job.rejectStart = reject
    })
    // A tracked caller receives its live id before preparation and does not
    // await this promise. Retain rejection for .start() callers while ensuring
    // a later preparation failure cannot become an unhandled rejection.
    job.startPromise.catch(() => {})
    activeJobs.set(key, job)
    if (tracked) emit(job.state)

    const launchWorker = () => {
      if (job.cancelled) throw new Error('index cancelled during preparation')
      job.worker = workerFactory({
        operation: 'index',
        jobId: job.state.id,
        sourceId: request.sourceId,
        mode,
        limit: request.limit,
        origin: request.origin,
        ...(request.itemIds != null ? { itemIds: request.itemIds } : {}),
        ...(request.requestId != null ? { requestId: request.requestId } : {}),
        cancelBuffer,
      })
      attachWorker(job)
    }
    if (mode === 'telegram' && telegramPreparation) {
      // The owned preparation (reply metadata) finishes BEFORE the worker
      // snapshots embedding inputs. The public job already exists and Cancel
      // reaches its child instead of leaving hidden Telethon work running.
      Promise.resolve().then(() => telegramPreparation(request, {
        isCancelled: () => job.cancelled,
        onCancel: callback => {
          job.cancelPreparation = callback
          if (job.cancelled) callback()
        },
      })).then(launchWorker).catch(error => { void failJob(job, error) })
    } else {
      try { launchWorker() } catch (error) { void failJob(job, error) }
    }

    return job
  }

  async function start(rawRequest) {
    return jobForRequest(rawRequest).startPromise
  }

  function startTracked(rawRequest) {
    return snapshot(jobForRequest(rawRequest, true).state)
  }

  function currentSnapshot(value, requestedMode = 'telegram') {
    const sourceId = normalizeSourceId(value)
    const mode = ['youtube', 'boosty'].includes(requestedMode) ? requestedMode : 'telegram'
    const job = activeJobs.get(`${mode}:${sourceId}`)
    return job ? snapshot(job.state) : null
  }

  function getActiveSnapshot(value) {
    for (const job of activeJobs.values()) {
      if (matchesJobId(job.state, value)) return snapshot(job.state)
    }
    return null
  }

  function listActiveSnapshots() {
    return [...activeJobs.values()].map(job => snapshot(job.state))
  }

  async function statusForSource(value, requestedMode = 'telegram') {
    const sourceId = normalizeSourceId(value)
    const mode = ['youtube', 'boosty'].includes(requestedMode) ? requestedMode : 'telegram'
    const key = `${mode}:${sourceId}`
    const pending = activeJobs.get(key)
    if (pending) {
      if (pending.state.phase === 'starting') {
        return { ...runningStatus(pending.state), phase: 'starting',
          unit: pending.state.mode === 'youtube' ? 'fragments' : 'messages' }
      }
      const live = activeJobs.get(key)
      if (live?.state.phase === 'running') return runningStatus(live.state)
    }
    return readIdleStatus(sourceId, mode)
  }

  function signalCancellation(job, label) {
    if (!job || job.lifecycleSettled) return false
    job.cancelled = true
    Atomics.store(job.cancelView, 0, 1)
    try { job.cancelPreparation?.() } catch {}
    try { job.worker?.postMessage({ type: 'cancel' }) } catch {}
    logger.log?.(`[IndexJob] cancel requested ${label} matched live #${job.state.id} ` +
      `db #${job.state.dbRowId || '-'} source #${job.state.source_id}`)
    return true
  }

  function cancel(value, requestedMode = 'telegram') {
    let sourceId
    try { sourceId = normalizeSourceId(value) } catch { return false }
    const mode = ['youtube', 'boosty'].includes(requestedMode) ? requestedMode : 'telegram'
    const job = activeJobs.get(`${mode}:${sourceId}`)
    return signalCancellation(job, `source #${sourceId}`)
  }

  function cancelById(value) {
    for (const job of activeJobs.values()) {
      if (matchesJobId(job.state, value)) return signalCancellation(job, `id=${value}`)
    }
    const active = Array.from(activeJobs.values())
      .map(job => `live #${job.state.id}/db #${job.state.dbRowId || '-'}/source #${job.state.source_id}`)
      .join(', ')
    logger.log?.(`[IndexJob] cancel requested id=${value} not found active=[${active}]`)
    return false
  }

  return {
    setTelegramPreparation: callback => { telegramPreparation = typeof callback === 'function' ? callback : null },
    start,
    startTracked,
    currentSnapshot,
    getActiveSnapshot,
    listActiveSnapshots,
    cancel,
    cancelById,
    statusForSource,
    subscribe,
    // Focused node:test coverage uses dependency injection instead of loading
    // Electron's native better-sqlite3 module in the system Node ABI.
    _activeCount: () => activeJobs.size,
  }
}

const coordinator = createCoordinator({
  // Public IDs from a previous app run must never alias a newly started job
  // (especially for Cancel). Native fixtures keep their deterministic IDs.
  idSeed: process.env.SC_INDEX_WORKER_FIXTURE === '1' ? 1 : Date.now() * 1000,
  // Idle status is a pair of SQLite counts. Reuse the persistent read worker
  // instead of booting the much heavier embedding worker on every mount.
  statusTask: (sourceId, mode) => mode === 'boosty'
    ? dbRead.request('boostyRag', 'status', { source_id: sourceId })
    : mode === 'youtube'
    ? createControlTask(defaultWorkerFactory, console)('status', { sourceId, mode })
    : dbRead.request('semanticIndexStatus', sourceId),
})

module.exports = {
  setTelegramPreparation: coordinator.setTelegramPreparation,
  start: coordinator.start,
  startTracked: coordinator.startTracked,
  currentSnapshot: coordinator.currentSnapshot,
  getActiveSnapshot: coordinator.getActiveSnapshot,
  listActiveSnapshots: coordinator.listActiveSnapshots,
  cancel: coordinator.cancel,
  cancelById: coordinator.cancelById,
  statusForSource: coordinator.statusForSource,
  subscribe: coordinator.subscribe,
  _createCoordinator: createCoordinator,
}
