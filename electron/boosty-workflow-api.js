'use strict'
const { matchesBearerToken } = require('./local-notification-auth')
const { fail } = require('./boosty-catalog-contract')

function createBoostyWorkflowApi({ token, workflow, readBody, sendJson }) {
  const allowed = {
    preflight: ['request_id', 'handle', 'url', 'external_mount'],
    start: ['request_id', 'plan_id', 'expected_plan_hash', 'video_ids', 'confirm_asr', 'asr_profile'],
    resume: ['request_id', 'job_id'], cancel: ['job_id'], cleanup: ['job_id', 'video_id'],
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/boosty-workflow/')) return false
    if (req.headers.origin) { sendJson(res, 403, { ok: false, code: 'BOOSTY_BROWSER_ORIGIN_REJECTED' }); return true }
    if (!matchesBearerToken(req.headers.authorization, token)) { sendJson(res, 401, { ok: false, code: 'BOOSTY_LOCAL_AUTH_REQUIRED' }); return true }
    try {
      const op = url.pathname.slice('/boosty-workflow/'.length)
      if (req.method === 'GET' && op === 'capabilities') {
        sendJson(res, 200, { ok: true, version: 1, auth_mode: 'account', auto_clipboard: false,
          requires_user_model_cost_release: true, engine_adapter: 'assemblyai_explicit_speech_models_no_fallback',
          soniox_adapter: false, asset_original_collection: false, pdf_extraction_or_ocr: false,
          existing_ready_replay: false, physical_external_media_required: true,
          eviction: 'exact_own_manifest_after_same_hash_TXT_SRT_original_cues_and_current_RAG',
          routes: ['POST /boosty-workflow/preflight', 'GET /boosty-workflow/storage', 'GET /boosty-workflow/status',
            'GET /boosty-workflow/ledger', 'POST /boosty-workflow/start', 'POST /boosty-workflow/cancel',
            'POST /boosty-workflow/resume', 'POST /boosty-workflow/cleanup', 'GET /boosty-workflow/diarization'],
          budget_scope: 'caller_approved_preflight_estimate_not_provider_hard_billing_limit',
          diarization_quality_verified: false }); return true
      }
      if (req.method === 'GET' && op === 'storage') { sendJson(res, 200, await workflow.storage()); return true }
      if (req.method === 'GET' && op === 'diarization') { sendJson(res, 200, workflow.diarization(Object.fromEntries(url.searchParams))); return true }
      if (req.method === 'GET' && ['status', 'ledger'].includes(op)) {
        const state = workflow.status(url.searchParams.get('job_id'))
        if (op === 'status') {
          const { ledger, plan, account_ledger, ...receipt } = state
          sendJson(res, 200, { ...receipt, counts: { posts: plan?.posts?.length || null, children: plan?.children?.length || ledger?.length || null,
            missing: plan?.children?.filter(c => c.state === 'missing').length ?? null,
            reused: plan?.children?.filter(c => c.state.startsWith('reused')).length ?? null,
            finished: ledger?.filter(c => ['ready_evicted', 'reused'].includes(c.state)).length || 0 } })
        } else {
          const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100)
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw fail('BOOSTY_INVALID_PAGINATION', 'Bounded ledger paging required')
          const expected = url.searchParams.get('expected_revision'), revision = String(state.revision)
          if (offset && !expected || expected && expected !== revision) throw fail('BOOSTY_LEDGER_REVISION_CHANGED', 'Read a fresh ledger; do not join changed snapshots')
          const type = url.searchParams.get('type') || 'children'
          if (!['children', 'posts'].includes(type)) throw fail('BOOSTY_INVALID_LEDGER_TYPE', 'children or posts required')
          const rows = type === 'posts' ? (state.plan || state.account_ledger)?.posts || []
            : state.plan?.children || (state.account_ledger?.children ? state.account_ledger.children.map(c => state.ledger.find(l => l.video_id === c.video_id) || c) : state.ledger || [])
          sendJson(res, 200, { ok: true, job_id: state.job_id, source_id: state.source_id, revision, type,
            rows: rows.slice(offset, offset + limit), total: rows.length,
            next_offset: offset + limit < rows.length ? offset + limit : null })
        }
        return true
      }
      if (req.method === 'POST' && allowed[op]) {
        const body = await readBody(req, 256000)
        if (!body || Object.keys(body).some(k => !allowed[op].includes(k))) throw fail('BOOSTY_INVALID_WORKFLOW_REQUEST', 'Unknown fields/credentials are not accepted')
        sendJson(res, 200, await workflow[op](op === 'cancel' ? body.job_id : body)); return true
      }
      sendJson(res, 404, { ok: false, code: 'BOOSTY_WORKFLOW_ROUTE_NOT_FOUND' })
    } catch (e) {
      sendJson(res, /CONFLICT|BUSY|REVISION/.test(e.code || '') ? 409 : 400,
        { ok: false, code: e.code || 'BOOSTY_WORKFLOW_FAILED', error: e.code ? e.message : 'Workflow operation failed; inspect the exact receipt before retry' })
    }
    return true
  }
  return { handle, close() {} }
}
module.exports = { createBoostyWorkflowApi }
