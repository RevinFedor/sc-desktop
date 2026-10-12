'use strict'

const { randomUUID } = require('node:crypto')
const { createBoostyCatalogClient } = require('./boosty-catalog-client')
const positive = { type: 'integer', minimum: 1 }
const request = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,160}$' }
const author = { source_id: positive, handle: { type: 'string', minLength: 1, maxLength: 80 }, url: { type: 'string' } }
const choice = [{ required: ['source_id'] }, { required: ['handle'] }, { required: ['url'] }]
const make = (name, description, properties, required = [], readOnly = true, anyOf) => ({ name, description,
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true,
    openWorldHint: ['boosty_catalog_start', 'boosty_catalog_tiers_refresh'].includes(name) },
  inputSchema: { type: 'object', properties, required, additionalProperties: false, ...(anyOf ? { anyOf } : {}) } })
const start = { handle: author.handle, url: author.url, auth_mode: { const: 'public', default: 'public' }, request_id: request,
  limit: { type: 'integer', minimum: 0, maximum: 100000 }, order: { enum: ['asc', 'desc'] },
  from_ts: positive, to_ts: positive, tags: { type: 'array', items: positive, maxItems: 100 }, only_allowed: { type: 'boolean' },
  page_size: { type: 'integer', minimum: 1, maximum: 100 }, max_pages: { type: 'integer', minimum: 1, maximum: 10000 } }
const boostyCatalogTools = [
  make('boosty_catalog_start', 'Start an ANONYMOUS public Boosty metadata catalogue, including public titles/dates/minimum tiers of locked posts. No cookies/account fallback, bodies/media/thumbnails/ASR/index/clipboard. limit=0 unfiltered plus explicit upstream isLast proves visible-feed EOF, not hidden-content access. Save returned request_id/job_id; accepted is not complete.', start, [], false, [{ required: ['handle'] }, { required: ['url'] }]),
  make('boosty_catalog_status', 'Read ONE exact durable public catalogue receipt and live progress. After restart an interrupted job remains the same receipt; no remote fetch or replacement is started.', {
    job_id: { type: 'string' }, request_id: request }, [], true, [{ required: ['job_id'] }, { required: ['request_id'] }]),
  make('boosty_catalog_cancel', 'Request cancellation of the exact public metadata catalogue job only. Final cancellation waits for worker exit and persistence; earlier complete coverage and account transcripts remain.', { job_id: { type: 'string' } }, ['job_id'], false),
  make('boosty_catalog_sources', 'Discover saved Boosty authors with PUBLIC catalogue scope/last complete proof and tiers state. Account RAG coverage/entitlement is different. No remote sync.', {
    limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 } }),
  make('boosty_catalog_state', 'Read public catalogue scope, honest EOF/partial reason and timestamps for one source. Historical complete proof is separate from the latest filtered/interrupted pass; browser account entitlement is not asserted.', author, [], true, choice),
  make('boosty_catalog_posts', 'Read paged saved public metadata: latest feed pass or known union, separate declared counts vs exposed child IDs/durations, no bodies/player URLs. Continue with SAME expected_catalog_revision to avoid mixed snapshots after refresh.', {
    ...author, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 },
    view: { enum: ['latest', 'known'] }, expected_catalog_revision: { type: 'string' } }, [], true, choice),
  make('boosty_catalog_tiers', 'Read all SAVED exposed public tier rows and explicit completeness/empty/unavailable state, per-currency prices, archived/deleted flags. Billing period is unknown unless explicitly exposed; no purchase or entitlement inference.', author, [], true, choice),
  make('boosty_catalog_tiers_refresh', 'Start a new anonymous metadata-only tiers discovery job for an author. Does not re-read posts or download anything; explicit nextId=null is EOF, other continuation remains honestly partial. Save exact request_id/job_id.', {
    handle: author.handle, url: author.url, auth_mode: { const: 'public', default: 'public' }, request_id: request }, [], false, [{ required: ['handle'] }, { required: ['url'] }]),
]
const boostyCatalogOperations = { boosty_catalog_start: 'start', boosty_catalog_status: 'status', boosty_catalog_cancel: 'cancel',
  boosty_catalog_sources: 'sources', boosty_catalog_state: 'state', boosty_catalog_posts: 'posts', boosty_catalog_tiers: 'tiers', boosty_catalog_tiers_refresh: 'refreshTiers' }
let client
async function callBoostyCatalogTool(name, args = {}, suppliedClient = null) {
  const operation = boostyCatalogOperations[name]
  if (!operation) throw new Error('Unknown public Boosty catalogue tool')
  const input = { ...args }
  if (['start', 'refreshTiers'].includes(operation)) {
    input.auth_mode ??= 'public'
    input.request_id ??= `boosty-catalog-mcp-${randomUUID()}`
  }
  try {
    const out = await (suppliedClient || (client ||= createBoostyCatalogClient()))[operation](input)
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
  } catch (e) {
    const unknown = !e.code || e.code === 'BOOSTY_CATALOG_ACK_UNKNOWN'
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code: e.code || 'BOOSTY_CATALOG_TRANSPORT_UNCONFIRMED',
      error: e.message, ...(input.request_id ? { request_id: input.request_id, delivery_unknown: unknown,
        recovery: 'Read boosty_catalog_status with this request_id. Retry only the unchanged request/key, never launch a replacement blindly.' } : {}) }) }] }
  }
}
module.exports = { boostyCatalogTools, boostyCatalogOperations, callBoostyCatalogTool }
