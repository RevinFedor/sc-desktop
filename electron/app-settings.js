const YOUTUBE_MODELS = new Set([
  'Gemini 3 Flash Preview',
  'Gemini 3.1 Pro Preview',
])
const CLAUDE_MODELS = new Set(['Opus 4.7', 'Sonnet 4.6', 'Haiku 4.5'])
const CHATGPT_CHAT_MODELS = new Set(['6', '6-astra', '5.6-sol', '5.5'])
const CHATGPT_WORK_MODELS = new Set(['5.6-sol', '5.6-terra', '5.6-luna'])
const CHATGPT_RETIRED_MODELS = new Set(['o3', '5.4', '5.3', '5.2', '4.5'])
const CHATGPT_KNOWN_MODELS = new Set([
  ...CHATGPT_CHAT_MODELS,
  ...CHATGPT_WORK_MODELS,
  '5.6',
  ...CHATGPT_RETIRED_MODELS,
])
const CHATGPT_EFFORTS = new Set([
  'low', 'xhigh', 'high', 'medium', 'instant', 'pro', 'pro-extended', 'max', 'ultra',
])
const CHATGPT_CHAT_55_EFFORTS = new Set(['instant'])
const CHATGPT_CHAT_6_ASTRA_EFFORTS = new Set(['pro'])
const CHATGPT_CHAT_56_EFFORTS = new Set(['instant', 'medium', 'high', 'xhigh', 'pro'])
const CHATGPT_WORK_56_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const CHATGPT_WORK_SPEEDS = new Set(['standard', 'fast'])
const YOUTUBE_SUBTITLE_POSITIONS = new Set(['top', 'bottom'])
const YOUTUBE_SUBTITLE_LANGUAGE_ORDERS = new Set(['source_first', 'target_first'])
const YOUTUBE_TRANSLATION_MODES = new Set(['never', 'always'])
const YOUTUBE_TRANSLATION_ORDERS = new Set(['natural', 'source'])
const EXTENSION_YOUTUBE_SCHEMA_VERSION = 2

const EXTENSION_YOUTUBE_DEFAULTS = Object.freeze({
  auto_aistudio: false,
  with_comments: false,
  preferred_lang: 'ru',
  learning_enabled: true,
  learning_target_lang: 'ru',
  learning_auto_pause: false,
  learning_subtitle_position: 'bottom',
  learning_subtitle_language_order: 'source_first',
  learning_subtitle_offset_x: 0,
  learning_subtitle_offset_y: 0,
  learning_subtitle_width_px: 1600,
  learning_subtitle_source_font_px: 34,
  learning_subtitle_target_font_px: 25,
  learning_subtitle_target_font_percent: 73.53,
  learning_controls_mirrored: false,
  learning_translation_mode: 'always',
  learning_translation_order: 'natural',
  learning_hide_native_subtitles: true,
  learning_hover_word_translation: false,
  learning_ai_explanation: true,
  learning_card_autoplay: false,
  learning_practice_hide_translations: true,
  engine: 'gemini',
  target: 'aistudio',
  system_instruction: '',
  post_system_instruction: '',
  model_title: 'Gemini 3 Flash Preview',
  post_model_title: 'Gemini 3.1 Pro Preview',
  claude_project: '',
  claude_post_project: '',
  claude_model: 'Opus 4.7',
  claude_adaptive_thinking: true,
  chatgpt_mode: 'chat',
  chatgpt_prompt: 'перескажи кратко',
  chatgpt_show_in_text_field: true,
  chatgpt_chat_model: '5.6-sol',
  chatgpt_chat_effort: 'xhigh',
  chatgpt_work_model: '5.6-sol',
  chatgpt_work_effort: 'xhigh',
  chatgpt_work_speed: 'standard',
  // Compatibility aliases. They always mirror the currently selected mode.
  chatgpt_model: '5.6-sol',
  chatgpt_effort: 'xhigh',
})

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value, fallback, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback
}

function enumValue(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

function booleanValue(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function clampedNumberValue(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function storagePathValue(value) {
  return typeof value === 'string' ? value.trim().slice(0, 2048) : ''
}

function sanitizeBoostySettings(raw = {}) {
  const input = isPlainObject(raw) ? raw : {}
  return {
    audio_dir: storagePathValue(input.audio_dir),
    video_dir: storagePathValue(input.video_dir),
    save_video: booleanValue(input.save_video, false),
  }
}

function chatgptModelsForMode(mode) {
  return mode === 'work' ? CHATGPT_WORK_MODELS : CHATGPT_CHAT_MODELS
}

function chatgptEffortsFor(mode, model) {
  if (mode === 'work') return CHATGPT_WORK_56_EFFORTS
  if (model === '6-astra') return CHATGPT_CHAT_6_ASTRA_EFFORTS
  if (model === '5.5') return CHATGPT_CHAT_55_EFFORTS
  return CHATGPT_CHAT_56_EFFORTS
}

function defaultChatgptEffort(mode, model) {
  if (mode === 'chat' && model === '6-astra') return 'pro'
  if (mode === 'chat' && model === '5.5') return 'instant'
  return 'xhigh'
}

function normalizeChatgptPair(mode, rawModel, rawEffort) {
  let model = typeof rawModel === 'string' ? rawModel : '5.6-sol'
  let effort = typeof rawEffort === 'string' ? rawEffort : ''

  if (model === 'gpt-6-astra') model = '6-astra'
  if (['gpt-6', '6'].includes(model)) model = mode === 'work' ? '6-astra' : '6'
  if (model === '5.6') model = '5.6-sol'
  if (effort === 'pro-extended') effort = 'pro'
  if (mode === 'work') {
    if (model === '5.5' || CHATGPT_RETIRED_MODELS.has(model)) model = '5.6-sol'
  } else {
    if (CHATGPT_RETIRED_MODELS.has(model)) model = effort === 'instant' ? '5.5' : '5.6-sol'
    if (model === '5.5' && effort && effort !== 'instant') model = '5.6-sol'
  }

  if (!chatgptModelsForMode(mode).has(model)) model = '5.6-sol'
  if (!chatgptEffortsFor(mode, model).has(effort)) effort = defaultChatgptEffort(mode, model)
  return { model, effort }
}

function subtitleFontSettings(raw = {}) {
  const source = Math.round(clampedNumberValue(raw.learning_subtitle_source_font_px, 34, 16, 64))
  const legacyTarget = Math.round(clampedNumberValue(raw.learning_subtitle_target_font_px, 25, 14, 52))
  const supplied = Number(raw.learning_subtitle_target_font_percent)
  const percent = Math.round(Math.max(20, Math.min(325,
    Number.isFinite(supplied) && supplied > 0 ? supplied : legacyTarget * 100 / source)) * 100) / 100
  return {
    learning_subtitle_source_font_px: source,
    learning_subtitle_target_font_percent: percent,
    learning_subtitle_target_font_px: Math.max(14, Math.min(52, Math.round(source * percent / 100))),
  }
}

function sanitizeExtensionYoutube(raw = {}) {
  const input = isPlainObject(raw) ? raw : {}
  const mode = enumValue(input.chatgpt_mode, new Set(['chat', 'work']), 'chat')
  // The legacy flat pair predates Work and therefore migrates into Chat.
  const legacyPair = normalizeChatgptPair('chat', input.chatgpt_model, input.chatgpt_effort)
  const chatPair = normalizeChatgptPair(
    'chat',
    input.chatgpt_chat_model ?? legacyPair.model,
    input.chatgpt_chat_effort ?? legacyPair.effort,
  )
  const workPair = normalizeChatgptPair('work', input.chatgpt_work_model, input.chatgpt_work_effort)
  const result = {
    ...EXTENSION_YOUTUBE_DEFAULTS,
    auto_aistudio: booleanValue(input.auto_aistudio, false),
    with_comments: booleanValue(input.with_comments, false),
    preferred_lang: stringValue(input.preferred_lang, 'ru', 32).trim() || 'ru',
    learning_enabled: booleanValue(input.learning_enabled, true),
    learning_target_lang: stringValue(input.learning_target_lang, 'ru', 32).trim() || 'ru',
    learning_auto_pause: booleanValue(input.learning_auto_pause, false),
    learning_subtitle_position: enumValue(
      input.learning_subtitle_position,
      YOUTUBE_SUBTITLE_POSITIONS,
      'bottom',
    ),
    learning_subtitle_language_order: enumValue(
      input.learning_subtitle_language_order,
      YOUTUBE_SUBTITLE_LANGUAGE_ORDERS,
      'source_first',
    ),
    learning_subtitle_offset_x: clampedNumberValue(input.learning_subtitle_offset_x, 0, -1, 1),
    learning_subtitle_offset_y: clampedNumberValue(input.learning_subtitle_offset_y, 0, -1, 1),
    learning_subtitle_width_px: Math.round(clampedNumberValue(input.learning_subtitle_width_px, 1600, 320, 2400)),
    ...subtitleFontSettings(input),
    learning_controls_mirrored: booleanValue(input.learning_controls_mirrored, false),
    learning_translation_mode: enumValue(
      input.learning_translation_mode === 'hover' ? 'never' : input.learning_translation_mode,
      YOUTUBE_TRANSLATION_MODES,
      'always',
    ),
    learning_translation_order: enumValue(
      input.learning_translation_order,
      YOUTUBE_TRANSLATION_ORDERS,
      'natural',
    ),
    learning_hide_native_subtitles: booleanValue(input.learning_hide_native_subtitles, true),
    learning_hover_word_translation: booleanValue(input.learning_hover_word_translation, false),
    learning_ai_explanation: booleanValue(input.learning_ai_explanation, true),
    learning_card_autoplay: booleanValue(input.learning_card_autoplay, false),
    learning_practice_hide_translations: booleanValue(input.learning_practice_hide_translations, true),
    engine: enumValue(input.engine, new Set(['gemini', 'assemblyai']), 'gemini'),
    target: enumValue(input.target, new Set(['aistudio', 'claude', 'chatgpt']), 'aistudio'),
    system_instruction: stringValue(input.system_instruction, '', 8000),
    post_system_instruction: stringValue(input.post_system_instruction, '', 8000),
    model_title: enumValue(input.model_title, YOUTUBE_MODELS, 'Gemini 3 Flash Preview'),
    post_model_title: input.post_model_title === ''
      ? ''
      : enumValue(input.post_model_title, YOUTUBE_MODELS, 'Gemini 3.1 Pro Preview'),
    claude_project: stringValue(input.claude_project, '', 200),
    claude_post_project: stringValue(input.claude_post_project, '', 200),
    claude_model: enumValue(input.claude_model, CLAUDE_MODELS, 'Opus 4.7'),
    claude_adaptive_thinking: booleanValue(input.claude_adaptive_thinking, true),
    chatgpt_mode: mode,
    chatgpt_prompt: stringValue(input.chatgpt_prompt, 'перескажи кратко', 4000),
    chatgpt_show_in_text_field: booleanValue(input.chatgpt_show_in_text_field, true),
    chatgpt_chat_model: chatPair.model,
    chatgpt_chat_effort: chatPair.effort,
    // The legacy flat pair belonged to ordinary Chat. Work did not exist yet,
    // so its first migration starts from explicit Work defaults.
    chatgpt_work_model: workPair.model,
    chatgpt_work_effort: workPair.effort,
    chatgpt_work_speed: enumValue(input.chatgpt_work_speed, CHATGPT_WORK_SPEEDS, 'standard'),
  }
  result.chatgpt_model = mode === 'work' ? result.chatgpt_work_model : result.chatgpt_chat_model
  result.chatgpt_effort = mode === 'work' ? result.chatgpt_work_effort : result.chatgpt_chat_effort
  return result
}

function effectiveExtensionYoutubePatch(current, patch) {
  const effective = { ...patch }
  const mode = enumValue(effective.chatgpt_mode, new Set(['chat', 'work']), current.chatgpt_mode)
  // Older popup/content versions only know the flat pair. Treat it as the
  // selected mode's pair instead of letting already-materialized defaults
  // shadow it during a merge.
  if (Object.hasOwn(effective, 'chatgpt_model')) {
    const key = `chatgpt_${mode}_model`
    if (!Object.hasOwn(effective, key)) effective[key] = effective.chatgpt_model
  }
  if (Object.hasOwn(effective, 'chatgpt_effort')) {
    const key = `chatgpt_${mode}_effort`
    if (!Object.hasOwn(effective, key)) effective[key] = effective.chatgpt_effort
  }
  return effective
}

function applyExtensionYoutubePatch(current, patch) {
  const font = subtitleFontSettings(current)
  const effective = effectiveExtensionYoutubePatch(current, patch)
  if (Object.hasOwn(patch, 'learning_subtitle_target_font_px')
      && !Object.hasOwn(patch, 'learning_subtitle_target_font_percent')
      && Number(patch.learning_subtitle_target_font_px) !== font.learning_subtitle_target_font_px) {
    effective.learning_subtitle_target_font_percent = subtitleFontSettings({
      ...current, ...patch, learning_subtitle_target_font_percent: undefined,
    }).learning_subtitle_target_font_percent
  }
  return sanitizeExtensionYoutube({
    ...current,
    learning_subtitle_target_font_percent: font.learning_subtitle_target_font_percent,
    ...effective,
  })
}

const FORWARD_ENUM_KEYS = new Set([
  'engine', 'target', 'model_title', 'post_model_title', 'claude_model',
  'chatgpt_mode', 'chatgpt_model', 'chatgpt_effort',
  'chatgpt_chat_model', 'chatgpt_chat_effort',
  'chatgpt_work_model', 'chatgpt_work_effort', 'chatgpt_work_speed',
  'learning_subtitle_position', 'learning_subtitle_language_order', 'learning_translation_mode', 'learning_translation_order',
])

const FORWARD_ENUM_VALUES = Object.freeze({
  engine: new Set(['gemini', 'assemblyai']),
  target: new Set(['aistudio', 'claude', 'chatgpt']),
  model_title: YOUTUBE_MODELS,
  post_model_title: new Set(['', ...YOUTUBE_MODELS]),
  claude_model: CLAUDE_MODELS,
  chatgpt_mode: new Set(['chat', 'work']),
  chatgpt_model: CHATGPT_KNOWN_MODELS,
  chatgpt_effort: CHATGPT_EFFORTS,
  chatgpt_chat_model: CHATGPT_KNOWN_MODELS,
  chatgpt_chat_effort: CHATGPT_EFFORTS,
  chatgpt_work_model: CHATGPT_KNOWN_MODELS,
  chatgpt_work_effort: CHATGPT_EFFORTS,
  chatgpt_work_speed: CHATGPT_WORK_SPEEDS,
  learning_subtitle_position: YOUTUBE_SUBTITLE_POSITIONS,
  learning_subtitle_language_order: YOUTUBE_SUBTITLE_LANGUAGE_ORDERS,
  learning_translation_mode: YOUTUBE_TRANSLATION_MODES,
  learning_translation_order: YOUTUBE_TRANSLATION_ORDERS,
})

function isFutureEnumValue(key, value) {
  return FORWARD_ENUM_KEYS.has(key) &&
    typeof value === 'string' &&
    !FORWARD_ENUM_VALUES[key]?.has(value)
}

function extensionYoutubeSchemaState(settings) {
  const version = settings?.browser_extension?.youtube_schema_version
  const numericVersion = Number(version)
  const raw = isPlainObject(settings?.browser_extension?.youtube)
    ? settings.browser_extension.youtube
    : null
  return {
    version,
    raw,
    initialized: version === EXTENSION_YOUTUBE_SCHEMA_VERSION && !!raw,
    incompatible: Number.isFinite(numericVersion) && numericVersion > EXTENSION_YOUTUBE_SCHEMA_VERSION,
  }
}

function incompatibleExtensionSchemaError(version) {
  const error = new Error(
    `YouTube extension settings use schema ${version}; this desktop supports ${EXTENSION_YOUTUBE_SCHEMA_VERSION}`,
  )
  error.code = 'extension_settings_schema_incompatible'
  error.schemaVersion = version
  error.supportedSchemaVersion = EXTENSION_YOUTUBE_SCHEMA_VERSION
  return error
}

function persistedExtensionYoutube(raw, patch, next, initialize, deriveAliases = true) {
  const effective = effectiveExtensionYoutubePatch(next, patch)
  const persisted = initialize ? { ...(raw || {}), ...next } : { ...(raw || {}) }
  if (initialize && raw) {
    for (const key of FORWARD_ENUM_KEYS) {
      const value = raw[key]
      if (isFutureEnumValue(key, value)) {
        persisted[key] = value.slice(0, 200)
      }
    }
  }
  for (const [key, value] of Object.entries(effective)) {
    // Preserve a future enum value that this desktop build does not yet
    // understand. An unrelated edit must not downgrade Opus/GPT/Gemini names
    // written by a newer extension. Known values and free text still go
    // through the current sanitizer/caps.
    if (isFutureEnumValue(key, value)) {
      persisted[key] = value.slice(0, 200)
    } else if (Object.hasOwn(next, key)) {
      persisted[key] = next[key]
    } else {
      persisted[key] = value
    }
  }
  // Materialize the ratio before the next read: persisting only a changed
  // source size would recompute it from the stale legacy absolute size.
  if (['learning_subtitle_source_font_px', 'learning_subtitle_target_font_px',
    'learning_subtitle_target_font_percent'].some(key => Object.hasOwn(effective, key))) {
    Object.assign(persisted, subtitleFontSettings(next))
  }
  const changesChatgptPair = Object.keys(effective).some(key => (
    key === 'chatgpt_mode' || /chatgpt_(?:chat_|work_)?(?:model|effort)$/.test(key)
  ))
  if (deriveAliases && (initialize || changesChatgptPair)) {
    const unknownFlatModel = (
      isFutureEnumValue('chatgpt_model', effective.chatgpt_model)
    ) || (
      initialize && isFutureEnumValue('chatgpt_model', raw?.chatgpt_model)
    )
    const unknownFlatEffort = (
      isFutureEnumValue('chatgpt_effort', effective.chatgpt_effort)
    ) || (
      initialize && isFutureEnumValue('chatgpt_effort', raw?.chatgpt_effort)
    )
    if (!unknownFlatModel) persisted.chatgpt_model = next.chatgpt_model
    if (!unknownFlatEffort) persisted.chatgpt_effort = next.chatgpt_effort
  }
  if (deriveAliases) {
    const explicitEngine = Object.hasOwn(effective, 'engine')
      ? effective.engine
      : raw?.engine
    if (!isFutureEnumValue('engine', explicitEngine)) persisted.engine = next.engine
    persisted.preferred_lang = next.preferred_lang
  }
  return persisted
}

function extensionYoutubeFromSettings(settings) {
  const raw = settings?.browser_extension?.youtube
  const pending = settings?.browser_extension?.youtube_desktop_pending
  const fallbackEngine = settings?.youtube?.engine
  const fallbackLanguage = settings?.youtube?.preferred_lang
  return sanitizeExtensionYoutube({
    ...(isPlainObject(raw) ? raw : {}),
    ...(isPlainObject(pending) ? pending : {}),
    // These two settings predate the extension bridge and remain part of the
    // shared CLI contract. A CLI edit must be visible on the next read even
    // when the extension block already exists.
    engine: fallbackEngine ?? raw?.engine,
    preferred_lang: fallbackLanguage ?? raw?.preferred_lang,
  })
}

function instagramBackends(instagram = {}) {
  const legacy = instagram.backend
  const legacyMapped = legacy === 'android' ? 'api' : legacy
  return {
    metadata_backend: enumValue(
      instagram.metadata_backend ?? legacyMapped,
      new Set(['api', 'apify']),
      'api',
    ),
    transcribe_backend: enumValue(
      instagram.transcribe_backend,
      new Set(['api', 'apify']),
      'api',
    ),
  }
}

function publicAppSettings(settings = {}) {
  const main = isPlainObject(settings.main) ? settings.main : {}
  const youtubeCore = isPlainObject(settings.youtube) ? settings.youtube : {}
  const extensionYoutube = extensionYoutubeFromSettings(settings)
  const telegram = isPlainObject(settings.telegram) ? settings.telegram : {}
  const instagram = isPlainObject(settings.instagram) ? settings.instagram : {}
  const instagramResolved = instagramBackends(instagram)
  const reddit = isPlainObject(settings.reddit) ? settings.reddit : {}
  const tiktok = isPlainObject(settings.tiktok) ? settings.tiktok : {}
  const boosty = sanitizeBoostySettings(settings.boosty)

  return {
    main: {
      configured: true,
      external_research_auto_close: booleanValue(main.external_research_auto_close, true),
      external_research_temporary_chat: booleanValue(main.external_research_temporary_chat, true),
      youtube_ai_temporary_chat: booleanValue(main.youtube_ai_temporary_chat, true),
    },
    telegram: {
      session: typeof telegram.session === 'string' ? telegram.session : null,
      // Source-level auto rules already require an explicit opt-in.  This
      // master gate preserves the existing behaviour for old settings files
      // while giving the desktop UI one immediate kill-switch for every
      // scheduled Telegram request.
      auto_enabled: booleanValue(telegram.auto_enabled, true),
      engine: enumValue(telegram.engine, new Set(['gemini', 'assemblyai']), 'gemini'),
      model: stringValue(telegram.model, 'gemini-2.5-flash', 120),
      max_preview_items: Number.isFinite(Number(telegram.max_preview_items))
        ? Math.max(1, Math.min(500, Math.round(Number(telegram.max_preview_items))))
        : 30,
    },
    youtube: {
      preferred_lang: extensionYoutube.preferred_lang,
      video_codec: stringValue(youtubeCore.video_codec, 'h264', 40),
      ...extensionYoutube,
      translator_configured: typeof settings?.api_keys?.AZURE_TRANSLATOR_KEY === 'string'
        && settings.api_keys.AZURE_TRANSLATOR_KEY.trim().length > 0,
      translator_region: stringValue(settings?.azure_translator?.region, '', 80),
    },
    instagram: {
      metadata_backend: instagramResolved.metadata_backend,
      transcribe_backend: instagramResolved.transcribe_backend,
      download_videos: booleanValue(instagram.download_videos, false),
      apify_token_set: typeof instagram.apify_token === 'string' && instagram.apify_token.trim().length > 0,
    },
    reddit: {
      backend: enumValue(reddit.backend, new Set(['api', 'auto', 'apify']), 'api'),
    },
    tiktok: {
      preferred_engine: enumValue(tiktok.preferred_engine, new Set(['tikwm', 'yt-dlp']), 'tikwm'),
    },
    boosty,
    twitter: {
      available: false,
    },
  }
}

function patchExtensionYoutubeSettings(readScSettings, writeScSettings, patch = {}) {
  if (!isPlainObject(patch)) throw new Error('YouTube settings patch must be an object')
  const settings = readScSettings()
  const schema = extensionYoutubeSchemaState(settings)
  if (schema.incompatible) throw incompatibleExtensionSchemaError(schema.version)
  const rawExtension = schema.raw
  const desktopPending = isPlainObject(settings?.browser_extension?.youtube_desktop_pending)
    ? settings.browser_extension.youtube_desktop_pending
    : {}
  const initialized = schema.initialized
  const current = extensionYoutubeFromSettings(settings)
  const effectivePatch = { ...patch }
  if (!initialized) {
    // First extension bootstrap imports its historic chrome.storage values,
    // but the desktop's already-existing shared subtitle choices remain
    // authoritative for the two fields that predate this bridge.
    if (typeof settings?.youtube?.engine === 'string') delete effectivePatch.engine
    if (typeof settings?.youtube?.preferred_lang === 'string') delete effectivePatch.preferred_lang
  }
  const imported = applyExtensionYoutubePatch(current, effectivePatch)
  // Explicit desktop edits made before the extension's first bootstrap win
  // only for their own keys; all other historic chrome.storage values survive.
  const next = applyExtensionYoutubePatch(imported, desktopPending)
  const combinedPatch = { ...effectivePatch, ...desktopPending }
  settings.browser_extension = isPlainObject(settings.browser_extension) ? settings.browser_extension : {}
  settings.browser_extension.youtube_schema_version = EXTENSION_YOUTUBE_SCHEMA_VERSION
  settings.browser_extension.youtube = persistedExtensionYoutube(
    rawExtension,
    combinedPatch,
    next,
    !initialized,
  )
  delete settings.browser_extension.youtube_desktop_pending
  settings.youtube = isPlainObject(settings.youtube) ? settings.youtube : {}
  // The fallback transcription engine is one product choice in both the
  // desktop paste flow and the browser-extension flow.
  settings.youtube.engine = next.engine
  settings.youtube.preferred_lang = next.preferred_lang
  const result = writeScSettings(settings)
  if (!result?.ok) throw new Error(result?.error || 'Unable to save settings')
  return next
}

function patchAppSettings(readScSettings, writeScSettings, payload = {}) {
  const section = String(payload.section || '')
  const patch = isPlainObject(payload.patch) ? payload.patch : null
  if (!patch) throw new Error('Settings patch must be an object')

  if (section === 'youtube') {
    const settings = readScSettings()
    const schema = extensionYoutubeSchemaState(settings)
    settings.youtube = isPlainObject(settings.youtube) ? settings.youtube : {}
    if (typeof patch.preferred_lang === 'string') {
      settings.youtube.preferred_lang = patch.preferred_lang.slice(0, 20)
    }
    if (typeof patch.video_codec === 'string') {
      settings.youtube.video_codec = patch.video_codec.slice(0, 40)
    }
    if (typeof patch.engine === 'string') {
      settings.youtube.engine = enumValue(patch.engine, new Set(['gemini', 'assemblyai']), settings.youtube.engine || 'gemini')
    }
    const extensionPatch = { ...patch }
    delete extensionPatch.video_codec
    const rawExtension = schema.raw
    const initialized = schema.initialized
    const desktopPending = isPlainObject(settings?.browser_extension?.youtube_desktop_pending)
      ? settings.browser_extension.youtube_desktop_pending
      : {}
    const currentExtension = extensionYoutubeFromSettings(settings)
    const nextExtension = applyExtensionYoutubePatch(currentExtension, extensionPatch)
    const extensionOnlyKeys = Object.keys(extensionPatch)
      .filter(key => key !== 'engine' && key !== 'preferred_lang')
    if (schema.incompatible && extensionOnlyKeys.length > 0) {
      throw incompatibleExtensionSchemaError(schema.version)
    }
    if (initialized) {
      settings.browser_extension = isPlainObject(settings.browser_extension) ? settings.browser_extension : {}
      settings.browser_extension.youtube_schema_version = EXTENSION_YOUTUBE_SCHEMA_VERSION
      settings.browser_extension.youtube = persistedExtensionYoutube(
        rawExtension,
        extensionPatch,
        nextExtension,
        !rawExtension,
      )
      settings.youtube.engine = nextExtension.engine
      settings.youtube.preferred_lang = nextExtension.preferred_lang
    } else if (extensionOnlyKeys.length > 0) {
      settings.browser_extension = isPlainObject(settings.browser_extension) ? settings.browser_extension : {}
      settings.browser_extension.youtube_desktop_pending = persistedExtensionYoutube(
        desktopPending,
        extensionPatch,
        nextExtension,
        false,
        false,
      )
    }
    const result = writeScSettings(settings)
    if (!result?.ok) throw new Error(result?.error || 'Unable to save settings')
    return publicAppSettings(settings).youtube
  }

  const settings = readScSettings()
  if (section === 'main') {
    settings.main = isPlainObject(settings.main) ? settings.main : {}
    if (typeof patch.external_research_auto_close === 'boolean') {
      settings.main.external_research_auto_close = patch.external_research_auto_close
    }
    if (typeof patch.external_research_temporary_chat === 'boolean') {
      settings.main.external_research_temporary_chat = patch.external_research_temporary_chat
    }
    if (typeof patch.youtube_ai_temporary_chat === 'boolean') {
      settings.main.youtube_ai_temporary_chat = patch.youtube_ai_temporary_chat
    }
  } else if (section === 'reddit') {
    settings.reddit = isPlainObject(settings.reddit) ? settings.reddit : {}
    settings.reddit.backend = enumValue(patch.backend, new Set(['api', 'auto', 'apify']), settings.reddit.backend || 'api')
  } else if (section === 'telegram') {
    settings.telegram = isPlainObject(settings.telegram) ? settings.telegram : {}
    if (typeof patch.auto_enabled === 'boolean') settings.telegram.auto_enabled = patch.auto_enabled
    if (typeof patch.engine === 'string') settings.telegram.engine = enumValue(patch.engine, new Set(['gemini', 'assemblyai']), settings.telegram.engine || 'gemini')
    if (typeof patch.model === 'string') settings.telegram.model = patch.model.slice(0, 120)
    if (Number.isFinite(Number(patch.max_preview_items))) settings.telegram.max_preview_items = Math.max(1, Math.min(500, Math.round(Number(patch.max_preview_items))))
  } else if (section === 'instagram') {
    settings.instagram = isPlainObject(settings.instagram) ? settings.instagram : {}
    if (Object.hasOwn(patch, 'metadata_backend') || Object.hasOwn(patch, 'transcribe_backend')) {
      const resolved = instagramBackends(settings.instagram)
      settings.instagram.metadata_backend = resolved.metadata_backend
      settings.instagram.transcribe_backend = resolved.transcribe_backend
      delete settings.instagram.backend
    }
    if (typeof patch.metadata_backend === 'string') settings.instagram.metadata_backend = enumValue(patch.metadata_backend, new Set(['api', 'apify']), settings.instagram.metadata_backend || 'api')
    if (typeof patch.transcribe_backend === 'string') settings.instagram.transcribe_backend = enumValue(patch.transcribe_backend, new Set(['api', 'apify']), settings.instagram.transcribe_backend || 'api')
    if (typeof patch.download_videos === 'boolean') settings.instagram.download_videos = patch.download_videos
  } else if (section === 'boosty') {
    settings.boosty = isPlainObject(settings.boosty) ? settings.boosty : {}
    if (typeof patch.audio_dir === 'string') settings.boosty.audio_dir = storagePathValue(patch.audio_dir)
    if (typeof patch.video_dir === 'string') settings.boosty.video_dir = storagePathValue(patch.video_dir)
    if (typeof patch.save_video === 'boolean') settings.boosty.save_video = patch.save_video
  } else {
    throw new Error(`Settings section is not editable: ${section}`)
  }

  const result = writeScSettings(settings)
  if (!result?.ok) throw new Error(result?.error || 'Unable to save settings')
  return publicAppSettings(settings)[section]
}

module.exports = {
  EXTENSION_YOUTUBE_SCHEMA_VERSION,
  EXTENSION_YOUTUBE_DEFAULTS,
  sanitizeExtensionYoutube,
  sanitizeBoostySettings,
  extensionYoutubeFromSettings,
  extensionYoutubeSchemaState,
  publicAppSettings,
  patchExtensionYoutubeSettings,
  patchAppSettings,
}
