const test = require('node:test')
const assert = require('node:assert/strict')

const {
  patchAppSettings,
  patchExtensionYoutubeSettings,
  publicAppSettings,
  sanitizeBoostySettings,
  sanitizeExtensionYoutube,
} = require('./app-settings')

test('Main defaults external research tab auto-close to off', () => {
  assert.equal(publicAppSettings({}).main.external_research_auto_close, false)
  assert.equal(
    publicAppSettings({ main: { external_research_auto_close: true } }).main.external_research_auto_close,
    true,
  )
})

test('Main persists the external research auto-close toggle without touching other sections', () => {
  let stored = { telegram: { session: 'keep-me' } }
  const result = patchAppSettings(
    () => structuredClone(stored),
    next => { stored = structuredClone(next); return { ok: true } },
    { section: 'main', patch: { external_research_auto_close: false } },
  )
  assert.equal(result.external_research_auto_close, false)
  assert.equal(stored.main.external_research_auto_close, false)
  assert.equal(stored.telegram.session, 'keep-me')
})

test('Telegram auto master switch defaults on and persists explicit off', () => {
  assert.equal(publicAppSettings({}).telegram.auto_enabled, true)
  assert.equal(
    publicAppSettings({ telegram: { auto_enabled: false } }).telegram.auto_enabled,
    false,
  )

  let stored = { telegram: { session: 'keep-me', engine: 'gemini' } }
  const result = patchAppSettings(
    () => structuredClone(stored),
    next => { stored = structuredClone(next); return { ok: true } },
    { section: 'telegram', patch: { auto_enabled: false } },
  )

  assert.equal(result.auto_enabled, false)
  assert.equal(stored.telegram.auto_enabled, false)
  assert.equal(stored.telegram.session, 'keep-me')
  assert.equal(stored.telegram.engine, 'gemini')
})

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

test('desktop preserves the global contextual word explanation toggle', () => {
  assert.equal(sanitizeExtensionYoutube({}).learning_ai_explanation, true)
  assert.equal(sanitizeExtensionYoutube({ learning_ai_explanation: false }).learning_ai_explanation, false)
})

test('desktop persists the selected translation word order', () => {
  assert.equal(sanitizeExtensionYoutube({}).learning_translation_mode, 'always')
  assert.equal(sanitizeExtensionYoutube({ learning_translation_mode: 'hover' }).learning_translation_mode, 'hover')
  assert.equal(sanitizeExtensionYoutube({ learning_translation_mode: 'never' }).learning_translation_mode, 'never')
  assert.equal(sanitizeExtensionYoutube({ learning_translation_mode: 'unknown' }).learning_translation_mode, 'always')
  assert.equal(sanitizeExtensionYoutube({}).learning_translation_order, 'natural')
  assert.equal(sanitizeExtensionYoutube({ learning_translation_order: 'source' }).learning_translation_order, 'source')
  assert.equal(sanitizeExtensionYoutube({ learning_translation_order: 'unknown' }).learning_translation_order, 'natural')
  assert.equal(sanitizeExtensionYoutube({}).learning_subtitle_language_order, 'source_first')
  assert.equal(sanitizeExtensionYoutube({ learning_subtitle_language_order: 'target_first' }).learning_subtitle_language_order, 'target_first')
  assert.equal(sanitizeExtensionYoutube({ learning_subtitle_language_order: 'unknown' }).learning_subtitle_language_order, 'source_first')
})

test('desktop keeps card autoplay off by default and persists opt-in', () => {
  assert.equal(sanitizeExtensionYoutube({}).learning_card_autoplay, false)
  assert.equal(sanitizeExtensionYoutube({ learning_card_autoplay: true }).learning_card_autoplay, true)
  assert.equal(sanitizeExtensionYoutube({ learning_subtitle_offset_x: 4 }).learning_subtitle_offset_x, 1)
  assert.equal(sanitizeExtensionYoutube({ learning_subtitle_offset_y: -4 }).learning_subtitle_offset_y, -1)
  assert.equal(sanitizeExtensionYoutube({}).learning_subtitle_width_px, 1600)
  assert.equal(sanitizeExtensionYoutube({ learning_subtitle_width_px: 9999 }).learning_subtitle_width_px, 2400)
  assert.equal(sanitizeExtensionYoutube({}).learning_subtitle_source_font_px, 34)
  assert.equal(sanitizeExtensionYoutube({}).learning_subtitle_target_font_px, 25)
  assert.equal(sanitizeExtensionYoutube({ learning_subtitle_source_font_px: 999 }).learning_subtitle_source_font_px, 64)
  assert.equal(sanitizeExtensionYoutube({ learning_subtitle_source_font_px: 1 }).learning_subtitle_source_font_px, 16)
  assert.equal(sanitizeExtensionYoutube({ learning_subtitle_target_font_px: 999 }).learning_subtitle_target_font_px, 52)
  assert.equal(sanitizeExtensionYoutube({ learning_subtitle_target_font_px: 1 }).learning_subtitle_target_font_px, 14)
})

test('desktop accepts current Chat o3 and Instant on GPT-5.6', () => {
  const o3 = sanitizeExtensionYoutube({
    chatgpt_chat_model: 'o3',
    chatgpt_chat_effort: 'medium',
  })
  assert.equal(o3.chatgpt_chat_model, 'o3')
  assert.equal(o3.chatgpt_chat_effort, 'medium')

  const instant = sanitizeExtensionYoutube({
    chatgpt_chat_model: '5.6-sol',
    chatgpt_chat_effort: 'instant',
  })
  assert.equal(instant.chatgpt_chat_effort, 'instant')
})

test('desktop defaults Work speed to standard and preserves explicit fast', () => {
  assert.equal(sanitizeExtensionYoutube({}).chatgpt_work_speed, 'standard')
  assert.equal(sanitizeExtensionYoutube({ chatgpt_work_speed: 'fast' }).chatgpt_work_speed, 'fast')
  assert.equal(sanitizeExtensionYoutube({ chatgpt_work_speed: 'unknown' }).chatgpt_work_speed, 'standard')
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

test('Boosty storage settings keep explicit folders and default video archive off', () => {
  assert.deepEqual(sanitizeBoostySettings({}), {
    audio_dir: '',
    video_dir: '',
    save_video: false,
  })
  assert.deepEqual(sanitizeBoostySettings({
    audio_dir: '  /Volumes/digma512/SC Desktop/Boosty/audio  ',
    video_dir: '/Volumes/digma512/SC Desktop/Boosty/video',
    save_video: true,
  }), {
    audio_dir: '/Volumes/digma512/SC Desktop/Boosty/audio',
    video_dir: '/Volumes/digma512/SC Desktop/Boosty/video',
    save_video: true,
  })
})

test('desktop patches only the Boosty settings section', () => {
  let stored = { telegram: { session: 'keep-me' } }
  const result = patchAppSettings(
    () => structuredClone(stored),
    next => { stored = structuredClone(next); return { ok: true } },
    { section: 'boosty', patch: { audio_dir: '/Volumes/digma512/audio', save_video: true } },
  )
  assert.equal(result.audio_dir, '/Volumes/digma512/audio')
  assert.equal(result.save_video, true)
  assert.equal(stored.telegram.session, 'keep-me')
})
