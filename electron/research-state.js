// In-memory state for Deep Research jobs (claude.ai / perplexity.ai).
//
// Job lifecycle:
//   queued       MCP вызвал deep_research_start, requestId создан, content-script
//                ещё не открыл вкладку (или открыл но не дошёл до prompt).
//   running      Prompt отправлен, идёт research (Send→Stop).
//   done         Stop→Send (детектор завершения). result содержит url, title,
//                опционально текст ответа.
//   error        Что-то пошло не так (selector не найден, нет логина и т.п.).
//
// Хранится строго в RAM. Если sc-desktop рестартует — job пропадает; это
// приемлемо, потому что research всё равно занимает <30 мин и юзер обычно
// в это время с расширением. Расширение независимо запоминает job в своём
// chrome.storage.local, так что после рестарта sc-desktop расширение
// досматривает и может позже отдать результат через POST /research-state
// — но пока bridge о job'е не знает, никто не лонг-полит этот id.
//
// EventEmitter: `events.on('change', job)` срабатывает на любое изменение
// одного job'а. Long-poll endpoint подписывается и отдаёт snapshot когда
// что-то поменялось.

const { EventEmitter } = require('node:events')
const path = require('node:path')
const os = require('node:os')

const jobs = new Map() // requestId → job snapshot
const events = new EventEmitter()
events.setMaxListeners(0) // long-poll может висеть многими параллельно

const LIB_ROOT = process.env.SC_DESKTOP_DIR
  || process.env.MEDIA_INBOX_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop')

function nowMs() { return Date.now() }

function newRequestId() {
  return 'r' + Math.random().toString(36).slice(2, 10) + nowMs().toString(36)
}

// Job-шейп держим плоским и сериализуемым (отдаём наружу как JSON).
// Каждый POST /research-state мерджит свои поля через update().
function create({ provider, prompt, options, attachments }) {
  const id = newRequestId()
  const job = {
    id,
    provider,        // 'claude' | 'perplexity'
    prompt,          // raw prompt (не показываем наружу через MCP — это input)
    options: options || {},
    attachments: Array.isArray(attachments) ? attachments : [],
    status: 'queued', // queued|running|done|error
    stage: null,      // 'opening'|'configuring'|'submitting'|'running'|'extracting'|null
    url: null,        // claude.ai/chat/<uuid> или perplexity.ai/search/<uuid>
    title: null,
    tabId: null,
    error: null,
    result: null,     // { text?, url, title } когда done
    createdAt: nowMs(),
    updatedAt: nowMs(),
    doneAt: null,
  }
  jobs.set(id, job)
  events.emit('change', job)
  return job
}

function get(id) { return jobs.get(id) || null }

function remove(id) {
  const existed = jobs.delete(id)
  if (existed) events.emit('change', { id, removed: true })
  return existed
}

// Найти active research по tabId. Используется CS recovery'м, когда страница
// перезагрузилась без hash и без window.name (crash-restore, discard и т.п.):
// CS у нас под рукой только tabId (через sender в SW), и hash был сброшен
// при первом chat-redirect'е, а window.name перестал переживать reload.
// Возвращаем самый свежий running job, привязанный к этому tabId, либо null.
function findByTabId(tabId) {
  if (tabId == null) return null
  let best = null
  for (const job of jobs.values()) {
    if (job.tabId !== tabId) continue
    if (job.status !== 'running') continue
    if (!best || job.updatedAt > best.updatedAt) best = job
  }
  return best
}

// Re-create job под уже существующим id — используется когда bridge
// рестартовал посреди research'а, а content-script продолжает слать
// /research-state. Без re-create CS получает 404 и теряет связь, хотя
// research живёт в браузерной вкладке. Stub'ом ставим минимум данных:
// provider от CS, prompt пустой (orig потерян), status='running'.
function recreate({ id, provider, options }) {
  if (jobs.has(id)) return jobs.get(id)
  const job = {
    id,
    provider: ['perplexity', 'chatgpt'].includes(provider) ? provider : 'claude',
    prompt: '',                // оригинал потерян, CS уже отработал submit
    options: options || {},
    attachments: [],
    status: 'running',
    stage: 'recovered',
    url: null,
    title: null,
    tabId: null,
    error: null,
    result: null,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    doneAt: null,
    recovered: true,           // флаг для дебага — этот job создан не через /research-create
  }
  jobs.set(id, job)
  events.emit('change', job)
  return job
}

function update(id, patch) {
  const cur = jobs.get(id)
  if (!cur) return null
  const merged = { ...cur, ...patch, updatedAt: nowMs() }
  if (merged.status === 'done' || merged.status === 'error') {
    merged.doneAt = merged.doneAt || nowMs()
  }
  jobs.set(id, merged)
  events.emit('change', merged)
  return merged
}

// Подписка на изменения. Возвращает unsubscribe. Та же форма что
// `jobRunner.subscribe` в существующем коде — long-poll handler одинаков.
function subscribe(fn) {
  const wrapped = (job) => { try { fn(job) } catch (_) {} }
  events.on('change', wrapped)
  return () => events.off('change', wrapped)
}

// Снапшот для MCP-ответа: prompt и options не отдаём (это input).
function publicSnapshot(job) {
  if (!job) return null
  return {
    id: job.id,
    provider: job.provider,
    status: job.status,
    stage: job.stage,
    tabId: job.tabId,
    url: job.url,
    title: job.title,
    error: job.error,
    result: job.result,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    doneAt: job.doneAt,
  }
}

// Список всех research-job'ов для UI-попапа «Запущенные MCP». В отличие от
// publicSnapshot (MCP-ответ, prompt скрыт) — это локальный renderer, поэтому
// отдаём promptHead (короткую шапку) для отображения. Нормализуем в shape,
// близкий к aistudio-job'у, + discriminator kind:'research'.
function listAllForUi() {
  const out = []
  for (const j of jobs.values()) {
    const r = j.result || {}
    const text = typeof r.text === 'string' ? r.text : ''
    const sources = normalizeSources(r)
    const sourcesMeta = normalizeSourcesMeta(r)
    const answerText = normalizeAnswerText(r, text)
    const reasoningText = normalizeReasoningText(r, sourcesMeta)
    const images = normalizeImageArray(r.images, 'output')
    const inputImages = normalizeInputImagesFromAttachments(j.attachments)
    const inputFiles = normalizeInputFilesFromAttachments(j.attachments)
    // elapsed: от старта до done (или до now если ещё бежит).
    const endTs = j.doneAt || Date.now()
    const elapsedSec = j.createdAt ? Math.max(0, Math.round((endTs - j.createdAt) / 1000)) : null
    // Модель: для perplexity — из options.model (что юзер выбрал), для chatgpt —
    // модель + уровень интеллекта, для claude — модель/effort из
    // options («opus-4.8 · max · Research») либо просто Research если авто.
    const modelLabel = j.provider === 'perplexity'
      ? (j.options?.model ? String(j.options.model) : 'default')
      : j.provider === 'chatgpt'
        ? chatgptModelLabel(j.options)
        : claudeModelLabel(j.options)
    out.push({
      kind: 'research',
      jobId: j.id,
      provider: j.provider,                       // 'claude' | 'perplexity' | 'chatgpt'
      modelId: modelLabel,                        // для UI-полей Model (раньше было пусто)
      mode: j.options?.mode || (j.provider === 'perplexity' ? 'deep' : null),
      status: j.status,                           // queued|running|done|error
      stage: j.stage,
      tabId: j.tabId,
      url: j.url,                                 // ссылка на чат в браузере
      title: j.title,
      promptHead: (j.prompt || '').slice(0, 140),
      fullPrompt: j.prompt || '',                 // полный промпт для detail-экрана
      responseText: text || null,                 // полный ответ
      responseHead: text ? text.slice(0, 600) : null,
      responseTextLen: text ? text.length : null,
      answerText: answerText || null,             // чистый ответ без источников
      answerHead: answerText ? answerText.slice(0, 600) : null,
      reasoningText: reasoningText || null,       // видимый thinking-summary ChatGPT
      images,
      inputImages,
      inputFiles,
      imageCount: images.length,
      sources,
      sourcesMeta,
      linkCount: sources.length || (r.linkCount ?? null),
      textKind: r.text_kind || null,
      isResearch: r.is_research,
      elapsedSec,
      error: j.error,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      doneAt: j.doneAt,
    })
  }
  return out
}

function normalizeSources(result) {
  const arr = Array.isArray(result?.sources)
    ? result.sources
    : Array.isArray(result?.links)
      ? result.links
      : []
  return arr
    .map((s) => ({
      url: typeof s?.url === 'string' ? s.url : (typeof s?.href === 'string' ? s.href : ''),
      title: typeof s?.title === 'string' ? s.title : '',
    }))
    .filter((s) => s.url)
}

function normalizeSourcesMeta(result) {
  return result?.sources_meta && typeof result.sources_meta === 'object'
    ? result.sources_meta
    : null
}

function normalizeAnswerText(result, fallbackText = '') {
  if (typeof result?.answer_text === 'string' && result.answer_text.trim()) return result.answer_text
  if (typeof result?.answerText === 'string' && result.answerText.trim()) return result.answerText
  return stripEmbeddedSources(fallbackText)
}

function normalizeReasoningText(result, sourcesMeta) {
  const direct = typeof result?.reasoning_text === 'string'
    ? result.reasoning_text
    : typeof result?.thinking_text === 'string'
      ? result.thinking_text
      : typeof sourcesMeta?.thinking_text === 'string'
        ? sourcesMeta.thinking_text
        : ''
  return direct.trim()
}

function normalizeInputImagesFromAttachments(attachments) {
  if (!Array.isArray(attachments)) return []
  return normalizeImageArray(attachments
    .filter((a) => String(a?.mime || '').startsWith('image/'))
    .map((a) => ({
    file_path: a?.path,
    name: a?.name,
    content_type: a?.mime,
    bytes: a?.size,
  })), 'input')
}

function normalizeInputFilesFromAttachments(attachments) {
  if (!Array.isArray(attachments)) return []
  return attachments
    .filter((a) => a?.path && !String(a?.mime || '').startsWith('image/'))
    .map((a, i) => ({
      role: 'input',
      index: Number.isFinite(a?.index) ? a.index : i,
      name: a?.name || path.basename(a.path),
      filePath: a.path,
      contentType: a?.mime || null,
      bytes: Number.isFinite(a?.size) ? a.size : null,
      lineStart: Number.isFinite(a?.line_start) ? a.line_start : null,
      lineEnd: Number.isFinite(a?.line_end) ? a.line_end : null,
      sourceLineCount: Number.isFinite(a?.source_line_count) ? a.source_line_count : null,
      bundledCount: Number.isFinite(a?.bundled_count) ? a.bundled_count : null,
    }))
}

function normalizeImageArray(raw, role) {
  const arr = Array.isArray(raw) ? raw : []
  return arr
    .map((it, i) => {
      const filePath = typeof it?.file_path === 'string' ? it.file_path
        : typeof it?.filePath === 'string' ? it.filePath
          : typeof it?.path === 'string' ? it.path
            : ''
      const name = typeof it?.name === 'string' && it.name
        ? it.name
        : (filePath ? path.basename(filePath) : `image-${i + 1}`)
      const assetUrl = assetUrlForFile(filePath)
      return {
        role,
        index: Number.isFinite(it?.index) ? it.index : i,
        name,
        filePath: filePath || null,
        assetUrl,
        contentType: it?.content_type || it?.contentType || it?.mime || null,
        bytes: Number.isFinite(it?.bytes) ? it.bytes : (Number.isFinite(it?.size) ? it.size : null),
        width: Number.isFinite(it?.width) ? it.width : null,
        height: Number.isFinite(it?.height) ? it.height : null,
      }
    })
    .filter((img) => img.assetUrl || img.filePath)
}

function assetUrlForFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return ''
  const abs = path.resolve(filePath)
  const rel = path.relative(LIB_ROOT, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
  return `sc-asset://${rel.split(path.sep).join('/')}`
}

function stripEmbeddedSources(text) {
  if (!text) return ''
  return String(text).split(/\n{2,}---\n(?:Источники|Sources)\s*\(\d+\):\n/i)[0].trim()
}

// Tab-closed fallback: юзер вручную закрыл research-вкладку → все её
// non-terminal jobs переводим в error с явной причиной. Без этого зомби-job
// висит в «Запущенные MCP» 30+ минут (реальный кейс: CS не стартовал из-за
// LNA, вкладка закрыта руками, job вечно queued). Terminal jobs НЕ трогаем:
// auto-close вкладки после done тоже даёт onRemoved — done перезаписывать нельзя.
function failAllByTabId(tabId, reason) {
  if (tabId == null) return []
  const failed = []
  for (const job of jobs.values()) {
    if (job.tabId !== tabId) continue
    if (job.status === 'done' || job.status === 'error') continue
    update(job.id, {
      status: 'error',
      stage: 'tab_closed',
      error: reason || 'Вкладка браузера закрыта — research остановлен',
    })
    failed.push(job.id)
  }
  return failed
}

// Лейбл claude-джобы из options: «opus-4.8 · max · Research» / «fable-5 · Chat» /
// «Research» (авто — модель не задавали). Используется и в listAllForUi, и в
// persistResearchJob (browser-bridge) — единый формат для попапа и Истории.
function claudeModelLabel(options) {
  const o = options || {}
  const research = o.research !== false
  if (!o.model) return research ? 'Research' : 'Chat'
  const parts = [String(o.model)]
  if (o.effort) parts.push(String(o.effort))
  if (o.thinking === false) parts.push('no-think')
  parts.push(research ? 'Research' : 'Chat')
  return parts.join(' · ')
}

function chatgptModelLabel(options) {
  const model = String(options?.model || '5.6-sol')
  const labels = {
    '5.5': 'GPT-5.5 Instant',
    '5.6': 'GPT-5.6 Sol',
    '5.6-sol': 'GPT-5.6 Sol',
    '5.6-terra': 'GPT-5.6 Terra',
    '5.6-luna': 'GPT-5.6 Luna',
    'o3': 'o3',
  }
  const modelLabel = labels[model] || (/^\d/.test(model) ? `GPT-${model}` : model)
  const parts = [modelLabel, options?.effort || (model === 'o3' ? 'medium' : 'xhigh')]
  if (options?.mode === 'work') parts.push(options?.speed === 'fast' ? 'fast' : 'standard')
  return parts.join(' · ')
}

// Очистка старья: research занимает <30 мин, но на дебаг (зависшие jobs)
// держим 24h чтобы post-mortem из логов можно было сверить с RAM-state'ом.
// После — drop. На каждый GC sweep логируем кого выкинули и кого оставили.
const RETENTION_MS = 24 * 60 * 60 * 1000
function gc() {
  const cutoff = nowMs() - RETENTION_MS
  const evicted = []
  const remaining = []
  for (const [id, j] of jobs) {
    if (j.updatedAt < cutoff) {
      jobs.delete(id)
      evicted.push(`${id.slice(0, 8)}:${j.status}/${j.stage || '-'}/${Math.round((nowMs() - j.updatedAt) / 60000)}min`)
    } else {
      remaining.push(`${id.slice(0, 8)}:${j.status}/${j.stage || '-'}/${Math.round((nowMs() - j.updatedAt) / 60000)}min`)
    }
  }
  if (evicted.length || remaining.length) {
    console.log(`[ResearchState] GC sweep evicted=${evicted.length} remaining=${remaining.length} [evicted: ${evicted.join(', ') || 'none'}] [remaining: ${remaining.join(', ') || 'none'}]`)
  }
}
setInterval(gc, 5 * 60 * 1000).unref?.()

module.exports = { create, recreate, get, remove, findByTabId, failAllByTabId, update, subscribe, publicSnapshot, listAllForUi, newRequestId, claudeModelLabel, chatgptModelLabel }
