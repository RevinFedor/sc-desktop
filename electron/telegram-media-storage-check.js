'use strict'

const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { validateTelegramFetchPolicy } = require('./telegram-fetch-policy')

function createTelegramMediaStorageChecks({ workerFactory = data => new Worker(path.join(__dirname, 'telegram-media-storage-worker.js'), { workerData: data }),
  deadlineMs = 10000, maxConcurrent = 4 } = {}) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('Invalid storage checker limits')
  const active = new Map()
  let serial = 0
  function scopeFor(directory) {
    // Pure lexical grouping: even stat/realpath can hang, so no main-thread
    // filesystem access is allowed while choosing the single-flight key.
    const folded = process.platform === 'darwin' ? directory.toLowerCase() : directory
    return folded.startsWith('/volumes/') && process.platform === 'darwin'
      ? `volume:${folded.split('/')[2]}`
      : directory.startsWith('/Volumes/') ? `volume:${directory.split('/')[2]}` : 'filesystem:local'
  }
  const snapshot = entry => ({ check_id: entry.id, directory: entry.directory, scope: entry.scope,
    started_at: entry.startedAt, deadline_ms: deadlineMs, state: entry.state,
    pending: true, retry_allowed: false })
  function pendingError(entry, message) {
    return Object.assign(new Error(message), { code: 'MEDIA_STORAGE_UNAVAILABLE', recovery_reason: 'CHECK_PENDING',
      storage_check: entry ? snapshot(entry) : { pending: true, retry_allowed: false, state: 'capacity_pending' } })
  }
  function check(directory, minFreeBytes = 268435456) {
    // Validation is CPU-only; disk access occurs exclusively in the worker.
    const policy = validateTelegramFetchPolicy({ media_cache_dir: directory, media_min_free_bytes: minFreeBytes })
    const clean = path.resolve(policy.media_cache_dir)
    const scope = scopeFor(clean)
    if (active.has(scope)) return Promise.reject(pendingError(active.get(scope), 'A storage check on this filesystem is still pending; no replacement checker was started'))
    if (active.size >= maxConcurrent) return Promise.reject(pendingError(null, 'Storage checker capacity is occupied by pending filesystem operations'))
    const entry = { id: `storage:${++serial}`, directory: clean, scope, startedAt: Math.floor(Date.now() / 1000), state: 'checking', settled: false, timer: null, worker: null }
    active.set(scope, entry)
    return new Promise((resolve, reject) => {
      const settle = (error, value) => {
        if (entry.settled) return
        entry.settled = true
        clearTimeout(entry.timer)
        if (error) reject(error)
        else resolve(value)
      }
      entry.timer = setTimeout(() => {
        entry.state = 'timed_out_pending'
        settle(pendingError(entry, 'Storage check exceeded its deadline; the filesystem operation may still be pending'))
        // Do not await terminate(): an in-kernel filesystem call may not be
        // interruptible. Keep its single-flight lock until the actual exit.
      }, deadlineMs)
      try {
        const worker = workerFactory({ directory: clean, minFreeBytes })
        entry.worker = worker
        worker.on('message', message => {
          if (entry.state !== 'timed_out_pending') entry.state = 'completing'
          if (message?.ok === true && message.value && typeof message.value === 'object') settle(null, message.value)
          else settle(Object.assign(new Error(message?.error?.message || 'Storage checker returned no usable result'),
            { code: message?.error?.code || 'MEDIA_STORAGE_UNAVAILABLE' }))
        })
        worker.on('error', error => {
          if (entry.state !== 'timed_out_pending') entry.state = 'failed'
          settle(Object.assign(new Error('Storage checker worker failed: ' + error.message), { code: 'MEDIA_STORAGE_UNAVAILABLE' }))
        })
        worker.on('exit', code => {
          if (active.get(scope) === entry) active.delete(scope)
          settle(Object.assign(new Error(`Storage checker exited without a result (${code})`), { code: 'MEDIA_STORAGE_UNAVAILABLE' }))
        })
        worker.unref?.()
      } catch (error) {
        // Constructor failure is before any checker thread exists.
        if (active.get(scope) === entry) active.delete(scope)
        settle(Object.assign(new Error('Unable to start storage checker: ' + error.message), { code: 'MEDIA_STORAGE_UNAVAILABLE' }))
      }
    })
  }
  return { check, pending: () => [...active.values()].map(snapshot) }
}

// Share the lock across Application API instances within one main process.
const checks = createTelegramMediaStorageChecks()
module.exports = { createTelegramMediaStorageChecks,
  checkTelegramMediaStorageAsync: (directory, minFreeBytes) => checks.check(directory, minFreeBytes),
  pendingTelegramMediaStorageChecks: () => checks.pending() }
