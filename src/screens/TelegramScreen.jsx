import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Settings, RotateCw, Plus, Image, Video, Mic, FileText, Copy, Trash2, X, TriangleAlert, UserRound, Loader2, Cpu, ChevronDown } from 'lucide-react'
import { openSettings, pushScreen, useStore } from '../lib/store'
import { useSources, refreshSources } from '../lib/sources'
import { useJobs } from '../lib/jobs'
import { useInvalidator, invalidate } from '../lib/dataBus'
import PlatformLogo from '../components/PlatformLogo'
import Avatar from '../components/Avatar'
import Checkbox from '../components/Checkbox'
import TelegramScopeFields, {
  FOLDER_RANGE_MODES, presetDaysOf, presetIdForDays,
} from '../components/TelegramScopeFields'
import { CONTENT_TYPES, defaultContent } from '../components/TelegramTypesPopover'
import { formatCopyToast, formatTokens, formatBytes } from '../lib/formatTokens'

// Default range when no folder-saved value exists yet — last week is the
// most common catch-up window the user actually picks. Centralised default
// so TelegramScreen and the persistence layer agree.
const DEFAULT_RANGE_MODE = 'last_week'

const DIALOG_CATEGORY_TABS = [
  { id: 'all',      label: 'Все',    title: 'Все Telegram-источники в текущей папке или сессии' },
  { id: 'personal', label: 'Личные чаты', title: 'Личные переписки: Telethon User' },
  { id: 'channels', label: 'Каналы', title: 'Каналы: Telethon Channel с broadcast=true' },
  { id: 'chats',    label: 'Чаты',   title: 'Группы и супергруппы: Telethon Chat или megagroup' },
  { id: 'auto',     label: 'auto',    title: 'Чаты, где включён auto-pull или auto-index', icon: 'auto' },
]

const AUTO_TYPE_LABELS = {
  text: 'Text',
  voice: 'Voice',
  video: 'Video',
  photo: 'Photo',
  docs: 'Docs',
  comments: 'Comments',
}

function telegramDialogKind(source) {
  try {
    const meta = JSON.parse(source?.meta_json || '{}')
    return String(meta?.kind || '').toLowerCase()
  } catch {
    return ''
  }
}

function telegramDialogCategory(source) {
  const kind = telegramDialogKind(source)
  if (kind === 'user') return 'personal'
  if (kind === 'channel') return 'channels'
  if (kind === 'group' || kind === 'chat') return 'chats'
  return 'unknown'
}

function telegramSourceMeta(source) {
  try { return JSON.parse(source?.meta_json || '{}') || {} }
  catch { return {} }
}

function telegramAutoSettings(source) {
  const raw = telegramSourceMeta(source).tg_auto
  if (!raw || typeof raw !== 'object') {
    return { pull: false, index: false, types: [], engine: 'assemblyai' }
  }
  return {
    pull: !!raw.pull || !!raw.index,
    index: !!raw.index,
    types: Array.isArray(raw.types) ? raw.types : [],
    engine: raw.engine || 'assemblyai',
  }
}

function telegramHasAuto(source) {
  const s = telegramAutoSettings(source)
  return s.pull || s.index
}

function autoTypeSummary(content) {
  const picked = Object.keys(content || {}).filter(k => content[k])
  if (picked.length === 0) return 'Pick types'
  return picked.map(k => AUTO_TYPE_LABELS[k] || k).join(' + ')
}

// `from_date` for tg_fetch_json.py. Format `dd.mm.yyyy` (00:00 implicit).
function daysToDateStr(days) {
  if (!days || days <= 0) return null
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}

// dd.mm.yy / dd.mm.yyyy (with optional HH:MM) → unix seconds. Same shape
// CopySavedPanel.parseUserDate accepts; trimmed copy here to keep the
// scope-builder local to this screen.
function parseUserDate(s) {
  const v = (s || '').trim()
  if (!v) return null
  const re = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?$/
  const m = v.match(re)
  if (!m) return null
  const d = +m[1], mo = +m[2] - 1
  let y = +m[3]; if (y < 100) y += 2000
  const h = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0
  return Math.floor(new Date(y, mo, d, h, mi).getTime() / 1000)
}

// Resolve `range` (the scope-fields state) into `{ mode, date_from, date_to,
// dateStr }`. dateStr is dd.mm.yyyy for the Python CLI; mode/date_from are
// the SQL shape that itemsAssemble* accepts. Returns null mode for `all`.
function resolveRangeForFolder(range) {
  if (range.mode === 'all') return { mode: null, date_from: null, dateStr: null }
  const presetDays = presetDaysOf(range.mode)
  if (presetDays != null) {
    return {
      mode: 'from_date',
      date_from: Math.floor((Date.now() - presetDays * 86400 * 1000) / 1000),
      dateStr: daysToDateStr(presetDays),
    }
  }
  if (range.mode === 'date_range') {
    // Unified mode: first date required, second optional.
    // - both filled  → SQL date_range, fetch via from_date + --date-to
    // - only first   → from_date / open upper bound
    const a = parseUserDate(range.fromDate)
    if (!a) return { mode: null }
    const b = range.toDate ? parseUserDate(range.toDate) : null
    if (b) {
      return {
        mode: 'date_range',
        date_from: a,
        date_to: b + 86400 - 1,
        dateStr: range.fromDate,
        dateToStr: range.toDate,
      }
    }
    return { mode: 'from_date', date_from: a, dateStr: range.fromDate }
  }
  return { mode: null }
}

// localStorage key — last active tab on TelegramScreen. Restored on mount
// when no explicit `payload.folderId` is passed. `0` is reserved for "Все
// чаты" (which has no folder row); we serialise `null` as 'all'.
const LAST_TAB_KEY = 'sc-telegram-last-tab'

export default function TelegramScreen({ payload }) {
  // Tab init order:
  //   1. explicit payload.folderId (clicked from another screen / Activity)
  //   2. localStorage last-active (returning to Telegram after navigating away)
  //   3. null = «Все чаты»
  const initialTabId = (() => {
    if (payload?.folderId) return payload.folderId
    try {
      const v = localStorage.getItem(LAST_TAB_KEY)
      if (v === 'all' || v == null) return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    } catch { return null }
  })()

  const allSources = useSources('telegram')
  const [folders, setFolders]   = useState([])
  const [activeTabId, setActiveTabId] = useState(initialTabId)
  const [dialogCategory, setDialogCategory] = useState('all')

  // ── Сессии ──────────────────────────────────────────────────────────
  // Чаты и папки принадлежат конкретному аккаунту. Переключатель сверху
  // меняет АКТИВНУЮ сессию (ту самую, что в ~/.config/sc/settings.json и
  // которой пользуются все tg-скрипты) — страница показывает только её
  // папки и чаты. Один источник правды, никакого view-only фильтра,
  // который бы расходился с тем, куда реально пойдёт парсинг.
  const [sessions, setSessions] = useState([])
  const [activeSession, setActiveSession] = useState(null)
  // Имя переключаемой сессии (а не boolean): спиннер крутится ТОЧЕЧНО на той
  // кнопке, которую нажали, остальные просто блокируются. null = простой.
  const [switchingTo, setSwitchingTo] = useState(null)
  useEffect(() => {
    let alive = true
    window.api?.tgListSessions?.().then(r => {
      if (!alive || !r) return
      setSessions(r.sessions || [])
      setActiveSession(r.active || null)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  async function switchSession(name) {
    if (!name || name === activeSession || switchingTo) return
    setSwitchingTo(name)
    try {
      await window.api.tgSetActiveSession(name)
      setActiveSession(name)
      // Папки другой сессии — текущий folder-таб больше не валиден.
      setActiveTabId(null)
      setSelectedIds(new Set())
      invalidate('folders')
      // await — спиннер держится до РЕАЛЬНОГО окончания перезагрузки 300+
      // источников (с коррелированными COUNT по items), а не до записи
      // settings.json. Иначе кнопка «отвисала» мгновенно, хотя список ещё
      // секунду перетряхивался — выглядело как «ничего не происходит».
      await refreshSources()
    } catch (err) {
      console.error('[TelegramScreen] switchSession failed', err)
    } finally {
      setSwitchingTo(null)
    }
  }

  // Persist active tab on every change so a navigate-away → return lands
  // on the same folder. Stored as 'all' for null, otherwise the numeric id.
  useEffect(() => {
    try {
      localStorage.setItem(LAST_TAB_KEY,
        activeTabId == null ? 'all' : String(activeTabId))
    } catch {}
  }, [activeTabId])
  const [folderSources, setFolderSources] = useState([])
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  // Range state — same shape as TelegramScopeFields' default. Folder-side
  // we only persist `mode` (a preset id, or 'all'/'from_date'/...) under
  // default_period_days for back-compat: legacy rows hold day-counts
  // (1, 7, 30, 0=all). Migration is one-way at load time — we map days→id
  // when reading, and never write days back (always the new mode-id format
  // in default_period_days... no, that breaks readers; we still emit days
  // for preset modes, and -1 for non-preset modes which old readers will
  // treat as "all" — same fallback as before).
  const [range, setRange] = useState({
    mode: DEFAULT_RANGE_MODE, lastN: '500', fromDate: '', toDate: '',
    url1: '', url2: '', direction: 'newest',
  })
  // Content types + engine — defaults match TelegramConfigForm
  // (text-only, AssemblyAI). Stored alongside the range per-folder; `Все
  // чаты` mode keeps a session-only copy.
  const [content, setContent] = useState(defaultContent)
  const [engine, setEngine]   = useState('assemblyai')
  const [withComments, setWithComments] = useState(false)
  const [autoContent, setAutoContent] = useState(defaultContent)
  const [autoEngine, setAutoEngine] = useState('assemblyai')
  const [autoTypesOpen, setAutoTypesOpen] = useState(false)
  const [autoToast, setAutoToast] = useState(null)
  // Live stats for the *current selection × period × types* — what would
  // land in clipboard if you hit «Скопировать» right now. Updated on a
  // 200ms debounce; query is `assemblyEstimate({source_ids, types,
  // mode, date_from})` which is one indexed COUNT per source — cheap.
  const [stats, setStats]     = useState(null)
  const [busy, setBusy] = useState(false)
  const [copyToast, setCopyToast] = useState(null)
  const [activeJobId, setActiveJobId] = useState(null)
  const [activeSnap, setActiveSnap] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [refreshNote, setRefreshNote] = useState(null)
  const [refreshJobId, setRefreshJobId] = useState(null)

  // Pick up the live `tg_folder_refresh` job — could be ours (just kicked
  // off) or one started by another window during this session. Either way
  // the spinner reflects real backend state, not local-only optimism.
  const allJobs = useJobs()
  const refreshJob = useMemo(() => {
    return allJobs.find(j =>
      j.type === 'tg_folder_refresh' &&
      (j.status === 'running' || j.id === refreshJobId)
    ) || null
  }, [allJobs, refreshJobId])
  const refreshing = refreshJob?.status === 'running'

  const sourcesVer  = useInvalidator('sources')
  const foldersVer  = useInvalidator('folders')

  // Re-pull folders list when something invalidates it. Scoped to the
  // active session — folders of the other account stay off-screen.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await window.api.folderList(activeSession)
        if (!cancelled) setFolders(list || [])
      } catch (err) {
        console.error('[TelegramScreen] folderList failed', err)
      }
    })()
    return () => { cancelled = true }
  }, [foldersVer, activeSession])

  // Re-pull active folder's sources when tab changes or sources invalidate.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (activeTabId == null) {
        setFolderSources([])
        return
      }
      try {
        const list = await window.api.folderListSources(activeTabId)
        if (!cancelled) setFolderSources(list || [])
      } catch (err) {
        console.error('[TelegramScreen] folderListSources failed', err)
      }
    })()
    return () => { cancelled = true }
  }, [activeTabId, foldersVer, sourcesVer])

  // When activeTabId changes load that folder's saved period + types.
  // Engine isn't persisted yet — staying in session memory is fine; users
  // pick once and almost never rotate it.
  //
  // Persistence shape note: `default_period_days` is a legacy integer column
  // (days back; 0 = all). Map it to a preset mode id on read, fall back to
  // 'all' for 0 and to the default for any unfamiliar value. We still WRITE
  // back as days for preset-modes (so legacy readers stay happy); manual
  // 'from_date'/'date_range' are session-only — no schema migration.
  useEffect(() => {
    function resetToDefault() {
      setRange(r => ({ ...r, mode: DEFAULT_RANGE_MODE }))
      setContent(defaultContent())
    }
    if (activeTabId == null) { resetToDefault(); return }
    const f = folders.find(x => x.id === activeTabId)
    if (!f) return
    if (Number.isFinite(f.default_period_days)) {
      const days = f.default_period_days
      const presetId = days === 0 ? 'all' : presetIdForDays(days)
      if (presetId) {
        setRange(r => ({ ...r, mode: presetId }))
      } else if (days > 0) {
        // Folder was saved with a non-preset window (legacy: 1/3/14/30/90)
        // before we trimmed the dropdown to just `last_week`. Translate to
        // a date_range with empty upper bound — same effect as the old
        // standalone `from_date` mode that's been merged into date_range.
        const d = new Date(Date.now() - days * 86400 * 1000)
        const pad = n => String(n).padStart(2, '0')
        const dd = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
        setRange(r => ({ ...r, mode: 'date_range', fromDate: dd, toDate: '' }))
      }
    }
    if (f.default_types_json) {
      try {
        const arr = JSON.parse(f.default_types_json)
        if (Array.isArray(arr)) {
          const next = defaultContent()
          // Reset every type, then turn on what's saved.
          for (const k of Object.keys(next)) next[k] = false
          for (const k of arr) if (k in next) next[k] = true
          setContent(next)
        }
      } catch {}
    }
  }, [activeTabId, folders])

  // Subscribe to live job updates so the per-chat list flips current/done.
  useEffect(() => {
    if (!window.api?.onJobUpdate) return
    const unsub = window.api.onJobUpdate(j => {
      if (!j) return
      if (activeJobId != null && j.id === activeJobId) {
        setActiveSnap(j)
        if (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') {
          // Folder fetch finished — clear and let the user copy.
          setBusy(false)
          // Bump folders so last_fetched_at refreshes.
          invalidate('folders')
        }
      }
    })
    return unsub
  }, [activeJobId])

  // Reset selection when switching folder tabs or dialog-type tabs — hidden
  // selected rows would make the parse/copy counters ambiguous.
  useEffect(() => {
    setSelectedIds(new Set())
  }, [activeTabId, dialogCategory])

  // «Все чаты» = чаты ВЫБРАННОЙ сессии. Legacy-строки без привязки
  // (tg_session NULL) показываем тоже — они дозаполнятся при следующем
  // fetch/refresh; прятать их совсем = «у меня пропали чаты».
  // Конфликтные (трогались из разных сессий) видимы в любой сессии —
  // юзер должен их видеть, чтобы запинить.
  const sessionScopedAll = useMemo(() => {
    if (!activeSession) return allSources
    return allSources.filter(s =>
      s.tg_session == null
      || s.tg_session === activeSession
      || Boolean(s.tg_session_conflict)
    )
  }, [allSources, activeSession])

  const baseVisibleSources = useMemo(() => {
    if (activeTabId != null) return folderSources
    return sessionScopedAll
  }, [activeTabId, sessionScopedAll, folderSources])

  const dialogCategoryCounts = useMemo(() => {
    const counts = { all: baseVisibleSources.length, personal: 0, channels: 0, chats: 0, auto: 0 }
    for (const s of baseVisibleSources) {
      const category = telegramDialogCategory(s)
      if (category in counts) counts[category] += 1
      if (telegramHasAuto(s)) counts.auto += 1
    }
    return counts
  }, [baseVisibleSources])

  const visibleSources = useMemo(() => {
    if (dialogCategory === 'all') return baseVisibleSources
    if (dialogCategory === 'auto') return baseVisibleSources.filter(telegramHasAuto)
    return baseVisibleSources.filter(s => telegramDialogCategory(s) === dialogCategory)
  }, [baseVisibleSources, dialogCategory])

  // Inline chat-filter. Lives in the chat-list header bar; same input is
  // used for "Все чаты" and inside any folder. Cleared when the active
  // folder tab changes (different folders → different cohort, stale query
  // would silently hide rows the user just clicked over to).
  const [chatQuery, setChatQuery] = useState('')
  useEffect(() => { setChatQuery('') }, [activeTabId])

  const filteredSources = useMemo(() => {
    const q = chatQuery.trim().toLowerCase()
    if (!q) return visibleSources
    return visibleSources.filter(s => {
      const handle = (s.handle || '').toLowerCase()
      const title  = (s.display_name || '').toLowerCase()
      return handle.includes(q) || title.includes(q)
    })
  }, [visibleSources, chatQuery])

  // "Select all" + count operate on the *filtered* cohort — otherwise the
  // user sees "выбрано 3 из 12" while only 5 rows are on screen, which is
  // confusing. Same for toggleAll: it adds/removes only what the user
  // currently sees.
  const allSelected = filteredSources.length > 0
    && filteredSources.every(s => selectedIds.has(s.id))
  const someSelected = filteredSources.some(s => selectedIds.has(s.id)) && !allSelected

  function toggleAll() {
    if (allSelected) {
      const next = new Set(selectedIds)
      for (const s of filteredSources) next.delete(s.id)
      setSelectedIds(next)
    } else {
      const next = new Set(selectedIds)
      for (const s of filteredSources) next.add(s.id)
      setSelectedIds(next)
    }
  }

  function toggleOne(id) {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  // The selected ids drive both "Спарсить" and "Скопировать" — same
  // mental model as picker'ы YT/IG. Copy works on already-saved items
  // even without re-fetch (the user's main fast path: «обновил утром,
  // вечером ещё раз скопировал, без сетевого вызова»).
  const selectedSources = visibleSources.filter(s => selectedIds.has(s.id))
  const selectionCount = selectedSources.length

  const autoPickedTypes = useMemo(
    () => Object.keys(autoContent).filter(k => autoContent[k]),
    [autoContent],
  )
  const selectedAuto = useMemo(() => {
    const rows = selectedSources.map(telegramAutoSettings)
    const pullCount = rows.filter(r => r.pull).length
    const indexCount = rows.filter(r => r.index).length
    return {
      anyPull: rows.some(r => r.pull),
      allPull: rows.length > 0 && rows.every(r => r.pull),
      pullCount,
      anyIndex: rows.some(r => r.index),
      allIndex: rows.length > 0 && rows.every(r => r.index),
      indexCount,
    }
  }, [selectedSources])
  const autoPullActionCount = selectionCount === 0
    ? null
    : selectedAuto.allPull ? `-${selectedAuto.pullCount}` : `+${selectionCount - selectedAuto.pullCount}`
  const autoIndexActionCount = selectionCount === 0
    ? null
    : selectedAuto.allIndex ? `-${selectedAuto.indexCount}` : `+${selectionCount - selectedAuto.indexCount}`

  // Stable identity of the picked types — array order preserves toggling
  // semantics (used both for SQL filter and for the assembleEstimate dep).
  const pickedTypes = useMemo(
    () => Object.keys(content).filter(k => content[k] && k !== 'comments'),
    [content],
  )

  // Resolve the current range state into the assembleEstimate scope shape.
  // `mode === null` means «no time constraint» (all-history) — assemble
  // treats missing date_from the same way.
  const resolved = useMemo(() => resolveRangeForFolder(range), [
    range.mode, range.fromDate, range.toDate,
  ])

  // Live size estimate: what would copy if the user clicked «📋 Скопировать»
  // right now, given the current (selection, range, types). Debounced to
  // 200ms — paste/toggle bursts shouldn't hammer SQLite, but a single click
  // shows numbers within a couple of frames. Cancelled when the deps change
  // before the timeout fires (no race on stale results).
  useEffect(() => {
    if (selectionCount === 0 || pickedTypes.length === 0) {
      setStats(null)
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const res = await window.api.itemsAssembleEstimate({
          source_ids: selectedSources.map(s => s.id),
          types:      pickedTypes,
          mode:       resolved.mode || 'all',
          date_from:  resolved.date_from || null,
          date_to:    resolved.date_to || null,
        })
        if (!cancelled) setStats(res || null)
      } catch (err) {
        if (!cancelled) setStats(null)
      }
    }, 200)
    return () => { cancelled = true; clearTimeout(t) }
  }, [
    selectionCount,
    // join id list so identity-of-Set doesn't matter
    selectedSources.map(s => s.id).join(','),
    resolved.mode, resolved.date_from, resolved.date_to,
    pickedTypes.join(','),
  ])

  // Re-pull every named folder from Telegram. Spawns a real `tg_folder_refresh`
  // job — Activity panel renders live progress and history persists. The
  // button itself reflects job state through `refreshJob` (no parallel
  // local 'refreshing' flag).
  const onRefreshAll = useCallback(async () => {
    if (refreshing) return
    setRefreshNote(null)
    try {
      const res = await window.api.tgRefreshFolders()
      if (!res?.ok) {
        setRefreshNote({ kind: 'error', text: res?.error || 'Не удалось запустить обновление' })
        return
      }
      setRefreshJobId(res.jobId)
    } catch (err) {
      setRefreshNote({ kind: 'error', text: String(err && err.message || err) })
    }
  }, [refreshing])

  // When the refresh job terminates, post a small toast next to the button
  // and bump caches. Watching `refreshJob.status` flips once on terminal.
  useEffect(() => {
    if (!refreshJob) return
    if (refreshJob.status === 'done' || refreshJob.status === 'error' || refreshJob.status === 'cancelled') {
      const summary = refreshJob.tg_folder_refresh
      if (refreshJob.status === 'done' && summary) {
        const parts = []
        if (summary.synced)  parts.push(`синхронизировано ${summary.synced}`)
        if (summary.removed) parts.push(`удалено ${summary.removed}`)
        setRefreshNote({ kind: 'ok', text: parts.length ? parts.join(' · ') : 'без изменений' })
      } else if (refreshJob.status === 'error') {
        setRefreshNote({ kind: 'error', text: refreshJob.error || 'Ошибка обновления' })
      }
      invalidate('folders')
      invalidate('sources')
      refreshSources()
      const t = setTimeout(() => setRefreshNote(null), 3000)
      return () => clearTimeout(t)
    }
  }, [refreshJob?.id, refreshJob?.status])

  // Persist range-mode change to the folder. "Все чаты" doesn't have a folder
  // row to write to, so no-op there.
  //
  // We persist `default_period_days` (legacy column) only when the picked mode
  // is a preset (its day-count is the natural number to store) or `all` (saved
  // as 0). For manual `from_date`/`date_range` the days don't apply — left
  // untouched on disk; the user re-picks per session, which matches the
  // ephemeral nature of those modes.
  const onRangeChange = useCallback(async (next) => {
    setRange(next)
    if (activeTabId == null) return
    let dbDays = null
    if (next.mode === 'all') dbDays = 0
    else { const d = presetDaysOf(next.mode); if (d != null) dbDays = d }
    if (dbDays == null) return
    try {
      await window.api.folderUpdateParams(activeTabId, { default_period_days: dbDays })
      invalidate('folders')
    } catch {}
  }, [activeTabId])

  // Persist content-type changes the same way. Engine isn't persisted —
  // session-only since users almost never flip it.
  const onContentChange = useCallback((updater) => {
    setContent(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      if (activeTabId != null) {
        const arr = Object.keys(next).filter(k => next[k])
        // Fire and forget — no need to block on this round-trip.
        window.api.folderUpdateParams(activeTabId, {
          default_types_json: JSON.stringify(arr),
        }).catch(() => {})
      }
      return next
    })
  }, [activeTabId])

  async function applyAutoPatch(patch, label) {
    if (selectionCount === 0) return
    try {
      const res = await window.api.sourcesSetTelegramAuto({
        source_ids: selectedSources.map(s => s.id),
        patch,
      })
      if (!res?.ok) {
        setAutoToast({ kind: 'error', text: res?.error || 'auto failed' })
        return
      }
      setAutoToast({ kind: 'ok', text: label })
      invalidate('sources')
      refreshSources()
      setTimeout(() => setAutoToast(null), 2200)
    } catch (err) {
      setAutoToast({ kind: 'error', text: String(err && err.message || err) })
      setTimeout(() => setAutoToast(null), 2600)
    }
  }

  function ensureAutoTypes() {
    if (autoPickedTypes.length > 0) return true
    setAutoTypesOpen(true)
    setAutoToast({ kind: 'error', text: 'Pick types' })
    setTimeout(() => setAutoToast(null), 2200)
    return false
  }

  function onAutoPullClick() {
    if (selectionCount === 0) return
    if (!ensureAutoTypes()) return
    const next = !selectedAuto.allPull
    applyAutoPatch({
      pull: next,
      index: next ? undefined : false,
      types: autoPickedTypes,
      engine: autoEngine,
    }, next ? `auto-pull on · ${selectionCount}` : `auto-pull off · ${selectionCount}`)
  }

  function onAutoIndexClick() {
    if (selectionCount === 0) return
    if (!ensureAutoTypes()) return
    const next = !selectedAuto.allIndex
    applyAutoPatch({
      pull: next ? true : undefined,
      index: next,
      types: autoPickedTypes,
      engine: autoEngine,
    }, next ? `auto-index on · ${selectionCount}` : `auto-index off · ${selectionCount}`)
  }


  async function onFetch() {
    if (selectionCount === 0) return
    if (pickedTypes.length === 0) {
      setCopyToast({ kind: 'error', message: 'Выбери хотя бы один тип' })
      setTimeout(() => setCopyToast(null), 2400)
      return
    }
    setBusy(true)
    setActiveSnap(null)
    try {
      const res = await window.api.folderFetch({
        folder_id:  activeTabId,
        source_ids: selectedSources.map(s => s.id),
        // resolved.mode === null → 'all' (no date_from); presets and manual
        // from_date both end up with a dd.mm.yyyy in dateStr.
        mode:       resolved.dateStr ? 'from_date' : 'all',
        date:       resolved.dateStr,
        // Only forwarded when the user filled the second date field —
        // job-runner pushes it down as --date-to.
        date_to:    resolved.dateToStr || null,
        types:      pickedTypes,
        // Only send engine when transcription is actually requested —
        // tg_fetch_json silently ignores it for non-voice/video chats but
        // surfacing it on the wire only when relevant keeps the params
        // legible in jobs history.
        engine:     (content.voice || content.video) ? engine : null,
      })
      if (!res?.ok) {
        console.error('[TelegramScreen] folderFetch failed', res)
        setBusy(false)
        setActiveJobId(null)
        return
      }
      setActiveJobId(res.jobId)
    } catch (err) {
      console.error('[TelegramScreen] folderFetch threw', err)
      setBusy(false)
    }
  }

  async function onCopy() {
    if (selectionCount === 0) return
    if (pickedTypes.length === 0) {
      setCopyToast({ kind: 'error', message: 'Выбери хотя бы один тип' })
      setTimeout(() => setCopyToast(null), 2400)
      return
    }
    try {
      const res = await window.api.itemsAssembleCopy({
        source_ids: selectedSources.map(s => s.id),
        types:      pickedTypes,
        mode:       resolved.mode || 'all',
        date_from:  resolved.date_from || null,
        date_to:    resolved.date_to || null,
        with_comments: !!withComments,
      })
      if (!res?.ok) {
        setCopyToast({ kind: 'error', message: res?.error || 'Нет данных' })
        return
      }
      setCopyToast({
        kind: 'ok',
        message: formatCopyToast({
          bytes:  res.bytes,
          count:  res.count,
          tokens: res.tokens,
        }),
      })
      setTimeout(() => setCopyToast(null), 2400)
    } catch (err) {
      setCopyToast({ kind: 'error', message: String(err && err.message || err) })
    }
  }

  // Live progress shape from the umbrella job.
  const progress = activeSnap?.tg_folder
  const inflight = busy && activeSnap?.status === 'running'

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto px-8 pt-8 pb-12">
        {/* Header — platform name + session switch + settings ⚙ */}
        <div className="flex items-center gap-3 mb-6">
          <PlatformLogo platform="telegram" size={22} />
          <h1 className="text-2xl font-semibold">Telegram</h1>
          {/* Переключатель сессий — сегменты по числу session-файлов.
              Активная = та, которой реально пойдёт парсинг (settings.json).
              Папки и «Все чаты» ниже отфильтрованы по ней. */}
          {sessions.length > 1 && (
            <div className="flex items-center rounded-md border border-zinc-800 overflow-hidden ml-2">
              {sessions.map(sess => {
                // me = живая identity; me_cached = последняя известная для
                // отозванных сессий (см. tg_sessions_ndjson sidecar-meta).
                const who = sess.me || sess.me_cached
                const label = who?.username
                  ? `@${who.username}`
                  : (who?.first_name || sess.name)
                const isActive = sess.name === activeSession
                const isSwitching = switchingTo === sess.name
                return (
                  <button
                    key={sess.name}
                    onClick={() => switchSession(sess.name)}
                    disabled={!!switchingTo}
                    aria-busy={isSwitching}
                    className={`px-2.5 py-1 flex items-center gap-1.5 ${
                      isActive
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900'
                    } ${isSwitching ? '' : 'disabled:opacity-60'}`}
                    style={{ fontSize: '13px' }}
                    title={sess.authorized === false
                      ? `${label} · сессия не авторизована`
                      : `Переключить активную сессию на ${label} (${sess.name})`}
                  >
                    {/* UserRound ↔ Loader2 — оба 12px, ширина кнопки не
                        дёргается при появлении спиннера (anti-jitter). */}
                    {isSwitching
                      ? <Loader2 size={12} className="animate-spin shrink-0" />
                      : <UserRound size={12} className="shrink-0" />}
                    <span className="truncate max-w-[140px]">{label}</span>
                    {sess.authorized === false && !isSwitching && (
                      <TriangleAlert size={12} className="text-amber-400 shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>
          )}
          <span className="ml-auto flex items-center gap-2">
            {refreshing && refreshJob?.tg_folder_refresh && (
              <span className="text-xs text-zinc-500 tabular-nums">
                {refreshJob.tg_folder_refresh.done_folders || 0}
                {refreshJob.tg_folder_refresh.total_folders
                  ? `/${refreshJob.tg_folder_refresh.total_folders}`
                  : ''}{' '}
                {refreshJob.tg_folder_refresh.current_title
                  ? `· ${refreshJob.tg_folder_refresh.current_title}`
                  : '…'}
              </span>
            )}
            {!refreshing && refreshNote && (
              <span
                className={`text-xs ${refreshNote.kind === 'ok' ? 'text-emerald-400' : 'text-red-300'}`}
              >{refreshNote.text}</span>
            )}
            <button
              onClick={onRefreshAll}
              disabled={refreshing}
              title="Подтянуть состав всех папок из Telegram"
              className={`text-zinc-500 hover:text-zinc-200 ${refreshing ? 'animate-spin' : ''} disabled:text-zinc-700`}
            ><RotateCw size={16} /></button>
            <button
              onClick={() => openSettings('telegram')}
              title="Настройки Telegram"
              className="text-zinc-500 hover:text-zinc-200"
            ><Settings size={18} /></button>
          </span>
        </div>

        {/* Tabs row: All chats + folders + add */}
        <div className="flex items-center gap-2 flex-wrap mb-5 pb-3 border-b border-zinc-800">
          <Tab
            active={activeTabId == null}
            onClick={() => setActiveTabId(null)}
            label="Все чаты"
            count={sessionScopedAll.length}
          />
          {folders.map(f => (
            <Tab
              key={f.id}
              active={activeTabId === f.id}
              onClick={() => setActiveTabId(f.id)}
              label={f.title}
              count={f.sources_count || 0}
            />
          ))}
          <button
            onClick={() => setAddOpen(v => !v)}
            title="Добавить папку из Telegram"
            className="ml-auto text-zinc-500 hover:text-zinc-200 flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-zinc-900"
          >
            <Plus size={14} />
            <span style={{ fontSize: '13px' }}>добавить папку</span>
          </button>
        </div>

        {addOpen && (
          <AddFolderForm
            onClose={() => setAddOpen(false)}
            onAdded={(folderId) => {
              setAddOpen(false)
              invalidate('folders')
              invalidate('sources')
              setActiveTabId(folderId)
            }}
          />
        )}

        {/* Scope-fields — same range/types/comments controls as the
            SourceDetail copy panel, but rendered inline (no toggle). The
            range select uses FOLDER_RANGE_MODES (presets + manual date,
            no last_n / between / single — those don't apply across N
            chats). Engine row appears whenever voice/video is on. */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 mb-3">
          <TelegramScopeFields
            use="copy"
            rangeModes={FOLDER_RANGE_MODES}
            range={range} onRangeChange={onRangeChange}
            content={content} onContentChange={onContentChange}
            engine={engine} onEngineChange={setEngine}
            showEngine={true}
            withComments={withComments} onWithCommentsChange={setWithComments}
            // Folder mode collapses topics across N chats — picker's
            // off the table; pass null/no-op so the row hides.
            topics={null}
            topicId={null} onTopicIdChange={() => {}}
            // commentsCount is per-source; folder-side we don't aggregate
            // it (could in future). null = «unknown», keeps toggle enabled.
            commentsCount={null}
          />
        </div>

        {/* Action buttons row — sits BELOW the scope-fields panel so the
            buttons aren't competing with the form for the eye. */}
        <div className="flex items-center gap-3 mb-2">
          <span className="ml-auto flex items-center gap-2">
            <button
              onClick={onFetch}
              disabled={selectionCount === 0 || inflight}
              className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white"
              style={{ fontSize: '14px' }}
            >
              {inflight && progress
                ? `Парсю ${progress.done_chats || 0}/${progress.total_chats || selectionCount}…`
                : `Спарсить (${selectionCount})`}
            </button>
            <button
              onClick={onCopy}
              disabled={selectionCount === 0}
              className={`px-3 py-1.5 rounded-md border min-w-[220px] text-center ${
                copyToast?.kind === 'ok'
                  ? 'border-emerald-700 bg-emerald-900/40 text-emerald-200'
                  : copyToast?.kind === 'error'
                    ? 'border-red-700 bg-red-900/30 text-red-200'
                    : 'border-zinc-700 bg-zinc-900 hover:border-zinc-500 text-zinc-200 disabled:text-zinc-600 disabled:hover:border-zinc-700'
              }`}
              style={{ fontSize: '14px' }}
            >
              {copyToast?.message || (
                <>
                  <span className="inline-flex items-center justify-center gap-1.5"><Copy size={14} />Скопировать ({selectionCount})</span>
                  {stats && stats.tokens > 0 && (
                    <span className="text-zinc-500 ml-2">· ~{formatTokens(stats.tokens)}</span>
                  )}
                </>
              )}
            </button>
          </span>
        </div>

        {/* Live stats — what would copy right now. Stays empty for empty
            selection / no chosen types so we don't show a stale row. */}
        <div className="h-5 mb-3 text-zinc-500" style={{ fontSize: '13px' }}>
          {stats ? (
            stats.count > 0 ? (
              <>
                <span className="text-zinc-300 tabular-nums">{stats.count}</span> сообщ.
                {' · '}
                <span className="tabular-nums">~{formatTokens(stats.tokens)}</span> токенов
                {' · '}
                <span className="tabular-nums">{formatBytes(stats.bytes)}</span>
                {(content.voice || content.video) && (
                  <span className="text-zinc-600 ml-2">
                    (только сохранённые транскрипты — голосовые без транскрипта пока не считаются)
                  </span>
                )}
              </>
            ) : (
              <span>0 сообщ. в выборке — поменяй период или типы</span>
            )
          ) : selectionCount === 0
              ? <span>выбери чаты слева — увидишь сразу сколько в них уже сохранено</span>
              : <span className="text-zinc-700">…</span>}
        </div>

        {/* Chat list */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950">
          {baseVisibleSources.length === 0 ? (
            <div className="p-6 text-zinc-500 italic" style={{ fontSize: '14px' }}>
              {activeTabId == null
                ? 'Пока нет ни одного Telegram-источника. Запросить новый можно через Home — пастишь @канал, ссылку или название.'
                : 'В этой папке нет чатов.'}
            </div>
          ) : (
            <>
              <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-2 overflow-x-auto">
                {DIALOG_CATEGORY_TABS.map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setDialogCategory(tab.id)}
                    title={tab.title}
                    className={`shrink-0 px-2.5 py-1 rounded-md flex items-center gap-1.5 ${
                      dialogCategory === tab.id
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900'
                    }`}
                    style={{ fontSize: '13px' }}
                  >
                    {tab.icon === 'auto' && <RotateCw size={13} className="shrink-0" />}
                    <span>{tab.label}</span>
                    <span className={dialogCategory === tab.id ? 'text-zinc-300' : 'text-zinc-600'}>
                      {dialogCategoryCounts[tab.id] || 0}
                    </span>
                  </button>
                ))}
              </div>
              <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={toggleAll}
                  size="sm"
                />
                <span className="text-zinc-500 shrink-0" style={{ fontSize: '13px' }}>
                  {allSelected
                    ? `все выбраны · ${filteredSources.length}`
                    : someSelected
                      ? `выбрано ${selectionCount} из ${filteredSources.length}`
                      : chatQuery
                        ? `найдено ${filteredSources.length} из ${visibleSources.length}`
                        : `всего ${visibleSources.length}`}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <AutoActionButton
                    active={selectedAuto.allPull}
                    mixed={!selectedAuto.allPull && selectedAuto.anyPull}
                    disabled={selectionCount === 0}
                    onClick={onAutoPullClick}
                    icon={<RotateCw size={13} />}
                    label="auto-pull"
                    actionCount={autoPullActionCount}
                  />
                  <AutoActionButton
                    active={selectedAuto.allIndex}
                    mixed={!selectedAuto.allIndex && selectedAuto.anyIndex}
                    disabled={selectionCount === 0}
                    onClick={onAutoIndexClick}
                    icon={<Cpu size={13} />}
                    label="auto-index"
                    actionCount={autoIndexActionCount}
                  />
                  <AutoTypesButton
                    content={autoContent}
                    onContentChange={setAutoContent}
                    engine={autoEngine}
                    onEngineChange={setAutoEngine}
                    open={autoTypesOpen}
                    onOpenChange={setAutoTypesOpen}
                  />
                  {autoToast && (
                    <span
                      className={`text-xs ${autoToast.kind === 'ok' ? 'text-emerald-400' : 'text-amber-300'}`}
                    >{autoToast.text}</span>
                  )}
                </div>
                <div className="ml-auto relative w-56 max-w-full">
                  <input
                    type="text"
                    value={chatQuery}
                    onChange={e => setChatQuery(e.target.value)}
                    placeholder="Поиск по чатам…"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-md pl-2.5 pr-7 py-1 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
                    style={{ fontSize: '13px' }}
                    onKeyDown={e => { if (e.key === 'Escape') setChatQuery('') }}
                  />
                  {chatQuery && (
                    <button
                      type="button"
                      onClick={() => setChatQuery('')}
                      className="inline-flex items-center justify-center absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
                      style={{ fontSize: '14px', lineHeight: 1 }}
                      title="Очистить"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
              {visibleSources.length === 0 ? (
                <div className="p-6 text-zinc-500 italic" style={{ fontSize: '14px' }}>
                  В этой вкладке нет чатов.
                </div>
              ) : filteredSources.length === 0 ? (
                <div className="p-6 text-zinc-500 italic" style={{ fontSize: '14px' }}>
                  Ничего не найдено по запросу «{chatQuery}».
                </div>
              ) : (
              <ul>
                {filteredSources.map(s => {
                  const checked = selectedIds.has(s.id)
                  const perChat = (progress?.per_chat || []).find(p => p.target === s.handle)
                  const isCurrent = inflight && progress?.current_target === s.handle
                  return (
                    <li
                      key={s.id}
                      className={`px-4 py-2 flex items-center gap-3 border-b border-zinc-900 last:border-b-0 ${
                        isCurrent ? 'bg-zinc-900/60' : 'hover:bg-zinc-900/40'
                      }`}
                    >
                      <Checkbox
                        checked={checked}
                        onChange={() => toggleOne(s.id)}
                        size="sm"
                      />
                      <Avatar source={s} size={26} />
                      {/* flex-1 min-w-0 на имени + shrink-0 nowrap на счётчиках:
                          длинное название чата сжимается с «…», а «Текст 10»
                          справа никогда не переносится на вторую строку. */}
                      <button
                        onClick={() => pushScreen('source-detail', { sourceId: s.id })}
                        className="text-zinc-200 truncate hover:underline flex-1 min-w-0 text-left"
                        style={{ fontSize: '14px' }}
                      >
                        {s.display_name && s.display_name !== s.handle
                          ? s.display_name
                          : `@${s.handle}`}
                      </button>
                      <span className="ml-auto flex items-center gap-3 text-zinc-500 shrink-0 whitespace-nowrap" style={{ fontSize: '13px' }}>
                        {perChat?.status === 'done' && (
                          <span className="text-emerald-500" title={`Только что спарсено: ${perChat.items_done || 0} сообщений`}>
                            +{perChat.items_done || 0}
                          </span>
                        )}
                        {perChat?.status === 'error' && (
                          <span className="text-red-400" title={perChat.error || ''}>✗ ошибка</span>
                        )}
                        {isCurrent && (
                          <span className="text-emerald-400">↻ парсю…</span>
                        )}
                        <AutoBadges row={s} />
                        <ItemTypeBreakdown row={s} />
                      </span>
                    </li>
                  )
                })}
              </ul>
              )}
            </>
          )}
        </div>

        {dialogCategory === 'auto' && (
          <div className="mt-2 text-zinc-500" style={{ fontSize: '12px' }}>
            <span className="text-zinc-400">auto-pull</span> запускается через минуту после старта и дальше каждые 30 минут, пока приложение открыто;{' '}
            <span className="text-zinc-400">auto-index</span> идёт после подтягивания.
          </div>
        )}

        {activeTabId != null && (
          <FolderFooter
            folder={folders.find(f => f.id === activeTabId)}
            onRemove={async () => {
              const f = folders.find(x => x.id === activeTabId)
              if (!f) return
              if (!confirm(`Убрать папку «${f.title}» из библиотеки? Чаты внутри останутся в Telegram-разделе как обычно.`)) return
              try {
                await window.api.folderRemove(activeTabId)
                setActiveTabId(null)
                invalidate('folders')
              } catch (err) {
                console.error('[TelegramScreen] folderRemove failed', err)
              }
            }}
          />
        )}
      </div>
    </div>
  )
}

function AutoActionButton({ active, mixed, disabled, onClick, icon, label, actionCount }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-7 px-2 rounded-md border inline-flex items-center gap-1.5 whitespace-nowrap ${
        active
          ? 'border-emerald-700 bg-emerald-950/60 text-emerald-200'
          : mixed
            ? 'border-amber-700 bg-amber-950/30 text-amber-200'
            : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:border-zinc-600 disabled:text-zinc-700 disabled:hover:border-zinc-800'
      }`}
      style={{ fontSize: '12px' }}
      title={mixed ? `${label}: включено не у всех выбранных чатов` : label}
    >
      {icon}
      <span>
        {label}
        {actionCount ? <span className="text-zinc-400"> ({actionCount})</span> : null}
      </span>
    </button>
  )
}

function AutoTypesButton({
  content, onContentChange,
  engine, onEngineChange,
  open, onOpenChange,
}) {
  const wrapRef = useRef(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onOpenChange(false)
    }
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [open, onOpenChange])

  const summary = autoTypeSummary(content)
  const pickedCount = Object.keys(content || {}).filter(k => content[k]).length
  const showEngine = !!(content.voice || content.video)

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`h-7 px-2 rounded-md border inline-flex items-center gap-1.5 whitespace-nowrap ${
          pickedCount === 0
            ? 'border-amber-800 bg-amber-950/20 text-amber-200 hover:border-amber-600'
            : open
              ? 'border-zinc-600 bg-zinc-800 text-zinc-100'
              : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-zinc-100 hover:border-zinc-600'
        }`}
        style={{ fontSize: '12px' }}
        title={summary}
      >
        <span>Types: {summary}</span>
        <ChevronDown size={13} className={`text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 left-0 w-[270px] rounded-md border border-zinc-700 bg-zinc-900 shadow-2xl py-1">
          {CONTENT_TYPES.map(t => {
            const label = AUTO_TYPE_LABELS[t.id] || t.label
            const checked = !!content[t.id]
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onContentChange(prev => ({ ...prev, [t.id]: !checked }))}
                className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-zinc-800"
              >
                <Checkbox
                  checked={checked}
                  onChange={next => onContentChange(prev => ({ ...prev, [t.id]: next }))}
                  size="sm"
                />
                <span className={checked ? 'text-zinc-100' : 'text-zinc-400'} style={{ fontSize: '13px' }}>
                  {label}
                </span>
              </button>
            )
          })}
          {showEngine && (
            <div className="px-3 pt-2 pb-1 border-t border-zinc-800 flex items-center gap-1.5">
              {['assemblyai', 'gemini'].map(id => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onEngineChange(id)}
                  className={`px-2 py-1 rounded-md border ${
                    engine === id
                      ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
                      : 'border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:border-zinc-600'
                  }`}
                  style={{ fontSize: '12px' }}
                >
                  {id === 'assemblyai' ? 'AssemblyAI' : 'Gemini'}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AutoBadges({ row }) {
  const auto = telegramAutoSettings(row)
  if (!auto.pull && !auto.index) return null
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      {auto.pull && (
        <span
          className="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-900/60"
          title={auto.types.length ? auto.types.map(t => AUTO_TYPE_LABELS[t] || t).join(' + ') : 'auto-pull'}
        >
          auto-pull
        </span>
      )}
      {auto.index && (
        <span
          className="px-1.5 py-0.5 rounded bg-sky-950/50 text-sky-300 border border-sky-900/60"
          title="auto-index"
        >
          auto-index
        </span>
      )}
    </span>
  )
}

// Per-source item-type breakdown — small inline summary that replaces the
// opaque "N сохр." count. Shows text count as a word ("Текст 10") because
// text is the primary content type, then icons + numbers for non-text:
//   📷 photos · 🎬 videos · 🎤 voices · 📎 documents
//
// Zero-count types are dropped silently — would just be noise on chats with
// no media. Hover-titles spell out what each icon counts.
function ItemTypeBreakdown({ row }) {
  const text  = Number(row?.text_n) || 0
  const photo = Number(row?.photo_n) || 0
  const video = Number(row?.video_n) || 0
  // voice + audio collapse into one "audio" bucket — UX-wise both are "ear
  // content", differentiating them in a per-row summary is overkill.
  const audio = (Number(row?.voice_n) || 0) + (Number(row?.audio_n) || 0)
  const docs  = Number(row?.document_n) || 0
  const empty = text === 0 && photo === 0 && video === 0 && audio === 0 && docs === 0
  if (empty) {
    return <span className="text-zinc-700">— пусто</span>
  }
  return (
    <span className="flex items-center gap-2 text-zinc-500 tabular-nums" style={{ fontSize: '13px' }}>
      {text > 0 && <span title="Текстовые сообщения">Текст {text}</span>}
      {photo > 0 && (
        <span className="flex items-center gap-1" title="Фото">
          <Image size={12} className="text-zinc-500" /> {photo}
        </span>
      )}
      {video > 0 && (
        <span className="flex items-center gap-1" title="Видео">
          <Video size={12} className="text-zinc-500" /> {video}
        </span>
      )}
      {audio > 0 && (
        <span className="flex items-center gap-1" title="Голосовые / аудио">
          <Mic size={12} className="text-zinc-500" /> {audio}
        </span>
      )}
      {docs > 0 && (
        <span className="flex items-center gap-1" title="Документы">
          <FileText size={12} className="text-zinc-500" /> {docs}
        </span>
      )}
    </span>
  )
}

function Tab({ active, onClick, label, count }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md flex items-center gap-2 ${
        active
          ? 'bg-zinc-800 text-zinc-100'
          : 'bg-zinc-950 hover:bg-zinc-900 text-zinc-400'
      }`}
      style={{ fontSize: '14px' }}
    >
      <span className="truncate max-w-[200px]">{label}</span>
      <span className={`text-xs ${active ? 'text-zinc-300' : 'text-zinc-600'}`}>
        {count}
      </span>
    </button>
  )
}

function FolderFooter({ folder, onRemove }) {
  if (!folder) return null
  const last = folder.last_fetched_at
    ? new Date(folder.last_fetched_at * 1000)
    : null
  const lastStr = last
    ? `последний парсинг ${formatRelative(last)}`
    : 'пока ничего не парсили в этой папке'
  return (
    <div className="mt-6 flex items-center gap-3 text-zinc-500" style={{ fontSize: '13px' }}>
      <span>{lastStr}</span>
      <span className="ml-auto">
        <button
          onClick={onRemove}
          className="text-zinc-500 hover:text-red-400"
          title="Убрать папку из библиотеки"
        ><span className="inline-flex items-center gap-1"><Trash2 size={13} />убрать папку</span></button>
      </span>
    </div>
  )
}

function formatRelative(date) {
  const sec = (Date.now() - date.getTime()) / 1000
  if (sec < 60)        return 'только что'
  if (sec < 3600)      return `${Math.round(sec / 60)} мин назад`
  if (sec < 86400)     return `${Math.round(sec / 3600)} ч назад`
  if (sec < 86400 * 7) return `${Math.round(sec / 86400)} дн назад`
  return date.toLocaleDateString('ru-RU')
}

/**
 * Inline form that resolves a Telegram folder by its name (the one the user
 * sees in the TG client itself, e.g. "events" or "😑events"). On success
 * upserts the folder + its chats and switches to the new tab.
 */
function AddFolderForm({ onClose, onAdded }) {
  const [name, setName] = useState('')
  const [stage, setStage] = useState('idle')   // idle | resolving | picker | error
  const [candidates, setCandidates] = useState([])
  const [error, setError] = useState(null)

  async function submit() {
    const q = name.trim()
    if (!q) return
    setStage('resolving')
    setError(null)
    try {
      const res = await window.api.tgResolveFolder({ name: q })
      if (!res?.ok) {
        setStage('error')
        setError(res?.error || 'Не удалось получить список папок из Telegram')
        return
      }
      if (res.folder) {
        onAdded(res.folder.id)
        return
      }
      // No exact match — show all candidates.
      setCandidates(res.candidates || [])
      setStage('picker')
    } catch (err) {
      setStage('error')
      setError(String(err && err.message || err))
    }
  }

  async function pickCandidate(c) {
    setStage('resolving')
    try {
      const res = await window.api.tgResolveFolder({ filterId: c.filter_id })
      if (!res?.ok || !res.folder) {
        setStage('error')
        setError(res?.error || 'Не удалось загрузить папку')
        return
      }
      onAdded(res.folder.id)
    } catch (err) {
      setStage('error')
      setError(String(err && err.message || err))
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-zinc-300" style={{ fontSize: '14px' }}>Имя папки в Telegram</span>
        <button onClick={onClose} className="inline-flex items-center ml-auto text-zinc-500 hover:text-zinc-200"><X size={16} /></button>
      </div>
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit() }}
          placeholder="events · работа · 😑events"
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
          style={{ fontSize: '14px' }}
          disabled={stage === 'resolving'}
        />
        <button
          onClick={submit}
          disabled={stage === 'resolving' || !name.trim()}
          className="px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white"
          style={{ fontSize: '14px' }}
        >
          {stage === 'resolving' ? 'ищу…' : 'найти'}
        </button>
      </div>

      {stage === 'picker' && candidates.length > 0 && (
        <div className="mt-3">
          <div className="text-zinc-500 mb-2" style={{ fontSize: '13px' }}>
            Точного совпадения нет — выберите папку из списка:
          </div>
          <ul className="border border-zinc-800 rounded-md">
            {candidates.map(c => (
              <li key={c.filter_id} className="border-b border-zinc-900 last:border-b-0">
                <button
                  onClick={() => pickCandidate(c)}
                  className="w-full px-3 py-2 flex items-center gap-3 hover:bg-zinc-900 text-left"
                  style={{ fontSize: '14px' }}
                >
                  <span className="text-zinc-200 truncate flex-1">{c.title}</span>
                  <span className="text-zinc-500 text-xs">{c.include_count} чатов</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {stage === 'picker' && candidates.length === 0 && (
        <div className="mt-3 text-zinc-500" style={{ fontSize: '13px' }}>
          В Telegram-аккаунте нет именованных папок. Создай папку прямо в клиенте Telegram, потом возвращайся.
        </div>
      )}

      {stage === 'error' && (
        <div className="mt-3 text-red-300" style={{ fontSize: '13px' }}>
          {error || 'Ошибка'}
        </div>
      )}
    </div>
  )
}
