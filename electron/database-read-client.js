const path = require('node:path')
const { Worker } = require('node:worker_threads')

let worker = null
let nextId = 1
const pending = new Map()
const intentionalStops = new WeakSet()

function rejectPending(error) {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function ensureWorker() {
  if (worker) return worker
  const instance = new Worker(path.join(__dirname, 'database-read-worker.js'))
  instance.unref?.()
  instance.on('message', message => {
    const request = pending.get(message?.id)
    if (!request) return
    pending.delete(message.id)
    if (message.ok) request.resolve(message.value)
    else request.reject(new Error(message.error || 'database read worker failed'))
  })
  instance.on('error', error => {
    if (worker === instance) worker = null
    console.error('[DbReadWorker] error', error)
    rejectPending(error)
  })
  instance.on('exit', code => {
    if (worker === instance) worker = null
    if (intentionalStops.has(instance)) return
    if (code !== 0) {
      const error = new Error(`database read worker exited ${code}`)
      console.error('[DbReadWorker] exit', error.message)
      rejectPending(error)
    }
  })
  worker = instance
  return instance
}

function request(method, ...args) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try { ensureWorker().postMessage({ id, method, args }) }
    catch (error) { pending.delete(id); reject(error) }
  })
}

async function stop() {
  const instance = worker
  worker = null
  if (!instance) return
  intentionalStops.add(instance)
  rejectPending(new Error('database read worker stopped'))
  await instance.terminate()
}

module.exports = { request, stop }
