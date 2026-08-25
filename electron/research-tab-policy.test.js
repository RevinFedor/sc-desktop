const test = require('node:test')
const assert = require('node:assert/strict')

const {
  resolveResearchAutoClose,
  withResearchAutoClose,
} = require('./research-tab-policy')

test('research tabs stay open when the global setting is absent or disabled', () => {
  assert.equal(resolveResearchAutoClose({}, false), false)
  assert.equal(withResearchAutoClose({}, false).autoClose, false)
})

test('global auto-close applies only when the request has no explicit override', () => {
  assert.equal(resolveResearchAutoClose({}, true), true)
  assert.equal(resolveResearchAutoClose({ autoClose: false }, true), false)
  assert.equal(resolveResearchAutoClose({ keepTab: true }, true), false)
  assert.equal(resolveResearchAutoClose({ keepTab: false }, false), true)
})
