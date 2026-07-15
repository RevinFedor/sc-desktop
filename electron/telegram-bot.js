const fs = require('node:fs')
const { processInstagramSingleReel, extractInstagramShortcode } = require('./instagram-reel-service')

const POLL_TIMEOUT_SEC = 25
const START_RETRY_BASE_MS = 2000
const START_RETRY_MAX_MS = 60000
const POLL_RETRY_BASE_MS = 1000
const POLL_RETRY_MAX_MS = 30000
const NOTIFICATION_RETRY_BASE_MS = 750
const NOTIFICATION_RETRY_MAX_MS = 60000
const NOTIFICATION_SEND_MAX_ATTEMPTS = 4
const CHAT_ACTION_INTERVAL_MS = 8000
const NOTIFICATION_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000
const NOTIFICATION_DEDUPE_MAX = 512
const NOTIFICATION_DEDUPE_PREF_KEY = 'telegram.terminal_notification_deliveries'

function createTelegramBotService({
  readScSettings,
  writeScSettings,
  jobRunner,
  db,
  allowTerminalNotifications = false,
}) {
  let running = false
  let abortController = null
  let offset = 0
  let activeTasks = 0
  let botToken = null
  let shouldRun = false
  let startRetryTimer = null
  let startRetryCount = 0
  let lifecycleGeneration = 0
  let startupAttempt = null
  let terminalNotificationQueue = Promise.resolve()
  let notificationDeliveriesHydrated = false
  const listeners = new Set()
  const notificationDeliveries = new Map()
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
    const explicitNotificationChatId = String(cfg.notification_chat_id || '').trim()
    return {
      settings,
      cfg,
      token,
      enabled: cfg.enabled !== false && !!token,
      allowedChatIds,
      allowedUserIds,
      notificationChatId: explicitNotificationChatId || (allowedChatIds.length === 1 ? allowedChatIds[0] : null),
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
    let res
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (err) {
      if (err?.name !== 'AbortError') err.telegramNetworkError = true
      throw err
    }
    let data = null
    try { data = await res.json() } catch {}
    if (!res.ok || !data?.ok) {
      const description = data?.description || `HTTP ${res.status}`
      const err = new Error(description)
      err.httpStatus = res.status
      err.telegram = data
      err.telegramErrorCode = Number(data?.error_code) || null
      err.retryAfterSec = Number(data?.parameters?.retry_after) || null
      throw err
    }
    return data.result
  }

  async function apiWithTransientRetry(method, payload, {
    token,
    signal,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
  }) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await api(method, payload, { token, signal })
      } catch (err) {
        if (
          err?.name === 'AbortError'
          || !isTransientTelegramError(err)
          || attempt >= maxAttempts
        ) throw err

        const delayMs = telegramRetryDelayMs(err, attempt - 1, baseDelayMs, maxDelayMs)
        console.warn(`[TelegramBot] ${method} transient failure; retry ${attempt + 1}/${maxAttempts} in ${delayMs}ms: ${err?.message || err}`)
        await sleep(delayMs, signal)
        if (signal?.aborted) throw createAbortError()
      }
    }
    throw new Error(`${method} retry loop exhausted`)
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

  async function sendMessageStrict(chatId, text, extra = {}, token = botToken) {
    const deliveries = []
    const chunks = splitTelegramText(text)
    for (const chunk of chunks) {
      const result = await apiWithTransientRetry('sendMessage', {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...extra,
      }, {
        token,
        maxAttempts: NOTIFICATION_SEND_MAX_ATTEMPTS,
        baseDelayMs: NOTIFICATION_RETRY_BASE_MS,
        maxDelayMs: NOTIFICATION_RETRY_MAX_MS,
      })
      deliveries.push({ message_id: result?.message_id || null })
    }
    return deliveries
  }

  function pruneExpiredNotificationDeliveries(now = Date.now()) {
    for (const [eventId, entry] of notificationDeliveries) {
      if (entry.settled && entry.expiresAt <= now) notificationDeliveries.delete(eventId)
    }
  }

  function reserveNotificationDeliverySlot() {
    while (notificationDeliveries.size >= NOTIFICATION_DEDUPE_MAX) {
      const oldestSettled = [...notificationDeliveries.entries()]
        .find(([, entry]) => entry.settled)?.[0]
      if (!oldestSettled) break
      notificationDeliveries.delete(oldestSettled)
    }
  }

  function hydrateNotificationDeliveries() {
    if (notificationDeliveriesHydrated) return
    notificationDeliveriesHydrated = true
    if (typeof db?.getUiPreference !== 'function') return

    try {
      const stored = db.getUiPreference(NOTIFICATION_DEDUPE_PREF_KEY)
      const entries = Array.isArray(stored) ? stored : stored?.entries
      if (!Array.isArray(entries)) return

      const now = Date.now()
      for (const saved of entries.slice(-NOTIFICATION_DEDUPE_MAX)) {
        const eventId = String(saved?.eventId || '').trim()
        const expiresAt = Number(saved?.expiresAt)
        if (!eventId || !Number.isFinite(expiresAt) || expiresAt <= now) continue
        const deliveries = Array.isArray(saved?.deliveries)
          ? saved.deliveries.map(item => ({ message_id: item?.message_id ?? null }))
          : []
        const result = { ok: true, eventId, deliveries }
        notificationDeliveries.set(eventId, {
          promise: Promise.resolve(result),
          settled: true,
          expiresAt,
          result,
        })
      }
    } catch (err) {
      console.warn(`[TelegramBot] notification dedupe restore failed: ${err?.message || err}`)
    }
  }

  function persistNotificationDeliveries() {
    if (typeof db?.setUiPreference !== 'function') return
    const now = Date.now()
    pruneExpiredNotificationDeliveries(now)
    const entries = [...notificationDeliveries.entries()]
      .filter(([, entry]) => entry.settled && entry.expiresAt > now && entry.result)
      .slice(-NOTIFICATION_DEDUPE_MAX)
      .map(([eventId, entry]) => ({
        eventId,
        expiresAt: entry.expiresAt,
        deliveries: Array.isArray(entry.result.deliveries) ? entry.result.deliveries : [],
      }))
    try {
      const saved = db.setUiPreference(NOTIFICATION_DEDUPE_PREF_KEY, { version: 1, entries })
      if (saved?.ok === false) {
        console.warn(`[TelegramBot] notification dedupe persist failed: ${saved.error || 'unknown error'}`)
      }
    } catch (err) {
      console.warn(`[TelegramBot] notification dedupe persist failed: ${err?.message || err}`)
    }
  }

  function enqueueTerminalNotification(task) {
    const delivery = terminalNotificationQueue.then(task)
    terminalNotificationQueue = delivery.catch(() => {})
    return delivery
  }

  async function notifyTerminalCompletion(event = {}) {
    const eventId = String(event.eventId || '').trim()
    if (!eventId) {
      const err = new Error('eventId is required')
      err.code = 'invalid_notification_event'
      throw err
    }

    if (allowTerminalNotifications !== true) {
      const err = new Error('Telegram terminal notifications are not allowed in this runtime')
      err.code = 'telegram_notifications_not_allowed'
      throw err
    }

    hydrateNotificationDeliveries()
    pruneExpiredNotificationDeliveries()
    const existing = notificationDeliveries.get(eventId)
    if (existing) {
      const result = await existing.promise
      return { ...result, duplicate: true }
    }
    reserveNotificationDeliverySlot()

    const deliveryPromise = enqueueTerminalNotification(async () => {
      const config = readBotConfig()
      if (!config.enabled) {
        const err = new Error(config.token ? 'Telegram bot is disabled' : 'Telegram bot token is not configured')
        err.code = config.token ? 'telegram_bot_disabled' : 'telegram_bot_not_configured'
        throw err
      }
      if (!config.notificationChatId) {
        const err = new Error('Telegram notification chat is not configured')
        err.code = 'telegram_notification_chat_not_configured'
        throw err
      }

      const tabName = String(event.tabName || 'Terminal').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Terminal'
      const deliveries = await sendMessageStrict(
        config.notificationChatId,
        `🔔 Вкладка завершилась\n${tabName}`,
        {},
        config.token,
      )
      console.log(`[TelegramBot] terminal completion sent event=${eventId.slice(0, 180)} deliveries=${deliveries.length}`)
      return { ok: true, eventId, deliveries }
    })

    const deliveryEntry = {
      promise: deliveryPromise,
      settled: false,
      expiresAt: Infinity,
    }
    notificationDeliveries.set(eventId, deliveryEntry)

    try {
      const result = await deliveryPromise
      if (notificationDeliveries.get(eventId) === deliveryEntry) {
        deliveryEntry.settled = true
        deliveryEntry.expiresAt = Date.now() + NOTIFICATION_DEDUPE_TTL_MS
        deliveryEntry.result = result
        persistNotificationDeliveries()
      }
      return { ...result, duplicate: false }
    } catch (err) {
      if (notificationDeliveries.get(eventId) === deliveryEntry) {
        notificationDeliveries.delete(eventId)
      }
      throw err
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

  async function flushPendingUpdates(token, signal, isOwner) {
    const updates = await api('getUpdates', {
      timeout: 0,
      limit: 100,
      allowed_updates: ['message', 'edited_message'],
    }, { token, signal })
    if (!isOwner() || !Array.isArray(updates) || updates.length === 0) return
    offset = Math.max(...updates.map(u => Number(u.update_id) || 0)) + 1
    console.log(`[TelegramBot] skipped pending updates count=${updates.length}`)
  }

  function ownsStartupAttempt(attempt) {
    return shouldRun
      && startupAttempt === attempt
      && lifecycleGeneration === attempt.generation
      && abortController === attempt.controller
  }

  function ownsPollingRuntime(generation, controller) {
    return shouldRun
      && running
      && lifecycleGeneration === generation
      && abortController === controller
  }

  async function pollLoop(token, signal, generation, controller) {
    let retryCount = 0
    while (ownsPollingRuntime(generation, controller)) {
      try {
        const updates = await api('getUpdates', {
          timeout: POLL_TIMEOUT_SEC,
          offset,
          allowed_updates: ['message', 'edited_message'],
        }, { token, signal })
        if (!ownsPollingRuntime(generation, controller)) break
        retryCount = 0
        setState({ status: 'online', last_error: null })
        for (const update of updates || []) {
          if (!ownsPollingRuntime(generation, controller)) break
          offset = Math.max(offset, (Number(update.update_id) || 0) + 1)
          void handleUpdate(update).catch(err => {
            if (!ownsPollingRuntime(generation, controller)) return
            console.error(`[TelegramBot] update handler failed: ${err?.message || err}`)
            setState({ last_error: String(err?.message || err) })
          })
        }
      } catch (err) {
        if (err?.name === 'AbortError' || !ownsPollingRuntime(generation, controller)) break

        if (!isTransientTelegramError(err)) {
          running = false
          abortController = null
          console.warn(`[TelegramBot] polling stopped after permanent failure: ${err?.message || err}`)
          setState({ status: 'error', last_error: String(err?.message || err) })
          break
        }

        const delayMs = telegramRetryDelayMs(err, retryCount, POLL_RETRY_BASE_MS, POLL_RETRY_MAX_MS)
        retryCount += 1
        console.warn(`[TelegramBot] polling transient failure; retry in ${delayMs}ms: ${err?.message || err}`)
        setState({ status: 'error', last_error: String(err?.message || err) })
        await sleep(delayMs, signal)
      }
    }
  }

  function clearStartRetry() {
    if (!startRetryTimer) return
    clearTimeout(startRetryTimer)
    startRetryTimer = null
  }

  function scheduleStartRetry(err, generation) {
    if (!shouldRun || lifecycleGeneration !== generation || startRetryTimer) return
    const delayMs = telegramRetryDelayMs(err, startRetryCount, START_RETRY_BASE_MS, START_RETRY_MAX_MS)
    startRetryCount += 1
    const timer = setTimeout(() => {
      if (startRetryTimer !== timer) return
      startRetryTimer = null
      if (
        shouldRun
        && lifecycleGeneration === generation
        && !running
        && !startupAttempt
      ) void start({ isRetry: true })
    }, delayMs)
    startRetryTimer = timer
    timer.unref?.()
    console.log(`[TelegramBot] startup retry scheduled in ${delayMs}ms`)
  }

  async function runStartupAttempt(attempt) {
    const { token, controller, generation } = attempt
    const isOwner = () => ownsStartupAttempt(attempt)

    try {
      const me = await api('getMe', {}, { token, signal: controller.signal })
      if (!isOwner()) return snapshot()

      await api('deleteWebhook', { drop_pending_updates: true }, { token, signal: controller.signal })
      if (!isOwner()) return snapshot()
      console.log('[TelegramBot] webhook disabled for desktop polling')

      await flushPendingUpdates(token, controller.signal, isOwner)
      if (!isOwner()) return snapshot()

      running = true
      startRetryCount = 0
      setState({
        status: 'online',
        username: me?.username || null,
        bot_id: me?.id || null,
        last_error: null,
      })
      console.log(`[TelegramBot] started username=${me?.username || '-'} id=${me?.id || '-'}`)
      void pollLoop(token, controller.signal, generation, controller)
    } catch (err) {
      if (!isOwner()) return snapshot()

      running = false
      abortController = null
      if (err?.name === 'AbortError' && !shouldRun) return snapshot()

      const transient = isTransientTelegramError(err)
      console.warn(`[TelegramBot] start ${transient ? 'transiently' : 'permanently'} failed: ${err?.message || err}`)
      setState({
        status: 'error',
        enabled: true,
        last_error: String(err?.message || err),
      })
      if (transient) scheduleStartRetry(err, generation)
    } finally {
      if (startupAttempt === attempt) startupAttempt = null
    }
    return snapshot()
  }

  async function start({ isRetry = false } = {}) {
    shouldRun = true
    if (running) return snapshot()
    if (startupAttempt) return startupAttempt.promise
    clearStartRetry()
    if (!isRetry) startRetryCount = 0
    const config = readBotConfig()
    setAllowedCountFromConfig(config)
    if (!config.enabled) {
      shouldRun = false
      lifecycleGeneration += 1
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

    const attempt = {
      generation: lifecycleGeneration + 1,
      controller: new AbortController(),
      token: config.token,
      promise: null,
    }
    lifecycleGeneration = attempt.generation
    botToken = attempt.token
    abortController = attempt.controller
    startupAttempt = attempt
    setState({
      status: 'starting',
      enabled: true,
      started_at: Math.floor(Date.now() / 1000),
      last_error: null,
    })
    attempt.promise = runStartupAttempt(attempt)
    return attempt.promise
  }

  function stop() {
    shouldRun = false
    lifecycleGeneration += 1
    clearStartRetry()
    startRetryCount = 0
    running = false
    const controller = abortController
    abortController = null
    startupAttempt = null
    if (controller) {
      try { controller.abort() } catch {}
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
    notifyTerminalCompletion,
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

function telegramErrorStatus(err) {
  const telegramCode = Number(err?.telegramErrorCode || err?.telegram?.error_code)
  if (Number.isFinite(telegramCode) && telegramCode > 0) return telegramCode
  const httpStatus = Number(err?.httpStatus)
  return Number.isFinite(httpStatus) && httpStatus > 0 ? httpStatus : null
}

function isTransientTelegramError(err) {
  if (!err || err.name === 'AbortError') return false
  if (err.telegramNetworkError === true) return true
  const status = telegramErrorStatus(err)
  return status === 408
    || status === 409
    || status === 425
    || status === 429
    || (status != null && status >= 500)
}

function telegramRetryDelayMs(err, retryIndex, baseDelayMs, maxDelayMs) {
  const exponent = Math.max(0, Math.min(16, Number(retryIndex) || 0))
  const exponentialMs = Math.min(maxDelayMs, baseDelayMs * (2 ** exponent))
  const retryAfterSec = Number(err?.retryAfterSec || err?.telegram?.parameters?.retry_after)
  const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? retryAfterSec * 1000
    : 0
  return Math.ceil(Math.min(maxDelayMs, Math.max(exponentialMs, retryAfterMs)))
}

function createAbortError() {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve()
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(t)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const t = setTimeout(finish, ms)
    t.unref?.()
    signal?.addEventListener('abort', finish, { once: true })
  })
}

module.exports = { createTelegramBotService }
