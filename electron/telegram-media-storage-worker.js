'use strict'

const { parentPort, workerData } = require('node:worker_threads')
const { checkTelegramMediaStorage } = require('./telegram-fetch-policy')

// One check per thread. Native filesystem calls can stall on an unhealthy
// mounted device; they must never occupy Electron Main's event loop.
try {
  const value = checkTelegramMediaStorage(workerData.directory, workerData.minFreeBytes)
  parentPort.postMessage({ ok: true, value })
} catch (error) {
  parentPort.postMessage({ ok: false, error: { code: error.code || 'MEDIA_STORAGE_UNAVAILABLE', message: error.message } })
}
