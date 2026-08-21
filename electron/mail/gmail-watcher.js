// Наблюдатель за почтой: держит постоянное соединение с Gmail по IMAP и
// сообщает о новых письмах от интересующих отправителей.
//
// Почему IMAP IDLE, а не опрос раз в минуту: IDLE — это режим, в котором
// почтовый сервер сам присылает уведомление в момент доставки письма, поэтому
// реакция занимает секунду вместо «до минуты». Опрос оставлен как запасной
// путь, если соединение не держится.
//
// Соединение с почтой рвётся по множеству причин (сон ноутбука, смена сети,
// таймаут на стороне Gmail), поэтому обрыв здесь — штатное событие, а не
// ошибка: watcher переподключается с нарастающей паузой и продолжает с того
// места, где остановился.

const { EventEmitter } = require('node:events')

const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 5 * 60_000
const POLL_INTERVAL_MS = 60_000
const IDLE_REFRESH_MS = 20 * 60_000     // Gmail закрывает молчащий IDLE — обновляем раньше
// Письма, пришедшие до первого запуска, — это история, а не новости:
// при первом знакомстве с ящиком мы их только запоминаем, иначе включение
// фичи обернётся пачкой уведомлений о старом.
const CATCH_UP_WINDOW_MS = 15 * 60_000   // насколько «свежим» считается письмо после простоя
const MAX_BATCH = 25                     // за один заход не обрабатываем больше

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase()
}

/** Правило «от кого уведомлять»: точный адрес или домен вида `@example.com`. */
function matchesSenderRule(address, rules) {
  const from = normalizeAddress(address)
  if (!from) return false
  return rules.some(rule => {
    const r = normalizeAddress(rule)
    if (!r) return false
    if (r.startsWith('@')) return from.endsWith(r)
    if (r.startsWith('*@')) return from.endsWith(r.slice(1))
    return from === r
  })
}

class GmailWatcher extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.user      адрес ящика
   * @param {string} opts.password  пароль приложения (16 символов)
   * @param {string[]} opts.senders правила отправителей
   * @param {(uid:number)=>boolean} opts.isSeen  уже обработанное письмо
   * @param {(uid:number)=>void}    opts.markSeen
   */
  constructor(opts = {}) {
    super()
    this.user = opts.user
    this.password = opts.password
    this.senders = Array.isArray(opts.senders) ? opts.senders : []
    this.host = opts.host || 'imap.gmail.com'
    this.port = opts.port || 993
    this.mailbox = opts.mailbox || 'INBOX'
    this.isSeen = opts.isSeen || (() => false)
    this.markSeen = opts.markSeen || (() => {})
    this.logger = opts.logger || console
    this.pollIntervalMs = opts.pollIntervalMs || POLL_INTERVAL_MS
    this.hasBaseline = opts.hasBaseline === true      // ящик уже осматривали раньше
    this.markBaseline = opts.markBaseline || (() => {})
    this.catchUpWindowMs = Number.isFinite(opts.catchUpWindowMs)
      ? opts.catchUpWindowMs
      : CATCH_UP_WINDOW_MS

    this.client = null
    this.stopped = false
    this.attempt = 0
    this.pollTimer = null
    this.idleTimer = null
    this.checking = false
    this.status = 'idle'
  }

  log(msg) { this.logger.log?.(`[GmailWatcher] ${msg}`) }
  warn(msg) { this.logger.warn?.(`[GmailWatcher] ${msg}`) }

  async start() {
    this.stopped = false
    await this.connectLoop()
  }

  async stop() {
    this.stopped = true
    this.clearTimers()
    const client = this.client
    this.client = null
    this.status = 'stopped'
    if (client) { try { await client.logout() } catch { try { client.close() } catch {} } }
  }

  clearTimers() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
  }

  async connectLoop() {
    while (!this.stopped) {
      try {
        await this.connectOnce()
        return
      } catch (err) {
        if (this.stopped) return
        this.attempt += 1
        const fatal = isAuthFailure(err)
        this.status = fatal ? 'auth_failed' : 'reconnecting'
        this.emit('status', { status: this.status, error: err?.message || String(err) })
        if (fatal) {
          this.warn(`authentication rejected: ${err?.message || err}`)
          return    // пароль неверен — переподключение не поможет
        }
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(8, this.attempt - 1))
        this.warn(`connection failed (attempt ${this.attempt}), retry in ${Math.round(delay / 1000)}s: ${err?.message || err}`)
        await sleep(delay)
      }
    }
  }

  async connectOnce() {
    const { ImapFlow } = require('imapflow')
    const client = new ImapFlow({
      host: this.host,
      port: this.port,
      secure: true,
      auth: { user: this.user, pass: this.password },
      logger: false,
      emitLogs: false,
    })
    client.on('error', err => {
      if (this.stopped) return
      this.warn(`socket error: ${err?.message || err}`)
    })
    client.on('close', () => {
      if (this.stopped || this.client !== client) return
      this.clearTimers()
      this.client = null
      this.status = 'reconnecting'
      this.emit('status', { status: this.status })
      this.log('connection closed, reconnecting')
      this.connectLoop().catch(err => this.warn(`reconnect failed: ${err?.message || err}`))
    })

    await client.connect()
    await client.mailboxOpen(this.mailbox)
    this.client = client
    this.attempt = 0
    this.status = 'watching'
    this.emit('status', { status: this.status })
    this.log(`connected as ${this.user}, watching ${this.mailbox}`)

    // Сервер сообщил о новом письме — сразу идём смотреть.
    client.on('exists', () => { this.checkNew().catch(err => this.warn(`check failed: ${err?.message || err}`)) })

    await this.checkNew({ firstRun: true })
    // Ящик изучен — со следующего запуска старое пропускать уже не нужно.
    if (!this.hasBaseline) { this.hasBaseline = true; this.markBaseline() }

    // Подстраховка: если уведомление потерялось, всё равно посмотрим сами.
    this.pollTimer = setInterval(() => {
      this.checkNew().catch(err => this.warn(`poll failed: ${err?.message || err}`))
    }, this.pollIntervalMs)
    this.pollTimer.unref?.()
    this.scheduleIdleRefresh()
  }

  // Молчащее соединение Gmail закрывает сам. Периодически дёргаем NOOP,
  // чтобы обрыв случался по нашей инициативе, а не внезапно.
  scheduleIdleRefresh() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(async () => {
      if (this.stopped || !this.client) return
      try { await this.client.noop() } catch (err) { this.warn(`keepalive failed: ${err?.message || err}`) }
      this.scheduleIdleRefresh()
    }, IDLE_REFRESH_MS)
    this.idleTimer.unref?.()
  }

  async checkNew({ firstRun = false } = {}) {
    if (this.checking || !this.client || this.stopped) return
    this.checking = true
    const client = this.client
    let lock = null
    try {
      lock = await client.getMailboxLock(this.mailbox)
      const total = client.mailbox?.exists || 0
      if (!total) return

      // Берём хвост ящика: адресата фильтруем сами, потому что серверный
      // поиск по нескольким отправителям хрупок и по-разному ведёт себя
      // с алиасами.
      const from = Math.max(1, total - MAX_BATCH + 1)
      // Холодный старт: ящик видим впервые — всё, что там лежит, это история.
      // После простоя (сон ноутбука) досылаем только свежее.
      const coldStart = firstRun && !this.hasBaseline
      const staleBefore = Date.now() - this.catchUpWindowMs
      const messages = []
      for await (const msg of client.fetch(`${from}:*`, { uid: true, envelope: true, source: true })) {
        messages.push(msg)
      }
      messages.sort((a, b) => a.uid - b.uid)

      for (const msg of messages) {
        if (this.stopped) break
        if (this.isSeen(msg.uid)) continue
        const sender = msg.envelope?.from?.[0]?.address || ''
        if (!matchesSenderRule(sender, this.senders)) {
          this.markSeen(msg.uid)      // чужое письмо тоже помечаем, чтобы не пересматривать
          continue
        }
        const receivedAt = msg.envelope?.date ? new Date(msg.envelope.date).valueOf() : Date.now()
        if (coldStart || (firstRun && Number.isFinite(receivedAt) && receivedAt < staleBefore)) {
          this.markSeen(msg.uid)
          this.log(`skip old mail uid=${msg.uid} from=${sender} (не новое на момент запуска)`)
          continue
        }
        let parsed = null
        try {
          const { simpleParser } = require('mailparser')
          parsed = await simpleParser(msg.source)
        } catch (err) {
          this.warn(`parse failed uid=${msg.uid}: ${err?.message || err}`)
        }
        this.markSeen(msg.uid)
        this.emit('mail', {
          uid: msg.uid,
          messageId: parsed?.messageId || msg.envelope?.messageId || null,
          subject: parsed?.subject || msg.envelope?.subject || '',
          fromName: parsed?.from?.value?.[0]?.name || msg.envelope?.from?.[0]?.name || '',
          fromAddress: sender,
          date: parsed?.date || msg.envelope?.date || new Date(),
          html: parsed?.html || null,
          text: parsed?.text || '',
        })
      }
    } finally {
      if (lock) lock.release()
      this.checking = false
    }
  }
}

function isAuthFailure(err) {
  const text = `${err?.responseText || ''} ${err?.message || ''}`.toLowerCase()
  return err?.authenticationFailed === true
    || text.includes('invalid credentials')
    || text.includes('authenticationfailed')
    || text.includes('username and password not accepted')
}

function sleep(ms) {
  return new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.() })
}

module.exports = { GmailWatcher, matchesSenderRule, normalizeAddress }
