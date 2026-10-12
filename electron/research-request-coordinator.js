const { assertSameResearchRequest } = require('./research-request-identity')

function requestError(code, message, statusCode = 503) {
  const error = new Error(message)
  Object.assign(error, { code, statusCode })
  return error
}

function restoreResearchRequest(state, saved) {
  if (!saved) return null
  const current = state.get(saved.id)
  if (current) return current
  const metadata = saved.requestMetadata || {}
  state.create({
    id: saved.id, provider: saved.provider, prompt: saved.prompt || '',
    options: metadata.options, attachments: metadata.attachments,
    requestFingerprint: saved.requestFingerprint,
  })
  return state.update(saved.id, {
    ...metadata, status: saved.status, stage: saved.stage,
    url: saved.url, title: metadata.title || null, error: saved.error,
    result: saved.result, createdAt: saved.createdAt,
    doneAt: saved.doneAt, recovered: true,
  })
}

// One requestId identifies one immutable attempt, never a conversation.
// The durable 'opening' record precedes the browser side effect. A missing
// browser tab after a restart cannot prove that the paid request never ran.
function createResearchRequestCoordinator({ state, load, save, prepare, open, find, packing }) {
  const inFlight = new Map()

  function snapshot(job, extra = {}) {
    return {
      ...state.publicSnapshot(job),
      attachmentPacking: packing(job.attachments || []),
      ...extra,
    }
  }

  async function recover(job) {
    if (job.status === 'done' || job.status === 'error') return job
    if (job.dispatchState === 'prepared') return dispatch(job)
    let found
    try { found = await find(job.targetUrl) } catch (cause) {
      throw requestError('research_start_recovery_unavailable',
        `Cannot recover the existing browser request: ${cause.message || cause}`)
    }
    if (found?.success === false) {
      throw requestError('research_start_recovery_unavailable',
        found.error || 'The extension could not check the existing request')
    }
    // An update received while finding the tab is newer evidence than the
    // restored snapshot. Never overwrite its result with a recovery outcome.
    const latest = state.get(job.id)
    if (latest !== job) return latest
    if (Number.isInteger(found?.tabId)) {
      const recovered = state.update(job.id, {
        tabId: found.tabId, url: found.url || job.url,
        dispatchState: 'opened', recovered: true,
      })
      save(recovered)
      return recovered
    }
    const unknown = state.update(job.id, {
      status: 'error', stage: 'delivery_unknown', dispatchState: 'delivery_unknown',
      error: 'The previous browser request cannot be located. It may already have been sent; no duplicate was created.',
    })
    save(unknown)
    return unknown
  }

  async function dispatch(job) {
    const opening = state.update(job.id, { dispatchState: 'opening', stage: 'opening' })
    try { save(opening) } catch (error) {
      state.update(job.id, { dispatchState: 'prepared', stage: 'prepared' })
      throw requestError('research_request_persistence_failed', error.message || String(error))
    }
    const result = await open(job.targetUrl, job.id)
    const latest = state.get(job.id)
    const patch = {}
    if (Number.isInteger(result.tabId)) patch.tabId = result.tabId
    if (latest.status !== 'done' && latest.status !== 'error') {
      patch.dispatchState = result.openState === 'failed' ? 'failed'
        : result.openState === 'delivery_unknown' ? 'delivery_unknown' : 'opened'
      if (result.openState === 'failed') {
        patch.status = 'error'
        patch.stage = 'open_failed'
        patch.error = result.openError || 'The browser request could not be opened'
      }
    }
    const updated = state.update(job.id, patch)
    save(updated)
    return { job: updated, open: result }
  }

  async function execute(input) {
    let existing = state.get(input.id)
    const saved = existing?.requestFingerprint ? null : load(input.id)
    if (!existing && saved) existing = restoreResearchRequest(state, saved)
    if (existing) {
      // A content-script may recreate a RAM stub before this caller arrives.
      // Recover identity only from the durable original request, not from
      // the caller's new payload.
      const fingerprint = existing.requestFingerprint || saved?.requestFingerprint
      assertSameResearchRequest(fingerprint, input.requestFingerprint)
      if (!existing.requestFingerprint && saved?.requestMetadata) {
        existing = state.update(existing.id, {
          ...saved.requestMetadata, prompt: saved.prompt || '',
          requestFingerprint: fingerprint,
        })
      }
      if ((existing.recovered || existing.dispatchState === 'prepared') && existing.status !== 'done' && existing.status !== 'error') {
        const recovered = await recover(existing)
        return snapshot(recovered.job || recovered, { openState: 'reconciled', idempotent: true })
      }
      return snapshot(existing, { openState: 'existing', idempotent: true })
    }

    let attachments
    try { attachments = await prepare(input) }
    catch (error) {
      // The client can time out before slow local I/O does. Preserve this
      // attempt's explicit no-send outcome so its next status read recovers
      // the error instead of starting the same blocked preparation forever.
      state.create({ ...input, attachments: [] })
      const failed = state.update(input.id, {
        status: 'error', stage: 'attachment_validation', dispatchState: 'not_sent',
        targetUrl: input.targetUrl, url: input.conversationUrl || null,
        error: `${error.code || 'attachment_preparation_failed'}: ${error.message || error}`,
      })
      try { save(failed) } catch (persistError) {
        state.remove(input.id)
        throw requestError('research_request_persistence_failed', persistError.message || String(persistError))
      }
      return snapshot(failed, { openState: 'failed', code: error.code || 'attachment_preparation_failed' })
    }
    const job = state.create({ ...input, attachments })
    const prepared = state.update(job.id, {
      targetUrl: input.targetUrl, url: input.conversationUrl || input.targetUrl,
      dispatchState: 'prepared', stage: 'prepared',
    })
    try { save(prepared) } catch (error) {
      state.remove(job.id)
      throw requestError('research_request_persistence_failed', error.message || String(error))
    }
    const opened = await dispatch(prepared)
    return snapshot(opened.job, {
      openState: opened.open.openState,
      ...(opened.open.openWarning ? { openWarning: opened.open.openWarning } : {}),
      ...(opened.open.openError ? { openError: opened.open.openError } : {}),
    })
  }

  function start(input) {
    const pending = inFlight.get(input.id)
    if (pending) {
      try { assertSameResearchRequest(pending.fingerprint, input.requestFingerprint) }
      catch (error) { return Promise.reject(error) }
      return pending.promise
    }
    const promise = Promise.resolve().then(() => execute(input))
      .finally(() => { inFlight.delete(input.id) })
    inFlight.set(input.id, { fingerprint: input.requestFingerprint, promise })
    return promise
  }

  async function restore(id) {
    const current = state.get(id)
    if (current) return current
    const saved = load(id)
    if (!saved) return null
    if (!saved.requestFingerprint || saved.status === 'done' || saved.status === 'error') {
      return restoreResearchRequest(state, saved)
    }
    // Reuse the same lock as POST /research-start: concurrent status reads
    // after restart must not dispatch one prepared request twice.
    await start({ id, requestFingerprint: saved.requestFingerprint })
    return state.get(id)
  }

  return { start, restore }
}

module.exports = { createResearchRequestCoordinator, restoreResearchRequest }
