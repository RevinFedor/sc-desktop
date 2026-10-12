'use strict'

const { matchesBearerToken } = require('./local-notification-auth')
const { normalizeRequest, requestKey, fail } = require('./boosty-catalog-contract')

function createBoostyCatalogApi({ token, runner, read, readBody, sendJson }) {
  const submissions = new Map()
  async function checked(action, args) {
    const result = await read(action, args)
    if (!result?.ok) throw fail(result?.code || 'BOOSTY_CATALOG_READ_FAILED', result?.error || 'Public catalogue read failed')
    return result
  }
  async function exact(args) {
    const result = await checked('job', args)
    const live = runner.getJobDetail(result.job.db_id, { identity: 'db' })
    // Physical numeric IDs are reusable after restart. Require durable identity.
    if (live?.params?.public_job_id === result.job.job_id && live.type === 'boosty_channel_fetch') {
      result.job.status = live.status
      result.job.progress = live.boosty_channel || result.job.progress
      result.job.items_done = live.items_done
    }
    return result
  }
  async function start(body) {
    const params = normalizeRequest(body), key = requestKey(params)
    const pending = submissions.get(params.request_id)
    if (pending) {
      if (pending.key !== key) throw fail('BOOSTY_REQUEST_ID_CONFLICT', 'request_id already belongs to another catalogue scope')
      const receipt = await pending.promise
      return { ...receipt, job: (await exact({ job_id: receipt.job_id })).job, deduplicated: true }
    }
    const promise = (async () => {
      const existing = await read('job', { request_id: params.request_id })
      if (existing?.ok) {
        if (requestKey(normalizeRequest(existing.job.params)) !== key) throw fail('BOOSTY_REQUEST_ID_CONFLICT', 'request_id already belongs to another catalogue scope')
        return { ok: true, accepted: true, deduplicated: true, request_id: params.request_id,
          job_id: existing.job.job_id, job: (await exact({ job_id: existing.job.job_id })).job }
      }
      if (existing?.code !== 'BOOSTY_CATALOG_JOB_NOT_FOUND') throw fail(existing?.code || 'BOOSTY_CATALOG_READ_FAILED', 'Cannot verify the original catalogue receipt; no new job was started')
      const id = runner.startBoostyChannelFetch(params)
      const snapshot = runner.getJobDetail(id)
      if (snapshot?.params?.public_job_id !== params.public_job_id) throw fail('BOOSTY_CATALOG_ACK_UNKNOWN', 'Catalogue submission identity is unconfirmed; inspect request_id before retry')
      return { ok: true, accepted: true, deduplicated: false, request_id: params.request_id, job_id: params.public_job_id,
        job: { job_id: params.public_job_id, db_id: snapshot.dbRowId || snapshot.db_id || null,
          source_id: snapshot.source_id || null, type: snapshot.type, status: snapshot.status, progress: snapshot.boosty_channel } }
    })()
    submissions.set(params.request_id, { key, promise })
    try { return await promise }
    catch (e) { submissions.delete(params.request_id); throw e }
    finally { if (submissions.size > 1000) submissions.delete(submissions.keys().next().value) }
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/boosty-catalog/')) return false
    if (req.headers.origin) { sendJson(res, 403, { ok: false, code: 'BOOSTY_BROWSER_ORIGIN_REJECTED', error: 'Browser origins are not allowed' }); return true }
    if (!matchesBearerToken(req.headers.authorization, token)) { sendJson(res, 401, { ok: false, code: 'BOOSTY_LOCAL_AUTH_REQUIRED', error: 'Local bearer authentication required' }); return true }
    try {
      const args = Object.fromEntries(url.searchParams)
      if (req.method === 'GET' && url.pathname === '/boosty-catalog/capabilities') {
        sendJson(res, 200, { ok: true, version: 1, auth_mode: 'public', metadata_only: true,
          remote_credentials: false, media_or_thumbnails_or_asr_or_index: false, auto_clipboard: false,
          routes: ['POST /boosty-catalog/start', 'GET /boosty-catalog/status', 'POST /boosty-catalog/cancel',
            'GET /boosty-catalog/sources', 'GET /boosty-catalog/state', 'GET /boosty-catalog/posts',
            'GET /boosty-catalog/tiers', 'POST /boosty-catalog/tiers/refresh'],
          post_eof: 'explicit_extra_isLast_true', tiers_eof: 'explicit_nextId_null',
          nonnull_tiers_continuation: 'reported_partial_not_guessed', pagination: 'saved_snapshot_revision_guarded',
          account_entitlement_verified: false }); return true
      }
      if (req.method === 'POST' && ['/boosty-catalog/start', '/boosty-catalog/tiers/refresh'].includes(url.pathname)) {
        const body = await readBody(req, 32768)
        sendJson(res, 200, await start({ ...body, ...(url.pathname.endsWith('/refresh') ? { tiers_only: true } : {}) })); return true
      }
      if (req.method === 'GET' && url.pathname === '/boosty-catalog/status') {
        sendJson(res, 200, await exact(args)); return true
      }
      if (req.method === 'POST' && url.pathname === '/boosty-catalog/cancel') {
        const body = await readBody(req, 16384), result = await exact(body)
        if (body.source_id != null && Number(body.source_id) !== Number(result.job.source_id)) throw fail('BOOSTY_CATALOG_JOB_SOURCE_MISMATCH', 'Job and source do not match')
        const live = runner.getJobDetail(result.job.db_id, { identity: 'db' })
        const eligible = live?.params?.public_job_id === result.job.job_id && live.child && live.phase !== 'finalizing'
          && !['done', 'error', 'cancelled', 'interrupted'].includes(live.status)
        const cancelled = eligible ? runner.cancelJob(result.job.db_id, { identity: 'db', type: 'boosty_channel_fetch' }) : false
        sendJson(res, 200, { ok: true, cancel_requested: cancelled, job_id: result.job.job_id, job: result.job,
          ...(live?.phase === 'finalizing' ? { reason: 'metadata_commit_in_flight' } : {}) }); return true
      }
      const actions = { '/boosty-catalog/sources': 'sources', '/boosty-catalog/state': 'state', '/boosty-catalog/posts': 'posts', '/boosty-catalog/tiers': 'tiers' }
      if (req.method === 'GET' && actions[url.pathname]) { sendJson(res, 200, await checked(actions[url.pathname], args)); return true }
      sendJson(res, 404, { ok: false, code: 'BOOSTY_CATALOG_ROUTE_NOT_FOUND', error: 'Unknown public catalogue operation' })
    } catch (e) {
      sendJson(res, /CONFLICT|REVISION|ALREADY_RUNNING/.test(e.code || '') ? 409 : 400,
        { ok: false, code: e.code || 'BOOSTY_CATALOG_REQUEST_FAILED', error: e.code ? e.message : 'Public catalogue request failed' })
    }
    return true
  }
  return { handle, close: () => submissions.clear() }
}

module.exports = { createBoostyCatalogApi }
