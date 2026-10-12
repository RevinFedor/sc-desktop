'use strict'
const { createBoostyRagClient } = require('./boosty-rag-client')
const id = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,192}$' }
const make = (name, description, properties, required = [], readOnly = true) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: name.endsWith('cleanup'), idempotentHint: true, openWorldHint: !readOnly } })
const boostyWorkflowTools = [
  make('boosty_account_preflight', 'Start metadata-only CURRENT browser-account feed reconciliation with explicit EOF and genuine child IDs. Preserve old full TXT/post bodies. Verify physical external USB for per-job disposable audio/temp and Mac text/index. No media/ASR/index/clipboard. Save exact job_id, then status/ledger/plan_hash.', { request_id: id, handle: { type: 'string' }, url: { type: 'string' }, external_mount: { type: 'string' } }, ['request_id'], false),
  make('boosty_storage_info', 'Read configured and physical media/work/text/library roots without exposing secrets or changing settings. A Mac work_dir is NOT safe external-only readiness.', {}),
  make('boosty_workflow_status', 'Read exact durable account/catchup receipt. Accepted is not terminal/current-ready; interrupted or paid-delivery-unknown never authorizes replacement/force. Does not start processing.', { job_id: id }, ['job_id']),
  make('boosty_workflow_ledger', 'Revision-safe paged per-post/per-child account access/empty/reused/missing/ready/cleanup evidence. Continue same expected_revision. Declared counters are not genuine child IDs or accessible archive coverage.', { job_id: id, type: { enum: ['posts', 'children'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 }, expected_revision: { type: 'string' } }, ['job_id']),
  make('boosty_catchup_start', 'PAID: sequentially process only genuinely missing authorized exact children from a completed fresh account/storage plan. Explicit user-approved model+cost release and confirm_asr REQUIRED. No hidden model/fallback; AssemblyAI adapter only (Soniox not implemented). All media/extraction/temp physically external USB; Mac TXT/SRT and same-version RAG verified before own-media eviction. Oldready never replayed.', { request_id: id, plan_id: id, expected_plan_hash: { type: 'string' }, video_ids: { type: 'array', items: { type: 'string' }, maxItems: 5000 }, confirm_asr: { const: true }, asr_profile: { type: 'object', additionalProperties: false, required: ['engine', 'release_id', 'approved_by_user', 'speech_models', 'language_detection', 'speaker_labels', 'estimated_cost_usd', 'max_cost_usd'], properties: {
    engine: { const: 'assemblyai' }, release_id: id, approved_by_user: { const: true }, speech_models: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 }, language_detection: { const: true }, speaker_labels: { const: true }, estimated_cost_usd: { type: 'number', minimum: 0 }, max_cost_usd: { type: 'number', exclusiveMinimum: 0 } } } }, ['request_id', 'plan_id', 'expected_plan_hash', 'confirm_asr', 'asr_profile'], false),
  make('boosty_workflow_cancel', 'Cancel ONE exact account/catchup job, signal only own Python/index, wait for terminal receipt. Remote accepted ASR is not cancelled/refunded by killing local polling; retain paid ID/media for GET-based recovery, never paid resubmit.', { job_id: id }, ['job_id'], false),
  make('boosty_catchup_resume', 'Resume exact cancelled/interrupted/error catchup using original media ownership and write-ahead paid receipt. Known provider ID retrieves same request; unknown submit refuses retry. No force and no new model/engine.', { request_id: id, job_id: id }, ['request_id', 'job_id'], false),
  make('boosty_workflow_cleanup', 'Delete only this workflow own media for ONE verified exact child after stable Mac TXT+SRT, hash-safe original/cues and current-ready RAG. Never delete old user media/text/items/history; refuse symlink/replaced/unknown files. Interrupted/failed unverified child is not eligible.', { job_id: id, video_id: { type: 'string' } }, ['job_id', 'video_id'], false),
  make('boosty_workflow_diarization', 'Read same-original/version provider speaker-labelled utterances retained on Mac for ONE exact new workflow child. Labels A/B are NOT identified interviewer/candidate roles; RU+EN quality is unverified. Old ASR without these outputs remains readable but no diarization is invented. Continue same document and diarization hashes.', { job_id: id, video_id: { type: 'string' }, expected_document_hash: { type: 'string' }, expected_diarization_hash: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, ['job_id', 'video_id', 'expected_document_hash']),
]
const boostyWorkflowOperations = { boosty_account_preflight: ['preflight', true], boosty_storage_info: ['storage', false], boosty_workflow_status: ['status', false], boosty_workflow_ledger: ['ledger', false], boosty_catchup_start: ['start', true], boosty_workflow_cancel: ['cancel', true], boosty_catchup_resume: ['resume', true], boosty_workflow_cleanup: ['cleanup', true], boosty_workflow_diarization: ['diarization', false] }
let client
async function callBoostyWorkflowTool(name, args = {}, providedClient) {
  const [op, write] = boostyWorkflowOperations[name] || []
  if (!op) throw new Error('Unknown Boosty workflow tool')
  try {
    const c = providedClient || (client ||= createBoostyRagClient())
    const result = await c.call(`/boosty-workflow/${op}${write ? '' : '?' + new URLSearchParams(Object.entries(args).filter(([, v]) => v != null))}`, write ? args : undefined)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (e) {
    const code = e.code === 'BOOSTY_APP_UPDATE_REQUIRED' ? 'BOOSTY_WORKFLOW_APP_UPDATE_REQUIRED' : e.code || 'BOOSTY_WORKFLOW_DELIVERY_UNCONFIRMED'
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code,
      error: code === 'BOOSTY_WORKFLOW_APP_UPDATE_REQUIRED' ? 'Running SC Desktop has no account/strict catchup lifecycle API; source preparation is not installed readiness. No fallback was used.' : e.message,
      request_id: args.request_id || null, recovery: 'Inspect exact boosty_workflow_status(job_id=boosty-workflow:<request_id>); retry only unchanged request, never replacement or rawstorage/worker fallback' }) }] }
  }
}
module.exports = { boostyWorkflowTools, boostyWorkflowOperations, callBoostyWorkflowTool }
