const { fork } = require('node:child_process')
const path = require('node:path')

const INACTIVITY_MS = 45_000
const MAX_WORKERS = 4
let activeWorkers = 0
const queued = []

function pump() {
  while (activeWorkers < MAX_WORKERS && queued.length) {
    const { input, options, resolve, reject } = queued.shift()
    activeWorkers++
    runWorker(input, options).then(resolve, reject).finally(() => { activeWorkers--; pump() })
  }
}

function runWorker(input, { inactivityMs = INACTIVITY_MS, onProgress, workerPath = path.join(__dirname, 'research-attachment-worker.js') } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, progress = null
    function finish(error, attachments) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        if (child?.connected) child.disconnect()
        child?.kill('SIGKILL')
        reject(error)
      } else resolve(attachments)
    }
    function deadline() {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const detail = progress ? ` (${progress.operation}: ${progress.path})` : ''
        const error = new Error(`Attachment preparation stopped making progress${detail}. No browser request was sent.`)
        Object.assign(error, { code: 'attachment_preparation_timeout', statusCode: 400, progress })
        finish(error)
      }, inactivityMs)
      timer.unref?.()
    }
    try {
      child = fork(workerPath, [], {
        execPath: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      deadline()
      child.on('message', message => {
        if (settled) return
        if (message?.type === 'progress') {
          progress = { operation: message.operation, path: message.path }
          deadline()
          onProgress?.(progress)
        } else if (message?.type === 'done') finish(null, message.attachments)
        else if (message?.type === 'error') {
          finish(Object.assign(new Error(message.error), {
            code: message.code || 'attachment_validation_failed', statusCode: 400, progress,
          }))
        }
      })
      child.once('error', error => finish(Object.assign(error, { code: 'attachment_worker_failed', statusCode: 400 })))
      child.once('exit', (code, signal) => {
        if (!settled) finish(Object.assign(new Error(`Attachment worker exited before completing (${signal || code})`),
          { code: 'attachment_worker_failed', statusCode: 400, progress }))
      })
      child.send(input, error => { if (error) finish(error) })
    } catch (error) { finish(error) }
  })
}

function prepareResearchAttachments(input, options) {
  if (!input.specs?.length) return Promise.resolve([])
  return new Promise((resolve, reject) => {
    queued.push({ input, options, resolve, reject })
    pump()
  })
}

module.exports = { prepareResearchAttachments, INACTIVITY_MS, MAX_WORKERS }
