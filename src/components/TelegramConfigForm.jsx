import React, { useState, useMemo, useEffect, useRef } from 'react'
import { BarChart3, X } from 'lucide-react'
import { startTelegramFetch, resolveTelegramTitle, watchJob, cancelJob } from '../lib/jobs'
import { useInvalidator } from '../lib/dataBus'
import PlatformLogo from './PlatformLogo'
import TelegramScopeFields, { defaultRange, presetDaysOf } from './TelegramScopeFields'
import { CONTENT_TYPES, defaultContent } from './TelegramTypesPopover'

// Single localStorage key holds last-used range mode, content types, and
// engine for the form. Stored as one JSON blob so adding a new persisted
// field later is a one-line change. Survives across paste-flow and
// SourceDetail mounts (form is unmounted/remounted each time, so React state
// alone wouldn't keep it).
const LAST_USED_KEY = 'tg-config-form-last'
const SAFE_RESTORED_RANGE_MODES = new Set(['last_n', 'last_week', 'date_range'])

function readLastUsed() {
  try {
    const raw = localStorage.getItem(LAST_USED_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

// Merge persisted range over the canonical default — that way any field we
// later add to defaultRange() shows up automatically without breaking older
// stored blobs. Only restore safe repeat modes + lastN; URLs, dates, and
// dangerous full-history modes stay one-shot per fetch.
function loadLastUsedRange() {
  const base = defaultRange('fetch')
  const v = readLastUsed()
  if (!v || !v.range) return base
  const next = { ...base }
  if (typeof v.range.mode === 'string' && SAFE_RESTORED_RANGE_MODES.has(v.range.mode)) {
    next.mode = v.range.mode
  }
  if (typeof v.range.lastN === 'string') next.lastN = v.range.lastN
  return next
}

// Restore content types as a strict overlay on defaultContent() so a removed
// type from a stale blob doesn't leak in, and a new type added later picks
// up its default until the user toggles it.
function loadLastUsedContent() {
  const base = defaultContent()
  const v = readLastUsed()
  if (!v || !v.content || typeof v.content !== 'object') return base
  const next = { ...base }
  for (const k of Object.keys(base)) {
    if (typeof v.content[k] === 'boolean') next[k] = v.content[k]
  }
  return next
}

function loadLastUsedEngine() {
  const v = readLastUsed()
  return (v && (v.engine === 'assemblyai' || v.engine === 'gemini'))
    ? v.engine : 'assemblyai'
}

function writeLastUsed({ range, content, engine }) {
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify({
      range:   { mode: range.mode, lastN: range.lastN },
      content: { ...content },
      engine,
    }))
  } catch {}
}

function parseTelegramDateInput(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/)
    || raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (!m) return null

  let year, month, day, hour, minute
  if (m[0].includes('.')) {
    day = Number(m[1])
    month = Number(m[2])
    year = Number(m[3])
    if (year < 100) year = year <= 68 ? 2000 + year : 1900 + year
    hour = Number(m[4] || 0)
    minute = Number(m[5] || 0)
  } else {
    year = Number(m[1])
    month = Number(m[2])
    day = Number(m[3])
    hour = Number(m[4] || 0)
    minute = Number(m[5] || 0)
  }

  const d = new Date(year, month - 1, day, hour, minute, 0, 0)
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day ||
    d.getHours() !== hour ||
    d.getMinutes() !== minute
  ) return null
  return d
}

function formatDateRu(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`
}

function rangeIssue(range) {
  if (range.mode !== 'date_range') return null
  const fromRaw = String(range.fromDate || '').trim()
  if (!fromRaw) return null
  const from = parseTelegramDateInput(fromRaw)
  if (!from) {
    return `Не понимаю дату «${fromRaw}». Формат: 01.12.2026 или 01.12.2026 12:00.`
  }
  const now = new Date()
  if (from.getTime() > now.getTime()) {
    return `Дата начала ${formatDateRu(from)} ещё не наступила. Сегодня ${formatDateRu(now)}; с такой границей Telegram вернёт 0 сообщений.`
  }
  const toRaw = String(range.toDate || '').trim()
  if (toRaw && !parseTelegramDateInput(toRaw)) {
    return `Не понимаю дату «${toRaw}». Формат: 01.12.2026 или 01.12.2026 12:00.`
  }
  return null
}

function resolveNeedleForTarget(target, kind) {
  const raw = String(target || '').trim()
  if (!raw) return ''
  if (kind === 'title') return raw
  try {
    const u = new URL(raw)
    if (/^(t\.me|telegram\.me)$/i.test(u.hostname)) {
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts[0] === 'c' && parts[1]) return `-100${parts[1]}`
      if (parts[0]) return parts[0]
    }
  } catch {}
  return raw.replace(/^@+/, '')
}

function unixFromTelegramDateInput(value) {
  const d = parseTelegramDateInput(value)
  return d ? Math.floor(d.getTime() / 1000) : null
}

function buildLocalMediaEstimateScope(sourceId, range, topicIds) {
  if (!sourceId) return null
  const scope = { source_id: Number(sourceId), mode: range.mode || 'all' }
  if (topicIds && topicIds.size > 0) {
    scope.topic_ids = Array.from(topicIds).map(Number).filter(Number.isFinite)
  }
  const presetDays = presetDaysOf(range.mode)
  if (range.mode === 'last_n') {
    const n = Number(range.lastN)
    if (!Number.isFinite(n) || n <= 0) return null
    scope.mode = 'last_n'
    scope.limit = n
    return scope
  }
  if (range.mode === 'all') {
    scope.mode = 'all'
    return scope
  }
  if (range.mode === 'date_range') {
    const from = unixFromTelegramDateInput(range.fromDate)
    if (!from) return null
    scope.mode = 'date_range'
    scope.date_from = from
    const to = unixFromTelegramDateInput(range.toDate)
    if (to) scope.date_to = to
    return scope
  }
  if (presetDays != null) {
    scope.mode = 'from_date'
    scope.date_from = Math.floor((Date.now() - presetDays * 86400 * 1000) / 1000)
    return scope
  }
  return null
}

function estimateType(estimate, type) {
  return estimate?.by_type?.[type] || {
    count: 0,
    processed: 0,
    duration_seconds: 0,
  }
}

function compactCount(n) {
  return Number(n || 0).toLocaleString('ru-RU')
}

function mediaEstimateSummary(estimate, content, redoProcessed) {
  if (!estimate?.ok) return null
  const rows = []
  const selectedTypes = []
  function add(type, label, withDuration = false) {
    const row = estimateType(estimate, type)
    selectedTypes.push(row)
    if (!row.count) return
    const dur = withDuration && row.duration_seconds > 0
      ? ` · ${fmtDuration(row.duration_seconds)}`
      : ''
    rows.push(`${compactCount(row.count)} ${label}${dur}`)
  }
  if (content.voice) {
    add('voice', 'голосовых', true)
    add('audio', 'аудио', true)
  }
  if (content.video) add('video', 'видео', true)
  if (content.photo) add('photo', 'фото')
  if (content.docs) add('document', 'документов')

  const pickedAny = content.voice || content.video || content.photo || content.docs
  if (!pickedAny) return null
  const total = selectedTypes.reduce((sum, row) => sum + Number(row.count || 0), 0)
  const processed = selectedTypes.reduce((sum, row) => sum + Number(row.processed || 0), 0)
  const toRun = redoProcessed ? total : Math.max(0, total - processed)
  return {
    total,
    processed,
    toRun,
    bits: rows,
    empty: total === 0,
  }
}

/**
 * Headless form (no header, no back button, no footer-bar). Renders inline
 * inside whatever container the caller provides.
 *
 * Range / types / topic / engine inputs live in `<TelegramScopeFields>` —
 * shared with `<CopySavedPanel>`. This wrapper owns the network-side state
 * (fetch params, pre-analysis job, title resolution, Start fetch action).
 *
 * Props:
 *   target         — '@user', 'user', URL, or free-text chat title (required)
 *   kind           — detection kind ('username' | 'channel' | 'url' | 'title' | …).
 *                    When 'title', form first resolves the text to a chat_id via
 *                    iter_dialogs() and (if 2+ matches) shows a picker. After
 *                    pick the rest of the form behaves identically.
 *   onStarted(id)  — called after job is enqueued
 */
export default function TelegramConfigForm({
  target,
  kind,
  onStarted,
  sourceId = null,
  sourceSession = null,
  sourceSessionConflict = false,
  notifyOnLaunch = false,
}) {
  // Title-resolve state (only used when kind === 'title').
  // 'pending' before mount-effect kicks off; 'resolving' during subprocess;
  // 'picker' when 2+ matches; 'error' for 0/no-session/etc; 'ready' once we
  // have a chosen chat (or kind !== 'title' from the start).
  const needsAccountResolve = !sourceId
  const resolveNeedle = useMemo(() => resolveNeedleForTarget(target, kind), [target, kind])
  const [resolveStage, setResolveStage] = useState(needsAccountResolve ? 'pending' : 'ready')
  const [resolveErr, setResolveErr] = useState(null)
  const [resolveScanned, setResolveScanned] = useState(0)  // live "просмотрено N…" counter
  const [matches, setMatches] = useState([])
  const [chosen, setChosen] = useState(null)        // {chat_id, title, kind, members, last_message_at, username}

  useEffect(() => {
    if (!needsAccountResolve) return
    let alive = true
    setResolveStage('resolving'); setResolveErr(null); setMatches([]); setChosen(null); setResolveScanned(0)
    // Subscribe to scan progress while invoke is in flight. Telethon's
    // iter_dialogs() walks every dialog page-by-page (no server-side title
    // search) so a busy account legitimately takes 30-60s.
    const off = window.api?.onTgResolveProgress?.((p) => {
      if (!alive) return
      if (p && typeof p.scanned === 'number') setResolveScanned(p.scanned)
    })
    ;(async () => {
      try {
        const r = await resolveTelegramTitle(resolveNeedle)
        if (!alive) return
        if (r.error === 'no_session') {
          setResolveErr('Нет активной Telegram-сессии — открой настройки и войди.')
          setResolveStage('error')
          return
        }
        if (!r.matches || r.matches.length === 0) {
          setResolveErr(`Не нашёл «${target}» ни в одном Telegram-аккаунте. Открой этот чат в Telegram нужного аккаунта и попробуй снова.`)
          setResolveStage('error')
          return
        }
        if (r.matches.length === 1) {
          setChosen(r.matches[0])
          setResolveStage('ready')
          return
        }
        setMatches(r.matches)
        setResolveStage('picker')
      } catch (e) {
        if (!alive) return
        setResolveErr(String(e && e.message || e))
        setResolveStage('error')
      }
    })()
    return () => { alive = false; off && off() }
  }, [needsAccountResolve, target, resolveNeedle])

  // Scope state — owned here, fed into <TelegramScopeFields>.
  //
  // Last-used persistence: the user almost always picks the same range mode +
  // content types + engine across consecutive fetches. We restore the last
  // committed combo from localStorage on mount so a navigate-away → return (or
  // a fresh paste) lands on whatever they chose previously, instead of always
  // resetting to `last_n=500, text-only, assemblyai`.
  //
  // What's NOT persisted (and why):
  //   • url1/url2     — one-shot per fetch (between-mode); restoring stale
  //                     URLs from a different chat would be confusing.
  //   • topicId/topicIds — per-source (forum topics belong to one chat only).
  //   • commentsLimit — niche, almost never customised; tied to comments
  //                     toggle which IS persisted.
  //   • skipDupes     — derived semantics depend on the current source's
  //                     typeBreakdown (backfill auto-disables it). Saving
  //                     a true/false would mislead in either direction.
  const [range, setRange] = useState(() => loadLastUsedRange())
  const [content, setContent] = useState(() => loadLastUsedContent())
  const [engine, setEngine] = useState(() => loadLastUsedEngine())
  // Comments per-post limit. 0 = no limit (all). Stored as string so the input
  // can be cleared mid-edit without snapping immediately.
  const [commentsLimit, setCommentsLimit] = useState('')   // empty = «все»

  // Whether the chosen source has a linked discussion group. Three states:
  //  null  — unknown (first fetch will probe and persist; checkbox stays
  //          enabled so first-time-fetcher isn't blocked from trying)
  //  true  — has linked group; checkbox enabled
  //  false — no linked group; checkbox disabled with «У канала нет обсуждений» hint
  const [hasDiscussion, setHasDiscussion] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [launchedJobId, setLaunchedJobId] = useState(null)
  const [err, setErr] = useState(null)
  // «Ничего не найдено» — set when a launched fetch finishes with 0 items and
  // a non-fatal warning (empty chat / dialog / filters). Keeps the form on the
  // main page and shows the notice inline instead of clearing the input and
  // leaving the user staring at a blank Home wondering what happened.
  const [emptyNotice, setEmptyNotice] = useState(null)
  // Tear-down handle for the post-launch job watcher (so a second submit or
  // unmount doesn't leak the onJobUpdate subscription).
  const launchWatchOff = useRef(null)
  useEffect(() => () => { if (launchWatchOff.current) launchWatchOff.current() }, [])

  // Forum-topic multi-select state. Populated once we resolve the source
  // row (its existing items reveal which topics live there). New chats
  // (first-time fetch, no items yet) get an empty list — the row hides,
  // user fetches the whole chat, future re-fetches will surface the
  // selector once topics show up in items_topics.
  const [topics, setTopics] = useState([])
  const [topicIds, setTopicIds] = useState(() => new Set())
  // Existing-source breadcrumbs for the dedup feature: max external_id
  // already saved + sourceId, so buildFetchParams can hand it to Python
  // as --since-msgid when the «пропускать дубли» toggle is on.
  const [sourceRow, setSourceRow] = useState(null)
  const [maxExternalId, setMaxExternalId] = useState(0)
  // Per-type breakdown for the existing source: used only as an internal
  // guard for skipDupes. If the selected type has metadata-only rows, a
  // last_n fetch must revisit the saved window instead of asking Telegram
  // only for messages newer than the saved tip.
  const [typeBreakdown, setTypeBreakdown] = useState([])
  const effectiveSourceId = sourceId || sourceRow?.id || null
  const itemsEstimateVer = useInvalidator(effectiveSourceId ? `items:${effectiveSourceId}` : '__tg_media_estimate:none')

  // Persist last-used range mode + content types + engine on every change.
  // Runs synchronously after the relevant state commits, no debounce — write
  // is a single setItem call (~µs) and only fires on actual user input.
  useEffect(() => {
    writeLastUsed({ range, content, engine })
  }, [range.mode, range.lastN, content, engine])

  // Probe has_discussion from existing source row (post-fetch state). For
  // first-time pastes the source row may not exist yet — leave hasDiscussion
  // null so the checkbox stays enabled.
  useEffect(() => {
    if (!window.api?.tgFetch) return
    let alive = true
    const handle = chosen ? null : String(target).replace(/^@/, '')
    const externalId = chosen ? String(chosen.chat_id) : null
    ;(async () => {
      try {
        let s = null
        if (sourceId && window.api.sourceGet) {
          s = await window.api.sourceGet(sourceId)
        } else {
          const sources = await window.api.sourcesList?.()
          if (!alive || !Array.isArray(sources)) return
          s = sources.find(s =>
            s.platform === 'telegram' && (
              (handle && s.handle === handle) ||
              (externalId && s.external_id === externalId)
            )
          )
        }
        if (!alive) return
        if (s) setSourceRow(s)
        if (s && s.has_discussion != null) setHasDiscussion(!!s.has_discussion)
        // If we have a sourceId, pull the topic list. itemsTopics returns
        // [{id, title, count}] sorted by count desc, perfect for the
        // multi-select. Forum chats with 1 topic (no real partition) hide
        // the row anyway — TelegramScopeFields checks length > 1.
        if (s && s.id && window.api.itemsTopics) {
          try {
            const rows = await window.api.itemsTopics(s.id)
            if (alive && Array.isArray(rows)) setTopics(rows)
          } catch {}
        }
        // Highest cached message id — used as `--since-msgid` when the
        // skip-dupes toggle is on. Telethon iter_messages with min_id=X
        // returns only messages whose id>X, so "последние 500" becomes
        // "500 freshest UNSEEN", not "500 freshest in the chat".
        if (s && s.id && window.api.sourceMaxExternalId) {
          try {
            const m = await window.api.sourceMaxExternalId(s.id)
            if (alive) setMaxExternalId(Number(m) || 0)
          } catch {}
        }
        // Per-type counts (with `with_caption`) — internal guard for
        // auto-disabling skipDupes when the selected saved window needs a
        // re-walk.
        if (s && s.id && window.api.itemsTypeBreakdown) {
          try {
            const rows = await window.api.itemsTypeBreakdown({ source_id: s.id })
            if (alive && Array.isArray(rows)) setTypeBreakdown(rows)
          } catch {}
        }
      } catch {}
    })()
    return () => { alive = false }
  }, [target, chosen?.chat_id, sourceId])

  // Reset topic selection if the user switches between candidate chats —
  // ids belong to the previous chat and would silently no-op against the
  // new one (or worse, hit unrelated msg_ids).
  useEffect(() => { setTopicIds(new Set()) }, [chosen?.chat_id])

  // Pre-analysis state. The current params snapshot the preview was made
  // from is stashed alongside, so we can grey it out as soon as the user
  // changes any input — preventing a stale preview from misleading.
  // previewJobId tracks the live tg_preview job so we can cancel it.
  const [preview, setPreview] = useState(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewSig, setPreviewSig] = useState(null)
  const [previewJobId, setPreviewJobId] = useState(null)
  const previewWatchOff = useRef(null)
  useEffect(() => () => { if (previewWatchOff.current) previewWatchOff.current() }, [])

  const [localMediaEstimate, setLocalMediaEstimate] = useState(null)
  const [localMediaEstimateBusy, setLocalMediaEstimateBusy] = useState(false)
  const localEstimateScope = useMemo(
    () => buildLocalMediaEstimateScope(effectiveSourceId, range, topicIds),
    [
      effectiveSourceId,
      range.mode, range.lastN, range.fromDate, range.toDate,
      topicIds,
    ],
  )
  const localEstimateSig = useMemo(
    () => localEstimateScope ? JSON.stringify(localEstimateScope) : '',
    [localEstimateScope],
  )

  useEffect(() => {
    if (!localEstimateScope || !window.api?.itemsTelegramMediaEstimate) {
      setLocalMediaEstimate(null)
      setLocalMediaEstimateBusy(false)
      return
    }
    let alive = true
    setLocalMediaEstimateBusy(true)
    const timer = setTimeout(async () => {
      const started = Date.now()
      try {
        const result = await window.api.itemsTelegramMediaEstimate(localEstimateScope)
        const rest = Math.max(0, 250 - (Date.now() - started))
        if (rest) await new Promise(resolve => setTimeout(resolve, rest))
        if (!alive) return
        setLocalMediaEstimate(result?.ok ? result : null)
      } catch {
        if (alive) setLocalMediaEstimate(null)
      } finally {
        if (alive) setLocalMediaEstimateBusy(false)
      }
    }, 200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [localEstimateSig, itemsEstimateVer])

  const rangeValidationIssue = useMemo(() => rangeIssue(range), [
    range.mode, range.fromDate, range.toDate,
  ])
  const effectiveSourceSession = sourceSession || sourceRow?.tg_session || null
  const sourceSessionIssue = sourceId
    ? (sourceSessionConflict || sourceRow?.tg_session_conflict
        ? 'У этого чата конфликт Telegram-аккаунтов. Выбери аккаунт в строке чата выше и запусти запрос снова.'
        : (!effectiveSourceSession
            ? 'У этого чата не выбран Telegram-аккаунт. Выбери аккаунт в строке чата выше и запусти запрос снова.'
            : null))
    : null
  const canStart = (() => {
    if (sourceSessionIssue) return false
    if (rangeValidationIssue) return false
    if (range.mode === 'last_n')     return Number(range.lastN) > 0
    // Unified date_range: first date is required, second is optional
    // (empty → «до конца», fetch goes from `fromDate` forward to «now»).
    if (range.mode === 'date_range') return !!range.fromDate
    if (range.mode === 'between')    return !!range.url1 && !!range.url2
    // Preset (last_week, …) and `all` — always startable.
    return true
  })()

  // Backfill detection: types the user picked (or that ride with «Текст»
  // implicitly) which have rows in the DB with empty caption
  // (`with_caption < count`). Each such type is a signal "skipDupes would
  // skip exactly what we want to refetch". CONTENT_TYPES uses `docs` as
  // the renderer-side id; SQL stores it as `document`, so we map at the
  // seam. Polls travel together with «Текст» — when text is on, polls
  // count toward backfill too.
  const TYPE_DB = { text: 'text', voice: 'voice', video: 'video',
                    photo: 'photo', docs: 'document' }
  const backfillTypes = useMemo(() => {
    const picked = Object.keys(content).filter(k => content[k] && TYPE_DB[k])
    const dbTypes = picked.map(id => TYPE_DB[id])
    if (content.text) dbTypes.push('poll')   // implicit
    const out = []
    for (const dbType of dbTypes) {
      const row = (typeBreakdown || []).find(r => r.type === dbType)
      if (!row) continue
      const cap = row.with_caption || 0
      if (cap < (row.count || 0)) {
        out.push({ id: dbType, dbType, missing: (row.count || 0) - cap, total: row.count })
      }
    }
    return out
  }, [content, typeBreakdown])
  const needsBackfill = backfillTypes.length > 0

  // Snapshot of inputs that affect the fetch range. Used to invalidate
  // pre-analysis the moment the user touches anything.
  const fetchSig = useMemo(() => JSON.stringify({
    target,
    session: chosen?.tg_session || effectiveSourceSession || null,
    mode: range.mode,
    lastN: range.lastN,
    fromDate: range.fromDate, toDate: range.toDate,
    url1: range.url1, url2: range.url2,
  }), [target, chosen?.tg_session, effectiveSourceSession, range])
  const previewStale = preview && previewSig !== fetchSig
  // Dismiss a stale «ничего не найдено» the moment the user changes the scope
  // (different target / range) — they're about to try something else, the old
  // empty verdict no longer applies.
  useEffect(() => { setEmptyNotice(null) }, [fetchSig])

  function buildFetchParams() {
    // In title-flow we hand the numeric chat_id straight to Python — that's
    // the stable identifier even if the chat gets renamed later.
    const tgt = chosen ? String(chosen.chat_id) : String(target).replace(/^@/, '')
    const params = { target: tgt }
    if (sourceId) params._source_id = Number(sourceId)
    const sessionOverride = chosen?.tg_session || effectiveSourceSession
    if (sessionOverride) params._tg_session_override = sessionOverride
    const presetDays = presetDaysOf(range.mode)
    if (range.mode === 'last_n') {
      params.mode = 'last_n'
      params.limit = Number(range.lastN)
      // Skip-dupes toggle: when on AND we already have something cached
      // for this source, pin Telethon's window to messages newer than the
      // saved tip. iter_messages(min_id=X, limit=N) returns up to N msgs
      // with id>X, ignoring the rest of the chat tail. Without this you
      // ask for "500" on a 30k-cached source and get 500 dupes filtered
      // out at UPSERT — wasted bandwidth + Gemini bills if engines are on.
      //
      // BUT: when the user picks a type whose bodies are empty in the DB
      // (e.g. polls saved as metadata-only before --process-polls existed),
      // skipDupes would force the fetch to skip exactly the rows we need
      // to backfill. Detect that case and silently disable skipDupes so
      // the run actually re-walks the chat with the new flags.
      // `redoProcessed` ("парсить заново") implies re-fetch from scratch —
      // we MUST NOT pin min_id, otherwise iter_messages would skip exactly
      // the message ids the user wants to revisit.
      if (range.skipDupes && maxExternalId > 0 && !needsBackfill && !range.redoProcessed) {
        params.sinceMessageId = maxExternalId
      }
    }
    else if (range.mode === 'all')       { params.mode = 'all' }
    else if (range.mode === 'between')   { params.mode = 'all' /* TODO between */ }
    else if (range.mode === 'date_range'){
      // Unified mode: first date required, second optional.
      params.mode = 'from_date'
      params.date = range.fromDate
      // Pass the upper bound only when the user filled it in. tg_fetch_json
      // accepts --date-to alongside --date in from_date mode and trims
      // iteration when the message date crosses it.
      if (range.toDate) params.date_to = range.toDate
    }
    else if (presetDays != null) {
      // Preset → from_date with the day-count's calendar date in dd.mm.yyyy
      // (the format `tg_fetch_json.py` parses for `--date`).
      const d = new Date(Date.now() - presetDays * 86400 * 1000)
      const pad = n => String(n).padStart(2, '0')
      params.mode = 'from_date'
      params.date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
    }
    if (content.comments) {
      params.include_comments = true
      const n = parseInt(String(commentsLimit).replace(/\D+/g, ''), 10)
      params.comments_limit = Number.isFinite(n) && n > 0 ? n : 0   // 0 = все
    }
    // Forum topic filter (multi). Empty Set = «Все темы» = no filter
    // (omit param entirely, server-side fetcher iterates the whole chat).
    // Otherwise pass the list — runner expands into N parallel-ish
    // iter_messages(reply_to=tid) loops, server filters.
    if (topicIds && topicIds.size > 0) {
      params.topic_ids = Array.from(topicIds)
    }
    // Hand the engine selection to job-runner only when one of the AI-processed
    // content types is actually requested. Without this the user-facing
    // selector was dead — the param never reached Python and voice/docs/photos
    // came back as raw media without text. See pending #1 in CLAUDE.md.
    const needsAi = content.voice || content.video || content.photo || content.docs
    if (needsAi) {
      params.transcribe_engine = engine
      params.transcribe_lang = 'ru'
      params.process_voice = !!(content.voice || content.video)
      params.process_photo = !!content.photo
      params.process_docs  = !!content.docs
    }
    // Polls render is local & free (the poll object is already inside the
    // Telethon message — no extra RPC, no Gemini call). They ride together
    // with text in the «Текст» tile, so the flag is implicitly always on.
    params.process_polls = true
    // «парсить заново» — when on, runner skips the build-skip-set step and
    // Python re-processes every voice/photo/PDF even if it has
    // transcribe_status='done' in the desktop DB.
    if (range.redoProcessed) params.redo_processed = true
    return params
  }

  async function go() {
    if (!canStart || submitting || launchedJobId) return
    setSubmitting(true); setErr(null); setEmptyNotice(null)
    try {
      const id = await startTelegramFetch(buildFetchParams())
      if (id == null) throw new Error('Электрон-IPC недоступен')
      setLaunchedJobId(id)
      // Watch the launched job to its terminal state. On a normal (non-empty)
      // fetch we hand off to the parent's onStarted (which clears the input so
      // the user can paste the next link). On an empty result we DON'T clear —
      // we keep the form mounted and render «ничего не найдено» inline, right
      // here on the main page, which is what the user asked for. The job is
      // still saved either way (job-runner persists it), so Activity/History
      // also show it; this is just the inline echo on Home.
      if (launchWatchOff.current) { launchWatchOff.current(); launchWatchOff.current = null }
      launchWatchOff.current = watchJob(id, snap => {
        if (!snap) return
        const terminal = snap.status === 'done' || snap.status === 'error' || snap.status === 'cancelled'
        if (!terminal) return
        setLaunchedJobId(null)
        if (launchWatchOff.current) { launchWatchOff.current(); launchWatchOff.current = null }
        if (notifyOnLaunch) return
        const empty = (snap.items_done || 0) === 0 && (snap.items_total || 0) === 0
        if (snap.status === 'done' && empty && snap.warning?.message) {
          // Stay on Home, show the notice; skip the parent's input-clear.
          setEmptyNotice(snap.warning.message)
        } else {
          onStarted && onStarted(id)
        }
      })
      if (notifyOnLaunch) onStarted && onStarted(id)
    } catch (e) {
      console.error(e)
      setErr(String(e && e.message || e))
      setLaunchedJobId(null)
    } finally {
      setSubmitting(false)
    }
  }

  async function runPreview() {
    if (!window.api?.tgPreview) return
    if (!canStart || previewBusy) return
    setPreviewBusy(true); setErr(null); setPreview(null)
    const sig = fetchSig
    try {
      const id = await window.api.tgPreview(buildFetchParams())
      if (id == null) {
        setErr('Электрон-IPC недоступен')
        setPreviewBusy(false)
        return
      }
      setPreviewJobId(id)
      // Tear down any prior subscription before starting a new one.
      if (previewWatchOff.current) { previewWatchOff.current(); previewWatchOff.current = null }
      previewWatchOff.current = watchJob(id, snap => {
        if (!snap) return
        if (snap.preview_summary) {
          setPreview(snap.preview_summary)
          setPreviewSig(sig)
        }
        if (snap.status === 'done') {
          setPreviewBusy(false); setPreviewJobId(null)
        } else if (snap.status === 'error') {
          setErr(snap.error || 'Не удалось получить предварительный анализ')
          setPreviewBusy(false); setPreviewJobId(null)
        } else if (snap.status === 'cancelled') {
          setPreviewBusy(false); setPreviewJobId(null)
        }
      })
    } catch (e) {
      console.error(e)
      setErr(String(e && e.message || e))
      setPreviewBusy(false)
    }
  }

  function cancelPreview() {
    if (previewJobId == null) return
    cancelJob(previewJobId)
  }

  if (needsAccountResolve && resolveStage !== 'ready') {
    return (
      <TitleResolvePanel
        text={target}
        stage={resolveStage}
        error={resolveErr}
        scanned={resolveScanned}
        matches={matches}
        onPick={(m) => { setChosen(m); setResolveStage('ready') }}
      />
    )
  }

  return (
    <div className="space-y-3">
      {chosen && (
        <ChosenChatHeader
          chat={chosen}
          canChange={matches.length > 1}
          onChange={() => { setChosen(null); setResolveStage('picker') }}
        />
      )}

      <TelegramScopeFields
        use="fetch"
        range={range} onRangeChange={setRange}
        content={content} onContentChange={setContent}
        engine={engine} onEngineChange={setEngine}
        commentsLimit={commentsLimit} onCommentsLimitChange={setCommentsLimit}
        // Single-topic post-fetch filter is unused here (it's a copy/view
        // concept). Pass null = no single-topic row. The multi-select for
        // *pre-fetch* lives below via topicIds/onTopicIdsChange.
        topics={topics}
        topicId={null} onTopicIdChange={() => {}}
        topicIds={topicIds} onTopicIdsChange={setTopicIds}
        preview={preview && !previewStale ? preview : null}
        mediaEstimate={localMediaEstimate}
        mediaEstimateBusy={localMediaEstimateBusy}
        hasDiscussion={hasDiscussion}
      >
        <PreAnalysisButton
          canStart={canStart}
          previewBusy={previewBusy}
          canCancel={previewJobId != null}
          hasPreview={!!preview}
          onRun={runPreview}
          onCancel={cancelPreview}
        />
      </TelegramScopeFields>

      <LocalMediaEstimateLine
        estimate={localMediaEstimate}
        busy={localMediaEstimateBusy}
        content={content}
        redoProcessed={!!range.redoProcessed}
      />

      {/* Inline preview / "Весь чат" warning under the form. Lives in the
          wrapper because it's a fetch-only artefact. */}
      {(preview || range.mode === 'all') && (
        <PreviewLine preview={preview} previewStale={previewStale} fullChat={range.mode === 'all'} />
      )}

      {err && <div className="text-red-400" style={{ fontSize: '14px' }}>{err}</div>}

      {sourceSessionIssue && (
        <div className="rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-amber-200"
             style={{ fontSize: '14px' }}>
          {sourceSessionIssue}
        </div>
      )}

      {rangeValidationIssue && (
        <div className="rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-amber-200"
             style={{ fontSize: '14px' }}>
          {rangeValidationIssue}
        </div>
      )}

      {/* «Ничего не найдено» — inline echo of an empty fetch, on Home itself.
          Neutral amber (not red): nothing failed, the chat was just empty. */}
      {emptyNotice && (
        <div className="rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-amber-200"
             style={{ fontSize: '14px' }}>
          {emptyNotice}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 border-t border-zinc-800 pt-3 mt-2">
        {/* Debug-style toggle: when ON, the runner ignores the «already
            transcribed» snapshot and re-runs voice/photo/pdf AI on every
            matching msg. Default OFF — typical re-fetch should NOT pay the
            transcription bill twice. Useful when the user changed the AI
            pipeline (engine, prompt) and wants fresh transcripts. */}
        <button
          type="button"
          onClick={() => setRange(r => ({ ...r, redoProcessed: !r.redoProcessed }))}
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 ${
            range.redoProcessed
              ? 'bg-amber-900/30 border-amber-700/60 text-amber-300'
              : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500'
          }`}
          style={{ fontSize: '12px' }}
          title={range.redoProcessed
            ? 'Игнорировать кэш транскрипций — заново прогнать аудио/фото/PDF через AI (платно).'
            : 'Уже расшифрованные голосовые/фото/PDF будут пропущены — экономит API-минуты при ре-фетче.'}
        >
          <span
            className={`inline-flex items-center justify-center w-3 h-3 rounded-[3px] border ${
              range.redoProcessed ? 'bg-amber-600 border-amber-600' : 'border-zinc-600'
            }`}
          >
            {range.redoProcessed && (
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5L6.5 12L13 4.5"
                      stroke="white" strokeWidth="2.5"
                      strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
          <span>парсить заново</span>
        </button>
        <button
          onClick={go}
          disabled={!canStart || submitting || !!launchedJobId}
          className={`px-5 py-2 rounded-md font-medium ${
            canStart && !submitting && !launchedJobId
              ? 'bg-zinc-100 text-zinc-900 hover:bg-white'
              : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
          }`}
        >
          {submitting ? 'Запуск…' : launchedJobId ? 'В работе…' : 'Начать парсинг'}
        </button>
      </div>
    </div>
  )
}

// Pre-analysis trigger sits in the same row as the Range select (slot child
// of <TelegramScopeFields>). Title "⓲ Анализ" is short — when there's
// already a result it switches to "Обновить", and during a run it shows
// "Анализ…" + a Cancel button.
function PreAnalysisButton({ canStart, previewBusy, canCancel, hasPreview, onRun, onCancel }) {
  return (
    <>
      {previewBusy && canCancel && (
        <button
          type="button" onClick={onCancel}
          className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"
          style={{ fontSize: '14px' }}
        ><X size={14} /></button>
      )}
      <button
        type="button" onClick={onRun}
        disabled={!canStart || previewBusy}
        title="Узнать сколько и каких сообщений в выбранном диапазоне"
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border ${
          !canStart || previewBusy
            ? 'border-zinc-800 text-zinc-600 cursor-not-allowed'
            : 'bg-zinc-900 text-zinc-300 border-zinc-700 hover:border-zinc-500 hover:text-zinc-100'
        }`}
        style={{ fontSize: '14px' }}
      >
        <BarChart3 size={14} className="shrink-0" />
        <span>{previewBusy ? 'Анализ…' : (hasPreview ? 'Обновить' : 'Анализ')}</span>
      </button>
    </>
  )
}

function LocalMediaEstimateLine({ estimate, busy, content, redoProcessed }) {
  const pickedAny = content.voice || content.video || content.photo || content.docs
  if (!pickedAny) return null
  if (busy) {
    return (
      <div className="mt-1.5 flex items-center gap-2 text-zinc-500" style={{ fontSize: '13px' }}>
        <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-zinc-700 border-t-zinc-300 animate-spin" />
        <span>считаю медиа по сохранённым сообщениям</span>
      </div>
    )
  }
  const summary = mediaEstimateSummary(estimate, content, redoProcessed)
  if (!summary) return null
  if (summary.empty) {
    return (
      <div className="mt-1.5 text-zinc-500" style={{ fontSize: '13px' }}>
        По сохранённому диапазону: выбранных медиа нет.
      </div>
    )
  }
  const runText = redoProcessed
    ? `парсить заново: к запуску ${compactCount(summary.toRun)}`
    : `уже обработано ${compactCount(summary.processed)} · к запуску ${compactCount(summary.toRun)}`
  return (
    <div className="mt-1.5 text-zinc-400 tabular-nums" style={{ fontSize: '13px' }}>
      По сохранённому диапазону: {summary.bits.join(', ')} · {runText}
    </div>
  )
}

// Compact pre-analysis summary. Up to 3 lines, capped — line 1 totals,
// line 2 by-type stickers, line 3 senders + duration. Stickers come from
// formatType (📝/🎤/🎬/🖼/📎). Greys + prefixes "устарело · " when stale.
function PreviewLine({ preview, previewStale, fullChat }) {
  if (!preview && fullChat) {
    return (
      <div style={{ fontSize: '13px' }} className="text-amber-400 mt-1.5">
        ⚠ спарсить всю историю — может быть долго
      </div>
    )
  }
  if (!preview) return null

  const total = preview.items_total
  const dateRange = preview.date_min && preview.date_max
    ? `${fmtDate(preview.date_min)} — ${fmtDate(preview.date_max)}` : null
  const dur = (preview.voice_seconds + preview.video_seconds) > 0
    ? `${fmtDuration(preview.voice_seconds + preview.video_seconds)} аудио/видео` : null
  // Type breakdown — keep the order from the form, drop zero-count ones,
  // render with stickers so the line reads at a glance.
  const typeBits = preview.type_counts
    ? CONTENT_TYPES
        .map(c => ({ id: c.id, n: preview.type_counts[c.id] || 0 }))
        .filter(x => x.n > 0)
        .map(x => `${formatType(x.id)} ${x.n.toLocaleString()}`)
    : []
  // Senders — count + top 3 with their message counts.
  let sendersText = null
  if (preview.total_senders > 1) {
    sendersText = `👥 ${preview.total_senders} отправителей`
    if (preview.senders?.length) {
      const top = preview.senders.slice(0, 3).map(s => `${s.name} (${s.count})`).join(', ')
      if (top) sendersText += ` · ${top}`
    }
  }

  const parts = [
    total != null ? `Всего ${total.toLocaleString()}` : null,
    dateRange,
    typeBits.length ? typeBits.join(' · ') : null,
    sendersText,
    dur,
  ].filter(Boolean)

  return (
    <div
      style={{ fontSize: '13px' }}
      className={`mt-1.5 space-y-0.5 tabular-nums ${previewStale ? 'text-amber-500' : 'text-zinc-400'}`}
    >
      {previewStale && <span>устарело · </span>}
      {parts.join(' · ')}
    </div>
  )
}

function TitleResolvePanel({ text, stage, error, scanned, matches, onPick }) {
  if (stage === 'resolving' || stage === 'pending') {
    // Telethon's iter_dialogs() walks every dialog (no server-side search).
    // On large accounts that's 30-60s. Show a live count so the spinner
    // doesn't read as "stuck".
    const tail =
      scanned > 0
        ? `просмотрено ${scanned.toLocaleString('ru-RU')} диалогов…`
        : 'ищу чат в твоих диалогах…'
    return (
      <div className="flex items-center gap-3 text-zinc-400">
        <PlatformLogo platform="telegram" size={16} />
        <div className="font-medium text-zinc-200 truncate">«{text}»</div>
        <span className="text-zinc-500 tabular-nums" style={{ fontSize: '14px' }}>
          {tail}
        </span>
        <span className="ml-auto inline-block w-3.5 h-3.5 rounded-full border-2 border-zinc-700 border-t-zinc-300 animate-spin" />
      </div>
    )
  }
  if (stage === 'error') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <PlatformLogo platform="telegram" size={16} />
          <div className="font-medium text-zinc-200 truncate">«{text}»</div>
        </div>
        <div className="text-red-400" style={{ fontSize: '14px' }}>{error}</div>
      </div>
    )
  }
  // stage === 'picker'
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <PlatformLogo platform="telegram" size={16} />
        <div className="font-medium text-zinc-200 truncate">«{text}»</div>
        <span className="text-zinc-500" style={{ fontSize: '14px' }}>
          · нашёл {matches.length} совпадений — выбери Telegram-аккаунт
        </span>
      </div>
      <div className="rounded-md border border-zinc-800 divide-y divide-zinc-800 overflow-hidden">
        {matches.map(m => (
          <button
            key={`${m.tg_session || 'session'}:${m.chat_id}`}
            onClick={() => onPick(m)}
            className="w-full text-left px-4 py-3 hover:bg-zinc-900 flex items-center gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="text-zinc-200 truncate">{m.title}</div>
              <div className="text-zinc-500 truncate" style={{ fontSize: '14px' }}>
                {[
                  m.session_label || m.tg_session,
                  m.kind,
                  m.username ? '@' + m.username : null,
                  m.members != null ? `${m.members.toLocaleString('ru-RU')} участников` : null,
                  m.last_message_at ? `последнее: ${formatChatDate(m.last_message_at)}` : null,
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
            <span className="text-zinc-600 tabular-nums shrink-0" style={{ fontSize: '14px' }}>
              id {m.chat_id}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ChosenChatHeader({ chat, canChange, onChange }) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-zinc-900/50 border border-zinc-800 px-4 py-3">
      <PlatformLogo platform="telegram" size={16} />
      <div className="flex-1 min-w-0">
        <div className="text-zinc-200 truncate">{chat.title}</div>
        <div className="text-zinc-500 truncate" style={{ fontSize: '14px' }}>
          {[
            chat.session_label || chat.tg_session,
            chat.kind,
            chat.username ? '@' + chat.username : null,
            chat.members != null ? `${chat.members.toLocaleString('ru-RU')} участников` : null,
          ].filter(Boolean).join(' · ')}
        </div>
      </div>
      {canChange && (
        <button
          onClick={onChange}
          className="text-zinc-400 hover:text-zinc-200"
          style={{ fontSize: '14px' }}
        >Сменить</button>
      )}
    </div>
  )
}

function formatChatDate(iso) {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
  } catch { return iso }
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function fmtDuration(secs) {
  if (!secs) return '—'
  const h = Math.floor(secs / 3600)
  const m = Math.round((secs % 3600) / 60)
  if (h > 0) return `${h}ч ${m}м`
  return `${m} мин`
}

function formatType(id) {
  switch (id) {
    case 'text':  return '💬'
    case 'voice': return '🎤'
    case 'video': return '🎬'
    case 'photo': return '🖼'
    case 'docs':  return '📎'
    default: return ''
  }
}
