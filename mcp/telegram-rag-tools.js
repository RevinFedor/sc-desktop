'use strict'

const captionProperties = {
  caption_chars: { type: 'integer', default: 4000, minimum: 0, maximum: 16000, description: 'Saved caption characters returned per message; may include labelled extraction/transcription/model descriptions. Truncation is explicit. Read selected messages fully with telegram_message_read.' },
}
const messageIdentity = {
  item_id: { type: 'integer', minimum: 1, description: 'Local library message PK, not Telegram message_id.' },
  source_id: { type: 'integer', minimum: 1 },
  external_id: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[1-9][0-9]*$' }], description: 'Telegram message_id paired with source_id.' },
}
const contextProperties = {
  ...messageIdentity, ...captionProperties,
  before: { type: 'integer', default: 15, minimum: 0, maximum: 100 },
  after: { type: 'integer', default: 15, minimum: 0, maximum: 100 },
  same_topic: { type: 'boolean', default: false, description: 'When true, chronological neighbors stay in the center topic. Actual reply ancestors remain explicitly labelled.' },
  max_depth: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
  max_descendants: { type: 'integer', default: 100, minimum: 0, maximum: 500 },
}
const identityAlternatives = [{ required: ['item_id'] }, { required: ['source_id', 'external_id'] }]

const telegramRagTools = [
  {
    name: 'telegram_message_read',
    description: 'Read the complete saved caption of ONE Telegram message, including a semantic hit beyond its beginning. The saved caption may contain labelled extraction, transcription or model descriptions; inspect caption_source/processing flags and never quote those as text typed by the author. No Telegram network/fetch/media download. Use item_id or source_id+external_id. Unicode-safe pages return exact caption_hash, total length, offset unit and next_offset; continuation requires expected_caption_hash and rejects edits between pages. Returns actual source/topic/reply/forward provenance, including external_reply; unknown legacy reply peers are not asserted as local parents. Never treat embedding-context as the author’s own text.',
    inputSchema: {
      type: 'object',
      properties: {
        ...messageIdentity,
        caption_chars: { ...captionProperties.caption_chars, default: 16000 },
        caption_offset: { type: 'integer', default: 0, minimum: 0, description: 'Unicode codepoint offset, not UTF16.' },
        expected_caption_hash: { type: 'string', description: 'Hash from the first page; required after offset 0.' },
      },
      anyOf: identityAlternatives, additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'telegram_context',
    description: 'Read the saved graph and chronological context for one Telegram RAG hit in one bounded call, deduplicated and stably ordered. Checked same-peer replies and unverified legacy parent candidates are labelled separately; provenance_complete=false means the legacy peer path is not proved. Known external_reply references never become local edges. Adjacent messages are not asserted to be the same conversation. Topic anchors, missing parents/depth/node/cycle limits and text truncation are explicit. Inspect saved-caption processing flags and forward origin before attributing a statement. No network or archive changes.',
    inputSchema: { type: 'object', properties: contextProperties, anyOf: identityAlternatives, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]

function ragErrorResult(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({
      ok: false, code: error.code || 'telegram_rag_error', error: error.message,
      ...(error.item_id != null ? { item_id: error.item_id } : {}),
      ...(error.source_id != null ? { source_id: error.source_id } : {}),
      ...(error.existing_job_id ? { existing_job_id: error.existing_job_id } : {}),
      ...(error.caption_hash ? { caption_hash: error.caption_hash } : {}),
      ...(error.expected_caption_hash ? { expected_caption_hash: error.expected_caption_hash } : {}),
    }, null, 2) }],
  }
}

module.exports = { telegramRagTools, captionProperties, ragErrorResult }
