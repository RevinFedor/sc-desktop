const fs = require('node:fs')
const { processInstagramSingleReel, extractInstagramShortcode } = require('./instagram-reel-service')

const POLL_TIMEOUT_SEC = 25
const POLL_BACKOFF_MS = 5000
const CHAT_ACTION_INTERVAL_MS = 8000

function createTelegramBotService({ readScSettings, writeScSettings, jobRunner, db }) {
  let running = false
  let abortController = null
  let offset = 0
  let activeTasks = 0
  let botToken = null
  const listeners = new Set()
  const state = {
    status: 'stopped',
    enabled: false,
    username: null,
    bot_id: null,
    started_at: null,
    last_update_at: null,
    last_error: null,
    allowed_chat_count: 0,
    active_tasks: 0,
  }

  function readBotConfig() {
    const settings = readScSettings()
    const cfg = settings.telegram_bot || {}
    const apiKeys = settings.api_keys || {}
    const tg = settings.telegram || {}
    const token = String(
      process.env.TELEGRAM_BOT_TOKEN
      || cfg.token
      || apiKeys.TELEGRAM_BOT_TOKEN
      || tg.bot_token
      || ''
    ).trim()
    const allowedChatIds = Array.isArray(cfg.allowed_chat_ids)
      ? cfg.allowed_chat_ids.map(String)
      : []
    const allowedUserIds = Array.isArray(cfg.allowed_user_ids)
      ? cfg.allowed_user_ids.map(String)
      : []
    return {
      settings,
      cfg,
      token,
      enabled: cfg.enabled !== false && !!token,
      allowedChatIds,
      allowedUserIds,
      claimFirstChat: cfg.claim_first_chat !== false,
      instagramEngine: cfg.instagram_engine || settings.instagram?.engine || settings.instagram?.transcribe_engine || 'gemini',
    }
  }

  function snapshot() {
    return { ...state, active_tasks: activeTasks }
  }

  function emit() {
    const snap = snapshot()
    for (const fn of listeners) {
      try { fn(snap) } catch {}
    }
  }

  function setState(patch) {
    Object.assign(state, patch)
    emit()
  }

  function setAllowedCountFromConfig(config = readBotConfig()) {
    state.allowed_chat_count = config.allowedChatIds.length + config.allowedUserIds.length
  }

  async function api(method, payload = {}, { token = botToken, signal } = {}) {
    if (!token) throw new Error('Telegram bot token is not configured')
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
    let data = null
    try { data = await res.json() } catch {}
    if (!res.ok || !data?.ok) {
      const description = data?.description || `HTTP ${res.status}`
      const err = new Error(description)
      err.httpStatus = res.status
      err.telegram = data
      throw err
    }
    return data.result
  }

  async function sendMessage(chatId, text, extra = {}) {
    const chunks = splitTelegramText(text)
    for (const chunk of chunks) {
      await api('sendMessage', {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...extra,
      }).catch(err => {
        console.warn(`[TelegramBot] sendMessage failed chat=${chatId}: ${err?.message || err}`)
      })
    }
  }

  async function sendChatAction(chatId, action) {
    await api('sendChatAction', { chat_id: chatId, action }).catch(() => {})
  }

  async function sendCodeBlockText(chatId, text) {
    const chunks = splitCodeBlockContent(text)
    for (let i = 0; i < chunks.length; i += 1) {
      const body = chunks.length > 1
        ? `часть ${i + 1}/${chunks.length}\n\n${chunks[i]}`
        : chunks[i]
      const message = '```\n' + escapeMarkdownV2Code(body) + '\n```'
      try {
        await api('sendMessage', {
          chat_id: chatId,
          text: message,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        })
      } catch (err) {
        console.warn(`[TelegramBot] code block send failed chat=${chatId}: ${err?.message || err}`)
        await sendMessage(chatId, '```\n' + body + '\n```')
      }
    }
  }

  async function sendInstagramTranscriptText(chatId, transcript) {
    const parsed = splitInstagramTranscriptForTelegram(transcript)
    const body = parsed.body || '(пустой транскрипт)'
    const escapedMetaLen = markdownTextEscapedLength(parsed.meta)
    const firstMax = Math.max(900, Math.min(3600, 3900 - escapedMetaLen - 12))
    const chunks = splitCodeBlockContent(body, firstMax)

    for (let i = 0; i < chunks.length; i += 1) {
      const prefix = i === 0
        ? parsed.meta
        : `часть ${i + 1}/${chunks.length}`
      const message = buildMarkdownCodeMessage(prefix, chunks[i])
      try {
        await api('sendMessage', {
          chat_id: chatId,
          text: message,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        })
      } catch (err) {
        console.warn(`[TelegramBot] transcript send failed chat=${chatId}: ${err?.message || err}`)
        const plain = [prefix, '```', chunks[i], '```'].filter(Boolean).join('\n')
        await sendMessage(chatId, plain)
      }
    }
  }

  function isAllowed(config, message) {
    const chatId = String(message?.chat?.id || '')
    const userId = String(message?.from?.id || '')
    if (!chatId) return false
    if (config.allowedChatIds.includes(chatId)) return true
    if (userId && config.allowedUserIds.includes(userId)) return true
    return false
  }

  async function claimFirstChat(config, message) {
    if (!config.claimFirstChat) return false
    if (config.allowedChatIds.length || config.allowedUserIds.length) return false
    const chatId = message?.chat?.id
    if (chatId == null) return false

    const settings = config.settings || readScSettings()
    settings.telegram_bot = {
      ...(settings.telegram_bot || {}),
      allowed_chat_ids: [String(chatId)],
      claim_first_chat: false,
    }
    const saved = writeScSettings(settings)
    if (!saved?.ok) {
      console.warn(`[TelegramBot] first chat claim failed: ${saved?.error || 'unknown error'}`)
      return false
    }
    setAllowedCountFromConfig(readBotConfig())
    console.log(`[TelegramBot] first allowed chat claimed chat=${chatId}`)
    await sendMessage(chatId, 'Этот чат привязан к SC Desktop боту. Теперь можно присылать Instagram-ссылки.')
    return true
  }

  async function ensureAllowed(message) {
    const config = readBotConfig()
    if (isAllowed(config, message)) return true
    if (await claimFirstChat(config, message)) return true
    const chatId = message?.chat?.id
    if (chatId != null) {
      await sendMessage(chatId, 'Этот чат не подключён к SC Desktop. Разрешён только уже привязанный чат.')
    }
    return false
  }

  async function handleUpdate(update) {
    const message = update?.message || update?.edited_message || null
    if (!message) return
    state.last_update_at = Math.floor(Date.now() / 1000)
    emit()

    const text = String(message.text || message.caption || '').trim()
    if (!text) return
    const chatId = message.chat?.id
    if (chatId == null) return

    if (!await ensureAllowed(message)) return

    if (/^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(text)) {
      await sendMessage(chatId, [
        'Пришли ссылку на Instagram reels или post.',
        'SC Desktop проверит кэш и настройки Instagram, запустит обычную обработку и пришлёт текст как code block.',
      ].join('\n'))
      return
    }

    if (/^\/status(?:@\w+)?(?:\s|$)/i.test(text)) {
      await sendMessage(chatId, describeStatus())
      return
    }

    const shortcode = extractInstagramShortcode(text)
    if (!shortcode) {
      await sendMessage(chatId, 'Пока принимаю только ссылки на Instagram reels/posts.')
      return
    }

    activeTasks += 1
    setState({ active_tasks: activeTasks, last_error: null })
    void handleInstagramMessage(chatId, text)
      .catch(err => {
        console.error(`[TelegramBot] Instagram message failed: ${err?.message || err}`)
        setState({ last_error: String(err?.message || err) })
        return sendMessage(chatId, `Ошибка обработки: ${err?.message || err}`)
      })
      .finally(() => {
        activeTasks = Math.max(0, activeTasks - 1)
        setState({ active_tasks: activeTasks })
      })
  }

  async function handleInstagramMessage(chatId, text) {
    const config = readBotConfig()
    console.log(`[TelegramBot] accepted Instagram link chat=${chatId}`)
    await sendMessage(chatId, 'Принял Instagram-ссылку. Проверяю кэш и настройки…')
    await sendChatAction(chatId, 'typing')

    let lastStage = null
    const actionTimer = setInterval(() => {
      sendChatAction(chatId, 'typing').catch(() => {})
    }, CHAT_ACTION_INTERVAL_MS)
    actionTimer.unref?.()

    try {
      const result = await processInstagramSingleReel({
        db,
        jobRunner,
        readScSettings,
        url: text,
        engine: config.instagramEngine,
        onStarted: (jobId, plan) => {
          console.log(`[TelegramBot] Instagram job started job=${jobId} backend=${plan.backend}`)
          sendMessage(chatId, `Запустил обработку: ${plan.backend}, ${plan.params.engine}.`).catch(() => {})
        },
        onProgress: snap => {
          const stage = snap?.yt_batch?.current?.stage || snap?.status || null
          if (!stage || stage === lastStage) return
          lastStage = stage
          setState({ last_job: { id: snap.id, status: snap.status, stage } })
        },
      })

      if (!result.ok) {
        console.warn(`[TelegramBot] Instagram processing rejected code=${result.code || '-'} error=${result.error || '-'}`)
        await sendMessage(chatId, `Не получилось обработать Instagram-ссылку: ${result.error || result.code || 'unknown error'}`)
        return
      }

      await sendChatAction(chatId, 'typing')
      const transcript = fs.readFileSync(result.file_path, 'utf8')
      await sendInstagramTranscriptText(chatId, transcript)
      console.log(`[TelegramBot] Instagram result sent chat=${chatId} cached=${result.cached ? 'yes' : 'no'}`)
    } finally {
      clearInterval(actionTimer)
    }
  }

  function describeStatus() {
    const snap = snapshot()
    const parts = [
      `Статус: ${snap.status}`,
      snap.username ? `Бот: @${snap.username}` : null,
      `Активных задач: ${snap.active_tasks || 0}`,
      `Разрешений: ${snap.allowed_chat_count || 0}`,
      snap.last_error ? `Последняя ошибка: ${snap.last_error}` : null,
    ].filter(Boolean)
    return parts.join('\n')
  }

  async function flushPendingUpdates(token, signal) {
    try {
      const updates = await api('getUpdates', {
        timeout: 0,
        limit: 100,
        allowed_updates: ['message', 'edited_message'],
      }, { token, signal })
      if (!Array.isArray(updates) || updates.length === 0) return
      offset = Math.max(...updates.map(u => Number(u.update_id) || 0)) + 1
      console.log(`[TelegramBot] skipped pending updates count=${updates.length}`)
    } catch (err) {
      console.warn(`[TelegramBot] pending update flush failed: ${err?.message || err}`)
    }
  }

  async function pollLoop(token, signal) {
    while (running && token === botToken) {
      try {
        const updates = await api('getUpdates', {
          timeout: POLL_TIMEOUT_SEC,
          offset,
          allowed_updates: ['message', 'edited_message'],
        }, { token, signal })
        if (!running || token !== botToken) break
        setState({ status: 'online', last_error: null })
        for (const update of updates || []) {
          offset = Math.max(offset, (Number(update.update_id) || 0) + 1)
          void handleUpdate(update).catch(err => {
            console.error(`[TelegramBot] update handler failed: ${err?.message || err}`)
            setState({ last_error: String(err?.message || err) })
          })
        }
      } catch (err) {
        if (err?.name === 'AbortError') break
        console.warn(`[TelegramBot] polling failed: ${err?.message || err}`)
        setState({ status: 'error', last_error: String(err?.message || err) })
        await sleep(POLL_BACKOFF_MS)
      }
    }
  }

  async function start() {
    if (running) return snapshot()
    const config = readBotConfig()
    setAllowedCountFromConfig(config)
    if (!config.enabled) {
      botToken = null
      setState({
        status: config.token ? 'disabled' : 'not_configured',
        enabled: false,
        username: null,
        bot_id: null,
        started_at: null,
        last_error: config.token ? null : 'Telegram bot token is not configured',
      })
      return snapshot()
    }

    botToken = config.token
    running = true
    abortController = new AbortController()
    setState({
      status: 'starting',
      enabled: true,
      started_at: Math.floor(Date.now() / 1000),
      last_error: null,
    })

    try {
      const me = await api('getMe', {}, { token: botToken, signal: abortController.signal })
      setState({
        status: 'online',
        username: me?.username || null,
        bot_id: me?.id || null,
        last_error: null,
      })
      console.log(`[TelegramBot] started username=${me?.username || '-'} id=${me?.id || '-'}`)
      await api('deleteWebhook', { drop_pending_updates: true }, { token: botToken, signal: abortController.signal })
      console.log('[TelegramBot] webhook disabled for desktop polling')
      await flushPendingUpdates(botToken, abortController.signal)
      void pollLoop(botToken, abortController.signal)
    } catch (err) {
      running = false
      abortController = null
      console.warn(`[TelegramBot] start failed: ${err?.message || err}`)
      setState({
        status: 'error',
        enabled: true,
        last_error: String(err?.message || err),
      })
    }
    return snapshot()
  }

  function stop() {
    running = false
    if (abortController) {
      try { abortController.abort() } catch {}
      abortController = null
    }
    if (state.status !== 'not_configured') {
      setState({ status: 'stopped', enabled: false })
    }
    console.log('[TelegramBot] stopped')
    return snapshot()
  }

  async function restart() {
    stop()
    return await start()
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return {
    start,
    stop,
    restart,
    getState: snapshot,
    subscribe,
  }
}

function splitTelegramText(text) {
  const s = String(text || '')
  if (s.length <= 3900) return [s]
  const chunks = []
  for (let i = 0; i < s.length; i += 3900) chunks.push(s.slice(i, i + 3900))
  return chunks
}

function splitInstagramTranscriptForTelegram(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const first = lines[0] || ''
  const m = first.match(/^---\s*(.*?)\s*---\s*$/)
  if (!m) return { meta: '', body: normalized.trim() }

  const metaLines = [formatInstagramMetaLine(m[1])]
  let i = 1

  while (i < lines.length && !lines[i].trim()) i += 1

  if (/^Caption:/i.test(lines[i] || '')) {
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim()) {
        i += 1
        break
      }
      metaLines.push(line)
      i += 1
    }
    while (i < lines.length && !lines[i].trim()) i += 1
  }

  return {
    meta: metaLines.filter(Boolean).join('\n').trim(),
    body: lines.slice(i).join('\n').trim(),
  }
}

function formatInstagramMetaLine(line) {
  const s = String(line || '').trim()
  const m = s.match(/^(.*?)\s*\|\s*(https?:\/\/\S+)\s*$/)
  if (!m) return s
  return `📸 ${m[2].trim()}`
}

function escapeMarkdownV2Code(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
}

function escapeMarkdownV2Text(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1')
}

function markdownTextEscapedLength(text) {
  return escapeMarkdownV2Text(text).length
}

function buildMarkdownCodeMessage(prefix, body) {
  const head = prefix ? `${escapeMarkdownV2Text(prefix)}\n\n` : ''
  return `${head}\`\`\`\n${escapeMarkdownV2Code(body)}\n\`\`\``
}

function markdownCodeEscapedLength(text) {
  let n = 0
  for (const ch of String(text || '')) {
    n += (ch === '\\' || ch === '`') ? 2 : 1
  }
  return n
}

function splitCodeBlockContent(text, maxEscapedLen = 3600) {
  const parts = String(text || '').replace(/\r\n/g, '\n').split(/(\n)/)
  const chunks = []
  let current = ''
  let currentLen = 0

  function flush() {
    if (!current) return
    chunks.push(current)
    current = ''
    currentLen = 0
  }

  function appendSmall(part, partLen) {
    if (current && currentLen + partLen > maxEscapedLen) flush()
    current += part
    currentLen += partLen
  }

  for (const part of parts) {
    if (!part) continue
    const partLen = markdownCodeEscapedLength(part)
    if (partLen <= maxEscapedLen) {
      appendSmall(part, partLen)
      continue
    }

    for (const ch of Array.from(part)) {
      const chLen = markdownCodeEscapedLength(ch)
      if (current && currentLen + chLen > maxEscapedLen) flush()
      current += ch
      currentLen += chLen
    }
  }

  flush()
  return chunks.length ? chunks : ['']
}

function sleep(ms) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

module.exports = { createTelegramBotService }
