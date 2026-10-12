const LIVE_OPERATIONS = new Set([
  'search', 'public_search', 'context', 'range', 'attachment', 'transcribe',
  'join', 'leave',
  'bot_info', 'bot_messages', 'bot_action', 'bot_action_status',
  'membership_info',
  'folder_read', 'folder_merge', 'folder_merge_status',
  'bot_join', 'bot_join_status',
])
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

function cleanLanguageHints(value) {
  if (value == null) return ['ru', 'en']
  if (!Array.isArray(value)) throw new Error('language_hints must be an array')
  const out = []
  for (const raw of value) {
    const hint = cleanText(raw, { required: true, max: 16, label: 'language hint' }).toLowerCase()
    if (!out.includes(hint)) out.push(hint)
    if (out.length >= 5) break
  }
  return out.length ? out : ['ru', 'en']
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

  if (operation.startsWith('folder_')) {
    if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Error('Folder operations require an exact session')
    if ((!Number.isSafeInteger(raw.expected_account_id) && typeof raw.expected_account_id !== 'string')
        || !/^[1-9][0-9]*$/.test(String(raw.expected_account_id))) throw new Error('Exact expected_account_id is required')
    if (raw.title !== 'ВУ') throw new Error('Only exact Cyrillic ВУ is authorized, not BY/VU or a list index')
    const value = { ...common, title: 'ВУ', expected_account_id: String(raw.expected_account_id) }
    if (operation !== 'folder_read') {
      if (typeof raw.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw.request_id)) throw new Error('A stable request_id is required')
      value.request_id = raw.request_id
    }
    if (operation === 'folder_merge_status') return value
    if (operation === 'folder_merge') {
      if (raw.confirm !== true || raw.purpose !== 'itkras_vu') throw new Error('confirm:true/purpose:itkras_vu are required for folder union')
      if (typeof raw.expected_snapshot_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.expected_snapshot_hash)) throw new Error('Fresh folder snapshot SHA256 is required')
      Object.assign(value, { confirm: true, purpose: 'itkras_vu', expected_snapshot_hash: raw.expected_snapshot_hash.toLowerCase() })
    }
    const chats = raw.chats ?? []
    if (!Array.isArray(chats) || chats.length > 100 || (operation === 'folder_merge' && !chats.length)) throw new Error('1..100 exact authorized chat identities are required for union')
    value.chats = chats.map(chat => {
      if (!chat || Object.keys(chat).some(k => !['chat_id', 'expected_title'].includes(k))) throw new Error('Only chat_id/expected_title are supported, no raw input peers/access hashes')
      if ((!Number.isSafeInteger(chat.chat_id) && typeof chat.chat_id !== 'string')
          || !/^-?[1-9][0-9]*$/.test(String(chat.chat_id))) throw new Error('chat_id must be an exact raw or marked decimal ID')
      if (typeof chat.expected_title !== 'string' || !chat.expected_title.trim() || chat.expected_title.length > 256) throw new Error('An exact expected_title is required')
      return { chat_id: String(chat.chat_id), expected_title: chat.expected_title }
    })
    return value
  }

  if (operation === 'membership_info') {
    if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Error('Exact session is required')
    if ((!Number.isSafeInteger(raw.expected_account_id) && typeof raw.expected_account_id !== 'string')
        || !/^[1-9][0-9]*$/.test(String(raw.expected_account_id))) throw new Error('Exact expected_account_id is required')
    return { ...common, expected_account_id: String(raw.expected_account_id),
      target: cleanText(raw.target, { required: true, max: 2000, label: 'target' }) }
  }

  if (operation.startsWith('bot_')) {
    if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Error('Bot operations require an exact session; no active-account fallback')
    const proofId = key => {
      const value = raw[key]
      if ((!Number.isSafeInteger(value) && typeof value !== 'string') || !/^[1-9][0-9]*$/.test(String(value))) throw new Error(`${key} must be an exact positive decimal ID`)
      return String(value)
    }
    const bot = cleanText(raw.bot, { required: true, max: 128, label: 'bot' })
    if (!/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(bot) && !/^[1-9][0-9]*$/.test(bot)) throw new Error('Use one exact bot @username or positive peer ID')
    const value = { ...common, bot, expected_account_id: proofId('expected_account_id'), expected_peer_id: proofId('expected_peer_id') }
    const msgId = key => {
      if (!Number.isInteger(raw[key]) || raw[key] < 1 || raw[key] > 2147483647) throw new Error(`${key} must be a Telegram message ID`)
      return raw[key]
    }
    const sha = key => {
      if (typeof raw[key] !== 'string' || !/^[a-f0-9]{64}$/i.test(raw[key])) throw new Error(`${key} must be SHA256`)
      return raw[key].toLowerCase()
    }
    if (operation === 'bot_info') return value
    if (operation === 'bot_messages') {
      if (!Array.isArray(raw.message_ids) || !raw.message_ids.length || raw.message_ids.length > 100
          || raw.message_ids.some(v => !Number.isInteger(v) || v < 1 || v > 2147483647)) throw new Error('1..100 exact message_ids are required')
      const rowOffset = intInRange(raw.row_offset, 0, 0, 10000)
      const hashes = raw.expected_binding_hashes || {}
      if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)
          || Object.entries(hashes).some(([key,v]) => !/^[1-9][0-9]*$/.test(key) || typeof v !== 'string' || !/^[a-f0-9]{64}$/i.test(v))) throw new Error('Invalid expected_binding_hashes')
      if (rowOffset > 0 && raw.message_ids.some(id => !hashes[String(id)])) throw new Error('Keyboard continuation requires each expected_binding_hash')
      return { ...value, message_ids: [...new Set(raw.message_ids)], row_offset: rowOffset,
        max_rows: intInRange(raw.max_rows, 100, 1, 100), expected_binding_hashes: hashes }
    }
    if (typeof raw.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw.request_id)) throw new Error('A stable request_id is required')
    value.request_id = raw.request_id
    if (operation === 'bot_action_status' || operation === 'bot_join_status') return value
    if (operation === 'bot_join') {
      if (raw.confirm !== true || raw.purpose !== 'join_itkras') throw new Error('Joining requires confirm:true/purpose:join_itkras')
      for (const key of ['row', 'column']) if (!Number.isInteger(raw[key]) || raw[key] < 0 || raw[key] > 10000) throw new Error(`${key} must be a zero-based integer`)
      for (const key of ['expected_action_label', 'expected_chat_title']) if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > 1000) throw new Error(`Exact ${key} is required`)
      return { ...value, confirm: true, purpose: 'join_itkras', message_id: msgId('message_id'), row: raw.row, column: raw.column,
        expected_binding_hash: sha('expected_binding_hash'), expected_action_label: raw.expected_action_label, expected_chat_title: raw.expected_chat_title }
    }
    if (raw.confirm !== true || raw.purpose !== 'read_groups') throw new Error('Bot actions require confirm:true and purpose:read_groups; this is not a payment/settings/general bot actuator')
    value.confirm = true; value.purpose = 'read_groups'
    if (raw.action === 'command') {
      if (typeof raw.command !== 'string' || !/^\/[a-z][a-z0-9_]{0,31}$/.test(raw.command)) throw new Error('One exact bot-advertised slash command is required')
      const command = { ...value, action: 'command', command: raw.command }
      if (raw.command_source_message_id != null) Object.assign(command, {
        command_source_message_id: msgId('command_source_message_id'),
        expected_command_source_sha256: sha('expected_command_source_sha256'),
      })
      return command
    }
    if (raw.action !== 'button') throw new Error('action must be command or button')
    for (const key of ['row', 'column']) if (!Number.isInteger(raw[key]) || raw[key] < 0 || raw[key] > 10000) throw new Error(`${key} must be a zero-based integer`)
    return { ...value, action: 'button', message_id: msgId('message_id'), row: raw.row,
      column: raw.column, expected_binding_hash: sha('expected_binding_hash'),
      expected_action_label: (() => {
        if (typeof raw.expected_action_label !== 'string' || !raw.expected_action_label.trim() || raw.expected_action_label.length > 1000) throw new Error('Exact expected_action_label is required')
        return raw.expected_action_label
      })() }
  }

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

  if (operation === 'public_search') {
    return {
      ...common,
      query: cleanText(raw.query, { required: true, max: 200, label: 'query' }),
      limit: intInRange(raw.limit, 20, 1, 50),
    }
  }

  if (operation === 'join' || operation === 'leave') {
    if (raw.confirm !== true) throw new Error(`${operation} requires confirm=true`)
    return {
      ...common,
      target: cleanText(raw.target, { required: true, max: 2000, label: 'target' }),
      confirm: true,
    }
  }

  if (operation === 'context' || operation === 'attachment' || operation === 'transcribe') {
    const url = raw.url == null || raw.url === ''
      ? null
      : cleanText(raw.url, { required: true, max: 2000, label: 'url' })
    const chat = raw.chat == null || raw.chat === '' ? null : cleanChat(raw.chat)
    const messageId = raw.message_id == null || raw.message_id === ''
      ? null
      : intInRange(raw.message_id, null, 1, Number.MAX_SAFE_INTEGER)
    if (!url && (!chat || !messageId)) throw new Error(`${operation} requires url or chat + message_id`)
    if (operation === 'attachment' || operation === 'transcribe') {
      const attachmentRequest = {
        ...common,
        chat,
        url,
        message_id: messageId,
        max_bytes: intInRange(raw.max_bytes, 100 * 1024 * 1024, 1, 2 * 1024 * 1024 * 1024),
        max_text_chars: intInRange(raw.max_text_chars, 200000, 1, 1000000),
      }
      if (operation === 'transcribe') {
        const engine = cleanText(raw.engine || 'soniox', {
          required: true, max: 40, label: 'engine',
        }).toLowerCase()
        if (engine !== 'soniox') throw new Error(`unsupported live transcription engine: ${engine}`)
        attachmentRequest.engine = engine
        attachmentRequest.language_hints = cleanLanguageHints(raw.language_hints)
        attachmentRequest.context = raw.context == null || raw.context === ''
          ? null
          : cleanText(raw.context, { required: true, max: 8000, label: 'context' })
      }
      return attachmentRequest
    }
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
  if (request.operation === 'public_search') return `Публичный поиск: ${request.query}`
  if (request.target) return request.target
  if (request.bot) return request.bot
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
    bytes_done: 0,
    bytes_total: null,
    file_name: null,
    media_downloaded: false,
    provider: null,
    retry_after_seconds: null,
  }
}

function compactTelegramLiveAttachment(result) {
  if (!result || !['attachment', 'transcribe'].includes(result.operation)) return null
  const attachment = result.attachment && typeof result.attachment === 'object'
    ? result.attachment
    : null
  return {
    attachment_found: result.attachment_found === true,
    file_path: typeof result.file_path === 'string' ? result.file_path : null,
    file_name: attachment?.file_name || null,
    content_type: attachment?.content_type || null,
    bytes: attachment?.bytes == null ? null : Number(attachment.bytes),
    content_kind: attachment?.content_kind || null,
    cached: attachment?.cached === true,
    extraction: attachment?.extraction && typeof attachment.extraction === 'object'
      ? { ...attachment.extraction }
      : null,
    limitation: result.limitation || attachment?.extraction?.limitation || null,
  }
}

function compactTelegramLiveTranscription(result) {
  if (!result || result.operation !== 'transcribe') return null
  const transcription = result.transcription && typeof result.transcription === 'object'
    ? result.transcription
    : null
  return {
    status: transcription?.status || null,
    engine: transcription?.engine || 'soniox',
    model: transcription?.model || null,
    transcript_path: typeof result.transcript_path === 'string'
      ? result.transcript_path
      : null,
    chars: transcription?.chars == null ? 0 : Number(transcription.chars),
    returned_chars: transcription?.returned_chars == null ? 0 : Number(transcription.returned_chars),
    token_count: transcription?.token_count == null ? 0 : Number(transcription.token_count),
    truncated: transcription?.truncated === true,
    limitation: result.limitation || transcription?.limitation || null,
  }
}

function compactTelegramLiveMembership(result) {
  if (!result || !['join', 'leave'].includes(result.operation)) return null
  const chat = result.chat && typeof result.chat === 'object' ? result.chat : null
  return {
    operation: result.operation,
    status: result.status || null,
    joined: result.joined === true,
    left: result.left === true,
    already_member: result.already_member === true,
    already_left: result.already_left === true,
    request_sent: result.request_sent === true,
    ready_for_fetch: result.ready_for_fetch === true,
    source_id: result.source_id == null ? null : Number(result.source_id),
    source_registered: result.source_registered === true,
    source_registration_error: result.source_registration_error || null,
    chat: chat ? {
      id: chat.id == null ? null : Number(chat.id),
      title: chat.title || null,
      username: chat.username || null,
      type: chat.type || null,
      participants_count: chat.participants_count == null ? null : Number(chat.participants_count),
      has_discussion: chat.has_discussion === true
        ? true
        : (chat.has_discussion === false ? false : null),
      linked_discussion_id: chat.linked_discussion_id == null
        ? null
        : Number(chat.linked_discussion_id),
      public: chat.public === true,
      member: chat.member === true,
      url: chat.url || null,
    } : null,
  }
}

function telegramMembershipSourcePayload(result, tgSession, existingSource = null) {
  if (!result || !['join', 'leave'].includes(result.operation)) return null
  const chat = result.chat
  const id = chat?.id == null ? '' : String(chat.id).replace(/^-100/, '').replace(/^-/, '')
  if (!/^\d+$/.test(id)) return null
  const sourceKind = String(chat.source_kind || '').toLowerCase()
  if (!['channel', 'group', 'chat'].includes(sourceKind)) return null
  const username = String(chat.username || '').replace(/^@+/, '').trim()
  const handle = username || (sourceKind === 'chat' ? `-${id}` : `-100${id}`)
  const membershipStatus = result.operation === 'join' && result.ready_for_fetch === true
    ? 'member'
    : 'left'
  return {
    platform: 'telegram',
    handle,
    display_name: chat.title || null,
    external_id: id,
    avatar_url: null,
    meta: {
      kind: sourceKind,
      username: username || null,
      tg_membership: {
        status: membershipStatus,
        checked_at: Math.floor(Date.now() / 1000),
      },
    },
    mark_synced: false,
    is_explicit: result.operation === 'join' ? true : !!existingSource?.is_explicit,
    tg_session: tgSession || existingSource?.tg_session || null,
  }
}

function telegramMembershipMutationInFlight(job) {
  return (job?.type === 'tg_live_join' || job?.type === 'tg_live_leave' || job?.type === 'tg_live_bot_join')
    && job?.tg_live?.stage === 'updating_membership'
}

function telegramBotMutationInFlight(job) {
  return job?.type === 'tg_live_bot_action' && job?.tg_live?.stage === 'dispatching_bot_action'
}

function telegramFolderMutationInFlight(job) {
  return job?.type === 'tg_live_folder_merge' && job?.tg_live?.stage === 'dispatching_folder_update'
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
      if (event.bytes_done != null) state.bytes_done = intInRange(event.bytes_done, state.bytes_done, 0, Number.MAX_SAFE_INTEGER)
      if (event.bytes_total != null) state.bytes_total = intInRange(event.bytes_total, state.bytes_total, 0, Number.MAX_SAFE_INTEGER)
      if (event.file_name) state.file_name = cleanText(event.file_name, { max: 500 })
      if (event.provider) state.provider = cleanText(event.provider, { max: 80 })
      if (event.retry_after_seconds != null) {
        state.retry_after_seconds = intInRange(event.retry_after_seconds, null, 0, Number.MAX_SAFE_INTEGER)
      }
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
      state.media_downloaded = result.media_downloaded === true
      if (!job.entity_title && result.chat?.title) job.entity_title = cleanText(result.chat.title, { max: 500 })
      if (!job.entity_kind && result.chat?.type) job.entity_kind = cleanText(result.chat.type, { max: 80 })
      if (result.attachment?.file_name) state.file_name = cleanText(result.attachment.file_name, { max: 500 })
      if (result.attachment?.bytes != null) {
        state.bytes_done = intInRange(result.attachment.bytes, state.bytes_done, 0, Number.MAX_SAFE_INTEGER)
        state.bytes_total = state.bytes_done
      }
      if (result.operation === 'attachment') {
        job.file_path = typeof result.file_path === 'string' ? result.file_path : null
        job.tg_live_attachment = compactTelegramLiveAttachment(result)
      }
      if (result.operation === 'transcribe') {
        job.file_path = typeof result.transcript_path === 'string'
          ? result.transcript_path
          : (typeof result.file_path === 'string' ? result.file_path : null)
        job.tg_live_attachment = compactTelegramLiveAttachment(result)
        job.tg_live_transcription = compactTelegramLiveTranscription(result)
        state.provider = result.transcription?.engine || state.provider || 'soniox'
      }
      if (result.operation === 'join' || result.operation === 'leave') {
        job.tg_live_membership = compactTelegramLiveMembership(result)
      }
      if (result.messages && Array.isArray(result.messages)) {
        state.unique_hits = result.messages.length
      }
      if (result.chats && Array.isArray(result.chats)) {
        state.unique_hits = result.chats.length
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
      if (event.retry_after_seconds != null) {
        state.retry_after_seconds = intInRange(event.retry_after_seconds, null, 0, Number.MAX_SAFE_INTEGER)
      }
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
    bytes_done: Number(state.bytes_done || 0),
    bytes_total: state.bytes_total == null ? null : Number(state.bytes_total),
    file_name: state.file_name || null,
    media_downloaded: state.media_downloaded === true,
    provider: state.provider || null,
    retry_after_seconds: state.retry_after_seconds == null
      ? null
      : Number(state.retry_after_seconds),
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
  compactTelegramLiveAttachment,
  compactTelegramLiveTranscription,
  compactTelegramLiveMembership,
  telegramMembershipSourcePayload,
  telegramMembershipMutationInFlight,
  telegramBotMutationInFlight,
  telegramFolderMutationInFlight,
}
