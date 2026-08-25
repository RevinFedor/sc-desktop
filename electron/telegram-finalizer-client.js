const path = require('node:path')
const { Worker } = require('node:worker_threads')

let worker = null
let nextRequestId = 1
const pending = new Map()
const intentionalStops = new WeakSet()
const CLONE_CHUNK_ROWS = 500

function rejectAll(error) {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function ensureWorker() {
  if (worker) return worker
  const instance = new Worker(path.join(__dirname, 'telegram-finalizer-worker.js'))
  instance.unref?.()
  instance.on('message', message => {
    const request = pending.get(message?.requestId)
    if (!request) return
    if (message.type === 'progress') {
      try { request.onProgress?.(message.progress) } catch {}
      return
    }
    pending.delete(message.requestId)
    if (message.type === 'result') request.resolve(message.result)
    else request.reject(new Error(message.error || 'telegram finalizer worker failed'))
  })
  instance.on('error', error => {
    console.error('[TelegramFinalizer] worker error', error)
    if (worker === instance) worker = null
    rejectAll(error)
  })
  instance.on('exit', code => {
    if (worker === instance) worker = null
    if (intentionalStops.has(instance)) return
    if (code !== 0) {
      const error = new Error(`telegram finalizer worker exited ${code}`)
      console.error('[TelegramFinalizer] worker exit', error.message)
      rejectAll(error)
    }
  })
  worker = instance
  return instance
}

function finalizeTelegramJob(payload, { onProgress } = {}) {
  const requestId = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onProgress })
    let instance
    try {
      instance = ensureWorker()
    } catch (error) {
      pending.delete(requestId)
      reject(error)
      return
    }
    const arrays = [
      ['items', Array.isArray(payload?.items) ? payload.items : []],
      ['mediaResults', Array.isArray(payload?.mediaResults) ? payload.mediaResults : []],
      ['commentsBuffer', Array.isArray(payload?.commentsBuffer) ? payload.commentsBuffer : []],
    ]
    const metadata = { ...(payload || {}) }
    delete metadata.items
    delete metadata.mediaResults
    delete metadata.commentsBuffer

    try {
      instance.postMessage({ type: 'finalize-start', requestId, payload: metadata })
    } catch (error) {
      pending.delete(requestId)
      reject(error)
      return
    }

    // Structured-cloning one 50k-message array in Worker.postMessage() can
    // itself monopolise main for hundreds of milliseconds. Clone bounded
    // chunks and yield between them; the worker reconstructs the payload.
    let fieldIndex = 0
    let rowIndex = 0
    const pump = () => {
      if (!pending.has(requestId)) return
      try {
        while (fieldIndex < arrays.length) {
          const [field, rows] = arrays[fieldIndex]
          if (rowIndex < rows.length) {
            const chunk = rows.slice(rowIndex, rowIndex + CLONE_CHUNK_ROWS)
            rowIndex += chunk.length
            instance.postMessage({ type: 'finalize-chunk', requestId, field, rows: chunk })
            setImmediate(pump)
            return
          }
          fieldIndex += 1
          rowIndex = 0
        }
        instance.postMessage({ type: 'finalize-commit', requestId })
      } catch (error) {
        const request = pending.get(requestId)
        pending.delete(requestId)
        request?.reject(error)
      }
    }
    setImmediate(pump)
  })
}

function finalizeCatalogJob(payload, { onProgress } = {}) {
  const requestId = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onProgress })
    let instance
    try {
      instance = ensureWorker()
    } catch (error) {
      pending.delete(requestId)
      reject(error)
      return
    }
    const items = Array.isArray(payload?.items) ? payload.items : []
    const metadata = { ...(payload || {}) }
    delete metadata.items
    try {
      instance.postMessage({ type: 'catalog-start', requestId, payload: metadata })
    } catch (error) {
      pending.delete(requestId)
      reject(error)
      return
    }
    let index = 0
    const pump = () => {
      if (!pending.has(requestId)) return
      try {
        if (index < items.length) {
          const rows = items.slice(index, index + CLONE_CHUNK_ROWS)
          index += rows.length
          instance.postMessage({ type: 'catalog-chunk', requestId, rows })
          setImmediate(pump)
          return
        }
        instance.postMessage({ type: 'catalog-commit', requestId })
      } catch (error) {
        const request = pending.get(requestId)
        pending.delete(requestId)
        request?.reject(error)
      }
    }
    setImmediate(pump)
  })
}

function requestPersistence(type, payload) {
  const requestId = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onProgress: null })
    try {
      ensureWorker().postMessage({ type, requestId, payload: payload || {} })
    } catch (error) {
      pending.delete(requestId)
      reject(error)
    }
  })
}

function syncTelegramFolder(payload) {
  return requestPersistence('sync-folder', payload)
}

function pruneTelegramFolders(payload) {
  return requestPersistence('prune-folders', payload)
}

function setTelegramAutoForSources(payload) {
  return requestPersistence('set-telegram-auto', payload)
}

function applyTelegramReplyUpdates(payload) {
  return requestPersistence('apply-reply-updates', payload)
}

function persistItemMutation(payload) {
  return requestPersistence('item-mutation', payload)
}

function finalizeBatchJob(payload) {
  return requestPersistence('finalize-batch-job', payload)
}

function stopTelegramFinalizer() {
  const instance = worker
  worker = null
  if (!instance) return Promise.resolve()
  intentionalStops.add(instance)
  rejectAll(new Error('telegram finalizer stopped'))
  return instance.terminate()
}

module.exports = {
  finalizeTelegramJob,
  finalizeCatalogJob,
  syncTelegramFolder,
  pruneTelegramFolders,
  setTelegramAutoForSources,
  applyTelegramReplyUpdates,
  persistItemMutation,
  finalizeBatchJob,
  stopTelegramFinalizer,
}
