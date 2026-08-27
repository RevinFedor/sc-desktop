const DEFAULT_BASE_URL = 'http://127.0.0.1:53127'

function bridgeError(error) {
  const message = String(error?.message || error)
  if (/fetch failed|ECONNREFUSED|socket/i.test(message)) {
    return new Error(
      'SC Desktop live bridge is unavailable on 127.0.0.1:53127. ' +
      'Open the current SC Desktop build; live Telegram requests deliberately do not fall back to a hidden MCP subprocess.',
    )
  }
  return error instanceof Error ? error : new Error(message)
}

function createTelegramLiveClient({
  baseUrl = process.env.SC_DESKTOP_BRIDGE_URL || DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')

  async function request(pathname, { method = 'GET', body = null, timeoutMs = 35000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${baseUrl}${pathname}`, {
        method,
        headers: body == null ? undefined : { 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let payload = null
      try { payload = text ? JSON.parse(text) : {} } catch {
        throw new Error(`SC Desktop live bridge returned invalid JSON (${response.status})`)
      }
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `SC Desktop live bridge returned ${response.status}`)
      }
      return payload
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('SC Desktop live bridge request timed out')
      throw bridgeError(error)
    } finally {
      clearTimeout(timer)
    }
  }

  async function start(jobRequest, waitMs = 15000) {
    const started = await request('/telegram-live/start', {
      method: 'POST',
      body: jobRequest,
    })
    const wait = Math.max(0, Math.min(30000, Number(waitMs || 0) || 0))
    if (!wait) return started
    return status(started.job_id, wait)
  }

  function status(jobId, waitMs = 0) {
    if (!jobId) throw new Error('job_id is required')
    const wait = Math.max(0, Math.min(30000, Number(waitMs || 0) || 0))
    return request(
      `/telegram-live/status?id=${encodeURIComponent(String(jobId))}&wait=${wait}`,
      { timeoutMs: Math.max(5000, wait + 5000) },
    )
  }

  function cancel(jobId) {
    if (!jobId) throw new Error('job_id is required')
    return request('/telegram-live/cancel', {
      method: 'POST',
      body: { job_id: jobId },
    })
  }

  async function save(saveRequest, waitMs = 0) {
    const started = await request('/telegram-live/save', {
      method: 'POST',
      body: saveRequest,
    })
    const wait = Math.max(0, Math.min(30000, Number(waitMs || 0) || 0))
    if (!wait) return started
    return status(started.job_id, wait)
  }

  return { start, status, cancel, save }
}

module.exports = { DEFAULT_BASE_URL, createTelegramLiveClient }
