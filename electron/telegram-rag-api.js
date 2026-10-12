'use strict'

// Origin-less loopback Application API. Jobs belong to the running Electron
// process and use its existing Activity/Cancel subscriptions, never a hidden
// second MCP indexer/fetch process.
function createTelegramRagApi({ jobRunner, indexJob, database, readBody, sendJson,
  storageCheck = (directory, minFreeBytes) => require('./telegram-media-storage-check').checkTelegramMediaStorageAsync(directory, minFreeBytes),
  storageChecks = () => require('./telegram-media-storage-check').pendingTelegramMediaStorageChecks(),
  guardCandidates = args => require('./database-read-client').request('telegramRagGuardCandidates', args) }) {
  const states = new Map()
  const fetchControl = require('./telegram-fetch-control').createTelegramFetchControl({ database, jobRunner })
  const unsubscribe = indexJob.subscribe(job => {
    states.set(String(job.id), job)
    if (states.size > 200) states.delete(states.keys().next().value)
  })
  const sourceId = value => {
    const id = Number(value)
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('source_id is required')
    const source = database().getSource(id)
    if (!source || source.platform !== 'telegram') throw new Error('Telegram source not found')
    return id
  }
  const exactJob = (requested, suppliedSource) => {
    const job = indexJob.getActiveSnapshot(requested) || states.get(String(requested))
    if (!job) throw Object.assign(new Error('Index job not known to this app run; read status by source_id after a restart'), { code: 'INDEX_JOB_NOT_FOUND' })
    if (suppliedSource != null && sourceId(suppliedSource) !== Number(job.source_id)) {
      throw Object.assign(new Error('Index job and source_id do not match'), { code: 'INDEX_JOB_SOURCE_MISMATCH' })
    }
    return job
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/telegram-rag/')) return false
    if (req.headers.origin) { sendJson(res, 403, { ok: false, error: 'browser origins are not allowed' }); return true }
    try {
      if (req.method === 'GET' && url.pathname === '/telegram-rag/jobs/active') {
        const jobs = jobRunner.listJobs().filter(job => ['pending', 'running', 'cancelling', 'awaiting_ai'].includes(job.status))
        const indices = indexJob.listActiveSnapshots()
        // History windows in listJobs are bounded. Include every active durable
        // row too, so an old/unacknowledged reservation cannot look like idle.
        const durable = database().getDb().prepare(`SELECT id,type,source_id,status,items_done,items_total,started_at,
          CASE WHEN json_valid(parameters_json) THEN json_extract(parameters_json,'$.request_id') END AS request_id
          FROM jobs WHERE status IN ('pending','running','cancelling','awaiting_ai') ORDER BY id`).all()
        sendJson(res, 200, { ok: true, scope: 'main_application_all_job_types', enumeration_complete: true, jobs, indices,
          durable_scope: 'all_persisted_job_types_unbounded', durable_enumeration_complete: true,
          durable_jobs: durable.map(row => ({ ...row, db_id: row.id,
            ...(row.type === 'tg_fetch' && row.request_id ? { job_id: `fetch:${row.request_id}` } : {}) })),
          durable_active_count: durable.length, storage_checks: storageChecks(), storage_enumeration_complete: true })
        return true
      }
      if (req.method === 'GET' && url.pathname === '/telegram-rag/fetch/capabilities') {
        sendJson(res, 200, { ok: true, version: 1, ...jobRunner.telegramFetchCapabilities() })
        return true
      }
      if (req.method === 'POST' && url.pathname === '/telegram-rag/fetch/storage-check') {
        const body = await readBody(req, 65536)
        sendJson(res, 200, { ok: true, ...(await storageCheck(body.directory, body.min_free_bytes)) })
        return true
      }
      if (req.method === 'GET' && url.pathname === '/telegram-rag/fetch/status') {
        sendJson(res, 200, fetchControl.status(url.searchParams.get('request_id')))
        return true
      }
      if (req.method === 'GET' && url.pathname === '/telegram-rag/fetch/candidates') {
        const id = sourceId(url.searchParams.get('source_id'))
        const afterItemId = Number(url.searchParams.get('after_item_id') || 0)
        const limit = Number(url.searchParams.get('limit') || 500)
        const maxDurationSec = Number(url.searchParams.get('max_duration_sec') || 1200)
        const voiceTypes = url.searchParams.has('voice_types') ? url.searchParams.get('voice_types').split(',') : ['voice', 'audio']
        sendJson(res, 200, { ok: true, ...require('./telegram-fetch-policy').telegramMediaCandidates(database(), {
          sourceId: id, afterItemId, limit, maxDurationSec, voiceTypes }) })
        return true
      }
      if (req.method === 'POST' && url.pathname === '/telegram-rag/fetch/cancel') {
        const body = await readBody(req, 65536)
        sendJson(res, 200, fetchControl.cancel(body.request_id))
        return true
      }
      if (req.method === 'POST' && url.pathname === '/telegram-rag/fetch/resume') {
        const body = await readBody(req, 65536)
        if(body.skip_unknown_media!=null&&typeof body.skip_unknown_media!=='boolean')throw new Error('skip_unknown_media must be boolean')
        sendJson(res, 200, fetchControl.resume(body.request_id, body.resume_id, {skipUnknownMedia:body.skip_unknown_media===true}))
        return true
      }
      if (req.method === 'POST' && url.pathname === '/telegram-rag/fetch/asr-state') {
        const body=await readBody(req,65536)
        sendJson(res,200,await fetchControl.asrCheckpoint(body.request_id))
        return true
      }
      if (req.method === 'POST' && url.pathname === '/telegram-rag/fetch/asr-adopt-file') {
        const body=await readBody(req,65536)
        if(!Number.isSafeInteger(body.message_id)||body.message_id<1||typeof body.file_id!=='string'||
          !/^[A-Za-z0-9-]{1,128}$/.test(body.file_id)||!/^[0-9a-f]{64}$/.test(body.expected_checkpoint_hash||''))throw new Error('Exact message/file/checkpoint hash required')
        sendJson(res,200,await fetchControl.asrCheckpoint(body.request_id,'adopt_file',{
          message_id:body.message_id,file_id:body.file_id,expected_checkpoint_hash:body.expected_checkpoint_hash}))
        return true
      }
      if (req.method === 'GET' && url.pathname === '/telegram-rag/index/guards') {
        const id = sourceId(url.searchParams.get('source_id'))
        const after = Number(url.searchParams.get('after_item_id') || 0)
        const limit = Number(url.searchParams.get('limit') || 500)
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
          throw new Error('Guard audit requires after_item_id>=0 and limit 1..1000')
        }
        const audit = await guardCandidates({ sourceId: id, afterItemId: after, limit })
        sendJson(res, 200, { ok: true, source_id: id, ...audit })
        return true
      }
      if (req.method === 'GET' && url.pathname === '/telegram-rag/index/list') {
        const sid = url.searchParams.get('source_id')
        const id = sid ? sourceId(sid) : null
        const jobs = indexJob.listActiveSnapshots()
          .filter(job => job.type === 'tg_index' && (id == null || Number(job.source_id) === id))
        sendJson(res, 200, { ok: true, jobs })
        return true
      }
      if (req.method === 'POST' && url.pathname === '/telegram-rag/index/start') {
        const body = await readBody(req, 2 * 1024 * 1024)
        const id = sourceId(body.source_id)
        if (body.limit != null && (typeof body.limit !== 'number' || !Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 200000)) {
          throw Object.assign(new Error('Explicit index limit must be an integer from 1 to 200000; omit it for full index'), { code: 'INVALID_INDEX_LIMIT' })
        }
        if (body.item_ids != null && (!Array.isArray(body.item_ids) || !body.item_ids.length || body.item_ids.length > 5000 ||
            body.item_ids.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0))) {
          throw Object.assign(new Error('item_ids must contain 1..5000 positive local item IDs'), { code: 'INVALID_INDEX_SELECTION' })
        }
        if (body.item_ids != null) {
          const unique = [...new Set(body.item_ids)]
          const matched = database().getDb().prepare(`SELECT COUNT(*) AS n FROM items WHERE source_id = ? AND id IN (${unique.map(() => '?').join(',')})`).get(id, ...unique).n
          if (matched !== unique.length) throw Object.assign(new Error('Every selected local item must belong to this Telegram source'), { code: 'INDEX_SELECTION_SOURCE_MISMATCH' })
        }
        const started = indexJob.startTracked({ sourceId: id, limit: body.limit ?? null, itemIds: body.item_ids ?? null, origin: 'mcp-application-api' })
        states.set(String(started.id), started)
        sendJson(res, 200, { ok: true, accepted: true, job_id: started.id, source_id: id, job: started })
        return true
      }
      if (req.method === 'GET' && url.pathname === '/telegram-rag/index/status') {
        const requested = url.searchParams.get('id')
        const sid = url.searchParams.get('source_id')
        let job = requested ? exactJob(requested, sid) : null
        const id = sid ? sourceId(sid) : job?.source_id
        if (!id) throw new Error('source_id or known index job id is required')
        job = job || indexJob.currentSnapshot(id)
        const index = job?.status === 'running' ? {
          ...job, state: 'running', done: job.items_done || 0,
          total: job.items_total || null, jobId: job.id, unit: job.unit || 'messages',
        } : await indexJob.statusForSource(id)
        sendJson(res, 200, { ok: true, source_id: id, job_id: requested || job?.id || null, job, index })
        return true
      }
      if (req.method === 'POST' && url.pathname === '/telegram-rag/index/cancel') {
        const body = await readBody(req, 2 * 1024 * 1024)
        if (body.job_id != null) exactJob(body.job_id, body.source_id)
        const ok = body.job_id != null ? indexJob.cancelById(body.job_id) : indexJob.cancel(sourceId(body.source_id))
        sendJson(res, 200, { ok, job_id: body.job_id || null })
        return true
      }
      if (req.method === 'POST' && url.pathname === '/telegram-rag/fetch/start') {
        const body = await readBody(req, 2 * 1024 * 1024)
        const params = body.params
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('fetch params are required')
        if (!['last_n', 'all', 'from_date', 'sync_new', 'single', 'media_only', 'id_list'].includes(params.mode)) throw new Error('unsupported fetch mode')
        if (typeof params.target !== 'string' || !params.target.trim()) throw new Error('one fetch target is required')
        const ids = ['source_id', 'source_id_hint', '_source_id'].filter(key => params[key] != null).map(key => sourceId(params[key]))
        if (new Set(ids).size > 1) throw new Error('Fetch source aliases must identify the same Telegram source')
        sendJson(res, 200, fetchControl.start(params))
        return true
      }
      sendJson(res, 404, { ok: false, error: 'unknown Telegram RAG route' })
    } catch (error) {
      sendJson(res, 400, { ok: false, code: error.code || 'telegram_rag_request_error', error: error.message,
        existing_job_id: error.existing_job_id || error.jobId || null,
        ...(error.request_id ? { request_id: error.request_id, job_id: error.job_id, accepted: error.accepted === true } : {}),
        ...(error.recovery_reason ? { recovery_reason: error.recovery_reason } : {}),
        ...(error.storage_check ? { storage_check: error.storage_check } : {}) })
    }
    return true
  }
  return { handle, close: unsubscribe }
}

module.exports = { createTelegramRagApi }
