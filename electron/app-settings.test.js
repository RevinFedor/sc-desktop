const test = require('node:test')
const assert = require('node:assert/strict')

const { sanitizeExtensionYoutube } = require('./app-settings')

test('desktop accepts GPT-5.6 with Work Max and Ultra capabilities', () => {
  const max = sanitizeExtensionYoutube({
    chatgpt_mode: 'work',
    chatgpt_work_model: '5.6',
    chatgpt_work_effort: 'max',
  })
  assert.equal(max.chatgpt_work_model, '5.6')
  assert.equal(max.chatgpt_work_effort, 'max')
  assert.equal(max.chatgpt_model, '5.6')
  assert.equal(max.chatgpt_effort, 'max')

  const ultra = sanitizeExtensionYoutube({
    chatgpt_mode: 'work',
    chatgpt_work_model: '5.6',
    chatgpt_work_effort: 'ultra',
  })
  assert.equal(ultra.chatgpt_work_effort, 'ultra')
})

test('desktop clamps combinations unavailable in the selected ChatGPT mode', () => {
  const settings = sanitizeExtensionYoutube({
    chatgpt_mode: 'work',
    chatgpt_chat_model: '5.6',
    chatgpt_chat_effort: 'pro-extended',
    chatgpt_work_model: '5.4',
    chatgpt_work_effort: 'ultra',
  })
  assert.equal(settings.chatgpt_chat_model, '5.6')
  assert.equal(settings.chatgpt_chat_effort, 'xhigh')
  assert.equal(settings.chatgpt_work_model, '5.5')
  assert.equal(settings.chatgpt_work_effort, 'xhigh')
  assert.equal(settings.chatgpt_model, '5.5')
  assert.equal(settings.chatgpt_effort, 'xhigh')
})
