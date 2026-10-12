const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeResearchRequestId,
  researchRequestFingerprint,
  assertSameResearchRequest,
} = require('./research-request-identity')

test('request identity is stable across object key order', () => {
  const left = researchRequestFingerprint({
    provider: 'chatgpt', prompt: 'review', options: { effort: 'medium', mode: 'chat' },
    attachments: [{ path: '/tmp/a.md', startLine: 2, endLine: 8 }],
    conversationUrl: 'https://chatgpt.com/c/example',
  })
  const right = researchRequestFingerprint({
    conversationUrl: 'https://chatgpt.com/c/example',
    attachments: [{ endLine: 8, startLine: 2, path: '/tmp/a.md' }],
    options: { mode: 'chat', effort: 'medium' }, prompt: 'review', provider: 'chatgpt',
  })
  assert.equal(left, right)
})

test('request identity changes for a new prompt, file range, or conversation', () => {
  const base = {
    provider: 'chatgpt', prompt: 'review', options: { mode: 'chat' },
    attachments: [{ path: '/tmp/a.md', lines: '1-3' }],
    conversationUrl: 'https://chatgpt.com/c/one',
  }
  const fingerprint = researchRequestFingerprint(base)
  assert.notEqual(fingerprint, researchRequestFingerprint({ ...base, prompt: 'review v2' }))
  assert.notEqual(fingerprint, researchRequestFingerprint({ ...base, attachments: [{ path: '/tmp/a.md', lines: '1-4' }] }))
  assert.notEqual(fingerprint, researchRequestFingerprint({ ...base, conversationUrl: 'https://chatgpt.com/c/two' }))
})

test('requestId validation and conflict are explicit', () => {
  assert.equal(normalizeResearchRequestId('noted_abcd-1234'), 'noted_abcd-1234')
  assert.throws(() => normalizeResearchRequestId('short'), /8-200/)
  assert.throws(() => assertSameResearchRequest('', 'a'), (error) => error.code === 'research_request_identity_unavailable')
  assert.throws(() => assertSameResearchRequest('a', 'b'), (error) => error.code === 'research_request_id_reused')
  assert.doesNotThrow(() => assertSameResearchRequest('same', 'same'))
})
