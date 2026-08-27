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
  createTerminalNotificationRoute,
} = require('./terminal-notification-route')
const {
  ensureNotificationToken,
  matchesBearerToken,
} = require('./local-notification-auth')
const {
  EXTENSION_YOUTUBE_SCHEMA_VERSION,
  extensionYoutubeFromSettings,
  extensionYoutubeSchemaState,
  patchExtensionYoutubeSettings,
  publicAppSettings,
} = require('./app-settings')
const {
  MAX_ATTACHMENT_BYTES,
  normalizeResearchAttachments,
  materializeResearchAttachments,
  publicAttachmentMeta,
  researchResultForPersist,
} = require('./research-attachments')
const {
  normalizeChatgptConversationUrl,
  chatgptResearchEntryUrl,
} = require('./chatgpt-url')
const { withResearchAutoClose } = require('./research-tab-policy')
const { reconcileResearchTabOpen, researchIdFromUrl } = require('./research-tab-open')

const BODY_LIMITS = {
  default: 64 * 1024,
  vocabularySync: 2 * 1024 * 1024,
  vocabularyPractice: 256 * 1024,
  researchStart: 2 * 1024 * 1024,
  researchState: 5 * 1024 * 1024,
  researchArtifactJson: 30 * 1024 * 1024,
  researchArtifactFile: 25 * 1024 * 1024,
  telegramLive: 256 * 1024,
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
        ? researchState.chatgptModelLabel(snap.options)
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
    invalidateResearchHistoryCache()
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
    invalidateResearchHistoryCache()
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
        if (msg.success === false) {
          const error = new Error(msg.error || 'extension error')
          error.code = msg.code || null
          error.deliveryUnknown = msg.deliveryUnknown === true
          error.retryable = msg.retryable === true
          pending.reject(error)
        }
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
let researchHistoryCache = null
// Кэш реестра Perplexity-моделей. Заполняется CS через POST /pplx-models-register
// при каждой загрузке perplexity-страницы. Источник правды — perplexity-research.js.
let PPLX_MODELS_CACHE = null
const AISTUDIO_TTL_MS = 60 * 60 * 1000 // 1 час

function invalidateResearchHistoryCache() {
  researchHistoryCache = null
}

function cachedResearchHistory() {
  if (researchHistoryCache) return researchHistoryCache
  try {
    researchHistoryCache = db()?.listResearchJobs(100) || []
  } catch (e) {
    console.log('[BrowserBridge] external-jobs db history failed:', e?.message)
    researchHistoryCache = []
  }
  return researchHistoryCache
}

// Navbar/popover/history need status and compact previews, not multi-megabyte
// answers and source arrays. Keep the full object available for an explicit
// JobDetail refresh, but never move it through the 1.5-second background path.
function externalJobSummary(job) {
  if (!job || typeof job !== 'object') return job
  const fullPrompt = typeof job.fullPrompt === 'string' ? job.fullPrompt
    : typeof job.prompt === 'string' ? job.prompt
      : ''
  const responseText = typeof job.responseText === 'string' ? job.responseText : ''
  const answerText = typeof job.answerText === 'string' ? job.answerText : ''
  const sources = Array.isArray(job.sources) ? job.sources : []
  const summary = {
    ...job,
    promptHead: job.promptHead || (fullPrompt ? fullPrompt.slice(0, 140) : null),
    promptLen: job.promptLen ?? (fullPrompt ? fullPrompt.length : null),
    responseTextLen: job.responseTextLen ?? (responseText ? responseText.length : null),
    responseHead: job.responseHead || (responseText ? responseText.slice(0, 600) : null),
    answerHead: job.answerHead || (answerText ? answerText.slice(0, 600) : null),
    linkCount: job.linkCount ?? (sources.length || null),
  }
  for (const key of [
    'prompt', 'fullPrompt', 'responseText', 'answerText', 'reasoningText',
    'sources', 'sourcesMeta', 'sourceActivity', 'result', 'resultJson',
    'options', 'log',
  ]) delete summary[key]
  return summary
}

function listExternalJobsForUi({ summary = false, jobId = null } = {}) {
  const out = []
  const cutoff = Date.now() - AISTUDIO_TTL_MS
  for (const [id, j] of AISTUDIO_JOBS) {
    if ((j.updatedAt || 0) < cutoff && j.status !== 'running' && j.status !== 'pending') {
      AISTUDIO_JOBS.delete(id)
      continue
    }
    out.push({ kind: 'aistudio', ...j })
  }
  try {
    for (const rj of researchState.listAllForUi()) out.push(rj)
  } catch (e) {
    console.log('[BrowserBridge] external-jobs research list failed:', e?.message)
  }
  const seen = new Set(out.map(j => j.jobId))
  for (const historic of cachedResearchHistory()) {
    if (!seen.has(historic.jobId)) out.push(historic)
  }
  const isActive = status => status === 'running' || status === 'pending' || status === 'queued'
  out.sort((a, b) => {
    const aa = isActive(a.status) ? 1 : 0
    const bb = isActive(b.status) ? 1 : 0
    if (aa !== bb) return bb - aa
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  })
  const selected = jobId ? out.filter(job => job.jobId === jobId) : out
  return summary ? selected.map(externalJobSummary) : selected
}

// Очередь команд для расширения (focus tab / close tab из popover'а).
// Bridge не имеет прямого доступа к chrome.tabs — кладём команду в queue,
// расширение opt-in polls и выполняет. См. background.js::pollBridgeCommands.
const BRIDGE_COMMAND_QUEUE = []  // [{cmd:'focus_tab'|'close_tab', tabId, ts}]
// requestId → {resolve, reject, timer}. The auth value exists only in this
// short-lived in-memory handoff and is never logged or persisted.
const BOOSTY_AUTH_REQUESTS = new Map()

function capBridgeCommandQueue() {
  if (BRIDGE_COMMAND_QUEUE.length > 50) {
    BRIDGE_COMMAND_QUEUE.splice(0, BRIDGE_COMMAND_QUEUE.length - 50)
  }
}

function requestBoostyAuthCookie({ timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const timer = setTimeout(() => {
      BOOSTY_AUTH_REQUESTS.delete(requestId)
      reject(new Error('Расширение браузера не ответило. Откройте Boosty в браузере и повторите.'))
    }, timeoutMs)
    BOOSTY_AUTH_REQUESTS.set(requestId, { resolve, reject, timer })
    BRIDGE_COMMAND_QUEUE.push({ cmd: 'boosty_auth', requestId, ts: Date.now() })
    capBridgeCommandQueue()
    console.log(`[BrowserBridge] queued Boosty auth request id=${requestId.slice(0, 8)}`)
  })
}
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
const LEARNING_MEDIA_ACCESS_TOKEN = crypto.randomBytes(24).toString('base64url')
function isExtensionOrigin(origin) {
  return origin === SC_BROWSER_EXTENSION_ORIGIN
}

function isExtensionSettingsRequest(req) {
  const origin = req.headers.origin || ''
  if (isExtensionOrigin(origin)) return true
  // Yandex omits Origin on some loopback fetches from extension pages/service
  // workers. A public web page cannot attach this custom header without a CORS
  // preflight, and unknown origins never receive our allow-origin response.
  return !origin && req.headers['x-sc-extension-id'] === SC_BROWSER_EXTENSION_ID
}

function isLearningMediaRequest(req, url, { tokenAllowed = false } = {}) {
  if (isExtensionSettingsRequest(req)) return true
  return tokenAllowed && String(url.searchParams.get('token') || '') === LEARNING_MEDIA_ACCESS_TOKEN
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

function telegramDesktopJobId(value) {
  const raw = typeof value === 'string' && value.startsWith('desktop:')
    ? value.slice('desktop:'.length)
    : value
  const id = Number(raw)
  return Number.isFinite(id) && id > 0 ? id : null
}

function telegramJobIsTerminal(job) {
  return !!job && ['done', 'error', 'cancelled', 'interrupted'].includes(job.status)
}

async function waitForTelegramDesktopJob(jobRunner, id, waitMs) {
  const boundedWait = Math.max(0, Math.min(30000, Number(waitMs || 0) || 0))
  let current = jobRunner.getJobDetail(id)
  if (!current || boundedWait <= 0 || telegramJobIsTerminal(current)) return current
  await new Promise(resolve => {
    let settled = false
    let off = null
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { off?.() } catch {}
      resolve()
    }
    const timer = setTimeout(finish, boundedWait)
    off = jobRunner.subscribe(snapshot => {
      if (Number(snapshot?.id) !== Number(id)) return
      current = snapshot
      if (telegramJobIsTerminal(snapshot)) finish()
    })
    current = jobRunner.getJobDetail(id) || current
    if (telegramJobIsTerminal(current)) finish()
  })
  return jobRunner.getJobDetail(id) || current
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

const LEARNING_MEDIA_MIME = Object.freeze({
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
})

function existingAllowedFile(filePath, roots) {
  if (!filePath || typeof filePath !== 'string') return null
  const absolute = path.resolve(filePath)
  const allowed = (roots || []).some(rawRoot => {
    if (!rawRoot) return false
    const root = path.resolve(rawRoot)
    const relative = path.relative(root, absolute)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
  if (!allowed) return null
  try {
    const stat = fs.statSync(absolute)
    return stat.isFile() && stat.size > 0 ? { path: absolute, stat } : null
  } catch {
    return null
  }
}

function srtPathForTranscript(transcriptPath) {
  const value = String(transcriptPath || '').trim()
  return value ? value.replace(/\.txt$/i, '.srt') : ''
}

function learningMediaRows(jobRunner) {
  const database = db()
  if (!database) return []
  const storage = jobRunner.getBoostyStorageConfig()
  const sources = database.listSources('boosty') || []
  const rows = []
  for (const source of sources) {
    for (const item of database.listBoostyVideos(source.id) || []) {
      const video = existingAllowedFile(item.video_path, [jobRunner.LIB_ROOT, storage.video_dir])
      const subtitles = existingAllowedFile(srtPathForTranscript(item.transcript_path), [jobRunner.LIB_ROOT])
      const audio = existingAllowedFile(item.media_path, [jobRunner.LIB_ROOT, storage.audio_dir])
      rows.push({ source, item, video, subtitles, audio })
    }
  }
  return rows.sort((left, right) => Number(right.item.published_at || 0) - Number(left.item.published_at || 0))
}

function publicLearningMedia(row, accessToken = '') {
  if (!row) return null
  const { source, item, video, subtitles, audio } = row
  return {
    id: item.id,
    sourceId: item.source_id,
    externalId: String(item.external_id || ''),
    title: item.title || 'Видео Boosty',
    author: source.display_name || source.handle || 'Boosty',
    sourceUrl: item.url || '',
    durationSeconds: Number(item.duration_seconds || 0),
    publishedAt: Number(item.published_at || 0),
    videoReady: !!video,
    videoBytes: Number(video?.stat?.size || 0),
    subtitlesReady: !!subtitles,
    audioReady: !!audio,
    downloadStatus: item.download_status || 'none',
    transcribeStatus: item.transcribe_status || 'none',
    videoUrl: video ? `/learning/media/${item.id}/video?token=${encodeURIComponent(accessToken)}` : '',
    subtitlesUrl: subtitles ? `/learning/media/${item.id}/subtitles?token=${encodeURIComponent(accessToken)}` : '',
  }
}

function parseSrtTimestamp(value) {
  const parts = String(value || '').trim().replace(',', '.').split(':').map(Number)
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return null
  return Math.round(((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000)
}

function parseSrtCues(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n')
  const cues = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('-->')) continue
    const [left, rightRaw] = lines[index].split(/\s+-->\s+/)
    const startMs = parseSrtTimestamp(left)
    const endMs = parseSrtTimestamp(String(rightRaw || '').split(/\s+/)[0])
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue
    const body = []
    for (index += 1; index < lines.length && lines[index].trim(); index += 1) body.push(lines[index].trim())
    const cueText = body.join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (cueText) cues.push({ startMs, endMs, text: cueText })
  }
  return cues
}

function parseByteRange(value, size) {
  if (!value) return null
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/i)
  if (!match) return { invalid: true }
  let start = match[1] === '' ? null : Number(match[1])
  let end = match[2] === '' ? null : Number(match[2])
  if (start == null) {
    const suffix = Number(end)
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    if (!Number.isFinite(start) || start < 0 || start >= size) return { invalid: true }
    if (end == null || !Number.isFinite(end)) end = size - 1
    end = Math.min(size - 1, end)
  }
  if (end < start) return { invalid: true }
  return { start, end }
}

function streamLearningVideo(req, res, file) {
  const size = file.stat.size
  const range = parseByteRange(req.headers.range, size)
  const contentType = LEARNING_MEDIA_MIME[path.extname(file.path).toLowerCase()] || 'application/octet-stream'
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', contentType)
  if (range?.invalid) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` })
    res.end()
    return
  }
  if (range) {
    const length = range.end - range.start + 1
    res.writeHead(206, {
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': length,
    })
    if (req.method === 'HEAD') { res.end(); return }
    fs.createReadStream(file.path, { start: range.start, end: range.end }).pipe(res)
    return
  }
  res.writeHead(200, { 'Content-Length': size })
  if (req.method === 'HEAD') { res.end(); return }
  fs.createReadStream(file.path).pipe(res)
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

function parseTimestampedTranscript(text) {
  const cues = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\[(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\]\s+(.+)$/)
    if (!match) continue
    const fractionMs = Number(String(match[4] || '0').padEnd(3, '0'))
    const startMs = ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000
      + fractionMs
    const cueText = match[5].trim()
    if (!cueText) continue
    const previous = cues[cues.length - 1]
    if (previous && previous.startMs === startMs) {
      previous.text = `${previous.text} ${cueText}`.replace(/\s+/g, ' ').trim()
      continue
    }
    cues.push({ startMs, endMs: null, text: cueText })
  }
  for (let i = 0; i < cues.length; i += 1) {
    const next = cues[i + 1]
    cues[i].endMs = next ? Math.max(cues[i].startMs + 250, next.startMs) : cues[i].startMs + 3000
  }
  return cues
}

const TRANSLATOR_DEFAULT_ENDPOINT = 'https://api.cognitive.microsofttranslator.com'
const TRANSLATOR_MAX_ITEMS = 25
const TRANSLATOR_MAX_CHARS = 5_000
const TRANSLATOR_MAX_DICTIONARY_EXAMPLE_PAIRS = 10
const TRANSLATOR_TIMEOUT_MS = 6_000
const TRANSLATOR_MAX_ATTEMPTS = 2
const TRANSLATOR_RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504])

function translatorConfig(settingsAccess) {
  const settings = settingsAccess?.readScSettings?.() || {}
  const raw = settings.azure_translator && typeof settings.azure_translator === 'object'
    ? settings.azure_translator
    : {}
  const key = String(
    process.env.AZURE_TRANSLATOR_KEY
      || settings.api_keys?.AZURE_TRANSLATOR_KEY
      || '',
  ).trim()
  const endpoint = String(raw.endpoint || TRANSLATOR_DEFAULT_ENDPOINT)
    .trim()
    .replace(/\/+$/, '')
  const region = String(raw.region || '').trim().toLowerCase()
  return { key, endpoint: endpoint || TRANSLATOR_DEFAULT_ENDPOINT, region }
}

function cleanLanguageCode(value, { allowAuto = false } = {}) {
  const text = String(value || '').trim()
  if (allowAuto && (!text || text === 'auto')) return 'auto'
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/i.test(text)) {
    throw new Error(`invalid language code: ${text || 'empty'}`)
  }
  return text
}

function dictionaryLanguageCode(value) {
  const code = cleanLanguageCode(value)
  if (/^zh-(?:Hans|Hant)$/i.test(code)) return code
  return code.split('-')[0]
}

function translatorCacheKey(operation, sourceLang, targetLang, sourceText) {
  return crypto.createHash('sha256')
    .update(`${operation}\u0000${sourceLang}\u0000${targetLang}\u0000${sourceText}`)
    .digest('hex')
}

async function azureTranslatorRequest(settingsAccess, route, params, body) {
  const config = translatorConfig(settingsAccess)
  if (!config.key) {
    const error = new Error('Azure Translator key is not configured')
    error.code = 'translator_not_configured'
    throw error
  }
  const url = new URL(config.endpoint + route)
  url.searchParams.set('api-version', '3.0')
  for (const [key, value] of Object.entries(params || {})) {
    if (value != null && value !== '' && value !== 'auto') url.searchParams.set(key, String(value))
  }
  for (let attempt = 1; attempt <= TRANSLATOR_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TRANSLATOR_TIMEOUT_MS)
    let failure = null
    const headers = {
      'Content-Type': 'application/json; charset=UTF-8',
      'Ocp-Apim-Subscription-Key': config.key,
      'X-ClientTraceId': crypto.randomUUID(),
    }
    if (config.region) headers['Ocp-Apim-Subscription-Region'] = config.region
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const rawText = await response.text()
      let payload = null
      try { payload = rawText ? JSON.parse(rawText) : null } catch {}
      if (response.ok) return payload

      const detail = payload?.error?.message || payload?.message || rawText || response.statusText
      failure = new Error(`Azure Translator HTTP ${response.status}: ${String(detail).slice(0, 500)}`)
      failure.status = response.status
      failure.code = payload?.error?.code || 'translator_http_error'
      failure.retryable = TRANSLATOR_RETRYABLE_STATUSES.has(response.status)
    } catch (error) {
      const timeout = error?.name === 'AbortError'
      const transportCode = String(error?.cause?.code || '').trim()
      failure = new Error(timeout
        ? `Azure Translator timed out after ${TRANSLATOR_TIMEOUT_MS} ms`
        : `Azure Translator network error${transportCode ? ` (${transportCode})` : ''}`)
      failure.code = timeout ? 'translator_timeout' : 'translator_network_error'
      failure.retryable = true
    } finally {
      clearTimeout(timer)
    }

    if (attempt < TRANSLATOR_MAX_ATTEMPTS && failure?.retryable) {
      console.log(`[Translator] retry route=${route} attempt=${attempt + 1} reason=${failure.code || failure.status || 'transient'}`)
      await new Promise(resolve => setTimeout(resolve, 220 * attempt))
      continue
    }
    throw failure || new Error('Azure Translator request failed')
  }

  throw new Error('Azure Translator request failed')
}

function sanitizeTranslationTexts(rawTexts) {
  const texts = Array.isArray(rawTexts) ? rawTexts : [rawTexts]
  const cleaned = texts.map(value => String(value || '').trim()).filter(Boolean)
  if (!cleaned.length) throw new Error('at least one text is required')
  if (cleaned.length > TRANSLATOR_MAX_ITEMS) {
    throw new Error(`too many texts (${cleaned.length} > ${TRANSLATOR_MAX_ITEMS})`)
  }
  if (cleaned.some(text => text.length > 10_000)) throw new Error('one text is too long')
  const chars = cleaned.reduce((sum, text) => sum + text.length, 0)
  if (chars > TRANSLATOR_MAX_CHARS) {
    throw new Error(`translation request is too large (${chars} > ${TRANSLATOR_MAX_CHARS})`)
  }
  return cleaned
}

async function translateTexts(settingsAccess, rawTexts, rawFrom, rawTo) {
  const texts = sanitizeTranslationTexts(rawTexts)
  const sourceLang = cleanLanguageCode(rawFrom, { allowAuto: true })
  const targetLang = cleanLanguageCode(rawTo)
  const results = new Array(texts.length)
  const misses = []

  texts.forEach((sourceText, index) => {
    // v1 responses predate Azure word alignment. A versioned cache key makes
    // every old line refresh exactly once instead of staying unalignable.
    const cacheKey = translatorCacheKey('translate-alignment-v1', sourceLang, targetLang, sourceText)
    const cached = db()?.getTranslationCache(cacheKey)
    if (cached?.response) {
      results[index] = { source_text: sourceText, response: cached.response, cached: true }
    } else {
      misses.push({ sourceText, index, cacheKey })
    }
  })

  if (misses.length) {
    const payload = await azureTranslatorRequest(
      settingsAccess,
      '/translate',
      { from: sourceLang, to: targetLang, textType: 'plain', includeAlignment: true },
      misses.map(item => ({ Text: item.sourceText })),
    )
    if (!Array.isArray(payload) || payload.length !== misses.length) {
      throw new Error('Azure Translator returned an unexpected translate response')
    }
    misses.forEach((item, i) => {
      const response = payload[i]
      db()?.upsertTranslationCache({
        cacheKey: item.cacheKey,
        operation: 'translate',
        sourceLang,
        targetLang,
        sourceText: item.sourceText,
        response,
      })
      results[item.index] = { source_text: item.sourceText, response, cached: false }
    })
  }

  return {
    source_lang: sourceLang,
    target_lang: targetLang,
    translations: results.map(item => ({
      source_text: item.source_text,
      translated_text: item.response?.translations?.[0]?.text || '',
      alignment: item.response?.translations?.[0]?.alignment?.proj || '',
      detected_language: item.response?.detectedLanguage?.language || null,
      cached: item.cached,
    })),
  }
}

async function dictionaryLookup(settingsAccess, rawText, rawFrom, rawTo) {
  const sourceText = String(rawText || '').trim()
  if (!sourceText || sourceText.length > 100) throw new Error('dictionary term must contain 1-100 characters')
  const sourceLang = dictionaryLanguageCode(rawFrom)
  const targetLang = dictionaryLanguageCode(rawTo)
  const cacheKey = translatorCacheKey('dictionary', sourceLang, targetLang, sourceText)
  const cached = db()?.getTranslationCache(cacheKey)
  if (cached?.response) {
    return { source_lang: sourceLang, target_lang: targetLang, dictionary: cached.response, cached: true }
  }

  try {
    const payload = await azureTranslatorRequest(
      settingsAccess,
      '/dictionary/lookup',
      { from: sourceLang, to: targetLang },
      [{ Text: sourceText }],
    )
    const dictionary = Array.isArray(payload) ? payload[0] : null
    if (dictionary?.translations?.length) {
      db()?.upsertTranslationCache({
        cacheKey,
        operation: 'dictionary',
        sourceLang,
        targetLang,
        sourceText,
        response: dictionary,
      })
      return { source_lang: sourceLang, target_lang: targetLang, dictionary, cached: false }
    }
  } catch (error) {
    // Dictionary coverage is narrower than ordinary translation. A missing
    // language pair or non-dictionary phrase falls back to /translate; auth,
    // quota and server failures stay visible instead of being disguised.
    if (![400, 404].includes(Number(error?.status))) throw error
  }

  const fallback = await translateTexts(settingsAccess, [sourceText], sourceLang, targetLang)
  return {
    source_lang: sourceLang,
    target_lang: targetLang,
    dictionary: null,
    fallback_translation: fallback.translations[0]?.translated_text || '',
    cached: fallback.translations[0]?.cached === true,
  }
}

function sanitizeDictionaryExamplePairs(rawPairs) {
  const pairs = (Array.isArray(rawPairs) ? rawPairs : [])
    .map((raw) => ({
      text: String(raw?.text || raw?.sourceText || '').trim(),
      translation: String(raw?.translation || raw?.targetText || '').trim(),
    }))
    .filter((pair) => pair.text && pair.translation)
  if (!pairs.length) throw new Error('at least one dictionary example pair is required')
  if (pairs.length > TRANSLATOR_MAX_DICTIONARY_EXAMPLE_PAIRS) {
    throw new Error(`too many dictionary example pairs (${pairs.length} > ${TRANSLATOR_MAX_DICTIONARY_EXAMPLE_PAIRS})`)
  }
  if (pairs.some((pair) => pair.text.length > 100 || pair.translation.length > 100)) {
    throw new Error('dictionary example terms must contain 1-100 characters')
  }
  return Array.from(new Map(
    pairs.map((pair) => [`${pair.text.toLocaleLowerCase('en-US')}\u0000${pair.translation.toLocaleLowerCase('en-US')}`, pair]),
  ).values())
}

async function dictionaryExamples(settingsAccess, rawPairs, rawFrom, rawTo, options = {}) {
  const pairs = sanitizeDictionaryExamplePairs(rawPairs)
  const sourceLang = dictionaryLanguageCode(rawFrom)
  const targetLang = dictionaryLanguageCode(rawTo)
  const sourceText = JSON.stringify(pairs)
  const cacheKey = translatorCacheKey('dictionary-examples-v1', sourceLang, targetLang, sourceText)
  const cache = options.cache === false ? null : db()
  const cached = cache?.getTranslationCache(cacheKey)
  if (cached?.response) {
    return { source_lang: sourceLang, target_lang: targetLang, examples: cached.response, cached: true }
  }

  const payload = await azureTranslatorRequest(
    settingsAccess,
    '/dictionary/examples',
    { from: sourceLang, to: targetLang },
    pairs.map((pair) => ({ Text: pair.text, Translation: pair.translation })),
  )
  if (!Array.isArray(payload) || payload.length !== pairs.length) {
    throw new Error('Azure Translator returned an unexpected dictionary examples response')
  }
  cache?.upsertTranslationCache({
    cacheKey,
    operation: 'dictionary',
    sourceLang,
    targetLang,
    sourceText,
    response: payload,
  })
  return { source_lang: sourceLang, target_lang: targetLang, examples: payload, cached: false }
}

const VOICE_DISCOVERY_DIR = path.join(os.homedir(), '.noted-terminal')
const VOICE_TOKEN_FILE = path.join(VOICE_DISCOVERY_DIR, 'web-token.txt')
const VOICE_DISCOVERY_RE = /^voice-web-server-\d+\.json$/

function normalizeVocabularyTerm(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US')
}

function normalizeVocabularyPartOfSpeech(value) {
  const normalized = String(value || 'unknown').trim().toLocaleLowerCase('en-US')
  return normalized || 'unknown'
}

function vocabularyIdentityKey(item) {
  const kind = item?.kind === 'phrase' ? 'phrase' : 'word'
  const sourceLang = String(item?.sourceLang || 'auto').trim().toLocaleLowerCase('en-US')
  const targetLang = String(item?.targetLang || 'ru').trim().toLocaleLowerCase('en-US')
  const lemma = normalizeVocabularyTerm(item?.lemma || item?.sourceText || item?.term)
  return kind === 'phrase'
    ? `${kind}|${sourceLang}|${targetLang}|${lemma}`
    : `${kind}|${sourceLang}|${targetLang}|${lemma}`
}

function voiceServerCandidates() {
  let files = []
  try { files = fs.readdirSync(VOICE_DISCOVERY_DIR).filter((name) => VOICE_DISCOVERY_RE.test(name)) }
  catch { return [] }
  return files.map((name) => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(VOICE_DISCOVERY_DIR, name), 'utf8'))
      const port = Number(raw?.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null
      return { port, updatedAt: Number(raw?.updatedAt) || 0 }
    } catch { return null }
  }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)
}

async function voiceVocabularyRequest(method, route, body = null, timeoutMs = 4_000) {
  let token = ''
  try { token = fs.readFileSync(VOICE_TOKEN_FILE, 'utf8').trim() }
  catch {}
  if (!token) {
    const error = new Error('Voice Record API token is unavailable')
    error.code = 'voice_record_offline'
    throw error
  }
  const candidates = voiceServerCandidates()
  if (!candidates.length) {
    const error = new Error('Voice Record is not running')
    error.code = 'voice_record_offline'
    throw error
  }
  let lastError = null
  for (const candidate of candidates) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 4_000))
    try {
      const response = await fetch(`http://127.0.0.1:${candidate.port}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body == null ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok === false) {
        const error = new Error(payload?.error || `Voice Record HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return payload
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
  }
  const error = new Error(lastError?.name === 'AbortError'
    ? 'Voice Record API timed out'
    : (lastError?.message || 'Voice Record API is unavailable'))
  error.code = 'voice_record_offline'
  throw error
}

const LEARNING_EXPLANATION_MODEL = 'gemini-3.7-flash'
const LEARNING_EXPLANATION_VERSION = 'v13'
const learningExplanationInflight = new Map()
const LEARNING_LITERAL_MODEL = 'gemini-3.1-flash-lite'
const LEARNING_LITERAL_VERSION = 'v4'
const learningLiteralInflight = new Map()
const LEARNING_EXPRESSION_MODEL = 'gemini-3.1-flash-lite'
const LEARNING_EXPRESSION_VERSION = 'v1'
const learningExpressionInflight = new Map()
const LEARNING_EXPRESSION_TYPES = new Set(['phrasal_verb', 'function_phrase', 'idiom'])

function normalizeLearningExplanationPayload(raw = {}) {
  const word = String(raw.word || raw.sourceText || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const context = String(raw.context || raw.cueText || '').replace(/\s+/g, ' ').trim().slice(0, 3000)
  if (!word) throw new Error('word is required')
  if (!context) throw new Error('subtitle context is required')
  const knownMeanings = Array.from(new Set((Array.isArray(raw.knownMeanings) ? raw.knownMeanings : [])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300))
    .filter(Boolean))).slice(0, 12)
  const dictionaryTranslations = (Array.isArray(raw.dictionaryTranslations) ? raw.dictionaryTranslations : [])
    .map((item) => ({
      value: String(item?.value || item?.translation || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      partOfSpeech: normalizeVocabularyPartOfSpeech(item?.partOfSpeech || item?.pos),
    }))
    .filter((item) => item.value)
    .slice(0, 20)
  return {
    word,
    wordTranslation: String(raw.wordTranslation || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    context,
    contextTranslation: String(raw.contextTranslation || '').replace(/\s+/g, ' ').trim().slice(0, 3000),
    sourceLang: cleanLanguageCode(raw.sourceLang || 'en'),
    targetLang: cleanLanguageCode(raw.targetLang || 'ru'),
    knownMeanings,
    dictionaryTranslations,
  }
}

function learningExplanationCacheKey(payload) {
  const digest = crypto.createHash('sha256')
    .update([
      LEARNING_EXPLANATION_VERSION,
      LEARNING_EXPLANATION_MODEL,
      payload.sourceLang,
      payload.targetLang,
      payload.word.toLocaleLowerCase('en-US'),
      payload.context,
      JSON.stringify(payload.knownMeanings),
      JSON.stringify(payload.dictionaryTranslations),
    ].join('\u0000'))
    .digest('hex')
  return `learning-ai:${digest}`
}

function normalizeLearningExplanationResult(result) {
  return {
    explanation: String(result?.explanation || '').replace(/\s+/g, ' ').trim().slice(0, 1500),
    model: String(result?.model || LEARNING_EXPLANATION_MODEL),
    lemma: String(result?.lemma || '').trim().slice(0, 120),
    partOfSpeech: normalizeVocabularyPartOfSpeech(result?.partOfSpeech),
    analysisConfidence: String(result?.analysisConfidence || 'low').trim().slice(0, 16),
    currentMeanings: Array.from(new Set((Array.isArray(result?.currentMeanings) ? result.currentMeanings : [])
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300))
      .filter(Boolean))).slice(0, 3),
    matchedMeaning: String(result?.matchedMeaning || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    expressionText: String(result?.expressionText || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US').slice(0, 160),
    meaningGroups: (Array.isArray(result?.meaningGroups) ? result.meaningGroups : []).slice(0, 20).map((group) => ({
      values: Array.from(new Set((Array.isArray(group?.values) ? group.values : [])
        .map((value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160))
        .filter(Boolean))),
      partOfSpeech: normalizeVocabularyPartOfSpeech(group?.partOfSpeech || group?.pos),
      example: String(group?.example || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
      exampleTranslation: String(group?.exampleTranslation || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
    })).filter((group) => group.values.length),
    invalidValues: Array.from(new Set((Array.isArray(result?.invalidValues) ? result.invalidValues : [])
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160))
      .filter(Boolean))).slice(0, 20),
  }
}

async function learningWordExplanation(raw) {
  const payload = normalizeLearningExplanationPayload(raw)
  const cacheKey = learningExplanationCacheKey(payload)
  const cached = db()?.getUiPreference(cacheKey)
  if (cached?.explanation) {
    return {
      explanation: String(cached.explanation),
      model: cached.model || LEARNING_EXPLANATION_MODEL,
      lemma: String(cached.lemma || ''),
      partOfSpeech: normalizeVocabularyPartOfSpeech(cached.partOfSpeech),
      analysisConfidence: String(cached.analysisConfidence || 'low'),
      currentMeanings: Array.isArray(cached.currentMeanings) ? cached.currentMeanings : [],
      matchedMeaning: String(cached.matchedMeaning || ''),
      expressionText: String(cached.expressionText || ''),
      meaningGroups: Array.isArray(cached.meaningGroups) ? cached.meaningGroups : [],
      invalidValues: Array.isArray(cached.invalidValues) ? cached.invalidValues : [],
      cached: true,
    }
  }
  if (learningExplanationInflight.has(cacheKey)) return learningExplanationInflight.get(cacheKey)
  const request = (async () => {
    const result = await voiceVocabularyRequest(
      'POST',
      '/api/desktop/learning-explain',
      payload,
      20_000,
    )
    const normalized = normalizeLearningExplanationResult(result)
    if (!normalized.explanation) throw new Error('Voice Record returned an empty learning explanation')
    const value = {
      ...normalized,
      createdAt: Date.now(),
    }
    db()?.setUiPreference(cacheKey, value)
    return { ...value, cached: false }
  })()
  learningExplanationInflight.set(cacheKey, request)
  try { return await request }
  finally { learningExplanationInflight.delete(cacheKey) }
}

function normalizeLearningExpressionPayload(raw = {}) {
  const selectedText = String(raw.selectedText || raw.text || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  const context = String(raw.context || selectedText).replace(/\s+/g, ' ').trim().slice(0, 3000)
  if (!selectedText || !selectedText.includes(' ')) throw new Error('multi-word expression is required')
  return {
    selectedText,
    context,
    contextTranslation: String(raw.contextTranslation || '').replace(/\s+/g, ' ').trim().slice(0, 3000),
    sourceLang: cleanLanguageCode(raw.sourceLang || 'en'),
    targetLang: cleanLanguageCode(raw.targetLang || 'ru'),
  }
}

function learningExpressionCacheKey(payload) {
  const digest = crypto.createHash('sha256')
    .update([
      LEARNING_EXPRESSION_VERSION,
      LEARNING_EXPRESSION_MODEL,
      payload.sourceLang,
      payload.targetLang,
      payload.selectedText.toLocaleLowerCase('en-US'),
      payload.context,
    ].join('\u0000'))
    .digest('hex')
  return `learning-expression:${digest}`
}

function normalizeLearningExpressionResult(raw = {}) {
  const expressionType = LEARNING_EXPRESSION_TYPES.has(String(raw.expressionType || ''))
    ? String(raw.expressionType)
    : ''
  return {
    eligible: !!expressionType,
    expressionType,
    canonicalText: String(raw.canonicalText || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US').slice(0, 500),
    translation: String(raw.translation || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
    confidence: ['high', 'medium', 'low'].includes(String(raw.confidence || '')) ? String(raw.confidence) : 'low',
    model: String(raw.model || LEARNING_EXPRESSION_MODEL),
  }
}

async function learningExpressionClassification(raw) {
  const payload = normalizeLearningExpressionPayload(raw)
  const cacheKey = learningExpressionCacheKey(payload)
  const cached = db()?.getUiPreference(cacheKey)
  if (cached?.canonicalText) return { ...normalizeLearningExpressionResult(cached), cached: true }
  if (learningExpressionInflight.has(cacheKey)) return learningExpressionInflight.get(cacheKey)
  const request = (async () => {
    const remote = await voiceVocabularyRequest('POST', '/api/desktop/learning-expression', payload, 20_000)
    const value = { ...normalizeLearningExpressionResult(remote), createdAt: Date.now() }
    db()?.setUiPreference(cacheKey, value)
    return { ...value, cached: false }
  })()
  learningExpressionInflight.set(cacheKey, request)
  try { return await request }
  finally { learningExpressionInflight.delete(cacheKey) }
}

function normalizeLearningLiteralPayload(raw = {}) {
  const sourceText = String(raw.sourceText || raw.text || '').replace(/\s+/g, ' ').trim().slice(0, 3000)
  const naturalTranslation = String(raw.naturalTranslation || raw.translation || '').replace(/\s+/g, ' ').trim().slice(0, 3000)
  if (!sourceText) throw new Error('subtitle source text is required')
  if (!naturalTranslation) throw new Error('natural subtitle translation is required')
  return {
    sourceText,
    naturalTranslation,
    sourceLang: cleanLanguageCode(raw.sourceLang || raw.from || 'en'),
    targetLang: cleanLanguageCode(raw.targetLang || raw.to || 'ru'),
  }
}

function learningLiteralCacheKey(payload) {
  const digest = crypto.createHash('sha256')
    .update([
      LEARNING_LITERAL_VERSION,
      LEARNING_LITERAL_MODEL,
      payload.sourceLang,
      payload.targetLang,
      payload.sourceText,
      payload.naturalTranslation,
    ].join('\u0000'))
    .digest('hex')
  return `learning-literal:${digest}`
}

function snapLiteralAlignmentToWords(text, targetStart, targetEnd) {
  const words = Array.from(String(text || '').matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu), match => ({
    start: match.index,
    end: match.index + match[0].length,
  })).filter(word => word.start < targetEnd && word.end > targetStart)
  if (!words.length) return null
  let first = words[0]
  const last = words[words.length - 1]
  // A model can accidentally tag the last letter of the previous word plus
  // the beginning of the intended one (for example `а под` in
  // `Афина подходит`). Drop that partial left edge and keep the complete
  // following word; a single partial word is expanded instead of discarded.
  if (targetStart > first.start && words.length > 1) first = words[1]
  if (!first || first.start > last.end) return null
  return { targetStart: first.start, targetEnd: last.end }
}

function normalizeLiteralAlignments(rawAlignments, literalText) {
  const text = String(literalText || '')
  const result = []
  const seen = new Set()
  for (const raw of Array.isArray(rawAlignments) ? rawAlignments : []) {
    const sourceWordIndex = Number(raw?.sourceWordIndex)
    let targetStart = Number(raw?.targetStart)
    let targetEnd = Number(raw?.targetEnd)
    if (!Number.isInteger(sourceWordIndex) || sourceWordIndex < 0 || sourceWordIndex > 300) continue
    if (!Number.isInteger(targetStart) || !Number.isInteger(targetEnd)
        || targetStart < 0 || targetEnd <= targetStart || targetEnd > text.length) continue
    const snapped = snapLiteralAlignmentToWords(text, targetStart, targetEnd)
    if (!snapped) continue
    targetStart = snapped.targetStart
    targetEnd = snapped.targetEnd
    const key = `${sourceWordIndex}:${targetStart}:${targetEnd}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ sourceWordIndex, targetStart, targetEnd })
    if (result.length >= 300) break
  }
  return result
}

async function learningLiteralTranslation(raw) {
  const payload = normalizeLearningLiteralPayload(raw)
  const cacheKey = learningLiteralCacheKey(payload)
  const cached = db()?.getUiPreference(cacheKey)
  if (cached?.literalText) {
    return {
      literalText: String(cached.literalText),
      alignments: normalizeLiteralAlignments(cached.alignments, cached.literalText),
      model: cached.model || LEARNING_LITERAL_MODEL,
      cached: true,
    }
  }
  if (learningLiteralInflight.has(cacheKey)) return learningLiteralInflight.get(cacheKey)
  const request = (async () => {
    const result = await voiceVocabularyRequest(
      'POST',
      '/api/desktop/learning-literal',
      payload,
      20_000,
    )
    const literalText = String(result?.literalText || '').replace(/\s+/g, ' ').trim().slice(0, 4000)
    if (!literalText) throw new Error('Voice Record returned an empty literal subtitle')
    const value = {
      literalText,
      alignments: normalizeLiteralAlignments(result?.alignments, literalText),
      model: String(result?.model || LEARNING_LITERAL_MODEL),
      createdAt: Date.now(),
    }
    db()?.setUiPreference(cacheKey, value)
    return { ...value, cached: false }
  })()
  learningLiteralInflight.set(cacheKey, request)
  try { return await request }
  finally { learningLiteralInflight.delete(cacheKey) }
}

function normalizeVocabularyPracticeRequest(raw = {}) {
  const action = raw.action === 'start' ? 'start' : 'turn'
  const vocabulary = []
  const seen = new Set()
  for (const item of Array.isArray(raw.vocabulary) ? raw.vocabulary : []) {
    const id = String(item?.id || item?.key || '').trim().slice(0, 220)
    const term = String(item?.term || item?.sourceText || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 160)
    if (!id || !term || seen.has(id)) continue
    seen.add(id)
    vocabulary.push({
      id,
      term,
      translation: String(item?.translation || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      partOfSpeech: normalizeVocabularyPartOfSpeech(item?.partOfSpeech),
    })
    if (vocabulary.length >= 16) break
  }
  if (!vocabulary.length) throw new Error('practice vocabulary is empty')
  const history = (Array.isArray(raw.history) ? raw.history : []).slice(-16).map((message) => ({
    role: message?.role === 'user' ? 'user' : 'assistant',
    english: String(message?.english || message?.content || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
    russian: String(message?.russian || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
  })).filter((message) => message.english)
  const answer = String(raw.answer || '').replace(/\s+/g, ' ').trim().slice(0, 3000)
  if (action === 'turn' && !answer) throw new Error('English answer is required')
  return { action, vocabulary, history, answer }
}

async function vocabularyPracticeTurn(raw) {
  const payload = normalizeVocabularyPracticeRequest(raw)
  const result = await voiceVocabularyRequest(
    'POST',
    '/api/desktop/vocabulary-practice',
    payload,
    45_000,
  )
  return {
    online: true,
    feedbackRussian: String(result?.feedbackRussian || '').slice(0, 1200),
    correctedEnglish: String(result?.correctedEnglish || '').slice(0, 2000),
    assistantEnglish: String(result?.assistantEnglish || '').slice(0, 2000),
    assistantRussian: String(result?.assistantRussian || '').slice(0, 2000),
    usedVocabularyIds: Array.isArray(result?.usedVocabularyIds) ? result.usedVocabularyIds.slice(0, 8) : [],
    model: String(result?.model || 'gemini-3.1-flash-lite'),
    usage: result?.usage || null,
  }
}

function vocabularySyncPayload(entry) {
  return {
    term: String(entry?.sourceText || entry?.term || '').trim(),
    translation: String(entry?.translation || ''),
    translationSource: entry?.translationSource === 'manual' ? 'manual' : 'machine',
    state: ['saved', 'known'].includes(entry?.state) ? entry.state : 'none',
    kind: entry?.kind === 'phrase' ? 'phrase' : 'word',
    expressionType: LEARNING_EXPRESSION_TYPES.has(String(entry?.expressionType || '')) ? String(entry.expressionType) : '',
    sourceLang: String(entry?.sourceLang || 'auto').slice(0, 32),
    targetLang: String(entry?.targetLang || 'ru').slice(0, 32),
    lemma: String(entry?.lemma || entry?.sourceText || entry?.term || '').trim(),
    partOfSpeech: normalizeVocabularyPartOfSpeech(entry?.partOfSpeech),
    partsOfSpeech: Array.isArray(entry?.partsOfSpeech) ? entry.partsOfSpeech.slice(0, 20) : [],
    analysisConfidence: String(entry?.analysisConfidence || 'low').trim().slice(0, 16),
    observedForms: Array.isArray(entry?.observedForms) ? entry.observedForms.slice(0, 100) : [],
    contexts: Array.isArray(entry?.contexts) ? entry.contexts.slice(0, 100) : [],
    ...(entry?.replaceContexts === true ? { replaceContexts: true } : {}),
  }
}

function remoteVocabularyIndex(items) {
  const byId = new Map()
  const byTerm = new Map()
  const byIdentity = new Map()
  for (const item of items || []) {
    if (item?.id) byId.set(item.id, item)
    const key = normalizeVocabularyTerm(item?.term)
    if (key) byTerm.set(key, item)
    const identity = vocabularyIdentityKey(item)
    if (identity) byIdentity.set(identity, item)
  }
  return { byId, byTerm, byIdentity }
}

async function syncVocabularyWithVoice(rawBody) {
  const localEntries = Array.isArray(rawBody?.entries) ? rawBody.entries.slice(0, 5000) : []
  const reviewOps = Array.isArray(rawBody?.reviews) ? rawBody.reviews.slice(0, 5000) : []
  let remotePayload = await voiceVocabularyRequest('GET', '/api/vocabulary?limit=5000&includeInactive=1')
  let remoteItems = Array.isArray(remotePayload?.items) ? remotePayload.items : []
  let index = remoteVocabularyIndex(remoteItems)
  const conflicts = []
  const syncedKeys = []
  const skippedKeys = []

  for (const local of localEntries) {
    const term = String(local?.sourceText || local?.term || '').trim()
    const localKey = String(local?.key || '')
    if (!term || !localKey) continue
    let remote = (local.remoteId && index.byId.get(local.remoteId))
      || index.byIdentity.get(vocabularyIdentityKey(local))
      || index.byTerm.get(normalizeVocabularyTerm(term))
      || null
    const payload = vocabularySyncPayload(local)
    if (!remote) {
      if (payload.state === 'none') {
        skippedKeys.push(localKey)
        continue
      }
      const created = await voiceVocabularyRequest('POST', '/api/vocabulary', payload)
      remote = created?.item || null
      if (remote) {
        index.byId.set(remote.id, remote)
        index.byTerm.set(normalizeVocabularyTerm(remote.term), remote)
        index.byIdentity.set(vocabularyIdentityKey(remote), remote)
        syncedKeys.push(localKey)
      }
      continue
    }

    const patch = {}
    const remoteStateAt = Number(remote.stateUpdatedAt || remote.updatedAt || 0)
    const localStateAt = Number(local.stateUpdatedAt || local.updatedAt || 0)
    if (payload.state !== (remote.state || 'saved') && localStateAt >= remoteStateAt) {
      patch.state = payload.state
    }

    const remoteTranslation = String(remote.translation || '')
    const localTranslation = String(payload.translation || '')
    const remoteTranslationSource = remote.translationSource === 'machine' ? 'machine' : 'manual'
    const localTranslationSource = payload.translationSource
    const remoteTranslationAt = Number(remote.translationUpdatedAt || remote.updatedAt || 0)
    const localTranslationAt = Number(local.translationUpdatedAt || local.updatedAt || 0)
    const commonTranslationAt = Number(local.remoteTranslationUpdatedAt || 0)
    const translationDiffers = localTranslation !== remoteTranslation
    const bothChanged = localTranslationAt > commonTranslationAt && remoteTranslationAt > commonTranslationAt
    const manualConflict = translationDiffers
      && bothChanged
      && localTranslationSource === 'manual'
      && remoteTranslationSource === 'manual'
      && local.translationDirty === true
    if (manualConflict) {
      conflicts.push({
        key: localKey,
        field: 'translation',
        localValue: localTranslation,
        remoteValue: remoteTranslation,
        remoteId: remote.id,
        remoteUpdatedAt: remote.updatedAt,
        remoteTranslationUpdatedAt: remoteTranslationAt,
      })
    } else if (translationDiffers) {
      const localWins = local.translationDirty === true && (
        localTranslationSource === 'manual' && remoteTranslationSource !== 'manual'
        || localTranslationSource === remoteTranslationSource && localTranslationAt >= remoteTranslationAt
        || !remoteTranslation
      )
      if (localWins) {
        patch.translation = localTranslation
        patch.translationSource = localTranslationSource
      }
    }

    if (payload.kind !== (remote.kind || 'word')) patch.kind = payload.kind
    if (payload.expressionType !== (remote.expressionType || '')) patch.expressionType = payload.expressionType
    if (payload.sourceLang && payload.sourceLang !== remote.sourceLang) patch.sourceLang = payload.sourceLang
    if (payload.targetLang && payload.targetLang !== remote.targetLang) patch.targetLang = payload.targetLang
    if (payload.lemma && payload.lemma !== remote.lemma) patch.lemma = payload.lemma
    if (payload.partOfSpeech !== (remote.partOfSpeech || 'unknown')) patch.partOfSpeech = payload.partOfSpeech
    if (JSON.stringify(payload.partsOfSpeech) !== JSON.stringify(remote.partsOfSpeech || [])) patch.partsOfSpeech = payload.partsOfSpeech
    if (payload.analysisConfidence !== (remote.analysisConfidence || 'low')) patch.analysisConfidence = payload.analysisConfidence
    if (payload.observedForms.length) patch.observedForms = payload.observedForms
    if (payload.contexts.length || payload.replaceContexts === true) {
      patch.contexts = payload.contexts
      if (payload.replaceContexts === true) patch.replaceContexts = true
    }
    if (Object.keys(patch).length) {
      const updated = await voiceVocabularyRequest(
        'PATCH',
        `/api/vocabulary/${encodeURIComponent(remote.id)}`,
        patch,
      )
      remote = updated?.item || remote
      index.byId.set(remote.id, remote)
      index.byTerm.set(normalizeVocabularyTerm(remote.term), remote)
      index.byIdentity.set(vocabularyIdentityKey(remote), remote)
    }
    if (!manualConflict) syncedKeys.push(localKey)
  }

  const acknowledgedReviews = []
  const orderedReviewOps = [...reviewOps].sort((a, b) => Number(a?.createdAt || a?.reviewedAt || 0) - Number(b?.createdAt || b?.reviewedAt || 0))
  for (const operation of orderedReviewOps) {
    const operationId = String(operation?.id || '').trim()
    const remote = (operation.remoteId && index.byId.get(operation.remoteId))
      || index.byIdentity.get(vocabularyIdentityKey(operation))
      || index.byTerm.get(normalizeVocabularyTerm(operation.term))
    if (!operationId || !remote?.id) continue
    if (operation?.type === 'review') {
      const result = operation?.result === 'forgotten' ? 'forgotten' : operation?.result === 'remembered' ? 'remembered' : ''
      if (!result) continue
      const reviewed = await voiceVocabularyRequest(
        'POST',
        `/api/vocabulary/${encodeURIComponent(remote.id)}/review`,
        {
          result,
          mode: operation.mode === 'practice' ? 'practice' : 'scheduled',
          operationId,
          reviewedAt: Number(operation.reviewedAt) || Date.now(),
        },
      )
      if (reviewed?.item) {
        index.byId.set(reviewed.item.id, reviewed.item)
        index.byTerm.set(normalizeVocabularyTerm(reviewed.item.term), reviewed.item)
        index.byIdentity.set(vocabularyIdentityKey(reviewed.item), reviewed.item)
        acknowledgedReviews.push(operationId)
      }
    } else if (operation?.type === 'undo-review') {
      const reviewOperationId = String(operation?.reviewOperationId || '').trim()
      if (!reviewOperationId) continue
      const undone = await voiceVocabularyRequest(
        'POST',
        `/api/vocabulary/${encodeURIComponent(remote.id)}/review/undo`,
        { operationId: reviewOperationId },
      )
      if (undone?.item) {
        index.byId.set(undone.item.id, undone.item)
        index.byTerm.set(normalizeVocabularyTerm(undone.item.term), undone.item)
        index.byIdentity.set(vocabularyIdentityKey(undone.item), undone.item)
        acknowledgedReviews.push(operationId)
      }
    }
  }

  remotePayload = await voiceVocabularyRequest('GET', '/api/vocabulary?limit=5000&includeInactive=1')
  remoteItems = Array.isArray(remotePayload?.items) ? remotePayload.items : []
  return {
    online: true,
    items: remoteItems,
    conflicts,
    syncedKeys,
    skippedKeys,
    acknowledgedReviews,
  }
}

function startServer({ jobRunner, notificationService, settingsAccess }) {
  const terminalNotificationRoute = createTerminalNotificationRoute({
    notificationService,
  })
  let localCliToken = null
  try { localCliToken = ensureNotificationToken().token }
  catch (err) { console.warn(`[BrowserBridge] local CLI auth unavailable: ${err?.message || err}`) }

  const defaultResearchAutoClose = () => {
    try {
      return publicAppSettings(settingsAccess?.readScSettings?.() || {}).main.external_research_auto_close === true
    } catch (error) {
      console.log(`[BrowserBridge] research auto-close settings read failed: ${error?.message || error}`)
      return false
    }
  }

  const server = http.createServer(async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    let url
    try { url = new URL(req.url, `http://127.0.0.1:${PORT}`) }
    catch { return sendJson(res, 400, { error: 'bad url' }) }

    try {
      if (await terminalNotificationRoute.handle(req, res, url)) return

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, version: 1 })
      }

      // MCP-first Telegram live retrieval. Browser pages are explicitly
      // rejected: these routes can access the user's signed-in Telegram
      // account and are only for origin-less local processes (our MCP server).
      // All operations are created in the app's real job-runner, so Activity
      // receives updates and its Cancel button terminates the Python worker.
      if (url.pathname.startsWith('/telegram-live/')) {
        if (req.headers.origin) {
          return sendJson(res, 403, { ok: false, error: 'browser origins are not allowed' })
        }
        if (req.method === 'POST' && url.pathname === '/telegram-live/start') {
          const body = await readBody(req, BODY_LIMITS.telegramLive)
          try {
            const desktopId = jobRunner.startTelegramLive(body)
            return sendJson(res, 200, {
              ok: true,
              job_id: `desktop:${desktopId}`,
              desktop_job_id: desktopId,
              job: jobRunner.getJobDetail(desktopId),
            })
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: String(error?.message || error) })
          }
        }
        if (req.method === 'GET' && url.pathname === '/telegram-live/status') {
          const desktopId = telegramDesktopJobId(url.searchParams.get('id'))
          if (!desktopId) return sendJson(res, 400, { ok: false, error: 'invalid job id' })
          const job = await waitForTelegramDesktopJob(
            jobRunner,
            desktopId,
            url.searchParams.get('wait'),
          )
          if (!job) return sendJson(res, 404, { ok: false, error: 'job not found' })
          return sendJson(res, 200, {
            ok: true,
            job_id: `desktop:${desktopId}`,
            desktop_job_id: desktopId,
            job,
            result: jobRunner.getTelegramLiveResult(desktopId),
          })
        }
        if (req.method === 'POST' && url.pathname === '/telegram-live/cancel') {
          const body = await readBody(req, BODY_LIMITS.telegramLive)
          const desktopId = telegramDesktopJobId(body.job_id ?? body.id)
          if (!desktopId) return sendJson(res, 400, { ok: false, error: 'invalid job id' })
          const cancelled = jobRunner.cancelJob(desktopId, { identity: 'live' })
          return sendJson(res, 200, {
            ok: cancelled === true,
            job_id: `desktop:${desktopId}`,
            desktop_job_id: desktopId,
            job: jobRunner.getJobDetail(desktopId),
          })
        }
        if (req.method === 'POST' && url.pathname === '/telegram-live/save') {
          const body = await readBody(req, BODY_LIMITS.telegramLive)
          const chat = String(body.chat || '').trim()
          const messageIds = Array.isArray(body.message_ids)
            ? [...new Set(body.message_ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
            : []
          if (!chat || !messageIds.length) {
            return sendJson(res, 400, { ok: false, error: 'chat and message_ids are required' })
          }
          if (messageIds.length > 5000) {
            return sendJson(res, 400, { ok: false, error: 'too many message_ids (max 5000)' })
          }
          try {
            const desktopId = jobRunner.startTelegramFetch({
              target: chat,
              mode: 'id_list',
              message_ids: messageIds,
              _tg_session_override: body.session || null,
              process_voice: body.process_voice === true,
              process_photo: body.process_photo === true,
              process_docs: body.process_docs === true,
              process_polls: body.process_polls !== false,
              transcribe_engine: body.transcribe_engine || undefined,
              transcribe_lang: body.transcribe_lang || undefined,
            })
            return sendJson(res, 200, {
              ok: true,
              job_id: `desktop:${desktopId}`,
              desktop_job_id: desktopId,
              job: jobRunner.getJobDetail(desktopId),
            })
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: String(error?.message || error) })
          }
        }
      }

      if (url.pathname.startsWith('/translator/')
          || url.pathname.startsWith('/learning/')
          || url.pathname === '/vocabulary/sync'
          || url.pathname === '/yt-learning-cues') {
        const origin = req.headers.origin || ''
        if (origin && !isAllowedOrigin(origin)) {
          return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
        }
      }

      if (url.pathname === '/learning/media/library' && req.method === 'GET') {
        if (!isLearningMediaRequest(req, url)) {
          return sendJson(res, 403, { ok: false, error: 'extension origin required' })
        }
        const items = learningMediaRows(jobRunner).map(row => publicLearningMedia(row, LEARNING_MEDIA_ACCESS_TOKEN))
        return sendJson(res, 200, { ok: true, items })
      }

      const mediaSubtitlesMatch = url.pathname.match(/^\/learning\/media\/(\d+)\/subtitles$/)
      if (mediaSubtitlesMatch && req.method === 'GET') {
        if (!isLearningMediaRequest(req, url, { tokenAllowed: true })) {
          return sendJson(res, 403, { ok: false, error: 'extension origin required' })
        }
        const media = learningMediaRows(jobRunner).find(row => Number(row.item.id) === Number(mediaSubtitlesMatch[1]))
        if (!media?.subtitles) return sendJson(res, 404, { ok: false, error: 'timed subtitles are unavailable' })
        const cues = parseSrtCues(fs.readFileSync(media.subtitles.path, 'utf8'))
        if (!cues.length) return sendJson(res, 422, { ok: false, error: 'timed subtitles are empty' })
        return sendJson(res, 200, {
          ok: true,
          item: publicLearningMedia(media, LEARNING_MEDIA_ACCESS_TOKEN),
          languageCode: 'en',
          cues,
        })
      }

      const mediaVideoMatch = url.pathname.match(/^\/learning\/media\/(\d+)\/video$/)
      if (mediaVideoMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!isLearningMediaRequest(req, url, { tokenAllowed: true })) {
          return sendJson(res, 403, { ok: false, error: 'extension origin required' })
        }
        const media = learningMediaRows(jobRunner).find(row => Number(row.item.id) === Number(mediaVideoMatch[1]))
        if (!media?.video) return sendJson(res, 404, { ok: false, error: 'video is unavailable' })
        return streamLearningVideo(req, res, media.video)
      }

      const mediaDownloadMatch = url.pathname.match(/^\/learning\/media\/(\d+)\/download$/)
      if (mediaDownloadMatch && req.method === 'POST') {
        if (!isLearningMediaRequest(req, url)) {
          return sendJson(res, 403, { ok: false, error: 'extension origin required' })
        }
        const media = learningMediaRows(jobRunner).find(row => Number(row.item.id) === Number(mediaDownloadMatch[1]))
        if (!media) return sendJson(res, 404, { ok: false, error: 'Boosty video is unavailable' })
        if (media.video) return sendJson(res, 200, { ok: true, ready: true, item: publicLearningMedia(media, LEARNING_MEDIA_ACCESS_TOKEN) })
        try {
          const auth = await requestBoostyAuthCookie()
          const jobId = await jobRunner.startBoostyBatchTranscribe({
            source_id: media.item.source_id,
            video_ids: [String(media.item.external_id)],
            mode: 'download',
            save_video: true,
            authCookie: auth.value,
            authExpiration: auth.expirationDate,
          })
          console.log(`[LearningMedia] download item=${media.item.id} job=${jobId}`)
          return sendJson(res, 200, { ok: true, ready: false, jobId })
        } catch (error) {
          console.log(`[LearningMedia] download failed item=${media.item.id} error=${error?.message || error}`)
          return sendJson(res, 502, { ok: false, error: error?.message || String(error) })
        }
      }

      if (url.pathname === '/learning/media/download-status' && req.method === 'GET') {
        if (!isLearningMediaRequest(req, url)) {
          return sendJson(res, 403, { ok: false, error: 'extension origin required' })
        }
        const jobId = Number(url.searchParams.get('id'))
        const job = (jobRunner.listJobs() || []).find(item => Number(item.id) === jobId) || null
        if (!job) return sendJson(res, 404, { ok: false, error: 'download job was not found' })
        return sendJson(res, 200, {
          ok: true,
          job: {
            id: job.id,
            status: job.status,
            error: job.error || null,
            progress: job.boosty_batch?.current || null,
          },
        })
      }

      if (req.method === 'GET' && url.pathname === '/translator/status') {
        const config = translatorConfig(settingsAccess)
        return sendJson(res, 200, {
          ok: true,
          configured: !!config.key,
          region: config.region || null,
          endpoint: config.endpoint,
          provider: 'azure',
        })
      }

      if (req.method === 'POST' && url.pathname === '/translator/translate') {
        try {
          const body = await readBody(req)
          const texts = body.texts ?? body.text
          const result = await translateTexts(settingsAccess, texts, body.from || 'auto', body.to)
          const chars = result.translations.reduce((sum, item) => sum + item.source_text.length, 0)
          const cacheHits = result.translations.filter(item => item.cached).length
          console.log(`[Translator] translate items=${result.translations.length} chars=${chars} cache_hits=${cacheHits}`)
          return sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          const status = error?.code === 'translator_not_configured'
            ? 503
            : Number(error?.status) || (/required|invalid|too many|too long|too large/i.test(error?.message || '') ? 400 : 502)
          console.log(`[Translator] translate failed status=${status} code=${error?.code || 'unknown'} message=${error?.message || error}`)
          return sendJson(res, status, { ok: false, code: error?.code || 'translator_error', error: error?.message || String(error) })
        }
      }

      if (req.method === 'POST' && url.pathname === '/translator/dictionary') {
        try {
          const body = await readBody(req)
          const result = await dictionaryLookup(settingsAccess, body.text, body.from, body.to)
          console.log(`[Translator] dictionary chars=${String(body.text || '').length} cache_hit=${result.cached === true}`)
          return sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          const status = error?.code === 'translator_not_configured'
            ? 503
            : Number(error?.status) || (/required|invalid|must contain/i.test(error?.message || '') ? 400 : 502)
          console.log(`[Translator] dictionary failed status=${status} code=${error?.code || 'unknown'} message=${error?.message || error}`)
          return sendJson(res, status, { ok: false, code: error?.code || 'translator_error', error: error?.message || String(error) })
        }
      }

      if (req.method === 'POST' && url.pathname === '/translator/examples') {
        try {
          const body = await readBody(req)
          const result = await dictionaryExamples(settingsAccess, body.pairs, body.from, body.to)
          const count = result.examples.reduce((sum, item) => sum + (Array.isArray(item?.examples) ? item.examples.length : 0), 0)
          console.log(`[Translator] dictionary examples pairs=${result.examples.length} examples=${count} cache_hit=${result.cached === true}`)
          return sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          const status = error?.code === 'translator_not_configured'
            ? 503
            : Number(error?.status) || (/required|invalid|too many|must contain/i.test(error?.message || '') ? 400 : 502)
          console.log(`[Translator] dictionary examples failed status=${status} code=${error?.code || 'unknown'} message=${error?.message || error}`)
          return sendJson(res, status, { ok: false, code: error?.code || 'translator_error', error: error?.message || String(error) })
        }
      }

      if (url.pathname === '/learning/entry' && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const result = db()?.upsertLearningEntry(body)
          if (!result?.entry) throw new Error('learning database is unavailable')
          console.log(`[Learning] upsert kind=${result.entry.kind} state=${result.entry.state} entry=${result.entry.id} examples=${result.examples_count}`)
          return sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          console.log(`[Learning] upsert failed: ${error?.message || error}`)
          return sendJson(res, 400, { ok: false, error: error?.message || String(error) })
        }
      }

      if (url.pathname === '/learning/entry' && req.method === 'GET') {
        const entry = db()?.getLearningEntry({
          kind: url.searchParams.get('kind') || 'word',
          sourceLang: url.searchParams.get('from') || 'auto',
          targetLang: url.searchParams.get('to') || '',
          normalizedText: url.searchParams.get('text') || '',
        })
        const examples = entry ? db()?.listLearningExamples(entry.id, 30) || [] : []
        return sendJson(res, 200, { ok: true, entry: entry || null, examples })
      }

      if (url.pathname === '/learning/entries' && req.method === 'GET') {
        const entries = db()?.listLearningEntries(5000) || []
        return sendJson(res, 200, { ok: true, entries })
      }

      if (url.pathname === '/learning/explain' && req.method === 'POST') {
        try {
          const result = await learningWordExplanation(await readBody(req))
          console.log(`[Learning] explanation model=${result.model} cached=${result.cached === true} chars=${result.explanation.length}`)
          return sendJson(res, 200, { ok: true, online: true, ...result })
        } catch (error) {
          if (error?.code === 'voice_record_offline') {
            console.log(`[Learning] explanation offline reason=${error?.message || error}`)
            return sendJson(res, 200, {
              ok: true,
              online: false,
              explanation: '',
              error: error?.message || String(error),
            })
          }
          console.log(`[Learning] explanation failed: ${error?.message || error}`)
          return sendJson(res, Number(error?.status) || 502, { ok: false, error: error?.message || String(error) })
        }
      }

      if (url.pathname === '/learning/expression' && req.method === 'POST') {
        try {
          const result = await learningExpressionClassification(await readBody(req))
          console.log(`[Learning] expression type=${result.expressionType || 'none'} cached=${result.cached === true}`)
          return sendJson(res, 200, { ok: true, online: true, ...result })
        } catch (error) {
          if (error?.code === 'voice_record_offline') {
            console.log(`[Learning] expression offline reason=${error?.message || error}`)
            return sendJson(res, 200, {
              ok: true,
              online: false,
              eligible: false,
              expressionType: '',
              error: error?.message || String(error),
            })
          }
          console.log(`[Learning] expression failed: ${error?.message || error}`)
          return sendJson(res, Number(error?.status) || 502, { ok: false, error: error?.message || String(error) })
        }
      }

      if (url.pathname === '/learning/practice' && req.method === 'POST') {
        try {
          const body = await readBody(req, BODY_LIMITS.vocabularyPractice)
          const result = await vocabularyPracticeTurn(body)
          console.log(`[Learning] practice action=${body?.action === 'start' ? 'start' : 'turn'} vocabulary=${Array.isArray(body?.vocabulary) ? body.vocabulary.length : 0} history=${Array.isArray(body?.history) ? body.history.length : 0}`)
          return sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          if (error?.code === 'voice_record_offline') {
            console.log(`[Learning] practice offline reason=${error?.message || error}`)
            return sendJson(res, 200, { ok: true, online: false, error: error?.message || String(error) })
          }
          console.log(`[Learning] practice failed: ${error?.message || error}`)
          return sendJson(res, Number(error?.status) || 400, { ok: false, error: error?.message || String(error) })
        }
      }

      if (url.pathname === '/learning/literal' && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const result = await learningLiteralTranslation(body)
          console.log(`[Learning] literal source_chars=${String(body?.sourceText || body?.text || '').length} alignments=${result.alignments.length} cache_hit=${result.cached === true}`)
          return sendJson(res, 200, { ok: true, online: true, ...result })
        } catch (error) {
          if (error?.code === 'voice_record_offline') {
            console.log(`[Learning] literal offline reason=${error?.message || error}`)
            return sendJson(res, 200, { ok: true, online: false, error: error?.message || String(error) })
          }
          console.log(`[Learning] literal failed: ${error?.message || error}`)
          return sendJson(res, Number(error?.status) || 502, { ok: false, error: error?.message || String(error) })
        }
      }

      if (url.pathname === '/learning/selection' && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const text = String(body?.text || '').replace(/\s+/g, ' ').trim().slice(0, 5000)
          const word = String(body?.word || '').replace(/\s+/g, ' ').trim().slice(0, 160)
          const context = String(body?.context || '').replace(/\s+/g, ' ').trim().slice(0, 5000)
          const result = await voiceVocabularyRequest('POST', '/api/desktop/learning-selection', {
            text,
            word,
            context,
            sourceName: String(body?.sourceName || 'YouTube subtitles').trim().slice(0, 120),
            pageUrl: String(body?.pageUrl || '').trim().slice(0, 2000),
            videoId: String(body?.videoId || '').trim().slice(0, 32),
            cueStartMs: Number.isFinite(Number(body?.cueStartMs)) ? Math.max(0, Math.round(Number(body.cueStartMs))) : null,
          })
          console.log(`[Learning] selection handoff armed=${result?.armed === true} chars=${text.length} word=${word ? 1 : 0} context=${context.length}`)
          return sendJson(res, 200, { ok: true, online: true, armed: result?.armed === true })
        } catch (error) {
          if (error?.code === 'voice_record_offline') {
            console.log(`[Learning] selection handoff offline reason=${error?.message || error}`)
            return sendJson(res, 200, { ok: true, online: false, armed: false, error: error?.message || String(error) })
          }
          console.log(`[Learning] selection handoff failed: ${error?.message || error}`)
          return sendJson(res, Number(error?.status) || 502, { ok: false, error: error?.message || String(error) })
        }
      }

      if (url.pathname === '/vocabulary/sync' && req.method === 'POST') {
        try {
          const body = await readBody(req, BODY_LIMITS.vocabularySync)
          const result = await syncVocabularyWithVoice(body)
          console.log(`[Vocabulary] sync online entries=${result.items.length} pushed=${result.syncedKeys.length} reviews=${result.acknowledgedReviews.length} conflicts=${result.conflicts.length}`)
          return sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          if (error?.code === 'voice_record_offline') {
            console.log(`[Vocabulary] sync offline reason=${error?.message || error}`)
            return sendJson(res, 200, {
              ok: true,
              online: false,
              items: [],
              conflicts: [],
              syncedKeys: [],
              skippedKeys: [],
              acknowledgedReviews: [],
              error: error?.message || String(error),
            })
          }
          console.log(`[Vocabulary] sync failed: ${error?.message || error}`)
          return sendJson(res, Number(error?.status) || 502, {
            ok: false,
            error: error?.message || String(error),
          })
        }
      }

      if (req.method === 'POST' && url.pathname === '/yt-learning-cues') {
        try {
          const body = await readBody(req)
          const videoId = String(body.videoId || '').trim()
          const targetUrl = String(body.url || '').trim()
          if (!/^[0-9A-Za-z_-]{11}$/.test(videoId)) throw new Error('invalid YouTube video id')
          if (!/^https?:\/\/(www\.|m\.)?youtube\.com\/watch\?v=/.test(targetUrl)) {
            throw new Error('invalid YouTube watch URL')
          }
          const lang = cleanLanguageCode(body.lang || 'en')
          const cached = jobRunner.lookupYoutubeCache(videoId)
          const result = await jobRunner.createYoutubeTimedTranscript({
            url: targetUrl,
            lang,
            title: String(body.title || '').trim().slice(0, 300),
            sourceFilePath: cached?.file_path || null,
          })
          if (!result?.ok || !result.file_path) {
            return sendJson(res, 404, { ok: false, error: result?.error || 'timestamped subtitles are unavailable' })
          }
          const text = safeReadFile(result.file_path, 8 * 1024 * 1024)
          if (text == null) throw new Error('timestamped subtitle file is not readable')
          const cues = parseTimestampedTranscript(text)
          if (!cues.length) throw new Error('timestamped subtitle file has no cues')
          console.log(`[Learning] timed cues video=${videoId} lang=${lang} cues=${cues.length} cached=${result.cached === true}`)
          return sendJson(res, 200, {
            ok: true,
            video_id: videoId,
            language: lang,
            cues,
            cached: result.cached === true,
          })
        } catch (error) {
          console.log(`[Learning] timed cues failed: ${error?.message || error}`)
          return sendJson(res, 400, { ok: false, error: error?.message || String(error) })
        }
      }

      // Authenticated local CLI handoff. This lets `sc boosty-all` coexist
      // with a running desktop that already owns port 53127. The cookie still
      // exists only for this request and is never logged or persisted.
      if (req.method === 'POST' && url.pathname === '/boosty-auth-request') {
        if (req.headers.origin) return sendJson(res, 403, { ok: false, error: 'browser origins are not allowed' })
        if (!localCliToken || !matchesBearerToken(req.headers.authorization, localCliToken)) {
          return sendJson(res, 401, { ok: false, error: 'invalid local credentials' })
        }
        const auth = await requestBoostyAuthCookie({ timeoutMs: 20_000 })
        return sendJson(res, 200, { ok: true, auth })
      }

      // One-shot cookie response from the installed extension. The cookie is
      // resolved directly to the waiting IPC request and is not retained in
      // bridge state after that. Never include its value in logs/responses.
      if (req.method === 'POST' && url.pathname === '/boosty-auth-state') {
        if (!isExtensionSettingsRequest(req)) {
          console.warn('[BrowserBridge] Boosty auth response rejected: extension origin required')
          return sendJson(res, 403, { ok: false, error: 'extension origin required' })
        }
        const body = await readBody(req)
        const requestId = String(body.requestId || '')
        const pending = BOOSTY_AUTH_REQUESTS.get(requestId)
        if (!pending) return sendJson(res, 404, { ok: false, error: 'request expired' })
        BOOSTY_AUTH_REQUESTS.delete(requestId)
        clearTimeout(pending.timer)
        const value = typeof body.auth?.value === 'string' ? body.auth.value : ''
        if (!value) {
          pending.reject(new Error(body.error || 'В браузере нет активной авторизации Boosty. Войдите в Boosty и повторите.'))
          console.log(`[BrowserBridge] Boosty auth missing id=${requestId.slice(0, 8)}`)
        } else {
          pending.resolve({ value, expirationDate: body.auth.expirationDate || null })
          console.log(`[BrowserBridge] Boosty auth received id=${requestId.slice(0, 8)}`)
        }
        return sendJson(res, 200, { ok: true })
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
            'english-lexeme.js', 'youtube-learning-utils.js', 'learning-store.js', 'youtube-learning.js', 'youtube-main-bridge.js',
            'study/index.html', 'study/study.js', 'study/study.css',
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
        const options = withResearchAutoClose(body.options, defaultResearchAutoClose())
        const job = researchState.create({ provider, prompt, options })
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
        const options = withResearchAutoClose(body.options, defaultResearchAutoClose())

        // ── AI Studio (Gemini) provider ──────────────────────────────
        // Раньше запускался через MCP-tool aistudio_run (browser-MCP). Теперь
        // — тот же HTTP-канал что claude/perplexity. SW-логика (резолв модели,
        // открытие вкладки ?sc-mcp-job=, debugger-attach) переиспользуется как
        // была — мы лишь дёргаем mcp_aistudio_start через sendToExtension.
        // Состояние живёт в AISTUDIO_JOBS (CS PATCH'ит через /aistudio-state),
        // jobId имеет префикс aim_ — по нему /research-status роутит в нужный store.
        if (body.provider === 'aistudio' || body.provider === 'gemini') {
          const opts = options
          try {
            const extResp = await sendToExtension('mcp_aistudio_start', {
              prompt,
              model: opts.model || body.model,
              systemInstruction: opts.systemInstruction || body.systemInstruction,
              reuse_tab: opts.reuse_tab,
              focus: opts.focus,
              keepTab: opts.autoClose === false,
            }, 20000)
            if (!extResp || extResp.success === false) {
              return sendJson(res, 200, { error: extResp?.error || 'aistudio start failed', provider: 'aistudio' })
            }
            const now = Date.now()
            const previous = AISTUDIO_JOBS.get(extResp.jobId) || { jobId: extResp.jobId, createdAt: now }
            AISTUDIO_JOBS.set(extResp.jobId, {
              ...previous,
              provider: 'aistudio',
              modelId: extResp.modelId,
              modelTitle: extResp.modelTitle,
              status: previous.status || 'pending',
              stage: previous.stage || 'boot',
              keepTab: opts.autoClose === false,
              updatedAt: now,
            })
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
        const rawAttachments = Array.isArray(body.attachments)
          ? body.attachments
          : (Array.isArray(body.files) ? body.files : [])
        if (rawAttachments.length && provider !== 'chatgpt') {
          return sendJson(res, 400, { error: 'attachments are currently supported only for provider=chatgpt' })
        }
        // Browser origins never get to name arbitrary local paths. Research
        // with files is a local CLI/main-process capability; ChatGPT's page
        // only reads already materialized bytes for its own job id.
        if (rawAttachments.length && req.headers.origin) {
          return sendJson(res, 403, { error: 'local file attachments require a local origin-less request' })
        }
        let attachments
        try {
          attachments = normalizeResearchAttachments(rawAttachments)
        } catch (error) {
          return sendJson(res, 400, { error: String(error?.message || error) })
        }
        const hasDocuments = attachments.some(attachment => attachment.kind !== 'image')
        if (hasDocuments && options.mode == null) options.mode = 'chat'
        if (hasDocuments && options.mode !== 'chat') {
          return sendJson(res, 400, { error: 'document attachments are currently supported only in Chat mode; Work image uploads remain supported' })
        }
        const conversationUrl = body.conversationUrl || body.continueUrl || body.url || body.options?.conversationUrl || ''
        const chatgptConversationUrl = provider === 'chatgpt' && conversationUrl
          ? normalizeChatgptConversationUrl(conversationUrl)
          : ''
        const job = researchState.create({ provider, prompt, options, attachments })
        if (attachments.length) {
          try {
            const materialized = materializeResearchAttachments({
              libRoot: jobRunner.LIB_ROOT || path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop'),
              id: job.id,
              attachments,
            })
            researchState.update(job.id, { attachments: materialized })
          } catch (error) {
            researchState.update(job.id, { status: 'error', stage: 'attachment_validation', error: String(error?.message || error) })
            return sendJson(res, 400, { error: String(error?.message || error) })
          }
        }
        // chatgpt: query + дубль в hash — SPA срезает query на pushState,
        // hash страхует ре-инжект CS до того как window.name установлен.
        const targetUrl = provider === 'perplexity'
          ? `https://www.perplexity.ai/?sc-research=${encodeURIComponent(job.id)}`
          : provider === 'chatgpt'
            ? chatgptResearchEntryUrl({
              id: job.id,
              mode: options.mode,
              conversationUrl: chatgptConversationUrl,
            })
            : `https://claude.ai/new#sc-research=${encodeURIComponent(job.id)}`
        if (chatgptConversationUrl) researchState.update(job.id, { url: chatgptConversationUrl, title: null })
        console.log(`[BrowserBridge] research-start id=${job.id} provider=${provider} prompt-len=${prompt.length} attachments=${researchState.get(job.id)?.attachments?.length || 0}/${attachments.length} continue=${chatgptConversationUrl ? 1 : 0}`)
        const open = await reconcileResearchTabOpen({
          openTab: () => sendToExtension('mcp_open_research_tab', { url: targetUrl }, 15000),
          findTab: () => sendToExtension('mcp_find_research_tab', { url: targetUrl }, 10000),
          getSnapshot: () => researchState.get(job.id),
          delay: () => new Promise(resolve => setTimeout(resolve, 350)),
        })
        // tabId в job СРАЗУ после обычного ACK или reconcile. Без него ручное
        // закрытие не сможет перевести зависший job через tab-closed fallback.
        if (open.tabId != null) researchState.update(job.id, { tabId: open.tabId })
        const liveJob = researchState.get(job.id) || job
        if (open.openState === 'failed') {
          console.log(`[BrowserBridge] research-start id=${job.id} OPEN_TAB_FAILED ${open.openError}`)
        } else if (open.openState !== 'opened') {
          console.log(`[BrowserBridge] research-start id=${job.id} OPEN_ACK_RECONCILED state=${open.openState} tabId=${open.tabId ?? '-'} warning=${open.openWarning || '-'}`)
        } else {
          console.log(`[BrowserBridge] research-start id=${job.id} tab opened tabId=${open.tabId}`)
        }
        return sendJson(res, 200, {
          id: job.id,
          provider,
          tabId: open.tabId,
          url: targetUrl,
          status: liveJob.status,
          openState: open.openState,
          ...(open.openWarning ? { openWarning: open.openWarning } : {}),
          ...(open.openError ? { openError: open.openError } : {}),
        })
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
          if (!st.isFile() || st.size !== att.size || st.size > MAX_ATTACHMENT_BYTES) {
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
        const logId = body.id && body.id !== '-'
          ? body.id
          : (researchIdFromUrl(body.url || body.data?.url) || '-')
        const tag = String(body.tag || 'unknown').slice(0, 80)
        const tabId = body.tabId != null ? body.tabId : '-'
        const pageUrl = String(body.url || '').slice(0, 160)
        const payload = body.data ? JSON.stringify(body.data).slice(0, 400) : ''
        console.log(`[BrowserBridge] research-log id=${String(logId).slice(0,12)} tabId=${tabId} tag=${tag} url=${pageUrl} ${payload}`)
        // `cs.boot` может прийти раньше ACK команды open-tab. URL уже несёт
        // стабильный sc-research id, поэтому это независимое доказательство
        // совершившегося side effect и источник настоящего tabId.
        if (logId !== '-' && typeof body.tabId === 'number') {
          const current = researchState.get(logId)
          if (current && current.tabId !== body.tabId) {
            researchState.update(logId, { tabId: body.tabId })
            console.log(`[BrowserBridge] research id=${logId} tab reconciled from ${tag} tabId=${body.tabId}`)
          }
        }
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
        const summary = url.searchParams.get('summary') === '1'
        const jobId = url.searchParams.get('id') || null
        return sendJson(res, 200, { jobs: listExternalJobsForUi({ summary, jobId }) })
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
        capBridgeCommandQueue()
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
          capBridgeCommandQueue()
          return sendJson(res, 200, { ok: true, queued: true })
        }
      }
      // Force-reload расширения по запросу (когда hot-reload poll ещё не
      // увидел свежий mtime и нужно применить код прямо сейчас, без manual ⟳
      // в chrome://extensions/). Команда `reload_extension` обрабатывается
      // расширением через тот же bridge-commands poll.
      if (req.method === 'POST' && url.pathname === '/reload-extension') {
        BRIDGE_COMMAND_QUEUE.push({ cmd: 'reload_extension', ts: Date.now() })
        capBridgeCommandQueue()
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
          researchState.remove(body.id)
          db()?.deleteResearchJob(body.id)
          invalidateResearchHistoryCache()
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
          'chatgpt-entry-url.js', 'tab-placement.js', 'pill-event-guard.js', 'research-tab-policy.js', 'research-tab-registry.js',
          'english-lexeme.js', 'youtube-learning-utils.js', 'learning-store.js', 'youtube-learning.js', 'youtube-main-bridge.js',
          'study/index.html', 'study/study.js', 'study/study.css',
          'mcp-window-model.js',
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

module.exports = {
  startServer,
  requestBoostyAuthCookie,
  listExternalJobsForUi,
  externalJobSummary,
  invalidateResearchHistoryCache,
  PORT,
  RELOAD_WS_PORT,
  // Kept non-public to the renderer/extension. Integration tests use the
  // same code path without binding the fixed bridge port.
  __test: {
    translatorConfig,
    azureTranslatorRequest,
    translateTexts,
    dictionaryLookup,
    dictionaryExamples,
    sanitizeDictionaryExamplePairs,
    translatorCacheKey,
    normalizeLearningExplanationPayload,
    learningExplanationCacheKey,
    normalizeLearningExplanationResult,
    normalizeLearningExpressionPayload,
    learningExpressionCacheKey,
    normalizeLearningExpressionResult,
    normalizeLearningLiteralPayload,
    learningLiteralCacheKey,
    normalizeLiteralAlignments,
    normalizeVocabularyPracticeRequest,
    parseTimestampedTranscript,
    parseSrtCues,
    parseByteRange,
    normalizeVocabularyTerm,
    vocabularySyncPayload,
  },
}
