import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TBANK_ORIGIN = 'https://www.tbank.ru'
const TBANK_API_PREFIX = `${TBANK_ORIGIN}/api`
const TBANK_CONTEXT_API_PREFIX = `${TBANK_ORIGIN}/context-application/api`

const READ_ONLY_PATHS = new Set([
  '/common/v1/accounts_light_ib',
  '/common/v1/operations',
  '/common/v1/ping',
  '/common/v1/shopping_receipt',
  '/common/v1/statements',
])

const COOKIE_READ_ONLY_PATHS = new Set([
  '/common/v1/operations',
  '/common/v1/ping',
  '/common/v1/shopping_receipt',
])

export class TBankApiError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'TBankApiError'
    this.status = details.status || null
    this.resultCode = details.resultCode || null
    this.errorMessage = details.errorMessage || null
    this.apiPath = details.apiPath || null
  }
}

export function defaultAppRoot() {
  return process.env.SC_DESKTOP_DIR
    || process.env.MEDIA_INBOX_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop')
}

export function defaultSessionFile() {
  return path.join(defaultAppRoot(), 'tbank-personal', 'session.json')
}

export function defaultExportDir() {
  return path.join(defaultAppRoot(), 'tbank-personal', 'exports')
}

export function assertInsideAppRoot(filePath) {
  const appRoot = path.resolve(defaultAppRoot())
  const resolved = path.resolve(filePath)
  const rel = path.relative(appRoot, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside SC Desktop app root: ${resolved}`)
  }
  return resolved
}

export function assertSessionId(value) {
  const sessionId = String(value || '').trim()
  if (!sessionId) throw new Error('T-Bank session id is empty')
  if (/[\s;&?]/.test(sessionId)) {
    throw new Error('T-Bank session id contains unsafe characters')
  }
  return sessionId
}

export function normalizeCookieJar(cookies) {
  if (!Array.isArray(cookies)) return []
  return cookies
    .filter(cookie => cookie && cookie.name && cookie.value !== undefined)
    .map(cookie => ({
      name: String(cookie.name),
      value: String(cookie.value),
      domain: String(cookie.domain || '.tbank.ru'),
      path: String(cookie.path || '/'),
    }))
}

export function cookieHeaderForUrl(urlLike, cookies) {
  const url = urlLike instanceof URL ? urlLike : new URL(String(urlLike))
  return normalizeCookieJar(cookies)
    .filter(cookie => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase()
      const host = url.hostname.toLowerCase()
      const domainMatches = host === domain || host.endsWith(`.${domain}`)
      const pathMatches = url.pathname.startsWith(cookie.path || '/')
      return domainMatches && pathMatches
    })
    .sort((a, b) => b.path.length - a.path.length)
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

export async function saveSession(sessionId, options = {}) {
  const filePath = assertInsideAppRoot(options.sessionFile || defaultSessionFile())
  const body = {
    sessionId: assertSessionId(sessionId),
    updatedAt: new Date().toISOString(),
    source: options.source || 'manual-psid',
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(tmpPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmpPath, filePath)
  await fs.chmod(filePath, 0o600)
  return filePath
}

export async function loadSession(options = {}) {
  const envSession = process.env.TBANK_SESSION_ID || process.env.TBANK_PSID
  if (envSession) {
    return { sessionId: assertSessionId(envSession), source: 'env' }
  }

  const filePath = options.sessionFile || defaultSessionFile()
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
    const value = parsed.sessionId || parsed.id || parsed.psid
    if (!value) return null
    return {
      sessionId: assertSessionId(value),
      source: filePath,
      updatedAt: parsed.updatedAt || null,
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

function appendParam(url, key, value) {
  if (value === undefined || value === null || value === '') return
  if (value instanceof Date) {
    url.searchParams.set(key, String(value.getTime()))
    return
  }
  if (typeof value === 'boolean') {
    url.searchParams.set(key, value ? 'true' : 'false')
    return
  }
  url.searchParams.set(key, String(value))
}

function parseDateMillis(value, name) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`${name} is invalid`)
    return value.getTime()
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${name} is invalid: ${value}`)
  return date.getTime()
}

function parseLocalDateOnly(value, boundary) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const [, year, month, day] = match
  if (boundary === 'end') {
    return new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
  }
  return new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0)
}

function timezoneSuffix(date) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const hours = String(Math.floor(abs / 60)).padStart(2, '0')
  const minutes = String(abs % 60).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

function formatTbankDateTime(value, name, boundary = 'start') {
  if (!value) return undefined
  if (typeof value === 'string' && /T\d{2}:\d{2}/.test(value)) return value

  const localDateOnly = typeof value === 'string' ? parseLocalDateOnly(value, boundary) : null
  const date = localDateOnly || (value instanceof Date ? value : new Date(value))
  if (Number.isNaN(date.getTime())) throw new Error(`${name} is invalid: ${value}`)

  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${timezoneSuffix(date)}`
}

function fromMillisObject(value) {
  if (!value || typeof value !== 'object') return null
  if (!Number.isFinite(value.milliseconds)) return null
  return new Date(value.milliseconds).toISOString()
}

function moneyValue(value) {
  if (!value || typeof value !== 'object') return null
  return Number.isFinite(value.value) ? value.value : null
}

function moneyCurrency(value) {
  if (!value || typeof value !== 'object') return null
  if (value.strCode || value.name) return value.strCode || value.name
  return value.currency?.strCode || value.currency?.name || null
}

function inferDirection(operation) {
  const type = String([operation.type, operation.operationPaymentType].filter(Boolean).join(' ')).toLowerCase()
  if (/(debit|withdraw|purchase|payment|outcome|expense|cashout)/.test(type)) return 'expense'
  if (/(credit|deposit|income|payin|refund)/.test(type)) return 'income'

  const value = moneyValue(operation.accountAmount) ?? moneyValue(operation.amount)
  if (typeof value === 'number') {
    if (value < 0) return 'expense'
    if (value > 0) return 'income'
  }
  return 'unknown'
}

export function normalizeAccount(account) {
  return {
    id: account.id,
    name: account.name || null,
    type: account.accountType || null,
    hidden: Boolean(account.hidden),
    balance: moneyValue(account.moneyAmount),
    currency: moneyCurrency(account.moneyAmount || account.currency),
    cards: Array.isArray(account.cards)
      ? account.cards.map(card => ({
          id: card.id,
          name: card.name || null,
          value: card.value || null,
          status: card.status || card.statusCode || null,
          primary: Boolean(card.primary),
          paymentSystem: card.paymentSystem || null,
        }))
      : [],
  }
}

export function normalizeOperation(operation) {
  const amount = moneyValue(operation.amount)
  const accountAmount = moneyValue(operation.accountAmount)
  return {
    id: operation.id,
    account: operation.account || null,
    time: fromMillisObject(operation.operationTime),
    debitingTime: fromMillisObject(operation.debitingTime),
    description: operation.description || null,
    status: operation.status || null,
    type: operation.type || null,
    direction: inferDirection(operation),
    amount,
    amountCurrency: moneyCurrency(operation.amount),
    accountAmount,
    accountCurrency: moneyCurrency(operation.accountAmount),
    category: operation.spendingCategory?.name || operation.category?.name || null,
    categoryId: operation.spendingCategory?.id || operation.category?.id || null,
    mcc: operation.mcc || operation.mccString || null,
    merchant: operation.merchant?.name || operation.brand?.name || null,
    hasShoppingReceipt: Boolean(operation.hasShoppingReceipt),
    cardNumber: operation.cardNumber || null,
    raw: operation,
  }
}

export function inferAccountsFromOperations(operations) {
  const byId = new Map()
  for (const operation of operations || []) {
    const account = operation?.account
    const id = typeof account === 'object' && account
      ? account.id || account.account || account.value
      : account
    if (!id) continue
    const key = String(id)
    if (!byId.has(key)) {
      byId.set(key, {
        id: key,
        name: typeof account === 'object' && account ? account.name || null : null,
        type: typeof account === 'object' && account ? account.accountType || account.type || null : null,
        hidden: false,
        balance: null,
        currency: null,
        cards: [],
      })
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function shouldFetchAccount(account, options = {}) {
  if (!account || !account.id) return false
  if (account.hidden && !options.includeHidden) return false
  if (options.includeExternal) return true
  return account.accountType !== 'Telecom' && account.accountType !== 'ExternalAccount'
}

export function summarizeOperations(operations) {
  const byCategory = new Map()
  const totals = {
    operations: 0,
    expenses: 0,
    income: 0,
    unknown: 0,
  }

  for (const operation of operations.map(normalizeOperation)) {
    totals.operations += 1
    const value = operation.accountAmount ?? operation.amount ?? 0
    if (operation.direction === 'expense') totals.expenses += Math.abs(value)
    else if (operation.direction === 'income') totals.income += Math.abs(value)
    else totals.unknown += Math.abs(value)

    const key = operation.category || 'Uncategorized'
    const current = byCategory.get(key) || {
      category: key,
      operations: 0,
      expenses: 0,
      income: 0,
      unknown: 0,
    }
    current.operations += 1
    if (operation.direction === 'expense') current.expenses += Math.abs(value)
    else if (operation.direction === 'income') current.income += Math.abs(value)
    else current.unknown += Math.abs(value)
    byCategory.set(key, current)
  }

  return {
    totals,
    byCategory: [...byCategory.values()].sort((a, b) => b.expenses - a.expenses),
  }
}

export class TBankPersonalClient {
  constructor(options = {}) {
    this.sessionId = options.sessionId ? assertSessionId(options.sessionId) : null
    this.cookieJar = normalizeCookieJar(options.cookieJar || options.cookies)
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch is not available in this Node runtime')
    }
    if (!this.sessionId && this.cookieJar.length === 0) {
      throw new Error('T-Bank client requires either a psid sessionId or browser cookieJar')
    }
  }

  get usesBrowserCookies() {
    return this.cookieJar.length > 0
  }

  async request(apiPath, params = {}) {
    if (!this.sessionId) {
      throw new Error('This T-Bank endpoint requires a psid sessionId; use operations with browser cookies instead')
    }
    if (!READ_ONLY_PATHS.has(apiPath)) {
      throw new Error(`Blocked non-read or unknown T-Bank endpoint: ${apiPath}`)
    }

    const url = new URL(`${TBANK_API_PREFIX}${apiPath}`)
    url.searchParams.set('origin', 'web,ib5,platform')
    url.searchParams.set('sessionid', this.sessionId)
    for (const [key, value] of Object.entries(params)) {
      appendParam(url, key, value)
    }

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
    })

    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch (err) {
      throw new TBankApiError(`T-Bank returned non-JSON response for ${apiPath}`, {
        status: response.status,
        apiPath,
      })
    }

    if (!response.ok) {
      throw new TBankApiError(`T-Bank HTTP ${response.status} for ${apiPath}`, {
        status: response.status,
        apiPath,
      })
    }

    if (data?.resultCode && data.resultCode !== 'OK') {
      throw new TBankApiError(data.errorMessage || `T-Bank resultCode ${data.resultCode}`, {
        status: response.status,
        resultCode: data.resultCode,
        errorMessage: data.errorMessage || null,
        apiPath,
      })
    }

    return data?.payload ?? data
  }

  async cookieRequest(apiPath, params = {}) {
    if (!COOKIE_READ_ONLY_PATHS.has(apiPath)) {
      throw new Error(`Blocked non-read or unknown T-Bank browser-cookie endpoint: ${apiPath}`)
    }
    if (this.cookieJar.length === 0) {
      throw new Error('Browser cookie jar is empty')
    }

    const url = new URL(`${TBANK_CONTEXT_API_PREFIX}${apiPath}`)
    url.searchParams.set('origin', 'web,ib5,platform')
    for (const [key, value] of Object.entries(params)) {
      appendParam(url, key, value)
    }

    const response = await this.fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        Cookie: cookieHeaderForUrl(url, this.cookieJar),
        Referer: `${TBANK_ORIGIN}/mybank/`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      },
    })

    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch (err) {
      throw new TBankApiError(`T-Bank returned non-JSON response for ${apiPath}`, {
        status: response.status,
        apiPath,
      })
    }

    if (!response.ok) {
      throw new TBankApiError(`T-Bank HTTP ${response.status} for ${apiPath}`, {
        status: response.status,
        apiPath,
      })
    }

    if (data?.resultCode && data.resultCode !== 'OK') {
      throw new TBankApiError(data.errorMessage || `T-Bank resultCode ${data.resultCode}`, {
        status: response.status,
        resultCode: data.resultCode,
        errorMessage: data.errorMessage || null,
        apiPath,
      })
    }

    return data?.payload ?? data
  }

  ping() {
    return this.usesBrowserCookies
      ? this.cookieRequest('/common/v1/ping')
      : this.request('/common/v1/ping')
  }

  accounts() {
    return this.request('/common/v1/accounts_light_ib')
  }

  statements(options = {}) {
    if (!options.account) throw new Error('statements: account is required')
    return this.request('/common/v1/statements', {
      account: options.account,
      itemsOrder: options.itemsOrder,
    })
  }

  operations(options = {}) {
    if (!options.from) throw new Error('operations: from is required')
    if (this.usesBrowserCookies) {
      return this.cookieRequest('/common/v1/operations', {
        account: options.account && options.account !== 'all' ? options.account : undefined,
        start: formatTbankDateTime(options.from, 'from', 'start'),
        end: options.to ? formatTbankDateTime(options.to, 'to', 'end') : undefined,
        operationId: options.operationId,
      })
    }

    if (!options.account) throw new Error('operations: account is required')
    return this.request('/common/v1/operations', {
      account: options.account,
      start: parseDateMillis(options.from, 'from'),
      end: options.to ? parseDateMillis(options.to, 'to') : undefined,
      operationId: options.operationId,
      trancheCreationAllowed: options.trancheCreationAllowed,
      loyaltyPaymentProgram: options.loyaltyPaymentProgram,
      loyaltyPaymentStatus: options.loyaltyPaymentStatus,
    })
  }

  shoppingReceipt(options = {}) {
    if (!options.operationId) throw new Error('shoppingReceipt: operationId is required')
    return this.request('/common/v1/shopping_receipt', {
      operationId: options.operationId,
      operationTime: options.operationTime ? parseDateMillis(options.operationTime, 'operationTime') : undefined,
      idSourceType: options.idSourceType,
      account: options.account,
    })
  }

  async operationsForAccounts(options = {}) {
    if (this.usesBrowserCookies) {
      const operations = await this.operations({
        account: options.account || 'all',
        from: options.from,
        to: options.to,
      })
      return [{
        account: { id: options.account || 'all', name: null },
        operations,
      }]
    }

    const accounts = options.accounts || await this.accounts()
    const selected = accounts.filter(account => {
      if (options.account && options.account !== 'all') return account.id === options.account
      return shouldFetchAccount(account, options)
    })

    const results = []
    for (const account of selected) {
      const operations = await this.operations({
        account: account.id,
        from: options.from,
        to: options.to,
      })
      results.push({ account, operations })
    }
    return results
  }
}
