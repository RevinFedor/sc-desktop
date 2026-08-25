const test = require('node:test');
const assert = require('node:assert/strict');

const { scKeepResearchTabAfterDone } = require('../research-tab-policy.js');

test('provider scripts share one keep-open policy', () => {
  assert.equal(scKeepResearchTabAfterDone({ autoClose: false }), true);
  assert.equal(scKeepResearchTabAfterDone({ keepTab: true }), true);
  assert.equal(scKeepResearchTabAfterDone({ autoClose: true }), false);
  assert.equal(scKeepResearchTabAfterDone({}), false);
});
