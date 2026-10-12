const test = require('node:test');
const assert = require('node:assert/strict');

const { scChatgptComposeEntryUrl } = require('../chatgpt-entry-url.js');

test('YouTube AI opens ordinary Chat summaries as temporary chats', () => {
  const url = new URL(scChatgptComposeEntryUrl('compose-chat', 'chat'));

  assert.equal(url.searchParams.get('temporary-chat'), 'true');
  assert.equal(url.searchParams.get('sc-compose'), 'compose-chat');
  assert.equal(url.hash, '#sc-compose=compose-chat');
});

test('YouTube AI opens Work summaries as normal chats so Work remains selectable', () => {
  const url = new URL(scChatgptComposeEntryUrl('compose-work', 'work'));

  assert.equal(url.searchParams.has('temporary-chat'), false);
  assert.equal(url.searchParams.get('sc-compose'), 'compose-work');
});

test('YouTube AI can open Chat summaries as normal chats from the Main setting', () => {
  const url = new URL(scChatgptComposeEntryUrl('compose-persistent', 'chat', false));

  assert.equal(url.searchParams.has('temporary-chat'), false);
  assert.equal(url.searchParams.get('sc-compose'), 'compose-persistent');
});
