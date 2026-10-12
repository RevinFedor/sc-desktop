const crypto = require('node:crypto')

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,199}$/

function normalizeResearchRequestId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) return ''
  if (!REQUEST_ID_RE.test(id)) {
    const error = new Error('requestId must be 8-200 characters using letters, digits, _ or -')
    error.code = 'invalid_research_request_id'
    throw error
  }
  return id
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = stableValue(value[key])
  }
  return out
}

function attachmentIdentity(value) {
  if (typeof value === 'string') return { path: value }
  if (!value || typeof value !== 'object') return value
  return stableValue({
    path: value.path,
    startLine: value.startLine,
    endLine: value.endLine,
    lines: value.lines,
    name: value.name,
  })
}

function researchRequestFingerprint({
  provider,
  prompt,
  options,
  attachments,
  conversationUrl,
} = {}) {
  const canonical = stableValue({
    provider: String(provider || ''),
    prompt: String(prompt || ''),
    options: options && typeof options === 'object' ? options : {},
    attachments: (Array.isArray(attachments) ? attachments : []).map(attachmentIdentity),
    conversationUrl: String(conversationUrl || ''),
  })
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function assertSameResearchRequest(existingFingerprint, requestedFingerprint) {
  if (!existingFingerprint) {
    const error = new Error('research request identity is unavailable for this requestId')
    error.code = 'research_request_identity_unavailable'
    throw error
  }
  if (existingFingerprint !== requestedFingerprint) {
    const error = new Error('requestId was already used for a different research request')
    error.code = 'research_request_id_reused'
    throw error
  }
}

module.exports = {
  normalizeResearchRequestId,
  researchRequestFingerprint,
  assertSameResearchRequest,
}
