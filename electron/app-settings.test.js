const test = require('node:test')
const assert = require('node:assert/strict')

const { patchExtensionYoutubeSettings, sanitizeExtensionYoutube } = require('./app-settings')

test('desktop accepts all GPT-5.6 Work tiers with Max and Ultra capabilities', () => {
  const max = sanitizeExtensionYoutube({
    chatgpt_mode: 'work',
    chatgpt_work_model: '5.6-terra',
    chatgpt_work_effort: 'max',
  })
  assert.equal(max.chatgpt_work_model, '5.6-terra')
  assert.equal(max.chatgpt_work_effort, 'max')
  assert.equal(max.chatgpt_model, '5.6-terra')
  assert.equal(max.chatgpt_effort, 'max')

  const ultra = sanitizeExtensionYoutube({
    chatgpt_mode: 'work',
    chatgpt_work_model: '5.6-luna',
    chatgpt_work_effort: 'ultra',
  })
  assert.equal(ultra.chatgpt_work_model, '5.6-luna')
  assert.equal(ultra.chatgpt_work_effort, 'ultra')
})

test('desktop clamps combinations unavailable in the selected ChatGPT mode', () => {
  const settings = sanitizeExtensionYoutube({
    chatgpt_mode: 'work',
    chatgpt_chat_model: '5.6-terra',
    chatgpt_chat_effort: 'low',
    chatgpt_work_model: '5.5',
    chatgpt_work_effort: 'pro',
  })
  assert.equal(settings.chatgpt_chat_model, '5.6-sol')
  assert.equal(settings.chatgpt_chat_effort, 'xhigh')
  assert.equal(settings.chatgpt_work_model, '5.6-sol')
  assert.equal(settings.chatgpt_work_effort, 'xhigh')
  assert.equal(settings.chatgpt_model, '5.6-sol')
  assert.equal(settings.chatgpt_effort, 'xhigh')
})

test('desktop migrates retired and numeric GPT model ids', () => {
  const settings = sanitizeExtensionYoutube({
    chatgpt_chat_model: '5.4',
    chatgpt_chat_effort: 'high',
    chatgpt_work_model: '5.6',
    chatgpt_work_effort: 'ultra',
  })
  assert.equal(settings.chatgpt_chat_model, '5.6-sol')
  assert.equal(settings.chatgpt_chat_effort, 'high')
  assert.equal(settings.chatgpt_work_model, '5.6-sol')
  assert.equal(settings.chatgpt_work_effort, 'ultra')
})

test('desktop defaults inline transcript mode on and preserves explicit off', () => {
  assert.equal(sanitizeExtensionYoutube({}).chatgpt_show_in_text_field, true)
  assert.equal(
    sanitizeExtensionYoutube({ chatgpt_show_in_text_field: false }).chatgpt_show_in_text_field,
    false,
  )
})

test('desktop persists the inline transcript toggle in extension settings', () => {
  let stored = {
    browser_extension: {
      youtube_schema_version: 1,
      youtube: {
        target: 'chatgpt',
        chatgpt_show_in_text_field: true,
      },
    },
  }
  const read = () => structuredClone(stored)
  const write = next => {
    stored = structuredClone(next)
    return { ok: true }
  }

  const result = patchExtensionYoutubeSettings(read, write, {
    chatgpt_show_in_text_field: false,
  })

  assert.equal(result.chatgpt_show_in_text_field, false)
  assert.equal(stored.browser_extension.youtube.chatgpt_show_in_text_field, false)
})
