const test = require('node:test')
const assert = require('node:assert/strict')

const researchState = require('./research-state')

test('public research status exposes reconciled tab identity', () => {
  const job = researchState.create({ provider: 'chatgpt', prompt: 'test', options: {} })
  researchState.update(job.id, { status: 'running', stage: 'configuring', tabId: 42 })
  const snapshot = researchState.publicSnapshot(researchState.get(job.id))

  assert.equal(snapshot.status, 'running')
  assert.equal(snapshot.tabId, 42)
  researchState.remove(job.id)
})
