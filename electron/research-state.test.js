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

test('preflight can reserve an id without exposing a job before create', () => {
  const id = researchState.newRequestId()
  assert.equal(researchState.get(id), null)

  const job = researchState.create({ id, provider: 'chatgpt', prompt: 'test', options: {}, attachments: [] })
  assert.equal(job.id, id)
  assert.throws(
    () => researchState.create({ id, provider: 'chatgpt', prompt: 'duplicate', options: {} }),
    /already exists/,
  )
  researchState.remove(id)
})

test('ChatGPT history labels Astra as the Pro model', () => {
  assert.equal(
    researchState.chatgptModelLabel({ mode: 'chat', model: '6-astra', effort: 'pro' }),
    'GPT-6 Astra · pro',
  )
  assert.equal(
    researchState.chatgptModelLabel({ mode: 'chat', model: 'gpt-6-astra' }),
    'GPT-6 Astra · pro',
  )
})

test('Chat history keeps ordinary GPT-6 and its effort separate from the existing Astra/Pro label', () => {
  assert.equal(researchState.chatgptModelLabel({ mode: 'chat', model: '6', effort: 'xhigh' }), 'GPT-6 · xhigh')
  assert.equal(researchState.chatgptModelLabel({ mode: 'chat', model: 'gpt-6', effort: 'medium' }), 'GPT-6 · medium')
})

test('Work history distinguishes new model generations without labelling Work Astra as Chat Pro', () => {
  assert.equal(researchState.chatgptModelLabel({ mode: 'work', model: '6.1-sol', effort: 'max' }), 'GPT-6.1 Sol · max · standard')
  assert.equal(researchState.chatgptModelLabel({ mode: 'work', model: '6-sol', effort: 'high' }), 'GPT-6 Sol · high · standard')
  assert.equal(researchState.chatgptModelLabel({ mode: 'work', model: '6-luna', effort: 'max' }), 'GPT-6 Luna · max · standard')
  assert.equal(researchState.chatgptModelLabel({ mode: 'work', model: '6-astra' }), 'GPT-6 Astra · xhigh · standard')
})
