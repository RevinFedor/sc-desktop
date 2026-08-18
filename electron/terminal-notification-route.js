const {
  ensureNotificationToken,
  matchesBearerToken,
} = require('./local-notification-auth')

const TERMINAL_NOTIFICATION_BODY_LIMIT = 16 * 1024
const TERMINAL_NOTIFICATION_RATE_LIMIT = 30
const TERMINAL_NOTIFICATION_RATE_WINDOW_MS = 60_000

function requiredNotificationString(value, field, maxLength) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} is required`)
  if (normalized.length > maxLength) throw new Error(`${field} is too long`)
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} contains control characters`)
  }
  return normalized
}

function normalizeTerminalCompletionEvent(body = {}) {
  if (body.kind !== 'terminal-completion') {
    throw new Error('kind must be terminal-completion')
  }
  const firedAt = Number(body.firedAt)
  if (!Number.isSafeInteger(firedAt) || firedAt <= 0) {
    throw new Error('firedAt must be a positive epoch-ms integer')
  }
  const mode = body.mode === 'persistent'
    ? 'persistent'
    : body.mode === 'oneshot'
      ? 'oneshot'
      : null
  if (!mode) throw new Error('mode must be oneshot or persistent')
  if (typeof body.unread !== 'boolean') throw new Error('unread must be a boolean')

  const event = {
    kind: 'terminal-completion',
    eventId: requiredNotificationString(body.eventId, 'eventId', 320),
    projectId: requiredNotificationString(body.projectId, 'projectId', 512),
    tabId: requiredNotificationString(body.tabId, 'tabId', 512),
    tabName: requiredNotificationString(body.tabName, 'tabName', 160).replace(/\s+/g, ' '),
    firedAt,
    mode,
    unread: body.unread,
  }
  if (event.eventId !== `${event.tabId}:${event.firedAt}`) {
    throw new Error('eventId must match tabId:firedAt')
  }
  return event
}

function createTerminalNotificationRoute({
  notificationService,
  ensureToken = ensureNotificationToken,
  now = Date.now,
  rateLimit = TERMINAL_NOTIFICATION_RATE_LIMIT,
  rateWindowMs = TERMINAL_NOTIFICATION_RATE_WINDOW_MS,
  logger = console,
}) {
  let notificationAuthToken = null
  try {
    const auth = ensureToken()
    notificationAuthToken = auth.token
    logger.log?.(`[BrowserBridge] terminal notification auth ready path=${auth.tokenPath}`)
  } catch (err) {
    logger.warn?.(
      `[BrowserBridge] terminal notification auth unavailable: ${err?.message || err}`,
    )
  }
  const notificationRequestTimes = []

  async function handle(req, res, url) {
    if (req.method !== 'POST' || url.pathname !== '/notifications/terminal-completion') {
      return false
    }
    if (req.headers.origin) {
      sendJson(res, 403, { ok: false, error: 'browser origins are not allowed' })
      return true
    }
    if (!notificationAuthToken) {
      sendJson(res, 503, {
        ok: false,
        error: 'notification bridge authentication is unavailable',
      })
      return true
    }
    if (!matchesBearerToken(req.headers.authorization, notificationAuthToken)) {
      sendJson(res, 401, {
        ok: false,
        error: 'invalid notification bridge credentials',
      })
      return true
    }
    if (typeof notificationService?.notifyTerminalCompletion !== 'function') {
      sendJson(res, 503, { ok: false, error: 'notification service is unavailable' })
      return true
    }

    const at = now()
    while (
      notificationRequestTimes.length
      && notificationRequestTimes[0] <= at - rateWindowMs
    ) {
      notificationRequestTimes.shift()
    }
    if (notificationRequestTimes.length >= rateLimit) {
      res.setHeader('Retry-After', String(Math.ceil(rateWindowMs / 1000)))
      sendJson(res, 429, {
        ok: false,
        error: 'terminal notification rate limit exceeded',
      })
      return true
    }
    notificationRequestTimes.push(at)

    let body
    try {
      body = await readJsonBody(req, TERMINAL_NOTIFICATION_BODY_LIMIT)
    } catch (err) {
      const status = err?.code === 'BODY_TOO_LARGE' ? 413 : 400
      sendJson(res, status, {
        ok: false,
        error: err?.message || 'invalid JSON body',
      })
      return true
    }

    let event
    try {
      event = normalizeTerminalCompletionEvent(body)
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err?.message || 'invalid terminal completion event',
      })
      return true
    }

    try {
      const result = await notificationService.notifyTerminalCompletion(event)
      sendJson(res, 200, {
        ok: true,
        eventId: event.eventId,
        duplicate: result?.duplicate === true,
        deliveries: Array.isArray(result?.deliveries) ? result.deliveries : [],
      })
    } catch (err) {
      const unavailable = new Set([
        'telegram_bot_disabled',
        'telegram_bot_not_configured',
        'telegram_notification_chat_not_configured',
        'telegram_notifications_not_allowed',
      ])
      const status = unavailable.has(err?.code) ? 503 : 502
      logger.warn?.(
        `[BrowserBridge] terminal notification failed code=${err?.code || 'telegram_delivery_failed'} error=${err?.message || err}`,
      )
      sendJson(res, status, {
        ok: false,
        code: err?.code || 'telegram_delivery_failed',
        error: err?.message || 'Telegram delivery failed',
      })
    }
    return true
  }

  return { handle }
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let data = ''
    let received = 0
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', chunk => {
      received += Buffer.byteLength(chunk, 'utf8')
      if (received > maxBytes) {
        tooLarge = true
        data = ''
        return
      }
      if (!tooLarge) data += chunk
    })
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error(`request body too large (${received} > ${maxBytes})`)
        err.code = 'BODY_TOO_LARGE'
        reject(err)
        return
      }
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

module.exports = {
  TERMINAL_NOTIFICATION_BODY_LIMIT,
  createTerminalNotificationRoute,
  normalizeTerminalCompletionEvent,
}
