// HTTP-bridge для browser-extension → Electron
//
// Расширение SC Browser Parser шлёт сюда «забрать видео» / «добери транскрипт».
// Только loopback (127.0.0.1) и только заранее известные origin'ы (сайты
// которые мы покрываем content-script'ами). Никакого стороннего доступа.
//
// Эндпоинты:
//   POST /yt-add        { url, withComments?, lang? }
//                       (engine НЕ принимается здесь — Stage 1 только субтитры;
//                        движок AI выбирается при resume через /yt-resume-ai)
//                       → cache-first lookup. Hit → { fromCache:true,
//                         cached_file_path, cached_comments_file_path? }
//                         Miss → запускает yt_transcribe + опц. yt_comments,
//                         возвращает { jobId, commentsJobId? }
//   GET  /yt-status?id&wait=N → { status, file_path?, comments_file_path?,
//                           transcript_text?, comments_text?, yt_stage?,
//                           yt_engine?, error? }
//                         text-поля присутствуют только когда обе стадии done,
//                         чтобы расширение могло одним запросом получить готовое.
//                         yt_stage = searching|subs_found|awaiting_ai|
//                         transcribing|transcribed (нужен extension'у для
//                         осмысленного toast'а: «Ищу субтитры…» vs «Запрос к
//                         Gemini…»). yt_engine = gemini|assemblyai (только
//                         после transcribe_start).
//                         wait=ms (опц., 1..25000) — long-poll: держим ответ
//                         пока (status, yt_stage, yt_engine, comments_status)
//                         не изменится либо до тайм-аута. Альтернатива
//                         alarm-polling'у в SW (6с минимум), убирает 0-6с
//                         задержку между «sc-desktop сохранил» и «pill done».
//   POST /yt-resume-ai  { id, engine? } → дёргает resumeYoutubeAi для job'а
//                       зависшего в awaiting_ai. Используется автоматически
//                       background tracker'ом расширения (юзеру negde нажать
//                       «продолжить через AI» — это фоновый flow).
//   GET  /yt-fetch?path → { text, file_path } — read готового файла из
//                         Library без оборота через job (для cache-hit'ов)
//   GET  /healthz       → { ok:true } для overlay'я в расширении
//
// Порт прибит на 53127 — расширение знает его наизусть, без discovery. Если
// порт занят — предполагаем, что уже запущен другой инстанс sc-desktop, и
// логируем без падения main process'а (UI продолжает работать без расширения).

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const researchState = require('./research-state')
const {
  ensureNotificationToken,
  matchesBearerToken,
} = require('./local-notification-auth')
const {
  EXTENSION_YOUTUBE_SCHEMA_VERSION,
  extensionYoutubeFromSettings,
  extensionYoutubeSchemaState,
  patchExtensionYoutubeSettings,
} = require('./app-settings')

const BODY_LIMITS = {
  default: 64 * 1024,
  terminalNotification: 16 * 1024,
  researchStart: 2 * 1024 * 1024,
  researchState: 5 * 1024 * 1024,
  researchArtifactJson: 30 * 1024 * 1024,
  researchArtifactFile: 25 * 1024 * 1024,
}

// История research persist'ится в library.db (research_jobs). Терминальные
// (done/error) джобы пишем туда, чтобы История MCP переживала рестарт.
let _db = null
function db() {
  if (!_db) { try { _db = require('./database') } catch (e) { console.log('[BrowserBridge] db load failed:', e.message) } }
  return _db
}
function persistResearchJob(snap) {
  if (!snap || (snap.status !== 'done' && snap.status !== 'error')) return
  try {
    const r = researchResultForPersist(snap)
    db()?.upsertResearchJob({
      jobId: snap.id, kind: 'research', provider: snap.provider,
      modelId: snap.provider === 'chatgpt'
        ? `${snap.options?.model || '5.5'} · ${snap.options?.effort || 'xhigh'}`
        : snap.provider === 'claude'
          ? researchState.claudeModelLabel(snap.options)
          : (snap.options?.model || (snap.provider === 'perplexity' ? 'default' : null)),
      mode: snap.options?.mode || null,
      status: snap.status, stage: snap.stage,
      fullPrompt: snap.prompt, responseText: r.text || null,
      url: snap.url, responseTextLen: r.text ? r.text.length : null,
      linkCount: Array.isArray(r.sources) ? r.sources.length : null,
      result: r,
      error: snap.error, createdAt: snap.createdAt, updatedAt: snap.updatedAt, doneAt: snap.doneAt,
    })
  } catch (e) { console.log('[BrowserBridge] persistResearchJob failed:', e.message) }
}
function persistAistudioJob(j) {
  if (!j || (j.status !== 'done' && j.status !== 'error')) return
  try {
    db()?.upsertResearchJob({
      jobId: j.jobId, kind: 'aistudio', provider: 'aistudio',
      modelId: j.modelId, mode: null,
      status: j.status, stage: j.stage,
      fullPrompt: j.prompt || j.promptHead, responseText: j.responseText || null,
      url: j.url, responseTextLen: j.responseTextLen ?? null, linkCount: j.linkCount ?? null,
      error: j.error, createdAt: j.createdAt, updatedAt: j.updatedAt, doneAt: j.doneAt || j.updatedAt,
    })
  } catch (e) { console.log('[BrowserBridge] persistAistudioJob failed:', e.message) }
}

// WS-клиент к mcp/browser/bridge.js (порт 3458) — нужен чтобы дёргать
// commands в extension (mcp_open_research_tab и подобные) из HTTP-handler'ов
// здесь. Без этого пришлось бы дублировать tab-management через WS-сервер,
// и юзер не смог бы открывать research-вкладку через curl.
//
// Подключение lazy: первый /research-start триггерит коннект. Дальше port
// держится живым (long-lived). Если bridge упал — на следующий вызов
// reconnect автоматически.
let WS
try { WS = require('ws') } catch (_) { WS = null }
const MCP_BRIDGE_URL = 'ws://localhost:3458'
let mcpBridgeWs = null
let mcpCommandSeq = 0
const mcpPending = new Map() // commandId → { resolve, reject, timer }

function ensureMcpBridge() {
  if (!WS) return Promise.reject(new Error('ws module not available'))
  if (mcpBridgeWs && mcpBridgeWs.readyState === WS.OPEN) return Promise.resolve(mcpBridgeWs)
  if (mcpBridgeWs && mcpBridgeWs.readyState === WS.CONNECTING) {
    return new Promise((resolve, reject) => {
      const ws = mcpBridgeWs
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }
  return new Promise((resolve, reject) => {
    const ws = new WS(MCP_BRIDGE_URL)
    mcpBridgeWs = ws
    ws.on('open', () => {
      console.log('[BrowserBridge] connected to mcp bridge ws://localhost:3458')
      resolve(ws)
    })
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        const pending = mcpPending.get(msg.commandId)
        if (!pending) return
        mcpPending.delete(msg.commandId)
        clearTimeout(pending.timer)
        if (msg.success === false) pending.reject(new Error(msg.error || 'extension error'))
        else pending.resolve(msg)
      } catch (e) {
        console.error('[BrowserBridge] mcp ws parse error:', e.message)
      }
    })
    ws.on('close', () => {
      console.log('[BrowserBridge] mcp bridge ws closed')
      mcpBridgeWs = null
      // Reject все pending
      for (const [, p] of mcpPending) { clearTimeout(p.timer); p.reject(new Error('mcp bridge closed')) }
      mcpPending.clear()
    })
    ws.on('error', (e) => {
      // Не reject'им — будет close. Логируем чтоб не молчать.
      console.error('[BrowserBridge] mcp bridge ws error:', e.message)
    })
  })
}

function sendToExtension(action, payload = {}, timeoutMs = 15000) {
  return ensureMcpBridge().then(ws => new Promise((resolve, reject) => {
    const commandId = ++mcpCommandSeq
    const timer = setTimeout(() => {
      mcpPending.delete(commandId)
      reject(new Error(`extension command timeout (${timeoutMs}ms): ${action}`))
    }, timeoutMs)
    mcpPending.set(commandId, { resolve, reject, timer })
    ws.send(JSON.stringify({ commandId, action, ...payload }))
  }))
}

const PORT = 53127
const RELOAD_WS_PORT = 53129  // hot-reload WebSocket (dev only)

// In-memory зеркало AI Studio MCP jobs (см. POST /aistudio-state).
// jobId → {jobId, status, stage, modelId, elapsedSec, promptHead, ...}
// Хранится час. Перезапуск sc-desktop = очистка; CS на следующем log-event
// автоматически восстанавливает свою активную запись.
const AISTUDIO_JOBS = new Map()
// Кэш реестра Perplexity-моделей. Заполняется CS через POST /pplx-models-register
// при каждой загрузке perplexity-страницы. Источник правды — perplexity-research.js.
let PPLX_MODELS_CACHE = null
const AISTUDIO_TTL_MS = 60 * 60 * 1000 // 1 час

// Очередь команд для расширения (focus tab / close tab из popover'а).
// Bridge не имеет прямого доступа к chrome.tabs — кладём команду в queue,
// расширение opt-in polls и выполняет. См. background.js::pollBridgeCommands.
const BRIDGE_COMMAND_QUEUE = []  // [{cmd:'focus_tab'|'close_tab', tabId, ts}]
// host_permissions расширения — синхронизировано с manifest.json
const ALLOWED_ORIGINS = new Set([
  'https://www.youtube.com',
  'https://m.youtube.com',
  'https://aistudio.google.com',
  'https://claude.ai',
  'https://www.perplexity.ai',
  'https://chatgpt.com',
])
// extension service worker делает fetch с origin `chrome-extension://<id>`.
// Этот origin не предсказуем (Chrome генерирует ID), но всегда начинается с
// `chrome-extension://`. Whitelist'им по префиксу.
function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.has(origin)) return true
  if (origin && origin.startsWith('chrome-extension://')) return true
  return false
}

// The manifest contains a fixed public key, so the extension ID is stable in
// both Chrome and Yandex. Settings contain prompts/project names and must not
// be exposed to every unrelated installed extension.
const SC_BROWSER_EXTENSION_ID = 'phnlfhkblebijojjnnlbcbklijgcijgf'
const SC_BROWSER_EXTENSION_ORIGIN = `chrome-extension://${SC_BROWSER_EXTENSION_ID}`
function isExtensionOrigin(origin) {
  return origin === SC_BROWSER_EXTENSION_ORIGIN
}

function isExtensionSettingsRequest(req) {
  const origin = req.headers.origin || ''
  if (isExtensionOrigin(origin)) return true
  // Yandex's MV3 service worker omits Origin on loopback fetches. Sec-Fetch-*
  // headers cannot be set by a web page, and the explicit extension id keeps
  // ordinary origin-less requests out of the settings route.
  return !origin &&
    req.headers['x-sc-extension-id'] === SC_BROWSER_EXTENSION_ID &&
    req.headers['sec-fetch-site'] === 'none' &&
    req.headers['sec-fetch-mode'] === 'cors'
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-SC-Extension-Id')
  res.setHeader('Access-Control-Max-Age', '600')
  // Chrome PNA (Private Network Access, начиная с Chrome 104+): fetch с
  // публичного origin (https://claude.ai) на private IP (127.0.0.1) требует
  // ответный заголовок, иначе preflight отлуп — даже если CORS-Origin
  // пропущен. У aistudio/youtube этой проблемы не было заметно из-за
  // более лояльной матрицы Google для собственных доменов, но claude.ai
  // строго требует. Безопасно отдавать только для known origins выше.
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req, maxBytes = BODY_LIMITS.default) {
  return new Promise((resolve, reject) => {
    let data = ''
    let received = 0
    req.setEncoding('utf-8')
    req.on('data', chunk => {
      received += Buffer.byteLength(chunk, 'utf8')
      data += chunk
      if (received > maxBytes) {
        const err = new Error(`request body too large (${received} > ${maxBytes})`)
        err.code = 'BODY_TOO_LARGE'
        req.destroy(err)
      }
    })
    req.on('end',  () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

const IMAGE_EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const IMAGE_MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

function fileMime(fp) {
  return IMAGE_EXT_MIME[path.extname(fp || '').toLowerCase()] || 'application/octet-stream'
}

function safeFileName(name, fallback = 'artifact') {
  const base = path.basename(String(name || fallback))
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return base || fallback
}

function normalizeResearchAttachments(raw) {
  const arr = Array.isArray(raw) ? raw : []
  const out = []
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i]
    const fp = typeof it === 'string'
      ? it
      : (typeof it?.path === 'string' ? it.path
        : (typeof it?.file_path === 'string' ? it.file_path : ''))
    if (!fp) continue
    const abs = path.resolve(fp)
    const st = fs.statSync(abs)
    if (!st.isFile()) throw new Error(`attachment is not a file: ${abs}`)
    if (st.size > 20 * 1024 * 1024) throw new Error(`attachment too large (${st.size} bytes): ${abs}`)
    const mime = typeof it?.mime === 'string' ? it.mime : fileMime(abs)
    if (!mime.startsWith('image/')) throw new Error(`only image attachments are supported for ChatGPT research: ${abs}`)
    out.push({
      index: out.length,
      path: abs,
      name: safeFileName(it?.name || path.basename(abs), `attachment-${i + 1}${path.extname(abs) || '.png'}`),
      mime,
      size: st.size,
    })
  }
  return out
}

function publicAttachmentMeta(a) {
  return { index: a.index, name: a.name, mime: a.mime, size: a.size }
}

function materializeResearchAttachments({ libRoot, id, attachments }) {
  if (!Array.isArray(attachments) || attachments.length === 0) return []
  const safeId = safeFileName(id, 'research')
  const dir = path.join(libRoot, 'research-artifacts', safeId, 'input')
  fs.mkdirSync(dir, { recursive: true })
  return attachments.map((a, i) => {
    const src = a.path
    const ext = IMAGE_MIME_EXT[String(a.mime || '').toLowerCase()]
      || path.extname(a.name || src).toLowerCase()
      || '.png'
    const stem = safeFileName(path.basename(a.name || `input-${i + 1}`, path.extname(a.name || '')), `input-${i + 1}`)
    const name = `${String(i + 1).padStart(2, '0')}-${stem}${ext}`
    const dest = path.join(dir, name)
    fs.copyFileSync(src, dest)
    const st = fs.statSync(dest)
    return {
      ...a,
      original_path: src,
      path: dest,
      name,
      size: st.size,
      artifact_role: 'input',
    }
  })
}

function researchInputImageMeta(a) {
  if (!a || !a.path) return null
  return {
    file_path: a.path,
    original_path: a.original_path || null,
    name: a.name || path.basename(a.path),
    content_type: a.mime || fileMime(a.path),
    bytes: a.size ?? null,
    role: 'input',
  }
}

function researchResultForPersist(snap) {
  const r = snap?.result && typeof snap.result === 'object' ? snap.result : {}
  const inputImages = Array.isArray(snap?.attachments)
    ? snap.attachments.map(researchInputImageMeta).filter(Boolean)
    : []
  return inputImages.length ? { ...r, input_images: inputImages } : r
}

function appendResearchId(rawUrl, id) {
  const u = new URL(rawUrl)
  u.searchParams.set('sc-research', id)
  u.hash = 'sc-research=' + encodeURIComponent(id)
  return u.toString()
}

function normalizeChatgptConversationUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const u = new URL(s)
  if (u.origin !== 'https://chatgpt.com') throw new Error('conversationUrl must be on https://chatgpt.com')
  if (!/^\/c\/[\w-]+\/?$/.test(u.pathname)) throw new Error('conversationUrl must look like https://chatgpt.com/c/<conversation-id>')
  u.hash = ''
  u.searchParams.delete('sc-research')
  return u.toString()
}

function saveResearchArtifact({ libRoot, id, name, contentType, base64 }) {
  if (!id) throw new Error('missing artifact id')
  if (!base64 || typeof base64 !== 'string') throw new Error('missing artifact base64')
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length) throw new Error('empty artifact')
  if (bytes.length > BODY_LIMITS.researchArtifactFile) throw new Error(`artifact too large (${bytes.length} bytes)`)
  const safeId = safeFileName(id, 'research')
  const ext = IMAGE_MIME_EXT[String(contentType || '').toLowerCase()]
    || path.extname(name || '').toLowerCase()
    || '.bin'
  const stem = safeFileName(path.basename(String(name || 'image'), path.extname(String(name || 'image'))), 'image')
  const uniq = crypto.randomBytes(4).toString('hex')
  const dir = path.join(libRoot, 'research-artifacts', safeId)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${Date.now()}-${uniq}-${stem}${ext}`)
  fs.writeFileSync(filePath, bytes)
  return { file_path: filePath, bytes: bytes.length, name: path.basename(filePath), content_type: contentType || null }
}

function safeReadFile(fp, maxBytes = 4 * 1024 * 1024) {
  if (!fp) return null
  try {
    const st = fs.statSync(fp)
    if (st.size > maxBytes) return null   // не пытаемся отдать многомегабайтный blob через JSON
    return fs.readFileSync(fp, 'utf-8')
  } catch { return null }
}

function requiredNotificationString(value, field, maxLength) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} is required`)
  if (normalized.length > maxLength) throw new Error(`${field} is too long`)
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${field} contains control characters`)
  return normalized
}

function normalizeTerminalCompletionEvent(body = {}) {
  if (body.kind !== 'terminal-completion') throw new Error('kind must be terminal-completion')
  const firedAt = Number(body.firedAt)
  if (!Number.isSafeInteger(firedAt) || firedAt <= 0) throw new Error('firedAt must be a positive epoch-ms integer')
  const mode = body.mode === 'persistent' ? 'persistent' : body.mode === 'oneshot' ? 'oneshot' : null
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

function startServer({ jobRunner, notificationService, settingsAccess }) {
  let notificationAuthToken = null
  try {
    const auth = ensureNotificationToken()
    notificationAuthToken = auth.token
    console.log(`[BrowserBridge] terminal notification auth ready path=${auth.tokenPath}`)
  } catch (err) {
    console.warn(`[BrowserBridge] terminal notification auth unavailable: ${err?.message || err}`)
  }
  const notificationRequestTimes = []

  const server = http.createServer(async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    let url
    try { url = new URL(req.url, `http://127.0.0.1:${PORT}`) }
    catch { return sendJson(res, 400, { error: 'bad url' }) }

    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, version: 1 })
      }

      // Desktop Settings and the browser popup share one YouTube parsing
      // configuration. Only the installed extension may use this route;
      // ordinary allowed web pages must not be able to change preferences.
      if (url.pathname === '/extension-settings/youtube') {
        if (!isExtensionSettingsRequest(req)) {
          console.warn(
            `[BrowserBridge] youtube settings rejected origin=${req.headers.origin || 'none'} fetch_site=${req.headers['sec-fetch-site'] || 'none'} fetch_mode=${req.headers['sec-fetch-mode'] || 'none'}`,
          )
          return sendJson(res, 403, { ok: false, error: 'extension origin required' })
        }
        if (typeof settingsAccess?.readScSettings !== 'function' ||
            typeof settingsAccess?.writeScSettings !== 'function') {
          return sendJson(res, 503, { ok: false, error: 'settings service is unavailable' })
        }
        if (req.method === 'GET') {
          const rawSettings = settingsAccess.readScSettings()
          const schema = extensionYoutubeSchemaState(rawSettings)
          if (schema.incompatible) {
            return sendJson(res, 409, {
              ok: false,
              incompatible: true,
              error: 'extension settings were written by a newer version',
              schemaVersion: schema.version,
              supportedSchemaVersion: EXTENSION_YOUTUBE_SCHEMA_VERSION,
            })
          }
          const initialized = schema.initialized
          const settings = extensionYoutubeFromSettings(rawSettings)
          const dirtyKeys = initialized
            ? []
            : Object.keys(rawSettings?.browser_extension?.youtube_desktop_pending || {})
          console.log(
            `[BrowserBridge] youtube settings read initialized=${initialized} schema=${schema.version ?? 'none'} dirty=${dirtyKeys.length}`,
          )
          return sendJson(res, 200, {
            ok: true,
            initialized,
            schemaVersion: schema.version ?? EXTENSION_YOUTUBE_SCHEMA_VERSION,
            supportedSchemaVersion: EXTENSION_YOUTUBE_SCHEMA_VERSION,
            dirty_keys: dirtyKeys,
            settings,
          })
        }
        if (req.method === 'POST') {
          const schema = extensionYoutubeSchemaState(settingsAccess.readScSettings())
          if (schema.incompatible) {
            return sendJson(res, 409, {
              ok: false,
              incompatible: true,
              error: 'extension settings were written by a newer version',
              schemaVersion: schema.version,
              supportedSchemaVersion: EXTENSION_YOUTUBE_SCHEMA_VERSION,
            })
          }
          const body = await readBody(req)
          const patch = body?.patch && typeof body.patch === 'object' ? body.patch : body
          console.log(
            `[BrowserBridge] youtube settings write keys=${Object.keys(patch || {}).sort().join(',') || 'none'}`,
          )
          const settings = patchExtensionYoutubeSettings(
            settingsAccess.readScSettings,
            settingsAccess.writeScSettings,
            patch,
          )
          return sendJson(res, 200, {
            ok: true,
            schemaVersion: EXTENSION_YOUTUBE_SCHEMA_VERSION,
            supportedSchemaVersion: EXTENSION_YOUTUBE_SCHEMA_VERSION,
            settings,
          })
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      }

      if (req.method === 'POST' && url.pathname === '/notifications/terminal-completion') {
        if (req.headers.origin) {
          return sendJson(res, 403, { ok: false, error: 'browser origins are not allowed' })
        }
        if (!notificationAuthToken) {
          return sendJson(res, 503, { ok: false, error: 'notification bridge authentication is unavailable' })
        }
        if (!matchesBearerToken(req.headers.authorization, notificationAuthToken)) {
          return sendJson(res, 401, { ok: false, error: 'invalid notification bridge credentials' })
        }
        if (typeof notificationService?.notifyTerminalCompletion !== 'function') {
          return sendJson(res, 503, { ok: false, error: 'notification service is unavailable' })
        }

        const now = Date.now()
        while (notificationRequestTimes.length && notificationRequestTimes[0] <= now - 60_000) {
          notificationRequestTimes.shift()
        }
        if (notificationRequestTimes.length >= 30) {
          res.setHeader('Retry-After', '60')
          return sendJson(res, 429, { ok: false, error: 'terminal notification rate limit exceeded' })
        }
        notificationRequestTimes.push(now)

        let body
        try {
          body = await readBody(req, BODY_LIMITS.terminalNotification)
        } catch (err) {
          const status = err?.code === 'BODY_TOO_LARGE' ? 413 : 400
          return sendJson(res, status, { ok: false, error: err?.message || 'invalid JSON body' })
        }

        let event
        try {
          event = normalizeTerminalCompletionEvent(body)
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err?.message || 'invalid terminal completion event' })
        }

        try {
          const result = await notificationService.notifyTerminalCompletion(event)
          return sendJson(res, 200, {
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
          console.warn(`[BrowserBridge] terminal notification failed code=${err?.code || 'telegram_delivery_failed'} error=${err?.message || err}`)
          return sendJson(res, status, {
            ok: false,
            code: err?.code || 'telegram_delivery_failed',
            error: err?.message || 'Telegram delivery failed',
          })
        }
      }

      // Hot-reload endpoint для browser-extension'а: возвращает max mtime
      // исходников. Расширение полит каждые 2 сек, при изменении —
      // chrome.runtime.reload(). Зачем: в Manifest-V3 service worker
      // нельзя hmr-нуть, юзер не должен каждый раз идти в chrome://extensions
      // и жать ⟳. Endpoint работает только в dev (когда исходники доступны
      // по пути ниже); в prod build .app сборка — этих файлов нет на
      // ожидаемом пути, fs.statSync падает, мы отдаём 404 → расширение
      // тихо не перезагружается (то что и нужно в проде).
      if (req.method === 'GET' && url.pathname === '/__ext_version') {
        try {
          const extDir = path.join(__dirname, '..', 'browser-extension')
          // Проверяем mtime ТОЛЬКО ключевых файлов (manifest + content/bg/popup),
          // не всё подряд, чтобы не считать mtime логов и .git'а.
          const files = [
            'manifest.json', 'background.js', 'youtube-content.js',
            'aistudio-autoscrape.js', 'aistudio-core.js', 'aistudio-mcp.js',
            'claude-autoscrape.js',
            'claude-research.js', 'perplexity-research.js', 'chatgpt-research.js',
            'research-badge.js',
            'popup.html', 'popup.js', 'settings.js',
            'mcp-handlers.js', 'mcp-content.js',
          ]
          let maxMtime = 0
          for (const f of files) {
            try {
              const st = fs.statSync(path.join(extDir, f))
              if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs
            } catch {}
          }
          if (maxMtime === 0) return sendJson(res, 404, { error: 'no source files' })
          return sendJson(res, 200, { mtime: Math.round(maxMtime) })
        } catch (e) {
          return sendJson(res, 500, { error: String(e?.message || e) })
        }
      }

      if (req.method === 'POST' && url.pathname === '/yt-add') {
        const body = await readBody(req)
        const targetUrl = String(body.url || '').trim()
        if (!/^https?:\/\/(www\.|m\.)?youtube\.com\/watch\?v=/.test(targetUrl) &&
            !/^https?:\/\/youtu\.be\//.test(targetUrl)) {
          return sendJson(res, 400, { error: 'not a youtube watch url' })
        }
        const lang = (body.lang && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.lang)) ? body.lang : 'ru'

        // Cache-first: если транскрипт уже есть в Library (single-paste,
        // batch-transcribe, items.transcript_path) — не плодим повторный job.
        // Для autoscrape это критично: без этого расширение polls «running»
        // на новый job вместо того чтоб моментально получить готовый text.
        // videoId извлекаем из URL — формат проверен regex'ом выше.
        let videoId = null
        try {
          const u = new URL(targetUrl)
          videoId = u.searchParams.get('v')
        } catch {}

        if (videoId) {
          const cached = jobRunner.lookupYoutubeCache(videoId)
          // Cache HIT может быть двух родов:
          //   - origin='jobs'  → есть полноценный jobId (single-paste row)
          //   - origin='items' → файл есть в Library (записан batch'ем
          //                      или подгружен через канал), id нет
          // В обоих случаях транскрипт уже на диске и НИКАКОГО нового
          // job'а запускать не надо. Расширение получит fromCache:true и
          // полный текст готового файла прямо в этом ответе.
          if (cached && cached.file_path && fs.existsSync(cached.file_path)) {
            console.log(`[BrowserBridge] yt-add ${targetUrl} → cache HIT (origin=${cached.id != null ? 'jobs#' + cached.id : 'items'})`)
            // Комменты считаются отдельно — у них свой кэш-tuple.
            let commentsJobId = null
            let commentsFilePath = null
            if (body.withComments) {
              const commentsCache = jobRunner.lookupYoutubeCommentsCache?.({
                videoId, sort: 'new', limit: 500, includeReplies: false,
              })
              if (commentsCache && commentsCache.file_path && fs.existsSync(commentsCache.file_path)) {
                commentsFilePath = commentsCache.file_path
                if (commentsCache.id != null) commentsJobId = commentsCache.id
              } else {
                commentsJobId = jobRunner.startYoutubeComments({
                  url: targetUrl, sort: 'new', limit: 500, includeReplies: false,
                })
              }
            }
            // Cache-hit clipboard: job-runner.js пишет в clipboard только
            // при event 'saved', а здесь job не запускается → нужно
            // явно скопировать. Если коммент-cache тоже hit — clipboard
            // получает «<транскрипт>\n\n<коммент-блок>». Если коммент
            // ушёл в job (miss) — копируем только транскрипт сейчас,
            // итоговая склейка остаётся на стороне расширения (autoscrape
            // уже умеет concat, см. main() в aistudio-autoscrape.js). Юзер
            // ждал «нажал → в буфере появилось».
            try {
              const { clipboard } = require('electron')
              const transcriptText = fs.readFileSync(cached.file_path, 'utf-8')
              let txt = transcriptText
              if (commentsFilePath) {
                try { txt += '\n\n' + fs.readFileSync(commentsFilePath, 'utf-8') } catch {}
              }
              clipboard.writeText(txt)
              console.log(`[BrowserBridge] cache-hit copied to clipboard: ${txt.length} chars`)
              // Edge-case: транскрипт-cache HIT, но comments — MISS и
              // запущен свежий comments-job. Через минуту его 'saved' event
              // в job-runner.js перезапишет clipboard ОДНИМИ комментами,
              // затирая транскрипт. Подписываемся: ждём done → склеиваем
              // обратно. Без этого юзер через минуту получает в буфере
              // только комменты.
              if (commentsJobId && !commentsFilePath) {
                const off = jobRunner.subscribe(j => {
                  if (!j || j.id !== commentsJobId) return
                  if (j.status === 'error' || j.status === 'cancelled') {
                    try { off() } catch {}
                    return
                  }
                  if (j.status === 'done' && j.file_path) {
                    try {
                      let combined = transcriptText + '\n\n' + fs.readFileSync(j.file_path, 'utf-8')
                      clipboard.writeText(combined)
                      console.log(`[BrowserBridge] cache-hit + late-comments combined to clipboard: ${combined.length} chars`)
                    } catch (e2) {
                      console.log(`[BrowserBridge] late-comments clipboard write failed: ${e2?.message || e2}`)
                    }
                    try { off() } catch {}
                  }
                })
              }
            } catch (e) {
              console.log(`[BrowserBridge] cache-hit clipboard write failed: ${e?.message || e}`)
            }
            return sendJson(res, 200, {
              jobId: cached.id || null,
              commentsJobId,
              fromCache: true,
              cached_file_path: cached.file_path,
              cached_comments_file_path: commentsFilePath,
            })
          }
        }

        const jobId = jobRunner.startYoutubeSingle({ url: targetUrl, lang })

        let commentsJobId = null
        if (body.withComments) {
          // sort=new, limit=500, replies=false — те же дефолты что у YouTubeSingleForm
          // (paste-flow). Расширение пока тоже не различает.
          commentsJobId = jobRunner.startYoutubeComments({
            url: targetUrl,
            sort: 'new',
            limit: 500,
            includeReplies: false,
          })
        }
        // Live + withComments: оба job'а независимо пишут в clipboard на
        // 'saved'. Второй (comments) затирает первый — итог: в буфере
        // только комменты, без транскрипта. Подписываемся на оба и при
        // обоих done переписываем clipboard склейкой.
        if (commentsJobId) {
          ;(() => {
            let savedTranscript = null
            let savedComments = null
            const off = jobRunner.subscribe(j => {
              if (!j) return
              if (j.id === jobId && j.status === 'done' && j.file_path) {
                savedTranscript = j.file_path
              }
              if (j.id === commentsJobId && j.status === 'done' && j.file_path) {
                savedComments = j.file_path
              }
              if (j.status === 'error' || j.status === 'cancelled') {
                if (j.id === jobId || j.id === commentsJobId) { try { off() } catch {} }
                return
              }
              if (savedTranscript && savedComments) {
                try {
                  const { clipboard } = require('electron')
                  let txt = fs.readFileSync(savedTranscript, 'utf-8')
                  txt += '\n\n' + fs.readFileSync(savedComments, 'utf-8')
                  clipboard.writeText(txt)
                  console.log(`[BrowserBridge] live transcript+comments combined to clipboard: ${txt.length} chars`)
                } catch (e) {
                  console.log(`[BrowserBridge] combined clipboard write failed: ${e?.message || e}`)
                }
                try { off() } catch {}
              }
            })
          })()
        }
        console.log(`[BrowserBridge] yt-add ${targetUrl} → job=${jobId}${commentsJobId ? ' comments=' + commentsJobId : ''}`)
        return sendJson(res, 200, { jobId, commentsJobId })
      }

      // /yt-resume-ai — пользователь в /yt-add не имеет UI для нажатия
      // «продолжить через AI» когда субтитров не нашлось. Расширение в
      // background tracker'е видит status=awaiting_ai и автоматически
      // дёргает этот endpoint, чтобы job дошёл до transcribe-стадии.
      if (req.method === 'POST' && url.pathname === '/yt-resume-ai') {
        const body = await readBody(req)
        const id = Number(body.id)
        if (!Number.isFinite(id)) return sendJson(res, 400, { error: 'missing id' })
        const engine = (body.engine === 'assemblyai') ? 'assemblyai' : 'gemini'
        const r = jobRunner.resumeYoutubeAi(id, { engine })
        if (!r.ok) return sendJson(res, 409, r)
        console.log(`[BrowserBridge] yt-resume-ai #${id} engine=${engine}`)
        return sendJson(res, 200, { ok: true, engine })
      }

      // /yt-fetch — синхронный fetch произвольного готового файла из Library.
      // Используется autoscrape'ом / tracker'ом когда yt-add вернул
      // fromCache:true с готовым cached_file_path: транскрипт уже на диске,
      // создавать виртуальный job нет смысла. Контракт прост: путь должен
      // быть внутри LIB_ROOT (защита от path-traversal).
      if (req.method === 'GET' && url.pathname === '/yt-fetch') {
        const fp = url.searchParams.get('path')
        if (!fp) return sendJson(res, 400, { error: 'missing path' })
        const libRoot = jobRunner.LIB_ROOT
        const resolved = path.resolve(fp)
        if (!resolved.startsWith(libRoot)) {
          return sendJson(res, 403, { error: 'path outside LIB_ROOT' })
        }
        const text = safeReadFile(resolved)
        if (text == null) return sendJson(res, 404, { error: 'not readable' })
        return sendJson(res, 200, { text, file_path: resolved })
      }

      if (req.method === 'GET' && url.pathname === '/yt-status') {
        const idRaw = url.searchParams.get('id')
        const cidRaw = url.searchParams.get('comments_id')
        const id = idRaw && /^\d+$/.test(idRaw) ? Number(idRaw) : idRaw
        const cid = cidRaw && /^\d+$/.test(cidRaw) ? Number(cidRaw) : null

        const main = id ? jobRunner.getJobDetail(id) : null
        if (!main) return sendJson(res, 404, { error: 'job not found' })

        // Снимок «наблюдаемых» полей. Long-poll отвечает когда ЛЮБОЕ из них
        // изменится — а это покрывает все переходы которые видит расширение
        // (status running→done, yt_stage searching→transcribing→…, engine,
        // comments_status). Сравнение идёт по строке-кортежу (быстрее объекта).
        const buildStatus = () => {
          const m = jobRunner.getJobDetail(id)
          if (!m) return null
          const s = {
            status: m.status,
            file_path: m.file_path || null,
            yt_stage: m.yt?.stage || null,
            yt_engine: m.yt?.engine || null,
            error: m.error || null,
          }
          if (cid != null) {
            const c = jobRunner.getJobDetail(cid)
            s.comments_status    = c?.status || null
            s.comments_file_path = c?.file_path || null
            s.comments_error     = c?.error || null
          }
          return s
        }
        const tupleOf = (s) => s == null ? '' :
          [s.status, s.yt_stage, s.yt_engine, s.error,
           s.comments_status, s.comments_error, s.file_path, s.comments_file_path].join('|')

        const enrich = (s) => {
          if (s == null) return s
          const transcriptReady = s.status === 'done' && s.file_path && fs.existsSync(s.file_path)
          const commentsReady   = cid == null
            ? true
            : s.comments_status === 'done' && s.comments_file_path && fs.existsSync(s.comments_file_path)
          if (transcriptReady && commentsReady) {
            s.transcript_text = safeReadFile(s.file_path)
            if (cid != null) s.comments_text = safeReadFile(s.comments_file_path)
          }
          return s
        }

        const initial = buildStatus()
        const initialTuple = tupleOf(initial)

        const waitRaw = parseInt(url.searchParams.get('wait') || '0', 10)
        const wait = Number.isFinite(waitRaw) ? Math.max(0, Math.min(25000, waitRaw)) : 0

        // Терминальные состояния — отдаём сразу. transcribed-without-comments
        // тоже терминал если cid не передан.
        const transcriptReadyNow = initial.status === 'done' && initial.file_path && fs.existsSync(initial.file_path)
        const commentsReadyNow   = cid == null
          ? true
          : initial.comments_status === 'done' && initial.comments_file_path && fs.existsSync(initial.comments_file_path)
        const errored = initial.status === 'error' || initial.comments_status === 'error'
        if (wait === 0 || errored || (transcriptReadyNow && commentsReadyNow)) {
          return sendJson(res, 200, enrich(initial))
        }

        // Long-poll: подписываемся на job-events, на любое emit'ивание
        // job'а — пересобираем снимок и сравниваем. Различие → ответ.
        let resolved = false
        const finish = (snapshot) => {
          if (resolved) return
          resolved = true
          try { off() } catch {}
          clearTimeout(timer)
          req.off('close', onClose)
          if (!res.writableEnded) sendJson(res, 200, enrich(snapshot))
        }
        const off = jobRunner.subscribe(j => {
          if (j && j.id !== id && j.id !== cid) return
          const snap = buildStatus()
          if (tupleOf(snap) !== initialTuple) finish(snap)
        })
        const onClose = () => {
          if (resolved) return
          resolved = true
          try { off() } catch {}
          clearTimeout(timer)
        }
        req.on('close', onClose)
        const timer = setTimeout(() => finish(buildStatus()), wait)
        return
      }

      // ─── Deep Research API (claude.ai / perplexity.ai) ────────────
      //
      // MCP-tool deep_research_start → POST /research-create. Bridge
      // создаёт in-memory job (RAM-only, см. research-state.js), отдаёт
      // requestId. MCP затем открывает вкладку через WS mcp_new_tab с
      // URL '<provider>#sc-research=<requestId>'.
      //
      // Content-script (claude-research.js / perplexity-research.js)
      // на старте читает hash, GET /research-job?id=… за payload'ом,
      // делает работу, шлёт POST /research-state с обновлениями.
      // MCP-tool deep_research_wait → GET /research-status?id&wait=N
      // (long-poll по той же схеме что /yt-status).
      //
      // RAM-only: рестарт sc-desktop теряет job. Это допустимо для
      // MCP-сессии (юзер всё равно перезапустит deep_research_start).

      if (req.method === 'POST' && url.pathname === '/research-create') {
        const body = await readBody(req, BODY_LIMITS.researchStart)
        const provider = body.provider === 'perplexity' ? 'perplexity' : 'claude'
        const prompt = typeof body.prompt === 'string' ? body.prompt : ''
        if (!prompt.trim()) return sendJson(res, 400, { error: 'empty prompt' })
        const job = researchState.create({ provider, prompt, options: body.options || {} })
        console.log(`[BrowserBridge] research-create id=${job.id} provider=${provider} prompt-len=${prompt.length}`)
        return sendJson(res, 200, { id: job.id, provider, hash: 'sc-research=' + job.id })
      }

      // Один-вызов flow: create job + попросить extension открыть вкладку.
      // Возвращает {id, provider, tabId, url}. Это объединяет /research-create
      // + ранее-MCP-only mcp_open_research_tab в один HTTP вызов так чтобы
      // юзер мог дёргать всё curl'ом без MCP-tools.
      if (req.method === 'POST' && url.pathname === '/research-start') {
        const body = await readBody(req, BODY_LIMITS.researchStart)
        const prompt = typeof body.prompt === 'string' ? body.prompt : ''
        if (!prompt.trim()) return sendJson(res, 400, { error: 'empty prompt' })

        // ── AI Studio (Gemini) provider ──────────────────────────────
        // Раньше запускался через MCP-tool aistudio_run (browser-MCP). Теперь
        // — тот же HTTP-канал что claude/perplexity. SW-логика (резолв модели,
        // открытие вкладки ?sc-mcp-job=, debugger-attach) переиспользуется как
        // была — мы лишь дёргаем mcp_aistudio_start через sendToExtension.
        // Состояние живёт в AISTUDIO_JOBS (CS PATCH'ит через /aistudio-state),
        // jobId имеет префикс aim_ — по нему /research-status роутит в нужный store.
        if (body.provider === 'aistudio' || body.provider === 'gemini') {
          const opts = body.options || {}
          try {
            const extResp = await sendToExtension('mcp_aistudio_start', {
              prompt,
              model: opts.model || body.model,
              systemInstruction: opts.systemInstruction || body.systemInstruction,
              reuse_tab: opts.reuse_tab,
              focus: opts.focus,
            }, 20000)
            if (!extResp || extResp.success === false) {
              return sendJson(res, 200, { error: extResp?.error || 'aistudio start failed', provider: 'aistudio' })
            }
            console.log(`[BrowserBridge] research-start(aistudio) id=${extResp.jobId} model=${extResp.modelId} tab=${extResp.tabId}`)
            return sendJson(res, 200, {
              id: extResp.jobId, provider: 'aistudio', tabId: extResp.tabId,
              modelId: extResp.modelId, modelTitle: extResp.modelTitle,
              isDeepResearch: extResp.isDeepResearch,
              url: `https://aistudio.google.com/prompts/new_chat?model=${extResp.modelId}`,
              status: 'pending',
            })
          } catch (e) {
            console.log(`[BrowserBridge] research-start(aistudio) FAILED ${e.message}`)
            return sendJson(res, 200, { error: String(e?.message || e), provider: 'aistudio' })
          }
        }

        const provider = body.provider === 'perplexity' ? 'perplexity'
          : body.provider === 'chatgpt' ? 'chatgpt'
          : 'claude'
        const attachments = normalizeResearchAttachments(body.attachments || body.files || [])
        if (attachments.length && provider !== 'chatgpt') {
          return sendJson(res, 400, { error: 'attachments are currently supported only for provider=chatgpt' })
        }
        const conversationUrl = body.conversationUrl || body.continueUrl || body.url || body.options?.conversationUrl || ''
        const chatgptConversationUrl = provider === 'chatgpt' && conversationUrl
          ? normalizeChatgptConversationUrl(conversationUrl)
          : ''
        const job = researchState.create({ provider, prompt, options: body.options || {}, attachments })
        if (attachments.length) {
          const materialized = materializeResearchAttachments({
            libRoot: jobRunner.LIB_ROOT || path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop'),
            id: job.id,
            attachments,
          })
          researchState.update(job.id, { attachments: materialized })
        }
        // chatgpt: query + дубль в hash — SPA срезает query на pushState,
        // hash страхует ре-инжект CS до того как window.name установлен.
        const targetUrl = provider === 'perplexity'
          ? `https://www.perplexity.ai/?sc-research=${encodeURIComponent(job.id)}`
          : provider === 'chatgpt'
            ? (chatgptConversationUrl
              ? appendResearchId(chatgptConversationUrl, job.id)
              : `https://chatgpt.com/?sc-research=${encodeURIComponent(job.id)}#sc-research=${encodeURIComponent(job.id)}`)
            : `https://claude.ai/new#sc-research=${encodeURIComponent(job.id)}`
        if (chatgptConversationUrl) researchState.update(job.id, { url: chatgptConversationUrl, title: null })
        console.log(`[BrowserBridge] research-start id=${job.id} provider=${provider} prompt-len=${prompt.length} attachments=${attachments.length} continue=${chatgptConversationUrl ? 1 : 0}`)
        try {
          const extResp = await sendToExtension('mcp_open_research_tab', { url: targetUrl }, 15000)
          const tabId = extResp?.tabId ?? extResp?.result?.tabId ?? null
          // tabId в job СРАЗУ, не дожидаясь CS stage=configuring. Если CS не
          // стартует вовсе (LNA, расширение умерло) — job остаётся queued, и
          // только эта привязка позволяет tab-closed fallback'у его прибить.
          if (tabId != null) researchState.update(job.id, { tabId })
          console.log(`[BrowserBridge] research-start id=${job.id} tab opened tabId=${tabId}`)
          return sendJson(res, 200, { id: job.id, provider, tabId, url: targetUrl, status: job.status })
        } catch (e) {
          console.log(`[BrowserBridge] research-start id=${job.id} OPEN_TAB_FAILED ${e.message} — job создан но вкладку придётся открыть вручную`)
          // Job создан, но не открыли. Возвращаем 200 с meta — юзер может
          // сам открыть в браузере URL и CS заработает.
          return sendJson(res, 200, { id: job.id, provider, tabId: null, url: targetUrl, status: job.status, openError: e.message })
        }
      }

      // Content-script читает свой job-payload. Включает prompt — без
      // этого нечего ставить в composer. Origin'ы — только наши allow-list'ы.
      //
      // На GET /research-job отдаём 404 если job-а нет: первый-инжект CS
      // не имеет другой стороны кроме как сабмитнуть с нуля, а без prompt'а
      // это невозможно. Re-create через POST /research-state — отдельный
      // путь для CS которые уже отработали submit и пишут стейт.
      if (req.method === 'GET' && url.pathname === '/research-job') {
        const id = url.searchParams.get('id')
        if (!id) return sendJson(res, 400, { error: 'missing id' })
        const job = researchState.get(id)
        if (!job) return sendJson(res, 404, { error: 'job not found' })
        // Snapshot + prompt + options. После выдачи могли бы удалять prompt
        // чтобы не светить повторно — но CS может попросить ещё раз после
        // SW respin'а, оставляем.
        return sendJson(res, 200, {
          id: job.id,
          provider: job.provider,
          prompt: job.prompt,
          options: job.options,
          attachments: (job.attachments || []).map(publicAttachmentMeta),
          status: job.status,
        })
      }

      // Content-script не имеет доступа к локальному FS. Для attachments
      // отдаём bytes только по уже созданному job.id и только из списка,
      // провалидированного на /research-start.
      if (req.method === 'GET' && url.pathname === '/research-attachment') {
        const id = url.searchParams.get('id')
        const index = parseInt(url.searchParams.get('index') || '0', 10)
        if (!id) return sendJson(res, 400, { error: 'missing id' })
        const job = researchState.get(id)
        if (!job) return sendJson(res, 404, { error: 'job not found' })
        const att = (job.attachments || []).find(a => a.index === index)
        if (!att) return sendJson(res, 404, { error: 'attachment not found' })
        try {
          const st = fs.statSync(att.path)
          if (!st.isFile() || st.size !== att.size || st.size > 20 * 1024 * 1024) {
            return sendJson(res, 410, { error: 'attachment changed or too large' })
          }
          return sendJson(res, 200, {
            ...publicAttachmentMeta(att),
            base64: fs.readFileSync(att.path).toString('base64'),
          })
        } catch (e) {
          return sendJson(res, 500, { error: String(e?.message || e) })
        }
      }

      // Content-script сохраняет сгенерированные ChatGPT изображения сюда.
      // В result потом кладётся только file_path + metadata; сам base64 в
      // research-state/БД не попадает.
      if (req.method === 'POST' && url.pathname === '/research-artifact') {
        const body = await readBody(req, BODY_LIMITS.researchArtifactJson)
        const id = body.id
        if (!id) return sendJson(res, 400, { error: 'missing id' })
        const job = researchState.get(id)
        if (!job) return sendJson(res, 404, { error: 'job not found' })
        const saved = saveResearchArtifact({
          libRoot: jobRunner.LIB_ROOT || path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop'),
          id,
          name: body.name || 'image.png',
          contentType: body.contentType || body.content_type || 'image/png',
          base64: body.base64,
        })
        console.log(`[BrowserBridge] research-artifact id=${id} saved ${saved.bytes} bytes → ${saved.file_path}`)
        return sendJson(res, 200, { ok: true, ...saved })
      }

      // Recovery endpoint для CS: найти active research по tabId.
      // CS вызывает это когда страница перезагрузилась без hash и window.name
      // (crash-restore / discard / переход через history.pushState на /chat/<uuid>
      // после которого Chrome перезагрузил вкладку без preservation window.name).
      // Без этого endpoint CS делает молчаливый `if(!id) return` и research
      // зависает в zombie-state на bridge'е (status=running, но никто не
      // тикает). На каждый запрос логируем что нашли — это даст нам
      // детерминированный signal "CS попал в recovery-flow" в production-логе.
      if (req.method === 'GET' && url.pathname === '/research-by-tab') {
        const tabIdStr = url.searchParams.get('tabId')
        const tabId = tabIdStr ? Number(tabIdStr) : NaN
        if (!Number.isFinite(tabId)) return sendJson(res, 400, { error: 'missing or invalid tabId' })
        const job = researchState.findByTabId(tabId)
        if (!job) {
          console.log(`[BrowserBridge] research-by-tab tabId=${tabId} → no active research`)
          return sendJson(res, 404, { error: 'no active research for tabId' })
        }
        console.log(`[BrowserBridge] research-by-tab tabId=${tabId} → id=${job.id} status=${job.status} stage=${job.stage || '-'} (recovery hit)`)
        return sendJson(res, 200, {
          id: job.id,
          provider: job.provider,
          status: job.status,
          stage: job.stage,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        })
      }

      // Persistent log endpoint для CS: dbg-sink #sc-research-dbg-log
      // живёт в DOM и умирает при reload'е / закрытии tab. Для post-mortem
      // anomaly типа "CS не запустился после reload" нужны логи, переживающие
      // tab. CS отправляет важные boot/recover/error события сюда — они летят
      // в bridge console log (persistent в production.log).
      if (req.method === 'POST' && url.pathname === '/research-log') {
        const body = await readBody(req)
        const logId = body.id || '-'
        const tag = String(body.tag || 'unknown').slice(0, 80)
        const tabId = body.tabId != null ? body.tabId : '-'
        const pageUrl = String(body.url || '').slice(0, 160)
        const payload = body.data ? JSON.stringify(body.data).slice(0, 400) : ''
        console.log(`[BrowserBridge] research-log id=${String(logId).slice(0,12)} tabId=${tabId} tag=${tag} url=${pageUrl} ${payload}`)
        // Tab-closed fallback: SW шлёт sw.tab.onRemoved для research-вкладок.
        // Закрыл вкладку руками → job не должен висеть «running 30 минут»
        // (реальный кейс — зомби-queued при не стартовавшем CS). Auto-close
        // после done сюда тоже прилетает, но terminal jobs failAllByTabId
        // не трогает. Persist — чтобы ошибка попала в Историю.
        if (tag === 'sw.tab.onRemoved' && typeof body.tabId === 'number') {
          const failedIds = researchState.failAllByTabId(body.tabId, 'Вкладка браузера закрыта — research остановлен')
          for (const fid of failedIds) {
            console.log(`[BrowserBridge] research id=${fid} → error (tab ${body.tabId} closed by user)`)
            persistResearchJob(researchState.get(fid))
          }
        }
        return sendJson(res, 200, { ok: true })
      }

      // CS шлёт сюда обновления. Партиальный merge — посылаем только
      // изменённые поля. На terminal-state (done/error) bridge больше
      // ничего не ждёт; повторные POST'ы становятся no-op'ами.
      //
      // Re-create на 404: если bridge рестартовал посреди research'а
      // (RAM-only state потерян), но CS продолжает слать обновления —
      // воссоздаём stub job чтобы дать CS возможность дотащить research
      // до финала. Требуется body.provider — без него job не восстановить.
      if (req.method === 'POST' && url.pathname === '/research-state') {
        const body = await readBody(req, BODY_LIMITS.researchState)
        const id = body.id
        if (!id) return sendJson(res, 400, { error: 'missing id' })
        let cur = researchState.get(id)
        if (!cur) {
          if (body.provider) {
            cur = researchState.recreate({ id, provider: body.provider })
            console.log(`[BrowserBridge] research-state RECOVERED id=${id} provider=${body.provider} (bridge respin survival)`)
          } else {
            return sendJson(res, 404, { error: 'job not found (no provider in body to recover)' })
          }
        }
        const patch = {}
        if (typeof body.status === 'string') patch.status = body.status
        if (typeof body.stage === 'string')  patch.stage = body.stage
        if (typeof body.url === 'string')    patch.url = body.url
        if (typeof body.title === 'string')  patch.title = body.title
        if (typeof body.tabId === 'number')  patch.tabId = body.tabId
        if (typeof body.error === 'string')  patch.error = body.error
        if (body.result && typeof body.result === 'object') patch.result = body.result
        const merged = researchState.update(id, patch)
        console.log(`[BrowserBridge] research-state id=${id} status=${merged.status} stage=${merged.stage || '-'}`)
        // Persist в БД на терминальном статусе — merged содержит prompt/options
        // (полный job, не publicSnapshot).
        persistResearchJob(merged)
        return sendJson(res, 200, researchState.publicSnapshot(merged))
      }

      // Long-poll. Та же схема что /yt-status: ждём изменения tuple'а
      // (status, stage, error, result.id?, url). На timeout — текущий snapshot.
      if (req.method === 'GET' && url.pathname === '/research-status') {
        const id = url.searchParams.get('id')
        const reqT0 = Date.now()
        const reqShortId = id ? id.slice(0, 8) : '?'
        if (!id) {
          console.log(`[BrowserBridge] research-status MISSING_ID — 400`)
          return sendJson(res, 400, { error: 'missing id' })
        }
        // AI Studio jobId (aim_…) живёт в AISTUDIO_JOBS, не в researchState.
        // Long-poll по нему: ждём изменения status/stage, иначе snapshot. Форму
        // приводим к research-подобной (result.text), чтобы caller'у было единообразно.
        if (id.startsWith('aim_')) {
          const waitRaw = parseInt(url.searchParams.get('wait') || '0', 10)
          const wait = Number.isFinite(waitRaw) ? Math.max(0, Math.min(60000, waitRaw)) : 0
          const snap = () => {
            const j = AISTUDIO_JOBS.get(id)
            if (!j) return null
            return {
              id, provider: 'aistudio', status: j.status, stage: j.stage,
              modelId: j.modelId, modelTitle: j.modelTitle, isDeepResearch: j.isDeepResearch,
              tabId: j.tabId, elapsedSec: j.elapsedSec, error: j.error || null,
              url: j.url || null, updatedAt: j.updatedAt,
              result: (j.status === 'done')
                ? { text: j.responseText || j.responseHead || '', links: j.links || [], text_kind: 'answer', is_research: !!j.isDeepResearch }
                : null,
            }
          }
          const cur = snap()
          if (!cur) return sendJson(res, 404, { error: 'job not found' })
          const aiTuple = j => j ? [j.status, j.stage, j.error].join('|') : ''
          const t0tuple = aiTuple(cur)
          const aiTerminal = cur.status === 'done' || cur.status === 'error'
          if (wait === 0 || aiTerminal) return sendJson(res, 200, cur)
          // poll AISTUDIO_JOBS каждые 1с до изменения tuple или timeout
          let aiResolved = false
          const aiTimer = setInterval(() => {
            const s = snap()
            if (aiResolved) return
            if (!s || aiTuple(s) !== t0tuple) {
              aiResolved = true; clearInterval(aiTimer); clearTimeout(aiHard)
              if (!res.writableEnded) sendJson(res, 200, s || { id, status: 'error', error: 'job vanished' })
            }
          }, 1000)
          const aiHard = setTimeout(() => {
            if (aiResolved) return
            aiResolved = true; clearInterval(aiTimer)
            if (!res.writableEnded) sendJson(res, 200, snap())
          }, wait)
          req.on('close', () => { aiResolved = true; clearInterval(aiTimer); clearTimeout(aiHard) })
          return
        }
        const initial = researchState.get(id)
        const waitRaw = parseInt(url.searchParams.get('wait') || '0', 10)
        const wait = Number.isFinite(waitRaw) ? Math.max(0, Math.min(60000, waitRaw)) : 0

        if (!initial) {
          console.log(`[BrowserBridge] research-status id=${reqShortId} → 404 (job not found in RAM map; wait=${wait}ms requested but bailed immediately)`)
          return sendJson(res, 404, { error: 'job not found' })
        }

        const tupleOf = (j) => j == null ? '' :
          [j.status, j.stage, j.error, j.url, j.result?.url || ''].join('|')
        const initialTuple = tupleOf(initial)

        const terminal = initial.status === 'done' || initial.status === 'error'
        if (wait === 0 || terminal) {
          console.log(`[BrowserBridge] research-status id=${reqShortId} → 200 immediate (status=${initial.status} stage=${initial.stage || '-'} terminal=${terminal})`)
          return sendJson(res, 200, researchState.publicSnapshot(initial))
        }

        console.log(`[BrowserBridge] research-status id=${reqShortId} long-poll START status=${initial.status} stage=${initial.stage || '-'} wait=${wait}ms tuple=${initialTuple}`)

        let resolved = false
        const finish = (snapshot, reason) => {
          if (resolved) return
          resolved = true
          try { off() } catch {}
          clearTimeout(timer)
          req.off('close', onClose)
          const dt = Date.now() - reqT0
          const finalTuple = tupleOf(snapshot)
          const tupleChanged = finalTuple !== initialTuple
          console.log(`[BrowserBridge] research-status id=${reqShortId} long-poll END reason=${reason} dt=${dt}ms status=${snapshot?.status || 'NULL'} stage=${snapshot?.stage || '-'} tupleChanged=${tupleChanged}`)
          if (!res.writableEnded) sendJson(res, 200, researchState.publicSnapshot(snapshot))
        }
        const off = researchState.subscribe(j => {
          if (j.id !== id) return
          if (tupleOf(j) !== initialTuple) finish(j, 'event')
        })
        const onClose = () => {
          if (resolved) return
          resolved = true
          try { off() } catch {}
          clearTimeout(timer)
          const dt = Date.now() - reqT0
          console.log(`[BrowserBridge] research-status id=${reqShortId} long-poll CLIENT_DISCONNECT dt=${dt}ms`)
        }
        req.on('close', onClose)
        const timer = setTimeout(() => finish(researchState.get(id), 'timeout'), wait)
        return
      }

      // ─── AI Studio MCP jobs state mirror ───────────────────────────
      //
      // Расширение (browser-extension/background.js + aistudio-mcp.js) при
      // каждом __sc_log с тегом aistudio.* шлёт PATCH сюда. Bridge хранит
      // in-memory Map<jobId, state>, рендерер sc-desktop читает через
      // GET /aistudio-jobs.
      //
      // Это РАЗДЕЛЁННОЕ зеркало с тем что лежит в chrome.storage.local:
      // - storage — источник истины для самого CS (read/write одного job'а)
      // - bridge — источник истины для renderer'а sc-desktop (никогда не
      //   видит storage напрямую)
      //
      // RAM-only, GC через час. Перезапуск sc-desktop сбрасывает
      // зеркало; CS на следующем log-event снова PATCH'ит и зеркало
      // восстанавливается.
      //
      // Контракт state:
      //   { jobId, tabId, modelId, status:'pending'|'running'|'done'|'error'|'tab_closed',
      //     stage, elapsedSec, promptHead, responseTextLen?, linkCount?,
      //     createdAt, updatedAt, error?, lastTag }
      if (req.method === 'POST' && url.pathname === '/aistudio-state') {
        const body = await readBody(req, BODY_LIMITS.researchState)
        const id = body.id
        if (!id || id === '-') return sendJson(res, 400, { error: 'missing id' })
        const now = Date.now()
        const prev = AISTUDIO_JOBS.get(id) || { jobId: id, createdAt: now }
        const next = { ...prev, ...body, jobId: id, updatedAt: now }
        AISTUDIO_JOBS.set(id, next)
        persistAistudioJob(next)   // persist в БД на done/error
        return sendJson(res, 200, { ok: true, job: next })
      }
      if (req.method === 'GET' && url.pathname === '/aistudio-jobs') {
        const out = []
        const cutoff = Date.now() - AISTUDIO_TTL_MS
        for (const [id, j] of AISTUDIO_JOBS) {
          if ((j.updatedAt || 0) < cutoff && j.status !== 'running' && j.status !== 'pending') {
            AISTUDIO_JOBS.delete(id)
            continue
          }
          out.push(j)
        }
        // Сортировка: running/pending первые, потом по updatedAt desc.
        out.sort((a, b) => {
          const aActive = (a.status === 'running' || a.status === 'pending') ? 1 : 0
          const bActive = (b.status === 'running' || b.status === 'pending') ? 1 : 0
          if (aActive !== bActive) return bActive - aActive
          return (b.updatedAt || 0) - (a.updatedAt || 0)
        })
        return sendJson(res, 200, { jobs: out })
      }
      // Реестр Perplexity-моделей. Источник правды — PPLX_MODELS в
      // perplexity-research.js (там же, где логика выбора, поэтому не дрейфует
      // от того что реально работает). CS на каждой загрузке Perplexity-страницы
      // POST'ит сюда свой реестр (self-register), а GET отдаёт его. Нейронка
      // может дёрнуть GET /pplx-models чтобы узнать актуальные модели/ярлыки.
      if (req.method === 'POST' && url.pathname === '/pplx-models-register') {
        const body = await readBody(req)
        if (Array.isArray(body.models)) {
          PPLX_MODELS_CACHE = { models: body.models, default: body.default || null, registeredAt: Date.now() }
        }
        return sendJson(res, 200, { ok: true })
      }
      if (req.method === 'GET' && url.pathname === '/pplx-models') {
        if (!PPLX_MODELS_CACHE) {
          return sendJson(res, 200, {
            models: [], default: null, registeredAt: null,
            note: 'Реестр ещё не зарегистрирован. Открой любую страницу perplexity.ai (CS запостит модели), либо запусти research — после этого список появится.',
          })
        }
        return sendJson(res, 200, PPLX_MODELS_CACHE)
      }
      // Unified-список ВСЕХ внешних research-активаций браузера: AI Studio
      // (aim_…) + Claude/Perplexity Deep Research (r…). Попап «Запущенные MCP»
      // читает отсюда, чтобы показывать всё, что реально крутится в браузере
      // по внешним каналам. Базовый browser-MCP (list_tabs/click/…) сюда НЕ
      // входит — он не «job», а разовая команда.
      if (req.method === 'GET' && url.pathname === '/external-jobs') {
        const out = []
        // 1) AI Studio jobs (тот же TTL-prune что и /aistudio-jobs).
        const cutoff = Date.now() - AISTUDIO_TTL_MS
        for (const [id, j] of AISTUDIO_JOBS) {
          if ((j.updatedAt || 0) < cutoff && j.status !== 'running' && j.status !== 'pending') {
            AISTUDIO_JOBS.delete(id)
            continue
          }
          out.push({ kind: 'aistudio', ...j })
        }
        // 2) Claude/Perplexity research jobs (live, RAM).
        try {
          for (const rj of researchState.listAllForUi()) out.push(rj)
        } catch (e) {
          console.log('[BrowserBridge] external-jobs research list failed:', e?.message)
        }
        // 3) История из БД (переживает рестарт). Дедуп: RAM-джоб (live, свежее)
        //    приоритетнее БД-записи с тем же jobId.
        try {
          const seen = new Set(out.map(j => j.jobId))
          for (const hj of (db()?.listResearchJobs(100) || [])) {
            if (seen.has(hj.jobId)) continue
            out.push(hj)
          }
        } catch (e) {
          console.log('[BrowserBridge] external-jobs db history failed:', e?.message)
        }
        // Сортировка: активные (running/pending/queued) первыми, потом updatedAt desc.
        const isActive = s => s === 'running' || s === 'pending' || s === 'queued'
        out.sort((a, b) => {
          const aa = isActive(a.status) ? 1 : 0
          const bb = isActive(b.status) ? 1 : 0
          if (aa !== bb) return bb - aa
          return (b.updatedAt || 0) - (a.updatedAt || 0)
        })
        return sendJson(res, 200, { jobs: out })
      }
      // Детерминированный стоп research-джобы: job → error СРАЗУ (не ждём
      // tab-closed fallback — у зомби-джоб tabId может быть null), потом
      // закрываем вкладку если она есть. Вызывается из попапа «Запущенные MCP»
      // через IPC research:stop. aistudio (aim_…) сюда не ходит — у него свой
      // clear-канал.
      if (req.method === 'POST' && url.pathname === '/research-stop') {
        const body = await readBody(req)
        const id = body.id
        if (!id) return sendJson(res, 400, { error: 'missing id' })
        const job = researchState.get(id)
        if (!job) return sendJson(res, 404, { error: 'job not found' })
        if (job.status !== 'done' && job.status !== 'error') {
          researchState.update(id, { status: 'error', stage: 'stopped', error: 'Остановлено пользователем' })
          persistResearchJob(researchState.get(id))
          console.log(`[BrowserBridge] research-stop id=${id} → error (user stop), tabId=${job.tabId ?? '-'}`)
        }
        if (job.tabId != null) {
          try { await sendToExtension('mcp_close_tab', { tabId: job.tabId }, 8000) } catch (_) {
            BRIDGE_COMMAND_QUEUE.push({ cmd: 'close_tab', tabId: job.tabId, ts: Date.now() })
          }
        }
        return sendJson(res, 200, { ok: true, tabId: job.tabId ?? null })
      }
      // Кладём команду в queue для расширения. Body: {cmd, tabId}.
      if (req.method === 'POST' && (url.pathname === '/focus-tab' || url.pathname === '/close-tab')) {
        const body = await readBody(req)
        if (body.tabId == null) return sendJson(res, 400, { error: 'missing tabId' })
        const cmd = url.pathname === '/focus-tab' ? 'focus_tab' : 'close_tab'
        BRIDGE_COMMAND_QUEUE.push({ cmd, tabId: body.tabId, ts: Date.now() })
        // Cap queue at 50 чтобы не накопилось мусора если расширение не polls.
        if (BRIDGE_COMMAND_QUEUE.length > 50) BRIDGE_COMMAND_QUEUE.splice(0, BRIDGE_COMMAND_QUEUE.length - 50)
        return sendJson(res, 200, { ok: true })
      }
      // Открыть/сфокусировать вкладку по URL. Используется из History-MCP UI
      // («↗ В браузере») — у research-джоба tabId меняется после reload'ов,
      // поэтому надёжнее открыть по url (SW найдёт существующую вкладку с этим
      // url или откроет новую).
      if (req.method === 'POST' && url.pathname === '/open-url') {
        const body = await readBody(req)
        if (!body.url) return sendJson(res, 400, { error: 'missing url' })
        // WS-путь (мгновенно) вместо queue+alarm-poll (лаг до 3-6с — отсюда
        // была «задержка» при клике «В браузере»). Fallback в queue если WS лёг.
        try {
          const r = await sendToExtension('mcp_open_url', { url: body.url }, 8000)
          return sendJson(res, 200, { ok: true, tabId: r?.tabId ?? null })
        } catch (e) {
          BRIDGE_COMMAND_QUEUE.push({ cmd: 'open_url', url: body.url, ts: Date.now() })
          if (BRIDGE_COMMAND_QUEUE.length > 50) BRIDGE_COMMAND_QUEUE.splice(0, BRIDGE_COMMAND_QUEUE.length - 50)
          return sendJson(res, 200, { ok: true, queued: true })
        }
      }
      // Force-reload расширения по запросу (когда hot-reload poll ещё не
      // увидел свежий mtime и нужно применить код прямо сейчас, без manual ⟳
      // в chrome://extensions/). Команда `reload_extension` обрабатывается
      // расширением через тот же bridge-commands poll.
      if (req.method === 'POST' && url.pathname === '/reload-extension') {
        BRIDGE_COMMAND_QUEUE.push({ cmd: 'reload_extension', ts: Date.now() })
        if (BRIDGE_COMMAND_QUEUE.length > 50) BRIDGE_COMMAND_QUEUE.splice(0, BRIDGE_COMMAND_QUEUE.length - 50)
        return sendJson(res, 200, { ok: true })
      }
      // Расширение polls этот endpoint через chrome.alarms watchdog (или
      // через свой 5с-таймер). Возвращает все накопленные команды и
      // очищает queue.
      if (req.method === 'GET' && url.pathname === '/bridge-commands') {
        const items = BRIDGE_COMMAND_QUEUE.splice(0, BRIDGE_COMMAND_QUEUE.length)
        return sendJson(res, 200, { items })
      }
      if (req.method === 'POST' && url.pathname === '/aistudio-clear') {
        const body = await readBody(req)
        if (body.id) {
          AISTUDIO_JOBS.delete(body.id)
        } else if (body.terminal) {
          // Очистить только завершённые
          for (const [id, j] of AISTUDIO_JOBS) {
            if (j.status === 'done' || j.status === 'error' || j.status === 'tab_closed') {
              AISTUDIO_JOBS.delete(id)
            }
          }
        }
        return sendJson(res, 200, { ok: true })
      }

      return sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      console.log(`[BrowserBridge] error ${err?.message || err}`)
      return sendJson(res, 500, { error: String(err?.message || err) })
    }
  })

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[BrowserBridge] port ${PORT} занят — другой инстанс sc-desktop уже слушает, расширение работать не будет`)
    } else {
      console.log(`[BrowserBridge] server error: ${err.message}`)
    }
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[BrowserBridge] listening on 127.0.0.1:${PORT}`)
  })

  // ── Hot-reload WebSocket (dev only) ─────────────────────────────────
  // SW расширения подключается сюда, шлёт ping каждые 20 сек, держит SW живым
  // (Chrome 116+ rule: WS-сообщение сбрасывает 30-сек idle-таймер). Когда мы
  // видим изменение mtime в browser-extension/ → шлём 'reload' → SW делает
  // chrome.runtime.reload(). Hot-reload < 1 секунды без зависимости от
  // chrome.alarms (которые в Yandex.Browser спят 5+ минут).
  if (WS) {
    try {
      // В dev `__dirname` = `<repo>/electron/`, browser-extension/ рядом.
      // В production .app `__dirname` = внутри asar — там browser-extension
      // НЕ запакован (он не нужен Electron'у, юзер ставит его в браузер из
      // src-папки). Но физически browser-extension всё ещё лежит у юзера
      // на диске — мы можем найти его через known-path. Это полезно даже
      // в production, чтобы hot-reload работал когда юзер правит файлы
      // расширения live.
      const repoExtDir = path.join(__dirname, '..', 'browser-extension')
      const homeExtDir = path.join(os.homedir(), 'Desktop', 'sc-desktop', 'browser-extension')
      const extDir = fs.existsSync(repoExtDir)
        ? repoExtDir
        : (fs.existsSync(homeExtDir) ? homeExtDir : null)
      if (extDir) {
        const wsServer = new WS.WebSocketServer({ port: RELOAD_WS_PORT, host: '127.0.0.1' })
        const reloadClients = new Set()
        wsServer.on('connection', (ws) => {
          reloadClients.add(ws)
          ws.on('close', () => reloadClients.delete(ws))
          ws.on('message', () => { /* ping/pong — keep SW alive */ })
        })
        wsServer.on('listening', () => {
          console.log(`[BrowserBridge] hot-reload WS listening on 127.0.0.1:${RELOAD_WS_PORT}`)
        })
        wsServer.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            console.log(`[BrowserBridge] hot-reload WS port ${RELOAD_WS_PORT} занят — пропускаем`)
          } else {
            console.log(`[BrowserBridge] hot-reload WS error: ${err.message}`)
          }
        })

        // Mtime poll каждые 1 секунду (внутри bridge, не SW) — самый простой
        // и надёжный watcher без зависимости от chokidar.
        const watchFiles = [
          'manifest.json', 'background.js', 'youtube-content.js',
          'aistudio-autoscrape.js', 'aistudio-core.js', 'aistudio-mcp.js',
          'claude-autoscrape.js', 'claude-research.js', 'perplexity-research.js',
          'chatgpt-research.js', 'research-badge.js',
          'popup.html', 'popup.js', 'settings.js', 'mcp-handlers.js', 'mcp-content.js',
        ]
        let lastMtime = 0
        const computeMaxMtime = () => {
          let max = 0
          for (const f of watchFiles) {
            try {
              const st = fs.statSync(path.join(extDir, f))
              if (st.mtimeMs > max) max = st.mtimeMs
            } catch {}
          }
          return max
        }
        lastMtime = computeMaxMtime()
        setInterval(() => {
          const m = computeMaxMtime()
          if (m > lastMtime) {
            console.log(`[BrowserBridge] hot-reload triggered (mtime ${lastMtime} → ${m}), notifying ${reloadClients.size} clients`)
            lastMtime = m
            for (const ws of reloadClients) {
              try { if (ws.readyState === ws.OPEN) ws.send('reload') } catch {}
            }
          }
        }, 1000)
      } else {
        console.log('[BrowserBridge] hot-reload WS skipped: extension dir not found (production?)')
      }
    } catch (e) {
      console.log(`[BrowserBridge] hot-reload WS init failed: ${e?.message || e}`)
    }
  }

  return server
}

module.exports = { startServer, PORT, RELOAD_WS_PORT }
