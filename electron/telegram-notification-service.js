const NOTIFICATION_RETRY_BASE_MS = 750
const NOTIFICATION_RETRY_MAX_MS = 60_000
const NOTIFICATION_SEND_MAX_ATTEMPTS = 4
const NOTIFICATION_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000
const NOTIFICATION_DEDUPE_MAX = 512
const NOTIFICATION_DEDUPE_PREF_KEY = 'telegram.terminal_notification_deliveries'

function createTelegramNotificationService({
  readScSettings,
  db,
  allowTerminalNotifications = false,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  now = Date.now,
  env = process.env,
}) {
  let terminalNotificationQueue = Promise.resolve()
  let notificationDeliveriesHydrated = false
  const notificationDeliveries = new Map()

  function readBotConfig() {
    const settings = readScSettings()
    const cfg = settings.telegram_bot || {}
    const apiKeys = settings.api_keys || {}
    const telegram = settings.telegram || {}
    const token = String(
      env.TELEGRAM_BOT_TOKEN
      || cfg.token
      || apiKeys.TELEGRAM_BOT_TOKEN
      || telegram.bot_token
      || ''
    ).trim()
    const allowedChatIds = Array.isArray(cfg.allowed_chat_ids)
      ? cfg.allowed_chat_ids.map(String)
      : []
    const explicitNotificationChatId = String(cfg.notification_chat_id || '').trim()

    return {
      token,
      enabled: cfg.enabled !== false && !!token,
      notificationChatId: explicitNotificationChatId
        || (allowedChatIds.length === 1 ? allowedChatIds[0] : null),
    }
  }

  async function telegramApi(method, payload, token) {
    if (!token) {
      const err = new Error('Telegram bot token is not configured')
      err.code = 'telegram_bot_not_configured'
      throw err
    }

    let response
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      err.telegramNetworkError = true
      throw err
    }

    let data = null
    try { data = await response.json() } catch {}
    if (!response.ok || !data?.ok) {
      const err = new Error(data?.description || `HTTP ${response.status}`)
      err.httpStatus = response.status
      err.telegram = data
      err.telegramErrorCode = Number(data?.error_code) || null
      err.retryAfterSec = Number(data?.parameters?.retry_after) || null
      throw err
    }
    return data.result
  }

  async function sendMessageWithRetry(chatId, text, token) {
    for (let attempt = 1; attempt <= NOTIFICATION_SEND_MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await telegramApi('sendMessage', {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }, token)
        return [{ message_id: result?.message_id || null }]
      } catch (err) {
        if (!isTransientTelegramError(err) || attempt >= NOTIFICATION_SEND_MAX_ATTEMPTS) {
          throw err
        }
        const delayMs = telegramRetryDelayMs(
          err,
          attempt - 1,
          NOTIFICATION_RETRY_BASE_MS,
          NOTIFICATION_RETRY_MAX_MS,
        )
        console.warn(
          `[TelegramNotification] sendMessage transient failure; retry ${attempt + 1}/${NOTIFICATION_SEND_MAX_ATTEMPTS} in ${delayMs}ms: ${err?.message || err}`,
        )
        await sleepImpl(delayMs)
      }
    }
    throw new Error('Telegram sendMessage retry loop exhausted')
  }

  function pruneExpiredNotificationDeliveries(at = now()) {
    for (const [eventId, entry] of notificationDeliveries) {
      if (entry.settled && entry.expiresAt <= at) notificationDeliveries.delete(eventId)
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

      const at = now()
      for (const saved of entries.slice(-NOTIFICATION_DEDUPE_MAX)) {
        const eventId = String(saved?.eventId || '').trim()
        const expiresAt = Number(saved?.expiresAt)
        if (!eventId || !Number.isFinite(expiresAt) || expiresAt <= at) continue
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
      console.warn(`[TelegramNotification] dedupe restore failed: ${err?.message || err}`)
    }
  }

  function persistNotificationDeliveries() {
    if (typeof db?.setUiPreference !== 'function') return
    const at = now()
    pruneExpiredNotificationDeliveries(at)
    const entries = [...notificationDeliveries.entries()]
      .filter(([, entry]) => entry.settled && entry.expiresAt > at && entry.result)
      .slice(-NOTIFICATION_DEDUPE_MAX)
      .map(([eventId, entry]) => ({
        eventId,
        expiresAt: entry.expiresAt,
        deliveries: Array.isArray(entry.result.deliveries) ? entry.result.deliveries : [],
      }))

    try {
      const saved = db.setUiPreference(
        NOTIFICATION_DEDUPE_PREF_KEY,
        { version: 1, entries },
      )
      if (saved?.ok === false) {
        console.warn(
          `[TelegramNotification] dedupe persist failed: ${saved.error || 'unknown error'}`,
        )
      }
    } catch (err) {
      console.warn(`[TelegramNotification] dedupe persist failed: ${err?.message || err}`)
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
        const err = new Error(
          config.token ? 'Telegram bot is disabled' : 'Telegram bot token is not configured',
        )
        err.code = config.token ? 'telegram_bot_disabled' : 'telegram_bot_not_configured'
        throw err
      }
      if (!config.notificationChatId) {
        const err = new Error('Telegram notification chat is not configured')
        err.code = 'telegram_notification_chat_not_configured'
        throw err
      }

      const tabName = String(event.tabName || 'Terminal')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160) || 'Terminal'
      const deliveries = await sendMessageWithRetry(
        config.notificationChatId,
        `🔔 Вкладка завершилась\n${tabName}`,
        config.token,
      )
      console.log(
        `[TelegramNotification] terminal completion sent event=${eventId.slice(0, 180)} deliveries=${deliveries.length}`,
      )
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
        deliveryEntry.expiresAt = now() + NOTIFICATION_DEDUPE_TTL_MS
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

  return { notifyTerminalCompletion }
}

function telegramErrorStatus(err) {
  const telegramCode = Number(err?.telegramErrorCode || err?.telegram?.error_code)
  if (Number.isFinite(telegramCode) && telegramCode > 0) return telegramCode
  const httpStatus = Number(err?.httpStatus)
  return Number.isFinite(httpStatus) && httpStatus > 0 ? httpStatus : null
}

function isTransientTelegramError(err) {
  if (!err) return false
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

function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

module.exports = {
  NOTIFICATION_DEDUPE_PREF_KEY,
  createTelegramNotificationService,
  isTransientTelegramError,
  telegramRetryDelayMs,
}
