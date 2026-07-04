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
const { embedQuery } = require('./embedder')
const { assembleText } = require('./assemble')
const {
  startTelegramAutoScheduler,
  stopTelegramAutoScheduler,
  clearTelegramAutoSessionBlock,
} = require('./telegram-auto')
const { createTelegramBotService } = require('./telegram-bot')

const isDev = process.env.NODE_ENV === 'development'

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
  jobRunner.subscribe(job => {
    perfDiagnostics.noteJobUpdate(job, 'jobRunner')
    if (!win.isDestroyed()) win.webContents.send('job:update', job)
  })
  indexJob.subscribe(job => {
    perfDiagnostics.noteJobUpdate(job, 'indexJob')
    if (!win.isDestroyed()) win.webContents.send('job:update', job)
  })
}

ipcMain.handle('jobs:list', () => jobRunner.listJobs())

// ─── AI Studio MCP jobs — зеркало state'а из browser-bridge ──────────
//
// Bridge хранит RAM-only Map<jobId, state> которую расширение PATCH'ит
// на каждый log-event. Renderer poll'ит через aistudio:listJobs (1.5s
// в useAistudioJobs store). Также broadcast 'aistudio:update' в окно
// чтобы избежать тикающего IPC-roundtrip каждую секунду — но poll-fallback
// остаётся как страховка если push сломается.
//
// Path-based fetch использует http.get локального HTTP-сервера. Это
// дёшево (loopback latency <1ms) и не блокирует Electron event loop.
// Unified-источник: /external-jobs объединяет AI Studio (aim_…) + Claude/
// Perplexity research (r…). Попап «Запущенные MCP» показывает всё внешнее.
// Имя IPC-канала оставлено aistudio:* для обратной совместимости с renderer-
// store (исторически), но содержимое теперь — все external-research jobs.
async function fetchAistudioJobs() {
  try {
    const r = await fetch('http://127.0.0.1:53127/external-jobs')
    if (!r.ok) return { jobs: [] }
    return await r.json()
  } catch (e) {
    return { jobs: [], error: String(e?.message || e) }
  }
}
ipcMain.handle('aistudio:listJobs', () => fetchAistudioJobs())
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
    const { jobs } = await fetchAistudioJobs()
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
app.whenReady().then(() => { startAistudioBroadcast() })

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

function writeScSettings(next) {
  try {
    fs.mkdirSync(path.dirname(SC_SETTINGS_PATH), { recursive: true })
    fs.writeFileSync(SC_SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
    return { ok: true }
  } catch (err) {
    console.error('[Settings] write failed', err)
    return { ok: false, error: String(err) }
  }
}

const telegramBot = createTelegramBotService({
  readScSettings,
  writeScSettings,
  jobRunner,
  db,
})

telegramBot.subscribe(state => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('telegramBot:update', state)
  }
})

ipcMain.handle('telegramBot:state', () => telegramBot.getState())
ipcMain.handle('telegramBot:restart', () => telegramBot.restart())

async function listTelegramSessionsSnapshot() {
  const events = await jobRunner.runTgSessionsCommand(['list'])
  const sessions = events.filter(e => e.type === 'session')
  const settings = readScSettings()
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
  return await listTelegramSessionsSnapshot()
})

ipcMain.handle('tg:setActiveSession', (_evt, name) => {
  const settings = readScSettings()
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
  const events = await jobRunner.runTgSessionsCommand(['delete', '--name', name])
  const errEv = events.find(e => e.type === 'error')
  if (errEv) return { ok: false, error: errEv.message }
  // If the deleted session was active, clear that field — otherwise the
  // next fetch would point at a missing file.
  const settings = readScSettings()
  if (settings.telegram?.session === name) {
    settings.telegram.session = null
    writeScSettings(settings)
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
ipcMain.handle('tg:countComments', (_evt, sourceId) => {
  if (!sourceId) return 0
  try { return db.countCommentsBySource(Number(sourceId)) } catch { return 0 }
})

ipcMain.handle('tg:postsWithComments', (_evt, sourceId) => {
  if (!sourceId) return []
  try { return db.listPostsWithComments(Number(sourceId)) } catch { return [] }
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
    // Materialise: upsert sources, upsert folder, set folder_sources.
    const sourceIds = []
    const sourcesOut = []
    for (const chat of (f.chats || [])) {
      try {
        const sid = db.upsertSource({
          platform:     'telegram',
          handle:       chat.handle,
          display_name: chat.title || null,
          external_id:  chat.tg_id != null ? String(chat.tg_id) : null,
          avatar_url:   chat.avatar_path || null,
          meta:         { kind: chat.kind, username: chat.username || null,
                          via_folder_id: f.filter_id },
          // Чаты из папок не "осознанные" — иначе sidebar засрётся всеми
          // 12 каналами папки event'ов как explicit-row'ами. Они доступны
          // через TelegramScreen → таб папки. is_explicit поднимается до 1
          // только если юзер позже руками их фетчит.
          is_explicit:  false,
          tg_session:   sessNow,
        })
        sourceIds.push(sid)
        sourcesOut.push({ id: sid, ...chat })
      } catch (err) {
        console.error('[FolderResolve] upsertSource failed', chat.handle, err)
      }
    }
    let folderId
    try {
      folderId = db.upsertFolder({
        tg_filter_id: f.filter_id,
        title:        f.title,
        tg_session:   sessNow,
      })
      db.setFolderSources(folderId, sourceIds)
    } catch (err) {
      console.error('[FolderResolve] folder upsert failed', err)
      return { ok: false, error: String(err && err.message || err) }
    }
    return {
      ok: true,
      folder: {
        id:           folderId,
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
ipcMain.handle('tg:replyBackfill', (_e, { source_id, limit } = {}) => {
  try {
    if (!source_id) return { ok: false, error: 'source_id required' }
    const s = db.getSource(Number(source_id))
    if (!s || s.platform !== 'telegram') {
      return { ok: false, error: 'not a telegram source' }
    }
    const target = s.handle
    if (!target) return { ok: false, error: 'source has no handle' }
    const id = jobRunner.startTelegramReplyBackfill({
      source_id: Number(source_id),
      target,
      limit: limit ? Number(limit) : undefined,
    })
    return { ok: true, jobId: id }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

// session-фильтр: TelegramScreen передаёт имя выбранной сессии — отдаём
// только её папки (+legacy без привязки). Без аргумента — все (back-compat).
ipcMain.handle('folder:list',         (_e, tgSession) => db.listFolders(tgSession || null))
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
ipcMain.handle('sources:setTelegramAuto', (_e, payload = {}) => {
  try {
    return db.setTelegramAutoForSources(payload.source_ids || [], payload.patch || {})
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})
ipcMain.handle('folder:get',          (_e, id) => db.getFolder(Number(id)))
ipcMain.handle('folder:listSources',  (_e, id) => db.listFolderSources(Number(id)))
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
ipcMain.handle('tg:catchUp', (_e, params) => {
  if (!params || !Array.isArray(params.source_ids) || params.source_ids.length === 0) {
    return { ok: false, error: 'source_ids required' }
  }
  const groups = new Map()
  for (const sid of params.source_ids) {
    try {
      const s = db.getSource(Number(sid))
      if (!s || s.platform !== 'telegram' || !s.handle) continue
      if (s.tg_session_conflict) return { ok: false, error: `Выбери Telegram-аккаунт для «${s.display_name || s.handle}»` }
      if (!s.tg_session) return { ok: false, error: `У «${s.display_name || s.handle}» не выбран Telegram-аккаунт` }
      if (!groups.has(s.tg_session)) groups.set(s.tg_session, { source_ids: [], targets: [], sinces: [] })
      const group = groups.get(s.tg_session)
      group.source_ids.push(Number(sid))
      group.targets.push(s.handle)
      let since = 0
      try { since = db.maxExternalId(s.id) || 0 } catch {}
      group.sinces.push(since)
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
ipcMain.handle('folder:fetch', (_e, params) => {
  if (!params || !Array.isArray(params.source_ids) || params.source_ids.length === 0) {
    return { ok: false, error: 'source_ids required' }
  }
  // Resolve each source_id → telegram handle the Python side speaks.
  const targets = []
  let tgSession = null
  for (const sid of params.source_ids) {
    try {
      const s = db.getSource(Number(sid))
      if (s && s.platform === 'telegram' && s.handle) {
        if (s.tg_session_conflict) return { ok: false, error: `Выбери Telegram-аккаунт для «${s.display_name || s.handle}»` }
        if (!s.tg_session) return { ok: false, error: `У «${s.display_name || s.handle}» не выбран Telegram-аккаунт` }
        if (tgSession && tgSession !== s.tg_session) return { ok: false, error: 'Выбранные чаты относятся к разным Telegram-аккаунтам' }
        tgSession = s.tg_session
        targets.push(s.handle)
      }
    } catch {}
  }
  if (!targets.length) return { ok: false, error: 'no resolvable telegram sources' }

  try {
    const id = jobRunner.startTelegramFolderFetch({
      folder_id:  params.folder_id || null,
      source_ids: params.source_ids.map(Number),
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
ipcMain.handle('tg:index', (_evt, { sourceId, limit }) => {
  try {
    const sid = Number(sourceId)
    const t0 = Date.now()
    console.log(`[tg:index] request source #${sid} limit=${limit || 'full'}`)
    const result = indexJob.start({ sourceId, limit: limit || null, origin: 'manual-ipc' })
    if (result && typeof result === 'object' && result.noop) {
      console.log(`[tg:index] source #${sid} noop reason=${result.reason} total_ms=${Date.now() - t0}`)
      return { ok: true, noop: true, reason: result.reason }
    }
    console.log(`[tg:index] source #${sid} started job=${result} total_ms=${Date.now() - t0}`)

    // Reply-graph backfill improves MCP `telegram_reply_thread`, but it must
    // not sit in the click's synchronous IPC path. Run it after returning the
    // index job id, and only when an index job actually started. If semantic
    // index is already complete (`noop`), a hidden Telethon job on every
    // "Index" click is just lag with no user-visible indexing work.
    setImmediate(() => {
      try {
        const pendingStarted = Date.now()
        const pending = db.listItemsMissingParent(sid, 1)
        console.log(`[tg:index] reply-backfill pending-check source #${sid} rows=${pending.length} took ${Date.now() - pendingStarted}ms`)
        if (!pending.length) return
        const sourceStarted = Date.now()
        const s = db.getSource(sid)
        console.log(`[tg:index] reply-backfill source-read source #${sid} took ${Date.now() - sourceStarted}ms`)
        if (s && s.platform === 'telegram' && s.handle) {
          try {
            jobRunner.startTelegramReplyBackfill({
              source_id: sid,
              target: s.handle,
            })
          } catch (err) {
            // Expected when a tg_fetch is already running for this source.
            // The index job itself runs over local DB rows and doesn't need
            // a Telethon session, so just skip backfill this time.
            console.log(`[tg:index] reply-backfill deferred: ${err.message || err}`)
          }
        }
      } catch (err) {
        console.error('[tg:index] reply-backfill kickoff failed', err)
      }
    })
    return { ok: true, jobId: result }
  } catch (err) {
    console.error('[tg:index] failed', err)
    return { ok: false, error: String(err && err.message || err) }
  }
})

ipcMain.handle('tg:indexStatus', (_evt, sourceId) => {
  try {
    return indexJob.statusForSource(sourceId)
  } catch (err) {
    console.error('[tg:indexStatus] failed', err)
    return { state: 'idle', done: 0, total: 0, error: String(err) }
  }
})

ipcMain.handle('tg:indexCancel', (_evt, sourceId) => {
  return { ok: indexJob.cancel(sourceId) }
})

// Hybrid search — server-side wrapper for the renderer + future MCP tool.
// Embeds the query, runs RRF over FTS5 + items_vec, returns up to `limit`
// items annotated with their fusion score.
ipcMain.handle('tg:search', async (_evt, { sourceId, query, limit }) => {
  try {
    if (!query || !query.trim()) return { results: [] }
    const q = await embedQuery(query)
    const results = db.hybridSearch({
      query, query_embedding: q, source_id: sourceId, limit: limit || 10,
    })
    return { results }
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
  const legacyMapped = legacy === 'android' ? 'api' : (legacy || null)
  return {
    metadata_backend:   ig.metadata_backend   || legacyMapped || 'api',
    transcribe_backend: ig.transcribe_backend || 'api',
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

ipcMain.handle('ig:getSettings', async () => {
  const s = readScSettings()
  const ig = s.instagram || {}
  let legacyToken = null
  try {
    if (fs.existsSync(APIFY_LEGACY_PATH)) {
      legacyToken = (fs.readFileSync(APIFY_LEGACY_PATH, 'utf8') || '').trim() || null
    }
  } catch {}
  const backends = _readIgBackends(ig)
  const token = ig.apify_token || legacyToken || null
  const apifyTokenCheck = await _checkApifyToken(token)
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
  const settings = readScSettings()
  const ig = { ...(settings.instagram || {}) }
  ig[`${which}_backend`] = backend
  // Drop the legacy `ig.backend` key once we've split — keeps settings.json tidy.
  delete ig.backend
  settings.instagram = ig
  return writeScSettings(settings)
})

ipcMain.handle('ig:setApifyToken', (_evt, token) => {
  const clean = (token || '').trim() || null
  const settings = readScSettings()
  settings.instagram = { ...(settings.instagram || {}), apify_token: clean }
  const r = writeScSettings(settings)
  if (!r.ok) return r
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

  // For api backend we need the profile's user_id (= sources.external_id
  // for IG sources) so the Python side can paginate clips/user/ to find
  // each shortcode's fresh signed video_url.
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
ipcMain.handle('ig:assembleBatchTranscript', (_evt, payload) => {
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
ipcMain.handle('yt:copyCachedFile', (_evt, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' }
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    clipboard.writeText(content)
    jobRunner.playClipboardSound()
    return { ok: true, bytes: content.length }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})
ipcMain.handle('yt:single',     (_evt, params) => jobRunner.startYoutubeSingle(params))
ipcMain.handle('yt:resumeAi',   (_evt, { jobId, engine }) => jobRunner.resumeYoutubeAi(jobId, { engine }))

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
ipcMain.handle('tk:copyCachedFile', (_evt, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' }
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    clipboard.writeText(content)
    jobRunner.playClipboardSound()
    return { ok: true, bytes: content.length }
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
  const rows = db.getItemsByExternalIds(source_id, video_ids)
  return rows.map(r => ({
    external_id:    r.external_id,
    transcript_path: r.transcript_path,
    duration_seconds: r.duration_seconds,
    title:          r.title,
  }))
})

// Cross-source bulk lookup for sourceless contexts (YouTube search picker).
// Returns the same shape but checks `items` across ALL channels + sourceless
// single-video jobs — so a search hit on a video that lives inside an
// already-fetched channel shows ✓ and skips re-transcription.
ipcMain.handle('yt:itemsStateGlobal', (_evt, { video_ids }) => {
  if (!Array.isArray(video_ids) || video_ids.length === 0) return []
  const map = db.findYoutubeTranscriptsByVideoIds(video_ids)
  const out = []
  for (const [vid, hit] of map) {
    out.push({
      external_id:     vid,
      transcript_path: hit.file_path,
      origin:          hit.origin,           // 'items' | 'jobs'
      source_id:       hit.source_id,
      source_handle:   hit.source_handle || null,
    })
  }
  return out
})

// Bulk per-video comments-state lookup. Picker uses it to render the 💬✓
// marker next to videos that already have at least one cached comments file
// (any sort/limit/replies — a "we have comments" indicator, not param-exact).
// Returns array of {external_id, file_path, finished_at, sort, limit,
//                    include_replies, count_total}.
ipcMain.handle('yt:itemsCommentsState', (_evt, { video_ids }) => {
  if (!Array.isArray(video_ids) || video_ids.length === 0) return []
  const map = db.findYoutubeCommentsByVideoIds(video_ids)
  const out = []
  for (const [vid, hit] of map) {
    out.push({
      external_id:     vid,
      file_path:       hit.file_path,
      finished_at:     hit.finished_at,
      sort:            hit.sort,
      limit:           hit.limit,
      include_replies: !!hit.include_replies,
      count_total:     hit.count_total,
    })
  }
  return out
})

// Build a combined transcript blob.  Two calling shapes:
//   { jobId, action }                          — for batch jobs (live or historical)
//   { source_id, video_ids[], action }         — for ad-hoc selection (picker)
ipcMain.handle('yt:assembleBatchTranscript', (_evt, payload) => {
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
ipcMain.handle('jobs:listForSource', (_e, payload) => {
  const obj   = (typeof payload === 'object' && payload != null) ? payload : null
  const id    = obj ? obj.id : payload
  const limit = obj && Number.isFinite(obj.limit) ? obj.limit : 20
  return db.listJobsForSource(id, limit)
    .filter(j => j.type !== 'yt_channel_fetch' && j.type !== 'tk_channel_fetch')
})

ipcMain.handle('jobs:cancel', (_evt, id) => {
  // Historic ids are not cancellable — they're already finished.
  if (typeof id === 'string' && id.startsWith('db-')) return false
  return jobRunner.cancelJob(id)
})

ipcMain.handle('jobs:detail', (_evt, id) => jobRunner.getJobDetail(id))

ipcMain.handle('jobs:setAutoIndexAfterFetch', (_evt, { jobId, enabled } = {}) => {
  try {
    return jobRunner.setAutoIndexAfterFetch(jobId, enabled === true)
  } catch (err) {
    console.error('[Jobs] setAutoIndexAfterFetch failed', err)
    return { ok: false, error: String(err && err.message || err) }
  }
})

// Copy file path or its content to clipboard.
ipcMain.handle('jobs:copyFile', (_evt, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' }
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    clipboard.writeText(content)
    return { ok: true, bytes: content.length }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// Stitch multiple text files (transcript + comments) into one clipboard
// payload. Inserts a blank line between sections; missing files are skipped
// silently. Returns bytes of the final blob so the caller can show
// «✓ Скопировано · KB» without a second read.
ipcMain.handle('jobs:copyCombined', (_evt, filePaths) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { ok: false, error: 'No files' }
  }
  try {
    const parts = []
    for (const fp of filePaths) {
      if (!fp) continue
      try {
        if (!fs.existsSync(fp)) continue
        parts.push(fs.readFileSync(fp, 'utf8').trim())
      } catch {}
    }
    if (parts.length === 0) return { ok: false, error: 'No readable files' }
    const blob = parts.join('\n\n') + '\n'
    clipboard.writeText(blob)
    jobRunner.playClipboardSound()
    return { ok: true, bytes: Buffer.byteLength(blob, 'utf8'), parts: parts.length }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

// Open in Sublime if installed; fall back to default editor.
ipcMain.handle('jobs:openExternal', (_evt, filePath) => {
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

ipcMain.handle('sources:list',     (_e, platform) => db.listSources(platform || null))
ipcMain.handle('sources:get',      (_e, id)       => db.getSource(id))
ipcMain.handle('sources:detail',   (_e, id) => ({
  source:        db.getSource(id),
  typeBreakdown: db.itemTypeBreakdown(id),
  senders:       db.senderBreakdown(id),
  coverage:      db.listCoverage(id),
  // Min/max published_at across saved items — UI shows it as a period
  // range so the user sees what slice of history is in the DB without
  // relying on coverage rows (which may have null date_from/date_to
  // for IG/YT where flat-playlist doesn't provide ranges).
  dateRange:     db.itemsDateRange(id),
  // Hide noisy "list refresh" operations — yt_channel_fetch happens every
  // sync and is not what the user means by "история парсинга". Old rows
  // already in DB are filtered out so legacy installs look clean too.
  jobs:          db.listJobsForSource(id)
                   .filter(j => j.type !== 'yt_channel_fetch' && j.type !== 'tk_channel_fetch'),
  // Telegram-only: total comments stored across all posts of this source.
  // 0 for non-TG sources or channels without discussion. UI renders chip in
  // type_breakdown row.
  commentsCount:    db.countCommentsBySource(id),
  // Posts that already have at least one stored comment — used to compute
  // «Дотянуть» availability (posts_total - this length).
  postsWithComments: db.listPostsWithComments(id).length,
}))

function sumExistingFiles(paths) {
  let bytes = 0, present = 0
  for (const p of paths || []) {
    try { bytes += fs.statSync(p).size; present++ } catch { /* missing file — skip */ }
  }
  return { bytes, present, total: (paths || []).length }
}

ipcMain.handle('sources:socialOverview', (_e, id) => {
  try {
    const overview = db.socialSourceOverview(id)
    if (!overview) return { ok: false, error: 'unsupported source' }
    const storage = db.storageBreakdownForSource(id)
    const media = sumExistingFiles(storage.media_paths)
    const transcripts = sumExistingFiles(storage.transcript_paths)
    const dbPayloadBytes = Number(overview.bytes?.db_payload || 0)
    return {
      ok: true,
      ...overview,
      storage: {
        root: jobRunner.LIB_ROOT,
        db_payload: { bytes: dbPayloadBytes },
        media,
        transcripts,
        index: { bytes: storage.index_bytes || 0, vectors: storage.index_vectors || 0 },
        total_bytes: dbPayloadBytes + media.bytes + transcripts.bytes + (storage.index_bytes || 0),
      },
    }
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
ipcMain.handle('sources:storage', (_e, id) => {
  try {
    const b = db.storageBreakdownForSource(id)
    const media = sumExistingFiles(b.media_paths)
    const transcripts = sumExistingFiles(b.transcript_paths)
    return {
      ok: true,
      root: jobRunner.LIB_ROOT,
      text:        { bytes: b.text_bytes },
      index:       { bytes: b.index_bytes, vectors: b.index_vectors },
      media:       media,
      transcripts: transcripts,
      total_bytes: b.text_bytes + b.index_bytes + media.bytes + transcripts.bytes,
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

ipcMain.handle('items:list',   (_e, params) => db.listItems(params))
ipcMain.handle('items:search', (_e, { source_id, query, limit }) =>
  db.searchItems(source_id || null, query, limit || 50))
ipcMain.handle('items:topics', (_e, source_id) => db.listSourceTopics(source_id))
ipcMain.handle('items:typeBreakdown', (_e, { source_id, topic_id }) =>
  db.itemTypeBreakdown(source_id, topic_id ?? null))
ipcMain.handle('items:telegramMediaEstimate', (_e, scope) =>
  db.telegramMediaEstimate(scope || {}))

// Copy the caption(s) of specific saved messages (per-row «копировать» and the
// bulk «копировать N» action in ChatView). The caption already carries any
// appended AI block — appendItemTranscript writes «[голосовое — расшифровка ·
// engine]\n<text>» into the same caption column — so we just read captions by
// external_id and join them chronologically. We deliberately DON'T route this
// through items:assembleCopy: that path is type-gated (a lone voice row with a
// transcript in caption but type='voice' would be dropped by the assembly
// WHERE), whereas here the user explicitly picked exact rows and wants exactly
// their text. Returns {ok, bytes, count}.
ipcMain.handle('items:copyMany', (_e, { source_id, external_ids }) => {
  try {
    if (!source_id || !Array.isArray(external_ids) || external_ids.length === 0) {
      return { ok: false, error: 'no ids', count: 0 }
    }
    const ids = external_ids.map(String)
    const rows = db.getItemsByExternalIds(source_id, ids)
    // Order by published_at so a multi-select copy reads top-to-bottom in
    // chat order, not in click order.
    rows.sort((a, b) => (a.published_at || 0) - (b.published_at || 0))
    const parts = []
    for (const r of rows) {
      const cap = (r.caption || '').trim()
      if (cap) parts.push(cap)
    }
    if (parts.length === 0) return { ok: false, error: 'empty', count: 0 }
    const blob = parts.join('\n\n') + '\n'
    clipboard.writeText(blob)
    jobRunner.playClipboardSound()
    return { ok: true, bytes: Buffer.byteLength(blob, 'utf8'), count: parts.length }
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
ipcMain.handle('items:assembleEstimate', (_e, scope) => {
  const base = db.assemblyEstimate(scope)
  // Header overhead per row: "--- DD.MM.YY HH:MM Sender [tag] ---" + body +
  // blank line. Header itself is ~30-60 bytes; the format is stable so we
  // budget 50 B per item. Adds <1.5% to the visible total at typical chat
  // sizes — much closer to the real clipboard payload than the old
  // "char-count = bytes" estimate.
  const headerBytes = base.count * 50

  // Voice/video bodies live on disk — sum file sizes for accuracy.
  let transcriptBytes = 0
  try {
    const rows = db.assemblyTranscriptPaths(scope)
    for (const r of rows) {
      try {
        if (r.transcript_path) transcriptBytes += fs.statSync(r.transcript_path).size
      } catch { /* missing file ignored — assembleText falls back to a stub */ }
    }
  } catch (err) {
    console.error('[Assemble] transcript stat failed', err)
  }

  const bytes = (base.caption_bytes || 0) + transcriptBytes + headerBytes
  // Token estimate. We don't ship a real tokenizer (tiktoken would pull a
  // multi-MB native module + table for one panel), so we use the
  // industry-standard heuristic: ~1 token ≈ 3 UTF-8 bytes for mixed
  // Russian/English chat text. Real Claude/GPT tokenization for Cyrillic
  // sits in the 2.7-3.3 B/token range; 3 is a safe middle. Surface it as
  // "~N токенов" so the user knows it's an approximation.
  const tokens = Math.round(bytes / 3)
  return { ...base, bytes, tokens }
})

ipcMain.handle('items:assembleCopy', (_e, scope) => {
  try {
    const rows = db.assemblyFetch(scope)
    const commentsByPostId = _buildCommentsMap(scope, rows)
    const chatLabelBySourceId = _buildChatLabelMap(scope)
    const text = assembleText(rows, {
      showTopicHeaders: scope?.topic_id == null,
      commentsByPostId,
      chatLabelBySourceId,
    })
    if (!text) return { ok: false, error: 'empty', count: 0 }
    clipboard.writeText(text)
    jobRunner.playClipboardSound()
    const bytes = Buffer.byteLength(text, 'utf8')
    return { ok: true, count: rows.length, bytes, tokens: Math.round(bytes / 3) }
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
    const rows = db.assemblyFetch(scope)
    const commentsByPostId = _buildCommentsMap(scope, rows)
    const chatLabelBySourceId = _buildChatLabelMap(scope)
    const text = assembleText(rows, {
      showTopicHeaders: scope?.topic_id == null,
      commentsByPostId,
      chatLabelBySourceId,
    })
    if (!text) return { ok: false, error: 'empty' }
    const win = BrowserWindow.getAllWindows()[0]
    const res = await dialog.showSaveDialog(win, {
      defaultPath: defaultName || 'export.txt',
      filters: [{ name: 'Text', extensions: ['txt'] }],
    })
    if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' }
    fs.writeFileSync(res.filePath, text, 'utf8')
    const bytes = Buffer.byteLength(text, 'utf8')
    return { ok: true, path: res.filePath, count: rows.length,
             bytes, tokens: Math.round(bytes / 3) }
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
ipcMain.handle('sources:maxExternalId', (_e, id) => db.maxExternalId(id))

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
  registerAssetProtocol()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  // HTTP-bridge для browser-extension (см. electron/browser-bridge.js).
  // Только loopback, фиксированный порт 53127. Падение/занятость порта не
  // ломает приложение — расширение просто покажет «sc-desktop не запущен».
  try {
    const { startServer } = require('./browser-bridge')
    startServer({ jobRunner })
  } catch (err) {
    console.log(`[BrowserBridge] failed to start: ${err?.message || err}`)
  }
  startTelegramAutoScheduler({ db, jobRunner, indexJob })
  telegramBot.start()
})

app.on('before-quit', () => {
  stopTelegramAutoScheduler()
  telegramBot.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
