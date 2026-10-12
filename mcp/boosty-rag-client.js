'use strict'

const fs = require('node:fs')
const { getNotificationTokenPath, readNotificationToken } = require('../electron/local-notification-auth')

function createBoostyRagClient({ baseUrl = process.env.SC_DESKTOP_BRIDGE_URL || 'http://127.0.0.1:53127',
  fetchImpl = globalThis.fetch, tokenReader = () => {
    const tokenPath = getNotificationTokenPath()
    if (fs.statSync(tokenPath).mode & 0o077) throw new Error('SC local API token must be private (mode 0600)')
    return readNotificationToken(tokenPath)
  } } = {}) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('Boosty saved-text API must be local loopback HTTP')
  async function call(route, body = null) {
    const token = tokenReader()
    if (!token) throw new Error('SC Desktop local API token is unavailable; start the installed app')
    const response = await fetchImpl(new URL(route, base), {
      method: body == null ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${token}`, ...(body == null ? {} : { 'Content-Type': 'application/json' }) },
      body: body == null ? undefined : JSON.stringify(body),
    })
    if (response.status === 404) throw Object.assign(new Error('The running SC Desktop app needs the Boosty saved-text RAG API update. No storage or worker fallback was used.'), { code: 'BOOSTY_APP_UPDATE_REQUIRED' })
    const out = await response.json()
    if (!response.ok || out.ok === false) throw Object.assign(new Error(out.error || `SC Desktop HTTP ${response.status}`), { code: out.code || 'BOOSTY_API_ERROR' })
    return out
  }
  const get = (route, args) => call(`/boosty-rag/${route}?${new URLSearchParams(Object.entries(args || {}).filter(([, value]) => value != null))}`)
  return { call, sources: args => get('sources', args), interviews: args => get('interviews', args),
    assets: args => get('assets', args),
    status: args => get('index/status', args), start: args => call('/boosty-rag/index/start', args),
    resume: args => call('/boosty-rag/index/resume', args), cancel: args => call('/boosty-rag/index/cancel', args),
    search: args => call('/boosty-rag/search', args), original: args => call('/boosty-rag/original', args),
    context: args => call('/boosty-rag/context', args) }
}

module.exports = { createBoostyRagClient }
