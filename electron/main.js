const { app, BrowserWindow, nativeImage, ipcMain, clipboard, shell, protocol, dialog } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Initialise file logger before anything else so early errors are captured.
const { init: initLogger } = require('./logger')
const { logPath } = initLogger()
console.log(`[Startup] SC Desktop launching (log: ${logPath})`)
const perfDiagnostics = require('./perf-diagnostics')
perfDiagnostics.install(ipcMain)

// macOS GUI-launched apps (Dock/Finder) inherit PATH=/usr/bin:/bin:/usr/sbin:/sbin
// from launchd — no /opt/homebrew/bin, no /usr/local/bin. Python subprocesses
// spawned by job-runner inherit this minimal PATH and can't find yt-dlp/ffmpeg.
// Dev shell-launched Electron doesn't hit this because PATH is inherited from zsh.
// Symptom: 'yt-dlp metadata fetch failed' on every YT/TikTok job in prod.
if (process.platform === 'darwin') {
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/opt/local/bin']
  const cur = (process.env.PATH || '').split(':').filter(Boolean)
  const merged = [...cur]
  for (const p of extra) if (!merged.includes(p)) merged.push(p)
  process.env.PATH = merged.join(':')
  console.log(`[Startup] PATH augmented with brew/macports: ${process.env.PATH}`)
}

const jobRunner = require('./job-runner')
const indexJob = require('./index-job')
const db = require('./database')
const dbRead = require('./database-read-client')
const {
  syncTelegramFolder,
  setTelegramAutoForSources,
  stopTelegramFinalizer,
} = require('./telegram-finalizer-client')
const { embedQuery } = require('./embedder')
const { normalizeRagScope, searchTelegramRag } = require('./telegram-rag-search')
const { createTelegramRagPreparation } = require('./telegram-rag-preparation')
const { assembleText } = require('./assemble')
const {
  startTelegramAutoScheduler,
  stopTelegramAutoScheduler,
  setTelegramAutoEnabled,
  clearTelegramAutoSessionBlock,
} = require('./telegram-auto')
const { startMobileApiServer } = require('./mobile-api-server')
const {
  createTelegramNotificationService,
} = require('./telegram-notification-service')
const {
  startServer: startBrowserBridge,
  listExternalJobsForUi,
} = require('./browser-bridge')
const { createResearchNavigation } = require('./research-navigation')
const researchNavigation = createResearchNavigation({
  readJob: jobId => listExternalJobsForUi({ jobId, summary: true }).find(job => job.jobId === jobId),
  getWindow: () => {
    let window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
    if (!window) {
      createWindow()
      window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
    }
    return window
  },
})
ipcMain.handle('research:open-job-ready', event => researchNavigation.ready(event.sender.id))
ipcMain.handle('research:open-job-ack', (event, body) => researchNavigation.acknowledge(event.sender.id, body))
app.on('before-quit', () => researchNavigation.dispose())
const {
  publicAppSettings,
  patchAppSettings,
} = require('./app-settings')

const isDev = process.env.NODE_ENV === 'development'
const isE2E = process.env.SC_DESKTOP_E2E === '1'
const rendererLiveSourceByWebContents = new Map()

async function readDb(method, args, fallback) {
  try {
    return await dbRead.request(method, ...(args || []))
  } catch (err) {
    // Preserve every existing flow if a packaged worker fails to load. This is
    // a loud recovery path, not the normal architecture.
    console.error(`[DbReadWorker] ${method} failed; falling back to main`, err)
    return fallback()
  }
}

if (!isE2E) indexJob.setTelegramPreparation(createTelegramRagPreparation({
  jobRunner,
  readDb: (method, args) => readDb(method, args, () => db[method](...args)),
}))

const isPrimaryInstance = isDev || app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  console.log('[Startup] Another production SC Desktop instance owns the app lock; exiting')
  app.quit()
} else if (!isDev) {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

// Pick the right icon. In dev: teal "DEV" variant so it's distinguishable
// from the production purple one (and from gt-editor / custom-terminal).
const ICON_PATH = path.join(
  __dirname, '..', 'build-resources',
  isDev ? 'icon-dev.png' : 'icon.png',
)
const ICON = nativeImage.createFromPath(ICON_PATH)
if (process.platform === 'darwin' && !ICON.isEmpty()) {
  app.dock?.setIcon(ICON)
}

function createWindow() {
  // App is 1700×1000 by default. In dev DevTools docks on the right
  // adding 320 px → outer window 2020×1000.
  const APP_WIDTH      = 1700
  const APP_HEIGHT     = 1000
  const DEVTOOLS_WIDTH = isDev ? 320 : 0

  const win = new BrowserWindow({
    width:  APP_WIDTH + DEVTOOLS_WIDTH,
    height: APP_HEIGHT,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0a0a0b',
    icon: ICON.isEmpty() ? undefined : ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: 'rgba(0,0,0,0)',
      height: 40,
      symbolColor: '#ffffff',
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    win.loadURL('http://localhost:5156')
    // Dock DevTools on the right inside the same window (like custom-terminal).
    // Chromium remembers the last-used DevTools width per profile in its
    // own pref file — there's no public API to force a width, so we send
    // a CDP command to set it explicitly the first time.
    win.webContents.openDevTools({ mode: 'right' })
    win.webContents.once('devtools-opened', () => {
      try {
        win.webContents.devToolsWebContents?.executeJavaScript(`
          // Persist target dock width so we keep our 320px no matter what.
          // Chromium reads this from localStorage on the DevTools frontend.
          try {
            localStorage.setItem('InspectorView.splitViewState',
              JSON.stringify({ vertical: { size: 320 }, horizontal: { size: 320 } }));
            // Also set the modern key name used since DevTools 119+.
            localStorage.setItem('inspectorViewSplitViewState',
              JSON.stringify({ vertical: { size: 320 }, horizontal: { size: 320 } }));
          } catch {}
        `)
      } catch {}
    })
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // Forward job events to the renderer.
  const offJobUpdates = jobRunner.subscribe(job => {
    perfDiagnostics.noteJobUpdate(job, 'jobRunner')
    if (!win.isDestroyed()) win.webContents.send('job:update', job)
  }, {
    includeLiveItems: job => (
      Number(rendererLiveSourceByWebContents.get(win.webContents.id)) === Number(job.source_id)
    ),
  })
  const offIndexUpdates = indexJob.subscribe(job => {
    perfDiagnostics.noteJobUpdate(job, 'indexJob')
    if (!win.isDestroyed()) win.webContents.send('job:update', job)
  })
  win.once('closed', () => {
    rendererLiveSourceByWebContents.delete(win.webContents.id)
    try { offJobUpdates() } catch {}
    try { offIndexUpdates() } catch {}
  })
}

ipcMain.handle('jobs:list', async () => {
  const historyRows = await readDb('activityHistoryRows', [], () => null)
  const indices = indexJob.listActiveSnapshots()
  const rows = jobRunner.listJobs(historyRows).filter(row => !indices.some(index => (
    row.id === index.id || (index.db_id != null && (
      row.db_id === index.db_id || row.id === `db-${index.db_id}`
    ))
  )))
  return [...rows, ...indices].sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
})
ipcMain.handle('jobs:setLiveSource', (event, sourceId) => {
  const id = Number(sourceId)
  if (Number.isFinite(id) && id > 0) {
    rendererLiveSourceByWebContents.set(event.sender.id, id)
    const snapshots = jobRunner.liveSnapshotsForSource(id)
    for (const snapshot of snapshots) {
      try { event.sender.send('job:update', snapshot) } catch {}
    }
    return { ok: true, sourceId: id, jobs: snapshots.length }
  }
  rendererLiveSourceByWebContents.delete(event.sender.id)
  return { ok: true, sourceId: null, jobs: 0 }
})

// ─── AI Studio MCP jobs — зеркало state'а из browser-bridge ──────────
//
// Bridge хранит RAM-only Map<jobId, state> которую расширение PATCH'ит
// на каждый log-event. Main берёт компактный snapshot прямо из того же
// модуля и раз в 1.5с broadcast'ит его renderer'у. Не ходить отсюда HTTP на
// собственный 53127: полный /external-jobs весит мегабайты из-за сохранённых
// ответов, а loopback учитывается Activity Monitor как сеть в обе стороны.
// Полные ответы запрашиваются только при открытии JobDetail.
// Имя IPC-канала оставлено aistudio:* для обратной совместимости с renderer-
// store (исторически), но содержимое теперь — все external-research jobs.
async function fetchAistudioJobs({ full = false, jobId = null } = {}) {
  if (isE2E) return { jobs: [] }
  try {
    return { jobs: listExternalJobsForUi({ summary: !full, jobId }) }
  } catch (e) {
    return { jobs: [], error: String(e?.message || e) }
  }
}
ipcMain.handle('aistudio:listJobs', (_evt, options) => fetchAistudioJobs({
  full: options?.full === true,
  jobId: typeof options?.jobId === 'string' ? options.jobId : null,
}))
ipcMain.handle('aistudio:clearJob', async (_evt, payload) => {
  try {
    const r = await fetch('http://127.0.0.1:53127/aistudio-clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    })
    return await r.json()
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})

// Per-job флаг keepTab: если true, при __sc_aistudio_mcp_done вкладка
// НЕ закрывается auto. Юзер ставит тогл в McpRunningPopover.
ipcMain.handle('aistudio:setKeepTab', async (_evt, payload) => {
  try {
    const { jobId, keepTab } = payload || {}
    if (!jobId) return { ok: false, error: 'missing jobId' }
    const r = await fetch('http://127.0.0.1:53127/aistudio-state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: jobId, keepTab: !!keepTab }),
    })
    return await r.json()
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})

// Research-старт из самого приложения (NewResearchScreen). Renderer НЕ может
// fetch'ить bridge напрямую: его origin (http://localhost:5156 в dev, file://
// в prod) не в ALLOWED_ORIGINS bridge'а, а добавлять его туда нельзя (CLAUDE.md:
// loopback-bridge только для known web-origin'ов; file:// вообще даёт null-origin
// который CORS-allowlist'ить небезопасно). Поэтому — через main, как все
// остальные bridge-вызовы (aistudio:listJobs и пр.). Тут CORS не действует.
ipcMain.handle('research:start', async (_evt, payload) => {
  try {
    const r = await fetch('http://127.0.0.1:53127/research-start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    })
    return await r.json()
  } catch (e) {
    return { error: String(e?.message || e) }
  }
})
ipcMain.handle('research:status', async (_evt, payload) => {
  try {
    const { id, wait } = payload || {}
    if (!id) return { error: 'missing id' }
    const url = `http://127.0.0.1:53127/research-status?id=${encodeURIComponent(id)}&wait=${Number(wait) || 0}`
    const r = await fetch(url)
    return await r.json()
  } catch (e) {
    return { error: String(e?.message || e) }
  }
})
ipcMain.handle('research:pplxModels', async () => {
  try {
    const r = await fetch('http://127.0.0.1:53127/pplx-models')
    return await r.json()
  } catch (e) {
    return { models: [], error: String(e?.message || e) }
  }
})
// Стоп research-джобы + управление вкладками браузера из попапа «Запущенные
// MCP» / страницы джобы. Раньше компоненты били прямым fetch'ем в bridge —
// CORS резал («Failed to fetch» до сети), кнопка Стоп «просто не работала».
ipcMain.handle('research:stop', async (_evt, payload) => {
  try {
    const r = await fetch('http://127.0.0.1:53127/research-stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    })
    return await r.json()
  } catch (e) {
    return { error: String(e?.message || e) }
  }
})
ipcMain.handle('bridge:tabCommand', async (_evt, payload) => {
  // path ∈ focus-tab | close-tab | open-url — фиксированный whitelist, не
  // произвольный проброс (renderer не должен дёргать любые bridge-эндпоинты).
  const { path, ...body } = payload || {}
  if (!['focus-tab', 'close-tab', 'open-url'].includes(path)) return { error: 'bad path' }
  try {
    const r = await fetch(`http://127.0.0.1:53127/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await r.json()
  } catch (e) {
    return { error: String(e?.message || e) }
  }
})

// Push-broadcast: каждые 1.5 сек, если есть открытые окна — pull bridge
// state и отправить в renderer через 'aistudio:update' event. Renderer
// слушает через window.api.onAistudioUpdate.
let aistudioBroadcastTimer = null
function startAistudioBroadcast() {
  if (aistudioBroadcastTimer) return
  let lastSerialized = ''
  aistudioBroadcastTimer = setInterval(async () => {
    const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
    if (wins.length === 0) return
    const { jobs } = await fetchAistudioJobs({ full: false })
    const serialized = JSON.stringify(jobs)
    if (serialized === lastSerialized) return // экономим IPC
    lastSerialized = serialized
    for (const w of wins) w.webContents.send('aistudio:update', { jobs })
  }, 1500)
}
function stopAistudioBroadcast() {
  if (aistudioBroadcastTimer) { clearInterval(aistudioBroadcastTimer); aistudioBroadcastTimer = null }
}
app.on('window-all-closed', () => stopAistudioBroadcast())
app.whenReady().then(() => {
  if (isPrimaryInstance && !isE2E) startAistudioBroadcast()
})

// ─── Telegram sessions / settings ─────────────────────────────────
//
// Settings live in ~/.config/sc/settings.json (shared with CLI).  We never
// blow it away — read, mutate, write back, with shallow merge per top-level
// key so other tools keep their config.

const SC_SETTINGS_PATH = path.join(require('node:os').homedir(), '.config', 'sc', 'settings.json')

function readScSettings() {
  try {
    return JSON.parse(fs.readFileSync(SC_SETTINGS_PATH, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    console.error('[Settings] read failed', err)
    return {}
  }
}

function readScSettingsStrict() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SC_SETTINGS_PATH, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings root must be a JSON object')
    }
    return parsed
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw new Error(`Unable to read shared settings: ${err?.message || err}`)
  }
}

function writeScSettings(next) {
  let tempPath = null
  try {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error('settings root must be a JSON object')
    }
    fs.mkdirSync(path.dirname(SC_SETTINGS_PATH), { recursive: true })
    tempPath = `${SC_SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`
    let mode = 0o600
    try { mode = fs.statSync(SC_SETTINGS_PATH).mode & 0o777 } catch {}
    fs.writeFileSync(tempPath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode })
    fs.renameSync(tempPath, SC_SETTINGS_PATH)
    return { ok: true }
  } catch (err) {
    if (tempPath) {
      try { fs.unlinkSync(tempPath) } catch {}
    }
    console.error('[Settings] write failed', err)
    return { ok: false, error: String(err) }
  }
}

ipcMain.handle('appSettings:get', () => publicAppSettings(readScSettingsStrict()))
ipcMain.handle('appSettings:patch', (_evt, payload) => {
  const result = patchAppSettings(readScSettingsStrict, writeScSettings, payload)
  if (payload?.section === 'telegram' && typeof payload?.patch?.auto_enabled === 'boolean') {
    setTelegramAutoEnabled(result.auto_enabled)
  }
  return result
})

// The old interactive getUpdates/Instagram bot stays retired. Custom Terminal
// still depends on the bot token for outbound completion alerts, so that
// delivery service remains independent from both polling and the mobile API.
const telegramNotificationService = createTelegramNotificationService({
  readScSettings: readScSettingsStrict,
  db,
  allowTerminalNotifications: !isDev || process.env.SC_TELEGRAM_BOT_DEV === '1',
})

// Почта → Telegram. Использует тот же бот-токен, что и уведомления о вкладках,
// но живёт отдельно: у писем свой источник, свои настройки и своя память о
// доставленном. Читает только те письма, отправители которых заданы явно.
const { createMailNotificationService } = require('./mail/mail-notification-service')
const { createTelegramApi } = require('./telegram-api')
const rawTelegramApi = createTelegramApi()

const mailNotificationService = createMailNotificationService({
  readScSettings: readScSettingsStrict,
  db,
  telegramApi: (method, payload) => {
    const settings = readScSettingsStrict()
    const cfg = settings.telegram_bot || {}
    const token = String(
      process.env.TELEGRAM_BOT_TOKEN
      || cfg.token
      || (settings.api_keys || {}).TELEGRAM_BOT_TOKEN
      || ''
    ).trim()
    return rawTelegramApi(method, payload, token)
  },
  allowDelivery: !isDev || process.env.SC_MAIL_NOTIFY_DEV === '1',
})

let mobileApiServer = null

async function listTelegramSessionsSnapshot() {
  const events = await jobRunner.runTgSessionsCommand(['list'])
  const sessions = events.filter(e => e.type === 'session')
  const settings = readScSettingsStrict()
  const active   = (settings.telegram && settings.telegram.session) || null
  return { sessions, active }
}

function telegramSessionLabel(sess) {
  const who = sess?.me || sess?.me_cached || null
  if (who?.username) return `@${who.username}`
  if (who?.first_name) return who.first_name
  if (who?.phone) return `+${who.phone}`
  return sess?.name || 'Telegram'
}

async function resolveTelegramTargetAllSessions(text, send) {
  const inv = await listTelegramSessionsSnapshot()
  const sessions = (inv.sessions || []).filter(s => s.authorized)
  if (!sessions.length) {
    return { matches: [], error: 'Нет авторизованных Telegram-аккаунтов.' }
  }
  const matches = []
  const errors = []
  for (const sess of sessions) {
    try {
      const res = await jobRunner.runTelegramResolveTitle(text, msg => {
        try { send && send({ ...msg, session: sess.name, session_label: telegramSessionLabel(sess) }) } catch {}
      }, { session: sess.name })
      for (const m of (res.matches || [])) {
        matches.push({
          ...m,
          tg_session: sess.name,
          session_label: telegramSessionLabel(sess),
        })
      }
      if (res.error) errors.push(`${telegramSessionLabel(sess)}: ${res.error}`)
    } catch (err) {
      errors.push(`${telegramSessionLabel(sess)}: ${String(err && err.message || err)}`)
    }
  }
  return { matches, error: matches.length ? null : (errors[0] || null), errors }
}

ipcMain.handle('tg:listSessions', async () => {
  if (isE2E) return { sessions: [], active: null }
  return await listTelegramSessionsSnapshot()
})

ipcMain.handle('tg:setActiveSession', (_evt, name) => {
  const settings = readScSettingsStrict()
  settings.telegram = { ...(settings.telegram || {}), session: name }
  return writeScSettings(settings)
})

ipcMain.handle('tg:loginStart', async (_evt, { phone, name }) => {
  const args = ['login-start', '--phone', phone]
  if (name) args.push('--name', name)
  const events = await jobRunner.runTgSessionsCommand(args)
  // Pick the most informative single event.
  const errEv  = events.find(e => e.type === 'error')
  if (errEv) return { ok: false, error: errEv.message }
  const sent   = events.find(e => e.type === 'code_sent')
  if (sent) return { ok: true, ...sent }
  return { ok: false, error: 'unknown response from python' }
})

ipcMain.handle('tg:loginFinish', async (_evt, { phone, hash, code, password, name }) => {
  const args = ['login-finish', '--phone', phone, '--hash', hash, '--code', code]
  if (password) args.push('--password', password)
  if (name)     args.push('--name', name)
  const events = await jobRunner.runTgSessionsCommand(args)
  const errEv = events.find(e => e.type === 'error')
  if (errEv) return { ok: false, error: errEv.message }
  if (events.find(e => e.type === '2fa_needed')) return { ok: false, twofa: true }
  const done = events.find(e => e.type === 'logged_in')
  if (done) {
    clearTelegramAutoSessionBlock(done.session_name || name || null, 'login_finish')
    return { ok: true, ...done }
  }
  return { ok: false, error: 'unknown response from python' }
})

ipcMain.handle('tg:deleteSession', async (_evt, name) => {
  // Validate the shared file before deleting the session. Otherwise a broken
  // JSON file could make us delete the account and then lose the active-session
  // update as a second, unrelated failure.
  readScSettingsStrict()
  const events = await jobRunner.runTgSessionsCommand(['delete', '--name', name])
  const errEv = events.find(e => e.type === 'error')
  if (errEv) return { ok: false, error: errEv.message }
  // If the deleted session was active, clear that field — otherwise the
  // next fetch would point at a missing file. Re-read after the async worker:
  // settings for another app may have changed while the session was deleting.
  const settings = readScSettingsStrict()
  if (settings.telegram?.session === name) {
    settings.telegram.session = null
    const saved = writeScSettings(settings)
    if (!saved.ok) return saved
  }
  return { ok: true }
})

ipcMain.handle('tg:fetch', (_evt, params) => {
  return jobRunner.startTelegramFetch(params)
})

ipcMain.handle('tg:preview', (_evt, params) => {
  return jobRunner.startTelegramPreview(params)
})

// «Дотянуть комментарии» — runs the comments-pass over an explicit list
// of channel post msg_ids without re-fetching messages.
ipcMain.handle('tg:catchUpComments', (_evt, params) => {
  return jobRunner.startTelegramCommentsCatchUp(params || {})
})

// Lightweight queries used by SourceDetail to render the comments chip
// and decide whether the «Дотянуть комментарии» button should appear.
ipcMain.handle('tg:countComments', async (_evt, sourceId) => {
  if (!sourceId) return 0
  try {
    return await readDb('countCommentsBySource', [Number(sourceId)], () => db.countCommentsBySource(Number(sourceId)))
  } catch { return 0 }
})

ipcMain.handle('tg:postsWithComments', async (_evt, sourceId) => {
  if (!sourceId) return []
  try {
    return await readDb('listPostsWithComments', [Number(sourceId)], () => db.listPostsWithComments(Number(sourceId)))
  } catch { return [] }
})

// ─── Telegram folders ─────────────────────────────────────────────
//
// Folder = pointer into existing telegram sources, never a content store.
// resolveFolder walks DialogFilters via Python and upserts a folder + its
// chats as regular sources (is_explicit=0). All multi-chat fetching goes
// through startTelegramFolderFetch (sequential, session-lock aware).

// Resolve and materialise. Returns { ok, folder, candidates } where
// `folder = { id, title, sources: [...] }` if exactly one match or
// candidates.length>1 (UI shows a picker).
ipcMain.handle('tg:resolveFolder', async (_evt, payload) => {
  const name     = payload && typeof payload.name === 'string' ? payload.name : null
  const filterId = payload && payload.filterId != null ? Number(payload.filterId) : null
  if (!name && filterId == null) {
    return { ok: false, error: 'name or filterId required' }
  }
  try {
    const res = await jobRunner.runTelegramResolveFolder({ name, filterId })
    if (res.error && !res.folder && (!res.candidates || res.candidates.length === 0)) {
      return { ok: false, error: res.error, candidates: [], folder: null }
    }
    if (!res.folder) {
      // Either no match or multiple — let the UI pick. Don't materialise yet.
      return { ok: true, folder: null, candidates: res.candidates || [] }
    }
    const f = res.folder
    // Сессия, через которую резолвили папку — job-runner снял снимок ДО
    // спавна и передал Python'у явный --session; берём тот же снимок (а не
    // перечитываем settings.json — это было бы второе окно гонки при
    // переключении сессии во время резолва).
    const sessNow = res.tg_session
      || (readScSettings().telegram || {}).session || null
    // A Telegram folder can contain thousands of dialogs. Materialise the
    // sources + join in the persistence worker; keep the old path solely as a
    // loud capability-preserving fallback for packaging failures.
    let persisted
    try {
      persisted = await syncTelegramFolder({
        filter_id: f.filter_id,
        title: f.title,
        chats: f.chats || [],
        tg_session: sessNow,
      })
    } catch (workerError) {
      console.error('[FolderResolve] persistence worker failed; falling back to main', workerError)
      const sourceIds = []
      const sources = []
      for (const chat of (f.chats || [])) {
        try {
          const id = db.upsertSource({
            platform: 'telegram', handle: chat.handle,
            display_name: chat.title || null,
            external_id: chat.tg_id != null ? String(chat.tg_id) : null,
            avatar_url: chat.avatar_path || null,
            meta: { kind: chat.kind, username: chat.username || null, via_folder_id: f.filter_id },
            is_explicit: false, tg_session: sessNow,
          })
          sourceIds.push(id)
          sources.push({ id, handle: chat.handle })
        } catch (error) {
          console.error('[FolderResolve] fallback upsertSource failed', chat.handle, error)
        }
      }
      const folderId = db.upsertFolder({ tg_filter_id: f.filter_id, title: f.title, tg_session: sessNow })
      db.setFolderSources(folderId, sourceIds)
      persisted = { folderId, sourceIds, sources, errors: [], fallback: true }
    }
    const sourceIdByHandle = new Map((persisted.sources || []).map(row => [String(row.handle), row.id]))
    const sourcesOut = []
    for (const chat of (f.chats || [])) {
      try {
        const sourceId = sourceIdByHandle.get(String(chat.handle))
        if (sourceId) sourcesOut.push({ id: sourceId, ...chat })
      } catch {
      }
    }
    return {
      ok: true,
      folder: {
        id:           persisted.folderId,
        tg_filter_id: f.filter_id,
        title:        f.title,
        sources:      sourcesOut,
      },
      candidates: res.candidates || [],
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), candidates: [], folder: null }
  }
})

// Refresh button on TelegramScreen header: kick off a real job
// (`tg_folder_refresh`) that streams progress through the Activity panel and
// gets persisted to the jobs table. Renderer reads job state through the
// usual `useJobs()` / `onJobUpdate` channel — no synchronous wait here.
ipcMain.handle('tg:refreshFolders', () => {
  try {
    const id = jobRunner.startTelegramFolderRefresh()
    return { ok: true, jobId: id }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

// Reply-graph backfill for one Telegram source. Resolves the chat target
// from sources.handle, then spawns the lightweight get_messages-based job.
ipcMain.handle('tg:replyBackfill', async (_e, { source_id, limit } = {}) => {
  try {
    if (!source_id) return { ok: false, error: 'source_id required' }
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 5000, 50000))
    const [s, pending] = await Promise.all([
      readDb('getSource', [Number(source_id)], () => db.getSource(Number(source_id))),
      readDb('listItemsMissingParent', [Number(source_id), 1], () => db.listItemsMissingParent(Number(source_id), 1)),
    ])
    if (!s || s.platform !== 'telegram') {
      return { ok: false, error: 'not a telegram source' }
    }
    const target = s.handle
    if (!target) return { ok: false, error: 'source has no handle' }
    const id = jobRunner.startTelegramReplyBackfill({
      source_id: Number(source_id),
      target,
      limit: boundedLimit,
      _known_empty: pending.length === 0,
      _runtime_source: s,
    })
    return { ok: true, jobId: id }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

// session-фильтр: TelegramScreen передаёт имя выбранной сессии — отдаём
// только её папки (+legacy без привязки). Без аргумента — все (back-compat).
ipcMain.handle('folder:list', (_e, tgSession) => (
  readDb('listFolders', [tgSession || null], () => db.listFolders(tgSession || null))
))
// Ручной пин чата к сессии из SourceDetail (бейдж сессии / конфликт).
ipcMain.handle('sources:setSession',  (_e, { id, session }) => {
  if (!id) return { ok: false, error: 'id required' }
  try {
    db.setSourceSession(Number(id), session || null)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})
ipcMain.handle('sources:setTelegramAuto', async (_e, payload = {}) => {
  try {
    return await setTelegramAutoForSources(payload)
  } catch (err) {
    console.error('[TelegramAuto] persistence worker failed; falling back to main', err)
    try {
      return db.setTelegramAutoForSources(payload.source_ids || [], payload.patch || {})
    } catch (fallbackError) {
      return { ok: false, error: String(fallbackError && fallbackError.message || fallbackError) }
    }
  }
})
ipcMain.handle('folder:get', (_e, id) => (
  readDb('getFolder', [Number(id)], () => db.getFolder(Number(id)))
))
ipcMain.handle('folder:listSources', (_e, id) => (
  readDb('listFolderSources', [Number(id)], () => db.listFolderSources(Number(id)))
))
ipcMain.handle('folder:remove',       (_e, id) => { db.deleteFolder(Number(id)); return { ok: true } })
ipcMain.handle('folder:updateParams', (_e, { id, patch }) => {
  if (!id || !patch) return { ok: false, error: 'id and patch required' }
  db.updateFolderParams(Number(id), patch || {})
  return { ok: true }
})

// Sidebar multi-chat «Запросить до конца». Same sequential umbrella as
// folder:fetch, but per-source min_id is read from the DB so each chat
// gets only what's strictly newer than its cached tip. Source-less chats
// (never fetched) fall back to last_n=200.
ipcMain.handle('tg:catchUp', async (_e, params) => {
  if (!params || !Array.isArray(params.source_ids) || params.source_ids.length === 0) {
    return { ok: false, error: 'source_ids required' }
  }
  const contexts = await readDb(
    'telegramRunContexts', [params.source_ids, true],
    () => params.source_ids.map(id => {
      const source = db.getSource(Number(id))
      return source ? { ...source, max_external_id: db.maxExternalId(source.id) || 0 } : null
    }).filter(Boolean),
  )
  const byId = new Map(contexts.map(row => [Number(row.id), row]))
  const groups = new Map()
  for (const sid of params.source_ids) {
    try {
      const s = byId.get(Number(sid))
      if (!s || s.platform !== 'telegram' || !s.handle) continue
      if (s.tg_session_conflict) return { ok: false, error: `Выбери Telegram-аккаунт для «${s.display_name || s.handle}»` }
      if (!s.tg_session) return { ok: false, error: `У «${s.display_name || s.handle}» не выбран Telegram-аккаунт` }
      if (!groups.has(s.tg_session)) groups.set(s.tg_session, { source_ids: [], targets: [], sinces: [] })
      const group = groups.get(s.tg_session)
      group.source_ids.push(Number(sid))
      group.targets.push(s.handle)
      group.sinces.push(Number(s.max_external_id) || 0)
    } catch {}
  }
  if (!groups.size) return { ok: false, error: 'no resolvable telegram sources' }

  try {
    const jobIds = []
    for (const [session, group] of groups.entries()) {
      const id = jobRunner.startTelegramCatchUp({
        source_ids:        group.source_ids,
        targets:           group.targets,
        per_source_since:  group.sinces,
        types:             Array.isArray(params.types) ? params.types : ['text'],
        engine:            params.engine || null,
        tg_session:        session,
      })
      jobIds.push(id)
    }
    return { ok: true, jobId: jobIds[0] || null, jobIds }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

// Sequential folder fetch over a chosen subset of its sources. Returns the
// umbrella job id so the renderer can subscribe via onJobUpdate.
ipcMain.handle('folder:fetch', async (_e, params) => {
  if (!params || !Array.isArray(params.source_ids) || params.source_ids.length === 0) {
    return { ok: false, error: 'source_ids required' }
  }
  // Resolve each source_id → telegram handle the Python side speaks.
  const contexts = await readDb(
    'telegramRunContexts', [params.source_ids, false],
    () => params.source_ids.map(id => db.getSource(Number(id))).filter(Boolean),
  )
  const byId = new Map(contexts.map(row => [Number(row.id), row]))
  const targets = []
  const sourceIds = []
  let tgSession = null
  for (const sid of params.source_ids) {
    try {
      const s = byId.get(Number(sid))
      if (s && s.platform === 'telegram' && s.handle) {
        if (s.tg_session_conflict) return { ok: false, error: `Выбери Telegram-аккаунт для «${s.display_name || s.handle}»` }
        if (!s.tg_session) return { ok: false, error: `У «${s.display_name || s.handle}» не выбран Telegram-аккаунт` }
        if (tgSession && tgSession !== s.tg_session) return { ok: false, error: 'Выбранные чаты относятся к разным Telegram-аккаунтам' }
        tgSession = s.tg_session
        targets.push(s.handle)
        sourceIds.push(Number(s.id))
      }
    } catch {}
  }
  if (!targets.length) return { ok: false, error: 'no resolvable telegram sources' }

  try {
    const id = jobRunner.startTelegramFolderFetch({
      folder_id:  params.folder_id || null,
      source_ids: sourceIds,
      targets,
      mode:       params.mode || 'last_n',
      limit:      params.limit || 0,
      date:       params.date || null,
      date_to:    params.date_to || null,
      tg_session: tgSession || null,
      // Content types + engine — applied to every child tg_fetch. Engine
      // is null when neither voice nor video is picked; tg_fetch_json
      // silently ignores it then.
      types:      Array.isArray(params.types) ? params.types : null,
      engine:     params.engine || null,
    })
    return { ok: true, jobId: id }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

ipcMain.handle('tg:resolveTitle', async (evt, text) => {
  try {
    // Stream progress (every 100 dialogs) back to the calling renderer so a
    // long iter_dialogs() walk doesn't look like a stalled spinner. The
    // sender is the BrowserWindow's webContents — `event.sender` here.
    const send = (msg) => {
      try { evt.sender.send('tg:resolveProgress', { text, ...msg }) } catch {}
    }
    return await resolveTelegramTargetAllSessions(text, send)
  } catch (err) {
    return { matches: [], error: String(err && err.message || err) }
  }
})

ipcMain.handle('tg:searchDialogs', async (_evt, payload) => {
  try {
    const query = typeof payload === 'string' ? payload : payload?.query
    const rawLimit = typeof payload === 'object' ? Number(payload?.limit) : 12
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(30, Math.round(rawLimit))) : 12
    return await jobRunner.runTelegramResolveTitle(query, null, { fuzzy: true, limit })
  } catch (err) {
    return { matches: [], error: String(err && err.message || err) }
  }
})

// ─── Semantic indexing (Telegram for now) ─────────────────────────
//
// Two channels: `tg:index` kicks off a job and returns immediately, status
// updates flow back through `job:update`. `tg:indexStatus` is a one-shot read
// for the IndexButton on mount / before any event fires.
ipcMain.handle('tg:index', async (_evt, { sourceId, limit }) => {
  try {
    const sid = Number(sourceId)
    const t0 = Date.now()
    console.log(`[tg:index] request source #${sid} limit=${limit || 'full'}`)
    // The shared coordinator publishes the preparing job immediately and
    // owns reply preparation BEFORE taking the embedding snapshot.
    const job = indexJob.startTracked({ sourceId, limit: limit || null, origin: 'manual-ipc' })
    console.log(`[tg:index] source #${sid} preparing job=${job.id} total_ms=${Date.now() - t0}`)
    return { ok: true, jobId: job.id, job }
  } catch (err) {
    console.error('[tg:index] failed', err)
    return { ok: false, error: String(err && err.message || err) }
  }
})

ipcMain.handle('tg:indexStatus', async (_evt, sourceId) => {
  try {
    return await indexJob.statusForSource(sourceId)
  } catch (err) {
    console.error('[tg:indexStatus] failed', err)
    return { state: 'idle', done: 0, total: 0, error: String(err) }
  }
})

ipcMain.handle('tg:indexCancel', (_evt, sourceId) => {
  return { ok: indexJob.cancel(sourceId) }
})

// Same per-message RAG ranking as MCP; all corpus reads/ranking run in the
// persistent DB worker. UI retrieves low-score rows for its local slider.
ipcMain.handle('tg:search', async (_evt, { sourceId, query, limit,
                                         min_cos = -1, date_from, date_to, topic_id } = {}) => {
  try {
    if (typeof query !== 'string' || !query.trim()) return { results: [] }
    const scope = normalizeRagScope({ source_id: sourceId, limit: limit || 10,
      min_cos, date_from, date_to, topic_id })
    const q = await embedQuery(query)
    const params = { ...scope, query_embedding: q }
    const result = await readDb('telegramRagSearch', [params], () => searchTelegramRag(db, params))
    return { results: result.rows, diagnostics: result.diagnostics,
      coverage: result.coverage, scope: result.scope }
  } catch (err) {
    console.error('[tg:search] failed', err)
    return { results: [], error: String(err && err.message || err) }
  }
})

// ─── Instagram settings ───────────────────────────────────────────
//
// Backend selector + Apify token + session inventory. Same single-source
// settings.json contract as Telegram. Apify token has a legacy file
// fallback (~/.config/sc/apify_token plaintext) that the CLI still reads
// — when the user sets a new token via the UI we wipe the legacy file so
// it can't shadow the new value.

const APIFY_LEGACY_PATH = path.join(require('node:os').homedir(), '.config', 'sc', 'apify_token')

// Two independent backend selectors.  ig.metadata_backend governs the
// profile-fetch path (api: cookies-free clips/user/, apify: reel-scraper
// actor). ig.transcribe_backend governs the per-reel transcribe path
// (api: video_url from clips/user/, apify: apple_yang audioUrl).  No
// auto-fallback — failures surface to the UI so the user picks.
//
// Legacy `ig.backend` (pre-split) is treated as the metadata backend when
// found, with `android` mapped to `api` (we no longer need any cookies for
// public profiles).
function _readIgBackends(ig) {
  const legacy = ig.backend
  const legacyMapped = legacy === 'apify' ? 'apify' : (legacy ? 'api' : null)
  return {
    metadata_backend:   ig.metadata_backend === 'apify' ? 'apify' : (ig.metadata_backend ? 'api' : (legacyMapped || 'api')),
    transcribe_backend: ig.transcribe_backend === 'apify' ? 'apify' : 'api',
  }
}

function _checkApifyToken(token) {
  const clean = String(token || '').trim()
  if (!clean) {
    return Promise.resolve({ status: 'missing', ok: false, message: 'token not set' })
  }
  return new Promise(resolve => {
    const https = require('node:https')
    const url = `https://api.apify.com/v2/users/me?token=${encodeURIComponent(clean)}`
    const req = https.get(url, { timeout: 12000 }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({
            status: 'invalid',
            ok: false,
            http_status: res.statusCode,
            message: `HTTP ${res.statusCode}: ${body.slice(0, 160)}`,
          })
          return
        }
        try {
          const data = JSON.parse(body)
          const user = data && data.data || {}
          resolve({
            status: 'valid',
            ok: true,
            http_status: res.statusCode,
            username: user.username || user.id || null,
            message: 'token accepted',
          })
        } catch (err) {
          resolve({ status: 'invalid', ok: false, http_status: res.statusCode, message: `invalid JSON: ${err.message}` })
        }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: 'error', ok: false, message: 'timeout' }) })
    req.on('error', err => resolve({ status: 'error', ok: false, message: err.message }))
  })
}

let apifyTokenCheckCache = { token: null, result: null, expiresAt: 0, promise: null }
function _checkApifyTokenCached(token, { force = false } = {}) {
  const clean = String(token || '').trim()
  if (isE2E) {
    return Promise.resolve({ status: clean ? 'unchecked' : 'missing', ok: clean ? null : false, message: 'validation disabled in E2E' })
  }
  const now = Date.now()
  if (!force && apifyTokenCheckCache.token === clean) {
    if (apifyTokenCheckCache.promise) return apifyTokenCheckCache.promise
    if (apifyTokenCheckCache.result && apifyTokenCheckCache.expiresAt > now) {
      return Promise.resolve(apifyTokenCheckCache.result)
    }
  }
  const promise = _checkApifyToken(clean).then(result => {
    if (apifyTokenCheckCache.token === clean) {
      apifyTokenCheckCache.result = result
      apifyTokenCheckCache.expiresAt = Date.now() + 5 * 60_000
      apifyTokenCheckCache.promise = null
    }
    return result
  }, error => {
    if (apifyTokenCheckCache.token === clean) apifyTokenCheckCache.promise = null
    throw error
  })
  apifyTokenCheckCache = { token: clean, result: null, expiresAt: 0, promise }
  return promise
}

ipcMain.handle('ig:getSettings', async (_event, options = {}) => {
  const s = readScSettingsStrict()
  const ig = s.instagram || {}
  let legacyToken = null
  try {
    if (fs.existsSync(APIFY_LEGACY_PATH)) {
      legacyToken = (fs.readFileSync(APIFY_LEGACY_PATH, 'utf8') || '').trim() || null
    }
  } catch {}
  const backends = _readIgBackends(ig)
  const token = ig.apify_token || legacyToken || null
  const apifyTokenCheck = options.validateToken === true
    ? await _checkApifyTokenCached(token, { force: options.force === true })
    : {
        status: token ? 'unchecked' : 'missing',
        ok: token ? null : false,
        message: token ? 'validation not requested' : 'token not set',
      }
  return {
    metadata_backend:   backends.metadata_backend,
    transcribe_backend: backends.transcribe_backend,
    apify_token_set:    !!token,
    apify_token_legacy: !ig.apify_token && !!legacyToken,
    apify_token_check:  apifyTokenCheck,
  }
})

// payload: { which: 'metadata'|'transcribe', backend: 'api'|'apify' }
ipcMain.handle('ig:setBackend', (_evt, payload) => {
  const { which, backend } = payload || {}
  if (!['metadata', 'transcribe'].includes(which)) {
    return { ok: false, error: `unknown selector: ${which}` }
  }
  if (!['api', 'apify'].includes(backend)) {
    return { ok: false, error: `unknown backend: ${backend}` }
  }
  const settings = readScSettingsStrict()
  const currentIg = settings.instagram || {}
  const resolved = _readIgBackends(currentIg)
  const ig = {
    ...currentIg,
    metadata_backend: resolved.metadata_backend,
    transcribe_backend: resolved.transcribe_backend,
  }
  ig[`${which}_backend`] = backend
  // Drop the legacy `ig.backend` key once we've split — keeps settings.json tidy.
  delete ig.backend
  settings.instagram = ig
  return writeScSettings(settings)
})

ipcMain.handle('ig:setApifyToken', (_evt, token) => {
  const clean = (token || '').trim() || null
  const settings = readScSettingsStrict()
  settings.instagram = { ...(settings.instagram || {}), apify_token: clean }
  const r = writeScSettings(settings)
  if (!r.ok) return r
  apifyTokenCheckCache = { token: null, result: null, expiresAt: 0, promise: null }
  // Wipe the legacy plaintext file so the CLI helper can't pick up an old
  // value that contradicts what the UI just wrote.
  try {
    if (fs.existsSync(APIFY_LEGACY_PATH)) fs.unlinkSync(APIFY_LEGACY_PATH)
  } catch (err) {
    console.error('[Settings] legacy apify_token unlink failed', err)
  }
  return { ok: true }
})

ipcMain.handle('ig:listSessions', async () => {
  const events = await jobRunner.runIgSessionsCommand(['list', '--check'])
  return { sessions: events.filter(e => e.type === 'session') }
})

ipcMain.handle('ig:login', async () => {
  try {
    const events = await jobRunner.runIgLogin()
    const error = events.find(e => e.type === 'error')
    const loggedIn = events.find(e => e.type === 'logged_in')
    return error
      ? { ok: false, error: error.message || error.code || 'Instagram login failed', events }
      : { ok: !!loggedIn, account: loggedIn?.username || null, events }
  } catch (err) {
    console.error('[InstagramLogin] IPC failed', err)
    return { ok: false, error: String(err?.message || err), events: [] }
  }
})

ipcMain.handle('ig:deleteSession', async (_evt, kind) => {
  const events = await jobRunner.runIgSessionsCommand(['delete', '--kind', kind])
  const errEv = events.find(e => e.type === 'error')
  if (errEv) return { ok: false, error: errEv.message }
  return { ok: true }
})

ipcMain.handle('ig:profileFetch', (_evt, params) => {
  return jobRunner.startInstagramProfileFetch(params)
})

// Free «Обзор профиля» — single HTTP request to instagram.com's
// web_profile_info endpoint, no cookies needed (same path that
// IGAPIClient._get_user_id_from_web uses on the Python side, just
// duplicated to Node so the UI can call it without spawning Python).
// Returns either { ok: true, profile: {...} } or { ok: false, error }.
ipcMain.handle('ig:overview', async (_evt, payload) => {
  const handle = String((payload && payload.handle) || '').replace(/^@/, '').trim()
  if (!handle) return { ok: false, error: 'empty handle' }
  const https = require('node:https')
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`
  return await new Promise(resolve => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'X-IG-App-ID': '936619743392459',
        'Accept': 'application/json',
      },
      timeout: 10000,
    }, res => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ ok: false, error: `HTTP ${res.statusCode}` })
          return
        }
        try {
          const data = JSON.parse(buf)
          const u = data?.data?.user
          if (!u) {
            resolve({ ok: false, error: 'no user in response' })
            return
          }
          resolve({
            ok: true,
            profile: {
              pk:                 u.id || null,
              username:           u.username || handle,
              full_name:          u.full_name || null,
              biography:          u.biography || null,
              follower_count:     u.edge_followed_by?.count ?? null,
              following_count:    u.edge_follow?.count ?? null,
              media_count:        u.edge_owner_to_timeline_media?.count ?? null,
              is_private:         !!u.is_private,
              is_verified:        !!u.is_verified,
              external_url:       u.external_url || null,
              profile_pic_url:    u.profile_pic_url_hd || u.profile_pic_url || null,
            },
          })
        } catch (err) {
          resolve({ ok: false, error: 'parse failed: ' + err.message })
        }
      })
    })
    req.on('error', err => resolve({ ok: false, error: err.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
  })
})

// Cache-hit shortcut for InstagramConfigForm: if the user has already
// fetched this profile, we render the inline picker immediately instead
// of waiting for a fresh job. Mirrors yt:channelLookup. Returns the
// source row enriched with items_count, or null.
ipcMain.handle('ig:lookupProfile', (_evt, payload) => {
  const handle = String((payload && payload.handle) || '').replace(/^@/, '').trim()
  if (!handle) return null
  try {
    const dbCon = db.getDb()
    return dbCon.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS items_count
         FROM sources s
        WHERE s.platform = 'instagram' AND s.handle = ?`,
    ).get(handle) || null
  } catch (err) {
    console.error('[IG] lookupProfile failed', err)
    return null
  }
})

ipcMain.handle('ig:lookupReel', (_evt, payload) => {
  const raw = String(payload?.shortcode || payload?.url || '').trim()
  const m = raw.match(/(?:^|\/)(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i)
  const shortcode = (m ? m[1] : raw).replace(/[^A-Za-z0-9_-]/g, '')
  if (!shortcode) return null
  try {
    const dbCon = db.getDb()
    const itemHit = dbCon.prepare(
      `SELECT
          i.id AS item_id,
          i.source_id,
          i.external_id,
          i.url,
          i.caption,
          i.title,
          i.duration_seconds,
          i.transcript_path,
          s.handle AS source_handle,
          s.display_name AS source_display_name,
          s.external_id AS source_external_id
         FROM items i
         JOIN sources s ON s.id = i.source_id
        WHERE s.platform = 'instagram'
          AND i.external_id = ?
        ORDER BY i.id DESC
        LIMIT 1`,
    ).get(`reel:${shortcode}`) || null
    if (itemHit) return itemHit

    // Sourceless single-reel Apify jobs do not create an items row.
    // Recover their cache state from the jobs table so re-pasting the same
    // URL shows "already transcribed" instead of offering another paid run.
    const rows = dbCon.prepare(
      `SELECT id, file_path, parameters_json, cost_usd, started_at, finished_at
         FROM jobs
        WHERE type = 'ig_batch_transcribe'
          AND status = 'done'
          AND file_path IS NOT NULL
        ORDER BY started_at DESC
        LIMIT 300`,
    ).all()
    for (const row of rows) {
      let params = null
      try { params = row.parameters_json ? JSON.parse(row.parameters_json) : null } catch {}
      const codes = Array.isArray(params?.shortcodes) ? params.shortcodes : []
      if (!codes.includes(shortcode)) continue
      const idx = codes.indexOf(shortcode)
      const captions = Array.isArray(params?.captions) ? params.captions : []
      return {
        item_id: null,
        source_id: null,
        external_id: `reel:${shortcode}`,
        url: params?.target || `https://www.instagram.com/reel/${shortcode}/`,
        caption: captions[idx] || '',
        title: null,
        duration_seconds: null,
        transcript_path: row.file_path,
        source_handle: null,
        source_display_name: null,
        source_external_id: null,
        job_id: row.id,
        cost_usd: row.cost_usd || 0,
        finished_at: row.finished_at || null,
      }
    }
    return null
  } catch (err) {
    console.error('[IG] lookupReel failed', err)
    return null
  }
})

ipcMain.handle('ig:batchTranscribe', (_evt, params) => {
  // Pick the configured backend; the renderer doesn't need to know about
  // the api/apify split at the picker level. Same source of truth as
  // settings UI: ig.transcribe_backend in ~/.config/sc/settings.json.
  const ig = readScSettings().instagram || {}
  const backends = _readIgBackends(ig)
  const backend = (params && params.backend) || backends.transcribe_backend || 'api'

  // Known sources pass their profile id and use anonymous clips/user/.
  // Bare links intentionally keep user_id empty so Python resolves the
  // shortcode through the saved authenticated Android API session.
  let user_id = params?.user_id || null
  if (backend === 'api' && !user_id && params?.source_id) {
    try {
      const src = db.getSource(params.source_id)
      if (src && /^\d+$/.test(String(src.external_id || ''))) user_id = String(src.external_id)
    } catch (err) {
      console.error('[IG] resolve user_id failed', err)
    }
  }

  return jobRunner.startInstagramBatchTranscribe({
    ...params,
    backend,
    user_id,
  })
})

// Build a combined Instagram transcript blob — same shape as the YouTube
// assembler, but reads items by `reel:<code>` external_id and looks them
// up in transcripts/instagram/. Two calling shapes match the YT version:
//   { jobId, action }                                  — for batch jobs
//   { source_id, shortcodes[], action }                — for ad-hoc selection
ipcMain.handle('ig:assembleBatchTranscript', async (_evt, payload) => {
  const action = payload?.action
  let row = null
  let sourceId = null
  let externalIds = []
  let originStartedAt = null

  if (payload?.source_id && Array.isArray(payload.shortcodes) && payload.shortcodes.length) {
    sourceId = payload.source_id
    externalIds = payload.shortcodes.map(s => `reel:${s}`)
    originStartedAt = Math.floor(Date.now() / 1000)
  } else if (payload?.jobId != null) {
    const jobId = payload.jobId
    if (typeof jobId === 'string' && jobId.startsWith('db-')) {
      const id = Number(jobId.slice(3))
      if (!Number.isFinite(id)) return { ok: false, error: 'bad job id' }
      row = db.getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    } else {
      const snap = jobRunner.getJobDetail(jobId)
      if (!snap) return { ok: false, error: 'job not found' }
      if (snap.type !== 'ig_batch_transcribe') return { ok: false, error: 'not an IG batch job' }
      row = {
        id: snap.id,
        type: snap.type,
        source_id: snap.source_id,
        parameters_json: JSON.stringify(snap.params || {}),
        yt_batch: snap.yt_batch,
        started_at: snap.started_at,
      }
    }
    if (!row) return { ok: false, error: 'job not found' }
    let params = {}
    try { params = JSON.parse(row.parameters_json || '{}') } catch {}
    sourceId = row.source_id || params.source_id
    externalIds = (Array.isArray(params.shortcodes) ? params.shortcodes : []).map(s => `reel:${s}`)
    originStartedAt = row.started_at
  } else {
    return { ok: false, error: 'either jobId or {source_id, shortcodes} required' }
  }

  let workerOutputPath = null
  if (action === 'save') {
    const dt = new Date((originStartedAt || Math.floor(Date.now() / 1000)) * 1000)
    const date = dt.toISOString().slice(0, 10)
    const tag = row?.id != null ? `job${row.id}` : `picker${externalIds.length}`
    workerOutputPath = path.join(jobRunner.JOBS_DIR, `${date}_ig_batch_${tag}_combined.txt`)
  }
  try {
    const result = await dbRead.request('selectedTranscriptsAssembly', {
      sourceId,
      externalIds,
      action,
      outputPath: workerOutputPath,
    })
    if (result?.ok && action === 'copy') {
      clipboard.writeText(result.content || '')
      const { content: _content, ...publicResult } = result
      return publicResult
    }
    return result
  } catch (workerError) {
    console.error('[InstagramAssembly] worker failed; falling back to main', workerError)
  }

  let entries = []
  if (sourceId && externalIds.length) {
    const items = db.getItemsByExternalIds(sourceId, externalIds)
    const byId = new Map(items.map(it => [it.external_id, it]))
    for (const eid of externalIds) {
      const it = byId.get(eid)
      if (it && it.transcript_path && fs.existsSync(it.transcript_path)) {
        entries.push({
          external_id:     eid,
          title:           it.title,
          url:             it.url,
          transcript_path: it.transcript_path,
        })
      }
    }
  }

  if (entries.length === 0) {
    return { ok: false, error: 'no transcripts found' }
  }

  const SEP = '\n\n' + '='.repeat(72) + '\n\n'
  const chunks = []
  for (const e of entries) {
    try { chunks.push(fs.readFileSync(e.transcript_path, 'utf8')) } catch {}
  }
  const combined = chunks.join(SEP)

  if (action === 'copy') {
    clipboard.writeText(combined)
    return { ok: true, bytes: combined.length, count: entries.length }
  }

  if (action === 'save') {
    const dt = new Date((originStartedAt || Math.floor(Date.now() / 1000)) * 1000)
    const date = dt.toISOString().slice(0, 10)
    const tag = row?.id != null ? `job${row.id}` : `picker${entries.length}`
    const fname = `${date}_ig_batch_${tag}_combined.txt`
    const fpath = path.join(jobRunner.JOBS_DIR, fname)
    try {
      fs.writeFileSync(fpath, combined, 'utf8')
      return { ok: true, bytes: combined.length, count: entries.length, file_path: fpath }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  return { ok: true, bytes: combined.length, count: entries.length, content: combined }
})

// ─── YouTube single-video ────────────────────────────────────────
async function readTextFileOffMain(filePath) {
  if (!filePath) return { text: '', parts: 0, bytes: 0 }
  return readDb('readTextFiles', [[filePath], { trim: false, separator: '' }], async () => {
    try {
      const text = await fs.promises.readFile(filePath, 'utf8')
      return { text, parts: 1, bytes: Buffer.byteLength(text, 'utf8') }
    } catch {
      return { text: '', parts: 0, bytes: 0 }
    }
  })
}

ipcMain.handle('yt:lookupCache', (_evt, videoId) => {
  const row = jobRunner.lookupYoutubeCache(videoId)
  if (!row) return null
  return {
    id:           row.id,
    file_path:    row.file_path,
    finished_at:  row.finished_at,
    cost_usd:     row.cost_usd || 0,
    parameters:   row.parameters_json ? JSON.parse(row.parameters_json) : null,
  }
})
ipcMain.handle('yt:copyCachedFile', async (_evt, filePath) => {
  try {
    const result = await readTextFileOffMain(filePath)
    if (!result.parts) return { ok: false, error: 'File not found' }
    clipboard.writeText(result.text)
    jobRunner.playClipboardSound()
    return { ok: true, bytes: result.bytes }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})
ipcMain.handle('yt:copyWithTimestamps', async (_evt, payload = {}) => {
  const result = await jobRunner.createYoutubeTimedTranscript({
    url: payload.url,
    lang: payload.lang,
    sourceFilePath: payload.sourceFilePath,
  })
  if (!result?.ok) return result || { ok: false, error: 'Не удалось получить таймкоды' }
  try {
    const file = await readTextFileOffMain(result.file_path)
    if (!file.parts) return { ok: false, error: 'File not found' }
    clipboard.writeText(file.text)
    jobRunner.playClipboardSound()
    const opened = payload.openInSublime === false
      ? { ok: true, opener: null }
      : openLocalFile(result.file_path)
    if (!opened.ok) return { ...opened, copied: true, file_path: result.file_path }
    console.log(`[YouTube] timed transcript copied video=${String(payload.url || '').slice(-11)} cached=${result.cached ? 1 : 0} open=${opened.opener || 'no'}`)
    return {
      ok: true,
      bytes: file.bytes,
      chars: file.text.length,
      file_path: result.file_path,
      cached: !!result.cached,
      opener: opened.opener || null,
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
})
ipcMain.handle('yt:single',     (_evt, params) => jobRunner.startYoutubeSingle(params))
ipcMain.handle('yt:resumeAi',   (_evt, { jobId, engine }) => jobRunner.resumeYoutubeAi(jobId, { engine }))

// ─── Rutube single-video ─────────────────────────────────────────
ipcMain.handle('rutube:lookupCache', (_evt, videoId) => {
  const row = jobRunner.lookupRutubeCache(videoId)
  if (!row) return null
  return {
    id:           row.id,
    file_path:    row.file_path,
    finished_at:  row.finished_at,
    cost_usd:     row.cost_usd || 0,
    parameters:   row.parameters_json ? JSON.parse(row.parameters_json) : null,
  }
})
ipcMain.handle('rutube:copyCachedFile', async (_evt, filePath) => {
  try {
    const result = await readTextFileOffMain(filePath)
    if (!result.parts) return { ok: false, error: 'File not found' }
    clipboard.writeText(result.text)
    jobRunner.playClipboardSound()
    return { ok: true, bytes: result.bytes }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})
ipcMain.handle('rutube:single',   (_evt, params) => jobRunner.startRutubeSingle(params || {}))
ipcMain.handle('rutube:resumeAi', (_evt, { jobId, engine }) => jobRunner.resumeRutubeAi(jobId, { engine }))

// ─── YouTube comments ───────────────────────────────────────────
// Cache key is the exact (video_id, sort, limit, includeReplies) tuple —
// changing any of those four parameters means a fresh fetch and a fresh file.
ipcMain.handle('yt:lookupCommentsCache', (_evt, payload) => {
  const row = jobRunner.lookupYoutubeCommentsCache(payload || {})
  if (!row) return null
  return {
    id:           row.id,
    file_path:    row.file_path,
    finished_at:  row.finished_at,
    parameters:   row.parameters_json ? JSON.parse(row.parameters_json) : null,
  }
})
ipcMain.handle('yt:comments', (_evt, params) => jobRunner.startYoutubeComments(params || {}))
ipcMain.handle('yt:batchComments', (_evt, params) => jobRunner.startYoutubeBatchComments(params || {}))

// ─── YouTube channel + batch ──────────────────────────────────────
ipcMain.handle('yt:channelLookup', (_evt, payload) => jobRunner.lookupYoutubeChannel(payload || {}))
ipcMain.handle('yt:channelFetch',  (_evt, params)  => jobRunner.startYoutubeChannelFetch(params))
ipcMain.handle('yt:batchTranscribe', (_evt, params) => jobRunner.startYoutubeBatchTranscribe(params))

ipcMain.handle('yt:index', async (_evt, { sourceId, limit } = {}) => {
  try {
    const sid = Number(sourceId)
    const source = await readDb('getSource', [sid], () => db.getSource(sid))
    if (!source || source.platform !== 'youtube') return { ok: false, error: 'YouTube source not found' }
    console.log(`[yt:index] request source #${sid} limit=${limit || 'full'}`)
    const result = await indexJob.start({
      sourceId: sid,
      limit: limit || null,
      origin: 'manual-ipc',
      mode: 'youtube',
    })
    if (result && typeof result === 'object' && result.noop) {
      return { ok: true, noop: true, reason: result.reason }
    }
    return { ok: true, jobId: result }
  } catch (err) {
    console.error('[yt:index] failed', err)
    return { ok: false, error: String(err?.message || err) }
  }
})

ipcMain.handle('yt:indexStatus', async (_evt, sourceId) => {
  try {
    return await indexJob.statusForSource(sourceId, 'youtube')
  } catch (err) {
    console.error('[yt:indexStatus] failed', err)
    return { state: 'idle', done: 0, total: 0, error: String(err?.message || err) }
  }
})

ipcMain.handle('yt:indexCancel', (_evt, sourceId) => ({
  ok: indexJob.cancel(sourceId, 'youtube'),
}))

ipcMain.handle('yt:semanticSearch', async (_evt, { sourceId, query, limit } = {}) => {
  try {
    if (!String(query || '').trim()) return { results: [] }
    const sid = Number(sourceId)
    const queryEmbedding = await embedQuery(String(query).trim())
    const rows = await readDb(
      'semanticChunkSearch',
      [{ query_embedding: queryEmbedding, source_id: sid, limit: limit || 20 }],
      () => db.semanticChunkSearch({ query_embedding: queryEmbedding, source_id: sid, limit: limit || 20 }),
    )
    return {
      results: rows.map(row => ({
        ...row,
        id: `yt-chunk-${row.id}`,
        item_id: row.item_id,
        type: 'video',
        caption: row.text,
        semantic_chunk: {
          chunk_id: row.id,
          chunk_index: row.chunk_index,
          start_seconds: row.start_seconds,
          end_seconds: row.end_seconds,
          position_approximate: !!row.position_approximate,
        },
      })),
    }
  } catch (err) {
    console.error('[yt:semanticSearch] failed', err)
    return { results: [], error: String(err?.message || err) }
  }
})

ipcMain.handle('yt:semanticContext', async (_evt, payload = {}) => {
  try {
    const rows = await readDb('semanticChunkContext', [payload], () => db.semanticChunkContext(payload))
    return { results: rows }
  } catch (err) {
    console.error('[yt:semanticContext] failed', err)
    return { results: [], error: String(err?.message || err) }
  }
})

// ─── TikTok ───────────────────────────────────────────────────────
ipcMain.handle('tk:lookupCache', (_evt, videoId) => {
  const row = jobRunner.lookupTiktokCache(videoId)
  if (!row) return null
  return {
    id:           row.id,
    file_path:    row.file_path,
    finished_at:  row.finished_at,
    cost_usd:     row.cost_usd || 0,
    parameters:   row.parameters_json ? JSON.parse(row.parameters_json) : null,
  }
})
ipcMain.handle('tk:copyCachedFile', async (_evt, filePath) => {
  try {
    const result = await readTextFileOffMain(filePath)
    if (!result.parts) return { ok: false, error: 'File not found' }
    clipboard.writeText(result.text)
    jobRunner.playClipboardSound()
    return { ok: true, bytes: result.bytes }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})
ipcMain.handle('tk:single',         (_evt, params)  => jobRunner.startTiktokSingle(params))
ipcMain.handle('tk:channelLookup',  (_evt, payload) => jobRunner.lookupTiktokChannel(payload || {}))
ipcMain.handle('tk:channelFetch',   (_evt, params)  => jobRunner.startTiktokChannelFetch(params))
ipcMain.handle('tk:batchTranscribe',(_evt, params)  => jobRunner.startTiktokBatchTranscribe(params))

// Reddit: thread fetch (full URL → post + comment tree) + search (keyword → posts list).
ipcMain.handle('rd:threadFetch', (_evt, params) => jobRunner.startRedditThreadFetch(params))
ipcMain.handle('rd:search',      (_evt, params) => jobRunner.startRedditSearch(params))

// Boosty single-video: request the user's live Boosty auth from the browser
// extension, then pass it only to the spawned worker environment. The cookie
// never enters renderer state, job snapshots, application logs, or SQLite.
ipcMain.handle('boosty:channelLookup', (_evt, payload = {}) => (
  jobRunner.lookupBoostyChannel(payload)
))
ipcMain.handle('boosty:channelFetch', async (_evt, params = {}) => {
  if (params.auth_mode === 'public') return jobRunner.startBoostyChannelFetch(params)
  const { requestBoostyAuthCookie } = require('./browser-bridge')
  const auth = await requestBoostyAuthCookie()
  return jobRunner.startBoostyChannelFetch({
    ...params,
    authCookie: auth.value,
    authExpiration: auth.expirationDate,
  })
})
ipcMain.handle('boosty:postPreview', async (_evt, params = {}) => {
  const { requestBoostyAuthCookie } = require('./browser-bridge')
  const auth = await requestBoostyAuthCookie()
  return jobRunner.previewBoostyPost({
    url: params.url,
    authCookie: auth.value,
    authExpiration: auth.expirationDate,
  })
})
ipcMain.handle('boosty:batchTranscribe', async (_evt, params = {}) => {
  const { requestBoostyAuthCookie } = require('./browser-bridge')
  const auth = await requestBoostyAuthCookie()
  return jobRunner.startBoostyBatchTranscribe({
    ...params,
    authCookie: auth.value,
    authExpiration: auth.expirationDate,
  })
})
ipcMain.handle('boosty:single', async (_evt, params = {}) => {
  const { requestBoostyAuthCookie } = require('./browser-bridge')
  const auth = await requestBoostyAuthCookie()
  return jobRunner.startBoostySingle({
    url: params.url,
    authCookie: auth.value,
    authExpiration: auth.expirationDate,
  })
})

function resolveLibraryPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(jobRunner.LIB_ROOT, filePath)
  const relative = path.relative(jobRunner.LIB_ROOT, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return absolute
}

function resolveAllowedPath(filePath, allowedRoots = [jobRunner.LIB_ROOT]) {
  if (!filePath || typeof filePath !== 'string') return null
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(jobRunner.LIB_ROOT, filePath)
  for (const rawRoot of allowedRoots) {
    if (!rawRoot) continue
    const root = path.resolve(rawRoot)
    const relative = path.relative(root, absolute)
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) return absolute
  }
  return null
}

function localFileInfo(filePath, allowedRoots = [jobRunner.LIB_ROOT]) {
  const absolute = resolveAllowedPath(filePath, allowedRoots)
  if (!absolute) return { present: false, bytes: 0, path: null }
  try {
    const stat = fs.statSync(absolute)
    return { present: stat.isFile(), bytes: stat.isFile() ? stat.size : 0, path: absolute }
  } catch {
    return { present: false, bytes: 0, path: absolute }
  }
}

function parseJsonObject(value) {
  try {
    const parsed = value ? JSON.parse(value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function publicBoostyRow(row) {
  const storageConfig = jobRunner.getBoostyStorageConfig()
  const media = localFileInfo(row.media_path, [jobRunner.LIB_ROOT, storageConfig.audio_dir])
  const video = localFileInfo(row.video_path, [jobRunner.LIB_ROOT, storageConfig.video_dir])
  const transcript = localFileInfo(row.transcript_path)
  const srt = localFileInfo(row.transcript_path
    ? String(row.transcript_path).replace(/\.txt$/i, '.srt')
    : null)
  const thumbnail = localFileInfo(row.thumbnail_path)
  return {
    id: row.id,
    source_id: row.source_id,
    external_id: String(row.external_id),
    type: row.type,
    url: row.url,
    title: row.title,
    caption: row.caption,
    published_at: row.published_at,
    duration_seconds: row.duration_seconds,
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    parent_external_id: row.parent_external_id,
    depth: row.depth,
    thumbnail_path: row.thumbnail_path,
    thumbnail_present: thumbnail.present,
    media_path: media.present ? media.path : null,
    media_present: media.present,
    media_bytes: media.bytes,
    video_path: video.present ? video.path : null,
    video_present: video.present,
    video_bytes: video.bytes,
    transcript_path: transcript.present ? transcript.path : null,
    transcript_present: transcript.present,
    transcript_bytes: transcript.bytes,
    srt_path: srt.present ? srt.path : null,
    srt_present: srt.present,
    download_status: media.present ? 'done' : (row.media_path ? 'missing' : row.download_status),
    download_error: row.download_error,
    transcribe_status: transcript.present ? 'done' : (row.transcript_path ? 'missing' : row.transcribe_status),
    transcribe_error: row.transcribe_error,
    transcribe_engine: row.transcribe_engine,
    meta: parseJsonObject(row.raw_meta_json),
  }
}

ipcMain.handle('boosty:posts', async (_evt, payload = {}) => {
  const sourceId = Number(payload.source_id)
  try {
    return await dbRead.request('boostyPosts', sourceId, jobRunner.getBoostyStorageConfig())
  } catch (workerError) {
    console.error('[Boosty] posts worker failed; falling back to main', workerError)
  }
  const source = db.getSource(sourceId)
  if (!source || source.platform !== 'boosty') return { ok: false, error: 'Источник Boosty не найден' }
  const publicRows = db.listBoostyItems(sourceId).map(publicBoostyRow)
  const parents = publicRows.filter(row => row.type === 'boosty_post')
  const childrenByParent = new Map()
  for (const row of publicRows) {
    if (row.type !== 'boosty_video' || !row.parent_external_id) continue
    const key = String(row.parent_external_id)
    if (!childrenByParent.has(key)) childrenByParent.set(key, [])
    childrenByParent.get(key).push(row)
  }
  const posts = parents.map(parent => {
    const videos = (childrenByParent.get(parent.external_id) || []).sort((a, b) => (
      Number(a.meta.position || 0) - Number(b.meta.position || 0)
    ))
    return {
      ...parent,
      videos,
      video_count: Math.max(Number(parent.meta.video_count || 0), videos.length),
      known_videos_count: videos.length,
      duration_seconds: videos.reduce((sum, video) => sum + Number(video.duration_seconds || 0), 0),
      media_bytes: videos.reduce((sum, video) => sum + Number(video.media_bytes || 0), 0),
      video_bytes: videos.reduce((sum, video) => sum + Number(video.video_bytes || 0), 0),
      media_present_count: videos.filter(video => video.media_present).length,
      video_present_count: videos.filter(video => video.video_present).length,
      transcribed_count: videos.filter(video => video.transcript_present).length,
    }
  })
  const videos = publicRows.filter(row => row.type === 'boosty_video')
  return {
    ok: true,
    source,
    meta: parseJsonObject(source.meta_json),
    posts,
    stats: {
      posts: posts.length,
      videos: videos.length,
      transcribed: videos.filter(video => video.transcript_present).length,
      audio_files: videos.filter(video => video.media_present).length,
      audio_bytes: videos.reduce((sum, video) => sum + Number(video.media_bytes || 0), 0),
      video_files: videos.filter(video => video.video_present).length,
      video_bytes: videos.reduce((sum, video) => sum + Number(video.video_bytes || 0), 0),
      locked_posts: posts.filter(post => post.meta.access_state === 'locked').length,
      lost_posts: posts.filter(post => post.meta.access_state === 'lost').length,
    },
  }
})

function deleteBoostyAudioForSource(sourceId, requested = null) {
  const rows = db.listBoostyVideos(sourceId, requested)
  let removedBytes = 0
  let removedFiles = 0
  const clearedIds = []
  const errors = []
  const storageConfig = jobRunner.getBoostyStorageConfig()
  for (const row of rows) {
    if (!row.media_path) continue
    const info = localFileInfo(row.media_path, [jobRunner.LIB_ROOT, storageConfig.audio_dir])
    if (!info.path) {
      errors.push({ video_id: String(row.external_id), message: 'Путь аудио находится вне библиотеки' })
      continue
    }
    try {
      if (info.present) {
        fs.unlinkSync(info.path)
        removedBytes += info.bytes
        removedFiles += 1
      }
      clearedIds.push(String(row.external_id))
    } catch (err) {
      errors.push({ video_id: String(row.external_id), message: String(err?.message || err) })
    }
  }
  if (clearedIds.length) db.clearItemMediaPaths(sourceId, clearedIds, 'evicted')
  return {
    ok: errors.length === 0,
    removed: clearedIds.length,
    removed_files: removedFiles,
    bytes: removedBytes,
    errors,
  }
}

function boostySourceIds() {
  return db.getDb().prepare(`SELECT id FROM sources WHERE platform='boosty' ORDER BY id`).all()
}

function boostyPlatformStorageSnapshot() {
  const sources = boostySourceIds()
  const mediaPaths = []
  const transcriptPaths = []
  const videoPaths = []
  const thumbnailPaths = []
  const perSource = {}
  let textBytes = 0
  let indexBytes = 0
  let indexVectors = 0
  for (const source of sources) {
    const breakdown = db.storageBreakdownForSource(source.id)
    const audio = sumExistingFiles(breakdown.media_paths)
    const videos = sumExistingFiles(breakdown.video_paths)
    perSource[String(source.id)] = {
      audio_bytes: audio.bytes,
      audio_files: audio.present,
      audio_known: audio.total,
      video_bytes: videos.bytes,
      video_files: videos.present,
      video_known: videos.total,
    }
    mediaPaths.push(...breakdown.media_paths)
    videoPaths.push(...breakdown.video_paths)
    transcriptPaths.push(...breakdown.transcript_paths)
    thumbnailPaths.push(...breakdown.thumbnail_paths)
    textBytes += Number(breakdown.text_bytes || 0)
    indexBytes += Number(breakdown.index_bytes || 0)
    indexVectors += Number(breakdown.index_vectors || 0)
  }
  const audio = sumExistingFiles(mediaPaths)
  const transcripts = sumExistingFiles(transcriptPaths)
  const videos = sumExistingFiles(videoPaths)
  const thumbnails = sumExistingFiles(thumbnailPaths)
  return {
    ok: true,
    root: jobRunner.LIB_ROOT,
    audio_root: jobRunner.getBoostyStorageConfig().audio_dir,
    video_root: jobRunner.getBoostyStorageConfig().video_dir,
    sources: sources.length,
    audio,
    videos,
    transcripts,
    thumbnails,
    text: { bytes: textBytes },
    index: { bytes: indexBytes, vectors: indexVectors },
    per_source: perSource,
    total_bytes: audio.bytes + videos.bytes + transcripts.bytes + thumbnails.bytes + textBytes + indexBytes,
  }
}

ipcMain.handle('boosty:platformStorage', async () => {
  try {
    const result = await dbRead.request('boostyPlatformStorage')
    const storage = jobRunner.getBoostyStorageConfig()
    return {
      ...result,
      root: jobRunner.LIB_ROOT,
      audio_root: storage.audio_dir,
      video_root: storage.video_dir,
    }
  } catch (err) {
    console.error('[Boosty] platform storage worker failed; falling back to main', err)
    try { return boostyPlatformStorageSnapshot() }
    catch (fallbackError) {
      console.error('[Boosty] platform storage fallback failed', fallbackError)
      return { ok: false, error: String(fallbackError?.message || fallbackError) }
    }
  }
})

function nearestExistingDirectory(target) {
  let current = path.resolve(target)
  while (!fs.existsSync(current) && path.dirname(current) !== current) current = path.dirname(current)
  return current
}

function storagePathInfo(target) {
  const absolute = path.resolve(String(target || jobRunner.LIB_ROOT))
  const probe = nearestExistingDirectory(absolute)
  const stats = fs.statfsSync(probe)
  return {
    path: absolute,
    probe,
    exists: fs.existsSync(absolute),
    free_bytes: Number(stats.bavail) * Number(stats.bsize),
    total_bytes: Number(stats.blocks) * Number(stats.bsize),
  }
}

ipcMain.handle('boosty:storageConfig', () => {
  const config = jobRunner.getBoostyStorageConfig()
  return {
    ok: true,
    ...config,
    audio_disk: storagePathInfo(config.audio_dir),
    video_disk: storagePathInfo(config.video_dir),
  }
})

ipcMain.handle('storage:pathInfo', (_evt, target) => storagePathInfo(target))

ipcMain.handle('storage:chooseDirectory', async (_evt, payload = {}) => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
    title: String(payload.title || 'Выберите папку'),
    defaultPath: payload.default_path ? String(payload.default_path) : undefined,
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled || !result.filePaths?.[0]
    ? { ok: false, canceled: true }
    : { ok: true, path: result.filePaths[0] }
})

ipcMain.handle('boosty:deleteAudio', (_evt, payload = {}) => {
  const sourceId = Number(payload.source_id)
  const source = db.getSource(sourceId)
  if (!source || source.platform !== 'boosty') return { ok: false, error: 'Источник Boosty не найден' }
  const hasExplicitSelection = Array.isArray(payload.video_ids)
  const requested = hasExplicitSelection
    ? [...new Set(payload.video_ids.map(String).filter(Boolean))]
    : null
  if (hasExplicitSelection && requested.length === 0) {
    return { ok: false, error: 'Не выбрано ни одного аудиофайла' }
  }
  return deleteBoostyAudioForSource(sourceId, requested)
})

ipcMain.handle('boosty:deletePlatformAudio', () => {
  const sources = boostySourceIds()
  const result = { ok: true, sources: 0, removed: 0, removed_files: 0, bytes: 0, errors: [] }
  for (const source of sources) {
    const one = deleteBoostyAudioForSource(source.id, null)
    if (one.removed) result.sources += 1
    result.removed += Number(one.removed || 0)
    result.removed_files += Number(one.removed_files || 0)
    result.bytes += Number(one.bytes || 0)
    result.errors.push(...(one.errors || []).map(error => ({ source_id: source.id, ...error })))
  }
  result.ok = result.errors.length === 0
  return result
})

ipcMain.handle('boosty:copyTranscripts', async (_evt, payload = {}) => {
  const sourceId = Number(payload.source_id)
  const ids = Array.isArray(payload.video_ids)
    ? [...new Set(payload.video_ids.map(String).filter(Boolean))]
    : []
  if (!sourceId || !ids.length) return { ok: false, error: 'Нечего копировать' }
  const result = await readDb('boostyCopyText', [sourceId, ids], () => {
    const chunks = []
    for (const row of db.listBoostyVideos(sourceId, ids)) {
      const info = localFileInfo(row.transcript_path)
      if (!info.present) continue
      try { chunks.push(fs.readFileSync(info.path, 'utf8')) } catch {}
    }
    const text = chunks.join('\n\n' + '='.repeat(72) + '\n\n')
    return { text, parts: chunks.length, bytes: Buffer.byteLength(text, 'utf8') }
  })
  if (!result?.text) return { ok: false, error: 'Сохранённых расшифровок нет' }
  clipboard.writeText(result.text)
  jobRunner.playClipboardSound()
  return { ok: true, count: result.parts, bytes: result.bytes }
})

// Local file transcribe — paste an absolute path → AssemblyAI/Gemini → clipboard.
ipcMain.handle('local:transcribe', (_evt, params) => jobRunner.startLocalTranscribe(params))

// YouTube search — sourceless video discovery via yt-dlp ytsearchN:query.
ipcMain.handle('yt:searchFetch', (_evt, params) => jobRunner.runYoutubeSearch(params || {}))

// Resume an interrupted yt_batch_transcribe (status='interrupted' or 'running'
// after app restart). Filters out already-transcribed videos and starts a fresh
// batch with the remainder.
ipcMain.handle('yt:resumeBatch', (_evt, payload) => {
  const id = payload?.jobId
  // Accept both 'db-NN' string ids (from listJobs hydration) and bare numeric.
  let rowId
  if (typeof id === 'string' && id.startsWith('db-')) rowId = Number(id.slice(3))
  else rowId = Number(id)
  if (!Number.isFinite(rowId)) return { ok: false, error: 'bad job id' }
  return jobRunner.resumeYoutubeBatch(rowId)
})

// Cache/state lookup for a chosen list of videos against the local DB.
// Used before starting a batch so the form can show "5 already transcribed".
ipcMain.handle('yt:itemsState', (_evt, { source_id, video_ids }) => {
  if (!source_id || !Array.isArray(video_ids) || video_ids.length === 0) return []
  return readDb('youtubeItemsState', [source_id, video_ids], () => (
    db.getItemsByExternalIds(source_id, video_ids).map(r => ({
      external_id: r.external_id,
      transcript_path: r.transcript_path,
      duration_seconds: r.duration_seconds,
      title: r.title,
    }))
  ))
})

// Cross-source bulk lookup for sourceless contexts (YouTube search picker).
// Returns the same shape but checks `items` across ALL channels + sourceless
// single-video jobs — so a search hit on a video that lives inside an
// already-fetched channel shows ✓ and skips re-transcription.
ipcMain.handle('yt:itemsStateGlobal', (_evt, { video_ids }) => {
  if (!Array.isArray(video_ids) || video_ids.length === 0) return []
  return readDb('youtubeItemsStateGlobal', [video_ids], () => {
    const out = []
    for (const [vid, hit] of db.findYoutubeTranscriptsByVideoIds(video_ids)) {
      out.push({
        external_id: vid, transcript_path: hit.file_path, origin: hit.origin,
        source_id: hit.source_id, source_handle: hit.source_handle || null,
      })
    }
    return out
  })
})

// Bulk per-video comments-state lookup. Picker uses it to render the 💬✓
// marker next to videos that already have at least one cached comments file
// (any sort/limit/replies — a "we have comments" indicator, not param-exact).
// Returns array of {external_id, file_path, finished_at, sort, limit,
//                    include_replies, count_total}.
ipcMain.handle('yt:itemsCommentsState', (_evt, { video_ids }) => {
  if (!Array.isArray(video_ids) || video_ids.length === 0) return []
  return readDb('youtubeItemsCommentsState', [video_ids], () => {
    const out = []
    for (const [vid, hit] of db.findYoutubeCommentsByVideoIds(video_ids)) {
      out.push({
        external_id: vid, file_path: hit.file_path, finished_at: hit.finished_at,
        sort: hit.sort, limit: hit.limit, include_replies: !!hit.include_replies,
        count_total: hit.count_total,
      })
    }
    return out
  })
})

// Build a combined transcript blob.  Two calling shapes:
//   { jobId, action }                          — for batch jobs (live or historical)
//   { source_id, video_ids[], action }         — for ad-hoc selection (picker)
ipcMain.handle('yt:assembleBatchTranscript', async (_evt, payload) => {
  const action = payload?.action
  let row = null
  let sourceId = null
  let videoIds = []
  let originStartedAt = null

  // Direct selection path — caller already knows which videos to assemble.
  if (payload?.source_id && Array.isArray(payload.video_ids) && payload.video_ids.length) {
    sourceId = payload.source_id
    videoIds = payload.video_ids
    originStartedAt = Math.floor(Date.now() / 1000)
  } else if (payload?.jobId != null) {
    // Job-based path — resolve to a row + params.
    const jobId = payload.jobId
    if (typeof jobId === 'string' && jobId.startsWith('db-')) {
      const id = Number(jobId.slice(3))
      if (!Number.isFinite(id)) return { ok: false, error: 'bad job id' }
      row = db.getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    } else {
      const snap = jobRunner.getJobDetail(jobId)
      if (!snap) return { ok: false, error: 'job not found' }
      if (snap.type !== 'yt_batch_transcribe') return { ok: false, error: 'not a batch job' }
      row = {
        id: snap.id,
        type: snap.type,
        source_id: snap.source_id,
        parameters_json: JSON.stringify(snap.params || {}),
        yt_batch: snap.yt_batch,
        started_at: snap.started_at,
      }
    }
    if (!row) return { ok: false, error: 'job not found' }
    let params = {}
    try { params = JSON.parse(row.parameters_json || '{}') } catch {}
    sourceId = row.source_id || params.source_id
    videoIds = Array.isArray(params.video_ids) ? params.video_ids : []
    originStartedAt = row.started_at
  } else {
    return { ok: false, error: 'either jobId or {source_id, video_ids} required' }
  }

  let workerParams = {}
  try { workerParams = row?.parameters_json ? JSON.parse(row.parameters_json) : {} } catch {}
  let workerOutputPath = null
  if (action === 'save') {
    const dt = new Date((originStartedAt || Math.floor(Date.now() / 1000)) * 1000)
    const date = dt.toISOString().slice(0, 10)
    const tag = row?.id != null ? `job${row.id}` : `picker${videoIds.length}`
    workerOutputPath = path.join(jobRunner.JOBS_DIR, `${date}_yt_batch_${tag}_combined.txt`)
  }
  try {
    const result = await dbRead.request('youtubeBatchAssembly', {
      sourceId,
      videoIds,
      params: workerParams,
      liveLog: row?.yt_batch?.log || null,
      action,
      outputPath: workerOutputPath,
    })
    if (result?.ok && action === 'copy') {
      clipboard.writeText(result.content || '')
      const { content: _content, ...publicResult } = result
      return publicResult
    }
    return result
  } catch (workerError) {
    // Keep the existing synchronous implementation below as a loud recovery
    // path if the packaged read worker cannot load.
    console.error('[YouTubeAssembly] worker failed; falling back to main', workerError)
  }

  // Pull transcript_path + title via items table (works for completed jobs
  // across restarts). Fallback to in-memory log for very fresh runs.
  let entries = []
  if (sourceId && videoIds.length) {
    const items = db.getItemsByExternalIds(sourceId, videoIds)
    const byId = new Map(items.map(it => [it.external_id, it]))
    for (const vid of videoIds) {
      const it = byId.get(vid)
      if (it && it.transcript_path && fs.existsSync(it.transcript_path)) {
        entries.push({
          video_id:        vid,
          title:           it.title,
          url:             it.url,
          transcript_path: it.transcript_path,
        })
      }
    }
  }
  // Sourceless (search) path — pull file paths from params.video_files
  // (persisted on close) or from in-memory yt_batch.log (live jobs).
  if (entries.length === 0 && row) {
    let params = null
    try { params = JSON.parse(row.parameters_json || '{}') } catch {}
    const videoFiles = params?.video_files || {}
    const titlesById = new Map(
      Array.isArray(params?.search_videos)
        ? params.search_videos.map(v => [v.video_id, v])
        : []
    )
    const ids = Array.isArray(params?.video_ids) ? params.video_ids : []
    for (const vid of ids) {
      const fp = videoFiles[vid]
      if (fp && fs.existsSync(fp)) {
        const meta = titlesById.get(vid) || {}
        entries.push({
          video_id:        vid,
          title:           meta.title || '',
          url:             meta.url   || `https://www.youtube.com/watch?v=${vid}`,
          transcript_path: fp,
        })
      }
    }
  }
  if (entries.length === 0 && row?.yt_batch?.log) {
    // Fallback for in-memory live jobs whose items haven't been queried yet.
    for (const e of row.yt_batch.log) {
      if (e.file_path && fs.existsSync(e.file_path)) {
        entries.push({ video_id: e.video_id, title: '', url: '', transcript_path: e.file_path })
      }
    }
  }

  if (entries.length === 0) {
    return { ok: false, error: 'no transcripts found' }
  }

  const SEP = '\n\n' + '='.repeat(72) + '\n\n'

  // Cheap estimate path — sum file sizes (bytes) without reading bodies.
  // Called for the picker's left-of-button "~Nk токенов · KB" hint when
  // all selected videos are already transcribed.
  if (action === 'estimate') {
    let bytes = 0
    for (const e of entries) {
      try { bytes += fs.statSync(e.transcript_path).size } catch {}
    }
    if (entries.length > 1) bytes += SEP.length * (entries.length - 1)
    // Same heuristic as CopySavedPanel: bytes/3 averages mixed RU/EN BPE.
    const tokens = Math.round(bytes / 3)
    return { ok: true, bytes, tokens, count: entries.length }
  }

  const chunks = []
  for (const e of entries) {
    try {
      const body = fs.readFileSync(e.transcript_path, 'utf8')
      chunks.push(body)
    } catch {
      // skip missing files silently
    }
  }
  const combined = chunks.join(SEP)
  const bytes = Buffer.byteLength(combined, 'utf8')
  const tokens = Math.round(bytes / 3)

  if (action === 'copy') {
    clipboard.writeText(combined)
    return { ok: true, bytes, tokens, count: entries.length }
  }

  if (action === 'save') {
    const dt = new Date((originStartedAt || Math.floor(Date.now() / 1000)) * 1000)
    const date = dt.toISOString().slice(0, 10)
    const tag = row?.id != null ? `job${row.id}` : `picker${entries.length}`
    const fname = `${date}_yt_batch_${tag}_combined.txt`
    const fpath = path.join(jobRunner.JOBS_DIR, fname)
    try {
      fs.writeFileSync(fpath, combined, 'utf8')
      return { ok: true, bytes, tokens, count: entries.length, file_path: fpath }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  return { ok: true, bytes, tokens, count: entries.length, content: combined }
})

// Lightweight history-only fetch for SourceDetail's "История парсинга" — it
// rebuilds many times during a long fetch (job progress invalidations) but
// the rest of the page (header, coverage, type breakdown) doesn't need to
// refetch on each tick. Splitting this out lets the bigger sources:detail
// stay terminal-only while the history strip stays live.
// Аргумент: голый id (legacy, limit=20) или {id, limit} — «История парсинга»
// докручивает limit кнопкой «показать ещё», иначе записи старше 20-й
// недостижимы (HIGH-1 аудита: SQL LIMIT прятал хвост истории насовсем).
ipcMain.handle('jobs:listForSource', async (_e, payload) => {
  const obj   = (typeof payload === 'object' && payload != null) ? payload : null
  const id    = obj ? obj.id : payload
  const limit = obj && Number.isFinite(obj.limit) ? obj.limit : 20
  const rows = await readDb(
    'listJobsForSource', [id, limit],
    () => db.listJobsForSource(id, limit),
  )
  return rows.filter(j => j.type !== 'yt_channel_fetch' && j.type !== 'tk_channel_fetch')
})
ipcMain.handle('jobs:listForSourcePage', async (_e, payload = {}) => {
  const id = payload.id ?? payload.sourceId
  const options = { limit: payload.limit || 20, cursor: payload.cursor || null }
  const page = await readDb(
    'listJobsForSourcePage', [id, options],
    () => db.listJobsForSourcePage(id, options),
  )
  return {
    ...page,
    jobs: (page.jobs || []).filter(j => j.type !== 'yt_channel_fetch' && j.type !== 'tk_channel_fetch'),
  }
})

ipcMain.handle('jobs:cancel', (_evt, payload) => {
  const request = payload && typeof payload === 'object' ? payload : { id: payload }
  const dbMatch = /^db-(\d+)$/.exec(String(request.id))
  const dbId = dbMatch ? Number(dbMatch[1]) : request.identity === 'db' ? Number(request.id) : null
  const index = dbId != null && indexJob.listActiveSnapshots().find(job => job.db_id === dbId)
  if (index) return indexJob.cancelById(index.id)
  // Historic ids are not cancellable — they're already finished.
  if (typeof request.id === 'string' && request.id.startsWith('db-')) return false
  return jobRunner.cancelJob(request.id, {
    identity: request.identity || null,
    type: request.type || null,
  })
})

ipcMain.handle('jobs:detail', (_evt, payload) => {
  const request = payload && typeof payload === 'object' ? payload : { id: payload }
  if (typeof request.id === 'string' && /^index-\d+$/.test(request.id)) {
    const live = indexJob.getActiveSnapshot(request.id)
    if (live) return live
  }
  const dbMatch = /^db-(\d+)$/.exec(String(request.id))
  const dbId = dbMatch ? Number(dbMatch[1]) : request.identity === 'db' ? Number(request.id) : null
  const index = dbId != null && indexJob.listActiveSnapshots().find(job => job.db_id === dbId)
  if (index) return index
  return jobRunner.getJobDetail(request.id, { identity: request.identity || null })
})

ipcMain.handle('jobs:setAutoIndexAfterFetch', async (_evt, { jobId, enabled } = {}) => {
  try {
    return await jobRunner.setAutoIndexAfterFetch(jobId, enabled === true)
  } catch (err) {
    console.error('[Jobs] setAutoIndexAfterFetch failed', err)
    return { ok: false, error: String(err && err.message || err) }
  }
})

// Copy file path or its content to clipboard.
ipcMain.handle('clipboard:writeText', (_evt, text) => {
  clipboard.writeText(String(text || ''))
  return { ok: true, bytes: Buffer.byteLength(String(text || ''), 'utf8') }
})

ipcMain.handle('jobs:copyFile', async (_evt, filePath) => {
  if (!filePath) return { ok: false, error: 'File not found' }
  try {
    const result = await readDb('readTextFiles', [[filePath], { trim: false, separator: '' }], async () => {
      const text = await fs.promises.readFile(filePath, 'utf8')
      return { text, parts: 1, bytes: Buffer.byteLength(text, 'utf8') }
    })
    if (!result?.parts) return { ok: false, error: 'File not found' }
    clipboard.writeText(result.text)
    return { ok: true, bytes: result.bytes }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// Stitch multiple text files (transcript + comments) into one clipboard
// payload. Inserts a blank line between sections; missing files are skipped
// silently. Returns bytes of the final blob so the caller can show
// «✓ Скопировано · KB» without a second read.
ipcMain.handle('jobs:copyCombined', async (_evt, filePaths) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { ok: false, error: 'No files' }
  }
  try {
    const result = await readDb('readTextFiles', [filePaths, { trim: true, separator: '\n\n' }], async () => {
      const parts = []
      for (const filePath of filePaths) {
        if (!filePath) continue
        try { parts.push((await fs.promises.readFile(filePath, 'utf8')).trim()) } catch {}
      }
      const text = parts.length ? `${parts.join('\n\n')}\n` : ''
      return { text, parts: parts.length, bytes: Buffer.byteLength(text, 'utf8') }
    })
    if (!result?.parts) return { ok: false, error: 'No readable files' }
    clipboard.writeText(result.text)
    jobRunner.playClipboardSound()
    return { ok: true, bytes: result.bytes, parts: result.parts }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

function openLocalFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' }
  // Prefer Sublime Text via `subl` CLI (or its app bundle); else system default.
  try {
    const sublPath = '/usr/local/bin/subl'
    const sublApp  = '/Applications/Sublime Text.app'
    if (fs.existsSync(sublPath)) {
      spawn(sublPath, [filePath], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true, opener: 'subl' }
    }
    if (fs.existsSync(sublApp)) {
      spawn('/usr/bin/open', ['-a', sublApp, filePath], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true, opener: 'sublime.app' }
    }
    shell.openPath(filePath)
    return { ok: true, opener: 'default' }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

// Open in Sublime if installed; fall back to default editor.
ipcMain.handle('jobs:openExternal', (_evt, filePath) => {
  return openLocalFile(filePath)
})

// Открыть URL во внешнем браузере. Отдельно от jobs:openExternal, который
// существует для локальных файлов и проверяет fs.existsSync(filePath).
// Принимаем только http/https — никакого file://, javascript:, и т.п.
ipcMain.handle('jobs:openUrl', (_evt, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Invalid URL' }
  }
  shell.openExternal(url).catch(() => {})
  return { ok: true }
})

ipcMain.handle('jobs:revealInFinder', (_evt, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false }
  shell.showItemInFolder(filePath)
  return { ok: true }
})

// ─── DB queries ───────────────────────────────────────────────
ipcMain.handle('ui:getPreference', (_e, key) => db.getUiPreference(key))
ipcMain.handle('ui:setPreference', (_e, payload) => {
  const p = payload || {}
  return db.setUiPreference(p.key, p.value)
})

ipcMain.handle('sources:list', (_e, platform) => (
  readDb('listSources', [platform || null], () => db.listSources(platform || null))
))
ipcMain.handle('sources:get', (_e, id) => (
  readDb('getSource', [id], () => db.getSource(id))
))
ipcMain.handle('sources:findTelegram', (_e, target) => (
  readDb('findTelegramSourceByTarget', [target], () => db.findTelegramSourceByTarget(target))
))
ipcMain.handle('sources:detail', (_e, id) => (
  readDb('sourceDetail', [id], () => {
    const source = db.getSource(id)
    return {
      source,
      typeBreakdown: db.itemTypeBreakdown(id),
      telegramAnalysis: source?.platform === 'telegram' ? db.latestTelegramAnalysisForSource(id) : null,
      senders: db.senderBreakdown(id),
      coverage: db.listCoverage(id),
      dateRange: db.itemsDateRange(id),
      jobs: source?.platform === 'boosty'
        ? db.listJobsForSource(id).filter(j => j.type !== 'yt_channel_fetch' && j.type !== 'tk_channel_fetch')
        : [],
      commentsCount: db.countCommentsBySource(id),
      postsWithComments: db.listPostsWithComments(id).length,
    }
  })
))

function sumExistingFiles(paths) {
  let bytes = 0, present = 0
  const unique = [...new Set(paths || [])]
  for (const p of unique) {
    const absolute = path.isAbsolute(String(p || '')) ? p : path.join(jobRunner.LIB_ROOT, String(p || ''))
    try { bytes += fs.statSync(absolute).size; present++ } catch { /* missing file — skip */ }
  }
  return { bytes, present, total: unique.length }
}

ipcMain.handle('sources:socialOverview', async (_e, id) => {
  try {
    return await readDb('socialOverview', [id], () => {
      const overview = db.socialSourceOverview(id)
      if (!overview) return { ok: false, error: 'unsupported source' }
      const storage = db.storageBreakdownForSource(id)
      const media = sumExistingFiles(storage.media_paths)
      const transcripts = sumExistingFiles(storage.transcript_paths)
      const dbPayloadBytes = Number(overview.bytes?.db_payload || 0)
      return {
        ok: true, ...overview,
        storage: {
          root: jobRunner.LIB_ROOT,
          db_payload: { bytes: dbPayloadBytes }, media, transcripts,
          index: { bytes: storage.index_bytes || 0, vectors: storage.index_vectors || 0 },
          total_bytes: dbPayloadBytes + media.bytes + transcripts.bytes + (storage.index_bytes || 0),
        },
      }
    })
  } catch (err) {
    console.error('[sources:socialOverview] failed', err)
    return { ok: false, error: String(err && err.message || err) }
  }
})
// Per-source disk-weight breakdown for the «Распределение по типам» block.
// DB returns byte sums + file-path lists in one round-trip; we stat() the
// files here (main thread, but cheap — a few hundred statSync at most, and
// most TG sources have zero downloaded media). Bytes only; the renderer
// formats to MB. `root` is the single storage dir (CLAUDE.md invariant —
// everything lives under LIB_ROOT) so the «open folder» button knows where
// to point.
ipcMain.handle('sources:storage', async (_e, id) => {
  try {
    const result = await readDb('sourceStorage', [id], () => {
      const b = db.storageBreakdownForSource(id)
      const source = db.getSource(id)
      const media = sumExistingFiles(b.media_paths)
      const videos = sumExistingFiles(b.video_paths)
      const transcripts = sumExistingFiles(b.transcript_paths)
      const thumbnails = sumExistingFiles(b.thumbnail_paths)
      return {
        ok: true,
        platform: source?.platform || null,
        root: jobRunner.LIB_ROOT,
        text: { bytes: b.text_bytes },
        index: { bytes: b.index_bytes, vectors: b.index_vectors },
        media, videos, transcripts, thumbnails,
        total_bytes: b.text_bytes + b.index_bytes + media.bytes + videos.bytes
          + transcripts.bytes + thumbnails.bytes,
      }
    })
    const boostyStorage = result?.platform === 'boosty' ? jobRunner.getBoostyStorageConfig() : null
    return {
      ...result,
      root: boostyStorage?.audio_dir || result?.root || jobRunner.LIB_ROOT,
      audio_root: boostyStorage?.audio_dir || null,
      video_root: boostyStorage?.video_dir || null,
    }
  } catch (err) {
    console.error('[sources:storage] failed', err)
    return { ok: false, error: String(err && err.message || err) }
  }
})

// Reveal the storage root folder in Finder. Distinct from
// jobs:revealInFinder (which selects a single file via showItemInFolder) —
// here we want the FOLDER opened, so openPath on the dir itself.
ipcMain.handle('storage:openRoot', (_e, dir) => {
  try {
    const target = (dir && typeof dir === 'string') ? dir : jobRunner.LIB_ROOT
    if (!fs.existsSync(target)) return { ok: false, error: 'not found' }
    shell.openPath(target)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

ipcMain.handle('items:list', (_e, params) => (
  readDb('listItems', [params], () => db.listItems(params))
))
ipcMain.handle('items:listPage', (_e, params) => (
  readDb('listItemsPage', [params], () => db.listItemsPage(params))
))
ipcMain.handle('items:search', (_e, { source_id, query, limit }) => (
  readDb('searchItems', [source_id || null, query, limit || 50], () => db.searchItems(source_id || null, query, limit || 50))
))
ipcMain.handle('items:topics', (_e, source_id) => (
  readDb('listSourceTopics', [source_id], () => db.listSourceTopics(source_id))
))
ipcMain.handle('items:typeBreakdown', (_e, { source_id, topic_id }) => (
  readDb('itemTypeBreakdown', [source_id, topic_id ?? null], () => db.itemTypeBreakdown(source_id, topic_id ?? null))
))
ipcMain.handle('items:telegramMediaEstimate', (_e, scope) => (
  readDb('telegramMediaEstimate', [scope || {}], () => db.telegramMediaEstimate(scope || {}))
))

// Copy the caption(s) of specific saved messages (per-row «копировать» and the
// bulk «копировать N» action in ChatView). The caption already carries any
// appended AI block — appendItemTranscript writes «[голосовое — расшифровка ·
// engine]\n<text>» into the same caption column — so we just read captions by
// external_id and join them chronologically. We deliberately DON'T route this
// through items:assembleCopy: that path is type-gated (a lone voice row with a
// transcript in caption but type='voice' would be dropped by the assembly
// WHERE), whereas here the user explicitly picked exact rows and wants exactly
// their text. Returns {ok, bytes, count}.
ipcMain.handle('items:copyMany', async (_e, { source_id, external_ids }) => {
  try {
    if (!source_id || !Array.isArray(external_ids) || external_ids.length === 0) {
      return { ok: false, error: 'no ids', count: 0 }
    }
    const result = await readDb('copyManyText', [source_id, external_ids], () => {
      const rows = db.getItemsByExternalIds(source_id, external_ids.map(String))
      rows.sort((a, b) => (a.published_at || 0) - (b.published_at || 0))
      const parts = rows.map(row => String(row.caption || '').trim()).filter(Boolean)
      const text = parts.length ? `${parts.join('\n\n')}\n` : ''
      return { text, count: parts.length, bytes: Buffer.byteLength(text, 'utf8') }
    })
    if (!result?.text) return { ok: false, error: 'empty', count: 0 }
    clipboard.writeText(result.text)
    jobRunner.playClipboardSound()
    return { ok: true, bytes: result.bytes, count: result.count }
  } catch (err) {
    return { ok: false, error: String(err?.message || err), count: 0 }
  }
})

// ─── Copy-saved (assemble) ────────────────────────────────────────────
//
// Three handlers around the same scope object:
//   items:assembleEstimate → cheap COUNT (debounced from UI)
//   items:assembleCopy     → assemble + clipboard.writeText + Blow.aiff
//   items:assembleSave     → assemble + showSaveDialog + write to disk
ipcMain.handle('items:assembleEstimate', (_e, scope) => (
  readDb('assemblyEstimate', [scope], () => {
    const base = db.assemblyEstimate(scope)
    let transcriptBytes = 0
    for (const row of db.assemblyTranscriptPaths(scope)) {
      try { if (row.transcript_path) transcriptBytes += fs.statSync(row.transcript_path).size } catch {}
    }
    const bytes = (base.caption_bytes || 0) + transcriptBytes + base.count * 50
    return { ...base, bytes, tokens: Math.round(bytes / 3) }
  })
))

ipcMain.handle('items:assembleCopy', async (_e, scope) => {
  try {
    const result = await readDb('assemblyText', [scope], () => {
      const rows = db.assemblyFetch(scope)
      const text = assembleText(rows, {
        showTopicHeaders: scope?.topic_id == null,
        commentsByPostId: _buildCommentsMap(scope, rows),
        chatLabelBySourceId: _buildChatLabelMap(scope),
      })
      const bytes = Buffer.byteLength(text || '', 'utf8')
      return { text, count: rows.length, bytes, tokens: Math.round(bytes / 3) }
    })
    if (!result?.text) return { ok: false, error: 'empty', count: 0 }
    clipboard.writeText(result.text)
    jobRunner.playClipboardSound()
    return { ok: true, count: result.count, bytes: result.bytes, tokens: result.tokens }
  } catch (err) {
    console.error('[Assemble] copy failed', err)
    return { ok: false, error: String(err && err.message || err) }
  }
})

// For folder-mode assembly: resolve every source_id once so the assembler
// can render `# Чат: <title>` headers between groups. Single-source mode
// returns null — the heading is unnecessary.
function _buildChatLabelMap(scope) {
  if (!Array.isArray(scope?.source_ids) || scope.source_ids.length < 2) return null
  const m = new Map()
  for (const sid of scope.source_ids) {
    try {
      const s = db.getSource(Number(sid))
      if (!s) continue
      m.set(s.id, {
        handle: s.handle,
        title:  (s.display_name && s.display_name !== s.handle) ? s.display_name : null,
      })
    } catch {}
  }
  return m
}

// Build the comments map only when the scope requested it. Pulls one
// listCommentsForPosts query for the slice — cheap (indexed by post_external_id).
function _buildCommentsMap(scope, rows) {
  if (!scope?.with_comments) return null
  if (!Array.isArray(rows) || rows.length === 0) return null
  const ids = rows.map(r => String(r.external_id)).filter(Boolean)
  if (ids.length === 0) return null
  try {
    const flat = db.listCommentsForPosts(scope.source_id, ids)
    const m = new Map()
    for (const c of flat) {
      const k = String(c.post_external_id)
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(c)
    }
    return m
  } catch (err) {
    console.error('[Assemble] listCommentsForPosts failed', err)
    return null
  }
}

ipcMain.handle('items:assembleSave', async (_e, { scope, defaultName }) => {
  try {
    const win = BrowserWindow.getAllWindows()[0]
    const res = await dialog.showSaveDialog(win, {
      defaultPath: defaultName || 'export.txt',
      filters: [{ name: 'Text', extensions: ['txt'] }],
    })
    if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' }
    return await readDb('assemblySave', [scope, res.filePath], async () => {
      const rows = db.assemblyFetch(scope)
      const text = assembleText(rows, {
        showTopicHeaders: scope?.topic_id == null,
        commentsByPostId: _buildCommentsMap(scope, rows),
        chatLabelBySourceId: _buildChatLabelMap(scope),
      })
      if (!text) return { ok: false, error: 'empty' }
      await fs.promises.writeFile(res.filePath, text, 'utf8')
      const bytes = Buffer.byteLength(text, 'utf8')
      return { ok: true, path: res.filePath, count: rows.length,
               bytes, tokens: Math.round(bytes / 3) }
    })
  } catch (err) {
    console.error('[Assemble] save failed', err)
    return { ok: false, error: String(err && err.message || err) }
  }
})

// Destructive ops — confirmed in the renderer before invocation.
ipcMain.handle('sources:delete', (_e, id) => { db.deleteSource(id);     return { ok: true } })
ipcMain.handle('items:delete',   (_e, id) => { db.deleteItem(id);       return { ok: true } })
ipcMain.handle('jobs:deleteOne', (_e, id) => {
  // Historic ids are 'db-N' strings; live (in-memory) ids are numbers.
  if (typeof id === 'string' && id.startsWith('db-')) {
    const n = Number(id.slice(3))
    if (Number.isFinite(n)) db.deleteJob(n)
  } else {
    db.deleteJob(id)
  }
  return { ok: true }
})
ipcMain.handle('jobs:clearForSource', (_e, id) => { db.clearJobsForSource(id); return { ok: true } })
ipcMain.handle('sources:maxExternalId', (_e, id) => (
  readDb('maxExternalId', [id], () => db.maxExternalId(id))
))

ipcMain.handle('sources:getNotes', (_e, id)         => db.getSourceNotes(id))
ipcMain.handle('sources:setNotes', (_e, { id, notes }) => db.setSourceNotes(id, notes))

// `sc-asset://<path-relative-to-LIB_ROOT>` — read-only access to local
// binary assets (avatars, thumbnails) from the renderer without disabling
// webSecurity. Path traversal is blocked: only files inside LIB_ROOT
// resolve, anything escaping (..) returns 404.
function registerAssetProtocol() {
  protocol.registerFileProtocol('sc-asset', (request, callback) => {
    try {
      const url = new URL(request.url)
      // sc-asset://avatars/telegram/123.jpg → host='avatars', pathname='/telegram/123.jpg'
      const rel = path.posix.normalize(path.posix.join(url.host || '', url.pathname || ''))
      if (rel.includes('..')) return callback({ error: -6 })   // FILE_NOT_FOUND
      const abs = path.join(jobRunner.LIB_ROOT, rel)
      callback({ path: abs })
    } catch (err) {
      console.error('[Asset] resolve failed', err)
      callback({ error: -2 })   // FAILED
    }
  })
}

app.whenReady().then(() => {
  if (!isPrimaryInstance) return
  registerAssetProtocol()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  // HTTP-bridge для browser-extension (см. electron/browser-bridge.js).
  // Только loopback, фиксированный порт 53127. Падение/занятость порта не
  // ломает приложение — расширение просто покажет «sc-desktop не запущен».
  if (!isE2E) {
    try {
      startBrowserBridge({
        jobRunner,
        researchNavigation,
        notificationService: telegramNotificationService,
        settingsAccess: { readScSettings: readScSettingsStrict, writeScSettings },
      })
    } catch (err) {
      console.log(`[BrowserBridge] failed to start: ${err?.message || err}`)
    }
    try {
      const autoEnabled = publicAppSettings(readScSettingsStrict()).telegram.auto_enabled
      startTelegramAutoScheduler({ db, jobRunner, indexJob, enabled: autoEnabled })
    } catch (err) {
      console.warn(`[TelegramAuto] failed to start scheduler: ${err?.message || err}`)
    }
  }
  // Наблюдатель за почтой поднимается только если пользователь включил его
  // в настройках; отсутствие настроек не считается ошибкой запуска.
  if (!isE2E) mailNotificationService.start()
    .then(state => {
      if (state?.status && state.status !== 'disabled') {
        console.log(`[MailNotify] start status=${state.status}${state.error ? ` reason=${state.error}` : ''}`)
      }
    })
    .catch(err => console.warn(`[MailNotify] failed to start: ${err?.message || err}`))
  if (!isE2E) try {
    mobileApiServer = startMobileApiServer({
      db,
      jobRunner,
      readScSettings: readScSettingsStrict,
    })
  } catch (err) {
    console.warn(`[MobileAPI] failed to start: ${err?.message || err}`)
  }
})

app.on('before-quit', () => {
  stopTelegramAutoScheduler()
  dbRead.stop().catch(err => console.error('[DbReadWorker] stop failed', err))
  stopTelegramFinalizer().catch(err => console.error('[PersistenceWorker] stop failed', err))
  mobileApiServer?.close()
  mobileApiServer = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
