'use strict'

const { matchesBearerToken } = require('./local-notification-auth')
const { normalizeSearch } = require('./boosty-rag')

// Local API owns all Boosty reads and jobs. MCP is an authenticated client,
// never a storage fallback or a forged extension-origin request.
function createBoostyRagApi({ token, database, indexJob, read, embedQuery, readBody, sendJson }) {
  const states = new Map(), receipts = new Map()
  const unsubscribe = indexJob.subscribe(job => {
    if (job.type !== 'boosty_index') return
    states.set(String(job.id), job)
    if (states.size > 500) states.delete(states.keys().next().value)
  })
  const fail = (code, message) => Object.assign(new Error(message), { code })
  async function readChecked(action, args) {
    const result = await read(action, args)
    if (!result?.ok) throw fail(result?.code || 'BOOSTY_RAG_ERROR', result?.error || 'Boosty saved-text reader failed')
    return result
  }
  function durableJob(id, requestId = null) {
    const db = database()
    const row = requestId != null ? db.getDb().prepare(`SELECT * FROM jobs WHERE type='boosty_index'
      AND json_valid(parameters_json) AND json_extract(parameters_json,'$.request_id')=? ORDER BY id DESC LIMIT 1`).get(requestId)
      : db.getDb().prepare(`SELECT * FROM jobs WHERE type='boosty_index' AND json_valid(parameters_json)
        AND json_extract(parameters_json,'$.public_job_id')=? ORDER BY id DESC LIMIT 1`).get(id)
    if (!row) return null
    const params = JSON.parse(row.parameters_json || '{}')
    return { id: params.public_job_id, db_id: row.id, type: row.type, source_id: row.source_id, status: row.status,
      items_done: row.items_done, items_total: row.items_total, error: row.error, started_at: row.started_at,
      finished_at: row.finished_at, params, unit: 'messages' }
  }
  function exact(id, sourceId = null) {
    const job = indexJob.getActiveSnapshot(id) || states.get(String(id)) || durableJob(id)
    if (!job || job.type !== 'boosty_index') throw fail('BOOSTY_INDEX_JOB_NOT_FOUND', 'Exact Boosty index job not found; no replacement was started')
    if (sourceId != null && Number(sourceId) !== Number(job.source_id)) throw fail('BOOSTY_INDEX_JOB_SOURCE_MISMATCH', 'Job and source_id do not match')
    return job
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/boosty-rag/')) return false
    if (req.headers.origin) { sendJson(res, 403, { ok: false, code: 'BOOSTY_BROWSER_ORIGIN_REJECTED', error: 'Browser origins are not allowed on the local RAG API' }); return true }
    if (!matchesBearerToken(req.headers.authorization, token)) { sendJson(res, 401, { ok: false, code: 'BOOSTY_LOCAL_AUTH_REQUIRED', error: 'Local bearer authentication is required' }); return true }
    try {
      const args = Object.fromEntries(url.searchParams)
      if (req.method === 'GET' && url.pathname === '/boosty-rag/capabilities') {
        sendJson(res, 200, { ok: true, version: 1, saved_text_only: true, download_or_asr: false,
          auth: 'originless_loopback_bearer_notification_bridge_token',
          routes: ['GET /boosty-rag/sources', 'GET /boosty-rag/interviews', 'GET /boosty-rag/assets', 'POST /boosty-rag/index/start',
            'POST /boosty-rag/index/resume', 'GET /boosty-rag/index/status', 'POST /boosty-rag/index/cancel',
            'POST /boosty-rag/search', 'POST /boosty-rag/original', 'POST /boosty-rag/context'],
          index_version: require('./boosty-rag-document').INDEX_VERSION, publication: 'atomic_whole_document',
          original_pagination: 'unicode_codepoints_hash_guarded', time_query_url_supported: false,
          saved_attachment_text: true, attachment_partial_or_filename_is_not_full_coverage: true })
        return true
      }
      if (req.method === 'GET' && url.pathname === '/boosty-rag/sources') {
        sendJson(res, 200, await readChecked('sources', args)); return true
      }
      if (req.method === 'GET' && url.pathname === '/boosty-rag/interviews') {
        sendJson(res, 200, await readChecked('interviews', args)); return true
      }
      if (req.method === 'GET' && url.pathname === '/boosty-rag/assets') {
        sendJson(res, 200, await readChecked('assets', args)); return true
      }
      if (req.method === 'GET' && url.pathname === '/boosty-rag/index/status') {
        const job = args.job_id ? exact(args.job_id, args.source_id) : indexJob.currentSnapshot(args.source_id, 'boosty')
        const id = args.source_id || job?.source_id
        const index = await readChecked('status', { source_id: id })
        sendJson(res, 200, { ok: true, source_id: Number(id), job_id: job?.id || null, job, index }); return true
      }
      if (req.method === 'POST' && ['/boosty-rag/index/start', '/boosty-rag/index/resume'].includes(url.pathname)) {
        const body = await readBody(req, 131072)
        if (typeof body.request_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(body.request_id)) throw fail('BOOSTY_REQUEST_ID_REQUIRED', 'A stable request_id (1..160 letters, digits, _ . : -) is required')
        const validated = await readChecked('validate', body)
        const key = JSON.stringify({ source_id: validated.source_id, limit: validated.limit, item_ids: validated.item_ids })
        const earlier = receipts.get(body.request_id)
        const persisted = durableJob(null, body.request_id)
        if (earlier || persisted) {
          const oldKey = earlier?.key || JSON.stringify({ source_id: persisted.source_id, limit: persisted.params.limit ?? null, item_ids: persisted.params.item_ids ?? null })
          if (oldKey !== key) throw fail('BOOSTY_REQUEST_ID_CONFLICT', 'This request_id already belongs to another index scope')
          const job = earlier ? exact(earlier.id) : persisted
          sendJson(res, 200, { ok: true, accepted: true, deduplicated: true, request_id: body.request_id, job_id: job.id, source_id: job.source_id, job }); return true
        }
        if (url.pathname.endsWith('/resume')) {
          if (!body.resume_of) throw fail('BOOSTY_RESUME_ID_REQUIRED', 'resume_of must be the exact interrupted/cancelled/error job_id')
          const old = exact(body.resume_of, validated.source_id)
          if (!['interrupted', 'cancelled', 'error'].includes(old.status)) throw fail('BOOSTY_RESUME_NOT_TERMINAL', 'Only interrupted, cancelled or error jobs can be resumed')
        }
        const job = indexJob.startTracked({ sourceId: validated.source_id, limit: validated.limit, itemIds: validated.item_ids,
          requestId: body.request_id, mode: 'boosty', origin: 'boosty-rag-application-api' })
        states.set(String(job.id), job)
        receipts.set(body.request_id, { key, id: job.id })
        sendJson(res, 200, { ok: true, accepted: true, request_id: body.request_id, job_id: job.id, source_id: job.source_id, job }); return true
      }
      if (req.method === 'POST' && url.pathname === '/boosty-rag/index/cancel') {
        const body = await readBody(req, 65536), job = exact(body.job_id, body.source_id)
        const cancelled = indexJob.cancelById(job.id)
        sendJson(res, 200, { ok: true, cancel_requested: cancelled, job_id: job.id, job }); return true
      }
      if (req.method === 'POST' && url.pathname === '/boosty-rag/search') {
        const body = await readBody(req, 65536)
        if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 10000) throw fail('BOOSTY_QUERY_REQUIRED', 'query must contain 1..10000 characters')
        normalizeSearch(body) // Reject invalid scope before a paid query embedding.
        const checked = body.source_ids || [body.source_id]
        for (const id of checked) await readChecked('validate', { source_id: id })
        const embedding = await embedQuery(body.query)
        sendJson(res, 200, await readChecked('search', { ...body, query_embedding: embedding })); return true
      }
      if (req.method === 'POST' && ['/boosty-rag/original', '/boosty-rag/context'].includes(url.pathname)) {
        const body = await readBody(req, 65536)
        sendJson(res, 200, await readChecked(url.pathname.endsWith('/context') ? 'context' : 'original', body)); return true
      }
      sendJson(res, 404, { ok: false, code: 'BOOSTY_RAG_ROUTE_NOT_FOUND', error: 'Unknown Boosty RAG operation' })
    } catch (e) {
      sendJson(res, /CONFLICT|CHANGED|RUNNING|SUPERSEDED/.test(e.code || '') ? 409 : 400,
        { ok: false, code: e.code || 'BOOSTY_RAG_REQUEST_ERROR', error: e.message })
    }
    return true
  }
  return { handle, close: unsubscribe }
}

module.exports = { createBoostyRagApi }
