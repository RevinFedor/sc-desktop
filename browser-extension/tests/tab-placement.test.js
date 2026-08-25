const test = require('node:test');
const assert = require('node:assert/strict');

const { scTabCreateOptionsBesideSource } = require('../tab-placement.js');

test('ChatGPT tab is created immediately to the right of its YouTube source tab', () => {
  const base = { url: 'https://chatgpt.com/', active: false };
  const result = scTabCreateOptionsBesideSource(base, { windowId: 7, index: 4 });

  assert.deepEqual(result, {
    url: 'https://chatgpt.com/',
    active: false,
    windowId: 7,
    index: 5,
  });
  assert.deepEqual(base, { url: 'https://chatgpt.com/', active: false });
});

test('first source tab places ChatGPT at index one', () => {
  const result = scTabCreateOptionsBesideSource(
    { url: 'https://chatgpt.com/', active: false },
    { windowId: 3, index: 0 },
  );

  assert.equal(result.windowId, 3);
  assert.equal(result.index, 1);
});

test('missing source geometry preserves the ordinary end-of-strip fallback', () => {
  const base = { url: 'https://chatgpt.com/', active: false };

  assert.deepEqual(scTabCreateOptionsBesideSource(base, null), base);
  assert.deepEqual(scTabCreateOptionsBesideSource(base, { windowId: 2 }), base);
  assert.deepEqual(scTabCreateOptionsBesideSource(base, { index: 6 }), base);
});
