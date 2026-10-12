const { randomUUID } = require('node:crypto')

function navigationKey(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value)) {
    throw Object.assign(new Error(`invalid ${field}`), { statusCode: 400 })
  }
  return value
}

// This owns only local UI navigation. It must not create, restart, stop, or
// change a research job, and success requires the exact rendered detail page.
function createResearchNavigation({ readJob, getWindow, deadlineMs = 15000, makeId = randomUUID }) {
  const requests = new Map()
  let active = null, sequence = 0
  const finish = (request, body) => {
    if (request.result) return
    clearTimeout(request.timer)
    request.result = body
    if (active === request) active = null
    request.resolve(body)
  }
  const publish = request => request.window.webContents.send('research:open-job-request', {
    requestId: request.id, jobId: request.jobId, sequence: request.sequence,
  })
  return {
    async open({ jobId, requestId = makeId() } = {}) {
      navigationKey(jobId, 'jobId'); navigationKey(requestId, 'requestId')
      const previous = requests.get(requestId)
      if (previous) {
        if (previous.jobId !== jobId) throw Object.assign(new Error('research_navigation_request_conflict'), { statusCode: 409 })
        return previous.promise
      }
      const ticket = ++sequence
      if (active) finish(active, { ok: false, error: 'research_navigation_superseded' })
      let resolve
      const promise = new Promise(done => { resolve = done })
      const request = { id: requestId, jobId, sequence: ticket, resolve, promise, result: null, timer: null }
      requests.set(requestId, request)
      active = request
      request.timer = setTimeout(() => finish(request, { ok: false, error: 'research_navigation_timeout' }), deadlineMs)
      for (const [key, row] of requests) {
        if (requests.size <= 128) break
        if (row.result) requests.delete(key)
      }
      try {
        const job = await readJob(jobId)
        if (ticket !== sequence || request.result) return promise
        if (!job || job.jobId !== jobId) {
          finish(request, { ok: false, error: 'research_job_not_found' }); return promise
        }
        const window = getWindow()
        if (!window || window.isDestroyed()) {
          finish(request, { ok: false, error: 'research_window_unavailable' }); return promise
        }
        request.window = window
        if (window.isMinimized()) window.restore()
        window.show(); window.focus()
        publish(request)
      } catch (error) {
        finish(request, { ok: false, error: error?.message || 'research_navigation_failed' })
      }
      return promise
    },
    ready(senderId) {
      if (!active?.window || active.result || active.window.webContents.id !== senderId) return null
      return { requestId: active.id, jobId: active.jobId, sequence: active.sequence }
    },
    acknowledge(senderId, body) {
      const request = requests.get(body?.requestId)
      if (!request?.window || request.window.webContents.id !== senderId || request.jobId !== body?.jobId) return { ok: false }
      if (request.result) return { ok: request.result.ok === true }
      if (active !== request) return { ok: false }
      finish(request, body.success === true ? { ok: true, opened: true, jobId: request.jobId, requestId: request.id }
        : { ok: false, error: body.error || 'research_navigation_failed' })
      return { ok: true }
    },
    dispose() {
      sequence++
      for (const request of requests.values()) finish(request, { ok: false, error: 'research_navigation_disposed' })
      requests.clear()
    },
  }
}

module.exports = { createResearchNavigation }
