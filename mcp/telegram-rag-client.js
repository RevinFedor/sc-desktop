'use strict'

function createTelegramRagClient({ baseUrl = process.env.SC_DESKTOP_BRIDGE_URL || 'http://127.0.0.1:53127', fetchImpl = globalThis.fetch } = {}) {
  async function call(path, body = null) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 35000)
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: body == null ? 'GET' : 'POST',
        headers: body == null ? undefined : { 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body), signal: controller.signal,
      })
      if (response.status === 404) {
        throw new Error('The running SC Desktop app needs the Telegram RAG Application API update. No hidden MCP worker fallback was started.')
      }
      const out = await response.json()
      if (!response.ok || out.ok === false) throw Object.assign(new Error(out.error || `SC Desktop returned ${response.status}`), {
        code: out.code, existing_job_id: out.existing_job_id || null,
        request_id: out.request_id, job_id: out.job_id, accepted: out.accepted === true,
      })
      return out
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('SC Desktop RAG request timed out; check the existing source/job status before starting again')
      throw error
    } finally { clearTimeout(timer) }
  }
  return {
    startIndex: args => call('/telegram-rag/index/start', args),
    listIndices: args => call(`/telegram-rag/index/list?${new URLSearchParams(Object.entries(args || {}).filter(([, v]) => v != null))}`),
    indexStatus: args => call(`/telegram-rag/index/status?${new URLSearchParams(Object.entries(args).filter(([, v]) => v != null))}`),
    cancelIndex: args => call('/telegram-rag/index/cancel', args),
    startFetch: params => call('/telegram-rag/fetch/start', { params }),
    fetchStatus: args => call(`/telegram-rag/fetch/status?${new URLSearchParams(args)}`),
    cancelFetch: args => call('/telegram-rag/fetch/cancel', args),
    resumeFetch: args => call('/telegram-rag/fetch/resume', args),
  }
}

module.exports = { createTelegramRagClient }
