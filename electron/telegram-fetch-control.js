'use strict'

const crypto = require('node:crypto')
const { validateTelegramFetchPolicy } = require('./telegram-fetch-policy')
const { mcpJobParams } = require('./clipboard-policy')
const ACTIVE = new Set(['pending', 'running', 'cancelling', 'awaiting_ai'])
const RESUMABLE = new Set(['error', 'cancelled', 'interrupted'])
const INTERNAL = new Set(['_reserved_job_row_id', '_fetch_request_hash', '_fetch_request_input', '_fetch_launch_unknown', '_fetch_history_request_id', '_fetch_report', '_error_code', '_runtime_source', '_asr_checkpoint_probe'])

function requestKey(value, name = 'request_id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw Object.assign(new Error(`${name} must be a stable 1..128 character key`), { code: 'INVALID_FETCH_REQUEST_ID' })
  }
  return value
}

function payloadHash(params) {
  const omit = new Set(['request_id', ...INTERNAL, '_runtime_source', '_fetch_report'])
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    return value
  }
  return crypto.createHash('sha256').update(JSON.stringify(stable(Object.fromEntries(Object.entries(params).filter(([key]) => !omit.has(key)))))).digest('hex')
}

function createTelegramFetchControl({ database, jobRunner }) {
  const db = () => database()
  const liveIds = new Map()
  function rowFor(requestId) {
    return db().getDb().prepare(`SELECT * FROM jobs WHERE type='tg_fetch'
      AND json_valid(parameters_json) AND json_extract(parameters_json,'$.request_id')=? ORDER BY id LIMIT 1`).get(requestId)
  }
  function status(requestId) {
    requestKey(requestId)
    const row = rowFor(requestId)
    if (!row) throw Object.assign(new Error('Fetch request not found'), { code: 'FETCH_REQUEST_NOT_FOUND' })
    const params = JSON.parse(row.parameters_json || '{}')
    let live = null
    const belongs = job => Number.isSafeInteger(job?.id) && job.type === 'tg_fetch' &&
      job.params?.request_id === requestId && job.params?._fetch_request_hash === params._fetch_request_hash &&
      (Number(job.db_id) === row.id || Number(job.params?._reserved_job_row_id) === row.id)
    if (liveIds.has(requestId)) {
      const candidate = jobRunner.getJobDetail(liveIds.get(requestId))
      if (belongs(candidate)) live = candidate
    }
    if (!live && typeof jobRunner.listJobs === 'function') {
      for (const view of jobRunner.listJobs()) {
        if (view.type !== 'tg_fetch' || !Number.isSafeInteger(view.id)) continue
        const candidate = jobRunner.getJobDetail(view.id)
        if (belongs(candidate)) { live = candidate; break }
      }
    }
    let job = live && ACTIVE.has(row.status) ? { ...live, db_id: row.id } : jobRunner.getJobDetail(`db-${row.id}`)
    if (!job || job.params?.request_id !== requestId || (!live && ACTIVE.has(job.status))) job = {
      id: `db-${row.id}`, db_id: row.id, source_id: row.source_id, type: row.type,
      status: row.status, items_done: row.items_done, items_total: row.items_total,
      error: row.error, params, fetch_report: params._fetch_report || null,
    }
    // A live terminal event alone is not a durable completion acknowledgement.
    if (ACTIVE.has(row.status) && !ACTIVE.has(job.status)) job = { ...job, status: row.status }
    const mediaError = params._error_code === 'media_delivery_unknown' || job.error_code === 'media_delivery_unknown'
    const probe = params._asr_checkpoint_probe
    const originalBlocked = String(params._media_phase?.voice?.current?.msg_id || job.media_phase?.voice?.current?.msg_id || '')
    const freshProbe = probe && probe.payload_hash === params._fetch_request_hash && Number.isSafeInteger(probe.checked_at_ms) &&
      Date.now()>=probe.checked_at_ms && Date.now()-probe.checked_at_ms <= 300000 && probe.result?.items?.some(item=>String(item.message_id)===originalBlocked)
    const reconciledBlocked = freshProbe && probe.result.items.find(item=>String(item.message_id)===originalBlocked)
    const unknownMediaDelivery = mediaError && !(reconciledBlocked && !reconciledBlocked.unknown &&
      (reconciledBlocked.completed || reconciledBlocked.has_file_id || reconciledBlocked.has_transcription_id))
    // A generic restart recovery can relabel a row interrupted/error without
    // proving whether a post-spawn launch happened. Only the original runner's
    // authoritative params persistence can clear this unknown-outcome fence.
    const unknownLaunch = params._fetch_launch_unknown === true
    return { ok: true, request_id: requestId, job_id: `fetch:${requestId}`, db_job_id: row.id,
      accepted: true, job, can_resume: RESUMABLE.has(row.status) && !ACTIVE.has(live?.status) && !unknownMediaDelivery && !unknownLaunch,
      completion_is_persisted: row.status === 'done' && !unknownLaunch, persisted_status: row.status,
      launch_outcome: unknownLaunch ? 'unknown' : live ? 'live' : 'persisted',
      recovery_reason: unknownMediaDelivery ? 'media_delivery_unknown' : unknownLaunch ? 'fetch_launch_outcome_unknown' : null,
      fetch_report: params._fetch_report || null,
      media_recovery: freshProbe ? probe.result : null,
      can_resume_partial: !!(unknownMediaDelivery && !unknownLaunch && RESUMABLE.has(row.status) && !ACTIVE.has(live?.status) &&
        params.mode==='id_list' && freshProbe && probe.result.safe_message_ids?.length) }
  }
  function start(input, { resumeOf = null, historyRequestId = null, partialResume = false } = {}) {
    for (const key of INTERNAL) {
      if (Object.hasOwn(input || {}, key)) throw Object.assign(new Error(`Server-owned fetch field is not accepted: ${key}`), { code: 'INVALID_FETCH_RESERVED_FIELD' })
    }
    const params = validateTelegramFetchPolicy(input)
    if (params.profile && !params.session && !params._tg_session_override) params.session = params.profile
    delete params.profile
    if (!params.request_id) {
      const id = jobRunner.startTelegramFetch(mcpJobParams(params))
      return { ok: true, job_id: `desktop:${id}`, desktop_job_id: id, job: jobRunner.getJobDetail(id) }
    }
    params._fetch_history_request_id = requestKey(historyRequestId || params.request_id)
    const hash = payloadHash(params)
    const reserved = db().getDb().transaction(() => {
      const existing = rowFor(params.request_id)
      if (existing) {
        const old = JSON.parse(existing.parameters_json || '{}')
        if (old._fetch_request_hash !== hash) throw Object.assign(new Error('request_id already belongs to another fetch payload'), { code: 'FETCH_REQUEST_PAYLOAD_MISMATCH' })
        return { id: existing.id, reused: true }
      }
      if (resumeOf != null) {
        const original = rowFor(resumeOf)
        const originalStatus = original ? status(resumeOf) : null
        if (originalStatus?.recovery_reason === 'media_delivery_unknown' && !(partialResume && originalStatus.can_resume_partial)) throw Object.assign(new Error('Unknown ASR delivery must be reconciled before resume'), {
          code: 'FETCH_RESUME_MEDIA_DELIVERY_UNKNOWN', recovery_reason: 'media_delivery_unknown', existing_job_id: `fetch:${resumeOf}` })
        if (!original || !RESUMABLE.has(original.status) || !(originalStatus.can_resume || partialResume && originalStatus.can_resume_partial)) {
          throw Object.assign(new Error('Only a confirmed terminal failed/cancelled/interrupted fetch can resume'), { code: 'FETCH_RESUME_NOT_TERMINAL' })
        }
        const sibling = db().getDb().prepare(`SELECT id FROM jobs WHERE type='tg_fetch'
          AND status IN ('pending','running','cancelling','awaiting_ai') AND json_valid(parameters_json)
          AND json_extract(parameters_json,'$.resume_of')=? ORDER BY id LIMIT 1`).get(resumeOf)
        if (sibling) throw Object.assign(new Error('A resume of this original fetch is already active'), {
          code: 'FETCH_RESUME_ALREADY_ACTIVE', existing_job_id: `db-${sibling.id}` })
      }
      const immutableInput = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(params).filter(([key]) => !INTERNAL.has(key) && !['_runtime_source', '_fetch_report'].includes(key)))))
      const id = db().recordJob({ type: 'tg_fetch', source_id: params.source_id_hint || params._source_id || null,
        status: 'running', items_done: 0, items_total: null, started_at: Math.floor(Date.now() / 1000),
        params: { ...params, _fetch_request_hash: hash, _fetch_request_input: immutableInput } })
      return { id, reused: false }
    }).immediate()
    if (reserved.reused) return { ...status(params.request_id), idempotent: true }
    try {
      const stored = JSON.parse(rowFor(params.request_id).parameters_json)
      const desktopId = jobRunner.startTelegramFetch(mcpJobParams({ ...stored, _reserved_job_row_id: reserved.id }))
      const live = jobRunner.getJobDetail(desktopId)
      if (!Number.isSafeInteger(desktopId) || live?.type !== 'tg_fetch' || live.params?.request_id !== params.request_id ||
          live.params?._fetch_request_hash !== hash ||
          (Number(live.db_id) !== reserved.id && Number(live.params?._reserved_job_row_id) !== reserved.id)) {
        throw Object.assign(new Error('Runner did not acknowledge the reserved fetch identity'), { code: 'FETCH_RUNNER_RESERVATION_MISMATCH' })
      }
      liveIds.set(params.request_id, desktopId)
      return { ...status(params.request_id), desktop_job_id: desktopId, idempotent: false }
    } catch (error) {
      const current = rowFor(params.request_id)
      if (ACTIVE.has(current.status)) {
        if (error.pre_spawn === true) {
          db().updateJob(reserved.id, { status: 'error', error: error.message, finished_at: Math.floor(Date.now() / 1000) })
        } else {
          db().updateJob(reserved.id, { error: error.message,
            params: { ...JSON.parse(current.parameters_json), _fetch_launch_unknown: true } })
          error.code = 'FETCH_START_OUTCOME_UNKNOWN'
        }
      }
      error.request_id = params.request_id
      error.job_id = `fetch:${params.request_id}`
      error.accepted = true
      throw error
    }
  }
  function resume(requestId, resumeId, { skipUnknownMedia = false } = {}) {
    requestKey(requestId)
    requestKey(resumeId, 'resume_id')
    if (requestId === resumeId) throw Object.assign(new Error('resume_id must be different from the original request_id'), { code: 'INVALID_FETCH_RESUME_ID' })
    const originalStatus = status(requestId)
    const persisted = JSON.parse(rowFor(requestId).parameters_json)
    const params = { ...(persisted._fetch_request_input || persisted), request_id: resumeId, resume_of: requestId,
      reuse_transcripts: true, redo_processed: false }
    delete params._fetch_report
    for (const key of INTERNAL) delete params[key]
    if (skipUnknownMedia) {
      if (!originalStatus.can_resume_partial) throw Object.assign(new Error('A fresh authoritative per-media probe is required for partial resume'),{code:'ASR_PARTIAL_RESUME_NOT_PROVEN'})
      const safe = new Set(originalStatus.media_recovery.safe_message_ids)
      params.message_ids = params.message_ids.filter(id=>safe.has(id))
      params.resume_quarantined_message_ids = originalStatus.media_recovery.blocked_message_ids
    }
    // Full traversal starts at head again; completed ASR checkpoints are reused.
    // We do not claim an uncommitted metadata cursor was persisted after crash.
    return { ...start(params, { resumeOf: requestId, historyRequestId: persisted._fetch_history_request_id || requestId, partialResume:skipUnknownMedia }),
      resume_mode: skipUnknownMedia ? 'original_media_scope_quarantine_unknown_reuse_completed' : 'restart_traversal_reuse_completed_transcripts' }
  }
  async function asrCheckpoint(requestId, action = 'inspect', adoption = {}) {
    const original = status(requestId), row = rowFor(requestId), params = JSON.parse(row.parameters_json)
    if (ACTIVE.has(row.status) || params._fetch_launch_unknown || params.mode!=='id_list' || !params.process_voice ||
      !Array.isArray(params.message_ids) || !params.message_ids.length || params.transcribe_engine!=='soniox') {
      throw Object.assign(new Error('ASR probe requires a confirmed terminal, explicitly scoped Soniox id-list request'),{code:'ASR_RECOVERY_SCOPE_REQUIRED'})
    }
    const blocked = Number(params._media_phase?.voice?.current?.msg_id || original.job.media_phase?.voice?.current?.msg_id)
    const originallyUncertain = params._error_code==='media_delivery_unknown' || original.job.error_code==='media_delivery_unknown'
    if (originallyUncertain && !params.message_ids.includes(blocked)) {
      throw Object.assign(new Error('Original uncertain media identity is unavailable'),{code:'ASR_UNKNOWN_MESSAGE_SCOPE'})
    }
    const input={action,original_request_id:requestId,message_ids:params.message_ids,
      originally_blocked_ids:originallyUncertain?[blocked]:[],
      started_at:row.started_at,finished_at:row.finished_at || Math.floor(Date.now()/1000),...adoption}
    const result = await jobRunner.runTelegramAsrCheckpointCommand(input,params)
    const inspected = action==='inspect' ? result : await jobRunner.runTelegramAsrCheckpointCommand({...input,action:'inspect'},params)
    const expected=new Set(params.message_ids),items=inspected.items
    if(inspected.ok!==true||!Array.isArray(items)||items.length!==expected.size||new Set(items.map(i=>i.message_id)).size!==expected.size||
      items.some(i=>!expected.has(i.message_id)||typeof i.unknown!=='boolean')||
      JSON.stringify([...inspected.safe_message_ids].sort((a,b)=>a-b))!==JSON.stringify(items.filter(i=>!i.unknown).map(i=>i.message_id).sort((a,b)=>a-b))||
      JSON.stringify([...inspected.blocked_message_ids].sort((a,b)=>a-b))!==JSON.stringify(items.filter(i=>i.unknown).map(i=>i.message_id).sort((a,b)=>a-b))) {
      throw Object.assign(new Error('ASR checkpoint result does not match the exact original media scope'),{code:'ASR_CHECKPOINT_SCOPE_MISMATCH'})
    }
    const current = rowFor(requestId), freshParams=JSON.parse(current.parameters_json)
    if (freshParams._fetch_request_hash !== params._fetch_request_hash || ACTIVE.has(current.status)) {
      throw Object.assign(new Error('Original request changed during ASR inspection'),{code:'ASR_ORIGINAL_CHANGED'})
    }
    db().updateJob(row.id,{params:{...freshParams,_asr_checkpoint_probe:{payload_hash:params._fetch_request_hash,checked_at_ms:Date.now(),result:inspected}}})
    return {...status(requestId),asr_checkpoint:inspected,adoption_result:action==='adopt_file'?result:null}
  }
  function cancel(requestId) {
    const original = status(requestId)
    if (!ACTIVE.has(original.persisted_status)) return { ...original, cancel_requested: false, already_terminal: true }
    const requested = jobRunner.cancelJob(original.db_job_id, { identity: 'db', type: 'tg_fetch' })
    return { ...status(requestId), cancel_requested: requested === true,
      ...(requested ? {} : { cancel_reason: 'no_live_worker_for_this_durable_row' }) }
  }
  return { start, status, resume, cancel, asrCheckpoint }
}

module.exports = { createTelegramFetchControl, payloadHash }
