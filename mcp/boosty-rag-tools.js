'use strict'

const { randomUUID } = require('node:crypto')
const { createBoostyRagClient } = require('./boosty-rag-client')
const positive = { type: 'integer', minimum: 1 }
const source = { source_id: positive }
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const request = { type: 'string', maxLength: 160, pattern: '^[A-Za-z0-9_.:-]+$' }
const selection = { ...source, request_id: request,
  item_ids: { type: 'array', items: positive, minItems: 1, maxItems: 5000 },
  limit: { type: 'integer', minimum: 1, maximum: 20000 } }
const make = (name, description, properties, required, readOnly = true, extra = {}) => ({ name, description,
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true,
    openWorldHint: ['boosty_index', 'boosty_index_resume', 'boosty_semantic_search'].includes(name) },
  inputSchema: { type: 'object', properties, required, additionalProperties: false, ...extra } })
const boostyRagTools = [
  make('boosty_list_sources', 'Discover saved Boosty authors and CURRENT saved full-text RAG coverage. No login/download/ASR; works without the external media disk. Counts known, available, ready, missing and pending separately.', {
    query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 },
  }, []),
  make('boosty_list_interviews', 'Page through saved child videos for one Boosty author, with post/child IDs, full TXT/SRT availability, hash, exact saved cue availability, provenance and current index state. limit counts child videos, not posts.', {
    ...source, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 },
  }, ['source_id']),
  make('boosty_list_assets', 'Page saved author attachments separately from post text and video transcripts: original binary hash, full extracted text availability and current RAG state. Partial/OCR/unsupported content is explicit, filenames are not indexed content. No download/ASR.', {
    ...source, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 },
  }, ['source_id']),
  make('boosty_index', 'Start/resume indexing FULL already saved transcript and author post texts as one visible cancellable SC Requests job. Reuses completed documents and staged vectors; never downloads/transcribes. Save returned request_id/job_id and inspect status; accepted is not current-ready.', selection, ['source_id'], false),
  make('boosty_index_status', 'Read exact Boosty index job and fresh rehashed corpus coverage, including complete-current interviews/posts, fragments, partial/stale/missing and exceptions. After restart an exact durable job remains readable. No index job is started.', {
    ...source, job_id: { type: 'string' },
  }, [], true, { anyOf: [{ required: ['source_id'] }, { required: ['job_id'] }] }),
  make('boosty_index_cancel', 'Cancel exactly the acknowledged Boosty index job. Completed documents remain current; partial embeddings stay resumable but are not searchable. Does not delete saved transcripts or media.', {
    ...source, job_id: { type: 'string' },
  }, ['job_id'], false),
  make('boosty_index_resume', 'Resume current saved texts after one exact interrupted/cancelled/error Boosty index job. A NEW stable request_id belongs to this resume; old submission is never replayed. Uses already staged embeddings, no ASR/download.', {
    ...selection, resume_of: { type: 'string' },
  }, ['source_id', 'resume_of'], false),
  make('boosty_semantic_search', 'Semantic search of FULL saved Boosty interview transcripts and/or author post text. Explicit source/date/type/current original hash/profile apply BEFORE KNN. limit counts unique interviews (or posts with group_by=post), not chunks. Inspect returned budget_exhausted and coverage. Read context/original with expected_document_hash before a salary/role claim: ASR words and unassigned speakers are NOT verified interviewee claims.', {
    ...source, source_ids: { type: 'array', items: positive, minItems: 1, maxItems: 20 }, query: { type: 'string', minLength: 1, maxLength: 10000 },
    types: { type: 'array', items: { enum: ['transcript', 'post', 'asset'] }, minItems: 1 },
    group_by: { enum: ['interview', 'post'] }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    budget: { type: 'integer', minimum: 1, maximum: 10000 }, min_cos: { type: 'number', minimum: -1, maximum: 1 },
    date_from: { oneOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] }, date_to: { oneOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] },
  }, ['query'], true, { anyOf: [{ required: ['source_id'] }, { required: ['source_ids'] }] }),
  make('boosty_original_read', 'Read ONE complete saved Boosty original in hash-safe Unicode-codepoint pages: text=full canonical indexed text, txt=exact saved TXT, srt=exact saved SRT. Continue next_offset with SAME format and expected_document_hash; a changed original rejects the continuation. No file paths/auth/media retrieval.', {
    item_id: positive, expected_document_hash: hash, format: { enum: ['text', 'txt', 'srt'] }, offset: { type: 'integer', minimum: 0 },
    max_chars: { type: 'integer', minimum: 1, maximum: 16000 },
  }, ['item_id']),
  make('boosty_context', 'Expand one same-version Boosty hit into neighboring exact saved cues (before/after) or untimed text. Requires expected_document_hash from the hit. Canonical post URL + separate timecode/child ID, no invented time URL or speaker/Q-A assignment. Extend bounded context/original for a full question and answer.', {
    item_id: positive, expected_document_hash: hash, chunk_index: { type: 'integer', minimum: 0 }, cue_index: { type: 'integer', minimum: 0 },
    before_cues: { type: 'integer', minimum: 0, maximum: 100 }, after_cues: { type: 'integer', minimum: 0, maximum: 100 },
    before_chars: { type: 'integer', minimum: 0, maximum: 8000 }, max_chars: { type: 'integer', minimum: 128, maximum: 16000 },
  }, ['item_id', 'expected_document_hash'], true, { anyOf: [{ required: ['chunk_index'] }, { required: ['cue_index'] }] }),
]

const operations = { boosty_list_sources: 'sources', boosty_list_interviews: 'interviews', boosty_index: 'start',
  boosty_list_assets: 'assets',
  boosty_index_status: 'status', boosty_index_cancel: 'cancel', boosty_index_resume: 'resume', boosty_semantic_search: 'search',
  boosty_original_read: 'original', boosty_context: 'context' }
let client
async function callBoostyRagTool(name, args, suppliedClient = null) {
  const operation = operations[name]
  if (!operation) throw new Error('Unknown Boosty RAG tool')
  const input = { ...args }
  if ((operation === 'start' || operation === 'resume') && input.request_id == null) input.request_id = `boosty-mcp-${randomUUID()}`
  try {
    const out = await (suppliedClient || (client ||= createBoostyRagClient()))[operation](input)
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code: e.code || 'BOOSTY_RAG_UNAVAILABLE', error: e.message,
      ...(input.request_id ? { request_id: input.request_id, delivery_unknown: true,
        recovery: 'Read source/job status first. Retry only the identical request with this same request_id; never launch a replacement blindly.' } : {}) }) }] }
  }
}

module.exports = { boostyRagTools, boostyRagOperations: operations, callBoostyRagTool }
