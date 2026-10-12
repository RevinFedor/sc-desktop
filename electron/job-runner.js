// Spawns Python CLI scripts and streams ndjson events to listeners.
// On completion the full item list is written to a JSON file inside the
// library directory so the user can re-open / copy / inspect it later.

const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const readline = require('node:readline')
const { randomUUID } = require('node:crypto')
const crypto = require('node:crypto')
let electronApp = null
try {
  electronApp = require('electron').app || null
} catch {
  electronApp = null
}
const db = require('./database')
const dbRead = require('./database-read-client')
const { formatCommentsBlock } = require('./assemble')
const {
  finalizeTelegramJob,
  finalizeCatalogJob,
  syncTelegramFolder,
  pruneTelegramFolders,
  applyTelegramReplyUpdates,
  persistItemMutation,
  finalizeBatchJob,
} = require('./telegram-finalizer-client')
const { resolveTelegramProcessOutcome } = require('./telegram-lifecycle')
const { boundedTail } = require('./job-snapshot-policy')
const { shouldAutoCopy } = require('./clipboard-policy')
const {
  normalizeTelegramLiveRequest,
  telegramLiveJobType,
  telegramLiveTarget,
  createTelegramLiveState,
  applyTelegramLiveEvent,
  publicTelegramLiveState,
  telegramMembershipSourcePayload,
  telegramMembershipMutationInFlight,
  telegramBotMutationInFlight,
  telegramFolderMutationInFlight,
} = require('./telegram-live')
const {
  TELEGRAM_SOURCE_UNAVAILABLE,
  telegramStableTarget,
} = require('./telegram-source-state')

// In production __dirname points inside app.asar (a tar-like archive, not a real
// dir) so spawn(cwd=…) fails with ENOTDIR. The build copies Python workers as
// extraResources next to app.asar — `process.resourcesPath/python-workers`.
const WORKERS_ROOT = electronApp?.isPackaged
  ? path.join(process.resourcesPath, 'python-workers')
  : path.resolve(__dirname, '..', 'python-workers')

function resolveWorkerPython() {
  if (process.env.SC_DESKTOP_PYTHON) {
    if (fs.existsSync(process.env.SC_DESKTOP_PYTHON)) return process.env.SC_DESKTOP_PYTHON
    console.warn(`[Jobs] SC_DESKTOP_PYTHON ignored, file not found: ${process.env.SC_DESKTOP_PYTHON}`)
  }
  const candidates = electronApp?.isPackaged
    ? [
        path.join(process.resourcesPath, 'python', 'bin', 'python3'),
        path.join(process.resourcesPath, '.venv', 'bin', 'python3'),
      ]
    : [
        path.resolve(__dirname, '..', '.venv', 'bin', 'python3'),
        path.resolve(__dirname, '..', 'venv', 'bin', 'python3'),
        '/usr/bin/python3',
        '/opt/homebrew/bin/python3.12',
        '/usr/local/bin/python3.12',
        '/opt/homebrew/bin/python3.11',
        '/usr/local/bin/python3.11',
      ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return '/usr/bin/python3'
}

const WORKER_PYTHON = resolveWorkerPython()
console.log(`[Jobs] worker runtime python=${WORKER_PYTHON} root=${WORKERS_ROOT}`)

// Library root holds saved job results (and later: media + transcripts).
// Honour SC_DESKTOP_DIR env var (with MEDIA_INBOX_DIR as legacy fallback)
// to share with the Python side if desired.
const LIB_ROOT = process.env.SC_DESKTOP_DIR
  || process.env.MEDIA_INBOX_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop')
const JOBS_DIR = path.join(LIB_ROOT, 'jobs')
const YT_TRANSCRIPTS_DIR = path.join(LIB_ROOT, 'transcripts', 'youtube')
const YT_COMMENTS_DIR    = path.join(LIB_ROOT, 'transcripts', 'youtube_comments')
const RUTUBE_TRANSCRIPTS_DIR = path.join(LIB_ROOT, 'transcripts', 'rutube')
const TK_TRANSCRIPTS_DIR = path.join(LIB_ROOT, 'transcripts', 'tiktok')
const IG_TRANSCRIPTS_DIR = path.join(LIB_ROOT, 'transcripts', 'instagram')
const LOCAL_TRANSCRIPTS_DIR = path.join(LIB_ROOT, 'transcripts', 'local')
const BOOSTY_TRANSCRIPTS_DIR = path.join(LIB_ROOT, 'transcripts', 'boosty')
const BOOSTY_MEDIA_DIR = path.join(LIB_ROOT, 'media', 'boosty')
const BOOSTY_VIDEO_DIR = path.join(LIB_ROOT, 'videos', 'boosty')
const BOOSTY_THUMBNAILS_DIR = path.join(LIB_ROOT, 'thumbnails', 'boosty')
const BOOSTY_TMP_DIR = path.join(LIB_ROOT, 'tmp', 'boosty')
try { fs.mkdirSync(JOBS_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(YT_TRANSCRIPTS_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(YT_COMMENTS_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(RUTUBE_TRANSCRIPTS_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(TK_TRANSCRIPTS_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(IG_TRANSCRIPTS_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(LOCAL_TRANSCRIPTS_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(BOOSTY_TRANSCRIPTS_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(BOOSTY_MEDIA_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(BOOSTY_VIDEO_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(BOOSTY_THUMBNAILS_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(BOOSTY_TMP_DIR, { recursive: true }) } catch {}

const SC_SETTINGS_PATH = path.join(os.homedir(), '.config', 'sc', 'settings.json')

function readScSettings() {
  try {
    return JSON.parse(fs.readFileSync(SC_SETTINGS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function configuredStoragePath(value, fallback) {
  const clean = typeof value === 'string' ? value.trim() : ''
  if (!clean) return fallback
  if (clean === '~') return os.homedir()
  if (clean.startsWith('~/')) return path.join(os.homedir(), clean.slice(2))
  return path.isAbsolute(clean) ? path.normalize(clean) : path.resolve(LIB_ROOT, clean)
}

function getBoostyStorageConfig() {
  const settings = readScSettings()
  const boosty = settings?.boosty && typeof settings.boosty === 'object' ? settings.boosty : {}
  return {
    audio_dir: configuredStoragePath(boosty.audio_dir, BOOSTY_MEDIA_DIR),
    video_dir: configuredStoragePath(boosty.video_dir, BOOSTY_VIDEO_DIR),
    save_video: boosty.save_video === true,
    transcript_dir: BOOSTY_TRANSCRIPTS_DIR,
  }
}

function settingValue(settings, paths) {
  for (const parts of paths) {
    let cur = settings
    let ok = true
    for (const part of parts) {
      if (!cur || typeof cur !== 'object' || !(part in cur)) {
        ok = false
        break
      }
      cur = cur[part]
    }
    if (ok && cur != null && String(cur).trim()) return String(cur).trim()
  }
  return null
}

function setEnvFromSettings(env, settings, envName, paths) {
  if (env[envName]) return
  const value = settingValue(settings, paths)
  if (value) env[envName] = value
}

function workerEnv() {
  const settings = readScSettings()
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    SC_DESKTOP_DIR: LIB_ROOT,
  }
  setEnvFromSettings(env, settings, 'GEMINI_API_KEY', [
    ['api_keys', 'GEMINI_API_KEY'],
    ['api', 'gemini_api_key'],
  ])
  setEnvFromSettings(env, settings, 'ASSEMBLYAI_API_KEY', [
    ['api_keys', 'ASSEMBLYAI_API_KEY'],
    ['api', 'assemblyai_api_key'],
  ])
  setEnvFromSettings(env, settings, 'SONIOX_API_KEY', [
    ['api_keys', 'SONIOX_API_KEY'],
    ['api', 'soniox_api_key'],
  ])
  if (!env.SONIOX_API_KEY) {
    try {
      const envPath = path.join(os.homedir(), '.noted-terminal', '.env')
      const body = fs.readFileSync(envPath, 'utf8')
      const m = body.match(/^\s*SONIOX_API_KEY\s*=\s*(.+?)\s*$/m)
      if (m && m[1]) {
        env.SONIOX_API_KEY = String(m[1]).replace(/^['"]|['"]$/g, '').trim()
      }
    } catch {}
  }
  setEnvFromSettings(env, settings, 'OPENAI_API_KEY', [
    ['api_keys', 'OPENAI_API_KEY'],
    ['api', 'openai_api_key'],
  ])
  setEnvFromSettings(env, settings, 'TELEGRAM_API_ID', [
    ['telegram', 'api_id'],
    ['api_keys', 'TELEGRAM_API_ID'],
    ['api', 'telegram_api_id'],
  ])
  setEnvFromSettings(env, settings, 'TELEGRAM_API_HASH', [
    ['telegram', 'api_hash'],
    ['api_keys', 'TELEGRAM_API_HASH'],
    ['api', 'telegram_api_hash'],
  ])
  return env
}

// Имя активной Telegram-сессии из ~/.config/sc/settings.json — то же поле,
// которое Python-сторона читает в _resolve_session_path(). Снимается В МОМЕНТ
// СПАВНА job'а (job.tg_session): уже-запущенный fetch продолжает работать со
// своей сессией, даже если юзер переключил активную (fact-telegram-sessions).
// Привязка чат↔сессия в sources.tg_session пишется из этого снимка.
function telegramFetchCapabilities() {
  const env = workerEnv()
  return {
    engines: { soniox: { configured: !!env.SONIOX_API_KEY }, assemblyai: { configured: !!env.ASSEMBLYAI_API_KEY }, gemini: { configured: !!env.GEMINI_API_KEY } },
    policy_version: 1, voice_types: ['voice', 'audio', 'video'], duration_guard_before_download: true,
    per_job_media_cache: true, durable_asr_checkpoints: true, durable_request_ids: true,
    full_history_snapshot_report: true, storage_check_async: true,
    transcript_reuse: 'any_complete_when_requested',
    request_status_route: '/telegram-rag/fetch/status', resume_route: '/telegram-rag/fetch/resume',
    asr_checkpoint_probe_route: '/telegram-rag/fetch/asr-state',
    asr_adopt_existing_file_route: '/telegram-rag/fetch/asr-adopt-file', partial_asr_resume: true,
  }
}

function activeTgSession() {
  try {
    const n = (readScSettings().telegram || {}).session
    return (typeof n === 'string' && n.trim()) ? n.trim() : null
  } catch { return null }
}

function isPlainTelegramHistoryFetch(params = {}) {
  const mode = params.mode || 'last_n'
  if (mode !== 'last_n' && mode !== 'all') return false
  if (params.date || params.date_to || params.url || params.sinceMessageId) return false
  if (params.include_comments) return false
  if (Array.isArray(params.topic_ids) && params.topic_ids.length > 0) return false
  if (Array.isArray(params._comments_only_post_ids) && params._comments_only_post_ids.length > 0) return false
  if (params._comments_only_source_id) return false
  if (Array.isArray(params._media_only_msg_ids) && params._media_only_msg_ids.length > 0) return false
  return true
}

function maybePromoteSuspiciousEmptyTelegramFetch(job) {
  if (job?.type !== 'tg_fetch') return false
  if (job.status !== 'done' || job.error || !job.source_id) return false
  if (!isPlainTelegramHistoryFetch(job.params || {})) return false
  const got = Array.isArray(job.items)
    ? job.items.length
    : Number(job.items_done || job.items_total || 0)
  if (got > 0) return false
  const warningCode = job.warning?.code || null
  if (warningCode && warningCode !== 'empty_result') return false

  let existingItems = 0
  try {
    existingItems = Number(db.getSource(job.source_id)?.items_count || 0)
  } catch (err) {
    console.error('[Jobs] empty-known-chat source lookup failed', err)
    return false
  }
  if (existingItems <= 0) return false

  const message = [
    `Telegram вернул 0 сообщений, хотя в этом чате уже сохранено ${existingItems}.`,
    'Это похоже на неправильную или устаревшую сессию Telegram либо сбой resolve диалога.',
    'Проверь привязанную сессию и запусти fetch заново.',
  ].join(' ')
  job.status = 'error'
  job.error = message
  job.warning = { code: 'empty_known_chat', message }
  job.params = {
    ...(job.params || {}),
    _warning: job.warning,
    _empty_known_chat: {
      existing_items: existingItems,
      tg_session: job.tg_session || null,
    },
  }
  console.warn(`[Jobs] tg_fetch #${job.id} promoted empty result to error source #${job.source_id} existing_items=${existingItems} session=${job.tg_session || '-'}`)
  return true
}

function isAutoEmptyCatchUpFetch(job) {
  if (job?.type !== 'tg_fetch') return false
  if (job.status !== 'done' || job.error) return false
  const params = job.params || {}
  if (params._auto_catchup !== true) return false
  const got = Array.isArray(job.items)
    ? job.items.length
    : Number(job.items_done || job.items_total || 0)
  return got <= 0
}

function suppressJobHistoryRow(job, reason) {
  if (!job?.dbRowId) {
    if (job) job.params = { ...(job.params || {}), _history_suppressed: true }
    console.log(`[Jobs] ${reason} no history row for #${job?.id || '-'}`)
    return true
  }
  const rowId = job.dbRowId
  try {
    db.deleteJob(rowId)
    job.dbRowId = null
    job.params = { ...(job.params || {}), _history_suppressed: true }
    console.log(`[Jobs] ${reason} suppressed history row #${rowId} for #${job.id}`)
    return true
  } catch (err) {
    console.error(`[Jobs] ${reason} suppress history row #${rowId} failed`, err)
    return false
  }
}

function telegramSourceForFetchParams(params = {}) {
  try {
    const sourceId = params._source_id || params.source_id || params.source_id_hint || null
    if (sourceId) {
      const s = db.getSource(Number(sourceId))
      return s && s.platform === 'telegram' ? s : null
    }
  } catch {}
  try {
    return db.findTelegramSourceByTarget(params.target) || null
  } catch {
    return null
  }
}

function telegramWorkerTarget(params = {}, source = null) {
  const stable = telegramStableTarget(source || telegramSourceForFetchParams(params))
  return stable || params.target
}

function clearTelegramUnavailableAfterLiveResolve(sourceId, context) {
  if (!sourceId) return
  try {
    const result = db.clearTelegramSourceHealth(sourceId)
    if (result?.changed) {
      console.log(`[Jobs] ${context} cleared unavailable source #${sourceId}`)
    }
  } catch (err) {
    console.error(`[Jobs] ${context} clear source health failed`, err)
  }
}

function persistTelegramUnavailableFailure(job, context) {
  if (!job?.source_id || !job?._usesStableTelegramTarget) return
  if (job.error_code !== TELEGRAM_SOURCE_UNAVAILABLE) return
  try {
    const result = db.setTelegramSourceUnavailable(job.source_id, {
      code: job.error_code,
      message: job.error,
      checked_at: job.finished_at,
    })
    console.warn(`[Jobs] ${context} source #${job.source_id} unavailable changed=${result?.changed ? 1 : 0}`)
  } catch (err) {
    console.error(`[Jobs] ${context} persist source health failed`, err)
  }
}

function telegramSessionForFetchParams(params = {}, knownSource = null) {
  const explicit = params._tg_session_override || params.tg_session || params.session || null
  if (explicit && typeof explicit === 'string' && explicit.trim()) return explicit.trim()

  const src = knownSource || telegramSourceForFetchParams(params)
  if (src && src.tg_session_conflict) {
    throw new Error('У этого Telegram-чата конфликт аккаунтов — выбери аккаунт в строке чата и запусти снова.')
  }
  if (src && !src.tg_session) {
    throw new Error('У этого Telegram-чата не выбран аккаунт — выбери аккаунт в строке чата и запусти снова.')
  }
  if (src && src.tg_session) return src.tg_session

  return activeTgSession()
}

const TG_TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'interrupted'])

function isTerminalStatus(status) {
  return TG_TERMINAL_STATUSES.has(status)
}

function parseTelegramUserDateToSec(raw, { endOfDay = false } = {}) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (m) {
    let year = Number(m[3])
    if (year < 100) year += 2000
    const hasTime = m[4] != null
    const hh = hasTime ? Number(m[4]) : (endOfDay ? 23 : 0)
    const mm = hasTime ? Number(m[5]) : (endOfDay ? 59 : 0)
    const ss = hasTime ? Number(m[6] || 0) : (endOfDay ? 59 : 0)
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]), hh, mm, ss)
    const ts = Math.floor(d.getTime() / 1000)
    return Number.isFinite(ts) ? ts : null
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (m) {
    const hasTime = m[4] != null
    const hh = hasTime ? Number(m[4]) : (endOfDay ? 23 : 0)
    const mm = hasTime ? Number(m[5]) : (endOfDay ? 59 : 0)
    const ss = hasTime ? Number(m[6] || 0) : (endOfDay ? 59 : 0)
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm, ss)
    const ts = Math.floor(d.getTime() / 1000)
    return Number.isFinite(ts) ? ts : null
  }
  return null
}

function formatTelegramUserDateTime(ts) {
  const d = new Date(Number(ts) * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function clampInterval(interval, request) {
  const start = Math.max(Number(interval.start), Number(request.start))
  const end = Math.min(Number(interval.end), Number(request.end))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return { start, end }
}

function mergeIntervals(intervals) {
  const sorted = (intervals || [])
    .filter(i => Number.isFinite(Number(i.start)) && Number.isFinite(Number(i.end)) && Number(i.end) >= Number(i.start))
    .map(i => ({ start: Number(i.start), end: Number(i.end) }))
    .sort((a, b) => a.start - b.start)
  const out = []
  for (const i of sorted) {
    const last = out[out.length - 1]
    if (last && i.start <= last.end + 1) {
      if (i.end > last.end) last.end = i.end
    } else {
      out.push({ ...i })
    }
  }
  return out
}

function intersectIntervalSets(a, b) {
  const aa = mergeIntervals(a)
  const bb = mergeIntervals(b)
  const out = []
  let i = 0, j = 0
  while (i < aa.length && j < bb.length) {
    const start = Math.max(aa[i].start, bb[j].start)
    const end = Math.min(aa[i].end, bb[j].end)
    if (end >= start) out.push({ start, end })
    if (aa[i].end < bb[j].end) i++
    else j++
  }
  return mergeIntervals(out)
}

function subtractCoveredIntervals(request, covered) {
  const req = { start: Number(request.start), end: Number(request.end) }
  if (!Number.isFinite(req.start) || !Number.isFinite(req.end) || req.end < req.start) return []
  const cov = mergeIntervals(covered)
    .map(i => clampInterval(i, req))
    .filter(Boolean)
  const missing = []
  let cur = req.start
  for (const c of cov) {
    if (c.start > cur) missing.push({ start: cur, end: c.start - 1 })
    cur = Math.max(cur, c.end + 1)
    if (cur > req.end) break
  }
  if (cur <= req.end) missing.push({ start: cur, end: req.end })
  return missing
}

function intervalSame(a, b) {
  return Number(a?.start) === Number(b?.start) && Number(a?.end) === Number(b?.end)
}

function telegramRequestedDateRange(params = {}) {
  if ((params.mode || '') !== 'from_date' || !params.date) return null
  const start = parseTelegramUserDateToSec(params.date)
  if (!Number.isFinite(start)) return null
  const end = params.date_to
    ? parseTelegramUserDateToSec(params.date_to, { endOfDay: true })
    : Math.floor(Date.now() / 1000)
  if (!Number.isFinite(end) || end < start) return null
  return { start, end }
}

function hasUnsafeTelegramBackfillNeed(sourceId, params = {}) {
  if (!sourceId) return false
  try {
    const rows = db.itemTypeBreakdown(sourceId) || []
    const byType = new Map(rows.map(r => [r.type, r]))
    const bodyTypes = ['text']
    if (params.process_polls) bodyTypes.push('poll')
    for (const t of bodyTypes) {
      const row = byType.get(t)
      if (!row) continue
      if (Number(row.with_caption || 0) < Number(row.count || 0)) return true
    }
  } catch (err) {
    console.error('[Jobs] coverage planner backfill check failed', err)
    return true
  }
  return false
}

function telegramCoveragePlannerAllowed(params = {}) {
  // A durable fetch identity belongs to one exact worker scope. Keep the
  // existing range planner for legacy callers, but do not substitute a noop
  // or a split parent behind a newly reserved request row.
  if (params.request_id) return false
  if (params._range_plan_child || params._coverage_planner_disabled) return false
  if ((params.mode || '') !== 'from_date') return false
  if (!params.date) return false
  if (params.redo_processed) return false
  if (params.include_comments) return false
  if (Array.isArray(params._comments_only_post_ids) && params._comments_only_post_ids.length > 0) return false
  if (params._comments_only_source_id) return false
  if (Array.isArray(params._media_only_msg_ids) && params._media_only_msg_ids.length > 0) return false
  if (Array.isArray(params.topic_ids) && params.topic_ids.length > 0) return false
  if (params.process_voice || params.process_photo || params.process_docs) return false
  return true
}

function isSourceWideTelegramCoverageParams(params = {}) {
  if (!params || typeof params !== 'object') return true
  if (params._range_plan_parent) return false
  if (params.mode === 'single' || params.mode === 'id_list' || params.mode === 'media_only') return false
  if (Array.isArray(params._comments_only_post_ids) && params._comments_only_post_ids.length > 0) return false
  if (params._comments_only_source_id) return false
  if (Array.isArray(params._media_only_msg_ids) && params._media_only_msg_ids.length > 0) return false
  if (Array.isArray(params.topic_ids) && params.topic_ids.length > 0) return false
  return true
}

function parseParamsJsonSafe(raw) {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

function coverageRowUsableForPlanner(row) {
  const params = parseParamsJsonSafe(row?.job_parameters_json)
  if (!params) return true
  return isSourceWideTelegramCoverageParams(params)
}

function coverageIntervalForPlannerRow(row, request) {
  let start = Number(row?.date_from)
  let end = Number(row?.date_to)
  const params = parseParamsJsonSafe(row?.job_parameters_json)
  if (params && row?.job_status === 'done'
      && isSourceWideTelegramCoverageParams(params)
      && params.mode === 'from_date'
      && params.date) {
    const requestedStart = parseTelegramUserDateToSec(params.date)
    if (Number.isFinite(requestedStart)) start = requestedStart
    const requestedEnd = params.date_to
      ? parseTelegramUserDateToSec(params.date_to, { endOfDay: true })
      : Number(row.job_finished_at || row.job_started_at || row.date_to)
    if (Number.isFinite(requestedEnd)) end = requestedEnd
  }
  return clampInterval({ start, end }, request)
}

function telegramCoverageTypesForParams(params = {}, typeBreakdown = {}) {
  // Saving hand-picked live hits proves nothing about corpus coverage. The
  // rows themselves are durable, but no date/type coverage interval should
  // be created from an arbitrary sparse id list.
  if (params.mode === 'id_list') return []
  const types = new Set(Object.keys(typeBreakdown || {}).filter(Boolean))
  if (isSourceWideTelegramCoverageParams(params)) {
    const mode = params.mode || 'last_n'
    if (mode === 'from_date' || mode === 'last_n' || mode === 'all') {
      types.add('text')
      if (params.process_polls) types.add('poll')
    }
  }
  return Array.from(types)
}

function telegramRequiredCoverageTypes(params = {}) {
  const types = ['text']
  if (params.process_polls) types.push('poll')
  return types
}

function coverageIntervalsForTypes(sourceId, requiredTypes, requestRange) {
  let rows = []
  try { rows = db.listCoverage(sourceId) || [] }
  catch (err) {
    console.error('[Jobs] coverage planner listCoverage failed', err)
    return []
  }
  const request = { start: requestRange.start, end: requestRange.end }
  const byType = new Map()
  for (const t of requiredTypes) byType.set(t, [])
  for (const r of rows) {
    if (!coverageRowUsableForPlanner(r)) continue
    if (!byType.has(r.content_type)) continue
    if (r.depth && r.depth !== 'metadata' && r.depth !== 'media' && r.depth !== 'transcribed') continue
    if (!r.date_from || !r.date_to) continue
    const clipped = coverageIntervalForPlannerRow(r, request)
    if (clipped) byType.get(r.content_type).push(clipped)
  }
  let covered = null
  for (const t of requiredTypes) {
    const intervals = mergeIntervals(byType.get(t) || [])
    if (!intervals.length) return []
    covered = covered == null ? intervals : intersectIntervalSets(covered, intervals)
    if (!covered.length) return []
  }
  return mergeIntervals(covered || [])
}

function summarizeRangePlan(original, covered, missing, reason = 'coverage') {
  return {
    reason,
    original,
    covered,
    intervals: missing,
    intervals_total: missing.length,
  }
}

function prepareTelegramCoveragePlan(params = {}) {
  if (!telegramCoveragePlannerAllowed(params)) return null
  const source = telegramSourceForFetchParams(params)
  if (!source?.id) return null
  const request = telegramRequestedDateRange(params)
  if (!request) return null
  if (hasUnsafeTelegramBackfillNeed(source.id, params)) {
    console.log(`[Jobs] coverage planner skip source #${source.id}: body backfill needed`)
    return null
  }
  const requiredTypes = telegramRequiredCoverageTypes(params)
  const covered = coverageIntervalsForTypes(source.id, requiredTypes, request)
  if (!covered.length) return null
  const missing = subtractCoveredIntervals(request, covered)
  const plan = summarizeRangePlan(request, covered, missing)
  if (missing.length === 0) {
    return { kind: 'noop', source, plan }
  }
  if (missing.length === 1) {
    if (intervalSame(missing[0], request)) return null
    const nextParams = {
      ...params,
      mode: 'from_date',
      date: formatTelegramUserDateTime(missing[0].start),
      date_to: formatTelegramUserDateTime(missing[0].end),
      _range_plan: plan,
    }
    console.log(`[Jobs] coverage planner source #${source.id}: clipped from_date ${formatTelegramUserDateTime(request.start)}..${formatTelegramUserDateTime(request.end)} → ${nextParams.date}..${nextParams.date_to}`)
    return { kind: 'single', source, plan, params: nextParams }
  }
  console.log(`[Jobs] coverage planner source #${source.id}: split ${missing.length} gaps from ${formatTelegramUserDateTime(request.start)}..${formatTelegramUserDateTime(request.end)}`)
  return { kind: 'multi', source, plan }
}

function buildTelegramDateProgress(params = {}, interval = null, intervalIndex = 0, intervalTotal = 1) {
  const range = interval || telegramRequestedDateRange(params)
  if (!range) return null
  return {
    kind: 'date_range',
    direction: 'forward',
    request_from: range.start,
    request_to: range.end,
    current_at: range.start,
    interval_index: intervalIndex,
    interval_total: intervalTotal,
  }
}

const TELEGRAM_ETA_SAMPLE_WINDOW = 10
const TELEGRAM_ETA_MIN_SAMPLE_MS = 250

function clampNonNegative(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, v) : 0
}

function pushTelegramEtaSample(job, sample) {
  if (!job) return
  if (!job._tgEta) job._tgEta = { samples: [], last: null }
  job._tgEta.samples.push(sample)
  if (job._tgEta.samples.length > TELEGRAM_ETA_SAMPLE_WINDOW) {
    job._tgEta.samples.splice(0, job._tgEta.samples.length - TELEGRAM_ETA_SAMPLE_WINDOW)
  }
}

function updateTelegramEtaFromSamples(job) {
  const progress = job?.tg_progress
  const samples = job?._tgEta?.samples || []
  if (!progress || samples.length === 0) return

  const wallSec = samples.reduce((acc, s) => acc + clampNonNegative(s.wall_ms) / 1000, 0)
  if (wallSec <= 0) return

  const currentAt = Number(progress.current_at || 0)
  const requestTo = Number(progress.request_to || 0)
  const rangeDone = samples.reduce((acc, s) => acc + clampNonNegative(s.range_sec), 0)
  const remainingRange = (currentAt && requestTo)
    ? Math.max(0, requestTo - currentAt)
    : null

  if (remainingRange != null && remainingRange > 0 && rangeDone > 0) {
    const rangePerSec = rangeDone / wallSec
    if (rangePerSec > 0) {
      progress.eta_sec = Math.ceil(remainingRange / rangePerSec)
      progress.eta_basis = 'date'
      progress.eta_samples = samples.length
      return
    }
  }

  const total = Number(job.items_total || 0)
  const done = Number(job.items_done || 0)
  const itemDone = samples.reduce((acc, s) => acc + clampNonNegative(s.items), 0)
  if (total > done && itemDone > 0) {
    const itemsPerSec = itemDone / wallSec
    if (itemsPerSec > 0) {
      progress.eta_sec = Math.ceil((total - done) / itemsPerSec)
      progress.eta_basis = 'items'
      progress.eta_samples = samples.length
      return
    }
  }

  delete progress.eta_sec
  delete progress.eta_basis
  progress.eta_samples = samples.length
}

function markTelegramEtaPoint(job, { force = false } = {}) {
  const progress = job?.tg_progress
  if (!progress) return
  const now = Date.now()
  const currentAt = Number(progress.current_at || 0)
  const itemsDone = Number(job.items_done || 0)
  if (!job._tgEta) job._tgEta = { samples: [], last: null }
  const prev = job._tgEta.last
  job._tgEta.last = { at_ms: now, current_at: currentAt, items_done: itemsDone }
  if (!prev) return

  const wallMs = now - Number(prev.at_ms || 0)
  const rangeSec = currentAt && prev.current_at
    ? Math.max(0, currentAt - Number(prev.current_at || 0))
    : 0
  const items = Math.max(0, itemsDone - Number(prev.items_done || 0))
  if ((force || wallMs >= TELEGRAM_ETA_MIN_SAMPLE_MS) && (rangeSec > 0 || items > 0)) {
    pushTelegramEtaSample(job, { wall_ms: wallMs, range_sec: rangeSec, items })
  }
  updateTelegramEtaFromSamples(job)
}

function updateTelegramSavingProgress(job, { done, total, chunkRows, ms } = {}) {
  const progress = job?.tg_progress
  if (!progress) return
  const savingDone = clampNonNegative(done)
  const savingTotal = clampNonNegative(total)
  progress.saving_done = savingDone
  progress.saving_total = savingTotal
  if (progress.request_to) progress.current_at = Number(progress.request_to)

  if (!job._tgSavingEta) job._tgSavingEta = { samples: [] }
  const rows = clampNonNegative(chunkRows)
  const wallMs = clampNonNegative(ms)
  if (rows > 0 && wallMs > 0) {
    job._tgSavingEta.samples.push({ rows, wall_ms: wallMs })
    if (job._tgSavingEta.samples.length > TELEGRAM_ETA_SAMPLE_WINDOW) {
      job._tgSavingEta.samples.splice(0, job._tgSavingEta.samples.length - TELEGRAM_ETA_SAMPLE_WINDOW)
    }
  }

  const samples = job._tgSavingEta.samples
  const sampleRows = samples.reduce((acc, s) => acc + clampNonNegative(s.rows), 0)
  const sampleWallSec = samples.reduce((acc, s) => acc + clampNonNegative(s.wall_ms) / 1000, 0)
  const remainingRows = Math.max(0, savingTotal - savingDone)
  if (remainingRows > 0 && sampleRows > 0 && sampleWallSec > 0) {
    const rowsPerSec = sampleRows / sampleWallSec
    progress.eta_sec = Math.ceil(remainingRows / rowsPerSec)
    progress.eta_basis = 'saving'
    progress.eta_samples = samples.length
  } else if (savingTotal > 0 && savingDone >= savingTotal) {
    progress.eta_sec = 0
    progress.eta_basis = 'saving'
    progress.eta_samples = samples.length
  }
}

function finishTelegramProgress(job) {
  const progress = job?.tg_progress
  if (!progress) return
  if (job.status === 'done' && progress.request_to) {
    progress.current_at = Number(progress.request_to)
    progress.eta_sec = 0
    progress.eta_basis = progress.saving_total ? 'saving' : (progress.eta_basis || 'date')
  }
}

function publicTelegramProgress(progress) {
  if (!progress) return null
  const out = {
    kind: progress.kind || 'date_range',
    direction: progress.direction || 'forward',
    request_from: progress.request_from || null,
    request_to: progress.request_to || null,
    current_at: progress.current_at || null,
    interval_index: progress.interval_index || 0,
    interval_total: progress.interval_total || 1,
    saving_done: progress.saving_done || 0,
    saving_total: progress.saving_total || 0,
  }
  if (progress.eta_sec != null && Number.isFinite(Number(progress.eta_sec))) {
    out.eta_sec = Math.max(0, Math.ceil(Number(progress.eta_sec)))
  }
  if (progress.eta_basis) out.eta_basis = progress.eta_basis
  if (progress.eta_samples != null) out.eta_samples = Number(progress.eta_samples) || 0
  if (out.current_at && out.request_to) {
    out.remaining_sec = Math.max(0, Number(out.request_to) - Number(out.current_at))
  } else if (out.request_from && out.request_to) {
    out.remaining_sec = Math.max(0, Number(out.request_to) - Number(out.request_from))
  }
  if (out.current_at && out.request_from && out.request_to) {
    const total = Math.max(1, Number(out.request_to) - Number(out.request_from))
    const done = Math.max(0, Math.min(total, Number(out.current_at) - Number(out.request_from)))
    out.progress_pct = Math.round((done / total) * 100)
  }
  return out
}

function persistTelegramProgressParams(job) {
  const progress = publicTelegramProgress(job?.tg_progress)
  if (!progress) return job?.params || null
  job.params = { ...(job.params || {}), _tg_progress: progress }
  return job.params
}

function updateTelegramDateProgress(job, item) {
  if (!job?.tg_progress || !item?.date) return
  const ts = Math.floor(new Date(item.date).getTime() / 1000)
  if (!Number.isFinite(ts)) return
  const from = Number(job.tg_progress.request_from || 0)
  const to = Number(job.tg_progress.request_to || 0)
  job.tg_progress.current_at = from && to
    ? Math.max(from, Math.min(to, ts))
    : ts
}

// On startup, flip any zombie 'running' batch rows to 'interrupted' so
// JobDetail can show a "Продолжить" button. yt_batch and ig_batch are the
// only flows where a hard-kill could leave orphan rows; tg_fetch persists
// items page-by-page and a partial fetch is still useful as-is.
if (process.env.SC_DESKTOP_MCP !== '1') {
  try {
    // Every running job-row whose process didn't survive the previous
    // session is a zombie — there's no in-memory job to clean it up, no UI
    // affordance to mark it done, and it will sit at status='running' for-
    // ever. Mark them all interrupted on startup. This includes tg_index
    // (the one that triggered the audit — Activity showed live progress
    // while History showed prior-session orphans as "running"), the TG
    // fetch family, and the AI batch jobs the original cleanup covered.
    // Anything not listed: live job-runner job is in-memory and still
    // emitting on close, so DB will catch up; if process died mid-flight
    // it's the same zombie scenario.
    const n = db.markStuckRunningAsInterrupted({
      types: [
        'yt_batch_transcribe', 'tk_batch_transcribe', 'ig_batch_transcribe',
        'tg_index', 'yt_index', 'boosty_index', 'tg_fetch', 'tg_preview',
        'tg_folder_fetch', 'tg_folder_refresh', 'tg_reply_backfill',
        'tg_catchup', 'tg_live_search', 'tg_live_public_search', 'tg_live_context',
        'tg_live_range', 'tg_live_attachment', 'tg_live_transcribe', 'tg_live_join', 'tg_live_leave',
        'tg_live_bot_info', 'tg_live_bot_messages', 'tg_live_bot_action', 'tg_live_bot_action_status',
        'tg_live_membership_info', 'tg_live_folder_read', 'tg_live_folder_merge', 'tg_live_folder_merge_status',
        'tg_live_bot_join', 'tg_live_bot_join_status',
        'yt_transcribe', 'yt_comments', 'yt_batch_comments',
        'rutube_transcribe',
        'yt_channel_fetch', 'tk_transcribe', 'tk_channel_fetch',
        'ig_profile_fetch', 'local_transcribe', 'boosty_transcribe',
        'boosty_channel_fetch', 'boosty_batch_transcribe', 'boosty_account_preflight', 'boosty_catchup',
      ],
    })
    if (n > 0) console.log(`[Jobs] reset ${n} zombie running job row(s) → interrupted`)
  } catch (err) {
    console.error('[Jobs] zombie cleanup failed', err)
  }
}

let nextId = 1
const jobs = new Map()              // id -> {id, type, target, status, items, total, startedAt, finishedAt, error, child}
const listeners = new Set()         // (job) => void
const eventListeners = new Set()    // (jobId, event) => void
const TG_LIVE_ITEMS_TAIL = 120
const TG_LIVE_ITEMS_MAX_BYTES = 64 * 1024

function emit(job) {
  if (!job.run_id) job.run_id = randomUUID()
  job.revision = Number(job.revision || 0) + 1
  if (isTerminalStatus(job.status)) job.phase = 'terminal'
  else if (job.status === 'cancelling') job.phase = 'cancelling'
  else if (!job.phase || job.phase === 'terminal' || job.phase === 'cancelling') job.phase = 'running'
  // Build one projection per revision. The old loop called snapshot(job) once
  // per listener, repeatedly mapping/sorting the 120-item Telegram live tail.
  const slim = snapshot(job, { includeLiveItems: false })
  let full = null
  for (const listener of listeners) {
    const includeLiveItems = typeof listener.includeLiveItems === 'function'
      ? listener.includeLiveItems(job)
      : listener.includeLiveItems === true
    const projected = includeLiveItems
      ? (full || (full = snapshot(job, { includeLiveItems: true })))
      : slim
    try { listener.fn(projected) } catch (e) {
      console.error('[Jobs] listener failed', e)
    }
  }
}

function emitEvent(job, event) {
  for (const fn of eventListeners) {
    try { fn(job.id, event) } catch (e) { /* swallow */ }
  }
}

function snapshot(j, { includeLiveItems = false } = {}) {
  return {
    id: j.id,
    run_id: j.run_id || null,
    revision: Number(j.revision || 0),
    phase: j.phase || null,
    // SQLite jobs.id of the persisted row (same job, different id space —
    // see fact-jobs.md::Pending row). Renderer paths that started from a
    // DB row (SourceDetail history) match against this; live ids are matched
    // against `id`. Either is acceptable identity for the same job.
    db_id: j.dbRowId || null,
    type: j.type,
    target: j.target,
    status: j.status,
    items_done: j.items_done || 0,
    items_total: j.items_total || null,
    error: j.error || null,
    // Machine token for structural error handling (e.g. "session_unauthorized"
    // → global toast). null for the vast majority of jobs.
    error_code: j.error_code || null,
    // Telegram account snapshot used by this job. Renderer mostly ignores it,
    // but background schedulers need it to pause/resume session-scoped auto work.
    tg_session: j.tg_session || null,
    // Non-fatal diagnostic for an otherwise-mute outcome: {message, code}.
    // Set by tg_fetch's empty-result path (personal account has no feed, 0 new
    // messages, filters excluded all). Rendered amber, doesn't block `done`.
    warning: j.warning || null,
    fetch_report: j.fetch_report || j.params?._fetch_report || null,
    tg_progress: publicTelegramProgress(j.tg_progress)
                 || j.params?._tg_progress
                 || null,
    started_at: j.started_at || null,
    finished_at: j.finished_at || null,
    entity_title: j.entity_title || null,
    entity_kind: j.entity_kind || null,
    // Pre-entity dialog-walk progress (tg_fetch only, while resolving a
    // private chat by title). 0 / undefined for everything else.
    resolve_scanned: j.resolve_scanned || 0,
    file_path: j.file_path || null,
    params: j.params || null,
    type_breakdown: j.type_breakdown || null,
    source_id: j.source_id || null,
    cost_usd: j.cost_usd || 0,
    // YouTube-specific shapes (null for other job types).
    yt:           j.yt || null,
    yt_channel:   j.yt_channel || null,
    yt_batch:     j.yt_batch || null,
    yt_comments:  j.yt_comments || null,
    rutube:       j.rutube || null,
    // TikTok shapes (mirror the YouTube ones structurally).
    tk:         j.tk || null,
    tk_channel: j.tk_channel || null,
    tk_batch:   j.tk_batch || null,
    // Local-file transcript shape.
    local:      j.local || null,
    // Boosty single-video download + transcript shape.
    boosty:     j.boosty || null,
    boosty_channel: j.boosty_channel || null,
    boosty_batch: j.boosty_batch || null,
    // tg_preview-specific aggregate (null for other job types).
    preview_summary: j.preview_summary || null,
    // tg_folder_fetch umbrella — driven by sequential per-chat fetches.
    // null on every other job type.
    tg_folder: j.tg_folder || null,
    // tg_folder_refresh — sweep of all DialogFilters with progress.
    tg_folder_refresh: j.tg_folder_refresh || null,
    // Per-kind AI processing progress (voice/photo/pdf). Drives the unified
    // <JobProgress> component on the renderer. Stripped of internal Sets
    // (_seen, _finished) — those are jobs.Map-only bookkeeping.
    media_phase: _publicMediaPhase(j.media_phase),
    // TG single-message specifics. tg_voice tracks AAI/Gemini transcribe
    // progress for a voice/audio message; tg_comments tracks the comments
    // side-fetch (count + per-post error count). file_path_comments is the
    // sidecar .txt path written on close — TelegramSingleMessageForm reads
    // it to enable the «📋 Комменты» button. Null for non-tg_fetch / non-
    // single fetches.
    tg_voice:      j.tg_voice      || null,
    tg_attachment: j.tg_attachment || j.params?._tg_attachment || null,
    tg_forward:    j.tg_forward    || j.params?._tg_forward || null,
    tg_comments:   j.tg_comments   || null,
    file_path_comments: j.file_path_comments || null,
    has_discussion: j.has_discussion === true ? true
                  : j.has_discussion === false ? false
                  : null,
    tg_live_items: includeLiveItems ? publicTelegramLiveItems(j) : null,
    tg_current_item: publicTelegramLiveItem(j.tg_current_item, j),
    // Telegram live request started by MCP (read-only retrieval or an explicit
    // confirmed membership mutation). Potentially large result bodies stay in
    // process memory and are returned only through the
    // explicit bridge status endpoint; renderer snapshots carry this compact
    // progress summary so background polling never recreates the old traffic
    // amplification bug.
    tg_live: publicTelegramLiveState(j.tg_live),
    tg_live_attachment: j.tg_live_attachment || j.params?._tg_live_attachment || null,
    tg_live_transcription: j.tg_live_transcription || j.params?._tg_live_transcription || null,
    tg_live_membership: j.tg_live_membership || j.params?._tg_live_membership || null,
  }
}

function publicTelegramLiveItem(it, j) {
  if (!it || !j) return null
  const published = it.date ? Math.floor(new Date(it.date).getTime() / 1000) : null
  const rawMeta = telegramRawMetaFromItem(it)
  return {
    id: `live:${j.id}:${it.id}`,
    source_id: j.source_id || null,
    external_id: String(it.id),
    type: it.type || 'other',
    url: null,
    title: null,
    caption: it.text || null,
    published_at: Number.isFinite(published) ? published : null,
    duration_seconds: it.duration || null,
    duration: it.duration || null,
    views: null,
    likes: null,
    comments: null,
    media_path: null,
    thumbnail_path: null,
    sender: it.sender || null,
    has_media: !!it.has_media,
    raw_meta_json: rawMeta ? JSON.stringify(rawMeta) : null,
    topic_id: it.topic_id != null ? it.topic_id : null,
    topic_title: it.topic_title || null,
    parent_external_id: it.parent_external_id || null,
    reactions: it.reactions === undefined ? null : it.reactions,
    __live: true,
    __live_job_id: j.id,
  }
}

function telegramRawMetaFromItem(item) {
  const out = {}
  if (Array.isArray(item?.media) && item.media.length) out.media = item.media
  if (item?.forward && typeof item.forward === 'object') out.forward = item.forward
  if (item?.telegram_reply && typeof item.telegram_reply === 'object') out.telegram_reply = item.telegram_reply
  if (Object.prototype.hasOwnProperty.call(item || {}, 'external_reply')) out.external_reply = item.external_reply
  return Object.keys(out).length ? out : null
}

function publicTelegramLiveItems(j) {
  if (!j || j.type !== 'tg_fetch') return null
  if (!j.source_id || j.params?.mode === 'media_only') return null
  if (j.status !== 'running' && j.status !== 'awaiting_ai') return null
  if (!Array.isArray(j.items) || j.items.length === 0) return []

  const selected = boundedTail(
    j.items,
    item => publicTelegramLiveItem(item, j),
    { maxCount: TG_LIVE_ITEMS_TAIL, maxBytes: TG_LIVE_ITEMS_MAX_BYTES },
  )
  return selected.sort((a, b) => {
    const at = a.published_at || 0
    const bt = b.published_at || 0
    if (bt !== at) return bt - at
    return (Number(b.external_id) || 0) - (Number(a.external_id) || 0)
  })
}

function listJobs(historyRows = null) {
  const workerHistory = historyRows && typeof historyRows === 'object' ? historyRows : null
  // Initial hydration stays slim. ChatView explicitly attaches to one source
  // and receives its current bounded tail plus subsequent live snapshots.
  const live = [...jobs.values()].map(job => snapshot(job, { includeLiveItems: false }))
  // Augment with YouTube single-video jobs from the DB so Activity 'Recent'
  // restores across app restarts. yt_transcribe rows now carry source_id
  // (channel-of-the-video); we still want them in Recent because they were
  // started as one-shot pastes, not channel-fetches. Query by type, not by
  // source_id IS NULL.
  let historic = []
  try {
    const rows = workerHistory
      ? (workerHistory.youtube || [])
      : db.getDb().prepare(
          `SELECT * FROM jobs WHERE type = 'yt_transcribe' ORDER BY started_at DESC LIMIT 150`
        ).all()
    historic = rows
      // skip the ones already alive in the Map (would dup if jobId == row.id;
      // they aren't since DB ids are independent from in-memory ids, but a
      // re-resumed job might be in both — match on file_path).
      .filter(row => !live.some(j => j.file_path && j.file_path === row.file_path))
      .map(rowToYoutubeSnapshot)
  } catch (err) {
    console.error('[Jobs] historic query failed', err)
  }
  let historicLocal = []
  try {
    const rows = workerHistory
      ? (workerHistory.local || [])
      : db.listSourcelessJobs({ type: 'local_transcribe', limit: 150 })
    historicLocal = rows
      .filter(row => !live.some(j => j.file_path && j.file_path === row.file_path))
      .map(rowToLocalSnapshot)
  } catch (err) {
    console.error('[Jobs] historic local query failed', err)
  }
  let historicRutube = []
  try {
    const rows = workerHistory
      ? (workerHistory.rutube || [])
      : db.listSourcelessJobs({ type: 'rutube_transcribe', limit: 150 })
    historicRutube = rows
      .filter(row => {
        let params = null
        try { params = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
        return !live.some(j => (
          j.type === 'rutube_transcribe' && (
            (row.file_path && j.file_path && j.file_path === row.file_path) ||
            (j.started_at === row.started_at && j.target === params?.url)
          )
        ))
      })
      .map(rowToRutubeSnapshot)
  } catch (err) {
    console.error('[Jobs] historic Rutube query failed', err)
  }
  let historicBoosty = []
  try {
    const rows = workerHistory
      ? (workerHistory.boosty || [])
      : db.listSourcelessJobs({ type: 'boosty_transcribe', limit: 150 })
    historicBoosty = rows
      .filter(row => !live.some(j => j.file_path && j.file_path === row.file_path))
      .map(rowToBoostySnapshot)
  } catch (err) {
    console.error('[Jobs] historic Boosty query failed', err)
  }
  // TG single-message — also sourceless (params.mode === 'single').
  // Without this the user loses the result after restart: live jobs Map is
  // empty on a fresh process, but the row is in DB. Mirrors the YouTube
  // single / local-file restoration paths.
  let historicTgSingle = []
  try {
    const rows = workerHistory
      ? (workerHistory.telegramSingle || [])
      : db.listSourcelessJobs({ type: 'tg_fetch', limit: 150 })
    // Dedup by file_path: a live single-message job that already finished
    // gets a DB row written in the close-handler; without this filter
    // listJobs returns both shapes for the *same* result and the renderer
    // (TelegramSingleMessageForm) latches onto the wrong one.
    historicTgSingle = rows
      .filter(row => !live.some(j =>
        j.type === 'tg_fetch' &&
        j.params?.mode === 'single' &&
        j.file_path && j.file_path === row.file_path
      ))
      .map(rowToTgSingleSnapshot)
  } catch (err) {
    console.error('[Jobs] historic tg_single query failed', err)
  }
  // Read-only Telegram live requests persist only a compact summary. Message
  // bodies are deliberately RAM-only, but the user still sees the completed
  // request in Activity history after restart.
  let historicTgLive = []
  try {
    const rows = workerHistory
      ? (workerHistory.telegramLive || [])
      : db.getDb().prepare(
          `SELECT * FROM jobs
            WHERE type IN ('tg_live_search', 'tg_live_public_search', 'tg_live_context',
                           'tg_live_range', 'tg_live_attachment', 'tg_live_transcribe',
                           'tg_live_join', 'tg_live_leave', 'tg_live_bot_info', 'tg_live_bot_messages',
                           'tg_live_bot_action', 'tg_live_bot_action_status', 'tg_live_membership_info',
                           'tg_live_folder_read', 'tg_live_folder_merge', 'tg_live_folder_merge_status',
                           'tg_live_bot_join', 'tg_live_bot_join_status')
            ORDER BY started_at DESC LIMIT 150`
        ).all()
    historicTgLive = rows
      .filter(row => !live.some(job => job.db_id === row.id))
      .map(rowToHistoricSnapshot)
  } catch (err) {
    console.error('[Jobs] historic Telegram live query failed', err)
  }
  // Search-batch (yt_batch_transcribe with source_id IS NULL → params.is_search).
  // Channel-batches keep their source_id and reach Activity through the
  // source-list fan-out; sourceless ones would otherwise never appear in
  // the right-rail "Recent". rowToHistoricSnapshot rebuilds the yt_batch
  // shape JobDetail expects.
  let historicYtBatch = []
  try {
    const rows = workerHistory
      ? (workerHistory.youtubeBatch || [])
      : db.listSourcelessJobs({ type: 'yt_batch_transcribe', limit: 150 })
    historicYtBatch = rows
      .filter(row => !live.some(j => j.id === row.id))
      .map(rowToHistoricSnapshot)
  } catch (err) {
    console.error('[Jobs] historic yt_batch query failed', err)
  }
  let historicIgBatch = []
  try {
    const rows = workerHistory
      ? (workerHistory.instagramBatch || [])
      : db.listSourcelessJobs({ type: 'ig_batch_transcribe', limit: 150 })
    historicIgBatch = rows
      .filter(row => {
        let p = null
        try { p = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
        const rowCodes = Array.isArray(p?.shortcodes) ? p.shortcodes.join(',') : ''
        return !live.some(j => {
          if (j.type !== 'ig_batch_transcribe') return false
          const liveCodes = Array.isArray(j.params?.shortcodes) ? j.params.shortcodes.join(',') : ''
          return (
            (row.file_path && j.file_path && row.file_path === j.file_path) ||
            (p?.target && j.target && p.target === j.target) ||
            (rowCodes && liveCodes && rowCodes === liveCodes)
          )
        })
      })
      .map(rowToHistoricSnapshot)
  } catch (err) {
    console.error('[Jobs] historic ig_batch query failed', err)
  }
  // YouTube comments — single-paste artifacts; show in Recent regardless of
  // whether they're now bound to a source via the new single-flow.
  let historicYtComments = []
  try {
    const rows = workerHistory
      ? (workerHistory.youtubeComments || [])
      : db.getDb().prepare(
          `SELECT * FROM jobs WHERE type = 'yt_comments' ORDER BY started_at DESC LIMIT 150`
        ).all()
    historicYtComments = rows
      .filter(row => !live.some(j => j.file_path && j.file_path === row.file_path))
      .map(rowToYoutubeCommentsSnapshot)
  } catch (err) {
    console.error('[Jobs] historic yt_comments query failed', err)
  }
  // YouTube batch-comments — both source-tied (channel batch) and sourceless
  // (search batch) variants. listSourcelessJobs covers the search ones.
  let historicYtBatchComments = []
  try {
    const rows = workerHistory
      ? (workerHistory.youtubeBatchComments || [])
      : db.listSourcelessJobs({ type: 'yt_batch_comments', limit: 150 })
    historicYtBatchComments = rows
      .filter(row => !live.some(j => j.id === row.id))
      .map(rowToHistoricSnapshot)
  } catch (err) {
    console.error('[Jobs] historic yt_batch_comments query failed', err)
  }
  return [...live, ...historic, ...historicLocal, ...historicRutube, ...historicBoosty, ...historicTgSingle, ...historicTgLive, ...historicYtBatch, ...historicIgBatch, ...historicYtComments, ...historicYtBatchComments]
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
}

function rowToYoutubeSnapshot(row) {
  let p = null
  try { p = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
  return {
    id:            `db-${row.id}`,            // string id distinguishes historic from live
    type:          row.type,
    target:        p?.url || '',
    status:        row.status,
    items_done:    0,
    items_total:   null,
    error:         row.error || null,
    started_at:    row.started_at,
    finished_at:   row.finished_at,
    entity_title:  p?.title || null,
    entity_kind:   'youtube_video',
    file_path:     row.file_path,
    params:        p,
    type_breakdown: null,
    yt: {
      video_id:     p?.video_id || null,
      title:        p?.title || null,
      channel:      p?.channel || null,
      duration_sec: p?.duration_sec || null,
      lang:         p?.lang || null,
      with_ts:      !!p?.with_ts,
      engine:       p?.engine || null,
      kind:         p?.engine ? 'ai' : 'subs',
      file_path:    row.file_path,
      cost_usd:     row.cost_usd || 0,
      stage:        row.status === 'done' ? 'transcribed' : 'idle',
    },
  }
}

function rowToYoutubeCommentsSnapshot(row) {
  let p = null
  try { p = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
  return {
    id:            `db-${row.id}`,
    type:          row.type,
    target:        p?.url || '',
    status:        row.status,
    items_done:    p?.count_total || 0,
    items_total:   p?.count_total || 0,
    error:         row.error || null,
    started_at:    row.started_at,
    finished_at:   row.finished_at,
    entity_title:  p?.title || null,
    entity_kind:   'youtube_video',
    file_path:     row.file_path,
    params:        p,
    type_breakdown: null,
    yt_comments: {
      video_id:        p?.video_id || null,
      title:           p?.title || null,
      channel:         p?.channel || null,
      sort:            p?.sort || 'new',
      limit:           p?.limit || 0,
      include_replies: !!p?.include_replies,
      count_total:     p?.count_total || null,
      count_top:       p?.count_top || null,
      count_replies:   p?.count_replies || null,
      file_path:       row.file_path,
      stage:           row.status === 'done' ? 'done' : 'idle',
    },
  }
}

function rowToRutubeSnapshot(row) {
  let p = null
  try { p = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
  return {
    id:            `db-${row.id}`,
    type:          row.type,
    target:        p?.url || '',
    status:        row.status,
    items_done:    0,
    items_total:   null,
    error:         row.error || null,
    started_at:    row.started_at,
    finished_at:   row.finished_at,
    entity_title:  p?.title || null,
    entity_kind:   'rutube_video',
    file_path:     row.file_path,
    params:        p,
    type_breakdown: null,
    rutube: {
      video_id:      p?.video_id || null,
      title:         p?.title || null,
      channel:       p?.channel || null,
      duration_sec:  p?.duration_sec || null,
      thumbnail_url: p?.thumbnail_url || null,
      lang:          p?.lang || null,
      with_ts:       !!p?.with_ts,
      engine:        p?.engine || null,
      kind:          p?.engine ? 'ai' : 'subs',
      chars:         p?.chars || null,
      file_path:     row.file_path,
      cost_usd:      row.cost_usd || 0,
      stage:         row.status === 'done' ? 'transcribed' : 'idle',
    },
  }
}

function rowToLocalSnapshot(row) {
  let p = null
  try { p = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
  const name = p?.name || (row.file_path ? path.basename(p?.path || '') : '')
  return {
    id:            `db-${row.id}`,
    type:          row.type,
    target:        p?.path || '',
    status:        row.status,
    items_done:    0,
    items_total:   null,
    error:         row.error || null,
    started_at:    row.started_at,
    finished_at:   row.finished_at,
    entity_title:  name || null,
    entity_kind:   'local_file',
    file_path:     row.file_path,
    params:        p,
    type_breakdown: null,
    local: {
      path:         p?.path || null,
      name:         name || null,
      size_bytes:   p?.size_bytes || null,
      duration_sec: p?.duration_sec || null,
      engine:       p?.engine || null,
      with_timings: !!p?.with_timings,
      kind:         'ai',
      file_path:    row.file_path,
      srt_path:     p?.srt_path || p?.result_files?.srt || null,
      srt_cues:     p?.srt_cues || null,
      token_count:  p?.token_count || null,
      result_files: p?.result_files || {
        text: row.file_path,
        srt: p?.srt_path || null,
      },
      cost_usd:     row.cost_usd || 0,
      stage:        row.status === 'done' ? 'transcribed' : 'idle',
    },
  }
}

function rowToBoostySnapshot(row) {
  let p = null
  try { p = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
  const meta = p?._boosty || {}
  return {
    id:            `db-${row.id}`,
    type:          row.type,
    target:        p?.url || meta.canonical_url || '',
    status:        row.status,
    items_done:    0,
    items_total:   null,
    error:         row.error || null,
    error_code:    p?._error_code || null,
    started_at:    row.started_at,
    finished_at:   row.finished_at,
    entity_title:  meta.title || null,
    entity_kind:   'boosty_video',
    file_path:     row.file_path,
    params:        p,
    type_breakdown: null,
    boosty: {
      ...meta,
      stage:        row.status === 'done' ? 'done' : 'idle',
      file_path:    row.file_path,
      audio_path:   meta.audio_path || p?.result_files?.audio || null,
      audio_bytes:  meta.audio_bytes || null,
      srt_path:     meta.srt_path || p?.result_files?.srt || null,
      result_files: p?.result_files || null,
    },
  }
}

// Hydrate a tg_fetch row that ran in single-message mode (source_id IS NULL).
// Channel/topic fetches keep their source_id and are reachable through Library
// → SourceDetail → "История парсинга", so they're never sourceless.
function rowToTgSingleSnapshot(row) {
  let p = null
  try { p = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
  return {
    id:             `db-${row.id}`,
    type:           row.type,
    target:         p?.target || '',         // @handle that owns the message
    status:         row.status,
    items_done:     row.items_done || 0,
    items_total:    row.items_total || row.items_done || 0,
    error:          row.error || null,
    started_at:     row.started_at,
    finished_at:    row.finished_at,
    entity_title:   p?.entity_title || null,
    entity_kind:    'tg_message',
    file_path:      row.file_path,
    // Comments-side sidecar path was stored in params on close — restore it
    // so re-mounted forms see both copy targets without re-fetching.
    file_path_comments: p?.file_path_comments || null,
    tg_comments:    p?.tg_comments || null,
    params:         p,
    // Prefer the new `_type_breakdown` slot; legacy single-mode jobs only
    // wrote `type_breakdown` directly into params. Either path produces
    // the same shape — {text: 12, voice: 3, …}.
    type_breakdown: p?._type_breakdown || p?.type_breakdown || null,
    // Restore per-kind error / skipped logs so «Видео ⚠14» in JobDetail
    // can still expand into the per-msg failure list after Electron restart.
    media_phase:    p?._media_phase || null,
    tg_attachment:  p?._tg_attachment || null,
    tg_forward:     p?._tg_forward || null,
  }
}

function subscribe(fn, options = {}) {
  const listener = { fn, includeLiveItems: options.includeLiveItems || false }
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function liveSnapshotsForSource(sourceId) {
  const wanted = Number(sourceId)
  const out = []
  for (const job of jobs.values()) {
    if (Number(job.source_id) !== wanted) continue
    if (job.status !== 'running' && job.status !== 'awaiting_ai' && job.status !== 'cancelling') continue
    out.push(snapshot(job, { includeLiveItems: true }))
  }
  return out
}
function subscribeEvents(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn) }

function markJobClosed(job) {
  if (!job) return
  job._closed = true
  if (typeof job._resolveClose === 'function') {
    try { job._resolveClose(snapshot(job)) } catch {}
    job._resolveClose = null
  }
}

function queueJobPersistence(job, label, task, fallback) {
  if (!job) return Promise.resolve()
  const previous = job._persistenceQueue || Promise.resolve()
  const next = previous.then(async () => {
    try {
      return await task()
    } catch (error) {
      console.error(`[Jobs] ${label} persistence worker failed; falling back to main`, error)
      if (typeof fallback === 'function') return fallback()
      throw error
    }
  }).catch(error => {
    job._persistenceError = job._persistenceError || String(error?.message || error)
    console.error(`[Jobs] ${label} persistence failed`, error)
  })
  job._persistenceQueue = next
  return next
}

async function waitForJobPersistence(job) {
  if (!job?._persistenceQueue) return
  await job._persistenceQueue
  delete job._persistenceQueue
}

function findLiveJobByIdOrDbId(id) {
  const numericId = Number(id)
  const requestedId = Number.isFinite(numericId) ? numericId : id
  let j = jobs.get(requestedId)
  if (!j) {
    for (const candidate of jobs.values()) {
      if (candidate.dbRowId === requestedId) {
        j = candidate
        break
      }
    }
  }
  return j || null
}

async function startAutoIndexAfterTelegramFetch(job) {
  if (!job || job.type !== 'tg_fetch') return null
  if (job.status !== 'done' || job.params?._auto_index_after_fetch !== true) return null
  if (job.params?._auto_index_after_fetch_started
      || job.params?._auto_index_after_fetch_noop) return null

  const nextParams = { ...(job.params || {}) }
  if (!job.source_id) {
    nextParams._auto_index_after_fetch_error = 'source_id missing after Telegram fetch'
    job.params = nextParams
    if (job.dbRowId) {
      try { db.updateJob(job.dbRowId, { params: job.params }) } catch {}
    }
    return { ok: false, error: nextParams._auto_index_after_fetch_error }
  }

  try {
    const indexJob = require('./index-job')
    const result = await indexJob.start({
      sourceId: Number(job.source_id),
      limit: null,
      origin: 'tg-fetch-auto-rag',
    })
    if (result && typeof result === 'object' && result.noop) {
      nextParams._auto_index_after_fetch_noop = {
        reason: result.reason || 'already-indexed',
        at: Math.floor(Date.now() / 1000),
      }
      delete nextParams._auto_index_after_fetch_error
      console.log(`[Jobs] tg_fetch #${job.id} auto RAG noop source #${job.source_id}: ${nextParams._auto_index_after_fetch_noop.reason}`)
      job.params = nextParams
      if (job.dbRowId) db.updateJob(job.dbRowId, { params: job.params })
      return { ok: true, noop: true, reason: nextParams._auto_index_after_fetch_noop.reason }
    }

    nextParams._auto_index_after_fetch_started = {
      job_id: result,
      at: Math.floor(Date.now() / 1000),
    }
    delete nextParams._auto_index_after_fetch_error
    console.log(`[Jobs] tg_fetch #${job.id} auto RAG started tg_index #${result} source #${job.source_id}`)
    job.params = nextParams
    if (job.dbRowId) db.updateJob(job.dbRowId, { params: job.params })
    return { ok: true, jobId: result }
  } catch (err) {
    const message = String(err && err.message || err)
    nextParams._auto_index_after_fetch_error = message
    job.params = nextParams
    if (job.dbRowId) {
      try { db.updateJob(job.dbRowId, { params: job.params }) } catch {}
    }
    console.error(`[Jobs] tg_fetch #${job.id} auto RAG failed`, err)
    return { ok: false, error: message }
  }
}

function patchAutoIndexParams(params, enabled) {
  const next = { ...(params || {}), _auto_index_after_fetch: enabled === true }
  if (enabled === true) {
    delete next._auto_index_after_fetch_error
  } else if (!next._auto_index_after_fetch_started && !next._auto_index_after_fetch_noop) {
    delete next._auto_index_after_fetch_error
  }
  return next
}

async function setAutoIndexAfterFetch(id, enabled) {
  const on = enabled === true
  const live = findLiveJobByIdOrDbId(id)
  if (live) {
    if (live.type !== 'tg_fetch') return { ok: false, error: 'auto RAG is only available for Telegram parsing jobs' }
    if (live.params?.mode === 'single' || live.params?.mode === 'media_only') {
      return { ok: false, error: 'auto RAG needs a saved Telegram chat source' }
    }
    live.params = patchAutoIndexParams(live.params, on)
    if (live.dbRowId) {
      try { db.updateJob(live.dbRowId, { params: live.params }) } catch {}
    }
    const auto = on ? await startAutoIndexAfterTelegramFetch(live) : null
    emit(live)
    return { ok: true, enabled: on, auto, job: snapshot(live) }
  }

  const rowId = Number(id)
  if (!Number.isFinite(rowId)) return { ok: false, error: 'job not found' }
  try {
    const row = db.getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(rowId)
    if (!row) return { ok: false, error: 'job not found' }
    if (row.type !== 'tg_fetch') return { ok: false, error: 'auto RAG is only available for Telegram parsing jobs' }
    let params = null
    try { params = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
    if (params?.mode === 'single' || params?.mode === 'media_only') {
      return { ok: false, error: 'auto RAG needs a saved Telegram chat source' }
    }
    const pseudoJob = {
      id: row.id,
      dbRowId: row.id,
      type: row.type,
      status: row.status,
      source_id: row.source_id || null,
      params: patchAutoIndexParams(params, on),
    }
    db.updateJob(row.id, { params: pseudoJob.params })
    const auto = on ? await startAutoIndexAfterTelegramFetch(pseudoJob) : null
    const job = getJobDetail(row.id)
    return { ok: true, enabled: on, auto, job }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

function startTelegramNoopFetch(params, planInfo) {
  const id = nextId++
  const source = planInfo?.source || telegramSourceForFetchParams(params) || null
  const now = Math.floor(Date.now() / 1000)
  const plan = planInfo?.plan || null
  const warning = {
    code: 'already_covered',
    message: 'Этот диапазон уже покрыт сохранённым парсингом — новый Telegram-запрос не запускался.',
  }
  const job = {
    id,
    type: 'tg_fetch',
    target: params.target,
    status: 'done',
    items_done: 0,
    items_total: 0,
    started_at: now,
    finished_at: now,
    source_id: source?.id || params._source_id || null,
    entity_title: source?.display_name || null,
    entity_kind: source?.meta?.kind || null,
    params: {
      ...params,
      _range_plan: plan,
      _warning: warning,
    },
    warning,
    type_breakdown: {},
    tg_progress: plan?.original ? buildTelegramDateProgress(params, plan.original) : null,
  }
  finishTelegramProgress(job)
  job.params = persistTelegramProgressParams(job)
  try {
    if (job.source_id) {
      job.dbRowId = db.recordJob({
        type: job.type, source_id: job.source_id, status: job.status,
        items_total: 0, items_done: 0,
        params: job.params, started_at: job.started_at,
        finished_at: job.finished_at,
        file_path: null,
      })
    }
  } catch (err) {
    console.error('[Jobs] coverage planner noop recordJob failed', err)
  }
  jobs.set(id, job)
  console.log(`[Jobs] coverage planner noop #${id} source #${job.source_id || '-'} db #${job.dbRowId || '-'} fully covered`)
  emit(job)
  setImmediate(() => emit(job))
  markJobClosed(job)
  return id
}

function mergeTypeBreakdownInto(target, src) {
  if (!target || !src) return
  for (const [k, v] of Object.entries(src)) {
    target[k] = (target[k] || 0) + Number(v || 0)
  }
}

function waitForJobClose(jobId) {
  const j = jobs.get(jobId)
  if (!j) return Promise.resolve(null)
  if (j._closed) return Promise.resolve(snapshot(j))
  if (j._closePromise) return j._closePromise
  if (isTerminalStatus(j.status)) return Promise.resolve(snapshot(j))
  return new Promise(resolve => {
    const off = subscribe(snap => {
      if (!snap || snap.id !== jobId) return
      if (!isTerminalStatus(snap.status)) return
      off()
      resolve(snap)
    })
  })
}

function startTelegramRangePlan(params, planInfo) {
  const id = nextId++
  const source = planInfo.source || telegramSourceForFetchParams(params) || null
  const intervals = Array.isArray(planInfo.plan?.intervals) ? planInfo.plan.intervals : []
  const now = Math.floor(Date.now() / 1000)
  const job = {
    id,
    type: 'tg_fetch',
    target: params.target,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: now,
    source_id: source?.id || params._source_id || null,
    entity_title: source?.display_name || null,
    entity_kind: source?.meta?.kind || null,
    params: {
      ...params,
      _range_plan_parent: true,
      _range_plan: planInfo.plan,
    },
    type_breakdown: {},
    tg_progress: intervals[0] ? buildTelegramDateProgress(params, intervals[0], 0, intervals.length) : null,
  }
  if (job.tg_progress) markTelegramEtaPoint(job)
  job._closePromise = new Promise(resolve => { job._resolveClose = resolve })
  job.cancel = () => {
    job._cancelRequested = true
    if (job._activeChildId) {
      try { cancelJob(job._activeChildId) } catch {}
    }
  }
  try {
    if (job.source_id) {
      job.dbRowId = db.recordJob({
        type: job.type, source_id: job.source_id, status: 'running',
        items_total: null, items_done: 0,
        params: persistTelegramProgressParams(job),
        started_at: job.started_at,
      })
    }
  } catch (err) {
    console.error('[Jobs] coverage planner parent recordJob failed', err)
  }
  jobs.set(id, job)
  console.log(`[Jobs] coverage planner parent #${id} source #${job.source_id || '-'} db #${job.dbRowId || '-'} intervals=${intervals.length}`)
  emit(job)

  ;(async () => {
    let failed = null
    for (let i = 0; i < intervals.length; i++) {
      if (job._cancelRequested || job.status === 'cancelled') break
      const interval = intervals[i]
      job.tg_progress = buildTelegramDateProgress(params, interval, i, intervals.length)
      job._tgEta = null
      if (job.tg_progress) markTelegramEtaPoint(job)
      job.params = persistTelegramProgressParams(job)
      if (job.dbRowId) {
        try { db.updateJob(job.dbRowId, { params: job.params, items_done: job.items_done }) } catch {}
      }
      emit(job)

      const childParams = {
        ...params,
        mode: 'from_date',
        date: formatTelegramUserDateTime(interval.start),
        date_to: formatTelegramUserDateTime(interval.end),
        _source_id: job.source_id || params._source_id || null,
        _range_plan_child: true,
        _range_plan_parent_id: id,
        _range_plan_parent_db_id: job.dbRowId || null,
        _range_plan_interval_index: i,
        _range_plan_interval_total: intervals.length,
      }
      let childId = null
      try {
        const doneBeforeInterval = Number(job.items_done || 0)
        childId = startTelegramFetch(childParams)
        job._activeChildId = childId
        console.log(`[Jobs] coverage planner parent #${id} interval ${i + 1}/${intervals.length} child #${childId} ${childParams.date}..${childParams.date_to}`)
        const offChildProgress = subscribe(snap => {
          if (!snap || snap.id !== childId) return
          job.items_done = doneBeforeInterval + Number(snap.items_done || 0)
          job.items_total = job.items_done || null
          if (snap.tg_progress) {
            job.tg_progress = {
              ...snap.tg_progress,
              interval_index: i,
              interval_total: intervals.length,
            }
          }
          job.params = persistTelegramProgressParams(job)
          const nowMs = Date.now()
          if (job.dbRowId && (!job._lastParentProgressDbSync || nowMs - job._lastParentProgressDbSync > 750)) {
            job._lastParentProgressDbSync = nowMs
            try { db.updateJob(job.dbRowId, { items_done: job.items_done, params: job.params }) }
            catch (err) { console.error('[Jobs] coverage planner parent progress update failed', err) }
          }
          emit(job)
        })
        const snap = await waitForJobClose(childId)
        try { offChildProgress() } catch {}
        job._activeChildId = null
        if (!snap) continue
        job.items_done = doneBeforeInterval + Number(snap.items_done || 0)
        job.items_total = job.items_done
        mergeTypeBreakdownInto(job.type_breakdown, snap.type_breakdown || {})
        if (snap.status === 'error') {
          failed = snap.error || 'child fetch failed'
          break
        }
        if (snap.status === 'cancelled') {
          job._cancelRequested = true
          break
        }
      } catch (err) {
        failed = String(err?.message || err)
        job._activeChildId = null
        break
      }
    }

    job.finished_at = Math.floor(Date.now() / 1000)
    if (job._cancelRequested) {
      job.status = 'cancelled'
    } else if (failed) {
      job.status = 'error'
      job.error = failed
    } else {
      job.status = 'done'
    }
    finishTelegramProgress(job)
    try {
      const nextParams = { ...(job.params || {}) }
      if (job.type_breakdown && Object.keys(job.type_breakdown).length) nextParams._type_breakdown = job.type_breakdown
      if (job.tg_progress) nextParams._tg_progress = publicTelegramProgress(job.tg_progress)
      job.params = nextParams
      if (job.dbRowId) {
        db.updateJob(job.dbRowId, {
          status: job.status,
          items_total: job.items_done,
          items_done: job.items_done,
          error: job.error || null,
          finished_at: job.finished_at,
          params: job.params,
        })
      }
    } catch (err) {
      console.error('[Jobs] coverage planner parent final update failed', err)
    }
    console.log(`[Jobs] coverage planner parent #${id} end status=${job.status} items=${job.items_done} intervals=${intervals.length}${job.error ? ' error=' + job.error : ''}`)
    emit(job)
    markJobClosed(job)
  })().catch(err => {
    job.status = 'error'
    job.error = String(err?.message || err)
    job.finished_at = Math.floor(Date.now() / 1000)
    console.error('[Jobs] coverage planner parent failed', err)
    emit(job)
    markJobClosed(job)
  })

  return id
}

async function bulkUpsertItemsYielding(rows, { jobId = '-', sourceId = '-', chunkSize = 1000, onProgress = null } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return 0
  if (rows.length <= chunkSize) {
    const t0 = Date.now()
    db.bulkUpsertItems(rows)
    if (typeof onProgress === 'function') {
      onProgress({ done: rows.length, total: rows.length, chunkRows: rows.length, ms: Date.now() - t0 })
    }
    return rows.length
  }
  let done = 0
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const t0 = Date.now()
    db.bulkUpsertItems(chunk)
    done += chunk.length
    const ms = Date.now() - t0
    if (ms > 250) {
      console.log(`[Jobs] close #${jobId} bulkUpsertItems chunk source #${sourceId} rows=${chunk.length} done=${done}/${rows.length} took ${ms}ms`)
    }
    if (typeof onProgress === 'function') {
      onProgress({ done, total: rows.length, chunkRows: chunk.length, ms })
    }
    await new Promise(resolve => setImmediate(resolve))
  }
  return done
}

/**
 * Start a Telegram fetch via tg_fetch_json.py.
 * params: { target, mode, limit?, date?, url? }
 */
function startTelegramFetch(params) {
  try {
    params = require('./telegram-fetch-policy').validateTelegramFetchPolicy(params || {})
    // Never perform potentially blocking external-volume I/O on Electron main.
    // The explicit public preflight uses a bounded storage worker; the real
    // Python job independently fences mount/space before download/provider work.
  } catch (error) { error.pre_spawn = true; throw error }
  let coveragePlan
  try { coveragePlan = prepareTelegramCoveragePlan(params) }
  catch (error) { error.pre_spawn = true; throw error }
  if (coveragePlan?.kind === 'noop') return startTelegramNoopFetch(params, coveragePlan)
  if (coveragePlan?.kind === 'multi') return startTelegramRangePlan(params, coveragePlan)
  if (coveragePlan?.kind === 'single' && coveragePlan.params) params = coveragePlan.params

  const startStartedMs = Date.now()
  const id = nextId++
  let telegramSource, workerTarget, usesStableTelegramTarget, tgSession
  try {
    telegramSource = telegramSourceForFetchParams(params)
    workerTarget = telegramWorkerTarget(params, telegramSource)
    usesStableTelegramTarget = !!telegramStableTarget(telegramSource)
    tgSession = telegramSessionForFetchParams(params, telegramSource)
  } catch (error) { error.pre_spawn = true; throw error }
  // Снимок активной сессии ДО построения args: он же уходит Python'у явным
  // --session (иначе Python перечитал бы settings.json сам — окно гонки, в
  // котором переключение сессии в UI ретаргетит уже-спавнящийся fetch, и
  // job.tg_session разошёлся бы с реально использованной сессией).
  const args = [
    path.join(WORKERS_ROOT, 'telegram', 'tg_fetch_json.py'),
    workerTarget,
    '--mode', params.mode,
  ]
  if (tgSession) args.push('--session', tgSession)
  if (params.limit) args.push('--limit', String(params.limit))
  if (params.date)  args.push('--date', params.date)
  if (params.date_to) args.push('--date-to', params.date_to)
  if (params.url)   args.push('--url', params.url)
  if (params.sinceMessageId) args.push('--since-msgid', String(params.sinceMessageId))
  if (Array.isArray(params.message_ids) && params.message_ids.length > 0) {
    args.push('--message-ids', params.message_ids.join(','))
  }
  // Single-message voice transcription (mode='single' only). Renderer
  // (TelegramSingleMessageForm) sets engine/lang from its selectors;
  // tg_fetch_json silently ignores both unless the message has voice/audio
  // media. Channel and topic fetches don't pass these.
  if (params.transcribe_engine) {
    args.push('--transcribe-engine', params.transcribe_engine)
    if (params.transcribe_lang) args.push('--transcribe-lang', params.transcribe_lang)
  }
  // Per-type opt-in flags. Without these tg_fetch_json defaults to
  // voice/audio only (legacy single-message behaviour). Channel/folder fetches
  // pass them so the Python side knows which media types to download and run
  // through Gemini Vision (photo) / extract_pdf (docs).
  if (params.process_voice) args.push('--process-voice')
  if (params.process_photo) args.push('--process-photo')
  if (params.process_docs)  args.push('--process-docs')
  if (params.process_polls) args.push('--process-polls')
  args.push(...require('./telegram-fetch-worker-options').telegramFetchWorkerOptions(params, { jobsDir: JOBS_DIR, session: tgSession }))
  // Forum topic filter (multi). Each id maps to a top_msg_id; Python loops
  // over them with iter_messages(reply_to=tid). Empty / undefined → omit.
  if (Array.isArray(params.topic_ids) && params.topic_ids.length > 0) {
    args.push('--topic-ids', params.topic_ids.join(','))
  }
  // Telegram channel comments (sourced from linked discussion group). off by
  // default; renderer opt-in via TelegramConfigForm checkbox.
  if (params.include_comments) {
    args.push('--include-comments')
    if (params.comments_limit && params.comments_limit > 0) {
      args.push('--comments-limit', String(params.comments_limit))
    }
  }
  // Catch-up only the comments pass over a specific list of post msg_ids.
  // Triggers Python to skip iter_messages entirely.
  if (Array.isArray(params._comments_only_post_ids) && params._comments_only_post_ids.length) {
    args.push('--include-comments')
    args.push('--comments-only-post-ids', params._comments_only_post_ids.join(','))
    if (params.comments_limit && params.comments_limit > 0) {
      args.push('--comments-limit', String(params.comments_limit))
    }
  }
  if (params._comments_only_source_id) {
    args.push('--include-comments')
    args.push('--comments-only-source-id', String(params._comments_only_source_id))
    if (params.comments_limit && params.comments_limit > 0) {
      args.push('--comments-limit', String(params.comments_limit))
    }
  }
  // On-demand media (re)processing of specific ALREADY-SAVED messages. The
  // user ticked voice/photo/doc rows in ChatView and pressed «перевести».
  // Python switches to mode=media_only: get_messages(ids=[...]) + process_media
  // per msg, no iter_messages walk. Results replay into captions on close via
  // the same tg_media_results stash → appendItemTranscript path as batch fetch.
  const isMediaOnly = Array.isArray(params._media_only_msg_ids)
                      && params._media_only_msg_ids.length > 0
  const isSingle = params.mode === 'single'
  const knownSourceIdRaw = params._source_id || params.source_id || params.source_id_hint
    || telegramSource?.id || null
  const knownSourceId = !isSingle && knownSourceIdRaw != null
    ? Number(knownSourceIdRaw)
    : null
  if (knownSourceId && Number.isFinite(knownSourceId) && knownSourceId > 0) {
    if (!params._range_plan_child) {
      for (const existing of jobs.values()) {
        if (existing?.type !== 'tg_fetch') continue
        if (Number(existing.source_id) !== Number(knownSourceId)) continue
        if (existing.status !== 'running' && existing.status !== 'awaiting_ai' && existing.status !== 'cancelling') continue
        if (params.request_id && existing.params?.request_id !== params.request_id) {
          throw Object.assign(new Error('Another Telegram fetch already owns this source'), { code: 'FETCH_SOURCE_BUSY', pre_spawn: true, existing_job_id: `desktop:${existing.id}` })
        }
        console.warn(`[Jobs] tg_fetch duplicate source #${knownSourceId} → reuse live #${existing.id} db #${existing.dbRowId || '-'}`)
        return existing.id
      }
    }
  }
  if (isMediaOnly) {
    args.push('--media-only-msg-ids', params._media_only_msg_ids.join(','))
  }

  // Skip-already-processed wiring. The user has a toggle «парсить заново»
  // (default OFF). Python reads the potentially huge ID map from library.db in
  // its own process. Previously Electron main selected, materialised,
  // JSON-stringified and wrote tens of thousands of IDs before spawn, freezing
  // the Parse click even though the actual fetch was asynchronous.
  const wantsAi = !!(params.process_voice || params.process_photo || params.process_docs)
  const allowReprocess = !!params.redo_processed
  // Ephemeral flows DO want re-processing every time:
  //   • mode='single' — paste of t.me/<chat>/<id>: produces a fresh .txt for
  //     THAT message, even if the same msg's transcript already lives in the
  //     channel's items table (single-mode is sourceless, doesn't re-use the
  //     items row for output). Skipping would emit empty .txt.
  //   • _comments_only_post_ids — comments-catch-up: doesn't process media,
  //     only walks discussion threads; skip is no-op but cheap to omit.
  const isEphemeral = isSingle
                       || (Array.isArray(params._comments_only_post_ids)
                           && params._comments_only_post_ids.length > 0)
                       || !!params._comments_only_source_id
                       // media-only: the user explicitly asked to (re)process
                       // these exact ids, possibly with a different engine.
                       // Building a skip-set would no-op the whole request.
                       || isMediaOnly
  let skipFilePath = null // legacy cleanup field; new runs do not create one
  if (wantsAi && !allowReprocess && (!isEphemeral || params.reuse_transcripts)) {
    if (telegramSource?.id) {
      args.push('--skip-processed-source-id', String(telegramSource.id))
    }
  }

  const startBits = [
    `[Jobs] start tg_fetch #${id}`,
    `target=${params.target}`,
    `mode=${params.mode}`,
    `limit=${params.limit || 'none'}`,
  ]
  if (knownSourceId && Number.isFinite(knownSourceId) && knownSourceId > 0) {
    startBits.push(`source=${knownSourceId}`)
  }
  if (usesStableTelegramTarget) startBits.push(`resolve_target=${workerTarget}`)
  if (params.sinceMessageId) startBits.push(`since=${params.sinceMessageId}`)
  if (Array.isArray(params.topic_ids) && params.topic_ids.length > 0) {
    startBits.push(`topics=${params.topic_ids.join(',')}`)
  }
  if (params.include_comments) startBits.push('comments=on')
  if (wantsAi) {
    startBits.push(`ai=${params.transcribe_engine || 'default'}`)
    startBits.push(`voice=${params.process_voice ? 'on' : 'off'}`)
    startBits.push(`photo=${params.process_photo ? 'on' : 'off'}`)
    startBits.push(`docs=${params.process_docs ? 'on' : 'off'}`)
  }
  if (allowReprocess) startBits.push('redo=on')
  console.log(startBits.join(' '))

  const spawnStartedMs = Date.now()
  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  console.log(`[Jobs] tg_fetch #${id} spawned pid=${child.pid || '-'} spawn_ms=${Date.now() - spawnStartedMs} setup_ms=${Date.now() - startStartedMs}`)

  const requestedDateRange = telegramRequestedDateRange(params)
  const job = {
    id,
    type: 'tg_fetch',
    target: params.target,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params },        // preserved for the detail panel
    items: [],                    // collected here, flushed to disk on close
    type_breakdown: {},           // {text: 12, voice: 3, ...}
    tg_session: tgSession,        // снимок на спавне — он же ушёл в --session
    child,
    _startStartedMs: startStartedMs,
    _telegramWorkerTarget: workerTarget,
    _usesStableTelegramTarget: usesStableTelegramTarget,
    _skipFilePath: skipFilePath,  // tmp file with already-processed external_ids;
                                  // removed in close handler.
    tg_requested_range: requestedDateRange,
    tg_progress: buildTelegramDateProgress(
      params,
      requestedDateRange,
      Number(params._range_plan_interval_index || 0),
      Number(params._range_plan_interval_total || 1),
    ),
  }
  job._closePromise = new Promise(resolve => { job._resolveClose = resolve })
  if (job.tg_progress) job.params = persistTelegramProgressParams(job)
  if (params._reserved_job_row_id) job.dbRowId = Number(params._reserved_job_row_id)
  if (job.tg_progress) markTelegramEtaPoint(job)
  // SourceDetail fetches already know their source_id before Python resolves
  // the Telegram entity. Seed it now and insert the running History row before
  // the potentially slow resolve pass; otherwise the page can look idle for
  // 20+ seconds and repeated clicks create duplicate live jobs.
  if (knownSourceId && Number.isFinite(knownSourceId) && knownSourceId > 0) {
    job.source_id = knownSourceId
    try {
      job.dbRowId = job.dbRowId || db.recordJob({
        type: job.type, source_id: job.source_id, status: 'running',
        items_total: null, items_done: 0,
        params: job.params, started_at: job.started_at,
      })
      console.log(`[Jobs] tg_fetch #${id} recordJob seeded row #${job.dbRowId} source #${job.source_id}`)
    } catch (err) {
      console.error('[Jobs] recordJob (seeded pending) failed', err)
    }
  }
  jobs.set(id, job)
  emit(job)

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt
    try { evt = JSON.parse(line) }
    catch { return }
    handleEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', async code => {
    const closeStartedMs = Date.now()
    if (job._cancelEscalationTimer) {
      clearTimeout(job._cancelEscalationTimer)
      job._cancelEscalationTimer = null
    }
    job.worker_finished_at = Math.floor(Date.now() / 1000)
    const cancelRequested = job._cancelRequested === true
      || job.status === 'cancelled'
      || job.status === 'cancelling'
    const processOutcome = resolveTelegramProcessOutcome({
      cancelRequested,
      exitCode: code,
      protocolDone: job._protocolDone === true,
      protocolError: job._protocolError === true,
      error: job.error || null,
      stderrTail,
    })
    let outcomeStatus = processOutcome.status
    job.error = processOutcome.error
    if (processOutcome.errorCode) job.error_code = job.error_code || processOutcome.errorCode
    // The suspicious-empty guard expects a candidate terminal outcome. Nothing
    // is emitted in this temporary state; public terminal status is published
    // only after persistence and the final jobs-row update succeed.
    job.status = outcomeStatus
    if (maybePromoteSuspiciousEmptyTelegramFetch(job)) outcomeStatus = job.status
    job._finalOutcome = outcomeStatus
    const dur = job.worker_finished_at - job.started_at
    const closeItemCount = Array.isArray(job.items) ? job.items.length : 0
    console.log(`[Jobs] close #${id} begin outcome=${outcomeStatus} code=${code} done_seen=${job._protocolDone ? 1 : 0} items=${closeItemCount} db #${job.dbRowId || '-'} source #${job.source_id || '-'}`)
    persistTelegramUnavailableFailure(job, `tg_fetch #${id}`)

    // Clean up the skip-processed JSON file (best-effort; missing file ok).
    if (job._skipFilePath) {
      try { fs.unlinkSync(job._skipFilePath) } catch {}
    }

    if (isAutoEmptyCatchUpFetch(job)
        && suppressJobHistoryRow(job, 'auto empty catchup')) {
      delete job.items
      job.phase = 'terminal'
      job.status = outcomeStatus
      job.finished_at = Math.floor(Date.now() / 1000)
      console.log(`[Jobs] end #${id} status=${job.status} items=${job.items_done} duration=${dur}s history=suppressed close_ms=${Date.now() - closeStartedMs}`)
      emit(job)
      markJobClosed(job)
      return
    }

    job.phase = 'finalizing'
    job.status = outcomeStatus === 'cancelled' ? 'cancelling' : 'running'
    job.finished_at = null
    emit(job)

    let finalizerResult = null
    let finalizerFallbackError = null
    const isSingle = job.params?.mode === 'single'
    const isMediaOnlyJob = job.params?.mode === 'media_only'
    const fname = isMediaOnlyJob ? null : jobFileName(job, { single: isSingle })
    const finalFilePath = fname ? path.join(JOBS_DIR, fname) : null
    const commentsFilePath = isSingle && fname
      ? path.join(JOBS_DIR, fname.replace(/\.txt$/, '_comments.txt'))
      : null
    const workerSummary = {
      id: job.id,
      type: job.type,
      target: job.target,
      params: job.params,
      entity: { title: job.entity_title, kind: job.entity_kind },
      status: outcomeStatus,
      error: job.error || null,
      warning: job.warning || null,
      started_at: job.started_at,
      finished_at: job.worker_finished_at,
      duration_sec: dur,
      items_total: closeItemCount,
      type_breakdown: job.type_breakdown,
    }
    try {
      finalizerResult = await finalizeTelegramJob({
        id: job.id,
        source_id: job.source_id || null,
        dbRowId: job.dbRowId || null,
        items: Array.isArray(job.items) ? job.items : [],
        params: job.params || {},
        outcomeStatus,
        type_breakdown: job.type_breakdown || {},
        mediaResults: Array.isArray(job.tg_media_results) ? job.tg_media_results : [],
        tg_voice: job.tg_voice || null,
        commentsBuffer: Array.isArray(job.tg_comments_buffer) ? job.tg_comments_buffer : [],
        isSingle,
        isMediaOnly: isMediaOnlyJob,
        filePath: finalFilePath,
        commentsFilePath,
        summary: workerSummary,
      }, {
        onProgress: info => {
          updateTelegramSavingProgress(job, info)
          job.params = persistTelegramProgressParams(job)
          emit(job)
        },
      })
      job.file_path = finalizerResult.file_path || null
      job.file_path_comments = finalizerResult.file_path_comments || null
      delete job.tg_comments_buffer
      console.log(`[TelegramFinalizer] #${id} worker rows=${finalizerResult.rows || 0} media=${finalizerResult.mediaApplied || 0} took ${finalizerResult.durationMs || 0}ms`)
    } catch (err) {
      // Idempotent fallback preserves capability if a packaged worker cannot
      // start. The worker writes sidecars atomically; repeated item/media
      // upserts are already idempotent. This path is intentionally loud so a
      // performance regression cannot masquerade as normal operation.
      finalizerFallbackError = err
      console.error(`[TelegramFinalizer] #${id} worker failed; falling back to main`, err)
    }

    let finalizeFailure = null
    let persistedRows = finalizerResult ? Number(finalizerResult.rows || 0) : null
    let persistedMedia = finalizerResult ? Number(finalizerResult.mediaApplied || 0) : null

    // 1. Persist all items into SQLite (idempotent UPSERT — re-fetches don't dup).
    try {
      if (!finalizerResult && job.source_id && job.items.length) {
        const prepareRowsStartedMs = Date.now()
        const rows = job.items.map(it => ({
          source_id:        job.source_id,
          external_id:      String(it.id),
          type:             it.type || 'other',
          url:              null,
          title:            null,
          caption:          it.text || null,
          published_at:     it.date ? Math.floor(new Date(it.date).getTime() / 1000) : null,
          duration_seconds: it.duration || null,
          views:            null,
          likes:            null,
          comments:         null,
          sender:           it.sender || null,
          has_media:        !!it.has_media,
          raw_meta:         telegramRawMetaFromItem(it),
          topic_id:         it.topic_id != null ? it.topic_id : null,
          topic_title:      it.topic_title || null,
          parent_external_id: it.parent_external_id || null,
          // tg_fetch_json reads reply state authoritatively from Telethon —
          // mark every fresh row as resolved so the backfill skips it.
          reply_resolved: true,
          // Reactions: array | [] | null. Mirror the reply_resolved pattern:
          // mark resolved=true only when Telethon actually returned the
          // attribute (`reactions !== undefined`). Null means "not seen
          // by this fetch" → backfill picks it up.
          reactions:          it.reactions === undefined ? null : it.reactions,
          reactions_resolved: it.reactions !== undefined,
        }))
        console.log(`[Jobs] close #${id} prepared item rows rows=${rows.length} took ${Date.now() - prepareRowsStartedMs}ms`)
        const dbStartedMs = Date.now()
        await bulkUpsertItemsYielding(rows, {
          jobId: id,
          sourceId: job.source_id,
          onProgress: info => {
            updateTelegramSavingProgress(job, info)
            job.params = persistTelegramProgressParams(job)
            emit(job)
          },
        })
        persistedRows = rows.length
        console.log(`[Jobs] close #${id} bulkUpsertItems rows=${rows.length} source #${job.source_id} took ${Date.now() - dbStartedMs}ms`)
      }

      // Replay any AI-processed media results stashed during the fetch (voice
      // transcripts, photo descriptions, PDF extracts) into the matching item
      // captions. appendItemTranscript UPDATEs an EXISTING row by external_id —
      // for a normal fetch the bulkUpsert above created the rows first; for
      // media_only re-processing the rows already existed (the user picked
      // already-saved messages), so this runs on its own with an empty
      // job.items. Guarded by source_id + a non-empty stash, NOT by
      // job.items.length — otherwise on-demand transcription would silently
      // drop its results.
      const stash = Array.isArray(job.tg_media_results) ? job.tg_media_results : []
      if (!finalizerResult && job.source_id && stash.length) {
        const mediaStartedMs = Date.now()
        let applied = 0
        for (const r of stash) {
          try {
            const id = db.appendItemTranscript({
              source_id:   job.source_id,
              external_id: r.msg_id,
              text:        r.text,
              engine:      r.engine,
              kind:        r.kind,
            })
            if (id) applied++
          } catch (err) {
            console.error(`[Jobs] appendItemTranscript (${r.kind}) failed for msg=${r.msg_id}`, err)
          }
        }
        console.log(`[Jobs] close #${id} applied ${applied}/${stash.length} media results to items took ${Date.now() - mediaStartedMs}ms`)
        persistedMedia = applied
      }
    } catch (err) {
      console.error('[Jobs] DB write failed', err)
      finalizeFailure = finalizeFailure || err
    }

    // 2. Per-type coverage records (the jobs row itself is finalised AFTER
    //    file save below so file_path can be persisted in the same UPDATE).
    try {
      const coverageTypes = telegramCoverageTypesForParams(job.params || {}, job.type_breakdown || {})
      const useRequestedDateRange = job.tg_requested_range
        && isSourceWideTelegramCoverageParams(job.params || {})
        && (job.params?.mode || '') === 'from_date'
      const coverageDateFrom = useRequestedDateRange ? job.tg_requested_range.start : job.date_min
      const coverageDateTo = useRequestedDateRange ? job.tg_requested_range.end : job.date_max
      if (job.source_id && outcomeStatus === 'done' && job.dbRowId
          && coverageTypes.length
          && Number.isFinite(Number(coverageDateFrom))
          && Number.isFinite(Number(coverageDateTo))) {
        const coverageStartedMs = Date.now()
        for (const contentType of coverageTypes) {
          db.recordCoverage({
            source_id:    job.source_id,
            job_id:       job.dbRowId,
            date_from:    Number(coverageDateFrom),
            date_to:      Number(coverageDateTo),
            content_type: contentType,
            // metadata for now — depth bumps to 'media' / 'transcribed' as we
            // download files / transcribe in later jobs.
            depth: 'metadata',
            items_count: Number(job.type_breakdown?.[contentType] || 0),
          })
        }
        console.log(`[Jobs] close #${id} coverage types=${coverageTypes.length} range=${coverageDateFrom}..${coverageDateTo} requested=${useRequestedDateRange ? 1 : 0} took ${Date.now() - coverageStartedMs}ms`)
      }
    } catch (err) {
      console.error('[Jobs] coverage write failed', err)
      finalizeFailure = finalizeFailure || err
    }

    // 3. Flush sidecar file. Two shapes depending on intent:
    //    - single-message:  plain .txt with the message body (and a stub
    //      line if the message is voice-only — full transcription is a
    //      pending feature, see CLAUDE.md). The user's expectation here
    //      mirrors YouTube single / local-file: Copy in JobDetail puts
    //      readable text in the clipboard, not JSON.
    //    - everything else: JSON sidecar — raw export so the user can
    //      re-process via "Open in Sublime" and the structure is preserved.
    const saveStartedMs = Date.now()
    try {
      if (finalizerResult) {
        // DB and sidecars were finalized in the worker. Keep the compact
        // params hydration below in main because it is tiny and feeds the
        // existing historic JobDetail contract.
      } else {
      // Media-only re-processing has no meaningful sidecar to write — the
      // results are appended directly into the existing items' captions (replay
      // above), and job.items is empty. A JSON dump of {summary, items:[]} would
      // just be a dead file in jobs/. Skip the write; the params-persist below
      // still runs so the historic JobDetail keeps its media_phase drill-down.
      const fpath = finalFilePath
      if (isMediaOnlyJob) {
        // no file
      } else if (isSingle) {
        const it = job.items[0] || {}
        const senderLine = it.sender ? `${it.sender}\n\n` : ''
        const textLine   = it.text ? it.text.trim() : ''
        const isAudio    = it.has_media && (it.type === 'voice' || it.type === 'audio')
        // Voice block: transcript if we got one, error note if we tried
        // and failed, placeholder otherwise (engine wasn't requested).
        let voiceLine = ''
        if (isAudio) {
          if (job.tg_voice?.text) {
            const heading = job.tg_voice.engine
              ? `[голосовое — расшифровка · ${job.tg_voice.engine}]`
              : '[голосовое — расшифровка]'
            voiceLine = `\n\n${heading}\n${job.tg_voice.text.trim()}`
          } else if (job.tg_voice?.error) {
            voiceLine = `\n\n[голосовое — расшифровка не удалась: ${job.tg_voice.error}]`
          } else if (!job.params?.transcribe_engine) {
            voiceLine = '\n\n[голосовое сообщение — транскрипция не запрошена]'
          }
        }
        const body = `${senderLine}${textLine}${voiceLine}`.trim() + '\n'
        fs.writeFileSync(fpath, body, 'utf8')
        // Sidecar comments file. Always written on a successful fetch when
        // the user opted in via «+ comm» on the split-chip — even at zero
        // rows. The renderer's «📋 Комменты» button stays enabled and
        // clicking copies the header line («комментарии (0) — нет»), so
        // user gets explicit confirmation that the side-fetch ran and there
        // really are no comments. Without this, an empty buffer would
        // suppress the file and the button would render disabled, looking
        // identical to «we didn't try». On error/cancel we skip — there's
        // no «we tried» signal to confirm.
        if (job.params?.include_comments && outcomeStatus === 'done') {
          const cBuf = Array.isArray(job.tg_comments_buffer) ? job.tg_comments_buffer : []
          const cName = fname.replace(/\.txt$/, '_comments.txt')
          const cPath = path.join(JOBS_DIR, cName)
          const collected = cBuf.length
          let cBody
          if (collected === 0) {
            cBody = `--- комментарии (0) ---\n(под этим постом нет комментариев)\n`
          } else {
            cBody = `--- комментарии (${collected}) ---\n` + formatCommentsBlock(cBuf) + '\n'
          }
          fs.writeFileSync(cPath, cBody, 'utf8')
          job.file_path_comments = cPath
          // Free memory; the buffer is on disk now.
          delete job.tg_comments_buffer
        }
      } else {
        const summary = {
          id: job.id,
          type: job.type,
          target: job.target,
          params: job.params,
          entity: { title: job.entity_title, kind: job.entity_kind },
          status: outcomeStatus,
          error: job.error || null,
          warning: job.warning || null,
          started_at: job.started_at,
          finished_at: job.worker_finished_at,
          duration_sec: dur,
          items_total: job.items.length,
          type_breakdown: job.type_breakdown,
        }
        const stringifyStartedMs = Date.now()
        const payload = JSON.stringify({ summary, items: job.items }, null, 2)
        const stringifyMs = Date.now() - stringifyStartedMs
        const writeStartedMs = Date.now()
        fs.writeFileSync(fpath, payload, 'utf8')
        console.log(`[Jobs] close #${id} sidecar json items=${job.items.length} stringify_ms=${stringifyMs} write_ms=${Date.now() - writeStartedMs}`)
      }
      job.file_path = fpath
      }
      // Snapshot key fields into params so the historic-row hydration path
      // (rowToTgSingleSnapshot) can render the JobDetail header without
      // re-reading the txt. Keeps restoration cheap and offline-safe.
      if (isSingle) {
        job.params = {
          ...job.params,
          entity_title: job.entity_title || null,
          type_breakdown: job.type_breakdown,
          file_path_comments: job.file_path_comments || null,
          tg_comments: job.tg_comments || null,
          has_discussion: job.has_discussion === true,
          _tg_attachment: job.tg_attachment || null,
          _tg_forward: job.tg_forward || null,
        }
      }
      // media_phase + type_breakdown live in-memory only; reaping the job
      // (or an Electron restart) wipes them. Persist compact snapshots into
      // parameters_json so the historic JobDetail can still expand
      // «Видео 60 ⚠14» into the per-msg failure list and render the chip
      // row at all. media_phase is conditional (most jobs have no media),
      // type_breakdown is unconditional when populated.
      try {
        const mpPublic = _publicMediaPhase(job.media_phase)
        const next = { ...(job.params || {}) }
        if (mpPublic) next._media_phase = mpPublic
        if (job.type_breakdown && Object.keys(job.type_breakdown).length) {
          next._type_breakdown = job.type_breakdown
        }
        // Persist the empty-result warning so a historic JobDetail (rebuilt
        // from the DB row after restart) still explains why 0 items landed.
        if (job.warning) next._warning = job.warning
        if (job.error_code) next._error_code = job.error_code
        finishTelegramProgress(job)
        if (job.tg_progress) next._tg_progress = publicTelegramProgress(job.tg_progress)
        job.params = next
      } catch (err) {
        console.error('[Jobs] media_phase persist failed', err)
      }
      console.log(`[Jobs] saved #${id} → ${job.file_path || '-'} (${Date.now() - saveStartedMs}ms)`)
    } catch (err) {
      console.error(`[Jobs] save failed after ${Date.now() - saveStartedMs}ms`, err)
      finalizeFailure = finalizeFailure || err
    }

    if (outcomeStatus === 'done' && finalizeFailure) {
      outcomeStatus = 'error'
      job.error_code = 'finalize_failed'
      job.error = `Не удалось сохранить результат: ${finalizeFailure.message || finalizeFailure}`
    }
    job.status = outcomeStatus
    job.phase = 'terminal'
    job.finished_at = Math.floor(Date.now() / 1000)
    finishTelegramProgress(job)
    job.params = persistTelegramProgressParams(job)
    if (job.error_code) job.params._error_code = job.error_code
    if (job.params?.request_id || job.params?.full_history) {
      job.fetch_report = { ...(job.fetch_report || {}), persistence: {
        metadata_rows_received: closeItemCount,
        metadata_rows_upserted: persistedRows ?? (closeItemCount === 0 ? 0 : null),
        media_results_received: Array.isArray(job.tg_media_results) ? job.tg_media_results.length : 0,
        media_results_applied: persistedMedia ?? (job.tg_media_results?.length ? null : 0),
        count_semantics: 'upserted_input_rows_not_new_insert_count',
        finalization_succeeded: !finalizeFailure,
      } }
      job.params._fetch_report = job.fetch_report
    }

    // Finalise the jobs row (started as status='running' on entity-resolve).
    // Single UPDATE — same id throughout the job lifecycle.
    try {
      if (job.dbRowId) {
        const finalUpdateStartedMs = Date.now()
        db.updateJob(job.dbRowId, {
          status: job.status,
          items_total: job.items_done, items_done: job.items_done,
          error: job.error || null,
          finished_at: job.finished_at,
          file_path: job.file_path || null,
          // Re-persist params now that close-handler stuffed _media_phase
          // (and, for single-mode, entity_title / type_breakdown) into them.
          // db.updateJob only writes params when explicitly passed.
          params: job.params || null,
        })
        console.log(`[Jobs] close #${id} updateJob row #${job.dbRowId} took ${Date.now() - finalUpdateStartedMs}ms`)
      } else if (job.params?.mode === 'single' && job.status !== 'running') {
        // Single-message run: source_id was deliberately omitted, but we
        // still want a history row so the user can find the result later.
        const finalInsertStartedMs = Date.now()
        db.recordJob({
          type: job.type, source_id: null, status: job.status,
          items_total: job.items_done, items_done: job.items_done,
          error: job.error || null,
          params: job.params,
          started_at: job.started_at,
          finished_at: job.finished_at,
          file_path: job.file_path || null,
        })
        console.log(`[Jobs] close #${id} recordJob final single took ${Date.now() - finalInsertStartedMs}ms`)
      }
    } catch (err) {
      console.error('[Jobs] updateJob (final) failed', err)
      if (job.status === 'done') {
        job.status = 'error'
        job.error_code = 'finalize_failed'
        job.error = `Результат сохранён, но не удалось завершить запись задачи: ${err.message || err}`
      }
    }

    // Free memory.
    delete job.items

    console.log(`[Jobs] end #${id} status=${job.status} items=${job.items_done} duration=${dur}s close_ms=${Date.now() - closeStartedMs}ms finalizer=${finalizerResult ? 'worker' : finalizerFallbackError ? 'main-fallback' : 'main'}${job.error ? ' error=' + job.error : ''}`)
    emit(job)
    markJobClosed(job)
    // Auto-index begins only after the durable terminal revision is visible to
    // every consumer. Selection/embedding run in index-worker, so this does not
    // block main or the Telegram close promise.
    void startAutoIndexAfterTelegramFetch(job)
  })

  return id
}

/**
 * Catch-up only the comments for a Telegram channel: skip the messages-fetch
 * loop entirely, walk the discussion threads of an explicit post-id list.
 * Used by the «Дотянуть комментарии» button in SourceDetail when posts are
 * already in the items table but no/few comments have been pulled yet.
 *
 * Runs as a regular tg_fetch job with a synthetic mode='last_n' just to
 * satisfy argparse — Python's `--comments-only-post-ids` shortcuts the
 * iter_messages loop. Per-post atomicity (bulk-insert each `comments` event
 * independently) means a cancel keeps everything fetched so far.
 */
function startTelegramCommentsCatchUp(params) {
  if (!params.source_id && (!Array.isArray(params.post_ids) || params.post_ids.length === 0)) {
    throw new Error('source_id or post_ids required')
  }
  return startTelegramFetch({
    target:                    params.target,
    mode:                      'last_n',
    limit:                     1,                    // dummy; iter loop is skipped
    include_comments:          true,
    comments_limit:            params.comments_limit || 0,
    _comments_only_source_id:  params.source_id || null,
    _comments_only_post_ids:   params.source_id ? null : params.post_ids,
    _source_id:                params.source_id || null,
  })
}

// Lazily-grown aggregate per media kind. Drives the unified <JobProgress>
// component on the renderer. Each kind has:
//   total   — count of *seen* msg_ids since fetch start (lazy: bumped the first
//             time we observe a msg in any progress/final event for that kind)
//   done    — count of finalised msg_ids (transcript/photo-text/pdf-text)
//   errors  — count of msg_ids that failed (media-error)
//   current — { msg_id, stage, engine, elapsed_sec?, audio_duration_sec? }
//             of the most recently seen *unfinished* msg. null when nothing
//             is in flight.
//   _seen   — Set of msg_ids ever observed (Total denominator). Internal,
//             not snapshotted.
//   _finished — Set of msg_ids that have already produced a final or error
//             event. Used to debounce double-counting if Python emits both.
// Snapshot helper: returns a JSON-safe copy without the internal Sets.
// Returns null when the job never touched media — keeps snapshot compact for
// the 99% of jobs that don't process AI media.
function _publicMediaPhase(mp) {
  if (!mp) return null
  const out = {}
  let touched = false
  for (const k of ['voice', 'photo', 'pdf']) {
    const s = mp[k]
    if (!s) continue
    if (s.total === 0 && s.done === 0 && s.errors === 0 && (s.skipped || 0) === 0 && !s.current) continue
    out[k] = {
      total:   s.total || 0,
      done:    s.done || 0,
      errors:  s.errors || 0,
      skipped: s.skipped || 0,
      current: s.current || null,
      errors_log:  Array.isArray(s.errors_log)  ? s.errors_log.slice(-ERRORS_LOG_CAP)  : [],
      skipped_log: Array.isArray(s.skipped_log) ? s.skipped_log.slice(-ERRORS_LOG_CAP) : [],
    }
    touched = true
  }
  return touched ? out : null
}

function _ensureMediaPhase(job) {
  if (!job.media_phase) {
    // errors_log keeps the last ~20 per-kind {msg_id, message} pairs so the UI
    // can show the user *what failed* (not just a counter). 20 is enough for
    // a glance — user can open the .json export for the full list.
    const mk = () => ({
      total: 0, done: 0, errors: 0, skipped: 0,
      current: null, errors_log: [], skipped_log: [],
      _seen: new Set(), _finished: new Set(),
    })
    job.media_phase = { voice: mk(), photo: mk(), pdf: mk() }
  }
  return job.media_phase
}

const ERRORS_LOG_CAP = 20

function _bumpSeen(slot, msg_id) {
  if (msg_id == null) return
  const key = String(msg_id)
  if (!slot._seen.has(key)) {
    slot._seen.add(key)
    slot.total += 1
  }
}

function _recordMediaProgress(job, kind, evt) {
  const phase = _ensureMediaPhase(job)
  const slot = phase[kind]
  if (!slot) return  // unknown kind, defensive
  _bumpSeen(slot, evt.msg_id)
  // Sticky audio_duration_sec: later events for the SAME msg_id win when
  // they carry duration (AAI's `queued` tick supersedes our pre-AAI probe),
  // but events that omit duration don't blank out a previously-known value.
  // Without this the UI would show «аудио 0:42» on `downloading`, lose it on
  // `uploading`, re-acquire it on `queued` — flicker.
  const prev = slot.current
  const sameMsg = !!(prev && evt.msg_id != null && prev.msg_id === String(evt.msg_id))
  const prevDur = sameMsg ? prev.audio_duration_sec : null
  // 'completed' is the AAI final tick before the actual `transcript` event —
  // we keep it as `current` until the transcript final clears it, so the UI
  // shows ✓ for ~one frame instead of bouncing back to idle.
  slot.current = {
    msg_id:             evt.msg_id != null ? String(evt.msg_id) : null,
    stage:              evt.stage || null,
    engine:             evt.engine || null,
    aai_status:         evt.aai_status || null,
    elapsed_sec:        evt.elapsed_sec ?? null,
    audio_duration_sec: evt.audio_duration_sec ?? prevDur ?? null,
    file_name:          evt.file_name ?? (sameMsg ? prev?.file_name : null) ?? null,
  }
}

function _recordMediaFinal(job, kind, msg_id) {
  const phase = _ensureMediaPhase(job)
  const slot = phase[kind]
  if (!slot) return
  _bumpSeen(slot, msg_id)  // final event might arrive without a prior progress
  if (msg_id != null) {
    const key = String(msg_id)
    if (!slot._finished.has(key)) {
      slot._finished.add(key)
      slot.done += 1
    }
  }
  // Clearing `current` only when the finalised msg_id matches the one we were
  // tracking — avoids races where two msgs are processed concurrently and the
  // final for msg A clears the in-flight progress for msg B.
  if (slot.current && msg_id != null && slot.current.msg_id === String(msg_id)) {
    slot.current = null
  }
}

// Skipped events (e.g. silent video pre-checked by ffprobe) increment a
// dedicated counter, NOT errors or done. UI shows them grey so the user
// can see «5 голосовых · 1 скип · 4 на обработке» instead of «5/8 errors».
function _recordMediaSkipped(job, kind, msg_id, reason) {
  const phase = _ensureMediaPhase(job)
  const slot = phase[kind]
  if (!slot) return
  _bumpSeen(slot, msg_id)
  if (msg_id != null) {
    const key = String(msg_id)
    if (!slot._finished.has(key)) {
      slot._finished.add(key)
      slot.skipped = (slot.skipped || 0) + 1
    }
  }
  // Stash the reason so UI can show «msg #X · нет звуковой дорожки» on demand.
  slot.skipped_log = slot.skipped_log || []
  slot.skipped_log.push({
    msg_id: msg_id != null ? String(msg_id) : null,
    reason: String(reason || ''),
  })
  if (slot.skipped_log.length > ERRORS_LOG_CAP) {
    slot.skipped_log.splice(0, slot.skipped_log.length - ERRORS_LOG_CAP)
  }
  if (slot.current && msg_id != null && slot.current.msg_id === String(msg_id)) {
    slot.current = null
  }
}

function _recordMediaError(job, kind, msg_id, message) {
  const phase = _ensureMediaPhase(job)
  const slot = phase[kind]
  if (!slot) return
  _bumpSeen(slot, msg_id)
  if (msg_id != null) {
    const key = String(msg_id)
    if (!slot._finished.has(key)) {
      slot._finished.add(key)
      slot.errors += 1
    }
  }
  // Keep the actual error message — UI shows it in the «Не удалось» panel.
  // Cap at ERRORS_LOG_CAP so a chat with hundreds of bad voices doesn't blow
  // up the snapshot size (full picture lives in the .json export).
  if (message) {
    slot.errors_log.push({
      msg_id: msg_id != null ? String(msg_id) : null,
      message: String(message),
    })
    if (slot.errors_log.length > ERRORS_LOG_CAP) {
      slot.errors_log.splice(0, slot.errors_log.length - ERRORS_LOG_CAP)
    }
  }
  if (slot.current && msg_id != null && slot.current.msg_id === String(msg_id)) {
    slot.current = null
  }
}

function handleEvent(job, evt) {
  emitEvent(job, evt)
  switch (evt.type) {
    case 'resolve_progress':
      // Pre-entity dialog walk progress — emitted by tg_fetch_json's
      // _resolve_via_dialog_walk fallback when get_entity() failed and Python
      // is scanning iter_dialogs() to find a private chat by title. Surface
      // the count on the job so ActivityPanel/JobDetail can render
      // «просмотрено N…» instead of an opaque pre-entity spinner. Cleared
      // implicitly once `entity` arrives (UI prefers entity_title).
      job.resolve_scanned = evt.scanned || 0
      break
    case 'entity':
      job.entity_title = evt.title || evt.username
      job.entity_kind  = evt.kind
      // Cache discussion-availability flag so the renderer can show / hide
      // the comments row on done without a second IPC. Comes from
      // GetFullChannel.full_chat.linked_chat_id on the Python side.
      job.has_discussion = !!evt.has_discussion
      const resolveMs = job._startStartedMs ? Date.now() - job._startStartedMs : null
      console.log(`[Jobs] tg_fetch #${job.id} entity=${evt.title || evt.username || evt.id} has_discussion=${!!evt.has_discussion} resolve_ms=${resolveMs == null ? '-' : resolveMs}`)
      // Single-message fetch (paste of t.me/<chat>/<id>) is a transient
      // history-only operation — don't pollute the Library with a source
      // row for a chat the user might have no intent to subscribe to.
      // Items also stay out of the items table (close handler checks
      // job.source_id before bulkUpsertItems).
      const isSingle = job.params?.mode === 'single'
      if (!isSingle) {
        // Folder-driven fetches (chosen via TelegramScreen папка-таба, not by
        // direct paste of @handle) are bulk operations on chats the user
        // hasn't necessarily promoted to "main" sidebar entries. Don't flip
        // is_explicit on those — keep the same flag the folder resolver set.
        // Direct fetches (paste @durov, channel-config form) keep going to
        // is_explicit=true. Note: is_explicit only ever LATCHES UP in
        // upsertSource — a chat that's already 1 stays 1.
        const fromFolder = !!job.params?._folder_umbrella_id
        try {
          const upsertStartedMs = Date.now()
          job.source_id = db.upsertSource({
            platform: 'telegram',
            handle:   evt.username || job.target,
            display_name: evt.title,
            external_id:  String(evt.id || ''),
            avatar_url:   evt.avatar_path || null,
            meta: { kind: evt.kind, username: evt.username },
            mark_synced: job.params?.mode !== 'id_list',
            is_explicit: !fromFolder,
            tg_session: job.tg_session || null,
          })
          console.log(`[Jobs] tg_fetch #${job.id} upsertSource source #${job.source_id} took ${Date.now() - upsertStartedMs}ms`)
          clearTelegramUnavailableAfterLiveResolve(job.source_id, `tg_fetch #${job.id}`)
        } catch (err) {
          console.error('[Jobs] upsertSource failed', err)
        }
        // Persist has_discussion as soon as we know — drives the
        // «Комментарии» checkbox enabled/disabled state in the form
        // even before any items arrive.
        if (typeof evt.has_discussion === 'boolean' && job.source_id) {
          try { db.setSourceHasDiscussion(job.source_id, evt.has_discussion) }
          catch (err) { console.error('[Jobs] setSourceHasDiscussion failed', err) }
        }
        // Insert a pending jobs row so "История парсинга" can show a spinner
        // while the fetch is still in progress. Finalised in the close handler
        // via db.updateJob(...) — no second INSERT, same row id.
        try {
          if (job.source_id && job.dbRowId && job.params?.request_id) db.updateJob(job.dbRowId, { source_id: job.source_id })
          if (job.source_id && !job.dbRowId) {
            const pendingStartedMs = Date.now()
            job.dbRowId = db.recordJob({
              type: job.type, source_id: job.source_id, status: 'running',
              items_total: null, items_done: 0,
              params: job.params, started_at: job.started_at,
            })
            console.log(`[Jobs] tg_fetch #${job.id} recordJob pending row #${job.dbRowId} took ${Date.now() - pendingStartedMs}ms`)
          }
        } catch (err) {
          console.error('[Jobs] recordJob (pending) failed', err)
        }
      }
      emit(job)
      break
    case 'item':
      job.items_done = (job.items_done || 0) + 1
      job.items.push(evt.data)
      job.tg_current_item = evt.data
      updateTelegramDateProgress(job, evt.data)
      const t = (evt.data && evt.data.type) || 'other'
      job.type_breakdown[t] = (job.type_breakdown[t] || 0) + 1
      if (job.params?.mode === 'single') {
        job.tg_attachment = Array.isArray(evt.data?.media) ? (evt.data.media[0] || null) : null
        job.tg_forward = evt.data?.forward || null
      }

      // Track date range for coverage record
      const ts = evt.data && evt.data.date ? Math.floor(new Date(evt.data.date).getTime() / 1000) : null
      if (ts) {
        if (!job.date_min || ts < job.date_min) job.date_min = ts
        if (!job.date_max || ts > job.date_max) job.date_max = ts
      }
      // Throttled progress emit. fact-ipc.md flagged "no per-item emit" as
      // a rule because the renderer lags when 5000 events fire back-to-back,
      // BUT the previous workaround of emitting only on `page` events (every
      // 100 items) means the user sees 0 → 0 → 0 → final. Compromise: rate-
      // limit to ~4 emits/sec — UI feels live, ipcRenderer doesn't drown.
      // The throttle is per-job (jobs.Map shared global), so two parallel
      // fetches don't starve each other.
      const now = Date.now()
      if (!job._lastProgressEmit || now - job._lastProgressEmit > 250) {
        job._lastProgressEmit = now
        emit(job)
      }
      // Cheap mid-run DB sync. Activity reads in-memory snapshot (live
      // counter), but SourceDetail's «История парсинга» and a JobDetail
      // opened from history read from the jobs table. Without this, the
      // two views diverge between page boundaries (Activity 84 ↔ History 0).
      // One UPDATE every 10 items is ~5ms — negligible compared to the
      // Telegram round-trip and any media processing. Page-event still
      // wins on its own boundary; this just narrows the gap in between.
      if (job.dbRowId && (job.items_done % 10) === 0) {
        try { db.updateJob(job.dbRowId, { items_done: job.items_done }) }
        catch (err) { console.error('[Jobs] tg_fetch item-tick updateJob failed', err) }
      }
      break
    case 'page':
      job.items_done = evt.loaded
      job.items_total = evt.limit || null
      if (job.tg_progress) markTelegramEtaPoint(job, { force: true })
      // Page boundary always emits — guaranteed update even if the throttle
      // skipped the last few items.
      job._lastProgressEmit = Date.now()
      emit(job)
      // Sync to DB so "История парсинга" / JobDetail (which read from the
      // `jobs` table, not the in-memory snapshot subscriber) see the live
      // counter. Page is every 100 items — single UPDATE is negligible.
      // Same fix made for tg_index in index-job.js.
      if (job.dbRowId) {
        try {
          const patch = { items_done: job.items_done }
          if (job.tg_progress) patch.params = persistTelegramProgressParams(job)
          db.updateJob(job.dbRowId, patch)
        }
        catch (err) { console.error('[Jobs] tg_fetch mid-run updateJob failed', err) }
      }
      break
    case 'comments':
      // One batch per post. For sourced fetches (channel/topic) we insert
      // into post_comments immediately — per-post atomic so a cancel keeps
      // coherent partial data. For sourceless single-message fetches we
      // buffer the rows in `tg_comments_buffer` and flush to a sidecar
      // .txt on close (no DB row to attach to). Either path: we never
      // drop the event, just route it to a different sink.
      if (Array.isArray(evt.comments) && evt.comments.length) {
        if (job.source_id) {
          try {
            db.bulkInsertComments(job.source_id, evt.comments)
          } catch (err) {
            console.error('[Jobs] bulkInsertComments failed', err)
          }
        } else if (job.params?.mode === 'single') {
          if (!Array.isArray(job.tg_comments_buffer)) job.tg_comments_buffer = []
          job.tg_comments_buffer.push(...evt.comments)
        }
      }
      break
    case 'comments_progress':
      // Drive the Activity progress bar via items_done/total during the
      // comments pass — by this point the messages-fetch finished and
      // items_done would otherwise sit at the post-count, looking frozen.
      job.tg_comments = {
        posts_done:         evt.posts_done,
        posts_total:        evt.posts_total,
        comments_collected: evt.comments_collected,
      }
      emit(job)
      break
    case 'comment_error':
      // Per-post failure — keep going, just count it. Surfaced in 'done' totals.
      console.warn(`[Jobs] tg comment_error post=${evt.post_id}: ${evt.message}`)
      break
    case 'speech-summary':
      job.fetch_report = { ...(job.fetch_report || {}), speech: evt.stats || evt.summary || {} }
      job.params._fetch_report = job.fetch_report
      if (job.dbRowId) { try { db.updateJob(job.dbRowId, { params: job.params }) } catch (error) { console.error('[Jobs] speech summary checkpoint failed', error.message) } }
      emit(job)
      break
    case 'flood-wait':
    case 'traversal':
      job.fetch_report = { ...(job.fetch_report || {}), ...evt }
      job.params._fetch_report = job.fetch_report
      if (job.dbRowId) { try { db.updateJob(job.dbRowId, { params: job.params }) } catch (error) { console.error('[Jobs] traversal checkpoint failed', error.message) } }
      emit(job)
      break
    case 'done':
      // Protocol done is not durable completion. Python still has to close and
      // Electron still has to commit SQLite + sidecars. Keep the public job
      // active until child.on('close') receives finalizer acknowledgement.
      job._protocolDone = true
      job.phase = 'draining'
      job.items_total = evt.items_total
      job.items_done = evt.items_total
      job.tg_current_item = null
      if (job.tg_progress) persistTelegramProgressParams(job)
      // Comments pass summary — surface in JobDetail.
      if (evt.comments_collected != null) {
        job.tg_comments = {
          ...(job.tg_comments || {}),
          comments_collected:  evt.comments_collected,
          comments_post_errors: evt.comments_post_errors || 0,
        }
      }
      emit(job)
      break
    case 'warning':
      // Non-fatal diagnostic — job still finishes `done`. Currently the only
      // emitter is tg_fetch_json's empty-result path («ничего не найдено»: 0
      // new messages, empty chat/dialog, future date, or filters excluded everything).
      // Carries a machine `code` (no_new_messages | empty_result | future_date) so the
      // renderer can branch structurally without matching the Russian text.
      // Surfaced in amber, beside (not instead of) job.error.
      job.warning = { message: evt.message, code: evt.code || null }
      console.log(`[Jobs] tg_fetch #${job.id} warning code=${evt.code || '-'}: ${evt.message}`)
      emit(job)
      break
    case 'error':
      job._protocolError = true
      job.error = evt.message
      // Machine token (e.g. "session_unauthorized") so the renderer can react
      // structurally — surface a global toast with a «Настройки» action —
      // without string-matching the human message. Optional; only set by
      // errors that carry one (tg_session_path.connect_authorized).
      if (evt.code) job.error_code = evt.code
      // status is set on 'close'
      break
    case 'media-progress': {
      // Unified per-msg progress for AI processing (voice/photo/pdf). Drives
      // both the per-kind aggregate counters in `media_phase` and the legacy
      // single-message tg_voice shape (TelegramSingleMessageForm reads it).
      _recordMediaProgress(job, evt.kind, evt)
      // Single-message form still reads tg_voice — keep that shape coherent.
      if (evt.kind === 'voice') {
        job.tg_voice = { ...(job.tg_voice || {}),
                         stage:             evt.stage,
                         engine:            evt.engine,
                         aai_status:        evt.aai_status,
                         aai_elapsed_sec:   evt.elapsed_sec,
                         aai_audio_dur_sec: evt.audio_duration_sec,
                         aai_transcript_id: evt.transcript_id }
      }
      // Batch fetch had `tg_media: {msg_id, stage, kind}` for the previous
      // single-current view. Keep populating it for any consumer still
      // reading the old shape (will retire once UI is fully on JobProgress).
      if (evt.kind === 'photo' || evt.kind === 'pdf') {
        job.tg_media = { ...(job.tg_media || {}),
                         msg_id: evt.msg_id, stage: evt.stage, kind: evt.kind }
      }
      emit(job)
      break
    }
    case 'media-error':
      _recordMediaError(job, evt.kind, evt.msg_id, evt.message)
      // Always log — same line shape regardless of kind, so grep-friendly.
      // Voice failures used to be silent (just stashed on tg_voice) which made
      // diagnosis impossible without a debugger; this gives the user (and us)
      // a paper trail in dev.log / production.log.
      console.error(`[Jobs] tg_fetch media-error kind=${evt.kind} msg=${evt.msg_id}: ${evt.message}`)
      if (evt.kind === 'voice') {
        job.tg_voice = { ...(job.tg_voice || {}),
                         stage: 'error', error: evt.message }
      }
      emit(job)
      break
    // Legacy aliases — Python now emits `media-progress`/`media-error` but
    // older consumers may be reading from a stale spawn. Same handling.
    case 'transcribe-progress':
      _recordMediaProgress(job, 'voice', evt)
      job.tg_voice = { ...(job.tg_voice || {}),
                       stage:               evt.stage,
                       engine:              evt.engine,
                       aai_status:          evt.aai_status,
                       aai_elapsed_sec:     evt.elapsed_sec,
                       aai_audio_dur_sec:   evt.audio_duration_sec,
                       aai_transcript_id:   evt.transcript_id }
      emit(job)
      break
    case 'transcribe-error':
      _recordMediaError(job, 'voice', evt.msg_id, evt.message)
      console.error(`[Jobs] tg_fetch transcribe-error msg=${evt.msg_id}: ${evt.message}`)
      job.tg_voice = { ...(job.tg_voice || {}), stage: 'error', error: evt.message }
      emit(job)
      break
    case 'vision-progress':
      _recordMediaProgress(job, 'photo', evt)
      job.tg_media = { ...(job.tg_media || {}),
                       msg_id: evt.msg_id, stage: evt.stage, kind: 'photo' }
      emit(job)
      break
    case 'doc-progress':
      _recordMediaProgress(job, 'pdf', evt)
      job.tg_media = { ...(job.tg_media || {}),
                       msg_id: evt.msg_id, stage: evt.stage, kind: 'pdf' }
      emit(job)
      break
    case 'vision-error':
      _recordMediaError(job, 'photo', evt.msg_id, evt.message)
      console.error(`[Jobs] tg_fetch vision-error msg=${evt.msg_id}: ${evt.message}`)
      emit(job)
      break
    case 'doc-error':
      _recordMediaError(job, 'pdf', evt.msg_id, evt.message)
      console.error(`[Jobs] tg_fetch doc-error msg=${evt.msg_id}: ${evt.message}`)
      emit(job)
      break

    case 'transcript':
      // Final transcript for the voice/audio.
      // Single-message: stash on job.tg_voice for the .txt export.
      // Batch: also append to the matching item's caption in DB so search
      // finds it. evt.msg_id is set by tg_fetch_json.process_media; absent
      // in legacy single-message events (those still hit the .txt path).
      _recordMediaFinal(job, 'voice', evt.msg_id)
      job.tg_voice = {
        ...(job.tg_voice || {}),
        stage: 'done',
        engine: evt.engine,
        text:   evt.text || '',
      }
      if (evt.msg_id != null) {
        // bulkUpsertItems for this fetch only runs on close, so the row
        // doesn't exist yet — stash and replay after the upsert. Single-
        // message mode (no source_id) skips DB entirely; the .txt export
        // still picks the transcript up via job.tg_voice.
        job.tg_media_results = job.tg_media_results || []
        job.tg_media_results.push({
          msg_id: String(evt.msg_id),
          kind:   'voice',
          engine: evt.engine,
          text:   evt.text || '',
        })
      }
      emit(job)
      break
    case 'photo-text':
      // Gemini Vision describe result. Stashed for replay after
      // bulkUpsertItems (same reason as 'transcript').
      _recordMediaFinal(job, 'photo', evt.msg_id)
      if (evt.msg_id != null) {
        job.tg_media_results = job.tg_media_results || []
        job.tg_media_results.push({
          msg_id: String(evt.msg_id),
          kind:   'photo',
          engine: evt.engine || 'gemini-vision',
          text:   evt.text || '',
        })
      }
      emit(job)
      break
    case 'pdf-text':
      _recordMediaFinal(job, 'pdf', evt.msg_id)
      if (evt.msg_id != null) {
        job.tg_media_results = job.tg_media_results || []
        job.tg_media_results.push({
          msg_id: String(evt.msg_id),
          kind:   'pdf',
          engine: evt.engine || 'gemini',
          text:   evt.text || '',
        })
      }
      emit(job)
      break
    case 'doc-skipped':
      // Non-PDF document (archive, executable, mp4 wrapped as document, …).
      // Not an error, just informational — Gemini's extract_pdf won't help.
      _recordMediaSkipped(job, 'pdf', evt.msg_id, evt.reason || `mime=${evt.mime}`)
      console.log(`[Jobs] tg_fetch doc-skipped msg=${evt.msg_id} mime=${evt.mime}: ${evt.reason}`)
      emit(job)
      break
    case 'media-skipped':
      // Pre-flight skip — we deliberately didn't send the file to AAI/Gemini
      // (e.g. silent video). Counts toward `total` so the user knows we saw
      // the file, but doesn't dirty the errors counter.
      _recordMediaSkipped(job, evt.kind, evt.msg_id, evt.reason)
      console.log(`[Jobs] tg_fetch media-skipped kind=${evt.kind} msg=${evt.msg_id}: ${evt.reason}`)
      emit(job)
      break
  }
}

function jobFileName(job, { single = false } = {}) {
  const safe = (s) => String(s || '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'job'
  const dt = new Date((job.started_at || Math.floor(Date.now() / 1000)) * 1000)
  const date = dt.toISOString().slice(0, 10)
  // single-message → plain text; channel/topic fetch → raw JSON export.
  const ext = single ? 'txt' : 'json'
  return `${date}_tg_${safe(job.target)}_${job.id}.${ext}`
}

function getJobDetail(id, { identity = null } = {}) {
  // Historic sourceless jobs use 'db-<rowId>' string ids (see listJobs).
  // Look up the row directly and dispatch by type — listSourcelessJobs is
  // type-scoped, so a one-shot fetch by primary key is both faster and
  // correct for any sourceless type (yt_transcribe, local_transcribe …).
  if (typeof id === 'string' && id.startsWith('db-')) {
    const rowId = Number(id.slice(3))
    if (!Number.isFinite(rowId)) return null
    try {
      const row = db.getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(rowId)
      if (!row) return null
      if (row.type === 'yt_transcribe')    return rowToYoutubeSnapshot(row)
      if (row.type === 'yt_comments')      return rowToYoutubeCommentsSnapshot(row)
      if (row.type === 'rutube_transcribe') return rowToRutubeSnapshot(row)
      if (row.type === 'local_transcribe') return rowToLocalSnapshot(row)
      if (row.type === 'boosty_transcribe') return rowToBoostySnapshot(row)
      // tg_fetch with source_id IS NULL → single-message run. Use the
      // single-shape snapshot so JobDetail's TelegramBody gets entity_title
      // and type_breakdown out of params (the live Map is empty after restart).
      if (row.type === 'tg_fetch' && row.source_id == null) return rowToTgSingleSnapshot(row)
      return rowToHistoricSnapshot(row)
    } catch { return null }
  }
  // Live in-memory job? Try direct lookup first, then fall back to a scan
  // by dbRowId — SourceDetail's «История парсинга» sends DB ids, not the
  // in-memory ones (the two sequences are independent). Same trick as
  // cancelJob; without this you get «Loading job…» forever in JobDetail
  // for a STILL-RUNNING fetch opened from history.
  let j = null
  if (identity !== 'db') {
    j = jobs.get(id)
    if (!j) {
      for (const candidate of jobs.values()) {
        if (candidate.dbRowId === id) { j = candidate; break }
      }
    }
  }
  if (j) return snapshot(j, { includeLiveItems: true })
  // Otherwise fall back to the DB row — happens for any historical job
  // opened from SourceDetail's «История парсинга» (tg_fetch, ig_profile_fetch,
  // ig_batch_transcribe, yt_batch_transcribe …). Without this, JobDetail
  // gets `null` after the live Map lookup and shows "Loading…" forever.
  try {
    const row = db.getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    if (!row) return null
    if (row.type === 'rutube_transcribe') return rowToRutubeSnapshot(row)
    if (row.type === 'boosty_transcribe') return rowToBoostySnapshot(row)
    return rowToHistoricSnapshot(row)
  } catch (err) {
    console.error('[Jobs] getJobDetail DB fallback failed', err)
    return null
  }
}

/**
 * Convert a `jobs` table row into the same shape `snapshot()` produces, so
 * JobDetail.jsx (which only knows the snapshot contract) can render it
 * uniformly. Per-type peculiarities:
 *   - tg_fetch: type_breakdown is not stored — leave null, JobDetail still
 *     shows status/items/duration.
 *   - ig_batch_transcribe / yt_batch_transcribe: rebuild a `yt_batch`-shaped
 *     summary from items_total/items_done/items_failed/cost_usd. Per-video
 *     log[] is in-memory only — empty here is fine, JobDetail derives the
 *     reel/video list from the items table via params.shortcodes /
 *     params.video_ids.
 */
function rowToHistoricSnapshot(row) {
  let params = null
  try { params = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
  const type = row.type
  const base = {
    id:           row.id,
    type,
    target:       params?.target || params?.url || (params?.shortcodes ? `batch:${params.shortcodes.length}` : ''),
    status:       row.status,
    items_done:   row.items_done || 0,
    items_total:  row.items_total != null ? row.items_total : null,
    error:        row.error || null,
    error_code:   params?._error_code || null,
    // Empty-result diagnostic stuffed into params on close — recover it so the
    // historic JobDetail still explains a 0-item fetch after Electron restart.
    warning:      params?._warning || null,
    tg_progress:  params?._tg_progress || null,
    started_at:   row.started_at || null,
    finished_at:  row.finished_at || null,
    entity_title: params?.entity_title || params?.title || null,
    entity_kind:  null,
    file_path:    row.file_path || null,
    params:       params || null,
    // Surfaced from parameters_json. type_breakdown is required to render
    // «По типам» chips at all; _media_phase carries per-kind errors_log /
    // skipped_log so each chip can still expand into the failure list.
    type_breakdown: params?._type_breakdown || null,
    source_id:    row.source_id || null,
    cost_usd:     row.cost_usd || 0,
    yt:           null,
    yt_channel:   null,
    yt_batch:     null,
    rutube:       null,
    tk:           null,
    tk_channel:   null,
    tk_batch:     null,
    boosty:       null,
    boosty_channel: null,
    boosty_batch: null,
    media_phase:  params?._media_phase || null,
  }
  // Re-create the per-batch shape so JobDetail's body components can render
  // saved/skipped/errors/cost from a finished historic row. Per-video log
  // lives in-memory only; JobDetail recovers per-item state by looking at
  // items.transcript_path via params.video_ids / params.shortcodes.
  const batchShape = {
    saved:    row.items_done || 0,
    skipped:  0,
    errors:   row.items_failed || 0,
    cost_usd: row.cost_usd || 0,
    current:  null,
    log:      [],
  }
  if (type === 'ig_batch_transcribe' || type === 'yt_batch_transcribe' || type === 'yt_batch_comments') {
    base.yt_batch = batchShape
  } else if (type === 'tk_batch_transcribe') {
    base.tk_batch = batchShape
  } else if (type === 'boosty_channel_fetch') {
    base.entity_kind = 'boosty_channel'
    base.boosty_channel = params?._boosty_channel || {
      posts_total: row.items_done || 0,
      catalog_complete: row.status === 'done',
    }
  } else if (type === 'boosty_batch_transcribe') {
    base.entity_kind = 'boosty_channel'
    base.boosty_batch = params?._boosty_batch || {
      mode: params?.mode || 'transcribe',
      saved: row.items_done || 0,
      cached: 0,
      errors: row.items_failed || 0,
      current: null,
      log: [],
    }
  } else if (type === 'tg_folder_fetch') {
    // Recover the folder umbrella shape from params._folder_summary which
    // close-handler stuffs into parameters_json. Without it, JobDetail
    // would render an empty "Чатов 0/0" block after a restart.
    base.tg_folder = params?._folder_summary || {
      folder_id: params?.folder_id || null,
      total_chats: row.items_total || 0,
      done_chats:  row.items_done || 0,
      per_chat:    [],
      total_items: 0,
    }
  } else if (type === 'tg_folder_refresh') {
    base.tg_folder_refresh = params?._summary || {
      total_folders: row.items_total || 0,
      done_folders:  row.items_done || 0,
      synced:        0,
      removed:       0,
    }
  } else if (type === 'tg_live_search' || type === 'tg_live_public_search'
    || type === 'tg_live_context' || type === 'tg_live_range'
    || type === 'tg_live_attachment' || type === 'tg_live_transcribe'
    || type === 'tg_live_join' || type === 'tg_live_leave'
    || type === 'tg_live_bot_info' || type === 'tg_live_bot_messages'
    || type === 'tg_live_bot_action' || type === 'tg_live_bot_action_status'
    || type === 'tg_live_membership_info' || type === 'tg_live_folder_read'
    || type === 'tg_live_folder_merge' || type === 'tg_live_folder_merge_status'
    || type === 'tg_live_bot_join' || type === 'tg_live_bot_join_status') {
    base.entity_kind = 'telegram_live'
    base.tg_live = params?._tg_live || {
      operation: type.replace('tg_live_', ''),
      stage: row.status === 'done' ? 'done' : row.status,
      steps_done: row.items_done || 0,
      steps_total: row.items_total || null,
      hits: row.items_done || 0,
      unique_hits: row.items_done || 0,
      result_available: false,
      truncated: false,
      duration_ms: null,
    }
  }
  return base
}

function cancelJob(id, { identity = null, type = null } = {}) {
  const numericId = Number(id)
  const requestedId = Number.isFinite(numericId) ? numericId : id
  console.log(`[Jobs] cancel requested id=${id}`)

  const cancelIndex = () => {
    try {
      const indexJob = require('./index-job')
      if (indexJob && typeof indexJob.cancelById === 'function' && indexJob.cancelById(requestedId)) {
        console.log(`[Jobs] cancel id=${id} handled by semantic index`)
        return true
      }
    } catch (err) {
      console.error('[Jobs] cancel semantic-index route failed', err && err.message || err)
    }
    return false
  }
  if ((typeof requestedId === 'string' && requestedId.startsWith('index-'))
      || (identity === 'db' && (type === 'tg_index' || type === 'yt_index' || type === 'boosty_index'))) {
    return cancelIndex()
  }

  // ActivityPanel sends in-memory `j.id`; SourceDetail's «История парсинга»
  // sends the SQLite `jobs.id` (it reads rows straight from the DB and the
  // renderer can't tell them apart from in-memory ids). The two are
  // independent integer sequences, so a DB id of 7 ≠ live id of 7. Look up
  // by either: first the in-memory Map (fast path), then a linear scan over
  // live jobs by dbRowId. Without this fallback the Stop button in History
  // silently no-ops while the same button in Activity works fine — same
  // job, two different ids. fact-jobs.md::Pending row context.
  let j = identity === 'db' ? null : jobs.get(requestedId)
  if (!j) {
    for (const candidate of jobs.values()) {
      if (candidate.dbRowId === requestedId) { j = candidate; break }
    }
  }
  if (!j) {
    if (identity !== 'db' && cancelIndex()) return true
    const active = Array.from(jobs.values())
      .map(job => `live #${job.id}/db #${job.dbRowId || '-'}/${job.type}`)
      .join(', ')
    console.log(`[Jobs] cancel id=${id} not found active=[${active}]`)
    return false
  }
  console.log(`[Jobs] cancel id=${id} matched live #${j.id} db #${j.dbRowId || '-'} type=${j.type} source #${j.source_id || '-'}`)
  if (telegramMembershipMutationInFlight(j)) {
    j.warning = {
      code: 'telegram_membership_commit_in_flight',
      message: 'Запрос на изменение участия уже передан Telegram; ждём подтверждение результата.',
    }
    console.warn(`[Jobs] cancel id=${id} refused: ${j.type} membership RPC already in flight`)
    emit(j)
    return false
  }
  if (telegramBotMutationInFlight(j)) {
    j.warning = { code: 'telegram_bot_commit_in_flight', message: 'Запрос боту уже отправляется; ждём квитанцию исходного request_id.' }
    console.warn(`[Jobs] cancel id=${id} refused: bot RPC already in flight`)
    emit(j)
    return false
  }
  if (telegramFolderMutationInFlight(j)) {
    j.warning = { code: 'telegram_folder_commit_in_flight', message: 'Изменение папки уже отправляется; проверяем исходный request_id, без повторной записи.' }
    console.warn(`[Jobs] cancel id=${id} refused: folder RPC already in flight`)
    emit(j)
    return false
  }
  // Telegram cancellation remains non-terminal until the subprocess closes
  // and all received rows have been durably finalized. This prevents folder
  // umbrellas from starting the next child over a still-running Telethon
  // process or an in-flight SQLite commit.
  const deferTerminalUntilClose = new Set([
    'tg_fetch', 'tg_reply_backfill', 'tg_folder_refresh',
    'tg_live_search', 'tg_live_public_search', 'tg_live_context', 'tg_live_range',
    'tg_live_attachment', 'tg_live_transcribe', 'tg_live_join', 'tg_live_leave', 'tg_live_asr_recovery',
    'tg_live_bot_info', 'tg_live_bot_messages', 'tg_live_bot_action', 'tg_live_bot_action_status',
    'tg_live_membership_info',
    'tg_live_folder_read', 'tg_live_folder_merge', 'tg_live_folder_merge_status',
    'tg_live_bot_join', 'tg_live_bot_join_status',
    'yt_channel_fetch', 'yt_batch_transcribe',
    'tk_channel_fetch', 'tk_batch_transcribe',
    'ig_profile_fetch', 'ig_batch_transcribe',
    'rd_thread_fetch', 'rd_search',
    'boosty_channel_fetch', 'boosty_batch_transcribe',
  ])
  if (deferTerminalUntilClose.has(j.type) && j.child && !j.child.killed) {
    j._cancelRequested = true
    j.phase = 'cancelling'
    j.status = 'cancelling'
    try { j.child.kill('SIGTERM') }
    catch (err) { console.error('[Jobs] child SIGTERM failed', err) }
    j._cancelEscalationTimer = setTimeout(() => {
      // A signal-terminated child keeps exitCode=null and records signalCode.
      // Treat either as terminal; otherwise a clean SIGTERM misleadingly
      // schedules a second SIGKILL against an already-closed process.
      if (!j.child || j.child.exitCode != null || j.child.signalCode != null) return
      console.warn(`[Jobs] cancel escalate live #${j.id} pid=${j.child.pid || '-'} → SIGKILL`)
      try { j.child.kill('SIGKILL') } catch {}
    }, 5000)
    j._cancelEscalationTimer.unref?.()
    emit(j)
    return true
  }
  if (typeof j.cancel === 'function') {
    j._cancelRequested = true
    j.status = 'cancelling'
    j.phase = 'cancelling'
    emit(j)
    // Mark the umbrella before invoking its hook. The hook can synchronously
    // cancel a child and cause subscribers to run; they must already see that
    // the parent is stopping, otherwise the loop can advance to the next chat.
    try { j.cancel() } catch (err) { console.error('[Jobs] custom cancel failed', err) }
    return true
  }
  if (j.child && !j.child.killed) {
    j.child.kill('SIGTERM')
    j.status = 'cancelled'
    j.finished_at = Math.floor(Date.now() / 1000)
    emit(j)
    return true
  }
  // No live child (e.g. yt_transcribe in 'awaiting_ai' between stages):
  // mark as cancelled directly.
  if (j.status === 'awaiting_ai' || j.status === 'pending') {
    j.status = 'cancelled'
    j.finished_at = Math.floor(Date.now() / 1000)
    emit(j)
  }
  return true
}

/**
 * One-shot title resolution. Walks iter_dialogs(), emits one chat_candidate
 * per case-insensitive exact-match. Used by paste-flow when target is a
 * free-text chat name without @username/URL ("Чат | EBASH"). Doesn't create
 * a job, doesn't write to DB. Resolves with array of matches (possibly empty).
 */
function runTelegramResolveTitle(text, onProgress, opts = {}) {
  return new Promise((resolve, reject) => {
    const tgSession = opts._tg_session_override || opts.session || activeTgSession()  // снимок → --session, как у job'ов
    const args = [
      path.join(WORKERS_ROOT, 'telegram', 'tg_fetch_json.py'),
      '--resolve-title', String(text || ''),
    ]
    if (tgSession) args.push('--session', tgSession)
    if (opts.fuzzy) args.push('--resolve-fuzzy')
    if (opts.limit) args.push('--resolve-limit', String(opts.limit))
    console.log(`[Resolve] start tg title="${text}" session=${tgSession || 'default'} fuzzy=${!!opts.fuzzy}`)
    const child = spawn(WORKER_PYTHON, args, {
      cwd: WORKERS_ROOT,
      env: workerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const matches = []
    let stderrTail = ''
    let firstError = null

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', line => {
      if (!line.trim()) return
      let evt; try { evt = JSON.parse(line) } catch { return }
      if (evt.type === 'chat_candidate') matches.push(evt)
      else if (evt.type === 'resolve_progress' && typeof onProgress === 'function') {
        try { onProgress({ scanned: evt.scanned }) } catch {}
      }
      else if (evt.type === 'error' && !firstError) firstError = evt.message
    })
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-2000) })

    child.on('close', code => {
      console.log(`[Resolve] end title="${text}" code=${code} matches=${matches.length}`)
      if (code === 4) return resolve({ matches: [], error: firstError || 'no_session' })
      if (code !== 0 && matches.length === 0) {
        return reject(new Error(firstError || stderrTail || `python exited ${code}`))
      }
      resolve({ matches, error: null })
    })
    child.on('error', reject)
  })
}

/**
 * Resolve a Telegram folder ("dialog filter") by name. Fires one ndjson
 * subprocess (tg_resolve_folder_ndjson.py), collects:
 *   - candidates[] — every named DialogFilter the user has, used for the
 *     ambiguity picker if name matches more than one
 *   - folder       — the chosen one with chats[]
 * Resolves with `{ candidates, folder, error }`. Doesn't create a job
 * (mirrors runTelegramResolveTitle); the heavy lifting is upserting sources
 * + folder rows in the IPC handler.
 */
function runTelegramResolveFolder({ name, filterId, all }) {
  return new Promise((resolve, reject) => {
    const tgSession = activeTgSession()  // снимок → --session, как у job'ов
    const args = [path.join(WORKERS_ROOT, 'telegram', 'tg_resolve_folder_ndjson.py')]
    if (all)              args.push('--all')
    if (filterId != null) args.push('--filter-id', String(filterId))
    if (tgSession)        args.push('--session', tgSession)
    if (name != null)     args.push(String(name))

    console.log(`[Resolve] start tg_folder name=${JSON.stringify(name)} filterId=${filterId ?? '-'} all=${!!all} session=${tgSession || 'default'}`)
    const child = spawn(WORKER_PYTHON, args, {
      cwd: WORKERS_ROOT,
      env: workerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const candidates = []
    // --all sweep emits multiple folder events in one subprocess; the single-
    // resolve flow gets exactly one. Collect all, return both shapes via
    // (folder, folders[]) — caller picks what it needs.
    const folders = []
    let firstError = null
    let stderrTail = ''

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', line => {
      if (!line.trim()) return
      let evt; try { evt = JSON.parse(line) } catch { return }
      if (evt.type === 'folder_candidate') candidates.push(evt)
      else if (evt.type === 'folder')      folders.push(evt)
      else if (evt.type === 'error' && !firstError) firstError = evt.message
    })
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-2000) })

    child.on('close', code => {
      console.log(`[Resolve] end tg_folder code=${code} candidates=${candidates.length} folders=${folders.length}`)
      if (code === 4) return resolve({ candidates: [], folder: null, folders: [], error: firstError || 'no_session' })
      if (code !== 0 && folders.length === 0 && candidates.length === 0) {
        return reject(new Error(firstError || stderrTail || `python exited ${code}`))
      }
      // tg_session: тот же снимок, что ушёл Python'у --session'ом. Caller
      // (tg:resolveFolder в main.js) раньше перечитывал settings.json сам —
      // второе чтение = второе окно гонки. Отдаём явно.
      resolve({ candidates, folder: folders[0] || null, folders,
                error: firstError, tg_session: tgSession })
    })
    child.on('error', reject)
  })
}

/**
 * Folder list refresh as a real job. The synchronous IPC path was fine for
 * one-shot "click and wait" usage but had no Activity-panel row, no progress,
 * and no history after the fact — for a 30s+ Telethon walk that's exactly
 * what the user means by "не понятно идёт ли что-то".
 *
 * Same Python script (tg_resolve_folder_ndjson.py --all) — but we now stream
 * the events into a job snapshot:
 *   folder_candidate → tg_folder_refresh.total_folders++
 *   folder           → upsert sources + folder + setFolderSources, then
 *                      tg_folder_refresh.done_folders++, current_title=…
 *   close            → prune folders the user removed in TG, recordJob row.
 *
 * Returns the new job id immediately. Activity panel subscribes via
 * onJobUpdate and renders progress N/M папок with current title.
 */
function startTelegramFolderRefresh(options = {}) {
  const id = nextId++
  // Снимок до спавна, он же — явный --session (см. startTelegramFetch).
  const override = options?._tg_session_override || options?.session || null
  const tgSession = (typeof override === 'string' && override.trim())
    ? override.trim()
    : activeTgSession()
  const args = [path.join(WORKERS_ROOT, 'telegram', 'tg_resolve_folder_ndjson.py'), '--all']
  if (tgSession) args.push('--session', tgSession)

  console.log(`[Jobs] start tg_folder_refresh #${id} session=${tgSession || 'default'}`)
  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const job = {
    id,
    type: 'tg_folder_refresh',
    target: 'all-folders',
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: {},
    tg_session: tgSession,               // папки принадлежат этой сессии
    tg_folder_refresh: {
      total_folders: 0,
      done_folders:  0,
      current_title: null,
      synced:        0,
      removed:       0,
    },
    seenTgIds: new Set(),                // local-only; not in snapshot
    child,
  }
  jobs.set(id, job)
  emit(job)

  let stderrTail = ''
  let folderPersistenceQueue = Promise.resolve()
  let folderPersistenceErrors = 0

  function persistFolderOnMain(evt) {
    const sourceIds = []
    for (const chat of (evt.chats || [])) {
      try {
        const sourceId = db.upsertSource({
          platform: 'telegram',
          handle: chat.handle,
          display_name: chat.title || null,
          external_id: chat.tg_id != null ? String(chat.tg_id) : null,
          avatar_url: chat.avatar_path || null,
          meta: {
            kind: chat.kind,
            username: chat.username || null,
            via_folder_id: evt.filter_id,
          },
          is_explicit: false,
          tg_session: job.tg_session || null,
        })
        clearTelegramUnavailableAfterLiveResolve(sourceId, `tg_folder_refresh #${job.id}`)
        sourceIds.push(sourceId)
      } catch (error) {
        console.error('[FolderRefresh] fallback upsertSource failed', chat.handle, error)
      }
    }
    const folderId = db.upsertFolder({
      tg_filter_id: evt.filter_id,
      title: evt.title,
      tg_session: job.tg_session || null,
    })
    db.setFolderSources(folderId, sourceIds)
    return { folderId, sourceIds, fallback: true }
  }

  function enqueueFolderPersistence(evt) {
    job.tg_folder_refresh.current_title = evt.title
    emit(job)
    folderPersistenceQueue = folderPersistenceQueue.then(async () => {
      const started = Date.now()
      let result
      try {
        result = await syncTelegramFolder({
          filter_id: evt.filter_id,
          title: evt.title,
          chats: evt.chats || [],
          tg_session: job.tg_session || null,
        })
      } catch (error) {
        // Capability-preserving fallback for a missing packaged worker. It is
        // deliberately loud because normal folder persistence must stay off
        // main; the old synchronous path remains only as recovery.
        console.error('[FolderRefresh] persistence worker failed; falling back to main', error)
        result = persistFolderOnMain(evt)
      }
      if (result?.errors?.length) {
        folderPersistenceErrors += result.errors.length
        console.error(`[FolderRefresh] ${result.errors.length} chat row(s) failed in ${evt.title}`)
      }
      job.seenTgIds.add(evt.filter_id)
      job.tg_folder_refresh.synced += 1
      console.log(`[FolderRefresh] persisted filter=${evt.filter_id} chats=${result?.sourceIds?.length || 0} worker=${result?.fallback ? 0 : 1} took ${Date.now() - started}ms`)
    }).catch(error => {
      folderPersistenceErrors += 1
      console.error('[FolderRefresh] folder persistence failed', evt.title, error)
    }).finally(() => {
      job.tg_folder_refresh.done_folders += 1
      job.items_done = job.tg_folder_refresh.done_folders
      emit(job)
    })
  }

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    if (evt.type === 'folder_candidate') {
      job.tg_folder_refresh.total_folders += 1
      job.items_total = job.tg_folder_refresh.total_folders
      emit(job)
      return
    }
    if (evt.type === 'folder') {
      // A folder can contain hundreds or thousands of dialogs. Queue the DB
      // transaction in the Telegram persistence worker and keep stdout
      // draining; terminal status waits for this queue below.
      enqueueFolderPersistence(evt)
      return
    }
    if (evt.type === 'error') {
      job.error = evt.message
      job._protocolError = true
      if (evt.code) job.error_code = evt.code
      return
    }
    if (evt.type === 'done') {
      job._protocolDone = true
    }
  })
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    void (async () => {
    await folderPersistenceQueue
    if (job._cancelEscalationTimer) {
      clearTimeout(job._cancelEscalationTimer)
      job._cancelEscalationTimer = null
    }
    const outcome = resolveTelegramProcessOutcome({
      cancelRequested: job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled',
      exitCode: code,
      protocolDone: job._protocolDone === true,
      protocolError: job._protocolError === true,
      error: job.error || null,
      stderrTail,
    })
    job.status = outcome.status
    job.error = outcome.error
    if (outcome.errorCode) job.error_code = job.error_code || outcome.errorCode
    job.finished_at = Math.floor(Date.now() / 1000)

    // Prune: any folder in the local DB whose tg_filter_id wasn't seen in
    // this sweep means the user deleted it on the Telegram side. Skip rows
    // without a tg_filter_id (manually-created entries, future-proofing).
    // SESSION SCOPE — СТРОГИЙ: удаляем только строки, явно привязанные к
    // сессии этого свипа. Legacy NULL-строки НЕ трогаем: «считать их своими»
    // (первая итерация) означало, что refresh под аккаунтом A удалял папки
    // аккаунта B, синканные до ввода привязки, — ровно так у юзера пропала
    // Oku27-папка «реклама» (synced=12 removed=1 под F9922). NULL-строки,
    // которые реально принадлежат этой сессии, упомянуты в свипе → их
    // усыновил upsertFolder выше; не упомянутые могут быть чужими — пусть
    // живут до refresh'а под своим аккаунтом.
    if (job.status === 'done' && job.tg_session) {
      try {
        const result = await pruneTelegramFolders({
          tg_session: job.tg_session,
          seen_filter_ids: [...job.seenTgIds],
        })
        job.tg_folder_refresh.removed += Number(result?.removed || 0)
      } catch (err) {
        console.error('[FolderRefresh] prune worker failed; falling back to main', err)
        try {
          const local = db.listFolders()
          for (const lf of local) {
            if (lf.tg_session !== job.tg_session) continue
            if (lf.tg_filter_id != null && !job.seenTgIds.has(lf.tg_filter_id)) {
              db.deleteFolder(lf.id)
              job.tg_folder_refresh.removed += 1
            }
          }
        } catch (fallbackError) {
          console.error('[FolderRefresh] prune fallback failed', fallbackError)
        }
      }
    }

    job.tg_folder_refresh.current_title = null
    delete job.seenTgIds                  // don't ship the Set in snapshots

    try {
      db.recordJob({
        type:        job.type,
        source_id:   null,
        status:      job.status,
        items_total: job.tg_folder_refresh.total_folders,
        items_done:  job.tg_folder_refresh.done_folders,
        params:      { ...job.params, _summary: job.tg_folder_refresh },
        error:       job.error || null,
        started_at:  job.started_at,
        finished_at: job.finished_at,
      })
    } catch (err) {
      console.error('[Jobs] tg_folder_refresh recordJob failed', err)
    }

    console.log(`[Jobs] end tg_folder_refresh #${id} status=${job.status} synced=${job.tg_folder_refresh.synced} removed=${job.tg_folder_refresh.removed} persistence_errors=${folderPersistenceErrors}`)
    emit(job)
    markJobClosed(job)
    })().catch(error => {
      job.status = 'error'
      job.error = String(error?.message || error)
      job.finished_at = Math.floor(Date.now() / 1000)
      delete job.seenTgIds
      console.error(`[Jobs] tg_folder_refresh #${id} close failed`, error)
      emit(job)
      markJobClosed(job)
    })
  })

  return id
}

/**
 * Reply-graph backfill for a single Telegram source.
 *
 * Old fetches (pre reply-graph support) wrote items without
 * parent_external_id. This job pulls all items where it's still NULL,
 * spawns tg_reply_backfill_ndjson.py with the msg_id list, and applies
 * each `item-update` event as a targeted UPDATE.
 *
 * Distinct from a regular tg_fetch because:
 *   - no metadata refresh (caption/media are not re-touched)
 *   - no FTS or coverage writes
 *   - one Telethon get_messages batch per 100 ids = O(N/100) RPC calls,
 *     no iter_messages re-pagination
 *
 * params: { source_id, target, limit? }   limit caps how many items to
 * process in one job (default 5000). Re-run for the next slice.
 */
function startTelegramReplyBackfill(params) {
  const id = nextId++
  const sourceId = params.source_id
  const target = params.target
  const limit = Math.max(1, Math.min(params.limit || 5000, 50000))
  if (!sourceId || !target) {
    throw new Error('startTelegramReplyBackfill: source_id and target required')
  }

  // Guard: don't spawn while another Telethon-session-using job is alive
  // for this same source. SQLiteSession busy_timeout helps for short waits,
  // but a 5000-message tg_fetch holds the lock for tens of seconds — better
  // to refuse upfront than to ride a 30s busy-wait. Caller (auto-backfill
  // hook in tg:index) silently swallows the error.
  for (const j of jobs.values()) {
    if (j.status !== 'running' && j.status !== 'cancelling') continue
    if (j.source_id !== sourceId) continue
    if (j.type === 'tg_fetch' || j.type === 'tg_reply_backfill' ||
        j.type === 'tg_folder_fetch' || j.type === 'tg_preview' ||
        j.type === 'tg_catchup') {
      throw new Error(
        `another Telegram job is running for source #${sourceId} (job #${j.id} ${j.type}) — try again after it finishes`)
    }
  }

  if (params._known_empty === true) {
    // Synthesize a no-op "done" job so the UI can show "ничего не нужно
    // дотягивать" without special-casing the call site.
    const job = {
      id, type: 'tg_reply_backfill', target, source_id: sourceId,
      status: 'done',
      items_done: 0, items_total: 0,
      started_at: Math.floor(Date.now() / 1000),
      finished_at: Math.floor(Date.now() / 1000),
      params: Object.fromEntries(Object.entries(params).filter(([key]) => !key.startsWith('_runtime_') && key !== '_known_empty')),
      tg_reply_backfill: { resolved: 0, with_parent: 0, no_parent: 0 },
    }
    jobs.set(id, job)
    emit(job)
    return id
  }

  // Backfill ходит по СУЩЕСТВУЮЩЕМУ source — правильная сессия не «активная
  // сейчас», а та, к которой чат привязан (sources.tg_session). Активная —
  // только fallback для legacy-строк без привязки.
  let tgSession = null
  let telegramSource = params._runtime_source || null
  try {
    if (!telegramSource) telegramSource = db.getSource(sourceId) || null
    tgSession = telegramSource?.tg_session || null
  } catch {}
  if (!tgSession) tgSession = activeTgSession()
  const workerTarget = telegramStableTarget(telegramSource) || target
  const args = [
    path.join(WORKERS_ROOT, 'telegram', 'tg_reply_backfill_ndjson.py'),
    String(workerTarget),
    '--source-id', String(sourceId),
    '--limit', String(limit),
  ]
  if (tgSession) args.push('--session', tgSession)

  console.log(`[Jobs] start tg_reply_backfill #${id} source=${sourceId} target=${target} resolve_target=${workerTarget} limit=${limit} session=${tgSession || 'default'}`)
  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const job = {
    id,
    type: 'tg_reply_backfill',
    target,
    source_id: sourceId,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: Object.fromEntries(Object.entries(params).filter(([key]) => !key.startsWith('_runtime_') && key !== '_known_empty')),
    tg_reply_backfill: { resolved: 0, with_parent: 0, no_parent: 0 },
    reaction_null: 0,
    reaction_checked: 0,
    pendingUpdates: [],     // batched DB writes — flushed every 100 events
    child,
  }
  jobs.set(id, job)
  emit(job)

  // Pending row in jobs table so История парсинга and JobDetail can show
  // the running job. Finalised in close-handler via db.updateJob(...) —
  // not a second INSERT.
  try {
    job.dbRowId = db.recordJob({
      type:        job.type,
      source_id:   sourceId,
      status:      'running',
      items_total: null,
      items_done:  0,
      params:      { ...job.params },
      started_at:  job.started_at,
    })
  } catch (err) {
    console.error('[Jobs] tg_reply_backfill recordJob (pending) failed', err)
  }

  let stderrTail = ''
  let updatePersistenceQueue = Promise.resolve()
  const flushUpdates = () => {
    if (!job.pendingUpdates.length) return
    const rows = job.pendingUpdates.splice(0, job.pendingUpdates.length)
    const n = rows.length
    const nullReactions = rows.filter(r =>
      Object.prototype.hasOwnProperty.call(r, 'reactions') && r.reactions == null
    ).length
    updatePersistenceQueue = updatePersistenceQueue.then(async () => {
      const t0 = Date.now()
      try {
        await applyTelegramReplyUpdates({ source_id: sourceId, rows })
      } catch (error) {
        console.error('[Jobs] tg_reply_backfill persistence worker failed; falling back to main', error)
        db.bulkUpdateParentExternalId(sourceId, rows)
      }
      console.log(`[Jobs] tg_reply_backfill #${id} flush updates=${n} null_reactions=${nullReactions} took ${Date.now() - t0}ms`)
    })
  }

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    switch (evt.type) {
      case 'item-update': {
        // Backfill events now also carry `reactions`. We pass the property
        // through only when it's present (not undefined) so legacy events —
        // and rows where Telethon couldn't fill reactions — leave the
        // reactions column / resolved-flag alone.
        const upd = {
          external_id: evt.external_id,
          parent_external_id: evt.parent_external_id || null,
        }
        if (evt.raw_meta_patch && typeof evt.raw_meta_patch === 'object') upd.raw_meta_patch = evt.raw_meta_patch
        if (Object.prototype.hasOwnProperty.call(evt, 'reactions')) {
          upd.reactions = evt.reactions   // null | [] | [...]
          job.reaction_checked += 1
          if (evt.reactions == null) job.reaction_null += 1
        }
        job.pendingUpdates.push(upd)
        job.tg_reply_backfill.resolved += 1
        if (evt.parent_external_id) job.tg_reply_backfill.with_parent += 1
        else                        job.tg_reply_backfill.no_parent += 1
        if (job.pendingUpdates.length >= 100) flushUpdates()
        break
      }
      case 'backfill-plan':
        job.items_total = Number(evt.items_total || 0)
        if (job.dbRowId) {
          try { db.updateJob(job.dbRowId, { items_total: job.items_total }) }
          catch (err) { console.error('[Jobs] tg_reply_backfill plan update failed', err) }
        }
        emit(job)
        break
      case 'page':
        job.items_done = evt.loaded
        // Persist running progress into jobs row so JobDetail (which reads
        // from the DB on mount) shows the same number as Activity. Cheap —
        // one UPDATE per 100-item batch, not per item.
        if (job.dbRowId) {
          try { db.updateJob(job.dbRowId, { items_done: job.items_done }) }
          catch (err) { console.error('[Jobs] tg_reply_backfill updateJob failed', err) }
        }
        emit(job)
        break
      case 'error':
        if (!job.error) job.error = evt.message
        job._protocolError = true
        break
      case 'done':
        job._protocolDone = true
        break
    }
  })
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-2000) })

  child.on('close', code => {
    void (async () => {
    const closeStartedMs = Date.now()
    flushUpdates()
    await updatePersistenceQueue
    if (job._cancelEscalationTimer) {
      clearTimeout(job._cancelEscalationTimer)
      job._cancelEscalationTimer = null
    }
    job.finished_at = Math.floor(Date.now() / 1000)
    const outcome = resolveTelegramProcessOutcome({
      cancelRequested: job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled',
      exitCode: code,
      protocolDone: job._protocolDone === true,
      protocolError: job._protocolError === true,
      error: job.error || null,
      stderrTail,
    })
    job.status = outcome.status
    job.error = outcome.error
    if (outcome.errorCode) job.error_code = job.error_code || outcome.errorCode
    if (job.status === 'done') {
      clearTelegramUnavailableAfterLiveResolve(sourceId, `tg_reply_backfill #${id}`)
    }
    job.items_done = job.tg_reply_backfill.resolved
    delete job.pendingUpdates

    try {
      if (job.dbRowId) {
        db.updateJob(job.dbRowId, {
          status:      job.status,
          items_total: job.items_total,
          items_done:  job.items_done,
          params:      { ...job.params, _summary: job.tg_reply_backfill },
          error:       job.error || null,
          finished_at: job.finished_at,
        })
      } else {
        db.recordJob({
          type:        job.type,
          source_id:   sourceId,
          status:      job.status,
          items_total: job.items_total,
          items_done:  job.items_done,
          params:      { ...job.params, _summary: job.tg_reply_backfill },
          error:       job.error || null,
          started_at:  job.started_at,
          finished_at: job.finished_at,
        })
      }
    } catch (err) {
      console.error('[Jobs] tg_reply_backfill final updateJob failed', err)
    }
    console.log(`[Jobs] end tg_reply_backfill #${id} status=${job.status} resolved=${job.tg_reply_backfill.resolved} with_parent=${job.tg_reply_backfill.with_parent} reactions_checked=${job.reaction_checked} reactions_null=${job.reaction_null} close_ms=${Date.now() - closeStartedMs}`)
    emit(job)
    markJobClosed(job)
    })().catch(error => {
      job.status = 'error'
      job.error = String(error?.message || error)
      job.finished_at = Math.floor(Date.now() / 1000)
      delete job.pendingUpdates
      console.error(`[Jobs] tg_reply_backfill #${id} close failed`, error)
      emit(job)
      markJobClosed(job)
    })
  })

  return id
}

function isFatalTelegramChildError(snap) {
  const code = snap?.error_code || null
  if (code === 'session_unauthorized') return true
  if (code === 'worker_dependency_missing') return true
  const msg = String(snap?.error || '')
  return /telethon (not installed|import failed)/i.test(msg)
}

function finalizeTelegramUmbrellaStatus(job) {
  const rows = Array.isArray(job?.tg_folder?.per_chat) ? job.tg_folder.per_chat : []
  const failed = rows.filter(row => row.status === 'error')
  const cancelled = rows.filter(row => row.status === 'cancelled')
  if (failed.length) {
    const first = failed.find(row => row.error) || failed[0]
    job.status = 'error'
    job.error = `${failed.length}/${job.tg_folder.total_chats} чатов завершились ошибкой${first?.error ? `: ${first.error}` : ''}`
    return
  }
  if (cancelled.length) {
    job.status = 'cancelled'
    job.error = null
    return
  }
  job.status = 'done'
  job.error = null
}

/**
 * Folder batch fetch — sequential, never parallel.
 *
 * Telethon's session-lock means two concurrent fetches against the same
 * .session file collide on `OperationalError: database is locked`. So we
 * spawn fetches one at a time, with a single "umbrella" job-row that the
 * Activity panel renders as a group ("3/12 чатов · @durov").
 *
 * Per-chat progress lands on the umbrella's `tg_folder` shape; the
 * underlying `startTelegramFetch` jobs run in their own ids so SourceDetail
 * sees them in its own history strip naturally.
 *
 * params: { folder_id, source_ids[], targets[], mode, date?, limit?,
 *           types? (informational; tg_fetch_json doesn't filter by type yet) }
 * Returns the umbrella job id.
 */
function startTelegramFolderFetch(params) {
  const id = nextId++
  const targets = Array.isArray(params.targets) ? params.targets.slice() : []
  const sourceIds = Array.isArray(params.source_ids) ? params.source_ids.slice() : []
  if (!targets.length) {
    throw new Error('startTelegramFolderFetch: targets required')
  }
  // Один снимок сессии на ВЕСЬ зонтик. Дети спавнятся последовательно
  // минутами — без этого переключение сессии в UI посреди прогона
  // раскидало бы чаты одной папки по двум аккаунтам.
  const tgSession = params.tg_session || activeTgSession()

  const job = {
    id,
    type: 'tg_folder_fetch',
    target: `folder:${params.folder_id || '-'}`,
    status: 'running',
    items_done: 0,
    items_total: targets.length,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params, targets },
    tg_session: tgSession,
    tg_folder: {
      folder_id:    params.folder_id || null,
      total_chats:  targets.length,
      done_chats:   0,
      current_idx:  0,
      current_target: null,
      child_job_id: null,
      per_chat:     [],            // [{target, status, items_done, error?}]
      total_items:  0,
    },
    child: null,                   // umbrella has no real child; cancel-aware
  }
  job.cancel = () => {
    job._cancelRequested = true
    const childId = job.tg_folder.child_job_id
    console.log(`[Jobs] tg_folder_fetch #${id} cancel hook child=${childId ?? '-'}`)
    if (childId != null) return cancelJob(childId)
    return true
  }
  jobs.set(id, job)
  emit(job)

  console.log(`[Jobs] start tg_folder_fetch #${id} chats=${targets.length} mode=${params.mode}`)

  // Sequential walk. Each iteration awaits the child startTelegramFetch's
  // close. We attach to the global job listener and resolve when the child
  // hits a terminal status.
  ;(async () => {
    for (let i = 0; i < targets.length; i++) {
      if (job.status !== 'running') break       // cancelled mid-walk
      const target = targets[i]
      const sourceId = Number(sourceIds[i]) || null
      job.tg_folder.current_idx = i
      job.tg_folder.current_target = target
      emit(job)

      let childId
      try {
        const types = Array.isArray(params.types) ? params.types : null
        // tg_fetch_json doesn't filter messages by type at the network
        // layer (Telethon iter_messages doesn't expose a useful per-type
        // filter that's cheaper than UPSERT-then-skip). What we DO drive
        // by `types` is the AI processing pass (voice/video → transcribe;
        // photo → Gemini Vision; docs → Gemini PDF) and the
        // include_comments toggle. Storage stays a full UPSERT —
        // user can re-copy with a different type subset without re-fetch.
        const wantsVoice    = !!(types && (types.includes('voice') || types.includes('video')))
        const wantsPhoto    = !!(types && types.includes('photo'))
        const wantsDocs     = !!(types && types.includes('docs'))
        // Polls now ride along with «Текст» — no separate checkbox. Render
        // is local & free, so we always pass the flag when text is picked
        // (and even when it isn't, it's a no-op for non-poll messages).
        const wantsPolls    = true
        const wantsComments = !!(types && types.includes('comments'))
        const needsEngine   = wantsVoice
        const fetchParams = {
          target,
          mode:  params.mode || 'last_n',
          limit: params.limit || 0,
          date:  params.date || null,
          date_to: params.date_to || null,
          transcribe_engine: needsEngine ? (params.engine || 'assemblyai') : null,
          // Per-type AI flags. tg_fetch_json now refuses to invoke Gemini /
          // AssemblyAI without these — having engine alone won't transcribe.
          // Caught a regression where folder batch with «Голосовые + Фото»
          // came back metadata-only.
          process_voice:     wantsVoice,
          process_photo:     wantsPhoto,
          process_docs:      wantsDocs,
          process_polls:     wantsPolls,
          include_comments:  wantsComments,
          _folder_umbrella_id: id,
          _tg_session_override: tgSession,
        }
        if (sourceId && Number.isFinite(sourceId) && sourceId > 0) {
          fetchParams._source_id = sourceId
        }
        childId = startTelegramFetch(fetchParams)
      } catch (err) {
        job.tg_folder.per_chat.push({ target, status: 'error',
                                      error: String(err && err.message || err) })
        continue
      }
      job.tg_folder.child_job_id = childId
      emit(job)

      // Wait for that child to finish via subscribe(). Don't poll.
      await new Promise(resolveOne => {
        const off = subscribe(snap => {
          if (snap.id !== childId) return
          if (snap.status === 'done' || snap.status === 'error' || snap.status === 'cancelled') {
            job.tg_folder.per_chat.push({
              target,
              status:     snap.status,
              items_done: snap.items_done || 0,
              error:      snap.error || null,
              source_id:  snap.source_id || null,
            })
            // Bubble a structural error code (e.g. session_unauthorized) up to
            // the umbrella. The session is shared, so a deauth fails every
            // child identically — surface it once and stop the remaining
            // children instead of spawning N doomed subprocesses.
            if (snap.error_code && !job.error_code) job.error_code = snap.error_code
            if (isFatalTelegramChildError(snap)) {
              job.status = 'error'
              job.error = snap.error || 'Telegram child job failed'
              job.finished_at = Math.floor(Date.now() / 1000)
            }
            job.tg_folder.total_items += snap.items_done || 0
            job.tg_folder.done_chats   = i + 1
            job.items_done             = i + 1
            off()
            resolveOne()
          }
        })
      })
      emit(job)
    }

    // Whole batch done.
    if (job._cancelRequested || job.status === 'cancelling') {
      job.status = 'cancelled'
      job.error = null
      job.finished_at = Math.floor(Date.now() / 1000)
    } else if (job.status === 'running') {
      finalizeTelegramUmbrellaStatus(job)
      job.finished_at = Math.floor(Date.now() / 1000)
    }
    job.tg_folder.current_target = null
    job.tg_folder.child_job_id   = null

    // Stamp the folder so the UI can show "последний парсинг … минуту назад".
    try {
      if (params.folder_id) {
        db.updateFolderParams(params.folder_id, { last_fetched_at: job.finished_at })
      }
    } catch (err) {
      console.error('[Jobs] folder updateFolderParams failed', err)
    }

    // Persist the umbrella row — sourceless (folder is not a source).
    try {
      db.recordJob({
        type:        job.type,
        source_id:   null,
        status:      job.status,
        items_total: job.tg_folder.total_chats,
        items_done:  job.tg_folder.done_chats,
        params:      { ...job.params, _folder_summary: job.tg_folder },
        error:       job.error || null,
        started_at:  job.started_at,
        finished_at: job.finished_at,
      })
    } catch (err) {
      console.error('[Jobs] tg_folder_fetch recordJob failed', err)
    }

    console.log(`[Jobs] end tg_folder_fetch #${id} status=${job.status} done=${job.tg_folder.done_chats}/${job.tg_folder.total_chats} items=${job.tg_folder.total_items}`)
    emit(job)
  })().catch(err => {
    console.error('[Jobs] tg_folder_fetch loop error', err)
    job.status = 'error'
    job.error = String(err && err.message || err)
    job.finished_at = Math.floor(Date.now() / 1000)
    emit(job)
  })

  return id
}

/**
 * Sidebar multi-chat «Запросить до конца».
 *
 * Same sequential umbrella mechanic as `startTelegramFolderFetch` (Telethon
 * session-lock means we can't parallelise), but per-target the strategy is
 * driven by the saved tip: for each source we already know `maxExternalId`
 * and ask Telethon for everything strictly newer via `--since-msgid` + the
 * `sync_new` mode. Empty / never-fetched sources fall back to `last_n=200`
 * so a chat without a cached tip still gets a meaningful slice.
 *
 * Reuses the `tg_folder` snapshot shape — Activity/JobDetail render the same
 * row body, no per-type fork. `folder_id` is null (this isn't a folder
 * operation); FolderRowBody handles that by falling back to «N выбранных
 * чатов» instead of a folder title.
 *
 * params:
 *   targets[]            — handles (or numeric chat_ids as string)
 *   per_source_since[]   — same length as targets; each entry is the highest
 *                          known external_id for that source (0 if unknown)
 *   types[]              — content types for the children (`text`, `voice`, …)
 *   engine               — voice/video transcription engine (when needed)
 *
 * Returns the umbrella job id.
 */
function startTelegramCatchUp(params) {
  const id = nextId++
  const targets = Array.isArray(params.targets) ? params.targets.slice() : []
  const sinces  = Array.isArray(params.per_source_since)
    ? params.per_source_since.slice()
    : []
  const sourceIds = Array.isArray(params.source_ids)
    ? params.source_ids.slice()
    : []
  if (!targets.length) {
    throw new Error('startTelegramCatchUp: targets required')
  }

  // Снимок сессии на весь зонтик — как в startTelegramFolderFetch.
  // Auto runs pass the source-bound session explicitly so background catch-up
  // does not depend on whichever account is currently active in the UI.
  const tgSession = params.tg_session || activeTgSession()

  const job = {
    id,
    type: 'tg_catchup',
    target: `catchup:${targets.length}`,
    status: 'running',
    items_done: 0,
    items_total: targets.length,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params, targets },
    tg_session: tgSession,
    // Reuse the folder snapshot shape — same fields drive both Activity's
    // FolderRowBody and JobDetail's TelegramFolderBody. folder_id=null is
    // the marker that disambiguates the two semantically.
    tg_folder: {
      folder_id:    null,
      total_chats:  targets.length,
      done_chats:   0,
      current_idx:  0,
      current_target: null,
      child_job_id: null,
      per_chat:     [],
      total_items:  0,
    },
    child: null,
  }
  job.cancel = () => {
    job._cancelRequested = true
    const childId = job.tg_folder.child_job_id
    console.log(`[Jobs] tg_catchup #${id} cancel hook child=${childId ?? '-'}`)
    if (childId != null) return cancelJob(childId)
    return true
  }
  jobs.set(id, job)
  emit(job)

  console.log(`[Jobs] start tg_catchup #${id} chats=${targets.length}`)

  ;(async () => {
    for (let i = 0; i < targets.length; i++) {
      if (job.status !== 'running') break
      const target = targets[i]
      const since  = Number(sinces[i]) || 0
      const sourceId = Number(sourceIds[i]) || null
      job.tg_folder.current_idx = i
      job.tg_folder.current_target = target
      emit(job)

      let childId
      try {
        const types = Array.isArray(params.types) ? params.types : null
        const wantsVoice    = !!(types && (types.includes('voice') || types.includes('video')))
        const wantsPhoto    = !!(types && types.includes('photo'))
        const wantsDocs     = !!(types && types.includes('docs'))
        const wantsPolls    = true
        const wantsComments = !!(types && types.includes('comments'))
        const needsEngine   = wantsVoice
        const fetchParams = {
          target,
          transcribe_engine: needsEngine ? (params.engine || 'assemblyai') : null,
          process_voice:     wantsVoice,
          process_photo:     wantsPhoto,
          process_docs:      wantsDocs,
          process_polls:     wantsPolls,
          include_comments:  wantsComments,
          _folder_umbrella_id: id,
          _tg_session_override: tgSession,
        }
        if (sourceId && Number.isFinite(sourceId) && sourceId > 0) {
          fetchParams._source_id = sourceId
        }
        if (params.auto === true) {
          fetchParams._auto_catchup = true
        }
        if (since > 0) {
          // Cached tip known: ask Telethon for strictly newer messages, no
          // limit. `sync_new` mode in tg_fetch_json honours --since-msgid as
          // min_id with iter_messages(limit=None).
          fetchParams.mode = 'sync_new'
          fetchParams.sinceMessageId = since
        } else {
          // No cached tip yet. We're not asking for "all" history blindly —
          // last_n=200 is a sensible default for a never-fetched chat that
          // shows up in the catch-up selection (e.g. just demoted from
          // «Прочее» after a folder resolve).
          fetchParams.mode  = 'last_n'
          fetchParams.limit = 200
        }
        childId = startTelegramFetch(fetchParams)
      } catch (err) {
        job.tg_folder.per_chat.push({
          target, status: 'error',
          error: String(err && err.message || err),
        })
        continue
      }
      job.tg_folder.child_job_id = childId
      emit(job)

      await new Promise(resolveOne => {
        const off = subscribe(snap => {
          if (snap.id !== childId) return
          if (snap.status === 'done' || snap.status === 'error' || snap.status === 'cancelled') {
            job.tg_folder.per_chat.push({
              target,
              status:     snap.status,
              items_done: snap.items_done || 0,
              error:      snap.error || null,
              source_id:  snap.source_id || null,
            })
            // Bubble a structural error code (e.g. session_unauthorized) up to
            // the umbrella. The session is shared, so a deauth fails every
            // child identically — surface it once and stop the remaining
            // children instead of spawning N doomed subprocesses.
            if (snap.error_code && !job.error_code) job.error_code = snap.error_code
            if (isFatalTelegramChildError(snap)) {
              job.status = 'error'
              job.error = snap.error || 'Telegram child job failed'
              job.finished_at = Math.floor(Date.now() / 1000)
            }
            job.tg_folder.total_items += snap.items_done || 0
            job.tg_folder.done_chats   = i + 1
            job.items_done             = i + 1
            off()
            resolveOne()
          }
        })
      })
      emit(job)
    }

    if (job._cancelRequested || job.status === 'cancelling') {
      job.status = 'cancelled'
      job.error = null
      job.finished_at = Math.floor(Date.now() / 1000)
    } else if (job.status === 'running') {
      finalizeTelegramUmbrellaStatus(job)
      job.finished_at = Math.floor(Date.now() / 1000)
    }
    job.tg_folder.current_target = null
    job.tg_folder.child_job_id   = null

    // Automatic network work is still real user-visible work when it finds
    // zero messages. Keep one umbrella row in Activity/History; only the 40
    // no-op child rows stay suppressed. Hiding the umbrella made the navbar
    // report zero while Telethon was actively walking chats.
    try {
      db.recordJob({
        type:        job.type,
        source_id:   null,
        status:      job.status,
        items_total: job.tg_folder.total_chats,
        items_done:  job.tg_folder.done_chats,
        params:      { ...job.params, _summary: job.tg_folder },
        error:       job.error || null,
        started_at:  job.started_at,
        finished_at: job.finished_at,
      })
    } catch (err) {
      console.error('[Jobs] tg_catchup recordJob failed', err)
    }

    console.log(`[Jobs] end tg_catchup #${id} status=${job.status} done=${job.tg_folder.done_chats}/${job.tg_folder.total_chats} items=${job.tg_folder.total_items}`)
    emit(job)
  })().catch(err => {
    console.error('[Jobs] tg_catchup loop error', err)
    job.status = 'error'
    job.error = String(err && err.message || err)
    job.finished_at = Math.floor(Date.now() / 1000)
    emit(job)
  })

  return id
}

const TG_LIVE_SCRIPT = path.join(WORKERS_ROOT, 'telegram', 'tg_live_ndjson.py')
const TG_LIVE_RESULT_TTL_MS = 30 * 60 * 1000
const TG_LIVE_RESULT_MAX_BYTES = 32 * 1024 * 1024
const TG_LIVE_RESULT_MAX_JOBS = 50

function applyTelegramMembershipResult(job, result) {
  if (!result || !['join', 'leave'].includes(result.operation)) return
  const chat = result.chat && typeof result.chat === 'object' ? result.chat : null
  if (!chat?.id) return
  try {
    if (result.operation === 'join' && result.ready_for_fetch === true) {
      const payload = telegramMembershipSourcePayload(result, job.tg_session)
      if (!payload) throw new Error('Telegram join returned incomplete source identity')
      const sourceId = db.upsertSource(payload)
      job.source_id = sourceId
      result.source_id = sourceId
      result.source_registered = true
      if (typeof chat.has_discussion === 'boolean') {
        db.setSourceHasDiscussion(sourceId, chat.has_discussion)
      }
      clearTelegramUnavailableAfterLiveResolve(sourceId, `tg_live_join #${job.id}`)
      return
    }
    if (result.operation === 'leave') {
      const lookup = chat.username || String(chat.id)
      const existing = db.findTelegramSourceByTarget(lookup)
        || db.findTelegramSourceByTarget(String(chat.id))
      if (!existing) return
      const payload = telegramMembershipSourcePayload(result, job.tg_session, existing)
      if (!payload) return
      const sourceId = db.upsertSource(payload)
      job.source_id = sourceId
      result.source_id = sourceId
      result.source_registered = true
    }
  } catch (error) {
    result.source_registered = false
    result.source_registration_error = String(error?.message || error)
    result.ready_for_fetch = false
    console.error(`[Jobs] tg_live_${result.operation} #${job.id} source registration failed`, error)
  }
}

function pruneTelegramLiveResults({ keepId = null } = {}) {
  const now = Date.now()
  const candidates = [...jobs.values()]
    .filter(job => job._tgLiveResult)
    .sort((a, b) => Number(b.finished_at || b.started_at || 0) - Number(a.finished_at || a.started_at || 0))
  let kept = 0
  let bytes = 0
  for (const job of candidates) {
    const ageMs = Math.max(0, now - Number(job.finished_at || job.started_at || 0) * 1000)
    const resultBytes = Number(job._tgLiveResultBytes || 0)
    const mustKeep = Number(job.id) === Number(keepId)
    const overBudget = kept >= TG_LIVE_RESULT_MAX_JOBS || bytes + resultBytes > TG_LIVE_RESULT_MAX_BYTES
    if (!mustKeep && (ageMs > TG_LIVE_RESULT_TTL_MS || overBudget)) {
      delete job._tgLiveResult
      delete job._tgLiveResultBytes
      if (job.tg_live) job.tg_live.result_available = false
      continue
    }
    kept += 1
    bytes += resultBytes
  }
}

/**
 * Start a Telegram server request on behalf of MCP. Read operations and
 * explicit confirmed membership mutations share this one visible job path.
 * The MCP process
 * calls the loopback bridge, so this is the main-process job Map the renderer
 * already watches — no invisible second job-runner exists for this flow.
 *
 * Message bodies stay in `_tgLiveResult` and are never put in snapshots or the
 * jobs table. The explicit `/telegram-live/status` route is the only reader.
 */
function startTelegramLive(rawRequest = {}) {
  pruneTelegramLiveResults()
  const request = normalizeTelegramLiveRequest(rawRequest)
  const id = nextId++
  const type = telegramLiveJobType(request.operation)
  const target = telegramLiveTarget(request)
  const tgSession = telegramSessionForFetchParams({ session: request.session }) || 'session2'
  request.session = tgSession
  const args = [TG_LIVE_SCRIPT, '--session', tgSession]
  const diagnosticTarget = /^https?:\/\/(?:t|telegram)\.me\/(?:\+|joinchat\/)/i.test(target)
    ? `private-invite:${crypto.createHash('sha256').update(target).digest('hex').slice(0,12)}` : target
  console.log(`[Jobs] start ${type} #${id} target=${diagnosticTarget} session=${tgSession}${request.operation === 'search' ? ` searches=${request.searches.length}` : ''}`)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const job = {
    id,
    type,
    target,
    status: 'running',
    items_done: 0,
    items_total: request.operation === 'search' ? request.searches.length : null,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...request, origin: rawRequest.origin, autoCopy: rawRequest.autoCopy },
    source_id: null,
    tg_session: tgSession,
    tg_live: createTelegramLiveState(request),
    child,
  }
  jobs.set(id, job)
  emit(job)

  let stderrTail = ''
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let event
    try { event = JSON.parse(line) } catch {
      console.warn(`[Jobs] ${type} #${id} ignored non-JSON worker line`)
      return
    }
    if (event.type === 'result' && event.result) {
      applyTelegramMembershipResult(job, event.result)
    }
    emitEvent(job, event)
    const shouldEmit = applyTelegramLiveEvent(job, event)
    if (event.type === 'result' && job._tgLiveResult) {
      job._tgLiveResultBytes = Buffer.byteLength(line, 'utf8')
    }
    if (shouldEmit) emit(job)
  })
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000)
  })
  child.on('error', error => {
    job.error = `spawn error: ${error.message}`
  })
  try {
    child.stdin.end(JSON.stringify(request))
  } catch (error) {
    job.error = `request write failed: ${error.message}`
    try { child.kill('SIGTERM') } catch {}
  }

  child.on('close', code => {
    job.child = null
    if (job._cancelEscalationTimer) clearTimeout(job._cancelEscalationTimer)
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
      if (job.tg_live) job.tg_live.stage = 'cancelled'
    } else if (job.status === 'running') {
      if (code === 0 && job._tgLiveResult) {
        job.status = 'done'
      } else {
        job.status = 'error'
        job.error = job.error || stderrTail.slice(-500) || `python exited ${code} without a result`
        if (job.tg_live) job.tg_live.stage = 'error'
      }
    }
    job.finished_at = Math.floor(Date.now() / 1000)
    if (job.tg_live) {
      job.tg_live.result_available = job.status === 'done' && !!job._tgLiveResult
      if (job.tg_live.duration_ms == null) {
        job.tg_live.duration_ms = Math.max(0, (job.finished_at - job.started_at) * 1000)
      }
    }
    try {
      job.dbRowId = db.recordJob({
        type: job.type,
        source_id: job.source_id || null,
        status: job.status,
        items_total: job.tg_live?.unique_hits || job.items_total || 0,
        items_done: job.tg_live?.unique_hits || job.items_done || 0,
        items_failed: job.status === 'error' ? 1 : 0,
        cost_usd: 0,
        params: {
          ...job.params,
          _tg_live: publicTelegramLiveState(job.tg_live),
          _tg_live_attachment: job.tg_live_attachment || null,
          _tg_live_transcription: job.tg_live_transcription || null,
          _tg_live_membership: job.tg_live_membership || null,
          entity_title: job.entity_title || null,
          target: job.target,
        },
        error: job.error,
        started_at: job.started_at,
        finished_at: job.finished_at,
        file_path: job.file_path || null,
      })
    } catch (error) {
      console.error(`[Jobs] ${type} #${id} recordJob failed`, error)
    }
    console.log(`[Jobs] end ${type} #${id} status=${job.status} hits=${job.tg_live?.unique_hits || 0}${job.error ? ` error=${job.error}` : ''}`)
    job.phase = 'terminal'
    emit(job)
    pruneTelegramLiveResults({ keepId: job.id })
    markJobClosed(job)
  })
  return id
}

function getTelegramLiveResult(id) {
  const raw = typeof id === 'string' && id.startsWith('desktop:') ? id.slice(8) : id
  const numeric = Number(raw)
  if (!Number.isFinite(numeric)) return null
  pruneTelegramLiveResults({ keepId: numeric })
  const job = jobs.get(numeric)
  if (!job || !String(job.type || '').startsWith('tg_live_')) return null
  return job._tgLiveResult || null
}

/**
 * Pre-analysis as a real job (`type: 'tg_preview'`). Walks the same
 * iter_messages() range as a normal fetch but with --preview-only — Python
 * skips per-item events and emits one preview_summary at the end. Lives in
 * the jobs Map (so Activity panel shows it), is cancellable, and gets
 * persisted to the jobs table on close — same long-running job lifecycle
 * users already understand.
 *
 * Returns the new job id immediately; result lands in snapshot.preview_summary.
 */
function startTelegramPreview(params) {
  const id = nextId++
  const telegramSource = telegramSourceForFetchParams(params)
  const workerTarget = telegramWorkerTarget(params, telegramSource)
  const usesStableTelegramTarget = !!telegramStableTarget(telegramSource)
  const tgSession = telegramSessionForFetchParams(params)   // снимок → --session (см. startTelegramFetch)
  const args = [
    path.join(WORKERS_ROOT, 'telegram', 'tg_fetch_json.py'),
    workerTarget,
    '--mode', params.mode,
    '--preview-only',
  ]
  if (tgSession) args.push('--session', tgSession)
  if (params.limit) args.push('--limit', String(params.limit))
  if (params.date)  args.push('--date', params.date)
  if (params.date_to) args.push('--date-to', params.date_to)
  if (params.url)   args.push('--url', params.url)
  if (params.sinceMessageId) args.push('--since-msgid', String(params.sinceMessageId))

  console.log(`[Jobs] start tg_preview #${id} target=${params.target} resolve_target=${workerTarget} mode=${params.mode} limit=${params.limit || 'none'}`)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const job = {
    id,
    type: 'tg_preview',
    target: params.target,
    status: 'running',
    items_done: 0,
    items_total: params.limit || null,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params },
    source_id: telegramSource?.id || null,
    type_breakdown: {},
    tg_session: tgSession,
    _telegramWorkerTarget: workerTarget,
    _usesStableTelegramTarget: usesStableTelegramTarget,
    child,
  }
  jobs.set(id, job)
  emit(job)

  let stderrTail = ''
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handlePreviewEvent(job, evt)
  })
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      if (code === 0 && job.preview_summary) {
        job.status = 'done'
      } else {
        job.status = 'error'
        job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
      }
    }
    job.finished_at = Math.floor(Date.now() / 1000)
    const dur = job.finished_at - job.started_at
    persistTelegramUnavailableFailure(job, `tg_preview #${id}`)

    // Persist the preview into jobs table so Activity / SourceDetail history
    // restore it after Electron restart, identical to fetch jobs. We stash
    // the summary inside parameters_json next to the request params — it's
    // small (counts only, no items) so cheap to keep there.
    try {
      db.recordJob({
        type: job.type,
        source_id: job.source_id || null,
        status: job.status,
        items_total: job.preview_summary?.items_total || job.items_done,
        items_done: job.preview_summary?.items_total || job.items_done,
        params: { ...job.params, _summary: job.preview_summary || null,
                  _entity: { title: job.entity_title, kind: job.entity_kind } },
        error: job.error,
        started_at: job.started_at,
        finished_at: job.finished_at,
      })
    } catch (err) {
      console.error('[Jobs] preview recordJob failed', err)
    }

    console.log(`[Jobs] end #${id} status=${job.status} preview=${job.preview_summary?.items_total ?? '-'} duration=${dur}s${job.error ? ' error=' + job.error : ''}`)
    emit(job)
  })

  return id
}

function handlePreviewEvent(job, evt) {
  emitEvent(job, evt)
  switch (evt.type) {
    case 'entity':
      job.entity_title = evt.title || evt.username
      job.entity_kind  = evt.kind
      // Persist source row immediately, mirroring the fetch flow — gives the
      // user a Library entry even for a "just curious how big this is" pass.
      try {
        job.source_id = db.upsertSource({
          platform: 'telegram',
          handle:   evt.username || job.target,
          display_name: evt.title,
          external_id:  String(evt.id || ''),
          avatar_url:   evt.avatar_path || null,
          meta: { kind: evt.kind, username: evt.username },
          mark_synced: false,    // preview doesn't pull items; don't bump sync time
          is_explicit: true,     // preview = юзер ввёл @канал в config-form
          tg_session: job.tg_session || null, // снимок со спавна, не «сейчас»
        })
        clearTelegramUnavailableAfterLiveResolve(job.source_id, `tg_preview #${job.id}`)
      } catch (err) {
        console.error('[Jobs] preview upsertSource failed', err)
      }
      emit(job)
      break
    case 'page':
      // Python emits page events even in preview-only — use them for live
      // progress so users see the bar move on a 50k-message walk.
      job.items_done = evt.loaded
      if (evt.limit) job.items_total = evt.limit
      emit(job)
      break
    case 'preview_summary':
      job.preview_summary = {
        items_total:    evt.items_total,
        type_counts:    evt.type_counts,
        senders:        evt.senders,
        total_senders:  evt.total_senders,
        date_min:       evt.date_min,
        date_max:       evt.date_max,
        voice_seconds:  evt.voice_seconds,
        video_seconds:  evt.video_seconds,
      }
      job.items_done = evt.items_total
      job.type_breakdown = evt.type_counts || {}
      emit(job)
      break
    case 'error':
      job.error = evt.message
      if (evt.code) job.error_code = evt.code
      // 'close' will flip status — we just record the error here.
      break
  }
}

// ─── YouTube single-video transcript ──────────────────────────────────
//
// Two stages with the same job id:
//   1. spawn yt_single_ndjson.py <url> --out-dir … (lang/with-ts)
//      → if subs found: status='done', file_path set, file persisted.
//      → if subs missing: status='awaiting_ai', subprocess exited cleanly.
//   2. (optional) resumeYoutubeAi(jobId) — spawn the same script with --ai
//      → status returns to 'running', then 'done'/'error' on close.
//
// The cancel button on Activity sends SIGTERM if a child is alive; for an
// 'awaiting_ai' job (no child running), it just marks status='cancelled'.

const YT_SCRIPT = path.join(WORKERS_ROOT, 'web', 'yt_single_ndjson.py')

function lookupYoutubeCache(videoId) {
  if (!videoId) return null
  // Cross-source: check items table (any channel) AND sourceless single-video
  // jobs. Without the items branch, paste of `youtube.com/watch?v=ID` on a
  // video that lives inside an already-fetched channel re-runs subs/AI even
  // though the .txt is on disk. See `fact-youtube.md::Cache lookup`.
  const hit = db.findYoutubeTranscriptForVideo(videoId)
  if (!hit) return null
  if (!hit.file_path || !fs.existsSync(hit.file_path)) return null
  // Normalise to the shape callers expect (id/file_path/finished_at/cost_usd
  // /parameters_json). Items-origin hits don't have those — synthesise a
  // pseudo-row so the IPC contract stays the same.
  if (hit.origin === 'items') {
    return {
      id:           null,
      file_path:    hit.file_path,
      finished_at:  null,
      cost_usd:     0,
      parameters_json: JSON.stringify({
        video_id:    videoId,
        title:       hit.title || null,
        source_id:   hit.source_id,
        from_items:  true,
        from_channel: hit.source_handle || hit.source_title || null,
      }),
    }
  }
  return hit  // origin: 'jobs' — already row-shaped (id, file_path, ...)
}

// ─── YouTube comments (sourceless, like single transcript) ───────────────
//
// Wraps yt_comments_ndjson.py. Cache key is the *exact* tuple
// (video_id, sort, limit, includeReplies) — different parameter sets get
// different files, so a 200-top fetch never gets reused for a 500-new
// request. Same auto-copy-on-saved behaviour as yt_transcribe so the user
// gets text in clipboard the moment the job lands.

const YT_COMMENTS_SCRIPT = path.join(WORKERS_ROOT, 'web', 'yt_comments_ndjson.py')

function lookupYoutubeCommentsCache({ videoId, sort, limit, includeReplies }) {
  if (!videoId) return null
  const hit = db.findYoutubeCommentsForVideo({
    videoId, sort, limit: Number(limit) || 0,
    includeReplies: !!includeReplies,
  })
  if (!hit) return null
  if (!hit.file_path || !fs.existsSync(hit.file_path)) return null
  return hit
}

function startYoutubeComments(params) {
  const id = nextId++
  const sort   = params.sort === 'top' ? 'top' : 'new'
  const limit  = Number(params.limit) || 0   // 0 = all
  const wReply = !!params.includeReplies
  const args = [
    YT_COMMENTS_SCRIPT,
    params.url,
    '--out-dir', YT_COMMENTS_DIR,
    '--sort', sort,
    '--limit', String(limit),
  ]
  if (wReply) args.push('--with-replies')
  if (params._comments_archive_path) {
    args.push('--archive-json', params._comments_archive_path,
      '--expected-channel-id', params._comments_expected_channel_id)
  }

  console.log(`[Jobs] start yt_comments #${id} url=${params.url} sort=${sort} limit=${limit}${wReply ? ' +replies' : ''}`)

  const job = {
    id,
    type: 'yt_comments',
    target: params.url,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params, url: params.url, sort, limit, includeReplies: wReply },
    source_id: params._comments_source_id || null,
    dbRowId: params._comments_db_row_id || null,
    yt_comments: {
      stage:    'fetching',
      video_id: null,
      title:    null,
      channel:  null,
      sort, limit,
      include_replies: wReply,
      // Live-counter fields populated from `fetch_progress` events.
      got: 0, expected: null,
      // Final stats from the `saved` event.
      count_total: null, count_top: null, count_replies: null,
    },
    child: null,
  }
  jobs.set(id, job)
  emit(job)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.child = child
  attachYoutubeCommentsStreams(job, child)
  return id
}

function attachYoutubeCommentsStreams(job, child) {
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleYoutubeCommentsEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    job.child = null
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      if (code === 0) {
        if (!job.file_path) {
          job.status = 'error'
          job.error = job.error || stderrTail.slice(-200) || 'exited 0 without result'
        } else {
          job.status = 'done'
        }
      } else if (code === null) {
        // killed by cancelJob — status already set
      } else {
        job.status = 'error'
        job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
      }
    }
    job.finished_at = Math.floor(Date.now() / 1000)

    // Persist so the form can resurrect 'done' state on re-mount via useJobs(),
    // and so cache-lookup can find this entry next time.
    if (job.status !== 'running') {
      try {
        const record = {
          type:        'yt_comments',
          source_id:   job.source_id || null,
          status:      job.status,
          items_total: job.yt_comments?.archive_report ? Number(job.yt_comments.archive_report.unique_count || 0) : null,
          items_done:  job.yt_comments?.archive_report ? Number(job.yt_comments.archive_report.unique_count || 0) : 0,
          cost_usd:    0,
          params: {
            ...job.params,
            url:             job.target,
            video_id:        job.yt_comments?.video_id,
            title:           job.yt_comments?.title,
            channel:         job.yt_comments?.channel,
            sort:            job.yt_comments?.sort,
            limit:           job.yt_comments?.limit,
            include_replies: !!job.yt_comments?.include_replies,
            count_total:     job.yt_comments?.count_total,
            count_top:       job.yt_comments?.count_top,
            count_replies:   job.yt_comments?.count_replies,
            ...(job.yt_comments?.archive_path ? {
              _comments_archive_path: job.yt_comments.archive_path,
              _comments_archive_sha256: job.yt_comments.archive_sha256,
              _comments_archive_report: job.yt_comments.archive_report,
            } : {}),
          },
          error:       job.error,
          started_at:  job.started_at,
          finished_at: job.finished_at,
          file_path:   job.file_path || null,
        }
        if (job.dbRowId) db.updateJob(job.dbRowId, record)
        else job.dbRowId = db.recordJob(record)
      } catch (err) {
        console.error('[Jobs] yt_comments DB write failed', err)
      }
    }

    const dur = job.finished_at - job.started_at
    console.log(`[Jobs] end #${job.id} status=${job.status} duration=${dur}s${job.error ? ' error=' + job.error : ''}`)
    emit(job)
  })

  child.on('error', err => {
    job.error = `spawn error: ${err.message}`
  })
}

function handleYoutubeCommentsEvent(job, evt) {
  emitEvent(job, evt)
  switch (evt.type) {
    case 'video':
      job.entity_title = evt.title
      job.entity_kind  = 'youtube_video'
      job.yt_comments = {
        ...(job.yt_comments || {}),
        video_id:      evt.video_id,
        title:         evt.title,
        channel:       evt.channel,
        duration_sec:  evt.duration_sec,
        comment_count_total: evt.comment_count,
      }
      emit(job)
      break
    case 'fetch_progress':
      job.yt_comments = {
        ...(job.yt_comments || {}),
        got:      evt.got,
        expected: evt.expected,
      }
      // Drive the generic `items_*` numbers too so the existing Activity row
      // renderer (which keys off items_done/total) shows progress without
      // a special-case branch.
      job.items_done  = evt.got
      job.items_total = evt.expected
      emit(job)
      break
    case 'saved':
      job.file_path = evt.file_path
      job.yt_comments = {
        ...(job.yt_comments || {}),
        file_path:     evt.file_path,
        count_total:   evt.count_total,
        count_top:     evt.count_top,
        count_replies: evt.count_replies,
        ...(evt.archive_path ? { archive_path: evt.archive_path,
          archive_sha256: evt.archive_sha256, archive_report: evt.archive_report } : {}),
      }
      scheduleAutoCopy(job, evt.file_path, result => {
        job.yt_comments.copied_bytes = result.bytes
      })
      break
    case 'done':
      if (job.status === 'running' && job.file_path) {
        job.status = 'done'
        job.finished_at = Math.floor(Date.now() / 1000)
      }
      emit(job)
      break
    case 'error':
      job.error = evt.message
      job.error_code = evt.code || null
      job.yt = {
        ...(job.yt || {}),
        stage: 'error',
        failure_stage: evt.stage || job.yt?.stage || null,
      }
      break
  }
}

async function copyFileToClipboard(filePath, { silent = false } = {}) {
  // Used by both fresh and cached YouTube flow.
  // Resolves to { ok, bytes? | error }; file I/O stays in the read worker.
  // This is the clipboard primitive. Automatic delivery is separately guarded
  // by scheduleAutoCopy; explicit human Copy remains available for any result.
  const { clipboard } = require('electron')
  try {
    let result
    try {
      result = await dbRead.request('readTextFiles', [filePath], { trim: false, separator: '' })
    } catch (workerError) {
      console.error('[Jobs] auto-copy read worker failed; falling back to async fs', workerError)
      const text = await fs.promises.readFile(filePath, 'utf8')
      result = { text, parts: 1, bytes: Buffer.byteLength(text, 'utf8') }
    }
    if (!result?.parts) return { ok: false, error: 'File not found' }
    clipboard.writeText(result.text)
    if (!silent) playClipboardSound()
    return { ok: true, bytes: result.bytes }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

// Every provider uses this shared gate. MCP gets its saved result through the
// API, never the person's clipboard; manual paste-flow/extension keeps copying.
function scheduleAutoCopy(job, filePath, onCopied) {
  if (!shouldAutoCopy(job?.params)) {
    console.log(`[Jobs] auto-copy suppressed #${job?.id} type=${job?.type || 'unknown'} reason=clipboard_policy`)
    return
  }
  const silent = !!job?.params?.silentAutoCopy
  void copyFileToClipboard(filePath, { silent }).then(result => {
    if (!result?.ok) return
    try { onCopied?.(result) } catch {}
    emit(job)
  }).catch(error => {
    console.error('[Jobs] auto-copy failed', error)
  })
}

// Plays macOS system "Blow.aiff" — fire-and-forget. Used after every auto-copy
// to clipboard so the user knows the transcript landed without looking at UI.
// Manual Copy buttons in JobDetail/etc. don't call this — only auto-fires.
// MCP jobs skip the whole automatic copy, including its sound.
function playClipboardSound() {
  if (process.platform !== 'darwin') return
  try {
    const child = spawn('afplay', ['/System/Library/Sounds/Blow.aiff'], {
      stdio: 'ignore', detached: true,
    })
    child.unref()
    child.on('error', () => {})
  } catch {}
}

/**
 * Stage 1 — start a YouTube single-video transcript job.
 *  params: { url, lang?, withTs? }
 *  Returns the new job id immediately. Listeners subscribe via subscribe().
 */
function startYoutubeSingle(params) {
  const id = nextId++
  const args = [
    YT_SCRIPT,
    params.url,
    '--out-dir', YT_TRANSCRIPTS_DIR,
  ]
  if (params.lang)   args.push('--lang', params.lang)
  if (params.withTs) args.push('--with-ts')

  console.log(`[Jobs] start yt_transcribe #${id} url=${params.url} lang=${params.lang || 'ru'}`)

  const job = {
    id,
    type: 'yt_transcribe',
    target: params.url,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params, stage: 'subs' },
    yt: { stage: 'searching', video_id: null, duration_sec: null, channel: null },
    child: null,
  }
  jobs.set(id, job)
  emit(job)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.child = child
  attachYoutubeStreams(job, child)
  return id
}

/**
 * Stage 2 — re-spawn the same script with --ai. Reuses the same job id so
 * Activity panel shows one continuous record.
 *  Returns { ok: true } on success, { ok: false, error } if job is in a
 *  state that doesn't accept resume (already done, running, or cancelled).
 */
function resumeYoutubeAi(jobId, opts = {}) {
  const job = jobs.get(jobId)
  if (!job)                          return { ok: false, error: 'job not found' }
  if (job.type !== 'yt_transcribe')  return { ok: false, error: 'wrong job type' }
  if (job.status !== 'awaiting_ai')  return { ok: false, error: `job is ${job.status}` }

  const engine = opts.engine || 'gemini'
  const args = [
    YT_SCRIPT,
    job.target,
    '--out-dir', YT_TRANSCRIPTS_DIR,
    '--ai',
    '--engine', engine,
  ]
  console.log(`[Jobs] resume yt_transcribe #${jobId} engine=${engine}`)

  job.status = 'running'
  job.error  = null
  job.params = { ...job.params, stage: 'ai', engine }
  job.yt     = { ...job.yt, stage: 'transcribing', engine }
  job.finished_at = null
  emit(job)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.child = child
  attachYoutubeStreams(job, child)
  return { ok: true }
}

function attachYoutubeStreams(job, child) {
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleYoutubeEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    job.child = null
    // If the child finished but we already moved into a terminal state via
    // its events ('done' for subs/ai, or 'awaiting_ai'), don't override.
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      if (code === 0) {
        // No saved file but exit 0 → could be subs_missing without follow-up
        // (handled in handleYoutubeEvent), or an unexpected silent exit.
        if (!job.file_path && job.yt?.stage !== 'awaiting_ai') {
          job.status = 'error'
          job.error = job.error || stderrTail.slice(-200) || 'exited 0 without result'
        } else {
          job.status = 'done'
        }
      } else if (code === null) {
        // killed (SIGTERM) — cancelJob already set status.
      } else {
        job.status = 'error'
        job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
      }
    }
    job.finished_at = Math.floor(Date.now() / 1000)

    // Persist completed/cancelled/error jobs to the DB so Activity restores
    // them across app restarts. 'awaiting_ai' is in-memory only — it goes
    // away if the user closes the window without confirming.
    if (job.status !== 'awaiting_ai' && job.status !== 'running') {
      try {
        db.recordJob({
          type:         'yt_transcribe',
          // Now bound to the channel-source we upserted on `video` event.
          // Sourceless rows from older runs stay null — listSourcelessJobs
          // still finds them via type filter.
          source_id:    job.source_id || null,
          status:       job.status,
          items_total:  null,
          items_done:   0,
          cost_usd:     job.cost_usd || 0,
          params: {
            url:          job.target,
            video_id:     job.yt?.video_id,
            title:        job.entity_title,
            channel:      job.yt?.channel,
            channel_id:   job.yt?.channel_id,
            duration_sec: job.yt?.duration_sec,
            engine:       job.params?.engine,
            lang:         job.params?.lang,
            with_ts:      !!job.params?.withTs,
          },
          error:       job.error,
          started_at:  job.started_at,
          finished_at: job.finished_at,
          file_path:   job.file_path || null,
        })
      } catch (err) {
        console.error('[Jobs] yt_transcribe DB write failed', err)
      }
    }

    const dur = job.finished_at - job.started_at
    console.log(`[Jobs] end #${job.id} status=${job.status} duration=${dur}s${job.error ? ' error=' + job.error : ''}`)
    emit(job)
  })

  child.on('error', err => {
    job.error = `spawn error: ${err.message}`
    // 'close' will follow with non-zero code.
  })
}

function handleYoutubeEvent(job, evt) {
  emitEvent(job, evt)
  switch (evt.type) {
    case 'metadata_start':
      job.yt = { ...(job.yt || {}), stage: 'fetching_metadata' }
      emit(job)
      break
    case 'video':
      job.entity_title = evt.title
      job.entity_kind  = 'youtube_video'
      job.yt = {
        ...(job.yt || {}),
        video_id:     evt.video_id,
        duration_sec: evt.duration_sec,
        channel:      evt.channel,
        channel_id:   evt.channel_id,
        channel_url:  evt.channel_url,
        title:        evt.title,
        canonical_url: evt.url,
      }
      // Upsert the owning channel into Library and remember its source_id.
      // Single-video paste used to be sourceless; now it joins the same
      // architecture as batch-fetch — channel in sidebar, video as items-row
      // with transcript_path. Cross-context cache lookup (paste of the same
      // video later) finds it via items_path now too.
      if (evt.channel_id || evt.uploader_id || evt.channel) {
        try {
          const sid = db.upsertYoutubeChannel({
            channel_id:   evt.channel_id || null,
            handle:       (evt.uploader_id || '').replace(/^@+/, '') || evt.channel || null,
            display_name: evt.channel || null,
            avatar_url:   null,
            meta:         { channel_url: evt.channel_url || null },
          })
          if (sid) job.source_id = sid
        } catch (err) {
          console.error('[Jobs] upsertYoutubeChannel (single) failed', err)
        }
      }
      emit(job)
      break
    case 'subs_racing':
      job.yt = { ...(job.yt || {}), stage: 'searching' }
      emit(job)
      break
    case 'subs_found':
      job.yt = { ...(job.yt || {}), stage: 'subs_found', lang: evt.lang, with_ts: !!evt.with_ts }
      emit(job)
      break
    case 'subs_missing':
      job.yt = { ...(job.yt || {}), stage: 'awaiting_ai',
                 est_cost_usd: evt.est_cost_usd, duration_sec: evt.duration_sec }
      job.status = 'awaiting_ai'
      // 'done' will arrive too; we already set the terminal-for-stage-1 state
      emit(job)
      break
    case 'audio_download_start':
      job.yt = { ...(job.yt || {}), stage: 'downloading_audio', engine: evt.engine }
      emit(job)
      break
    case 'audio_download_done':
      job.yt = { ...(job.yt || {}), stage: 'audio_ready', engine: evt.engine, audio_bytes: evt.bytes }
      emit(job)
      break
    case 'transcribe_start':
      job.yt = { ...(job.yt || {}), stage: 'transcribing', engine: evt.engine }
      emit(job)
      break
    case 'transcribe_done':
      job.yt = { ...(job.yt || {}), stage: 'transcribed',
                 chars: evt.chars, cost_usd: evt.cost_usd }
      job.cost_usd = (job.cost_usd || 0) + (evt.cost_usd || 0)
      emit(job)
      break
    case 'save_start':
      job.yt = { ...(job.yt || {}), stage: evt.kind === 'subs' ? 'subs_found' : 'saving' }
      emit(job)
      break
    case 'saved':
      job.file_path = evt.file_path
      job.yt = { ...(job.yt || {}), file_path: evt.file_path, kind: evt.kind, chars: evt.chars }
      // Auto-copy the transcript to clipboard the moment it's saved — this
      // matches the CLI behaviour ('paste URL → text in clipboard').
      scheduleAutoCopy(job, evt.file_path, result => {
        job.yt.copied_bytes = result.bytes
      })
      // Persist the video as an items-row under its channel — cross-context
      // cache hits read from items.transcript_path. Same shape that
      // yt_batch_transcribe writes per-video on save.
      if (job.source_id && job.yt?.video_id) {
        try {
          db.bulkUpsertItems([{
            source_id:        job.source_id,
            external_id:      job.yt.video_id,
            type:             'video',
            url:              job.yt.canonical_url || job.target,
            title:            job.yt.title || null,
            duration_seconds: job.yt.duration_sec || null,
            transcript_path:  evt.file_path,
            transcribe_engine: evt.kind === 'ai' ? (job.params?.engine || 'gemini') : 'subs',
            transcribe_status: 'done',
            transcribe_cost_usd: evt.cost_usd || 0,
          }])
        } catch (err) {
          console.error('[Jobs] bulkUpsertItems (single) failed', err)
        }
      }
      break
    case 'done':
      // For Stage 1 with subs found, 'subs_missing' didn't fire so status
      // stays 'running' — flip it to 'done' here. For Stage 1 missing subs,
      // we already set 'awaiting_ai' on the missing event; respect that.
      if (job.status === 'running' && job.file_path) {
        job.status = 'done'
        job.finished_at = Math.floor(Date.now() / 1000)
      }
      emit(job)
      break
    case 'error':
      job.error = evt.message
      break
  }
}

// Derived timestamped transcript for an already-finished YouTube job.
// This is intentionally not another history job: it does not transcribe or
// spend money, it only re-fetches the video's existing subtitles and formats
// them with [HH:MM:SS] markers. Concurrent clicks share one worker promise.
const timedYoutubeRequests = new Map()

function youtubeVideoIdFromUrl(url) {
  const value = String(url || '')
  const match = value.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/)([0-9A-Za-z_-]{11})(?:[?&#/]|$)/)
  return match?.[1] || null
}

function timedYoutubeCachePath(sourceFilePath, videoId) {
  if (!sourceFilePath || !videoId) return null
  const root = path.resolve(YT_TRANSCRIPTS_DIR)
  const source = path.resolve(String(sourceFilePath))
  const relative = path.relative(root, source)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  const basename = path.basename(source)
  if (!basename.startsWith(`${videoId}__`) || !basename.endsWith('.txt')) return null
  if (basename.endsWith('__timestamps.txt')) return source
  return path.join(path.dirname(source), basename.replace(/\.txt$/i, '__timestamps.txt'))
}

function findExistingTimedYoutubeTranscript(videoId) {
  if (!videoId) return null
  try {
    const candidates = fs.readdirSync(YT_TRANSCRIPTS_DIR)
      .filter(name => name.startsWith(`${videoId}__`) && name.endsWith('__timestamps.txt'))
      .map(name => {
        const filePath = path.join(YT_TRANSCRIPTS_DIR, name)
        let mtimeMs = 0
        try { mtimeMs = fs.statSync(filePath).mtimeMs } catch {}
        return { filePath, mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return candidates[0]?.filePath || null
  } catch {
    return null
  }
}

function hasPreciseYoutubeTimestamps(filePath) {
  if (!filePath) return false
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    return /^\[\d{2}:\d{2}:\d{2}[.,]\d{3}\]\s+/m.test(text)
  } catch {
    return false
  }
}

function createYoutubeTimedTranscript(params = {}) {
  const url = String(params.url || '').trim()
  const videoId = youtubeVideoIdFromUrl(url)
  if (!videoId) return Promise.resolve({ ok: false, error: 'Не удалось распознать YouTube URL' })

  const cachedPath = timedYoutubeCachePath(params.sourceFilePath, videoId)
    || findExistingTimedYoutubeTranscript(videoId)
  if (cachedPath && fs.existsSync(cachedPath) && hasPreciseYoutubeTimestamps(cachedPath)) {
    return Promise.resolve({ ok: true, file_path: cachedPath, cached: true })
  }
  if (cachedPath && fs.existsSync(cachedPath)) {
    console.log(`[Jobs] stale yt_timed_derive cache video=${videoId} reason=second_precision`)
  }
  if (timedYoutubeRequests.has(videoId)) return timedYoutubeRequests.get(videoId)

  const lang = String(params.lang || 'ru').trim() || 'ru'
  const request = new Promise(resolve => {
    const args = [
      YT_SCRIPT,
      url,
      '--out-dir', YT_TRANSCRIPTS_DIR,
      '--lang', lang,
      '--with-ts',
      '--captions-only',
    ]
    const title = String(params.title || '').trim()
    if (title) args.push('--title', title.slice(0, 300))
    console.log(`[Jobs] start yt_timed_derive video=${videoId} lang=${lang}`)
    const child = spawn(WORKER_PYTHON, args, {
      cwd: WORKERS_ROOT,
      env: workerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let filePath = null
    let chars = null
    let workerError = null
    let stderrTail = ''

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', line => {
      if (!line.trim()) return
      let event
      try { event = JSON.parse(line) } catch { return }
      if (event.type === 'saved') {
        filePath = event.file_path || null
        chars = event.chars || null
      } else if (event.type === 'subs_missing') {
        workerError = 'У видео нет доступных субтитров с таймкодами'
      } else if (event.type === 'error') {
        workerError = event.message || 'Не удалось получить субтитры с таймкодами'
      }
    })
    child.stderr.on('data', chunk => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })
    child.on('error', err => {
      workerError = `Не удалось запустить обработку: ${err.message}`
    })
    child.on('close', code => {
      if (filePath && fs.existsSync(filePath)) {
        console.log(`[Jobs] end yt_timed_derive video=${videoId} status=done cached=0`)
        resolve({ ok: true, file_path: filePath, chars, cached: false })
        return
      }
      const detail = workerError || stderrTail.slice(-300) || `worker exited ${code}`
      console.error(`[Jobs] end yt_timed_derive video=${videoId} status=error error=${detail}`)
      resolve({ ok: false, error: detail })
    })
  })
  timedYoutubeRequests.set(videoId, request)
  request.finally(() => timedYoutubeRequests.delete(videoId))
  return request
}

// ─── Rutube single-video transcript ──────────────────────────────────
//
// The visible flow mirrors YouTube (free subtitles, then explicit AI), but
// persistence stays sourceless. A Rutube author is not a YouTube Library
// source, and this first version deliberately has no channel/catalog flow.

const RUTUBE_SCRIPT = path.join(WORKERS_ROOT, 'web', 'rutube_single_ndjson.py')

function lookupRutubeCache(videoId) {
  if (!videoId) return null
  try {
    const rows = db.getDb().prepare(
      `SELECT * FROM jobs
        WHERE type = 'rutube_transcribe'
          AND status = 'done'
          AND file_path IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 200`
    ).all()
    for (const row of rows) {
      let params = null
      try { params = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
      if (String(params?.video_id || '') !== String(videoId)) continue
      if (!row.file_path || !fs.existsSync(row.file_path)) continue
      return row
    }
  } catch (err) {
    console.error('[Jobs] lookupRutubeCache failed', err)
  }
  return null
}

function startRutubeSingle(params = {}) {
  const url = String(params.url || '').trim()
  if (!url) throw new Error('startRutubeSingle: url required')

  // React protects the button while a request is running, but a remount or
  // rapid Enter must not create a second process for the exact same paste.
  for (const existing of jobs.values()) {
    if (existing.type !== 'rutube_transcribe' || existing.target !== url) continue
    if (existing.status === 'running' || existing.status === 'awaiting_ai') return existing.id
  }

  const id = nextId++
  const args = [
    RUTUBE_SCRIPT,
    url,
    '--out-dir', RUTUBE_TRANSCRIPTS_DIR,
    '--lang', params.lang || 'ru',
  ]
  if (params.withTs) args.push('--with-ts')

  console.log(`[Jobs] start rutube_transcribe #${id} url=${url} lang=${params.lang || 'ru'}`)

  const job = {
    id,
    type: 'rutube_transcribe',
    target: url,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: { url, lang: params.lang || 'ru', withTs: !!params.withTs, stage: 'subs' },
    rutube: { stage: 'searching', video_id: null, duration_sec: null, channel: null },
    child: null,
  }
  jobs.set(id, job)
  emit(job)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.child = child
  attachRutubeStreams(job, child)
  return id
}

function resumeRutubeAi(jobId, opts = {}) {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: 'job not found' }
  if (job.type !== 'rutube_transcribe') return { ok: false, error: 'wrong job type' }
  if (job.status !== 'awaiting_ai') return { ok: false, error: `job is ${job.status}` }

  const engine = opts.engine === 'assemblyai' ? 'assemblyai' : 'gemini'
  const args = [
    RUTUBE_SCRIPT,
    job.target,
    '--out-dir', RUTUBE_TRANSCRIPTS_DIR,
    '--ai',
    '--engine', engine,
  ]
  console.log(`[Jobs] resume rutube_transcribe #${jobId} engine=${engine}`)

  job.status = 'running'
  job.error = null
  job.finished_at = null
  job.params = { ...job.params, stage: 'ai', engine }
  job.rutube = { ...job.rutube, stage: 'transcribing', engine }
  emit(job)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.child = child
  attachRutubeStreams(job, child)
  return { ok: true }
}

function attachRutubeStreams(job, child) {
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let event
    try { event = JSON.parse(line) } catch { return }
    handleRutubeEvent(job, event)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })
  child.on('error', err => {
    job.error = `spawn error: ${err.message}`
  })
  child.on('close', code => {
    job.child = null
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      if (code === 0 && job.file_path) {
        job.status = 'done'
      } else if (code !== null) {
        job.status = 'error'
        job.error = job.error || stderrTail.slice(-300) || `python exited ${code}`
      }
    }
    job.finished_at = Math.floor(Date.now() / 1000)

    if (job.status !== 'awaiting_ai' && job.status !== 'running') {
      try {
        db.recordJob({
          type: 'rutube_transcribe',
          source_id: null,
          status: job.status,
          items_total: null,
          items_done: 0,
          cost_usd: job.cost_usd || 0,
          params: {
            url: job.target,
            video_id: job.rutube?.video_id,
            title: job.entity_title,
            channel: job.rutube?.channel,
            duration_sec: job.rutube?.duration_sec,
            thumbnail_url: job.rutube?.thumbnail_url,
            engine: job.params?.engine,
            lang: job.rutube?.lang || job.params?.lang,
            with_ts: !!job.params?.withTs,
            chars: job.rutube?.chars || null,
          },
          error: job.error,
          started_at: job.started_at,
          finished_at: job.finished_at,
          file_path: job.file_path || null,
        })
      } catch (err) {
        console.error('[Jobs] rutube_transcribe DB write failed', err)
      }
    }

    const duration = job.finished_at - job.started_at
    console.log(`[Jobs] end rutube_transcribe #${job.id} status=${job.status} duration=${duration}s${job.error ? ' error=' + job.error : ''}`)
    emit(job)
  })
}

function handleRutubeEvent(job, event) {
  emitEvent(job, event)
  switch (event.type) {
    case 'metadata_start':
      job.rutube = { ...(job.rutube || {}), stage: 'fetching_metadata' }
      emit(job)
      break
    case 'video':
      job.entity_title = event.title
      job.entity_kind = 'rutube_video'
      job.rutube = {
        ...(job.rutube || {}),
        stage: 'searching',
        video_id: event.video_id,
        title: event.title,
        channel: event.channel,
        duration_sec: event.duration_sec,
        thumbnail_url: event.thumbnail_url || null,
        canonical_url: event.url,
      }
      emit(job)
      break
    case 'subs_racing':
      job.rutube = { ...(job.rutube || {}), stage: 'searching' }
      emit(job)
      break
    case 'subs_found':
      job.rutube = {
        ...(job.rutube || {}),
        stage: 'subs_found',
        lang: event.lang,
        with_ts: !!event.with_ts,
        chars: event.chars,
      }
      emit(job)
      break
    case 'subs_missing':
      job.rutube = {
        ...(job.rutube || {}),
        stage: 'awaiting_ai',
        est_cost_usd: event.est_cost_usd,
        duration_sec: event.duration_sec || job.rutube?.duration_sec,
      }
      job.status = 'awaiting_ai'
      emit(job)
      break
    case 'audio_download_start':
      job.rutube = { ...(job.rutube || {}), stage: 'downloading_audio', engine: event.engine }
      emit(job)
      break
    case 'audio_download_done':
      job.rutube = { ...(job.rutube || {}), stage: 'audio_ready', engine: event.engine, audio_bytes: event.bytes }
      emit(job)
      break
    case 'transcribe_start':
      job.rutube = { ...(job.rutube || {}), stage: 'transcribing', engine: event.engine }
      emit(job)
      break
    case 'transcribe_done':
      job.rutube = {
        ...(job.rutube || {}),
        stage: 'transcribed',
        chars: event.chars,
        cost_usd: event.cost_usd,
      }
      job.cost_usd = (job.cost_usd || 0) + Number(event.cost_usd || 0)
      emit(job)
      break
    case 'save_start':
      job.rutube = { ...(job.rutube || {}), stage: event.kind === 'subs' ? 'subs_found' : 'saving' }
      emit(job)
      break
    case 'saved': {
      job.file_path = event.file_path
      job.rutube = {
        ...(job.rutube || {}),
        file_path: event.file_path,
        kind: event.kind,
        chars: event.chars,
      }
      scheduleAutoCopy(job, event.file_path, result => {
        job.rutube.copied_bytes = result.bytes
      })
      break
    }
    case 'done':
      if (job.status === 'running' && job.file_path) {
        job.status = 'done'
        job.finished_at = Math.floor(Date.now() / 1000)
      }
      emit(job)
      break
    case 'error':
      job.error = event.message || 'Rutube worker error'
      break
  }
}

// ─── YouTube channel fetch (flat-playlist) ────────────────────────────
//
// One spawn → entity, items[*], preview_summary, done. Always upserts the
// channel as a Source on `entity` so the sidebar gets a row immediately.
// Items are bulk-upserted on close (idempotent — repeat sync just refreshes).

const YT_CHANNEL_SCRIPT = path.join(WORKERS_ROOT, 'web', 'yt_channel_ndjson.py')
const YT_BATCH_SCRIPT   = path.join(WORKERS_ROOT, 'web', 'yt_batch_transcribe_ndjson.py')

/**
 * Look up a YouTube channel in the DB by handle or channel_id.
 * Used as a cache-hit shortcut on paste — if we already know the channel,
 * the form can render its summary immediately instead of waiting for
 * yt-dlp. Returns the source row (with items_count) or null.
 */
function lookupYoutubeChannel({ handle, channel_id }) {
  try {
    const dbCon = db.getDb()
    let row = null
    if (channel_id) {
      row = dbCon.prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS items_count
           FROM sources s
          WHERE s.platform = 'youtube' AND s.external_id = ?`
      ).get(channel_id)
    }
    if (!row && handle) {
      const clean = String(handle).replace(/^@+/, '')
      row = dbCon.prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS items_count
           FROM sources s
          WHERE s.platform = 'youtube' AND s.handle = ?`
      ).get(clean)
    }
    return row || null
  } catch (err) {
    console.error('[Jobs] lookupYoutubeChannel failed', err)
    return null
  }
}

/**
 * Stage: list channel's videos via yt-dlp --flat-playlist.
 *  params: { target, limit?, reverse? }
 *  Side-effects: UPSERT source on `entity`, bulkUpsertItems on `done`.
 */
function startYoutubeChannelFetch(params) {
  const id = nextId++
  const rawLimit = Number(params?.limit)
  const requestedLimit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 200
  const args = [
    YT_CHANNEL_SCRIPT,
    params.target,
    '--limit', String(requestedLimit),
  ]
  if (params.reverse) args.push('--reverse')

  console.log(`[Jobs] start yt_channel_fetch #${id} target=${params.target} limit=${requestedLimit || 'full'}`)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const job = {
    id,
    type: 'yt_channel_fetch',
    target: params.target,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params, limit: requestedLimit },
    items: [],            // accumulated → bulkUpsert on close
    yt_channel: {},       // entity payload mirrored here
    child,
  }
  jobs.set(id, job)
  emit(job)

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleChannelEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    void (async () => {
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      job.status = code === 0 ? 'done' : 'error'
      if (code !== 0) job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
    }
    job.finished_at = Math.floor(Date.now() / 1000)

    // Persist videos → items (idempotent via UPSERT). Only on success.
    let finalizedInWorker = false
    if (job.source_id && job.items.length && job.status === 'done') {
      job.phase = 'finalizing'
      job.status = 'running'
      emit(job)
      try {
        const result = await finalizeCatalogJob({
          kind: 'youtube-channel',
          source_id: job.source_id,
          items: job.items,
          status: 'done',
          date_from: job.yt_channel?.date_min,
          date_to: job.yt_channel?.date_max,
        })
        finalizedInWorker = true
        console.log(`[CatalogFinalizer] yt source #${job.source_id} rows=${result.rows || 0}`)
      } catch (error) {
        console.error('[CatalogFinalizer] YouTube worker failed; falling back to main', error)
      }
      job.status = 'done'
    }
    try {
      if (!finalizedInWorker && job.source_id && job.items.length && job.status === 'done') {
        const rows = job.items.map(v => ({
          source_id:        job.source_id,
          external_id:      String(v.video_id),
          type:             'video',
          url:              v.url,
          title:            v.title,
          caption:          null,
          published_at:     v.timestamp || null,
          duration_seconds: v.duration_sec || null,
          views:            v.view_count || null,
          likes:            null,
          comments:         null,
          sender:           null,
          has_media:        true,
          raw_meta:         null,
        }))
        db.bulkUpsertItems(rows)
        console.log(`[Jobs] DB upserted ${rows.length} videos into source #${job.source_id}`)

        // Coverage row: depth=metadata. Captures total range so SourceDetail
        // can show "we know about N videos in this date span". Multiple
        // syncs → multiple rows; UI aggregates.
        try {
          db.recordCoverage({
            source_id:    job.source_id,
            job_id:       null,                 // job written below
            date_from:    job.yt_channel?.date_min,
            date_to:      job.yt_channel?.date_max,
            content_type: 'video',
            depth:        'metadata',
            items_count:  rows.length,
          })
        } catch (err) {
          console.error('[Jobs] coverage write failed', err)
        }
      }
    } catch (err) {
      console.error('[Jobs] yt_channel_fetch DB write failed', err)
    }

    // Channel-list fetches are NOT persisted to the jobs table — they're
    // routine "refresh data" actions, not operations the user needs in
    // history. The channel's last_synced_at on `sources` covers "when did
    // we last update the list".  Only batch transcribes / TG fetches stay.

    if (job.status === 'done' && job.source_id && job.yt_channel?.channel_id) {
      try {
        db.upsertYoutubeChannel({
          channel_id: job.yt_channel.channel_id,
          handle: job.yt_channel.handle,
          display_name: job.yt_channel.title,
          avatar_url: job.yt_channel.avatar_url,
          meta: {
            subs_count: job.yt_channel.subs_count,
            channel_url: job.yt_channel.url,
            catalog_last_fetch_count: job.yt_channel.loaded_count ?? job.items_done ?? 0,
            catalog_total: job.yt_channel.catalog_complete
              ? (job.yt_channel.catalog_total ?? job.items_done ?? 0)
              : null,
            catalog_complete: !!job.yt_channel.catalog_complete,
            catalog_requested_limit: requestedLimit,
            catalog_updated_at: job.finished_at,
          },
          is_explicit: true,
        })
      } catch (err) {
        console.error('[Jobs] YouTube catalog coverage meta write failed', err)
      }
    }

    delete job.items
    job.phase = 'terminal'
    const dur = job.finished_at - job.started_at
    console.log(`[Jobs] end #${id} status=${job.status} items=${job.items_done} duration=${dur}s${job.error ? ' error=' + job.error : ''}`)
    emit(job)
    markJobClosed(job)
    })().catch(error => {
      job.status = 'error'
      job.phase = 'terminal'
      job.error = String(error?.message || error)
      job.finished_at = Math.floor(Date.now() / 1000)
      delete job.items
      console.error(`[Jobs] yt_channel_fetch #${id} close failed`, error)
      emit(job)
      markJobClosed(job)
    })
  })

  return id
}

function handleChannelEvent(job, evt) {
  emitEvent(job, evt)
  switch (evt.type) {
    case 'entity':
      job.entity_title = evt.title
      job.entity_kind  = 'youtube_channel'
      job.yt_channel = {
        ...job.yt_channel,
        channel_id: evt.channel_id,
        handle:     evt.handle,
        title:      evt.title,
        avatar_url: evt.avatar_url,
        subs_count: evt.subs_count,
        url:        evt.url,
      }
      // Persist source row immediately so the sidebar updates while
      // yt-dlp is still streaming entries.
      try {
        job.source_id = db.upsertYoutubeChannel({
          channel_id:   evt.channel_id,
          handle:       evt.handle,
          display_name: evt.title,
          avatar_url:   evt.avatar_url,
          meta:         { subs_count: evt.subs_count, channel_url: evt.url },
          is_explicit:  true,        // channel-fetch = осознанный pull списка видео
        })
      } catch (err) {
        console.error('[Jobs] upsertYoutubeChannel failed', err)
      }
      emit(job)
      break
    case 'item':
      job.items_done = (job.items_done || 0) + 1
      job.items.push(evt.data)
      if (evt.data.timestamp) {
        const ts = evt.data.timestamp
        if (!job.yt_channel.date_min || ts < job.yt_channel.date_min) job.yt_channel.date_min = ts
        if (!job.yt_channel.date_max || ts > job.yt_channel.date_max) job.yt_channel.date_max = ts
      }
      break
    case 'page':
      job.items_done  = evt.loaded
      job.items_total = evt.limit || null
      emit(job)
      break
    case 'preview_summary':
      job.yt_channel = {
        ...job.yt_channel,
        items_total:        evt.items_total,
        loaded_count:       evt.loaded_count ?? evt.items_total,
        catalog_total:      evt.catalog_total ?? null,
        catalog_complete:   !!evt.catalog_complete,
        requested_limit:    evt.requested_limit,
        total_duration_sec: evt.total_duration_sec,
        date_min:           evt.date_min || job.yt_channel.date_min,
        date_max:           evt.date_max || job.yt_channel.date_max,
      }
      emit(job)
      break
    case 'done':
      job.items_total = evt.items_total
      job.items_done  = evt.items_total
      // status set on close — keep in sync
      break
    case 'error':
      job.error = evt.message
      break
  }
}

// ─── YouTube batch transcribe ─────────────────────────────────────────
//
// Iterates over a fixed list of video ids (chosen by the user from a
// channel's video list). Each video: subs first, AI fallback if --auto-ai.
// Updates items.transcript_path / FTS as 'saved' events arrive.

// All-cached short-circuit: when every selected video already has a
// transcript on disk, we don't spawn yt_batch_transcribe at all — it would
// re-fetch metadata and re-extract subs for nothing. Synthesise a `done`
// job snapshot so JobDetail / picker render the same final layout, plus a
// DB row so the run still appears in history.
function _synthesiseAllCachedBatchJob(params, cachedFiles) {
  const id = nextId++
  const now = Math.floor(Date.now() / 1000)
  const log = params.video_ids.map(vid => ({
    video_id:  vid,
    kind:      'cache',
    file_path: cachedFiles[vid],
  }))
  const job = {
    id,
    type:        'yt_batch_transcribe',
    target:      params.source_id ? `source:${params.source_id}` : `batch:${params.video_ids.length}`,
    status:      'done',
    items_done:  params.video_ids.length,
    items_total: params.video_ids.length,
    started_at:  now,
    finished_at: now,
    params:      { ...params },
    yt_batch: {
      saved:    params.video_ids.length,
      skipped:  0,
      errors:   0,
      cost_usd: 0,
      current:  null,
      log,
    },
  }
  jobs.set(id, job)
  // Persist a DB row so Activity panel & history include this no-spawn run.
  try {
    const persistParams = { ...params }
    if (params.is_search) persistParams.video_files = { ...cachedFiles }
    db.recordJob({
      type:        'yt_batch_transcribe',
      source_id:   params.source_id || null,
      status:      'done',
      items_total: params.video_ids.length,
      items_done:  params.video_ids.length,
      items_failed: 0,
      cost_usd:    0,
      params:      persistParams,
      started_at:  now,
      finished_at: now,
    })
  } catch (err) {
    console.error('[Jobs] all-cached batch DB write failed', err)
  }
  console.log(`[Jobs] yt_batch_transcribe #${id} all-cached (${params.video_ids.length}) — no spawn`)
  emit(job)
  return id
}

async function startYoutubeBatchTranscribe(params) {
  if (!Array.isArray(params.video_ids) || params.video_ids.length === 0) {
    throw new Error('video_ids must be a non-empty array')
  }

  // Pre-filter videos that already have a transcript saved anywhere in the
  // local DB (any channel's items + sourceless single-video jobs). For both
  // channel-batches and search-batches: re-running on the same video pays
  // AI/subs again for nothing. We persist the original list as
  // `params.video_ids` (audit) and the actual spawn-list as
  // `params.video_ids_run` so JobDetail still renders all selected rows
  // (cached ones get '✓ из кэша').
  let cachePlan
  try {
    cachePlan = await dbRead.request('youtubeBatchCachePlan', params.video_ids)
  } catch (workerError) {
    console.error('[Jobs] YouTube batch cache worker failed; falling back to main', workerError)
    const cacheMap = db.findYoutubeTranscriptsByVideoIds(params.video_ids)
    const cachedFiles = {}
    for (const [videoId, hit] of cacheMap) {
      if (hit.file_path && fs.existsSync(hit.file_path)) cachedFiles[String(videoId)] = hit.file_path
    }
    const cachedIds = Object.keys(cachedFiles)
    const cached = new Set(cachedIds)
    cachePlan = {
      cachedIds,
      cachedFiles,
      runIds: params.video_ids.map(String).filter(videoId => !cached.has(videoId)),
    }
  }
  const { cachedIds, cachedFiles, runIds } = cachePlan

  if (runIds.length === 0) {
    // Nothing to spawn — every selected video already has a transcript.
    // Synthesise a done-job so JobDetail / picker show the same final view
    // as if we had run and skipped everything.
    return _synthesiseAllCachedBatchJob(params, cachedFiles)
  }

  if (cachedIds.length > 0) {
    console.log(`[Jobs] yt_batch_transcribe pre-filter: ${cachedIds.length}/${params.video_ids.length} already cached`)
  }

  const id = nextId++

  const args = [
    YT_BATCH_SCRIPT,
    '--videos', runIds.join(','),
    '--out-dir', YT_TRANSCRIPTS_DIR,
    '--lang', params.lang || 'ru',
  ]
  if (params.with_ts) args.push('--with-ts')
  if (params.auto_ai) args.push('--auto-ai')
  if (params.engine)  args.push('--engine', params.engine)

  console.log(`[Jobs] start yt_batch_transcribe #${id} count=${params.video_ids.length} auto_ai=${!!params.auto_ai} engine=${params.engine || '-'}`)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Seed b.log with cached entries up-front so the picker / JobDetail show
  // them as ✓ from the very first render. Using kind='cache' keeps them
  // distinct from fresh subs/AI in the UI ("✓ из кэша") without changing
  // the saved-count semantics (cached doesn't bump cost_usd).
  const seedLog = cachedIds.map(vid => ({
    video_id:  vid,
    kind:      'cache',
    file_path: cachedFiles[vid],
  }))

  const job = {
    id,
    type: 'yt_batch_transcribe',
    target: params.source_id ? `source:${params.source_id}` : `batch:${params.video_ids.length}`,
    status: 'running',
    items_done: cachedIds.length,
    items_total: params.video_ids.length,
    started_at: Math.floor(Date.now() / 1000),
    // Preserve the *full* selection in params.video_ids; runIds is only the
    // fresh subset Python is processing. Mirror cache hits into video_files
    // for sourceless (search) batches so assembleBatchTranscript can copy
    // them without items-table lookup.
    params: { ...params },
    yt_batch: {
      saved:    cachedIds.length,   // cached ones count as already-done
      skipped:  0,
      errors:   0,
      cost_usd: 0,
      current:  null,
      log:      seedLog,
    },
    child,
  }
  // Mark these as "already had a transcript" so the close-handler merges
  // them into params.video_files (search-batch) without re-querying.
  job._cachedIds = cachedIds
  job._cachedFiles = cachedFiles
  jobs.set(id, job)
  emit(job)

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleBatchEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    void (async () => {
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      job.status = code === 0 ? 'done' : 'error'
      if (code !== 0) job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
    }
    job.finished_at = Math.floor(Date.now() / 1000)

    const terminalStatus = job.status
    job.phase = 'finalizing'
    job.status = terminalStatus === 'cancelled' ? 'cancelling' : 'running'
    emit(job)
    await waitForJobPersistence(job)

    const persistParams = { ...job.params }
    if (job.params?.is_search) {
      persistParams.video_files = (job.yt_batch.log || [])
        .filter(row => row.file_path)
        .reduce((map, row) => { map[row.video_id] = row.file_path; return map }, {})
    }
    let finalizedInWorker = false
    try {
      await finalizeBatchJob({
        job: {
          type: 'yt_batch_transcribe',
          source_id: params.source_id || null,
          status: terminalStatus,
          items_total: params.video_ids.length,
          items_done: job.yt_batch.saved,
          items_failed: job.yt_batch.errors,
          cost_usd: job.yt_batch.cost_usd,
          params: persistParams,
          error: job.error,
          started_at: job.started_at,
          finished_at: job.finished_at,
        },
        coverage: params.source_id && job.yt_batch.saved > 0 ? {
          source_id: params.source_id,
          content_type: 'video', depth: 'transcribed', items_count: job.yt_batch.saved,
        } : null,
      })
      finalizedInWorker = true
    } catch (error) {
      console.error('[Jobs] yt_batch finalizer worker failed; falling back to main', error)
    }
    job.status = terminalStatus

    try {
      // For sourceless search-batches, persist the full video metadata
      // and per-video file paths into params so JobDetail can render the
      // finalized list and yt:assembleBatchTranscript can rebuild after
      // restart without touching the items table.
      if (!finalizedInWorker) db.recordJob({
        type:        'yt_batch_transcribe',
        source_id:   params.source_id || null,
        status:      job.status,
        items_total: params.video_ids.length,
        items_done:  job.yt_batch.saved,
        items_failed:job.yt_batch.errors,
        cost_usd:    job.yt_batch.cost_usd,
        params:      persistParams,
        error:       job.error,
        started_at:  job.started_at,
        finished_at: job.finished_at,
      })

      // Coverage: each transcribed video bumps depth. We record one row
      // for the slice of videos the batch actually saved.
      if (!finalizedInWorker && params.source_id && job.yt_batch.saved > 0) {
        db.recordCoverage({
          source_id:    params.source_id,
          job_id:       null,
          date_from:    null,
          date_to:      null,
          content_type: 'video',
          depth:        'transcribed',
          items_count:  job.yt_batch.saved,
        })
      }
    } catch (err) {
      console.error('[Jobs] yt_batch_transcribe DB write failed', err)
    }

    const dur = job.finished_at - job.started_at
    job.phase = 'terminal'
    console.log(`[Jobs] end #${id} status=${job.status} saved=${job.yt_batch.saved} skipped=${job.yt_batch.skipped} errors=${job.yt_batch.errors} cost=$${job.yt_batch.cost_usd.toFixed(4)} duration=${dur}s`)
    emit(job)
    markJobClosed(job)
    })().catch(error => {
      job.status = 'error'
      job.phase = 'terminal'
      job.error = String(error?.message || error)
      job.finished_at = Math.floor(Date.now() / 1000)
      console.error(`[Jobs] yt_batch_transcribe #${id} close failed`, error)
      emit(job)
      markJobClosed(job)
    })
  })

  return id
}

function handleBatchEvent(job, evt) {
  emitEvent(job, evt)
  const b = job.yt_batch
  switch (evt.type) {
    case 'item_start':
      b.current = { i: evt.i, n: evt.n, video_id: evt.video_id, title: evt.title,
                    duration_sec: evt.duration_sec, channel: evt.channel, stage: 'subs' }
      job.items_done = evt.i - 1   // visual progress: "currently doing #i of n"
      emit(job)
      break
    case 'subs_racing':
      if (b.current) b.current.stage = 'searching'
      break
    case 'subs_found':
      if (b.current) b.current.stage = 'subs_found'
      break
    case 'subs_missing':
      if (b.current) b.current.stage = 'awaiting_ai'
      break
    case 'audio_download_start':
      if (b.current) { b.current.stage = 'downloading_audio'; b.current.engine = evt.engine }
      emit(job)
      break
    case 'audio_download_done':
      if (b.current) { b.current.stage = 'audio_ready'; b.current.bytes = evt.bytes || null }
      emit(job)
      break
    case 'transcribe_start':
      if (b.current) { b.current.stage = 'transcribing'; b.current.engine = evt.engine }
      break
    case 'transcribe_done':
      b.cost_usd += evt.cost_usd || 0
      break
    case 'saved':
      b.saved += 1
      job.items_done = (b.saved + b.skipped + b.errors)
      // Persist transcript path on the corresponding item row
      if (job.params?.source_id) {
        const args = {
          source_id: job.params.source_id,
          external_id: evt.video_id,
          transcript_path: evt.file_path,
          engine: evt.kind === 'ai' ? (job.params.engine || 'gemini') : 'subs',
          cost_usd: evt.cost_usd || null,
        }
        queueJobPersistence(
          job,
          `yt_batch #${job.id} mark transcript`,
          () => persistItemMutation({ method: 'markItemTranscribed', args }),
          () => db.markItemTranscribed(args),
        )
      }
      b.log.push({ video_id: evt.video_id, kind: evt.kind, file_path: evt.file_path })
      emit(job)
      break
    case 'skipped':
      b.skipped += 1
      job.items_done = (b.saved + b.skipped + b.errors)
      b.log.push({ video_id: evt.video_id, kind: 'skipped', reason: evt.reason })
      emit(job)
      break
    case 'item_error':
      b.errors += 1
      job.items_done = (b.saved + b.skipped + b.errors)
      b.log.push({ video_id: evt.video_id, kind: 'error', code: evt.code || null, stage: evt.stage || null, message: evt.message })
      emit(job)
      break
    case 'done':
      // totals already tracked from per-item events. status set on close.
      break
    case 'error':
      job.error = evt.message
      break
  }
}

// ─── YouTube batch comments ───────────────────────────────────────────
//
// Iterates over a fixed list of video ids, invoking yt_comments_ndjson.py
// per video sequentially. Same per-item event protocol as batch transcribe
// (item_start / saved / skipped / item_error / done) so JobDetail and the
// Activity panel handle it through familiar shapes.

const YT_BATCH_COMMENTS_SCRIPT = path.join(WORKERS_ROOT, 'web', 'yt_batch_comments_ndjson.py')

function _synthesiseAllCachedBatchCommentsJob(params, cachedFiles) {
  const id = nextId++
  const now = Math.floor(Date.now() / 1000)
  const log = params.video_ids.map(vid => ({
    video_id:  vid,
    kind:      'cache',
    file_path: cachedFiles[vid],
  }))
  const job = {
    id,
    type:        'yt_batch_comments',
    target:      params.source_id ? `source:${params.source_id}` : `batch-comments:${params.video_ids.length}`,
    status:      'done',
    items_done:  params.video_ids.length,
    items_total: params.video_ids.length,
    started_at:  now,
    finished_at: now,
    params:      { ...params },
    yt_batch: {
      saved:    params.video_ids.length,
      skipped:  0,
      errors:   0,
      cost_usd: 0,
      current:  null,
      log,
    },
  }
  jobs.set(id, job)
  try {
    const persistParams = { ...params }
    persistParams.video_files = { ...cachedFiles }
    db.recordJob({
      type:         'yt_batch_comments',
      source_id:    params.source_id || null,
      status:       'done',
      items_total:  params.video_ids.length,
      items_done:   params.video_ids.length,
      items_failed: 0,
      cost_usd:     0,
      params:       persistParams,
      started_at:   now,
      finished_at:  now,
    })
  } catch (err) {
    console.error('[Jobs] all-cached batch-comments DB write failed', err)
  }
  console.log(`[Jobs] yt_batch_comments #${id} all-cached (${params.video_ids.length}) — no spawn`)
  emit(job)
  return id
}

function startYoutubeBatchComments(params) {
  if (!Array.isArray(params.video_ids) || params.video_ids.length === 0) {
    throw new Error('video_ids must be a non-empty array')
  }
  const sort   = params.sort === 'top' ? 'top' : 'new'
  const limit  = Number.isFinite(Number(params.limit)) ? Number(params.limit) : 500
  const wReply = !!params.includeReplies

  // Pre-filter cached: lookup is param-exact for the selected (sort, limit,
  // includeReplies). Comments cached under different params don't count —
  // the user explicitly selected this combo so we'd lie if we reused others.
  const cachedFiles = {}
  for (const vid of params.video_ids) {
    const hit = db.findYoutubeCommentsForVideo({
      videoId: vid, sort, limit, includeReplies: wReply,
    })
    if (hit && hit.file_path && fs.existsSync(hit.file_path)) {
      cachedFiles[vid] = hit.file_path
    }
  }
  const cachedSet = new Set(Object.keys(cachedFiles))
  const runIds = params.video_ids.filter(v => !cachedSet.has(v))

  if (runIds.length === 0) {
    return _synthesiseAllCachedBatchCommentsJob(
      { ...params, sort, limit, includeReplies: wReply }, cachedFiles)
  }

  if (cachedSet.size > 0) {
    console.log(`[Jobs] yt_batch_comments pre-filter: ${cachedSet.size}/${params.video_ids.length} already cached`)
  }

  const id = nextId++
  const args = [
    YT_BATCH_COMMENTS_SCRIPT,
    '--videos',  runIds.join(','),
    '--out-dir', YT_COMMENTS_DIR,
    '--sort',    sort,
    '--limit',   String(limit),
  ]
  if (wReply) args.push('--with-replies')

  console.log(`[Jobs] start yt_batch_comments #${id} count=${params.video_ids.length} sort=${sort} limit=${limit}${wReply ? ' +replies' : ''}`)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const seedLog = Object.entries(cachedFiles).map(([vid, fp]) => ({
    video_id:  vid,
    kind:      'cache',
    file_path: fp,
  }))

  const job = {
    id,
    type: 'yt_batch_comments',
    target: params.source_id ? `source:${params.source_id}` : `batch-comments:${params.video_ids.length}`,
    status: 'running',
    items_done: cachedSet.size,
    items_total: params.video_ids.length,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params, sort, limit, includeReplies: wReply },
    yt_batch: {
      saved:    cachedSet.size,
      skipped:  0,
      errors:   0,
      cost_usd: 0,
      current:  null,
      log:      seedLog,
    },
    child,
  }
  job._cachedFiles = cachedFiles
  jobs.set(id, job)
  emit(job)

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleBatchCommentsEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    if (job.status === 'running') {
      job.status = code === 0 ? 'done' : 'error'
      if (code !== 0) job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
    }
    job.finished_at = Math.floor(Date.now() / 1000)

    try {
      const persistParams = { ...job.params }
      persistParams.video_files = (job.yt_batch.log || [])
        .filter(r => r.file_path)
        .reduce((m, r) => { m[r.video_id] = r.file_path; return m }, {})
      db.recordJob({
        type:         'yt_batch_comments',
        source_id:    params.source_id || null,
        status:       job.status,
        items_total:  params.video_ids.length,
        items_done:   job.yt_batch.saved,
        items_failed: job.yt_batch.errors,
        cost_usd:     0,
        params:       persistParams,
        error:        job.error,
        started_at:   job.started_at,
        finished_at:  job.finished_at,
      })
    } catch (err) {
      console.error('[Jobs] yt_batch_comments DB write failed', err)
    }

    const dur = job.finished_at - job.started_at
    console.log(`[Jobs] end #${id} status=${job.status} saved=${job.yt_batch.saved} skipped=${job.yt_batch.skipped} errors=${job.yt_batch.errors} duration=${dur}s`)
    emit(job)
  })

  return id
}

function handleBatchCommentsEvent(job, evt) {
  emitEvent(job, evt)
  const b = job.yt_batch
  switch (evt.type) {
    case 'item_start':
      b.current = {
        i: evt.i, n: evt.n, video_id: evt.video_id, title: evt.title,
        channel: evt.channel, comment_count: evt.comment_count,
        got: 0, expected: null, stage: 'fetching',
      }
      job.items_done = evt.i - 1
      emit(job)
      break
    case 'fetch_progress':
      if (b.current) {
        b.current.got = evt.got
        b.current.expected = evt.expected
      }
      emit(job)
      break
    case 'saved':
      b.saved += 1
      job.items_done = (b.saved + b.skipped + b.errors)
      b.log.push({
        video_id:      evt.video_id,
        kind:          'comments',
        file_path:     evt.file_path,
        count_total:   evt.count_total,
        count_top:     evt.count_top,
        count_replies: evt.count_replies,
      })
      emit(job)
      break
    case 'skipped':
      b.skipped += 1
      job.items_done = (b.saved + b.skipped + b.errors)
      b.log.push({ video_id: evt.video_id, kind: 'skipped', reason: evt.reason })
      emit(job)
      break
    case 'item_error':
      b.errors += 1
      job.items_done = (b.saved + b.skipped + b.errors)
      b.log.push({ video_id: evt.video_id, kind: 'error', message: evt.message })
      emit(job)
      break
    case 'done':
      break
    case 'error':
      job.error = evt.message
      break
  }
}

// ─── TikTok ───────────────────────────────────────────────────────────
//
// Three flows mirror YouTube:
//   1. Channel-fetch: tk_channel_ndjson.py → list videos → upsert source/items.
//   2. Single video:  tk_single_ndjson.py  → AI transcribe one URL (no subs
//                     stage on TikTok, so no awaiting_ai).
//   3. Batch:         tk_batch_transcribe_ndjson.py → loop AI over N videos.

const TK_CHANNEL_SCRIPT = path.join(WORKERS_ROOT, 'web', 'tk_channel_ndjson.py')
const TK_SINGLE_SCRIPT  = path.join(WORKERS_ROOT, 'web', 'tk_single_ndjson.py')
const TK_BATCH_SCRIPT   = path.join(WORKERS_ROOT, 'web', 'tk_batch_transcribe_ndjson.py')

function lookupTiktokChannel({ handle, channel_id }) {
  try {
    const dbCon = db.getDb()
    let row = null
    if (channel_id) {
      row = dbCon.prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS items_count
           FROM sources s
          WHERE s.platform = 'tiktok' AND s.external_id = ?`
      ).get(String(channel_id))
    }
    if (!row && handle) {
      const clean = String(handle).replace(/^@+/, '')
      row = dbCon.prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS items_count
           FROM sources s
          WHERE s.platform = 'tiktok' AND s.handle = ?`
      ).get(clean)
    }
    return row || null
  } catch (err) {
    console.error('[Jobs] lookupTiktokChannel failed', err)
    return null
  }
}

function lookupTiktokCache(videoId) {
  if (!videoId) return null
  // Mirror of lookupYoutubeCache — cross-source via items table.
  const hit = db.findTiktokTranscriptForVideo(videoId)
  if (!hit) return null
  if (!hit.file_path || !fs.existsSync(hit.file_path)) return null
  if (hit.origin === 'items') {
    return {
      id:           null,
      file_path:    hit.file_path,
      finished_at:  null,
      cost_usd:     0,
      parameters_json: JSON.stringify({
        video_id:    videoId,
        title:       hit.title || null,
        source_id:   hit.source_id,
        from_items:  true,
        from_channel: hit.source_handle || hit.source_title || null,
      }),
    }
  }
  return hit
}

function startTiktokChannelFetch(params) {
  const id = nextId++
  const args = [
    TK_CHANNEL_SCRIPT,
    params.target,
    '--limit', String(params.limit || 200),
  ]
  if (params.reverse) args.push('--reverse')

  console.log(`[Jobs] start tk_channel_fetch #${id} target=${params.target} limit=${params.limit || 200}`)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const job = {
    id,
    type: 'tk_channel_fetch',
    target: params.target,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params },
    items: [],
    tk_channel: {},
    child,
  }
  jobs.set(id, job)
  emit(job)

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleTiktokChannelEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    void (async () => {
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      job.status = code === 0 ? 'done' : 'error'
      if (code !== 0) job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
    }
    job.finished_at = Math.floor(Date.now() / 1000)

    let finalizedInWorker = false
    if (job.source_id && job.items.length && job.status === 'done') {
      job.phase = 'finalizing'
      job.status = 'running'
      emit(job)
      try {
        const result = await finalizeCatalogJob({
          kind: 'tiktok-channel',
          source_id: job.source_id,
          items: job.items,
          status: 'done',
          date_from: job.tk_channel?.date_min,
          date_to: job.tk_channel?.date_max,
        })
        finalizedInWorker = true
        console.log(`[CatalogFinalizer] TikTok source #${job.source_id} rows=${result.rows || 0}`)
      } catch (error) {
        console.error('[CatalogFinalizer] TikTok worker failed; falling back to main', error)
      }
      job.status = 'done'
    }
    try {
      if (!finalizedInWorker && job.source_id && job.items.length && job.status === 'done') {
        const rows = job.items.map(v => ({
          source_id:        job.source_id,
          external_id:      String(v.video_id),
          type:             'video',
          url:              v.url,
          title:            v.title,
          caption:          null,
          published_at:     v.timestamp || null,
          duration_seconds: v.duration_sec || null,
          views:            v.view_count || null,
          likes:            null,
          comments:         null,
          sender:           null,
          has_media:        true,
          raw_meta:         null,
        }))
        db.bulkUpsertItems(rows)
        console.log(`[Jobs] DB upserted ${rows.length} tiktok videos into source #${job.source_id}`)

        try {
          db.recordCoverage({
            source_id:    job.source_id,
            job_id:       null,
            date_from:    job.tk_channel?.date_min,
            date_to:      job.tk_channel?.date_max,
            content_type: 'video',
            depth:        'metadata',
            items_count:  rows.length,
          })
        } catch (err) {
          console.error('[Jobs] coverage write failed', err)
        }
      }
    } catch (err) {
      console.error('[Jobs] tk_channel_fetch DB write failed', err)
    }

    delete job.items
    job.phase = 'terminal'
    const dur = job.finished_at - job.started_at
    console.log(`[Jobs] end #${id} status=${job.status} items=${job.items_done} duration=${dur}s${job.error ? ' error=' + job.error : ''}`)
    emit(job)
    markJobClosed(job)
    })().catch(error => {
      job.status = 'error'
      job.phase = 'terminal'
      job.error = String(error?.message || error)
      job.finished_at = Math.floor(Date.now() / 1000)
      delete job.items
      console.error(`[Jobs] tk_channel_fetch #${id} close failed`, error)
      emit(job)
      markJobClosed(job)
    })
  })

  return id
}

function handleTiktokChannelEvent(job, evt) {
  emitEvent(job, evt)
  switch (evt.type) {
    case 'entity':
      job.entity_title = evt.title
      job.entity_kind  = 'tiktok_channel'
      job.tk_channel = {
        ...job.tk_channel,
        channel_id: evt.channel_id,
        handle:     evt.handle,
        title:      evt.title,
        avatar_url: evt.avatar_url,
        url:        evt.url,
      }
      try {
        job.source_id = db.upsertTiktokChannel({
          channel_id:   evt.channel_id,
          handle:       evt.handle,
          display_name: evt.title,
          avatar_url:   evt.avatar_url,
          meta:         { channel_url: evt.url },
          is_explicit:  true,         // TikTok channel-fetch = осознанный
        })
      } catch (err) {
        console.error('[Jobs] upsertTiktokChannel failed', err)
      }
      emit(job)
      break
    case 'item':
      job.items_done = (job.items_done || 0) + 1
      job.items.push(evt.data)
      if (evt.data.timestamp) {
        const ts = evt.data.timestamp
        if (!job.tk_channel.date_min || ts < job.tk_channel.date_min) job.tk_channel.date_min = ts
        if (!job.tk_channel.date_max || ts > job.tk_channel.date_max) job.tk_channel.date_max = ts
      }
      break
    case 'page':
      job.items_done  = evt.loaded
      job.items_total = evt.limit || null
      emit(job)
      break
    case 'preview_summary':
      job.tk_channel = {
        ...job.tk_channel,
        items_total:        evt.items_total,
        total_duration_sec: evt.total_duration_sec,
        date_min:           evt.date_min || job.tk_channel.date_min,
        date_max:           evt.date_max || job.tk_channel.date_max,
      }
      emit(job)
      break
    case 'done':
      job.items_total = evt.items_total
      job.items_done  = evt.items_total
      break
    case 'error':
      job.error = evt.message
      break
  }
}

function startTiktokSingle(params) {
  const id = nextId++
  const args = [
    TK_SINGLE_SCRIPT,
    params.url,
    '--out-dir', TK_TRANSCRIPTS_DIR,
    '--engine', params.engine || 'gemini',
  ]

  console.log(`[Jobs] start tk_transcribe #${id} url=${params.url} engine=${params.engine || 'gemini'}`)

  const job = {
    id,
    type: 'tk_transcribe',
    target: params.url,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params },
    tk: { stage: 'fetching_meta', video_id: null, duration_sec: null, channel: null },
    child: null,
  }
  jobs.set(id, job)
  emit(job)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.child = child

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleTiktokSingleEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    job.child = null
    if (job.status === 'running') {
      if (code === 0 && job.file_path) {
        job.status = 'done'
      } else if (code === null) {
        // killed — cancelJob set status
      } else {
        job.status = 'error'
        job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
      }
    }
    job.finished_at = Math.floor(Date.now() / 1000)

    if (job.status !== 'running') {
      try {
        db.recordJob({
          type:         'tk_transcribe',
          source_id:    null,
          status:       job.status,
          items_total:  null,
          items_done:   0,
          cost_usd:     job.cost_usd || 0,
          params: {
            url:          job.target,
            video_id:     job.tk?.video_id,
            title:        job.entity_title,
            channel:      job.tk?.channel,
            duration_sec: job.tk?.duration_sec,
            engine:       job.params?.engine,
          },
          error:       job.error,
          started_at:  job.started_at,
          finished_at: job.finished_at,
          file_path:   job.file_path || null,
        })
      } catch (err) {
        console.error('[Jobs] tk_transcribe DB write failed', err)
      }
    }

    const dur = job.finished_at - job.started_at
    console.log(`[Jobs] end #${id} status=${job.status} duration=${dur}s${job.error ? ' error=' + job.error : ''}`)
    emit(job)
  })

  return id
}

function handleTiktokSingleEvent(job, evt) {
  emitEvent(job, evt)
  switch (evt.type) {
    case 'video':
      job.entity_title = evt.title
      job.entity_kind  = 'tiktok_video'
      job.tk = {
        ...(job.tk || {}),
        video_id:      evt.video_id,
        duration_sec:  evt.duration_sec,
        channel:       evt.channel,
        title:         evt.title,
        canonical_url: evt.url,
        stage:         'downloading',
      }
      emit(job)
      break
    case 'download_start':
      job.tk = { ...(job.tk || {}), stage: 'downloading' }
      emit(job)
      break
    case 'download_done':
      job.tk = { ...(job.tk || {}), stage: 'downloaded', bytes: evt.bytes }
      break
    case 'transcribe_start':
      job.tk = { ...(job.tk || {}), stage: 'transcribing', engine: evt.engine }
      emit(job)
      break
    case 'transcribe_done':
      job.tk = { ...(job.tk || {}), stage: 'transcribed',
                 chars: evt.chars, cost_usd: evt.cost_usd }
      job.cost_usd = (job.cost_usd || 0) + (evt.cost_usd || 0)
      break
    case 'saved':
      job.file_path = evt.file_path
      job.tk = { ...(job.tk || {}), file_path: evt.file_path, kind: evt.kind, chars: evt.chars }
      scheduleAutoCopy(job, evt.file_path, result => {
        job.tk.copied_bytes = result.bytes
      })
      break
    case 'done':
      // status flip happens on close
      break
    case 'error':
      job.error = evt.message
      break
  }
}

function startTiktokBatchTranscribe(params) {
  const id = nextId++
  if (!Array.isArray(params.video_ids) || params.video_ids.length === 0) {
    throw new Error('video_ids must be a non-empty array')
  }

  const args = [
    TK_BATCH_SCRIPT,
    '--videos', params.video_ids.join(','),
    '--out-dir', TK_TRANSCRIPTS_DIR,
    '--engine', params.engine || 'gemini',
  ]
  if (params.handle) args.push('--handle', params.handle)

  console.log(`[Jobs] start tk_batch_transcribe #${id} count=${params.video_ids.length} engine=${params.engine || 'gemini'}`)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const job = {
    id,
    type: 'tk_batch_transcribe',
    target: params.source_id ? `source:${params.source_id}` : `batch:${params.video_ids.length}`,
    status: 'running',
    items_done: 0,
    items_total: params.video_ids.length,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params },
    tk_batch: { saved: 0, skipped: 0, errors: 0, cost_usd: 0, current: null, log: [] },
    child,
  }
  jobs.set(id, job)
  emit(job)

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleTiktokBatchEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    void (async () => {
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      job.status = code === 0 ? 'done' : 'error'
      if (code !== 0) job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
    }
    job.finished_at = Math.floor(Date.now() / 1000)

    const terminalStatus = job.status
    job.phase = 'finalizing'
    job.status = terminalStatus === 'cancelled' ? 'cancelling' : 'running'
    emit(job)
    await waitForJobPersistence(job)
    let finalizedInWorker = false
    try {
      await finalizeBatchJob({
        job: {
          type: 'tk_batch_transcribe',
          source_id: params.source_id || null,
          status: terminalStatus,
          items_total: params.video_ids.length,
          items_done: job.tk_batch.saved,
          items_failed: job.tk_batch.errors,
          cost_usd: job.tk_batch.cost_usd,
          params: job.params,
          error: job.error,
          started_at: job.started_at,
          finished_at: job.finished_at,
        },
        coverage: params.source_id && job.tk_batch.saved > 0 ? {
          source_id: params.source_id,
          content_type: 'video', depth: 'transcribed', items_count: job.tk_batch.saved,
        } : null,
      })
      finalizedInWorker = true
    } catch (error) {
      console.error('[Jobs] tk_batch finalizer worker failed; falling back to main', error)
    }
    job.status = terminalStatus

    try {
      if (!finalizedInWorker) db.recordJob({
        type:        'tk_batch_transcribe',
        source_id:   params.source_id || null,
        status:      job.status,
        items_total: params.video_ids.length,
        items_done:  job.tk_batch.saved,
        items_failed:job.tk_batch.errors,
        cost_usd:    job.tk_batch.cost_usd,
        params:      job.params,
        error:       job.error,
        started_at:  job.started_at,
        finished_at: job.finished_at,
      })
      if (!finalizedInWorker && params.source_id && job.tk_batch.saved > 0) {
        db.recordCoverage({
          source_id:    params.source_id,
          job_id:       null,
          date_from:    null,
          date_to:      null,
          content_type: 'video',
          depth:        'transcribed',
          items_count:  job.tk_batch.saved,
        })
      }
    } catch (err) {
      console.error('[Jobs] tk_batch_transcribe DB write failed', err)
    }

    const dur = job.finished_at - job.started_at
    job.phase = 'terminal'
    console.log(`[Jobs] end #${id} status=${job.status} saved=${job.tk_batch.saved} errors=${job.tk_batch.errors} cost=$${job.tk_batch.cost_usd.toFixed(4)} duration=${dur}s`)
    emit(job)
    markJobClosed(job)
    })().catch(error => {
      job.status = 'error'
      job.phase = 'terminal'
      job.error = String(error?.message || error)
      job.finished_at = Math.floor(Date.now() / 1000)
      console.error(`[Jobs] tk_batch_transcribe #${id} close failed`, error)
      emit(job)
      markJobClosed(job)
    })
  })

  return id
}

function handleTiktokBatchEvent(job, evt) {
  emitEvent(job, evt)
  const b = job.tk_batch
  switch (evt.type) {
    case 'item_start':
      b.current = { i: evt.i, n: evt.n, video_id: evt.video_id, title: evt.title,
                    duration_sec: evt.duration_sec, channel: evt.channel, stage: 'downloading' }
      job.items_done = evt.i - 1
      emit(job)
      break
    case 'transcribe_start':
      if (b.current) { b.current.stage = 'transcribing'; b.current.engine = evt.engine }
      break
    case 'transcribe_done':
      b.cost_usd += evt.cost_usd || 0
      break
    case 'saved':
      b.saved += 1
      job.items_done = (b.saved + b.skipped + b.errors)
      if (job.params?.source_id) {
        const args = {
          source_id: job.params.source_id,
          external_id: evt.video_id,
          transcript_path: evt.file_path,
          engine: job.params.engine || 'gemini',
          cost_usd: evt.cost_usd || null,
        }
        queueJobPersistence(
          job,
          `tk_batch #${job.id} mark transcript`,
          () => persistItemMutation({ method: 'markItemTranscribed', args }),
          () => db.markItemTranscribed(args),
        )
      }
      b.log.push({ video_id: evt.video_id, kind: evt.kind, file_path: evt.file_path })
      emit(job)
      break
    case 'item_error':
      b.errors += 1
      job.items_done = (b.saved + b.skipped + b.errors)
      b.log.push({ video_id: evt.video_id, kind: 'error', message: evt.message })
      emit(job)
      break
    case 'done':
      break
    case 'error':
      job.error = evt.message
      break
  }
}

// ─── Instagram profile fetch ──────────────────────────────────────────
//
// Apify or Android backend, switched via params.backend (UI reads
// settings.json::instagram.backend). Apify is the default. Result:
//   - source upserted on `entity` event (platform=instagram, handle=<username>)
//   - items bulk-upserted on close (idempotent UPSERT)
//   - source_coverage row written for each (type, depth=metadata) slice
//   - jobs row recorded so SourceDetail's history includes the run.

const IG_PROFILE_SCRIPT = path.join(WORKERS_ROOT, 'instagram', 'ig_profile_ndjson.py')

function startInstagramProfileFetch(params) {
  const id = nextId++
  const backend = params.backend || 'apify'
  const mode    = params.mode    || 'reels'
  const limit   = params.limit   != null ? params.limit : 50
  const target  = params.target

  const args = [
    IG_PROFILE_SCRIPT,
    target,
    '--backend', backend,
    '--mode',    mode,
    '--limit',   String(limit),
  ]

  console.log(`[Jobs] start ig_profile_fetch #${id} target=${target} backend=${backend} mode=${mode} limit=${limit}`)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const job = {
    id,
    type: 'ig_profile_fetch',
    target,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params },
    items: [],
    type_breakdown: {},
    child,
  }
  jobs.set(id, job)
  emit(job)

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleInstagramEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    void (async () => {
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      job.status = code === 0 ? 'done' : 'error'
      if (code !== 0) job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
    }
    job.finished_at = Math.floor(Date.now() / 1000)
    const dur = job.finished_at - job.started_at

    const terminalStatus = job.status
    const approxCost = terminalStatus === 'done' && job.params?.backend === 'apify' ? 0.0026 : 0
    job.cost_usd = approxCost
    let finalizedInWorker = false
    if (job.source_id && job.items.length) {
      job.phase = 'finalizing'
      job.status = terminalStatus === 'cancelled' ? 'cancelling' : 'running'
      emit(job)
      try {
        const result = await finalizeCatalogJob({
          kind: 'instagram-profile',
          source_id: job.source_id,
          items: job.items,
          status: terminalStatus,
          job_type: job.type,
          items_done: job.items_done,
          type_breakdown: job.type_breakdown,
          params: job.params,
          error: job.error,
          cost_usd: approxCost,
          date_from: job.date_min,
          date_to: job.date_max,
          started_at: job.started_at,
          finished_at: job.finished_at,
        })
        finalizedInWorker = true
        console.log(`[CatalogFinalizer] Instagram source #${job.source_id} rows=${result.rows || 0}`)
      } catch (error) {
        console.error('[CatalogFinalizer] Instagram worker failed; falling back to main', error)
      }
      job.status = terminalStatus
    }

    // Persist items into SQLite. external_id already prefixed (reel:/post:)
    // by the Python side, so reels and posts can co-exist for the same source.
    try {
      if (!finalizedInWorker && job.source_id && job.items.length) {
        const rows = job.items.map(it => ({
          source_id:        job.source_id,
          external_id:      String(it.external_id),
          type:             it.type || 'other',
          url:              it.url || null,
          title:            it.title || null,
          caption:          it.caption || null,
          published_at:     it.date ? Math.floor(new Date(it.date).getTime() / 1000) : null,
          duration_seconds: it.duration_sec || null,
          views:            it.views || null,
          likes:            it.likes || null,
          comments:         it.comments || null,
          sender:           null,
          has_media:        !!it.has_media,
          raw_meta:         null,
        }))
        db.bulkUpsertItems(rows)
        console.log(`[Jobs] DB upserted ${rows.length} ig items into source #${job.source_id}`)
      }
    } catch (err) {
      console.error('[Jobs] ig DB write failed', err)
    }

    // Coverage rows + jobs row.
    try {
      if (!finalizedInWorker && job.source_id && job.status === 'done' && Object.keys(job.type_breakdown).length) {
        // Approximate cost — we don't have per-item cost for profile-
        // fetch, but Apify charges ~$0.0026 per actor run. So at least
        // the user sees «бесплатно» on android-api and «$0.0026» on apify
        // in JobDetail.
        const jobIdInDb = db.recordJob({
          type: job.type, source_id: job.source_id, status: job.status,
          items_total: job.items_done, items_done: job.items_done,
          cost_usd: approxCost,
          params: job.params, error: job.error,
          started_at: job.started_at, finished_at: job.finished_at,
        })
        for (const [contentType, count] of Object.entries(job.type_breakdown)) {
          db.recordCoverage({
            source_id:    job.source_id,
            job_id:       jobIdInDb,
            date_from:    job.date_min,
            date_to:      job.date_max,
            content_type: contentType,
            depth:        'metadata',
            items_count:  count,
          })
        }
      }
    } catch (err) {
      console.error('[Jobs] ig coverage write failed', err)
    }

    delete job.items
    job.phase = 'terminal'
    console.log(`[Jobs] end #${id} status=${job.status} items=${job.items_done} duration=${dur}s${job.error ? ' error=' + job.error : ''}`)
    emit(job)
    markJobClosed(job)
    })().catch(error => {
      job.status = 'error'
      job.phase = 'terminal'
      job.error = String(error?.message || error)
      job.finished_at = Math.floor(Date.now() / 1000)
      delete job.items
      console.error(`[Jobs] ig_profile_fetch #${id} close failed`, error)
      emit(job)
      markJobClosed(job)
    })
  })

  return id
}

function handleInstagramEvent(job, evt) {
  emitEvent(job, evt)
  switch (evt.type) {
    case 'entity':
      job.entity_title = evt.title || evt.username
      job.entity_kind  = evt.kind
      try {
        job.source_id = db.upsertSource({
          platform: 'instagram',
          handle:   evt.username || job.target,
          display_name: evt.title || evt.username || job.target,
          external_id:  evt.id != null ? String(evt.id) : null,
          meta: { kind: evt.kind, username: evt.username },
          mark_synced: true,
          is_explicit: true,         // ig profile fetch = осознанный
        })
      } catch (err) {
        console.error('[Jobs] ig upsertSource failed', err)
      }
      emit(job)
      break
    case 'item': {
      const data = evt.data || {}
      job.items_done = (job.items_done || 0) + 1
      job.items.push(data)
      const t = data.type || 'other'
      job.type_breakdown[t] = (job.type_breakdown[t] || 0) + 1
      const ts = data.date ? Math.floor(new Date(data.date).getTime() / 1000) : null
      if (ts) {
        if (!job.date_min || ts < job.date_min) job.date_min = ts
        if (!job.date_max || ts > job.date_max) job.date_max = ts
      }
      break
    }
    case 'page':
      job.items_done = evt.loaded
      job.items_total = evt.limit || null
      emit(job)
      break
    case 'done':
      job.items_total = evt.items_total
      job.items_done  = evt.items_total
      // status set on close
      break
    case 'error':
      job.error = evt.message
      break
  }
}

// ─── Instagram batch transcribe (reels) ───────────────────────────────
//
// Same per-item event shape as yt_batch_transcribe_ndjson.py — the
// Python emits {item_start, transcribe_start, transcribe_done, saved,
// item_error, done}. We reuse `yt_batch` job state and a near-identical
// handler so ActivityPanel / JobDetail render the progress without a
// second display path. Differences from the YouTube batch:
//   - external_id is `reel:<shortcode>` (Python emits the bare shortcode
//     in evt.video_id; we re-add the prefix before calling markItem-).
//   - cost is per-reel (no subs free path — every reel pays for AI).
//   - transcripts go to LIB_ROOT/transcripts/instagram/

const IG_BATCH_SCRIPT = path.join(WORKERS_ROOT, 'instagram', 'ig_batch_transcribe_ndjson.py')

function startInstagramBatchTranscribe(params) {
  const id = nextId++
  if (!Array.isArray(params.shortcodes) || params.shortcodes.length === 0) {
    throw new Error('shortcodes must be a non-empty array')
  }

  const captions = Array.isArray(params.captions) ? params.captions : []
  // Pipe-triple separator: matches Python parse_captions split by '|||'.
  const captionsArg = captions.join('|||')

  const backend = params.backend || 'api'
  const args = [
    IG_BATCH_SCRIPT,
    '--shortcodes', params.shortcodes.join(','),
    '--out-dir',    IG_TRANSCRIPTS_DIR,
    '--backend',    backend,
    '--engine',     params.engine || 'gemini',
  ]
  if (captionsArg) {
    args.push('--captions', captionsArg)
  }
  if (backend === 'api' && params.user_id) {
    args.push('--user-id', String(params.user_id))
  }

  const apiResolution = backend === 'api'
    ? (params.api_resolution || (params.user_id ? 'profile_clips' : 'shortcode_session'))
    : 'apify'
  console.log(`[Jobs] start ig_batch_transcribe #${id} count=${params.shortcodes.length} backend=${backend} resolve=${apiResolution} engine=${params.engine || 'gemini'}`)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const job = {
    id,
    type: 'ig_batch_transcribe',
    target: params.target || (params.source_id ? `source:${params.source_id}` : `batch:${params.shortcodes.length}`),
    status: 'running',
    items_done: 0,
    items_total: params.shortcodes.length,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params },
    yt_batch: { saved: 0, skipped: 0, errors: 0, cost_usd: 0, current: null, log: [] },
    source_id: params.source_id || null,
    child,
  }
  jobs.set(id, job)
  emit(job)

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleInstagramBatchEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    void (async () => {
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      const allFailed = job.yt_batch.saved === 0 && (job.yt_batch.errors > 0 || !!job.error)
      job.status = code === 0 && !allFailed ? 'done' : 'error'
      if (code !== 0) job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
    }
    job.finished_at = Math.floor(Date.now() / 1000)
    if (job.error_code) job.params._error_code = job.error_code

    const terminalStatus = job.status
    job.phase = 'finalizing'
    job.status = terminalStatus === 'cancelled' ? 'cancelling' : 'running'
    emit(job)
    await waitForJobPersistence(job)
    const saved = (job.yt_batch.log || []).filter(entry => entry.kind === 'ai' && entry.file_path)
    const date = new Date((job.started_at || Math.floor(Date.now() / 1000)) * 1000).toISOString().slice(0, 10)
    const combinedPath = saved.length ? path.join(JOBS_DIR, `${date}_ig_batch_${id}_combined.txt`) : null
    let finalizedInWorker = false
    try {
      const result = await finalizeBatchJob({
        job: {
          type: 'ig_batch_transcribe',
          source_id: params.source_id || null,
          status: terminalStatus,
          items_total: params.shortcodes.length,
          items_done: job.yt_batch.saved,
          items_failed: job.yt_batch.errors,
          cost_usd: job.yt_batch.cost_usd,
          params: job.params,
          error: job.error,
          started_at: job.started_at,
          finished_at: job.finished_at,
        },
        coverage: params.source_id && job.yt_batch.saved > 0 ? {
          source_id: params.source_id,
          content_type: 'video', depth: 'transcribed', items_count: job.yt_batch.saved,
        } : null,
        combine_paths: saved.map(entry => entry.file_path),
        combine_output_path: combinedPath,
      })
      job.file_path = result.file_path || null
      finalizedInWorker = true
    } catch (error) {
      console.error('[Jobs] ig_batch finalizer worker failed; falling back to main', error)
    }
    job.status = terminalStatus

    // Combined transcript sidecar — automatic for Instagram because every
    // saved reel is a paid AI transcript (no free subs path), so a job-
    // level artefact is what the user comes back to. Writes to JOBS_DIR
    // alongside the rest of the job sidecars.
    try {
      if (!finalizedInWorker && saved.length > 0) {
        const SEP = '\n\n' + '='.repeat(72) + '\n\n'
        const chunks = []
        for (const e of saved) {
          try { chunks.push(fs.readFileSync(e.file_path, 'utf8')) } catch {}
        }
        const fname = `${date}_ig_batch_${id}_combined.txt`
        const fpath = path.join(JOBS_DIR, fname)
        fs.writeFileSync(fpath, chunks.join(SEP), 'utf8')
        job.file_path = fpath
        console.log(`[Jobs] saved combined ig batch transcript → ${fpath}`)
      }
    } catch (err) {
      console.error('[Jobs] ig combined save failed', err)
    }

    try {
      if (!finalizedInWorker) db.recordJob({
        type:        'ig_batch_transcribe',
        source_id:   params.source_id || null,
        status:      job.status,
        items_total: params.shortcodes.length,
        items_done:  job.yt_batch.saved,
        items_failed:job.yt_batch.errors,
        cost_usd:    job.yt_batch.cost_usd,
        params:      job.params,
        error:       job.error,
        started_at:  job.started_at,
        finished_at: job.finished_at,
        file_path:   job.file_path || null,
      })
      if (!finalizedInWorker && params.source_id && job.yt_batch.saved > 0) {
        db.recordCoverage({
          source_id:    params.source_id,
          job_id:       null,
          date_from:    null,
          date_to:      null,
          content_type: 'video',
          depth:        'transcribed',
          items_count:  job.yt_batch.saved,
        })
      }
    } catch (err) {
      console.error('[Jobs] ig_batch_transcribe DB write failed', err)
    }

    const dur = job.finished_at - job.started_at
    job.phase = 'terminal'
    console.log(`[Jobs] end #${id} status=${job.status} saved=${job.yt_batch.saved} errors=${job.yt_batch.errors} cost=$${job.yt_batch.cost_usd.toFixed(4)} duration=${dur}s`)
    emit(job)
    markJobClosed(job)
    })().catch(error => {
      job.status = 'error'
      job.phase = 'terminal'
      job.error = String(error?.message || error)
      job.finished_at = Math.floor(Date.now() / 1000)
      console.error(`[Jobs] ig_batch_transcribe #${id} close failed`, error)
      emit(job)
      markJobClosed(job)
    })
  })

  return id
}

function handleInstagramBatchEvent(job, evt) {
  emitEvent(job, evt)
  const b = job.yt_batch
  switch (evt.type) {
    case 'item_start':
      b.current = { i: evt.i, n: evt.n, video_id: evt.video_id, title: evt.title,
                    duration_sec: evt.duration_sec, channel: evt.channel, stage: 'fetching' }
      job.items_done = evt.i - 1
      emit(job)
      break
    case 'resolve_start':
      if (b.current) {
        b.current.stage = 'resolving'
        b.current.backend = evt.backend
        b.current.mode = evt.mode
      }
      console.log(`[Jobs] ig_batch resolve #${job.id} video=${evt.video_id || '-'} backend=${evt.backend || '-'} mode=${evt.mode || '-'}`)
      emit(job)
      break
    case 'resolve_done':
      if (b.current) {
        b.current.stage = 'resolved'
        b.current.backend = evt.backend || b.current.backend
        b.current.mode = evt.mode || b.current.mode
      }
      emit(job)
      break
    case 'download_start':
      if (b.current) b.current.stage = 'downloading'
      emit(job)
      break
    case 'download_done':
      if (b.current) {
        b.current.stage = 'audio_ready'
        b.current.bytes = evt.bytes || null
      }
      emit(job)
      break
    case 'transcribe_start':
      if (b.current) { b.current.stage = 'transcribing'; b.current.engine = evt.engine }
      emit(job)
      break
    case 'transcribe_done':
      b.cost_usd += evt.cost_usd || 0
      if (b.current) {
        b.current.stage = 'saving'
        b.current.engine = evt.engine || b.current.engine
      }
      emit(job)
      break
    case 'save_start':
      if (b.current) b.current.stage = 'saving'
      emit(job)
      break
    case 'saved':
      b.saved += 1
      job.items_done = (b.saved + b.skipped + b.errors)
      if (job.params?.source_id) {
        const args = {
          source_id: job.params.source_id,
          // DB stores items with `reel:<code>`; Python emits bare code.
          external_id: `reel:${evt.video_id}`,
          transcript_path: evt.file_path,
          engine: job.params.engine || 'gemini',
          cost_usd: evt.cost_usd || null,
        }
        queueJobPersistence(
          job,
          `ig_batch #${job.id} mark transcript`,
          () => persistItemMutation({ method: 'markItemTranscribed', args }),
          () => db.markItemTranscribed(args),
        )
      }
      b.log.push({ video_id: evt.video_id, kind: 'ai', file_path: evt.file_path })
      emit(job)
      break
    case 'item_error':
      b.errors += 1
      b.cost_usd += evt.cost_usd || 0
      if (!job.error) {
        job.error = evt.message || 'Instagram item failed'
        job.error_code = evt.code || null
      }
      job.items_done = (b.saved + b.skipped + b.errors)
      b.log.push({
        video_id: evt.video_id,
        kind: 'error',
        code: evt.code || null,
        message: evt.message,
        cost_usd: evt.cost_usd || 0,
      })
      console.warn(`[Jobs] ig_batch item_error #${job.id} video=${evt.video_id || '-'} code=${evt.code || '-'} message=${String(evt.message || '-').replace(/\s+/g, ' ').slice(0, 600)}`)
      emit(job)
      break
    case 'done':
      // status set on close
      break
    case 'error':
      job.error = evt.message
      break
  }
}

// ─── Reddit thread + search ───────────────────────────────────────────
//
// Backend: Apify trudax/reddit-scraper-lite. Reddit JSON API blocked at
// anonymous-IP scale since 2024 (HTTP 403); official API is paid. Apify
// keeps a session/proxy pool and works for our $5/mo budget.
//
// Two source-types:
//   - thread (kind='thread') — one URL → post + comment tree (depth, parent_external_id).
//     Source row: handle = post_id, identity = post.title.
//   - search (kind='search') — keyword (+optional subreddit) → list of posts (no comments).
//     Source row: handle = `q-<sha8>`, identity = query string.
// Click on a post inside Search-source spawns a thread fetch for that URL,
// creating a separate Thread-source.

const RD_THREAD_SCRIPT = path.join(WORKERS_ROOT, 'reddit', 'rd_thread_ndjson.py')
const RD_SEARCH_SCRIPT = path.join(WORKERS_ROOT, 'reddit', 'rd_search_ndjson.py')

function _startRedditCommon(scriptPath, args, jobType, target, params) {
  const id = nextId++
  console.log(`[Jobs] start ${jobType} #${id} target=${target}`)
  const child = spawn(WORKER_PYTHON, [scriptPath, ...args], {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const job = {
    id,
    type: jobType,
    target,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params },
    items: [],
    type_breakdown: {},
    child,
  }
  jobs.set(id, job)
  emit(job)

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleRedditEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    void (async () => {
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      job.status = code === 0 ? 'done' : 'error'
      if (code !== 0) job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
    }
    job.finished_at = Math.floor(Date.now() / 1000)
    const dur = job.finished_at - job.started_at

    const terminalStatus = job.status
    let finalizedInWorker = false
    if (job.source_id && job.items.length) {
      job.phase = 'finalizing'
      job.status = terminalStatus === 'cancelled' ? 'cancelling' : 'running'
      emit(job)
      try {
        const result = await finalizeCatalogJob({
          kind: 'reddit',
          source_id: job.source_id,
          items: job.items,
          status: terminalStatus,
          job_type: job.type,
          items_done: job.items_done,
          type_breakdown: job.type_breakdown,
          params: job.params,
          error: job.error,
          cost_usd: job.cost_usd || 0,
          date_from: job.date_min,
          date_to: job.date_max,
          started_at: job.started_at,
          finished_at: job.finished_at,
        })
        finalizedInWorker = true
        console.log(`[CatalogFinalizer] Reddit source #${job.source_id} rows=${result.rows || 0}`)
      } catch (error) {
        console.error('[CatalogFinalizer] Reddit worker failed; falling back to main', error)
      }
      job.status = terminalStatus
    }

    try {
      if (!finalizedInWorker && job.source_id && job.items.length) {
        const rows = job.items.map(it => ({
          source_id:        job.source_id,
          external_id:      String(it.external_id),
          type:             it.type || 'text',
          url:              it.url || null,
          title:            it.title || null,
          caption:          it.caption || null,
          published_at:     it.date ? Math.floor(new Date(it.date).getTime() / 1000) : null,
          duration_seconds: null,
          views:            null,
          likes:            it.likes || null,
          comments:         it.comments || null,
          sender:           it.sender || null,
          has_media:        !!it.has_media,
          raw_meta:         it.raw_meta || null,
          parent_external_id: it.parent_external_id || null,
          depth:            it.depth != null ? it.depth : null,
        }))
        db.bulkUpsertItems(rows)
        console.log(`[Jobs] DB upserted ${rows.length} reddit items into source #${job.source_id}`)
      }
    } catch (err) {
      console.error('[Jobs] reddit DB write failed', err)
    }

    try {
      if (!finalizedInWorker && job.source_id && job.status === 'done' && Object.keys(job.type_breakdown).length) {
        const cost = job.cost_usd != null ? job.cost_usd : 0
        const jobIdInDb = db.recordJob({
          type: job.type, source_id: job.source_id, status: job.status,
          items_total: job.items_done, items_done: job.items_done,
          cost_usd: cost,
          params: job.params, error: job.error,
          started_at: job.started_at, finished_at: job.finished_at,
        })
        for (const [contentType, count] of Object.entries(job.type_breakdown)) {
          db.recordCoverage({
            source_id:    job.source_id,
            job_id:       jobIdInDb,
            date_from:    job.date_min,
            date_to:      job.date_max,
            content_type: contentType,
            depth:        'metadata',
            items_count:  count,
          })
        }
      }
    } catch (err) {
      console.error('[Jobs] reddit coverage write failed', err)
    }

    delete job.items
    job.phase = 'terminal'
    console.log(`[Jobs] end #${id} status=${job.status} items=${job.items_done} duration=${dur}s${job.error ? ' error=' + job.error : ''}`)
    emit(job)
    markJobClosed(job)
    })().catch(error => {
      job.status = 'error'
      job.phase = 'terminal'
      job.error = String(error?.message || error)
      job.finished_at = Math.floor(Date.now() / 1000)
      delete job.items
      console.error(`[Jobs] ${job.type} #${id} close failed`, error)
      emit(job)
      markJobClosed(job)
    })
  })

  return id
}

function startRedditThreadFetch(params) {
  const url = params.url
  if (!url) throw new Error('url required')
  const args = [url]
  if (params.maxComments) args.push('--max-comments', String(params.maxComments))
  if (params.backend)     args.push('--backend', params.backend)
  return _startRedditCommon(RD_THREAD_SCRIPT, args, 'rd_thread_fetch', url, params)
}

function startRedditSearch(params) {
  const query = params.query
  if (!query) throw new Error('query required')
  const args = [query]
  if (params.subreddit) args.push('--subreddit', params.subreddit)
  if (params.limit)     args.push('--limit', String(params.limit))
  if (params.sort)      args.push('--sort', params.sort)
  if (params.time)      args.push('--time', params.time)
  if (params.backend)   args.push('--backend', params.backend)
  return _startRedditCommon(RD_SEARCH_SCRIPT, args, 'rd_search', query, params)
}

function handleRedditEvent(job, evt) {
  emitEvent(job, evt)
  switch (evt.type) {
    case 'entity':
      job.entity_title = evt.title
      job.entity_kind  = evt.kind
      try {
        // For thread: handle = post_id; for search: handle = q-<sha8> (already in evt.id).
        const handle = evt.kind === 'thread'
          ? `t-${evt.id}`               // unique per thread
          : evt.id                      // already 'q-<sha8>' from search script
        const meta = {
          kind:      evt.kind,
          subreddit: evt.subreddit || null,
          author:    evt.author || null,
          query:     evt.query || null,
          url:       evt.url || null,
        }
        job.source_id = db.upsertSource({
          platform: 'reddit',
          handle,
          display_name: evt.title || handle,
          external_id:  evt.id != null ? String(evt.id) : null,
          meta,
          mark_synced: true,
          is_explicit: true,        // reddit thread/search = осознанный
        })
      } catch (err) {
        console.error('[Jobs] reddit upsertSource failed', err)
      }
      emit(job)
      break
    case 'item': {
      const data = evt.data || {}
      job.items_done = (job.items_done || 0) + 1
      job.items.push(data)
      const t = data.type || 'text'
      job.type_breakdown[t] = (job.type_breakdown[t] || 0) + 1
      const ts = data.date ? Math.floor(new Date(data.date).getTime() / 1000) : null
      if (ts) {
        if (!job.date_min || ts < job.date_min) job.date_min = ts
        if (!job.date_max || ts > job.date_max) job.date_max = ts
      }
      break
    }
    case 'page':
      job.items_done  = evt.loaded
      job.items_total = evt.limit || null
      emit(job)
      break
    case 'done':
      job.items_total = evt.items_total
      job.items_done  = evt.items_total
      if (evt.cost_usd != null) job.cost_usd = evt.cost_usd
      break
    case 'error':
      job.error = evt.message
      break
  }
}

// ─── Telegram session manager (one-shot ndjson runs) ──────────────────
//
// All three modes go through the same script. The runner spawns it,
// collects per-line events into an array, and resolves with the array on
// `close`. The UI decides which event types it cares about.

const TG_SESSIONS_SCRIPT = path.join(WORKERS_ROOT, 'telegram', 'tg_sessions_ndjson.py')
const TG_SEND_SAVED_SCRIPT = path.join(WORKERS_ROOT, 'telegram', 'tg_send_saved_ndjson.py')
const TG_SEND_TEXT_SCRIPT = path.join(WORKERS_ROOT, 'telegram', 'tg_send_text_ndjson.py')
const IG_SESSIONS_SCRIPT = path.join(WORKERS_ROOT, 'instagram', 'ig_sessions_ndjson.py')
const IG_LOGIN_SCRIPT = path.join(WORKERS_ROOT, 'instagram', 'ig_login_ndjson.py')

function runOneShotNdjson(scriptPath, argv, { onEvent, onSpawn, extraEnv, input, timeoutMs = null, timeoutCode = 'worker_deadline' } = {}) {
  return new Promise((resolve, reject) => {
    const env = workerEnv()
    if (extraEnv && typeof extraEnv === 'object') Object.assign(env, extraEnv)
    const child = spawn(WORKER_PYTHON, [scriptPath, ...argv], {
      cwd: WORKERS_ROOT,
      env,
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    onSpawn?.(child)
    // Drop secrets from our mutable copy once spawn has cloned the env.
    if (extraEnv) {
      for (const key of Object.keys(extraEnv)) delete env[key]
    }
    if (input != null) {
      child.stdin.on('error', () => {}) // close/result determines outcome, never resend
      child.stdin.end(input)
    }
    const events = []
    const deadline = require('./ndjson-worker-deadline').ndjsonWorkerDeadline(child, {
      timeoutMs, onTimeout: () => events.push({ type: 'error', code: timeoutCode,
        message: 'Worker deadline: исход неизвестен, отсутствие аккаунта не доказано.' }),
    })
    let stderrTail = ''
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', line => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line)
        events.push(event)
        onEvent?.(event)
      } catch {}
    })
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-2000) })
    child.on('close', code => {
      deadline.clear()
      if (deadline.expired()) { resolve(events.filter(event => event.type !== 'done')); return }
      if (code !== 0 && events.length === 0) {
        reject(new Error(stderrTail.slice(-300) || `python exited ${code}`))
      } else {
        resolve(events)
      }
    })
    child.on('error', reject)
  })
}

function runTgSessionsCommand(argv) {
  return runOneShotNdjson(TG_SESSIONS_SCRIPT, argv, argv[0] === 'list'
    ? { timeoutMs: 30000, timeoutCode: 'session_inventory_timeout' } : {})
}

async function runTelegramAsrCheckpointCommand(request, params) {
  const session = params._tg_session_override || params.session
  if (!session || !Number.isSafeInteger(params.expected_peer_id) || !Number.isSafeInteger(params.expected_account_id)) {
    throw Object.assign(new Error('ASR recovery requires the original explicit session/account/peer'), { code: 'ASR_RECOVERY_SCOPE_REQUIRED' })
  }
  const namespace = crypto.createHash('sha256').update(session).digest('hex').slice(0,32)
  const id = nextId++, now = Math.floor(Date.now()/1000)
  const job = { id, type:'tg_live_asr_recovery', target:request.original_request_id,
    source_id:params.source_id_hint || params._source_id || null, tg_session:session,
    status:'running', items_done:0, items_total:request.message_ids.length, started_at:now,
    params:{ operation:request.action || 'inspect', original_request_id:request.original_request_id,
      expected_account_id:params.expected_account_id, expected_peer_id:params.expected_peer_id } }
  job.dbRowId = db.recordJob({type:job.type,source_id:job.source_id,status:'running',started_at:now,params:job.params})
  jobs.set(id,job);emit(job)
  try {
    const events = await runOneShotNdjson(path.join(WORKERS_ROOT,'telegram','tg_asr_recovery_ndjson.py'),[],{
      input:JSON.stringify({...request,state_dir:path.join(JOBS_DIR,'telegram-asr-state',namespace),expected_peer_id:params.expected_peer_id}),
      timeoutMs:60000,timeoutCode:'asr_checkpoint_deadline',onSpawn:child=>{job.child=child},
    })
    const error = events.find(e=>e.type==='error')
    const result = events.find(e=>e.type==='result')?.result
    if(job._cancelRequested)throw Object.assign(new Error('ASR checkpoint operation was cancelled; inspect before any recovery'),{code:'ASR_RECOVERY_CANCELLED'})
    if (error || !result) throw Object.assign(new Error(error?.message || 'ASR checkpoint result unavailable'),{code:error?.code || 'ASR_RECOVERY_UNKNOWN'})
    job.status = 'done';job.items_done=request.message_ids.length;job.params.result=result
    return {...result,desktop_job_id:id,db_job_id:job.dbRowId}
  } catch(error) {
    job.status=job._cancelRequested?'cancelled':'error';job.error=error.message;job.error_code=error.code
    throw error
  } finally {
    job.child=null;job.finished_at=Math.floor(Date.now()/1000)
    db.updateJob(job.dbRowId,{status:job.status,items_done:job.items_done,items_total:job.items_total,finished_at:job.finished_at,error:job.error||null,params:job.params})
    emit(job)
  }
}

async function runTelegramTextCommand(request) {
  // Same owned one-shot worker contour as Saved Messages. Bodies travel only
  // through stdin, never process argv, logs, library items or job history.
  console.log(`[Jobs] tg_text operation=${request.operation} request_id=${request.request_id || '-'}`)
  try {
    const events = await runOneShotNdjson(TG_SEND_TEXT_SCRIPT, [], { input: JSON.stringify(request) })
    const result = events.find(event => event.type === 'result')?.result
    if (result) return result
  } catch {
    // An exit/error is not proof the external effect did not happen. The
    // durable worker receipt, not stderr text, decides a later reconciliation.
  }
  return {
    ok: false, delivered: false, state: 'unknown', code: 'worker_result_missing',
    request_id: request.request_id || null,
    error: 'No receipt returned. Use telegram_send_text_status with the original request_id; never resend under a new key.',
  }
}

async function sendTelegramSavedMessage({ text = '', images = [], files = [], album = null, session = null, silent = false } = {}) {
  const message = String(text == null ? '' : text)
  const argv = ['--text', message]
  for (const image of images || []) argv.push('--image', String(image))
  for (const file of files || []) argv.push('--file', String(file))
  if (album) argv.push('--album-json', JSON.stringify(album))
  if (session) argv.push('--session', String(session))
  if (silent) argv.push('--silent')

  console.log(`[Jobs] tg_send_saved session=${session || activeTgSession() || '-'} chars=${message.length} images=${(images || []).length} files=${(files || []).length} album=${album?.mode || '-'} album_files=${album?.paths?.length || 0}`)
  const events = await runOneShotNdjson(TG_SEND_SAVED_SCRIPT, argv)
  const sent = events.filter(e => e.type === 'sent')
  const done = events.find(e => e.type === 'done') || null
  const errors = events.filter(e => e.type === 'error')
  if (!done && !errors.length) {
    errors.push({ code: 'delivery_unknown', message: 'Worker stopped without a delivery receipt. Inspect Saved Messages before retrying.' })
  }
  return {
    ok: !!done && errors.length === 0,
    target: 'saved_messages',
    session: done?.session || sent[0]?.session || session || null,
    sent,
    albums: events.filter(e => e.type === 'album_verified'),
    preflight: events.find(e => e.type === 'preflight') || null,
    done,
    errors,
  }
}

function runIgSessionsCommand(argv) {
  return runOneShotNdjson(IG_SESSIONS_SCRIPT, argv)
}

let igLoginPromise = null
function runIgLogin() {
  if (igLoginPromise) return igLoginPromise
  console.log('[InstagramLogin] start')
  igLoginPromise = runOneShotNdjson(IG_LOGIN_SCRIPT, [], {
    onEvent: event => {
      const detail = String(event.message || event.code || '').replace(/\s+/g, ' ').slice(0, 240)
      console.log(`[InstagramLogin] stage=${event.type || '-'}${detail ? ` detail=${detail}` : ''}`)
    },
  }).then(events => {
    const error = events.find(event => event.type === 'error')
    const done = events.some(event => event.type === 'done')
    console.log(`[InstagramLogin] end status=${done && !error ? 'done' : 'error'} events=${events.length}`)
    return events
  }).finally(() => {
    igLoginPromise = null
  })
  return igLoginPromise
}

// ─── YouTube search (sourceless) ──────────────────────────────────────
//
// One-shot fetch — yt-dlp ytsearchN:query is fast (1-3s for 30 results),
// no streaming UI is needed. Returns an items array. Pagination is handled
// renderer-side: caller spawns again with offset, dedupes by video_id.
const YT_SEARCH_SCRIPT = path.join(WORKERS_ROOT, 'web', 'yt_search_ndjson.py')

// Resume an interrupted yt_batch_transcribe row: pull params, filter out
// videos that already have transcripts on disk, kick off a fresh batch.
// Returns { ok, jobId } or { ok: false, error }.
async function resumeYoutubeBatch(rowId) {
  try {
    const row = db.getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(rowId)
    if (!row) return { ok: false, error: 'job not found' }
    if (row.type !== 'yt_batch_transcribe') return { ok: false, error: 'wrong job type' }
    let params = {}
    try { params = JSON.parse(row.parameters_json || '{}') } catch {}
    const allIds = Array.isArray(params.video_ids) ? params.video_ids : []
    if (!allIds.length) return { ok: false, error: 'no video_ids' }

    // Remaining = those without a saved transcript file.
    // For search-batches the truth is in params.video_files (set on close).
    // For interrupted runs we don't have that map yet, so we trust filesystem
    // via the search_videos title list — videos saved before the interrupt
    // have their .txt under YT_TRANSCRIPTS_DIR matching <video_id>__*.txt.
    let remaining
    try {
      remaining = await dbRead.request(
        'youtubeResumeRemaining', allIds, params.video_files || {}, YT_TRANSCRIPTS_DIR,
      )
    } catch (workerError) {
      console.error('[Jobs] YouTube resume scan worker failed; falling back to main', workerError)
      let dirEntries = []
      try { dirEntries = fs.readdirSync(YT_TRANSCRIPTS_DIR, { withFileTypes: true }) } catch {}
      const cachedIds = new Set(dirEntries
        .filter(entry => entry.isFile() && entry.name.endsWith('.txt'))
        .map(entry => entry.name.split('__', 1)[0]))
      remaining = allIds.filter(videoId => {
        const explicit = (params.video_files || {})[videoId]
        if (explicit && fs.existsSync(explicit)) return false
        return !cachedIds.has(String(videoId))
      })
    }
    if (!remaining.length) {
      // All done already — flip the row to done so the UI stops nagging.
      db.updateJob(rowId, { status: 'done' })
      return { ok: false, error: 'all videos already transcribed', already_done: true }
    }

    // Fresh batch with reduced video_ids; preserve search context if any.
    const id = await startYoutubeBatchTranscribe({
      ...params,
      video_ids: remaining,
      // search_videos / search_query / is_search are forwarded as-is
    })
    return { ok: true, jobId: id, remaining: remaining.length, total: allIds.length }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

async function runYoutubeSearch({ query, limit = 20, offset = 0 }) {
  if (!query || !String(query).trim()) {
    throw new Error('query required')
  }
  const argv = [
    '--query', String(query),
    '--limit', String(limit),
    '--offset', String(offset),
  ]
  console.log(`[Jobs] yt_search query="${String(query).slice(0, 60)}" limit=${limit} offset=${offset}`)
  const events = await runOneShotNdjson(YT_SEARCH_SCRIPT, argv)
  const items = []
  let entity = null
  let errMsg = null
  for (const e of events) {
    if (e.type === 'entity') entity = e
    else if (e.type === 'item' && e.data) items.push(e.data)
    else if (e.type === 'error') errMsg = e.message
  }
  if (errMsg && items.length === 0) throw new Error(errMsg)
  return { entity, items }
}

// ─── Boosty catalog + post preview ───────────────────────────────────
//
// The first-party JSON API exposes an opaque cursor (`extra.offset`) and a
// truthful `isLast` flag. The Python worker follows that cursor directly;
// there is no browser scrolling and the renderer never receives auth or
// signed player URLs.

const BOOSTY_CATALOG_SCRIPT = path.join(WORKERS_ROOT, 'web', 'boosty_catalog_ndjson.py')

let boostyWorkflow
function getBoostyWorkflow() {
  return boostyWorkflow ||= require('./boosty-workflow').createBoostyWorkflow({
    db, jobs, allocateId: () => nextId++, emit, markJobClosed, spawn, workerEnv,
    python: WORKER_PYTHON, workersRoot: WORKERS_ROOT, libraryRoot: LIB_ROOT,
    authProvider: () => require('./browser-bridge').requestBoostyAuthCookie(), indexJob: require('./index-job'),
  })
}
const BOOSTY_THUMBNAIL_SCRIPT = path.join(WORKERS_ROOT, 'web', 'boosty_thumbnail_cache_ndjson.py')
const boostyThumbnailProcesses = new Map()

function relativeLibraryPath(filePath) {
  if (!filePath) return null
  const absolute = path.resolve(String(filePath))
  const relative = path.relative(LIB_ROOT, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

function boostySelectedVideoId(rawUrl) {
  try {
    const layer = new URL(String(rawUrl || '')).searchParams.get('layer') || ''
    const match = layer.match(/^video:[^:]+:[0-9a-f-]{36}:([0-9a-f-]{36})$/i)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

function boostySourceMeta(entity, summary = null) {
  const meta = {
    canonical_url: entity?.canonical_url || null,
    posts_remote_count: entity?.posts_count ?? null,
    subscribers_count: entity?.subscribers_count ?? null,
    subscription: entity?.subscription || null,
    subscription_kind: entity?.subscription_kind || null,
  }
  if (summary) Object.assign(meta, {
    catalog_complete: summary?.catalog_complete === true,
    catalog_posts_count: summary?.posts_total ?? null,
    catalog_video_posts_count: summary?.video_posts ?? null,
    catalog_videos_count: summary?.videos_total ?? null,
    catalog_accessible_posts: summary?.accessible_posts ?? null,
    catalog_tags: summary?.tags || [],
    catalog_checked_at: Math.floor(Date.now() / 1000),
  })
  return meta
}

function persistBoostyCatalog({ entity, posts, thumbnails, summary, explicit = false, markSynced = false }) {
  if (!entity?.author_handle) throw new Error('Boosty не вернул автора')
  const sourceId = db.upsertBoostyChannel({
    author_id: entity.author_id || null,
    handle: entity.author_handle,
    display_name: entity.title || entity.author_handle,
    avatar_url: entity.avatar_url || null,
    meta: boostySourceMeta(entity, summary),
    is_explicit: explicit,
    mark_synced: markSynced,
  })
  const relativeThumbnails = {}
  for (const [externalId, filePath] of Object.entries(thumbnails || {})) {
    const relative = relativeLibraryPath(filePath)
    if (relative) relativeThumbnails[String(externalId)] = relative
  }
  const counts = db.upsertBoostyCatalog({
    source_id: sourceId,
    posts: posts || [],
    thumbnail_paths: relativeThumbnails,
  })
  db.patchSourceMeta(sourceId, boostySourceMeta(entity, summary), { mark_synced: markSynced })
  return { sourceId, counts }
}

async function startBoostyThumbnailCache({
  sourceId, entity, posts, thumbnailItems = null, manifestPath: suppliedManifestPath = null,
  thumbnailCount = 0, notifyJob = null, fullCatalog = false,
}) {
  if (!sourceId || !entity?.author_handle) return
  const items = Array.isArray(thumbnailItems) ? thumbnailItems : []
  if (!thumbnailItems && Array.isArray(posts)) {
    for (const post of posts) {
      if (post?.external_id && post?.thumbnail_url) {
        items.push({ external_id: String(post.external_id), url: post.thumbnail_url })
      }
      for (const video of post?.videos || []) {
        if (video?.video_id && video?.thumbnail_url) {
          items.push({ external_id: String(video.video_id), url: video.thumbnail_url })
        }
      }
    }
  }
  const itemCount = items.length || Number(thumbnailCount || 0)
  if (!itemCount) return

  // A refresh supersedes an older cache pass for the same author. Metadata is
  // already safely persisted and remote previews remain usable while this
  // best-effort background process is replaced.
  const previous = boostyThumbnailProcesses.get(sourceId)
  if (previous?.child && !previous.child.killed && !fullCatalog) return
  if (previous?.child && !previous.child.killed) {
    try { previous.child.kill('SIGTERM') } catch {}
  }

  const manifestPath = suppliedManifestPath || path.join(
    BOOSTY_TMP_DIR, `thumbnails-${sourceId}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  )
  if (!suppliedManifestPath) {
    try {
      await fs.promises.writeFile(manifestPath, JSON.stringify({ author: entity.author_handle, items }), {
        encoding: 'utf8',
        mode: 0o600,
      })
    } catch (error) {
      console.error('[Jobs] Boosty thumbnail manifest write failed', error)
      return
    }
  }
  const child = spawn(WORKER_PYTHON, [
    BOOSTY_THUMBNAIL_SCRIPT,
    '--manifest', manifestPath,
    '--output-dir', BOOSTY_THUMBNAILS_DIR,
  ], {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { child, manifestPath, cached: 0, requested: itemCount, summary: null, fullCatalog }
  boostyThumbnailProcesses.set(sourceId, state)
  if (notifyJob?.boosty_channel) {
    notifyJob.boosty_channel = {
      ...notifyJob.boosty_channel,
      thumbnail_cache: { status: 'running', cached: 0, requested: itemCount },
    }
    emit(notifyJob)
  }
  console.log(`[Jobs] boosty thumbnail cache start source=${sourceId} rows=${itemCount}`)

  let stderrTail = ''
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt
    try { evt = JSON.parse(line) } catch { return }
    if (evt.type === 'thumbnail' && evt.external_id && evt.path) {
      const relative = relativeLibraryPath(evt.path)
      if (relative && db.setItemThumbnailPath(sourceId, evt.external_id, relative)) state.cached += 1
    } else if (evt.type === 'done') {
      state.summary = evt
    }
  })
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-1000) })
  child.on('close', code => {
    try { fs.unlinkSync(manifestPath) } catch {}
    if (boostyThumbnailProcesses.get(sourceId) === state) boostyThumbnailProcesses.delete(sourceId)
    const ok = code === 0 && !!state.summary
    try {
      const cacheMeta = state.fullCatalog
        ? {
            thumbnail_cache_status: ok ? 'done' : 'partial',
            thumbnail_cache_count: state.cached,
            thumbnail_cache_checked_at: Math.floor(Date.now() / 1000),
          }
        : {
            // A post preview/filtered request may cache only a handful of
            // images; keep the full-catalog count as the aggregate truth.
            thumbnail_preview_checked_at: Math.floor(Date.now() / 1000),
          }
      db.patchSourceMeta(sourceId, cacheMeta)
    } catch (err) {
      console.error('[Jobs] boosty thumbnail cache metadata failed', err)
    }
    if (notifyJob?.boosty_channel) {
      notifyJob.boosty_channel = {
        ...notifyJob.boosty_channel,
        thumbnail_cache: {
          status: ok ? 'done' : 'partial',
          cached: state.cached,
          requested: items.length,
        },
      }
      emit(notifyJob)
    }
    console.log(`[Jobs] boosty thumbnail cache end source=${sourceId} status=${ok ? 'done' : 'partial'} cached=${state.cached}${stderrTail && !ok ? ' stderr=' + stderrTail.slice(-180) : ''}`)
  })
}

function lookupBoostyChannel(payload = {}) {
  const handle = String(payload.handle || payload.target || '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?boosty\.to\//i, '')
    .split(/[/?#]/, 1)[0]
    .replace(/^@+/, '')
  if (!handle) return null
  try {
    const connection = db.getDb()
    return connection.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM items i WHERE i.source_id=s.id AND i.type='boosty_post') AS items_count,
        (SELECT COUNT(*) FROM items i WHERE i.source_id=s.id AND i.type='boosty_video') AS boosty_videos_count,
        (SELECT COUNT(*) FROM items i WHERE i.source_id=s.id AND i.type='boosty_video' AND i.transcribe_status='done') AS boosty_transcribed_count
      FROM sources s WHERE s.platform='boosty' AND s.handle=? LIMIT 1
    `).get(handle) || null
  } catch (err) {
    console.error('[Jobs] lookupBoostyChannel failed', err)
    return null
  }
}

function startBoostyChannelFetch(params = {}) {
  if (params.auth_mode === 'public') {
    const { createPublicCatalogRunner } = require('./boosty-catalog-runner')
    return createPublicCatalogRunner({ db, jobs, allocateId: () => nextId++, spawn, workerEnv,
      python: WORKER_PYTHON, script: BOOSTY_CATALOG_SCRIPT, cwd: WORKERS_ROOT,
      emit, emitEvent, markJobClosed, finalizeCatalog: finalizeCatalogJob }).start(params)
  }
  const target = String(params.target || params.url || '').trim()
  const authCookie = String(params.authCookie || '').trim()
  if (!target) throw new Error('startBoostyChannelFetch: target required')
  if (!authCookie) throw new Error('startBoostyChannelFetch: browser auth required')
  const targetKey = target.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
  for (const existing of jobs.values()) {
    if (existing.status !== 'running' || existing.type !== 'boosty_channel_fetch') continue
    const existingKey = String(existing.target || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
    if (existingKey === targetKey) return existing.id
  }
  const id = nextId++

  const args = [
    BOOSTY_CATALOG_SCRIPT,
    target,
    '--limit', String(Math.max(0, Number(params.limit || 0))),
    '--order', params.order === 'asc' ? 'asc' : 'desc',
  ]
  if (params.from_ts) args.push('--from-ts', String(params.from_ts))
  if (params.to_ts) args.push('--to-ts', String(params.to_ts))
  if (Array.isArray(params.tags) && params.tags.length) args.push('--tags', params.tags.join(','))
  if (params.only_allowed) args.push('--only-allowed')

  const env = workerEnv()
  env.SC_BOOSTY_AUTH_COOKIE = authCookie
  if (params.authExpiration) env.SC_BOOSTY_AUTH_EXPIRES = String(params.authExpiration)
  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  delete env.SC_BOOSTY_AUTH_COOKIE
  delete env.SC_BOOSTY_AUTH_EXPIRES

  const safeParams = {
    target,
    limit: Math.max(0, Number(params.limit || 0)),
    order: params.order === 'asc' ? 'asc' : 'desc',
    from_ts: params.from_ts || null,
    to_ts: params.to_ts || null,
    tags: Array.isArray(params.tags) ? params.tags : [],
    only_allowed: !!params.only_allowed,
  }
  const isFullFeedRequest = safeParams.limit === 0
    && !safeParams.from_ts
    && !safeParams.to_ts
    && safeParams.tags.length === 0
    && !safeParams.only_allowed
  const job = {
    id,
    type: 'boosty_channel_fetch',
    target,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: safeParams,
    entity_title: null,
    entity_kind: 'boosty_channel',
    source_id: null,
    boosty_channel: { stage: 'authorizing', loaded: 0, catalog_complete: false },
    _boostyEntity: null,
    _boostyPosts: [],
    _boostyThumbnails: {},
    _boostySummary: null,
    child,
  }
  jobs.set(id, job)
  emit(job)
  console.log(`[Jobs] start boosty_channel_fetch #${id} target=${target} limit=${safeParams.limit || 'all'} order=${safeParams.order}`)

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt
    try { evt = JSON.parse(line) } catch { return }
    emitEvent(job, evt)
    switch (evt.type) {
      case 'entity':
        job._boostyEntity = evt
        job.entity_title = evt.title || evt.author_handle
        job.items_total = Number(evt.posts_count || 0) || null
        job.boosty_channel = {
          ...job.boosty_channel,
          stage: 'catalog',
          author_handle: evt.author_handle,
          title: evt.title,
          avatar_url: evt.avatar_url,
          remote_total: evt.posts_count || null,
          subscription: evt.subscription || null,
        }
        try {
          job.source_id = db.upsertBoostyChannel({
            author_id: evt.author_id || null,
            handle: evt.author_handle,
            display_name: evt.title || evt.author_handle,
            avatar_url: evt.avatar_url || null,
            meta: boostySourceMeta(evt),
            is_explicit: true,
            mark_synced: false,
          })
        } catch (err) {
          console.error('[Jobs] upsertBoostyChannel failed', err)
        }
        emit(job)
        break
      case 'post':
        if (evt.data) job._boostyPosts.push(evt.data)
        break
      case 'page':
        job.items_done = Number(evt.loaded || job._boostyPosts.length)
        job.items_total = Number(evt.remote_total || job.items_total || 0) || null
        job.boosty_channel = {
          ...job.boosty_channel,
          stage: 'catalog',
          loaded: job.items_done,
          remote_total: job.items_total,
          oldest_at: evt.oldest_at || null,
          has_more: evt.has_more === true,
        }
        emit(job)
        break
      case 'thumbnail':
        if (evt.external_id && evt.path) job._boostyThumbnails[String(evt.external_id)] = evt.path
        break
      case 'done':
        job._boostySummary = {
          ...evt,
          catalog_complete: isFullFeedRequest && evt.catalog_complete === true,
        }
        job.items_done = Number(evt.posts_total || job._boostyPosts.length)
        job.items_total = job.items_done
        job.boosty_channel = {
          ...job.boosty_channel,
          stage: 'saving',
          loaded: job.items_done,
          posts_total: evt.posts_total || 0,
          video_posts: evt.video_posts || 0,
          videos_total: evt.videos_total || 0,
          accessible_posts: evt.accessible_posts || 0,
          catalog_complete: isFullFeedRequest && evt.catalog_complete === true,
          tags: evt.tags || [],
        }
        emit(job)
        break
      case 'error':
        job.error = evt.message || 'Не удалось загрузить каталог Boosty'
        job.error_code = evt.code || null
        emit(job)
        break
    }
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-2000) })
  child.on('error', err => { job.error = `spawn error: ${err.message}` })
  child.on('close', code => {
    void (async () => {
    job.child = null
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      job.status = code === 0 && job._boostySummary ? 'done' : 'error'
      if (job.status === 'error') job.error = job.error || stderrTail.slice(-300) || `python exited ${code}`
    }
    job.finished_at = Math.floor(Date.now() / 1000)
    const terminalStatus = job.status
    job.phase = 'finalizing'
    job.status = terminalStatus === 'cancelled' ? 'cancelling' : 'running'
    emit(job)
    let catalogResult = null
    if (job._boostyEntity && job._boostyPosts.length) {
      try {
        const summary = isFullFeedRequest
          ? (job._boostySummary || { catalog_complete: false, posts_total: job._boostyPosts.length })
          : null
        catalogResult = await finalizeCatalogJob({
          kind: 'boosty-catalog',
          entity: job._boostyEntity,
          items: job._boostyPosts,
          thumbnails: job._boostyThumbnails,
          source_meta: boostySourceMeta(job._boostyEntity, summary),
          explicit: true,
          mark_synced: terminalStatus === 'done' && isFullFeedRequest,
          thumbnail_manifest_path: terminalStatus === 'done'
            ? path.join(
                BOOSTY_TMP_DIR,
                `thumbnails-${job.source_id || id}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
              )
            : null,
        })
        job.source_id = catalogResult.sourceId
        job.boosty_channel = {
          ...job.boosty_channel,
          stage: terminalStatus === 'done' ? 'done' : job.boosty_channel.stage,
          stored_posts: catalogResult.counts.posts,
          stored_videos: catalogResult.counts.videos,
        }
        if (terminalStatus === 'done') {
          void startBoostyThumbnailCache({
            sourceId: catalogResult.sourceId,
            entity: job._boostyEntity,
            thumbnailItems: catalogResult.thumbnailItems,
            manifestPath: catalogResult.thumbnailManifestPath,
            thumbnailCount: catalogResult.thumbnailCount,
            notifyJob: job,
            fullCatalog: isFullFeedRequest,
          })
        }
      } catch (error) {
        console.error('[Jobs] Boosty catalog finalizer worker failed; falling back to main', error)
      }
    }
    job.status = terminalStatus
    try {
      if (!catalogResult && job._boostyEntity && job._boostyPosts.length) {
        const entityForThumbnails = job._boostyEntity
        const postsForThumbnails = job._boostyPosts
        const persisted = persistBoostyCatalog({
          entity: job._boostyEntity,
          posts: job._boostyPosts,
          thumbnails: job._boostyThumbnails,
          // A filtered/ranged request enriches the known post list but must
          // not overwrite the source-wide proof that the whole feed was read.
          summary: isFullFeedRequest
            ? (job._boostySummary || { catalog_complete: false, posts_total: job._boostyPosts.length })
            : null,
          explicit: true,
          markSynced: job.status === 'done' && isFullFeedRequest,
        })
        job.source_id = persisted.sourceId
        job.boosty_channel = {
          ...job.boosty_channel,
          stage: job.status === 'done' ? 'done' : job.boosty_channel.stage,
          stored_posts: persisted.counts.posts,
          stored_videos: persisted.counts.videos,
        }
        if (job.status === 'done') {
          void startBoostyThumbnailCache({
            sourceId: persisted.sourceId,
            entity: entityForThumbnails,
            posts: postsForThumbnails,
            notifyJob: job,
            fullCatalog: isFullFeedRequest,
          })
        }
      }
      const persistedParams = {
        ...safeParams,
        _boosty_channel: job.boosty_channel,
        entity_title: job.entity_title,
      }
      job.params = persistedParams
      let recordedInWorker = false
      try {
        await finalizeBatchJob({
          job: {
            type: job.type,
            source_id: job.source_id || null,
            status: job.status,
            items_total: job.items_total,
            items_done: job.items_done,
            items_failed: job.status === 'error' ? 1 : 0,
            cost_usd: 0,
            params: persistedParams,
            error: job.error,
            started_at: job.started_at,
            finished_at: job.finished_at,
          },
        })
        recordedInWorker = true
      } catch (error) {
        console.error('[Jobs] Boosty catalog history worker failed; falling back to main', error)
      }
      if (!recordedInWorker) db.recordJob({
        type: job.type,
        source_id: job.source_id || null,
        status: job.status,
        items_total: job.items_total,
        items_done: job.items_done,
        items_failed: job.status === 'error' ? 1 : 0,
        cost_usd: 0,
        params: persistedParams,
        error: job.error,
        started_at: job.started_at,
        finished_at: job.finished_at,
      })
    } catch (err) {
      console.error('[Jobs] boosty_channel_fetch DB write failed', err)
      if (job.status === 'done') {
        job.status = 'error'
        job.error = 'Каталог получен, но не удалось сохранить его в библиотеку'
      }
    }
    delete job._boostyEntity
    delete job._boostyPosts
    delete job._boostyThumbnails
    delete job._boostySummary
    job.phase = 'terminal'
    console.log(`[Jobs] end boosty_channel_fetch #${id} status=${job.status} posts=${job.items_done}${job.error ? ' error=' + job.error : ''}`)
    emit(job)
    markJobClosed(job)
    })().catch(error => {
      job.status = 'error'
      job.phase = 'terminal'
      job.error = String(error?.message || error)
      job.finished_at = Math.floor(Date.now() / 1000)
      delete job._boostyEntity
      delete job._boostyPosts
      delete job._boostyThumbnails
      delete job._boostySummary
      console.error(`[Jobs] boosty_channel_fetch #${id} close failed`, error)
      emit(job)
      markJobClosed(job)
    })
  })
  return id
}

async function previewBoostyPost(params = {}) {
  const url = String(params.url || '').trim()
  const authCookie = String(params.authCookie || '').trim()
  if (!url) throw new Error('previewBoostyPost: url required')
  if (!authCookie) throw new Error('previewBoostyPost: browser auth required')
  const events = await runOneShotNdjson(
    BOOSTY_CATALOG_SCRIPT,
    [url, '--post'],
    { extraEnv: { SC_BOOSTY_AUTH_COOKIE: authCookie } },
  )
  const failure = events.find(evt => evt.type === 'error')
  const entity = events.find(evt => evt.type === 'entity') || null
  const post = events.find(evt => evt.type === 'post')?.data || null
  if (failure || !entity || !post) {
    const err = new Error(failure?.message || 'Boosty не вернул данные поста')
    err.code = failure?.code || 'boosty_preview_failed'
    throw err
  }
  const thumbnails = {}
  for (const evt of events) {
    if (evt.type === 'thumbnail' && evt.external_id && evt.path) thumbnails[String(evt.external_id)] = evt.path
  }
  const persisted = persistBoostyCatalog({
    entity,
    posts: [post],
    thumbnails,
    // A one-post preview proves only that post. It must never overwrite a
    // previously verified full-channel coverage count with "1 post".
    summary: null,
    explicit: false,
    markSynced: false,
  })
  void startBoostyThumbnailCache({
    sourceId: persisted.sourceId,
    entity,
    posts: [post],
  })
  return {
    source_id: persisted.sourceId,
    entity,
    post,
    selected_video_id: boostySelectedVideoId(url),
  }
}

function boostyBatchSelectionRows(sourceId, videoIds) {
  const source = db.getSource(sourceId)
  if (!source || source.platform !== 'boosty') throw new Error('Источник Boosty не найден')
  const rows = db.listBoostyVideos(sourceId, videoIds)
  const byId = new Map(rows.map(row => [String(row.external_id), row]))
  const ordered = []
  for (const rawId of videoIds) {
    const row = byId.get(String(rawId))
    if (row && !ordered.some(item => String(item.external_id) === String(row.external_id))) ordered.push(row)
  }
  if (!ordered.length) throw new Error('Выбранные видео Boosty не найдены в библиотеке')
  return { source, rows: ordered }
}

function existingFile(filePath) {
  return existingFileBytes(filePath) > 0
}

function existingFileBytes(filePath) {
  try {
    const stat = filePath ? fs.statSync(filePath) : null
    return stat?.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

function boostyCachedBatchLog(row, mode) {
  const transcriptPath = mode === 'download' ? null : row.transcript_path
  const candidateSrt = transcriptPath
    ? String(transcriptPath).replace(/\.txt$/i, '.srt')
    : null
  return {
    video_id: String(row.external_id),
    title: row.title || null,
    kind: 'cache',
    file_path: transcriptPath,
    srt_path: existingFile(candidateSrt) ? candidateSrt : null,
    audio_path: row.media_path || null,
    audio_bytes: existingFileBytes(row.media_path),
    video_path: row.video_path || null,
    video_bytes: existingFileBytes(row.video_path),
  }
}

function synthesiseCachedBoostyBatchFromLogs(params, log, mode) {
  const id = nextId++
  const now = Math.floor(Date.now() / 1000)
  const job = {
    id,
    type: 'boosty_batch_transcribe',
    target: `source:${params.source_id}`,
    source_id: Number(params.source_id),
    status: 'done',
    items_done: log.length,
    items_total: log.length,
    started_at: now,
    finished_at: now,
    params: { ...params, mode },
    entity_title: params.entity_title || null,
    entity_kind: 'boosty_channel',
    boosty_batch: {
      mode,
      saved: log.length,
      cached: log.length,
      errors: 0,
      current: null,
      log,
    },
  }
  jobs.set(id, job)
  try {
    db.recordJob({
      type: job.type,
      source_id: job.source_id,
      status: 'done',
      items_total: log.length,
      items_done: log.length,
      items_failed: 0,
      cost_usd: 0,
      params: { ...job.params, _boosty_batch: job.boosty_batch },
      started_at: now,
      finished_at: now,
    })
  } catch (err) {
    console.error('[Jobs] cached Boosty batch DB write failed', err)
  }
  emit(job)
  markJobClosed(job)
  return id
}

async function startBoostyBatchTranscribe(params = {}) {
  const sourceId = Number(params.source_id)
  const videoIds = Array.isArray(params.video_ids)
    ? [...new Set(params.video_ids.map(String).filter(Boolean))]
    : []
  if (!sourceId || !videoIds.length) throw new Error('Нужно выбрать хотя бы одно видео Boosty')
  const mode = params.mode === 'download' ? 'download' : 'transcribe'
  const storageConfig = getBoostyStorageConfig()
  // Full-video archiving is an explicit download-mode choice. A regular
  // transcription never inherits it silently and stays on the fast MP3 path.
  const saveVideo = mode === 'download' && (params.save_video === true || storageConfig.save_video)
  const authCookie = String(params.authCookie || '').trim()
  if (!authCookie) throw new Error('startBoostyBatchTranscribe: browser auth required')
  for (const existing of jobs.values()) {
    if ((existing.status !== 'running' && existing.status !== 'cancelling')
        || existing.type !== 'boosty_batch_transcribe') continue
    if (Number(existing.source_id) === sourceId) return existing.id
  }
  let plan
  try {
    plan = await dbRead.request('boostyBatchPlan', sourceId, videoIds, mode, saveVideo, storageConfig)
  } catch (workerError) {
    console.error('[Jobs] Boosty batch plan worker failed; falling back to main', workerError)
    const fallback = boostyBatchSelectionRows(sourceId, videoIds)
    const cachedLogs = []
    const selection = []
    for (const row of fallback.rows) {
      const ready = mode === 'download'
        ? existingFile(row.media_path) && (!saveVideo || existingFile(row.video_path))
        : existingFile(row.transcript_path)
      if (ready) {
        cachedLogs.push(boostyCachedBatchLog(row, mode))
        continue
      }
      let meta = {}
      try { meta = JSON.parse(row.raw_meta_json || '{}') } catch {}
      selection.push({
        url: row.url,
        video_id: String(row.external_id),
        position: meta.position || null,
        title: row.title || null,
        duration_sec: row.duration_seconds || null,
        author: fallback.source.display_name || fallback.source.handle,
        audio_path: existingFile(row.media_path) ? row.media_path : null,
        video_path: existingFile(row.video_path) ? row.video_path : null,
      })
    }
    plan = { source: fallback.source, total: fallback.rows.length, cachedLogs, selection }
  }
  const { source } = plan
  const cachedLogs = plan.cachedLogs || []
  const selection = plan.selection || []
  // The plan read is asynchronous. Recheck after it resolves so two rapid
  // clicks cannot both pass the pre-read guard and spawn duplicate batches.
  for (const existing of jobs.values()) {
    if ((existing.status !== 'running' && existing.status !== 'cancelling')
        || existing.type !== 'boosty_batch_transcribe') continue
    if (Number(existing.source_id) === sourceId) return existing.id
  }
  const safeParams = {
    source_id: sourceId,
    video_ids: videoIds,
    mode,
    save_video: saveVideo,
    entity_title: source.display_name || source.handle,
  }
  if (!selection.length) return synthesiseCachedBoostyBatchFromLogs(safeParams, cachedLogs, mode)

  const id = nextId++
  const selectionPath = path.join(BOOSTY_TMP_DIR, `selection-${id}-${Date.now()}.json`)
  await fs.promises.writeFile(selectionPath, JSON.stringify({ items: selection }), { encoding: 'utf8', mode: 0o600 })

  const args = [
    BOOSTY_SCRIPT,
    '--selection-file', selectionPath,
    '--media-dir', storageConfig.audio_dir,
    '--transcript-dir', BOOSTY_TRANSCRIPTS_DIR,
    '--work-dir', BOOSTY_TMP_DIR,
  ]
  if (saveVideo) args.push('--save-video', '--video-dir', storageConfig.video_dir)
  if (mode === 'download') args.push('--download-only')
  const env = workerEnv()
  env.SC_BOOSTY_AUTH_COOKIE = authCookie
  if (params.authExpiration) env.SC_BOOSTY_AUTH_EXPIRES = String(params.authExpiration)
  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  delete env.SC_BOOSTY_AUTH_COOKIE
  delete env.SC_BOOSTY_AUTH_EXPIRES

  const seedLog = cachedLogs
  const job = {
    id,
    type: 'boosty_batch_transcribe',
    target: `source:${sourceId}`,
    source_id: sourceId,
    status: 'running',
    items_done: cachedLogs.length,
    items_total: plan.total,
    started_at: Math.floor(Date.now() / 1000),
    params: safeParams,
    entity_title: source.display_name || source.handle,
    entity_kind: 'boosty_channel',
    boosty_batch: {
      mode,
      saved: cachedLogs.length,
      cached: cachedLogs.length,
      errors: 0,
      current: null,
      log: seedLog,
    },
    _boostySelectionPath: selectionPath,
    child,
  }
  jobs.set(id, job)
  emit(job)
  console.log(`[Jobs] start boosty_batch_transcribe #${id} source=${sourceId} mode=${mode} selected=${plan.total} cached=${cachedLogs.length}`)

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt
    try { evt = JSON.parse(line) } catch { return }
    handleBoostyBatchEvent(job, evt)
  })
  let stderrTail = ''
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-2000) })
  child.on('error', err => { job.error = `spawn error: ${err.message}` })
  child.on('close', code => {
    void (async () => {
    job.child = null
    try { await fs.promises.unlink(selectionPath) } catch {}
    delete job._boostySelectionPath
    if (job._cancelRequested || job.status === 'cancelling' || job.status === 'cancelled') {
      job.status = 'cancelled'
      job.error = null
    } else if (job.status === 'running') {
      job.status = code === 0 ? 'done' : 'error'
      if (code !== 0) job.error = job.error || stderrTail.slice(-300) || `python exited ${code}`
    }
    job.finished_at = Math.floor(Date.now() / 1000)
    const persistedParams = { ...safeParams, _boosty_batch: job.boosty_batch }
    job.params = persistedParams
    const terminalStatus = job.status
    job.phase = 'finalizing'
    job.status = terminalStatus === 'cancelled' ? 'cancelling' : 'running'
    emit(job)
    await waitForJobPersistence(job)
    let finalizedInWorker = false
    try {
      await finalizeBatchJob({
        job: {
          type: job.type,
          source_id: sourceId,
          status: terminalStatus,
          items_total: job.items_total,
          items_done: job.boosty_batch.saved,
          items_failed: job.boosty_batch.errors,
          cost_usd: job.cost_usd || 0,
          params: persistedParams,
          error: job.error,
          started_at: job.started_at,
          finished_at: job.finished_at,
        },
        coverage: mode === 'transcribe' && job.boosty_batch.saved > cachedLogs.length ? {
          source_id: sourceId,
          content_type: 'video', depth: 'transcribed',
          items_count: job.boosty_batch.saved - cachedLogs.length,
        } : null,
      })
      finalizedInWorker = true
    } catch (error) {
      console.error('[Jobs] Boosty batch finalizer worker failed; falling back to main', error)
    }
    job.status = terminalStatus
    try {
      if (!finalizedInWorker) db.recordJob({
        type: job.type,
        source_id: sourceId,
        status: job.status,
        items_total: job.items_total,
        items_done: job.boosty_batch.saved,
        items_failed: job.boosty_batch.errors,
        cost_usd: job.cost_usd || 0,
        params: persistedParams,
        error: job.error,
        started_at: job.started_at,
        finished_at: job.finished_at,
      })
      if (!finalizedInWorker && mode === 'transcribe' && job.boosty_batch.saved > cachedLogs.length) {
        db.recordCoverage({
          source_id: sourceId,
          job_id: null,
          date_from: null,
          date_to: null,
          content_type: 'video',
          depth: 'transcribed',
          items_count: job.boosty_batch.saved - cachedLogs.length,
        })
      }
    } catch (err) {
      console.error('[Jobs] boosty_batch_transcribe DB write failed', err)
    }
    job.phase = 'terminal'
    console.log(`[Jobs] end boosty_batch_transcribe #${id} status=${job.status} saved=${job.boosty_batch.saved} errors=${job.boosty_batch.errors}`)
    emit(job)
    markJobClosed(job)
    })().catch(error => {
      job.status = 'error'
      job.phase = 'terminal'
      job.error = String(error?.message || error)
      job.finished_at = Math.floor(Date.now() / 1000)
      console.error(`[Jobs] boosty_batch_transcribe #${id} close failed`, error)
      emit(job)
      markJobClosed(job)
    })
  })
  return id
}

function handleBoostyBatchEvent(job, evt) {
  emitEvent(job, evt)
  const batch = job.boosty_batch
  const videoId = evt.video_id ? String(evt.video_id) : batch.current?.video_id
  switch (evt.type) {
    case 'auth_ready':
      batch.stage = 'resolving'
      emit(job)
      break
    case 'batch_start':
      batch.stage = 'running'
      batch.run_total = Number(evt.items_total || 0)
      emit(job)
      break
    case 'item_start':
      batch.current = {
        i: Number(evt.item_index || 1) + Number(batch.cached || 0),
        n: job.items_total,
        video_id: videoId,
        title: evt.title || null,
        duration_sec: evt.duration_sec || null,
        stage: 'resolving',
      }
      emit(job)
      break
    case 'metadata':
      batch.current = {
        ...(batch.current || {}),
        video_id: videoId,
        title: evt.title || batch.current?.title,
        duration_sec: evt.duration_sec || batch.current?.duration_sec,
        stage: 'downloading',
      }
      emit(job)
      break
    case 'download_progress':
      batch.current = {
        ...(batch.current || {}),
        stage: 'downloading',
        downloaded_bytes: evt.downloaded_bytes || 0,
        total_bytes: evt.total_bytes || null,
        percent: evt.percent ?? null,
        speed_bps: evt.speed_bps || null,
        eta_sec: evt.eta_sec || null,
      }
      // yt-dlp can report dozens of chunks per second. Keep progress live
      // without flooding job:update / React with one IPC frame per chunk.
      if (!job._lastProgressEmit || Date.now() - job._lastProgressEmit >= 250) {
        job._lastProgressEmit = Date.now()
        emit(job)
      }
      break
    case 'download_processing':
      if (batch.current) batch.current.stage = 'extracting'
      emit(job)
      break
    case 'download_done':
      if (videoId && evt.audio_path) {
        const args = { source_id: job.source_id, external_id: videoId, media_path: evt.audio_path }
        queueJobPersistence(job, `Boosty #${job.id} audio path`,
          () => persistItemMutation({ method: 'markItemDownloaded', args }),
          () => db.markItemDownloaded(args))
      }
      if (videoId && evt.video_path) {
        const args = { source_id: job.source_id, external_id: videoId, video_path: evt.video_path }
        queueJobPersistence(job, `Boosty #${job.id} video path`,
          () => persistItemMutation({ method: 'markItemVideoDownloaded', args }),
          () => db.markItemVideoDownloaded(args))
      }
      batch.current = {
        ...(batch.current || {}),
        stage: job.params.mode === 'download' ? 'saving' : 'transcribing',
        audio_path: evt.audio_path || null,
        audio_bytes: evt.audio_bytes || null,
        video_path: evt.video_path || null,
        video_bytes: evt.video_bytes || null,
      }
      emit(job)
      break
    case 'transcribe_start':
      if (batch.current) batch.current.stage = 'transcribing'
      emit(job)
      break
    case 'transcribe_progress':
      batch.current = {
        ...(batch.current || {}),
        stage: 'transcribing',
        provider_stage: evt.stage || null,
        elapsed_sec: evt.elapsed_sec || null,
      }
      emit(job)
      break
    case 'transcribe_done':
      job.cost_usd = (job.cost_usd || 0) + Number(evt.cost_usd || 0)
      break
    case 'audio_saved':
      batch.saved += 1
      job.items_done = batch.saved + batch.errors
      if (videoId && evt.audio_path) {
        const args = { source_id: job.source_id, external_id: videoId, media_path: evt.audio_path }
        queueJobPersistence(job, `Boosty #${job.id} audio saved`,
          () => persistItemMutation({ method: 'markItemDownloaded', args }),
          () => db.markItemDownloaded(args))
      }
      if (videoId && evt.video_path) {
        const args = { source_id: job.source_id, external_id: videoId, video_path: evt.video_path }
        queueJobPersistence(job, `Boosty #${job.id} video saved`,
          () => persistItemMutation({ method: 'markItemVideoDownloaded', args }),
          () => db.markItemVideoDownloaded(args))
      }
      batch.log.push({
        video_id: videoId,
        title: evt.title || batch.current?.title || null,
        kind: evt.cached ? 'cache' : 'audio',
        audio_path: evt.audio_path,
        audio_bytes: evt.audio_bytes || batch.current?.audio_bytes || null,
        video_path: evt.video_path || batch.current?.video_path || null,
        video_bytes: evt.video_bytes || batch.current?.video_bytes || null,
      })
      batch.current = null
      emit(job)
      break
    case 'saved':
      batch.saved += 1
      job.items_done = batch.saved + batch.errors
      if (videoId) {
        if (evt.audio_path) {
          const args = { source_id: job.source_id, external_id: videoId, media_path: evt.audio_path }
          queueJobPersistence(job, `Boosty #${job.id} transcript audio`,
            () => persistItemMutation({ method: 'markItemDownloaded', args }),
            () => db.markItemDownloaded(args))
        }
        if (evt.video_path) {
          const args = { source_id: job.source_id, external_id: videoId, video_path: evt.video_path }
          queueJobPersistence(job, `Boosty #${job.id} transcript video`,
            () => persistItemMutation({ method: 'markItemVideoDownloaded', args }),
            () => db.markItemVideoDownloaded(args))
        }
        if (evt.file_path) {
          const args = {
            source_id: job.source_id, external_id: videoId,
            transcript_path: evt.file_path, engine: 'assemblyai', cost_usd: evt.cost_usd || null,
          }
          queueJobPersistence(job, `Boosty #${job.id} transcript`,
            () => persistItemMutation({ method: 'markItemTranscribed', args }),
            () => db.markItemTranscribed(args))
        }
      }
      batch.log.push({
        video_id: videoId,
        title: evt.title || batch.current?.title || null,
        kind: evt.cached ? 'cache' : 'ai',
        file_path: evt.file_path || null,
        srt_path: evt.srt_path || null,
        audio_path: evt.audio_path || null,
        audio_bytes: evt.audio_bytes || batch.current?.audio_bytes || null,
        video_path: evt.video_path || batch.current?.video_path || null,
        video_bytes: evt.video_bytes || batch.current?.video_bytes || null,
      })
      batch.current = null
      emit(job)
      break
    case 'item_error':
      batch.errors += 1
      job.items_done = batch.saved + batch.errors
      batch.log.push({
        video_id: videoId,
        title: evt.title || batch.current?.title || null,
        kind: 'error',
        message: evt.message,
      })
      {
        const method = job.params.mode === 'download' ? 'markItemDownloadError' : 'markItemTranscribeError'
        const args = { source_id: job.source_id, external_id: videoId, error: evt.message }
        queueJobPersistence(job, `Boosty #${job.id} item error`,
          () => persistItemMutation({ method, args }),
          () => db[method](args))
      }
      batch.current = null
      emit(job)
      break
    case 'done':
      batch.stage = 'done'
      batch.worker_failed = Number(evt.items_failed || 0)
      emit(job)
      break
    case 'error':
      if (evt.code === 'cancelled' && job.status === 'cancelled') break
      job.error = evt.message || 'Не удалось обработать видео Boosty'
      job.error_code = evt.code || null
      emit(job)
      break
  }
}

// ─── Boosty single video ─────────────────────────────────────────────
//
// The renderer supplies only a Boosty URL. Main obtains the short-lived
// `auth` cookie from the installed browser extension and passes it here as an
// in-memory argument. The value is put only in the child environment: never
// in job.params, snapshots, logs, or SQLite.

const BOOSTY_SCRIPT = path.join(WORKERS_ROOT, 'web', 'boosty_single_ndjson.py')

function startBoostySingle(params = {}) {
  const id = nextId++
  const url = String(params.url || '').trim()
  const authCookie = String(params.authCookie || '').trim()
  if (!url) throw new Error('startBoostySingle: url required')
  if (!authCookie) throw new Error('startBoostySingle: browser auth required')

  const storageConfig = getBoostyStorageConfig()
  const args = [
    BOOSTY_SCRIPT,
    url,
    '--media-dir', storageConfig.audio_dir,
    '--transcript-dir', BOOSTY_TRANSCRIPTS_DIR,
    '--work-dir', BOOSTY_TMP_DIR,
  ]
  const safeParams = { url, engine: 'assemblyai' }
  const job = {
    id,
    type: 'boosty_transcribe',
    target: url,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: safeParams,
    entity_title: null,
    entity_kind: 'boosty_video',
    boosty: { stage: 'authorizing', engine: 'assemblyai' },
    child: null,
  }
  jobs.set(id, job)
  emit(job)
  console.log(`[Jobs] start boosty_transcribe #${id} url=${url}`)

  const env = workerEnv()
  env.SC_BOOSTY_AUTH_COOKIE = authCookie
  if (params.authExpiration) env.SC_BOOSTY_AUTH_EXPIRES = String(params.authExpiration)
  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Drop the local references immediately after spawn. The child has its own
  // environment copy; the live job remains secret-free.
  delete env.SC_BOOSTY_AUTH_COOKIE
  delete env.SC_BOOSTY_AUTH_EXPIRES
  job.child = child
  attachBoostyStreams(job, child)
  return id
}

function attachBoostyStreams(job, child) {
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt
    try { evt = JSON.parse(line) } catch { return }
    handleBoostyEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    job.child = null
    if (job.status === 'running') {
      if (code === 0 && job.file_path) {
        job.status = 'done'
      } else if (code === null) {
        // cancelJob already set the terminal status.
      } else if (code === 130 && job.status === 'cancelled') {
        // SIGTERM handler converted the stop into a clean Python interrupt.
      } else {
        job.status = 'error'
        job.error = job.error || stderrTail.slice(-300) || `python exited ${code}`
      }
    }
    job.finished_at = Math.floor(Date.now() / 1000)

    if (job.status !== 'running') {
      const boosty = job.boosty || {}
      const persistedParams = {
        url: job.target,
        engine: 'assemblyai',
        result_files: boosty.result_files || null,
        _boosty: {
          canonical_url: boosty.canonical_url || null,
          post_id: boosty.post_id || null,
          video_id: boosty.video_id || null,
          title: boosty.title || job.entity_title || null,
          author: boosty.author || null,
          author_handle: boosty.author_handle || null,
          duration_sec: boosty.duration_sec || null,
          thumbnail: boosty.thumbnail || null,
          audio_path: boosty.audio_path || null,
          audio_bytes: boosty.audio_bytes || null,
          srt_path: boosty.srt_path || null,
          chars: boosty.chars || null,
        },
      }
      if (job.error_code) persistedParams._error_code = job.error_code
      job.params = persistedParams
      try {
        db.recordJob({
          type: 'boosty_transcribe',
          source_id: null,
          status: job.status,
          items_total: null,
          items_done: 0,
          cost_usd: job.cost_usd || 0,
          params: persistedParams,
          error: job.error,
          started_at: job.started_at,
          finished_at: job.finished_at,
          file_path: job.file_path || null,
        })
      } catch (err) {
        console.error('[Jobs] boosty_transcribe DB write failed', err)
      }
    }
    console.log(`[Jobs] end boosty_transcribe #${job.id} status=${job.status}${job.error ? ' error=' + job.error : ''}`)
    emit(job)
    markJobClosed(job)
  })

  child.on('error', err => {
    job.error = `spawn error: ${err.message}`
  })
}

function handleBoostyEvent(job, evt) {
  emitEvent(job, evt)
  switch (evt.type) {
    case 'auth_ready':
      job.boosty = { ...(job.boosty || {}), stage: 'resolving' }
      emit(job)
      break
    case 'metadata':
      job.entity_title = evt.title || job.entity_title
      job.boosty = {
        ...(job.boosty || {}),
        stage: 'downloading',
        canonical_url: evt.canonical_url,
        post_id: evt.post_id,
        video_id: evt.video_id,
        title: evt.title,
        author: evt.author,
        author_handle: evt.author_handle,
        duration_sec: evt.duration_sec,
        thumbnail: evt.thumbnail,
        playlist_index: evt.playlist_index,
        playlist_count: evt.playlist_count,
      }
      emit(job)
      break
    case 'download_progress':
      job.items_done = Number(evt.downloaded_bytes || 0)
      job.items_total = Number(evt.total_bytes || 0) || null
      job.boosty = {
        ...(job.boosty || {}),
        stage: 'downloading',
        downloaded_bytes: evt.downloaded_bytes || 0,
        total_bytes: evt.total_bytes || null,
        percent: evt.percent ?? null,
        speed_bps: evt.speed_bps || null,
        eta_sec: evt.eta_sec || null,
        fragment_index: evt.fragment_index || null,
        fragment_count: evt.fragment_count || null,
      }
      if (!job._lastProgressEmit || Date.now() - job._lastProgressEmit >= 250) {
        job._lastProgressEmit = Date.now()
        emit(job)
      }
      break
    case 'download_processing':
      job.boosty = { ...(job.boosty || {}), stage: 'extracting' }
      emit(job)
      break
    case 'download_done':
      job.boosty = {
        ...(job.boosty || {}),
        stage: 'transcribing',
        audio_path: evt.audio_path,
        audio_bytes: evt.audio_bytes,
        duration_sec: evt.duration_sec || job.boosty?.duration_sec,
      }
      emit(job)
      break
    case 'transcribe_start':
      job.boosty = { ...(job.boosty || {}), stage: 'transcribing', engine: evt.engine }
      emit(job)
      break
    case 'transcribe_progress':
      job.boosty = {
        ...(job.boosty || {}),
        stage: 'transcribing',
        engine: evt.engine,
        aai_stage: evt.stage,
        aai_status: evt.aai_status,
        aai_elapsed_sec: evt.elapsed_sec,
        aai_audio_dur_sec: evt.audio_duration_sec,
        aai_transcript_id: evt.transcript_id,
      }
      emit(job)
      break
    case 'transcribe_done':
      job.boosty = {
        ...(job.boosty || {}),
        stage: 'saving',
        chars: evt.chars,
      }
      job.cost_usd = (job.cost_usd || 0) + Number(evt.cost_usd || 0)
      emit(job)
      break
    case 'saved': {
      job.file_path = evt.file_path
      const resultFiles = {
        text: evt.file_path || null,
        srt: evt.srt_path || null,
        audio: evt.audio_path || null,
      }
      job.boosty = {
        ...(job.boosty || {}),
        stage: 'done',
        file_path: evt.file_path,
        srt_path: evt.srt_path || null,
        audio_path: evt.audio_path || job.boosty?.audio_path || null,
        audio_bytes: evt.audio_bytes || job.boosty?.audio_bytes || null,
        duration_sec: evt.duration_sec || job.boosty?.duration_sec || null,
        chars: evt.chars || job.boosty?.chars || null,
        result_files: resultFiles,
      }
      scheduleAutoCopy(job, evt.file_path, result => {
        job.boosty.copied_bytes = result.bytes
      })
      emit(job)
      break
    }
    case 'done':
      if (job.status === 'running' && job.file_path) {
        job.status = 'done'
        job.finished_at = Math.floor(Date.now() / 1000)
      }
      emit(job)
      break
    case 'error':
      if (evt.code === 'cancelled' && job.status === 'cancelled') {
        job.error = null
        job.error_code = null
        job.boosty = { ...(job.boosty || {}), stage: 'cancelled' }
        emit(job)
        break
      }
      job.error = evt.message || 'Boosty worker error'
      job.error_code = evt.code || null
      emit(job)
      break
  }
}

// ─── Local file transcribe ────────────────────────────────────────────
//
// Mirror of yt_transcribe minus the subs stage. One spawn → file event +
// transcribe_start/done + saved + done. AssemblyAI is the default engine
// for plain text; Soniox is the timed-output path because it returns tokens
// with start/end times that can be converted into SRT subtitles.

const LOCAL_SCRIPT = path.join(WORKERS_ROOT, 'web', 'local_transcribe_ndjson.py')

function startLocalTranscribe(params) {
  const id = nextId++
  const inputPath = String(params.path || '').trim()
  if (!inputPath) {
    throw new Error('startLocalTranscribe: path required')
  }
  const engine = params.engine === 'gemini'
    ? 'gemini'
    : params.engine === 'soniox'
      ? 'soniox'
      : 'assemblyai'
  const withTimings = engine === 'soniox' && params.with_timings === true

  const args = [
    LOCAL_SCRIPT,
    inputPath,
    '--out-dir', LOCAL_TRANSCRIPTS_DIR,
    '--engine', engine,
  ]
  if (withTimings) args.push('--timings')

  console.log(`[Jobs] start local_transcribe #${id} engine=${engine} timings=${withTimings ? 'on' : 'off'} path=${inputPath}`)

  const job = {
    id,
    type: 'local_transcribe',
    target: inputPath,
    status: 'running',
    items_done: 0,
    items_total: null,
    started_at: Math.floor(Date.now() / 1000),
    params: { ...params, engine, with_timings: withTimings },
    entity_title: path.basename(inputPath),
    entity_kind: 'local_file',
    local: { stage: 'transcribing', path: inputPath, engine, with_timings: withTimings,
             name: path.basename(inputPath) },
    child: null,
  }
  jobs.set(id, job)
  emit(job)

  const child = spawn(WORKER_PYTHON, args, {
    cwd: WORKERS_ROOT,
    env: workerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.child = child
  attachLocalStreams(job, child)
  return id
}

function attachLocalStreams(job, child) {
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let evt; try { evt = JSON.parse(line) } catch { return }
    handleLocalEvent(job, evt)
  })

  let stderrTail = ''
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.on('close', code => {
    job.child = null
    if (job.status === 'running') {
      if (code === 0) {
        if (job.file_path) {
          job.status = 'done'
        } else {
          job.status = 'error'
          job.error = job.error || stderrTail.slice(-200) || 'exited 0 without result'
        }
      } else if (code === null) {
        // killed (cancelJob already set status)
      } else {
        job.status = 'error'
        job.error = job.error || `python exited ${code}: ${stderrTail.slice(-200)}`
      }
    }
    job.finished_at = Math.floor(Date.now() / 1000)

    if (job.status !== 'running') {
      try {
        db.recordJob({
          type:         'local_transcribe',
          source_id:    null,
          status:       job.status,
          items_total:  null,
          items_done:   0,
          cost_usd:     job.cost_usd || 0,
          params: {
            path:         job.target,
            name:         job.local?.name || path.basename(job.target),
            size_bytes:   job.local?.size_bytes || null,
            duration_sec: job.local?.duration_sec || null,
            engine:       job.params?.engine || job.local?.engine,
            with_timings: !!(job.params?.with_timings || job.local?.with_timings),
            result_files: job.local?.result_files || null,
            srt_path:     job.local?.srt_path || null,
            srt_cues:     job.local?.srt_cues || null,
            token_count:  job.local?.token_count || null,
          },
          error:       job.error,
          started_at:  job.started_at,
          finished_at: job.finished_at,
          file_path:   job.file_path || null,
        })
      } catch (err) {
        console.error('[Jobs] local_transcribe DB write failed', err)
      }
    }

    const dur = job.finished_at - job.started_at
    console.log(`[Jobs] end #${job.id} status=${job.status} duration=${dur}s${job.error ? ' error=' + job.error : ''}`)
    emit(job)
  })

  child.on('error', err => {
    job.error = `spawn error: ${err.message}`
  })
}

function handleLocalEvent(job, evt) {
  emitEvent(job, evt)
  switch (evt.type) {
    case 'file':
      job.local = {
        ...(job.local || {}),
        path:         evt.path,
        name:         evt.name,
        size_bytes:   evt.size_bytes,
        duration_sec: evt.duration_sec,
      }
      job.entity_title = evt.name || job.entity_title
      emit(job)
      break
    case 'transcribe_start':
      job.local = { ...(job.local || {}), stage: 'transcribing', engine: evt.engine }
      emit(job)
      break
    case 'transcribe_progress':
      // Provider polling — fine-grained sub-stages so the UI can show
      // upload/queue/process/fetch progress instead of one frozen spinner.
      if (evt.engine === 'soniox') {
        job.local = { ...(job.local || {}),
                      stage: 'transcribing',
                      soniox_stage:   evt.stage,
                      soniox_status:  evt.status,
                      soniox_attempt: evt.attempt }
      } else {
        job.local = { ...(job.local || {}),
                      stage: 'transcribing',
                      aai_stage:           evt.stage,
                      aai_status:          evt.aai_status,
                      aai_elapsed_sec:     evt.elapsed_sec,
                      aai_audio_dur_sec:   evt.audio_duration_sec,
                      aai_transcript_id:   evt.transcript_id }
      }
      emit(job)
      break
    case 'transcribe_done':
      job.local = { ...(job.local || {}), stage: 'transcribed',
                    chars: evt.chars, cost_usd: evt.cost_usd }
      job.cost_usd = (job.cost_usd || 0) + (evt.cost_usd || 0)
      break
    case 'saved':
      job.file_path = evt.file_path
      job.params = { ...(job.params || {}),
        result_files: {
          text: evt.file_path || null,
          srt: evt.srt_path || null,
        },
        srt_path: evt.srt_path || null,
        srt_cues: evt.srt_cues || null,
        token_count: evt.token_count || null,
      }
      job.local = { ...(job.local || {}), file_path: evt.file_path,
                    srt_path: evt.srt_path || null,
                    srt_cues: evt.srt_cues || null,
                    token_count: evt.token_count || null,
                    with_timings: !!evt.timings,
                    result_files: {
                      text: evt.file_path || null,
                      srt: evt.srt_path || null,
                    },
                    kind: evt.kind, chars: evt.chars }
      scheduleAutoCopy(job, evt.file_path, result => {
        job.local.copied_bytes = result.bytes
      })
      break
    case 'done':
      if (job.status === 'running' && job.file_path) {
        job.status = 'done'
        job.finished_at = Math.floor(Date.now() / 1000)
      }
      emit(job)
      break
    case 'error':
      job.error = evt.message
      break
  }
}

module.exports = {
  runTelegramAsrCheckpointCommand,
  telegramFetchCapabilities,
  startTelegramLive,
  getTelegramLiveResult,
  startTelegramFetch,
  startTelegramCommentsCatchUp,
  startTelegramPreview,
  startTelegramFolderFetch,
  startTelegramFolderRefresh,
  startTelegramReplyBackfill,
  startTelegramCatchUp,
  runTelegramResolveTitle,
  runTelegramResolveFolder,
  startYoutubeSingle,
  resumeYoutubeAi,
  lookupYoutubeCache,
  createYoutubeTimedTranscript,
  startRutubeSingle,
  resumeRutubeAi,
  lookupRutubeCache,
  startYoutubeComments,
  lookupYoutubeCommentsCache,
  startYoutubeBatchComments,
  startYoutubeChannelFetch,
  startYoutubeBatchTranscribe,
  lookupYoutubeChannel,
  lookupTiktokChannel,
  lookupTiktokCache,
  startTiktokSingle,
  startTiktokChannelFetch,
  startTiktokBatchTranscribe,
  runTgSessionsCommand,
  sendTelegramSavedMessage,
  runTelegramTextCommand,
  runIgSessionsCommand,
  runIgLogin,
  startInstagramProfileFetch,
  startInstagramBatchTranscribe,
  startRedditThreadFetch,
  startRedditSearch,
  lookupBoostyChannel,
  startBoostyChannelFetch,
  previewBoostyPost,
  startBoostyBatchTranscribe,
  getBoostyWorkflow,
  startBoostySingle,
  startLocalTranscribe,
  runYoutubeSearch,
  resumeYoutubeBatch,
  cancelJob,
  setAutoIndexAfterFetch,
  listJobs,
  liveSnapshotsForSource,
  getJobDetail,
  subscribe,
  subscribeEvents,
  playClipboardSound,
  LIB_ROOT,
  JOBS_DIR,
  YT_TRANSCRIPTS_DIR,
  RUTUBE_TRANSCRIPTS_DIR,
  BOOSTY_TRANSCRIPTS_DIR,
  BOOSTY_MEDIA_DIR,
  BOOSTY_VIDEO_DIR,
  BOOSTY_THUMBNAILS_DIR,
  getBoostyStorageConfig,
}
