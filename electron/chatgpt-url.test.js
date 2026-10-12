const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeChatgptConversationUrl,
  chatgptResearchEntryUrl,
} = require('./chatgpt-url')

test('new Chat research opens as a temporary ChatGPT chat by default', () => {
  const url = new URL(chatgptResearchEntryUrl({ id: 'r-chat', mode: 'chat' }))

  assert.equal(url.origin, 'https://chatgpt.com')
  assert.equal(url.searchParams.get('temporary-chat'), 'true')
  assert.equal(url.searchParams.get('sc-research'), 'r-chat')
  assert.equal(url.hash, '#sc-research=r-chat')
})

test('Work research uses a normal chat because temporary chat has no Work space', () => {
  const url = new URL(chatgptResearchEntryUrl({ id: 'r-work', mode: 'work' }))

  assert.equal(url.searchParams.has('temporary-chat'), false)
  assert.equal(url.searchParams.get('sc-research'), 'r-work')
})

test('Main setting can open a new Chat research as a normal persistent chat', () => {
  const url = new URL(chatgptResearchEntryUrl({
    id: 'r-persistent-chat',
    mode: 'chat',
    temporaryChat: false,
  }))

  assert.equal(url.searchParams.has('temporary-chat'), false)
  assert.equal(url.searchParams.get('sc-research'), 'r-persistent-chat')
})

test('continuing an explicit conversation preserves whether that conversation is temporary', () => {
  const permanent = new URL(chatgptResearchEntryUrl({
    id: 'r-followup',
    mode: 'chat',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
  }))
  const temporary = new URL(chatgptResearchEntryUrl({
    id: 'r-temp-followup',
    mode: 'chat',
    conversationUrl: 'https://chatgpt.com/c/conversation-2?temporary-chat=true',
  }))

  assert.equal(permanent.searchParams.has('temporary-chat'), false)
  assert.equal(permanent.searchParams.get('sc-research'), 'r-followup')
  assert.equal(temporary.searchParams.get('temporary-chat'), 'true')
  assert.equal(temporary.searchParams.get('sc-research'), 'r-temp-followup')
})

test('conversation URL validation still rejects foreign origins', () => {
  assert.throws(
    () => normalizeChatgptConversationUrl('https://example.com/c/not-chatgpt'),
    /must be on https:\/\/chatgpt\.com/,
  )
})
