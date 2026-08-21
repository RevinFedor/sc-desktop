// Связывает почту и Telegram: слушает новые письма от заданных отправителей
// и присылает каждое в чат одним раскрывающимся сообщением.
//
// Настройки живут в общем ~/.config/sc/settings.json (секция `mail`), пароль
// приложения — там же. Память о том, какие письма уже отправлены, хранится в
// ui_preferences базы приложения, поэтому перезапуск не приводит к повторной
// отправке одного и того же письма.

const { GmailWatcher } = require('./gmail-watcher')
const { buildRichMessage } = require('./email-to-rich')

const SEEN_PREF_KEY = 'mail.gmail_seen_uids'
const BASELINE_PREF_KEY = 'mail.gmail_baseline'
const SEEN_MAX = 500
const SEND_MAX_ATTEMPTS = 4
const SEND_RETRY_BASE_MS = 1_000
const SEND_RETRY_MAX_MS = 60_000

// Ссылка «открыть в Gmail» по стабильному идентификатору письма: точный адрес
// конкретного письма серверу неизвестен, но поиск по Message-ID открывает
// именно его.
function gmailSearchUrl(messageId) {
  const id = String(messageId || '').replace(/^<|>$/g, '').trim()
  if (!id) return null
  return `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(id)}`
}

// Домен отправителя — разумная догадка про «сайт, о котором письмо».
// Используется как цель ссылки в заголовке.
function siteUrlFor(mail, overrides = {}) {
  const address = String(mail.fromAddress || '').toLowerCase()
  const domain = address.split('@')[1] || ''
  if (!domain) return null
  for (const [rule, url] of Object.entries(overrides)) {
    const key = String(rule).toLowerCase().replace(/^@/, '')
    if (domain === key || address === key) return url
  }
  const bare = domain.replace(/^(mail|email|mailer|smtp|news|notifications?|no-?reply)\./, '')
  return `https://${bare}/`
}

function readMailConfig(readScSettings) {
  const settings = readScSettings() || {}
  const mail = settings.mail || {}
  const gmail = mail.gmail || {}
  const senders = Array.isArray(mail.senders) ? mail.senders.map(String).filter(Boolean) : []
  return {
    enabled: mail.enabled === true,
    user: String(gmail.user || '').trim(),
    password: String(gmail.app_password || '').trim(),
    mailbox: String(gmail.mailbox || 'INBOX'),
    senders,
    siteOverrides: mail.site_urls && typeof mail.site_urls === 'object' ? mail.site_urls : {},
    chatId: String(mail.chat_id || '').trim(),
  }
}

function createMailNotificationService({
  readScSettings,
  db,
  telegramApi,            // (method, payload) => Promise<result>
  logger = console,
  allowDelivery = true,
  sleepImpl = sleep,
}) {
  let watcher = null
  let seen = null
  let lastStatus = { status: 'stopped' }

  function loadSeen() {
    if (seen) return seen
    seen = new Set()
    try {
      const stored = db?.getUiPreference?.(SEEN_PREF_KEY)
      const list = Array.isArray(stored) ? stored : stored?.uids
      if (Array.isArray(list)) for (const uid of list) seen.add(Number(uid))
    } catch (err) {
      logger.warn?.(`[MailNotify] seen restore failed: ${err?.message || err}`)
    }
    return seen
  }

  function persistSeen() {
    try {
      const list = [...loadSeen()].sort((a, b) => a - b).slice(-SEEN_MAX)
      seen = new Set(list)
      db?.setUiPreference?.(SEEN_PREF_KEY, { version: 1, uids: list })
    } catch (err) {
      logger.warn?.(`[MailNotify] seen persist failed: ${err?.message || err}`)
    }
  }

  async function sendWithRetry(payload) {
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await telegramApi('sendRichMessage', payload)
      } catch (err) {
        const retryable = isTransient(err)
        if (!retryable || attempt >= SEND_MAX_ATTEMPTS) throw err
        const retryAfter = Number(err?.retryAfterSec) > 0 ? Number(err.retryAfterSec) * 1000 : 0
        const delay = Math.min(SEND_RETRY_MAX_MS, Math.max(retryAfter, SEND_RETRY_BASE_MS * 2 ** (attempt - 1)))
        logger.warn?.(`[MailNotify] send retry ${attempt + 1}/${SEND_MAX_ATTEMPTS} in ${delay}ms: ${err?.message || err}`)
        await sleepImpl(delay)
      }
    }
    throw new Error('send retry loop exhausted')
  }

  async function deliver(mail, config) {
    const { html, truncated } = buildRichMessage({
      subject: mail.subject,
      fromName: mail.fromName,
      fromAddress: mail.fromAddress,
      html: mail.html,
      text: mail.text,
      date: mail.date,
      headerUrl: siteUrlFor(mail, config.siteOverrides),
      gmailUrl: gmailSearchUrl(mail.messageId),
    })

    try {
      await sendWithRetry({ chat_id: config.chatId, rich_message: { html } })
      logger.log?.(`[MailNotify] delivered uid=${mail.uid} from=${mail.fromAddress} truncated=${truncated}`)
      return { ok: true, truncated }
    } catch (err) {
      // Rich-сообщение может не собраться из-за неожиданной разметки письма.
      // Тогда лучше короткое обычное уведомление, чем молчание.
      logger.warn?.(`[MailNotify] rich send failed uid=${mail.uid}: ${err?.message || err}`)
      try {
        const fallback = `📬 ${mail.subject || '(без темы)'}\n${mail.fromAddress || ''}`.slice(0, 3500)
        await telegramApi('sendMessage', {
          chat_id: config.chatId, text: fallback, disable_web_page_preview: true,
        })
        logger.log?.(`[MailNotify] delivered uid=${mail.uid} via plain fallback`)
        return { ok: true, fallback: true }
      } catch (fallbackErr) {
        logger.warn?.(`[MailNotify] fallback failed uid=${mail.uid}: ${fallbackErr?.message || fallbackErr}`)
        return { ok: false, error: fallbackErr?.message || String(fallbackErr) }
      }
    }
  }

  async function start() {
    const config = readMailConfig(readScSettings)
    if (!config.enabled) { lastStatus = { status: 'disabled' }; return lastStatus }
    if (!allowDelivery) { lastStatus = { status: 'not_allowed' }; return lastStatus }
    if (!config.user || !config.password) {
      lastStatus = { status: 'not_configured', error: 'нужны адрес ящика и пароль приложения' }
      logger.warn?.('[MailNotify] gmail credentials are not configured')
      return lastStatus
    }
    if (!config.chatId) {
      lastStatus = { status: 'not_configured', error: 'не задан чат для уведомлений' }
      return lastStatus
    }
    if (!config.senders.length) {
      lastStatus = { status: 'not_configured', error: 'не задан ни один отправитель' }
      return lastStatus
    }
    await stop()

    const store = loadSeen()
    // Метка «этот ящик уже осматривали»: без неё каждый перезапуск считался бы
    // первым знакомством и старые письма молча пропускались бы навсегда.
    const baselineKey = `${config.user}|${config.mailbox}`
    let baseline = null
    try { baseline = db?.getUiPreference?.(BASELINE_PREF_KEY) } catch { /* нет — значит первый запуск */ }
    const hasBaseline = baseline?.key === baselineKey

    watcher = new GmailWatcher({
      user: config.user,
      password: config.password,
      mailbox: config.mailbox,
      senders: config.senders,
      isSeen: uid => store.has(uid),
      markSeen: uid => { store.add(uid); persistSeen() },
      hasBaseline,
      markBaseline: () => {
        try {
          db?.setUiPreference?.(BASELINE_PREF_KEY, { version: 1, key: baselineKey, at: Date.now() })
        } catch (err) {
          logger.warn?.(`[MailNotify] baseline persist failed: ${err?.message || err}`)
        }
      },
      logger,
    })
    watcher.on('status', s => { lastStatus = s })
    watcher.on('mail', mail => {
      deliver(mail, readMailConfig(readScSettings))
        .catch(err => logger.warn?.(`[MailNotify] deliver crashed: ${err?.message || err}`))
    })
    await watcher.start()
    lastStatus = { status: watcher.status }
    return lastStatus
  }

  async function stop() {
    if (!watcher) return
    const w = watcher
    watcher = null
    await w.stop()
  }

  function status() {
    return { ...lastStatus, watching: !!watcher }
  }

  return { start, stop, status, deliver, readConfig: () => readMailConfig(readScSettings) }
}

function isTransient(err) {
  const status = Number(err?.telegramErrorCode || err?.httpStatus) || 0
  return err?.telegramNetworkError === true
    || status === 429 || status === 408 || status >= 500
}

function sleep(ms) {
  return new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.() })
}

module.exports = {
  SEEN_PREF_KEY,
  BASELINE_PREF_KEY,
  createMailNotificationService,
  gmailSearchUrl,
  siteUrlFor,
  readMailConfig,
}
