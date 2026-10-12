'use strict'

const { createBoostyRagClient } = require('./boosty-rag-client')
// Same protected loopback credential/protocol as saved-text RAG, never SQL,
// CLI secret handoff, forged extension Origin or a hidden worker fallback.
function createBoostyCatalogClient(options = {}) {
  const client = createBoostyRagClient(options)
  async function call(route, body) {
    try { return await client.call(route, body) }
    catch (e) {
      if (e.code === 'BOOSTY_APP_UPDATE_REQUIRED') throw Object.assign(new Error('The running SC Desktop app needs the public metadata catalogue API update; no fallback was used'), { code: 'BOOSTY_CATALOG_APP_UPDATE_REQUIRED' })
      throw e
    }
  }
  const get = (route, args) => call(`/boosty-catalog/${route}?${new URLSearchParams(Object.entries(args || {}).filter(([, v]) => v != null))}`)
  return { sources: args => get('sources', args), state: args => get('state', args), posts: args => get('posts', args),
    tiers: args => get('tiers', args), status: args => get('status', args),
    start: args => call('/boosty-catalog/start', args), cancel: args => call('/boosty-catalog/cancel', args),
    refreshTiers: args => call('/boosty-catalog/tiers/refresh', args) }
}
module.exports = { createBoostyCatalogClient }
