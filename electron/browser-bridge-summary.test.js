const test = require('node:test')
const assert = require('node:assert/strict')

const { externalJobSummary } = require('./browser-bridge')

test('external job summary keeps navbar metadata and drops heavy research bodies', () => {
  const sourceRows = Array.from({ length: 400 }, (_, i) => ({
    title: `Source ${i}`,
    url: `https://example.com/${i}`,
  }))
  const full = {
    jobId: 'research-1',
    kind: 'research',
    provider: 'chatgpt',
    status: 'done',
    stage: 'done',
    modelId: '5.6-sol',
    createdAt: 10,
    updatedAt: 20,
    fullPrompt: 'p'.repeat(5000),
    responseText: 'r'.repeat(130000),
    answerText: 'a'.repeat(10000),
    reasoningText: 't'.repeat(20000),
    sources: sourceRows,
    sourcesMeta: { activity_items: sourceRows },
    sourceActivity: sourceRows,
    images: [{ assetUrl: 'sc-asset://one.png', bytes: 42 }],
  }

  const summary = externalJobSummary(full)

  assert.equal(summary.jobId, full.jobId)
  assert.equal(summary.status, 'done')
  assert.equal(summary.promptLen, 5000)
  assert.equal(summary.responseTextLen, 130000)
  assert.equal(summary.linkCount, 400)
  assert.equal(summary.promptHead.length, 140)
  assert.equal(summary.responseHead.length, 600)
  assert.deepEqual(summary.images, full.images)
  for (const key of [
    'fullPrompt', 'responseText', 'answerText', 'reasoningText',
    'sources', 'sourcesMeta', 'sourceActivity',
  ]) {
    assert.equal(Object.hasOwn(summary, key), false, key)
  }
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 20)
})
