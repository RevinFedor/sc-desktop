const LIVE_OPERATIONS = new Set(['search', 'context', 'range'])
const LIVE_MEDIA_FILTERS = new Set([
  'all', 'photos', 'videos', 'photo_video', 'documents', 'voice', 'audio',
  'music', 'links', 'polls', 'gifs',
])

function intInRange(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

function cleanText(value, { required = false, max = 4000, label = 'value' } = {}) {
  const text = String(value == null ? '' : value).trim()
  if (required && !text) throw new Error(`${label} is required`)
  if (text.length > max) throw new Error(`${label} is too long (max ${max})`)
  return text
}

function cleanChat(value, label = 'chat') {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value))
  return cleanText(value, { required: true, max: 1000, label })
}

function cleanDate(value, label) {
  if (value == null || value === '') return null
  return cleanText(value, { required: true, max: 80, label })
}

function cleanSearch(raw, defaults = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const mediaFilter = cleanText(source.media_filter ?? defaults.media_filter ?? 'all', {
    max: 40,
    label: 'media_filter',
  }).toLowerCase() || 'all'
  if (!LIVE_MEDIA_FILTERS.has(mediaFilter)) {
    throw new Error(`unsupported media_filter: ${mediaFilter}`)
  }
  const sender = source.sender == null || source.sender === ''
    ? null
    : cleanText(source.sender, { required: true, max: 1000, label: 'sender' })
  const topicId = source.topic_id == null || source.topic_id === ''
    ? null
    : intInRange(source.topic_id, null, 1, Number.MAX_SAFE_INTEGER)
  return {
    chat: cleanChat(source.chat ?? defaults.chat),
    query: cleanText(source.query, { required: true, max: 4000, label: 'query' }),
    limit: intInRange(source.limit ?? defaults.limit, 20, 1, 100),
    offset_id: intInRange(source.offset_id ?? defaults.offset_id, 0, 0, Number.MAX_SAFE_INTEGER),
    date_from: cleanDate(source.date_from ?? defaults.date_from, 'date_from'),
    date_to: cleanDate(source.date_to ?? defaults.date_to, 'date_to'),
    sender,
    topic_id: topicId,
    media_filter: mediaFilter,
  }
}

function normalizeTelegramLiveRequest(raw = {}) {
  const operation = cleanText(raw.operation, { required: true, max: 30, label: 'operation' })
  if (!LIVE_OPERATIONS.has(operation)) throw new Error(`unsupported Telegram live operation: ${operation}`)

  const session = raw.session == null || raw.session === ''
    ? null
    : cleanText(raw.session, { required: true, max: 200, label: 'session' })
  const captionChars = intInRange(raw.caption_chars, operation === 'search' ? 1200 : 8000, 100, 8000)
  const common = { operation, session, caption_chars: captionChars }

  if (operation === 'search') {
    let searches = []
    if (Array.isArray(raw.searches) && raw.searches.length) {
      searches = raw.searches.map(search => cleanSearch(search, raw))
    } else if (Array.isArray(raw.chats) && raw.chats.length && Array.isArray(raw.queries) && raw.queries.length) {
      for (const chat of raw.chats) {
        for (const query of raw.queries) searches.push(cleanSearch({ chat, query }, raw))
      }
    } else {
      searches = [cleanSearch(raw, raw)]
    }
    if (searches.length > 60) throw new Error('too many live Telegram searches (max 60)')
    return {
      ...common,
      searches,
      concurrency: intInRange(raw.concurrency, 3, 1, 5),
      max_candidates: intInRange(raw.max_candidates, 250, 1, 500),
    }
  }

  if (operation === 'context') {
    const url = raw.url == null || raw.url === ''
      ? null
      : cleanText(raw.url, { required: true, max: 2000, label: 'url' })
    const chat = raw.chat == null || raw.chat === '' ? null : cleanChat(raw.chat)
    const messageId = raw.message_id == null || raw.message_id === ''
      ? null
      : intInRange(raw.message_id, null, 1, Number.MAX_SAFE_INTEGER)
    if (!url && (!chat || !messageId)) throw new Error('context requires url or chat + message_id')
    return {
      ...common,
      chat,
      url,
      message_id: messageId,
      before: intInRange(raw.before, 15, 0, 100),
      after: intInRange(raw.after, 15, 0, 100),
      max_depth: intInRange(raw.max_depth, 20, 0, 50),
      max_replies: intInRange(raw.max_replies, 100, 0, 500),
    }
  }

  const fromUrl = raw.from_url == null || raw.from_url === ''
    ? null
    : cleanText(raw.from_url, { required: true, max: 2000, label: 'from_url' })
  const toUrl = raw.to_url == null || raw.to_url === ''
    ? null
    : cleanText(raw.to_url, { required: true, max: 2000, label: 'to_url' })
  const chat = raw.chat == null || raw.chat === '' ? null : cleanChat(raw.chat)
  const fromId = raw.from_id == null || raw.from_id === ''
    ? null
    : intInRange(raw.from_id, null, 1, Number.MAX_SAFE_INTEGER)
  const toId = raw.to_id == null || raw.to_id === ''
    ? null
    : intInRange(raw.to_id, null, 1, Number.MAX_SAFE_INTEGER)
  if (!(fromUrl && toUrl) && !(chat && fromId && toId)) {
    throw new Error('range requires from_url + to_url or chat + from_id + to_id')
  }
  return {
    ...common,
    chat,
    from_url: fromUrl,
    to_url: toUrl,
    from_id: fromId,
    to_id: toId,
    max_messages: intInRange(raw.max_messages, 1000, 1, 5000),
  }
}

function telegramLiveJobType(operation) {
  return `tg_live_${operation}`
}

function telegramLiveTarget(request) {
  if (request.operation === 'search') {
    const chats = [...new Set(request.searches.map(search => search.chat))]
    return chats.length === 1 ? chats[0] : `${chats.length} Telegram-чатов`
  }
  if (request.chat) return request.chat
  return request.url || request.from_url || 'Telegram'
}

function createTelegramLiveState(request) {
  const total = request.operation === 'search'
    ? request.searches.length
    : request.operation === 'range'
      ? null
      : 1
  return {
    operation: request.operation,
    stage: 'starting',
    steps_done: 0,
    steps_total: total,
    hits: 0,
    unique_hits: 0,
    result_available: false,
    truncated: false,
    duration_ms: null,
  }
}

function applyTelegramLiveEvent(job, event) {
  if (!job || !event || typeof event !== 'object') return false
  const state = job.tg_live || (job.tg_live = createTelegramLiveState(job.params || {}))
  switch (event.type) {
    case 'started':
      state.stage = 'running'
      if (event.total_steps != null) {
        state.steps_total = intInRange(event.total_steps, state.steps_total, 0, 100000)
        job.items_total = state.steps_total || null
      }
      return true
    case 'entity':
      if (!job.entity_title && event.chat?.title) job.entity_title = event.chat.title
      if (!job.entity_kind && event.chat?.kind) job.entity_kind = event.chat.kind
      return true
    case 'progress':
      state.stage = cleanText(event.stage || 'running', { max: 80 }) || 'running'
      state.steps_done = intInRange(event.done, state.steps_done, 0, 100000)
      state.steps_total = intInRange(event.total, state.steps_total, 0, 100000)
      state.hits = intInRange(event.hits, state.hits, 0, 1000000)
      state.unique_hits = intInRange(event.unique_hits, state.unique_hits, 0, 1000000)
      job.items_done = state.steps_done
      job.items_total = state.steps_total || null
      return true
    case 'result': {
      const result = event.result && typeof event.result === 'object' ? event.result : {}
      job._tgLiveResult = result
      state.stage = 'done'
      state.result_available = true
      state.hits = intInRange(result.hits, state.hits, 0, 1000000)
      state.unique_hits = intInRange(result.unique_hits, state.unique_hits, 0, 1000000)
      state.truncated = result.truncated === true
      if (result.messages && Array.isArray(result.messages)) {
        state.unique_hits = result.messages.length
      }
      return true
    }
    case 'done':
      state.stage = 'done'
      state.duration_ms = intInRange(event.duration_ms, null, 0, Number.MAX_SAFE_INTEGER)
      if (event.hits != null) state.hits = intInRange(event.hits, state.hits, 0, 1000000)
      if (event.unique_hits != null) state.unique_hits = intInRange(event.unique_hits, state.unique_hits, 0, 1000000)
      state.steps_done = state.steps_total || state.steps_done
      job.items_done = state.unique_hits || state.steps_done
      job.items_total = state.unique_hits || state.steps_total || null
      return true
    case 'error':
      job.error = cleanText(event.message || 'Telegram live request failed', { max: 4000 })
      if (event.code) job.error_code = cleanText(event.code, { max: 120 })
      state.stage = 'error'
      return false
    default:
      return false
  }
}

function publicTelegramLiveState(state) {
  if (!state) return null
  return {
    operation: state.operation || null,
    stage: state.stage || null,
    steps_done: Number(state.steps_done || 0),
    steps_total: state.steps_total == null ? null : Number(state.steps_total),
    hits: Number(state.hits || 0),
    unique_hits: Number(state.unique_hits || 0),
    result_available: state.result_available === true,
    truncated: state.truncated === true,
    duration_ms: state.duration_ms == null ? null : Number(state.duration_ms),
  }
}

module.exports = {
  LIVE_MEDIA_FILTERS,
  normalizeTelegramLiveRequest,
  telegramLiveJobType,
  telegramLiveTarget,
  createTelegramLiveState,
  applyTelegramLiveEvent,
  publicTelegramLiveState,
}
