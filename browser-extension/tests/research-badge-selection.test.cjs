const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'research-badge.js'), 'utf8');

test('Job ID and model are native selectable text fields, not copy controls', () => {
  for (const key of ['job', 'model']) {
    assert.match(source, new RegExp(`class="sc-mcp-selectable sc-mcp-meta-value" data-sc-mcp-${key}="1"`));
  }
  assert.match(source, /\.sc-mcp-body,\s*#\$\{BADGE_ID\} \.sc-mcp-selectable\{\s*pointer-events:auto;\s*user-select:text!important;/);
  assert.match(source, /-webkit-user-select:text!important/);
});

test('no prompt-copy button, clipboard writes or custom double-click selection remains', () => {
  assert.doesNotMatch(source, /data-sc-mcp-prompt-copy|copyPromptToClipboard|promptCopyFeedback/);
  assert.doesNotMatch(source, /clipboard\.writeText|execCommand/);
  assert.doesNotMatch(source, /addEventListener\(['"](?:dblclick|mousedown|pointerdown)/);
});

test('collapse and prompt expansion controls remain available', () => {
  assert.match(source, /data-sc-mcp-toggle/);
  assert.match(source, /data-sc-mcp-prompt-more/);
  assert.match(source, /el\.classList\.toggle\('collapsed'/);
  assert.match(source, /promptText\.classList\.toggle\('expanded'/);
});
