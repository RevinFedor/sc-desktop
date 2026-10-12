const test = require('node:test')
const assert = require('node:assert/strict')

const {
  isAmbiguousDeliveryError,
  researchIdFromUrl,
  reconcileResearchTabOpen,
} = require('./research-tab-open')

test('research id is recovered from boot URL when the log has no id yet', () => {
  assert.equal(researchIdFromUrl('https://chatgpt.com/?sc-research=boot-id#sc-research=boot-id'), 'boot-id')
  assert.equal(researchIdFromUrl('https://claude.ai/new#sc-research=claude-id'), 'claude-id')
  assert.equal(researchIdFromUrl('https://chatgpt.com/'), null)
})

test('extension disconnect is delivery-unknown, not proof that open failed', () => {
  assert.equal(isAmbiguousDeliveryError(new Error('Extension disconnected')), true)
  assert.equal(isAmbiguousDeliveryError(Object.assign(new Error('lost'), { deliveryUnknown: true })), true)
  assert.equal(isAmbiguousDeliveryError(new Error('invalid URL')), false)
})

test('lost open ACK reconciles to the tab already recorded by the extension', async () => {
  const result = await reconcileResearchTabOpen({
    openTab: async () => { throw new Error('Extension disconnected') },
    findTab: async () => ({ success: true, tabId: 42, reused: true }),
    getSnapshot: () => ({ status: 'running' }),
  })
  assert.deepEqual(result, {
    tabId: 42,
    openState: 'reconciled',
    attempts: 2,
    openWarning: 'Extension disconnected',
    response: { success: true, tabId: 42, reused: true },
  })
})

test('a new extension may safely perform one idempotent open after find returns empty', async () => {
  let opens = 0
  const result = await reconcileResearchTabOpen({
    openTab: async () => {
      opens++
      if (opens === 1) throw Object.assign(new Error('ack lost'), { deliveryUnknown: true })
      return { success: true, tabId: 77 }
    },
    findTab: async () => ({ success: true, tabId: null }),
    getSnapshot: () => ({ status: 'queued' }),
  })
  assert.equal(opens, 2)
  assert.equal(result.tabId, 77)
  assert.equal(result.openState, 'opened_after_reconnect')
})

test('old extension failure stays unknown and never triggers a blind duplicate open', async () => {
  let opens = 0
  const result = await reconcileResearchTabOpen({
    openTab: async () => { opens++; throw new Error('Extension disconnected') },
    findTab: async () => { throw new Error('unknown action mcp_find_research_tab') },
    getSnapshot: () => ({ status: 'running', stage: 'configuring' }),
  })
  assert.equal(opens, 1)
  assert.equal(result.tabId, null)
  assert.equal(result.openState, 'started_without_tab_ack')
})
test('durable caller preserves an unknown outcome when a lost ACK has no remaining tab', async () => {
  let opens = 0
  const result = await reconcileResearchTabOpen({
    openTab: async () => { opens++; throw Object.assign(new Error('ack lost'), { deliveryUnknown: true }) },
    findTab: async () => ({ success: true, tabId: null }),
    getSnapshot: () => null,
    retryAfterMissing: false,
  })
  assert.equal(result.openState, 'delivery_unknown')
  assert.equal(opens, 1)
})
test('an explicit extension rejection is a failed open, not an accepted browser request', async () => {
  const result = await reconcileResearchTabOpen({
    openTab: async () => ({ success: false, error: 'browser unavailable' }),
    findTab: async () => { throw new Error('must not retry a known rejection') },
  })
  assert.equal(result.openState, 'failed')
  assert.equal(result.openError, 'browser unavailable')
})

test('a local opening stage does not prove that the browser received the request', async () => {
  const result = await reconcileResearchTabOpen({
    openTab: async () => ({ success: true }),
    getSnapshot: () => ({ status: 'queued', stage: 'opening' }),
  })
  assert.equal(result.openState, 'delivery_unknown')
})
